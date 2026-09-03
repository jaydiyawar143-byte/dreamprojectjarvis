import { createHash } from "node:crypto";
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DOCUMENT_CHUNKING_VERSION,
  JarvisError,
  MAX_CHUNK_SIZE,
  type ChunkBoundaryKind,
  type ChunkSourceContext,
  type ChunkingOptions,
  type DocumentChunk,
  type DocumentChunkMetadata,
  type DocumentChunkingResult,
  type DocumentExtractionResult,
  type IDocumentChunker,
  type ResolvedChunkingOptions,
} from "@jarvis/core";
import { countWords } from "../extraction/text-normalizer.js";
import { findChunkEnd } from "./chunk-boundaries.js";
import {
  findPrimarySection,
  locatePages,
  locateSectionRefs,
} from "./chunk-locator.js";

/**
 * Sprint 3.3 — document chunking.
 *
 * Turns the normalized text from Sprint 3.2 extraction into ordered,
 * overlapping chunks ready for a later embedding stage. It does not embed,
 * persist, or retrieve anything.
 *
 * Determinism is the whole point of this layer. Chunking is a pure function of
 * `(text, chunkSize, chunkOverlap, minChunkSize)` — no clock, no randomness, no
 * counters — so re-chunking the same document produces deeply equal chunks with
 * identical ids. That is what lets a caller detect whether a re-uploaded
 * document actually needs re-embedding.
 *
 * Two invariants hold for every emitted chunk:
 *   - `text.slice(chunk.startOffset, chunk.endOffset) === chunk.content`
 *   - `chunks[i].index === i`, contiguous from 0
 */

/** Resolves and validates options, failing fast on nonsense configuration. */
export function resolveChunkingOptions(
  options: ChunkingOptions = {}
): ResolvedChunkingOptions {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const minChunkSize = options.minChunkSize ?? 0;

  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new JarvisError(
      "INVALID_REQUEST",
      "chunkSize must be a positive integer",
      { chunkSize }
    );
  }
  if (chunkSize > MAX_CHUNK_SIZE) {
    throw new JarvisError(
      "INVALID_REQUEST",
      `chunkSize must not exceed ${MAX_CHUNK_SIZE}`,
      { chunkSize, maxChunkSize: MAX_CHUNK_SIZE }
    );
  }
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0) {
    throw new JarvisError(
      "INVALID_REQUEST",
      "chunkOverlap must be a non-negative integer",
      { chunkOverlap }
    );
  }
  // Strict inequality is load-bearing: at `chunkOverlap === chunkSize` the next
  // chunk would start exactly where the current one did and the loop would
  // never advance.
  if (chunkOverlap >= chunkSize) {
    throw new JarvisError(
      "INVALID_REQUEST",
      "chunkOverlap must be smaller than chunkSize",
      { chunkSize, chunkOverlap }
    );
  }
  if (!Number.isInteger(minChunkSize) || minChunkSize < 0) {
    throw new JarvisError(
      "INVALID_REQUEST",
      "minChunkSize must be a non-negative integer",
      { minChunkSize }
    );
  }

  return { chunkSize, chunkOverlap, minChunkSize };
}

/**
 * Merges per-call overrides onto the service defaults.
 *
 * The subtlety is inheriting `chunkOverlap`. A service built with the defaults
 * (1000/200) that is then asked for `{ chunkSize: 100 }` would inherit an
 * overlap of 200 and fail validation — even though the caller supplied nothing
 * invalid. So when the overlap is inherited rather than stated, and it cannot
 * fit the requested chunk size, it falls back to the same proportion the
 * defaults encode (200/1000 = 20%).
 *
 * An overlap the caller states explicitly is never adjusted: an impossible pair
 * asked for outright is a programming error and still throws.
 */
