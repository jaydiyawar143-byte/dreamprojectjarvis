import type { SupportedDocumentFormat } from "./document-extraction.js";

// ---------------------------------------------------------------------------
// Sprint 3.3 — Document Chunking
//
// Splits the normalized text produced by Sprint 3.2 extraction into ordered,
// overlapping chunks. Chunking is a pure function of
// `(text, chunkSize, chunkOverlap, minChunkSize)`: no timestamps, no random
// ids, no ambient state. The same document chunked twice with the same options
// yields deeply equal chunks, including their ids.
//
// This layer stops at chunk boundaries and metadata. It does not embed,
// persist, or retrieve anything.
// ---------------------------------------------------------------------------

/**
 * Version of the chunk boundary + id contract. Recorded on every chunk so that
 * chunks written under an older algorithm can be identified and rebuilt rather
 * than silently mixed with chunks from a newer one.
 *
 * Bump this whenever boundary selection or id derivation changes.
 */
export const DOCUMENT_CHUNKING_VERSION = "3.3.0";

/** Target characters per chunk when the caller does not specify one. */
export const DEFAULT_CHUNK_SIZE = 1000;

/** Characters of the previous chunk repeated at the start of the next. */
export const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * A chunk is never cut shorter than this fraction of `chunkSize` purely to land
 * on a nicer boundary. Without a floor, a document whose only separator sits
 * near the window start would produce a run of near-empty chunks.
 */
export const CHUNK_MIN_FILL_RATIO = 0.5;

/** Upper bound on `chunkSize`, guarding against absurd configuration. */
export const MAX_CHUNK_SIZE = 100_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ChunkingOptions {
  /** Target characters per chunk. Positive integer, defaults to 1000. */
  chunkSize?: number;
  /**
   * Characters of overlap between consecutive chunks. Non-negative integer,
   * strictly less than `chunkSize`, defaults to 200.
   */
  chunkOverlap?: number;
  /**
   * If the final chunk would carry fewer than this many non-whitespace
   * characters, it is merged into the preceding chunk instead of being emitted
   * on its own. 0 disables merging (the default).
   */
  minChunkSize?: number;
}

export interface ResolvedChunkingOptions {
  chunkSize: number;
  chunkOverlap: number;
  minChunkSize: number;
}

// ---------------------------------------------------------------------------
// Chunk
// ---------------------------------------------------------------------------

/**
 * The kind of boundary a chunk's end landed on. Diagnostic only — it explains
 * why a chunk ended where it did without having to re-run the algorithm.
 */
export type ChunkBoundaryKind =
  | "paragraph"
  | "line"
  | "sentence"
  | "word"
  | "hard"
  | "document-end";

/** A section of the source document that a chunk overlaps. */
export interface ChunkSectionRef {
  title: string;
  level: number;
  /** `ExtractedSection.order` from the source document. */
  order: number;
}

/**
 * Provenance carried from the source document onto every chunk.
 *
 * Fields sourced from the document are optional because extraction only
 * populates what the file actually declared; nothing here is inferred.
 * `chunkingVersion` is always present.
 */
export interface DocumentChunkMetadata {
  documentTitle?: string;
  fileName?: string;
  format?: SupportedDocumentFormat;
  mimeType?: string;
  source?: string;
  /** SHA-256 of the source document's normalized text. */
  contentHash?: string;
  extractionVersion?: string;
  chunkingVersion: string;
  /** Source page numbers this chunk overlaps, ascending. Empty when unpaginated. */
  pageNumbers: number[];
  /** Sections this chunk overlaps, in document order. Empty when unstructured. */
  sections: ChunkSectionRef[];
  /** The section containing the chunk's first character, when there is one. */
  primarySection?: ChunkSectionRef;
}

export interface DocumentChunk {
  /**
   * Deterministic identifier. Derived by hashing the chunking version, the
   * document content hash, the chunking options and the chunk's own position,
   * so it is stable across runs and machines — and changes if any of those do.
   */
  id: string;
  /** 0-based position in the document. Contiguous across the result. */
  index: number;
  /**
   * Exact slice of the source text. The invariant
   * `text.slice(startOffset, endOffset) === content` always holds, which is
   * what lets a later stage re-derive a chunk from the document alone.
   */
  content: string;
  charCount: number;
  wordCount: number;
  startOffset: number;
  /** Exclusive. */
  endOffset: number;
  /** Characters shared with the previous chunk; 0 for the first. */
  overlapWithPrevious: number;
  boundary: ChunkBoundaryKind;
  metadata: DocumentChunkMetadata;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface DocumentChunkingResult {
  chunks: DocumentChunk[];
  chunkCount: number;
  /** Characters of source text considered (after normalization by extraction). */
  totalCharCount: number;
  chunkSize: number;
  chunkOverlap: number;
  chunkingVersion: string;
  /** SHA-256 of the chunked text. Ties the result to exact source content. */
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Chunker
// ---------------------------------------------------------------------------

/** Structural context a caller can supply when chunking bare text. */
export interface ChunkSourceContext {
  documentTitle?: string;
  fileName?: string;
  format?: SupportedDocumentFormat;
  mimeType?: string;
  source?: string;
  contentHash?: string;
  extractionVersion?: string;
  pages?: readonly { pageNumber: number; startOffset: number; endOffset: number }[];
  sections?: readonly {
    title: string;
    level: number;
    order: number;
    startOffset: number;
    endOffset: number;
  }[];
}

export interface IDocumentChunker {
  /**
   * Splits normalized text into ordered chunks. Empty or whitespace-only text
   * yields zero chunks rather than an error — an empty document is a valid
   * input, just one with nothing to index.
   *
   * Throws a `JarvisError` with code `INVALID_REQUEST` for invalid options.
   */
  chunkText(
    text: string,
    context?: ChunkSourceContext,
    options?: ChunkingOptions
  ): DocumentChunkingResult;
}