function mergeChunkingOptions(
  defaults: ResolvedChunkingOptions,
  overrides: ChunkingOptions
): ChunkingOptions {
  const merged: ChunkingOptions = { ...defaults, ...overrides };

  if (
    overrides.chunkOverlap === undefined &&
    merged.chunkSize !== undefined &&
    merged.chunkOverlap !== undefined &&
    merged.chunkOverlap >= merged.chunkSize
  ) {
    const ratio = DEFAULT_CHUNK_OVERLAP / DEFAULT_CHUNK_SIZE;
    merged.chunkOverlap = Math.floor(merged.chunkSize * ratio);
  }

  return merged;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Derives a chunk's stable id.
 *
 * The digest covers the chunking contract version, the document's content hash,
 * the options that shaped the boundaries, and the chunk's own position. Changing
 * any of those — different document, different chunk size, a bumped algorithm —
 * yields different ids, which is what stops chunks produced under different
 * settings from colliding in storage.
 *
 * Truncated to 32 hex characters: 128 bits, far beyond collision risk for a
 * per-document chunk set, and short enough to read in a log line.
 */
export function deriveChunkId(
  contentHash: string,
  options: ResolvedChunkingOptions,
  index: number,
  startOffset: number,
  endOffset: number
): string {
  const material = [
    DOCUMENT_CHUNKING_VERSION,
    contentHash,
    options.chunkSize,
    options.chunkOverlap,
    options.minChunkSize,
    index,
    startOffset,
    endOffset,
  ].join("|");
  return sha256Hex(material).slice(0, 32);
}

interface RawChunk {
  startOffset: number;
  endOffset: number;
  boundary: ChunkBoundaryKind;
}

/**
 * Walks the text once, producing raw `[start, end)` spans.
 *
 * Separated from metadata assembly so the boundary logic can be tested — and
 * reasoned about — without any document context in the way.
 */
export function computeChunkSpans(
  text: string,
  options: ResolvedChunkingOptions
): RawChunk[] {
  if (text.length === 0) return [];

  const { chunkSize, chunkOverlap, minChunkSize } = options;
  const spans: RawChunk[] = [];

  let start = 0;
  while (start < text.length) {
    const { end, kind } = findChunkEnd(text, start, chunkSize, chunkOverlap);
    spans.push({ startOffset: start, endOffset: end, boundary: kind });

    if (end >= text.length) break;

    // `findChunkEnd` guarantees `end > start + chunkOverlap`, so this always
    // advances. The max() is belt-and-braces against a future boundary change.
    start = Math.max(end - chunkOverlap, start + 1);
  }

  // A stray tail ("...and.") carries no retrievable meaning on its own; fold it
  // back into the chunk before it. Only ever merges the LAST span, so earlier
  // boundaries stay exactly where the algorithm put them.
  if (minChunkSize > 0 && spans.length > 1) {
    const last = spans[spans.length - 1]!;
    const tail = text.slice(last.startOffset, last.endOffset).trim();
    if (tail.length < minChunkSize) {
      spans.pop();
      const previous = spans[spans.length - 1]!;
      previous.endOffset = last.endOffset;
      previous.boundary = "document-end";
    }
  }

  return spans;
}

export class DocumentChunkingService implements IDocumentChunker {
  private readonly defaults: ResolvedChunkingOptions;

  constructor(options: ChunkingOptions = {}) {
    // Validated at construction so a misconfigured service fails on creation
    // rather than on the first document, matching the extraction service.
    this.defaults = resolveChunkingOptions(options);
  }

  chunkText(
    text: string,
    context: ChunkSourceContext = {},
    options?: ChunkingOptions
  ): DocumentChunkingResult {
    const resolved = options
      ? resolveChunkingOptions(mergeChunkingOptions(this.defaults, options))
      : this.defaults;

    // The hash covers the exact text being chunked, so chunk ids stay tied to
    // content even when the caller supplies no document context.
    const contentHash = context.contentHash ?? sha256Hex(text);

    // Whitespace-only is treated as empty: there is nothing to retrieve, and an
    // empty document is a legitimate input rather than an error.
    const spans =
      text.trim().length === 0 ? [] : computeChunkSpans(text, resolved);

    const chunks: DocumentChunk[] = [];
    let previousEnd = -1;

    for (const span of spans) {
      const content = text.slice(span.startOffset, span.endOffset);

      // Drop spans that are pure whitespace — reachable when overlap pulls the
      // window back into a run of blank lines. Indices are assigned after this
      // filter, so the emitted sequence stays contiguous.
      if (content.trim().length === 0) continue;

      const index = chunks.length;
      const overlapWithPrevious =
        previousEnd === -1 ? 0 : Math.max(0, previousEnd - span.startOffset);

      chunks.push({
        id: deriveChunkId(
          contentHash,
          resolved,
          index,
          span.startOffset,
          span.endOffset
        ),
        index,
        content,
        charCount: content.length,
        wordCount: countWords(content),
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        overlapWithPrevious,
        boundary: span.boundary,
        metadata: this.buildMetadata(context, contentHash, span),
      });

      previousEnd = span.endOffset;
    }

    return {
      chunks,
      chunkCount: chunks.length,
      totalCharCount: text.length,
      chunkSize: resolved.chunkSize,
      chunkOverlap: resolved.chunkOverlap,
      chunkingVersion: DOCUMENT_CHUNKING_VERSION,
      contentHash,
    };
  }

  /**
   * Chunks an extraction result, carrying its identity, page map and section
   * map through without the caller having to restate any of it.
   */
  chunkDocument(
    result: DocumentExtractionResult,
    options?: ChunkingOptions & { source?: string }
  ): DocumentChunkingResult {
    const { source, ...chunkOptions } = options ?? {};

    const context: ChunkSourceContext = {
      documentTitle: result.title,
      fileName: result.fileName,
      format: result.format,
      mimeType: result.mimeType,
      contentHash: result.contentHash,
      extractionVersion: result.extractionVersion,
      pages: result.pages,
      sections: result.sections,
    };
    if (source !== undefined) context.source = source;

    return this.chunkText(result.text, context, chunkOptions);
  }

  private buildMetadata(
    context: ChunkSourceContext,
    contentHash: string,
    span: RawChunk
  ): DocumentChunkMetadata {
    const metadata: DocumentChunkMetadata = {
      chunkingVersion: DOCUMENT_CHUNKING_VERSION,
      contentHash,
      pageNumbers: locatePages(context, span.startOffset, span.endOffset),
      sections: locateSectionRefs(context, span.startOffset, span.endOffset),
    };

    // Assigned conditionally so absent provenance stays absent rather than
    // becoming an explicit `undefined` in the persisted JSON.
    if (context.documentTitle !== undefined) metadata.documentTitle = context.documentTitle;
    if (context.fileName !== undefined) metadata.fileName = context.fileName;
    if (context.format !== undefined) metadata.format = context.format;
    if (context.mimeType !== undefined) metadata.mimeType = context.mimeType;
    if (context.source !== undefined) metadata.source = context.source;
    if (context.extractionVersion !== undefined) {
      metadata.extractionVersion = context.extractionVersion;
    }

    const primary = findPrimarySection(context, span.startOffset);
    if (primary !== undefined) metadata.primarySection = primary;

    return metadata;
  }
}
