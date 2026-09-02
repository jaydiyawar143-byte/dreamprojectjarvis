import { createHash } from "node:crypto";
import {
  DOCUMENT_EXTRACTION_VERSION,
  JarvisError,
  type DocumentExtractionRequest,
  type DocumentExtractionResult,
  type ExtractedDocumentMetadata,
  type ExtractedPage,
  type ExtractedSection,
  type IDocumentExtractor,
} from "@jarvis/core";
import {
  isSupportedDocument,
  resolveValidationConfig,
  validateDocumentInput,
  type DocumentValidationConfig,
  type ValidatedDocument,
} from "./document-validator.js";
import {
  BLOCK_SEPARATOR,
  countWords,
  normalizeInlineText,
  normalizeText,
} from "./text-normalizer.js";
import {
  extractMarkdownSections,
  locateSections,
} from "./section-extractor.js";
import {
  createDefaultPdfBackend,
  parsePdf,
  type PdfParseBackend,
} from "./parsers/pdf-parser.js";
import {
  createDefaultDocxBackend,
  parseDocx,
  type DocxParseBackend,
} from "./parsers/docx-parser.js";
import { parseText } from "./parsers/text-parser.js";
import type { ParsedDocument } from "./parsers/types.js";

/**
 * Sprint 3.2 — document text extraction.
 *
 * Turns an uploaded file into normalized text plus the structural metadata a
 * later chunking stage needs. Extraction stops there: this service does not
 * chunk, embed, or persist anything. Use {@link toKnowledgeDocumentInput} to
 * hand the result to the Sprint 3.1 knowledge repository.
 *
 * Extraction is a pure function of `(fileName, bytes)`: the result carries no
 * timestamps or identifiers, so re-running it on the same file always yields a
 * deeply equal object. That is what makes `contentHash` usable for detecting
 * whether a re-uploaded document actually changed.
 */

export interface DocumentExtractionServiceConfig extends DocumentValidationConfig {
  /** Overrides the PDF backend. Defaults to a lazily loaded `pdf-parse`. */
  pdfBackend?: PdfParseBackend;
  /** Overrides the DOCX backend. Defaults to a lazily loaded `mammoth`. */
  docxBackend?: DocxParseBackend;
  /**
   * Maximum characters of extracted text to keep. Text longer than this is
   * rejected rather than truncated — a silently shortened document would be
   * indexed as if complete.
   */
  maxTextLength?: number;
}

/** Ceiling on extracted characters, independent of the byte-size limit. */
export const DEFAULT_MAX_TEXT_LENGTH = 5_000_000;

interface AssembledText {
  text: string;
  pages: ExtractedPage[];
}

export class DocumentExtractionService implements IDocumentExtractor {
  private readonly validationConfig: DocumentValidationConfig;
  private readonly maxTextLength: number;
  private readonly pdfBackend: PdfParseBackend;
  private readonly docxBackend: DocxParseBackend;

  constructor(config: DocumentExtractionServiceConfig = {}) {
    const {
      pdfBackend,
      docxBackend,
      maxTextLength,
      ...validationConfig
    } = config;

    // Validated eagerly so a misconfigured limit fails at construction rather
    // than on the first upload.
    resolveValidationConfig(validationConfig);

    this.validationConfig = validationConfig;
    this.maxTextLength = maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;

    if (!Number.isInteger(this.maxTextLength) || this.maxTextLength <= 0) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "maxTextLength must be a positive integer"
      );
    }

    this.pdfBackend = pdfBackend ?? createDefaultPdfBackend();
    this.docxBackend = docxBackend ?? createDefaultDocxBackend();
  }

  supports(fileName: string, mimeType?: string): boolean {
    return isSupportedDocument(fileName, mimeType, this.validationConfig);
  }

  async extract(
    request: DocumentExtractionRequest
  ): Promise<DocumentExtractionResult> {
    const validated = validateDocumentInput(request, this.validationConfig);
    const parsed = await this.parse(request.content, validated);
    const assembled = this.assemble(parsed, validated);
    const sections = this.deriveSections(assembled.text, parsed, validated);

    return {
      format: validated.format,
      mimeType: validated.mimeType,
      fileName: validated.fileName,
      title: deriveTitle(parsed.metadata, sections, assembled.text, validated),
      text: assembled.text,
      charCount: assembled.text.length,
      wordCount: countWords(assembled.text),
      byteSize: validated.byteSize,
      contentHash: createHash("sha256").update(assembled.text, "utf8").digest("hex"),
      pages: parsed.paginated ? assembled.pages : [],
      sections,
      metadata: buildMetadata(parsed.metadata),
      extractionVersion: DOCUMENT_EXTRACTION_VERSION,
    };
  }

  private async parse(
    content: Uint8Array,
    validated: ValidatedDocument
  ): Promise<ParsedDocument> {
    switch (validated.format) {
      case "PDF":
        return parsePdf(content, validated.fileName, this.pdfBackend);
      case "DOCX":
        return parseDocx(content, validated.fileName, this.docxBackend);
      case "TXT":
      case "MD":
        return parseText(content, validated.format);
    }
  }

  /**
   * Normalizes each block and concatenates them, recording where every source
   * page landed. Because each block is normalized and trimmed and the separator
   * is exactly one blank line, the concatenation is itself already normalized —
   * no second pass that would invalidate the offsets.
   */
  private assemble(
    parsed: ParsedDocument,
    validated: ValidatedDocument
  ): AssembledText {
    const parts: string[] = [];
    const pages: ExtractedPage[] = [];
    let offset = 0;

    for (const block of parsed.blocks) {
      const text = normalizeText(block.text);

      if (text.length === 0) {
        // Image-only PDF pages still get an entry, so page numbering stays
        // aligned with the source document.
        pages.push({
          pageNumber: block.pageNumber,
          charCount: 0,
          startOffset: offset,
          endOffset: offset,
        });
        continue;
      }

      if (parts.length > 0) {
        parts.push(BLOCK_SEPARATOR);
        offset += BLOCK_SEPARATOR.length;
      }

      pages.push({
        pageNumber: block.pageNumber,
        charCount: text.length,
        startOffset: offset,
        endOffset: offset + text.length,
      });
      parts.push(text);
      offset += text.length;
    }

    const text = parts.join("");

    if (text.length === 0) {
      throw new JarvisError(
        "DOCUMENT_EMPTY",
        `No readable text could be extracted from this ${validated.format} file`,
        { fileName: validated.fileName, format: validated.format }
      );
    }
    if (text.length > this.maxTextLength) {
      throw new JarvisError(
        "DOCUMENT_TOO_LARGE",
        `Extracted text exceeds the maximum length of ${this.maxTextLength} characters`,
        { charCount: text.length, maxTextLength: this.maxTextLength }
      );
    }

    return { text, pages };
  }

  private deriveSections(
    text: string,
    parsed: ParsedDocument,
    validated: ValidatedDocument
  ): ExtractedSection[] {
    if (validated.format === "MD") return extractMarkdownSections(text);
    if (parsed.headings !== undefined) return locateSections(text, parsed.headings);
    return [];
  }
}

function buildMetadata(
  parsed: ParsedDocument["metadata"]
): ExtractedDocumentMetadata {
  const metadata: ExtractedDocumentMetadata = { warnings: [...parsed.warnings] };

  // Assigned conditionally so absent fields stay absent rather than becoming
  // explicit `undefined` keys, which would break deep-equality determinism
  // checks and add noise to the persisted metadata blob.
  if (parsed.title !== undefined) metadata.title = parsed.title;
  if (parsed.author !== undefined) metadata.author = parsed.author;
  if (parsed.subject !== undefined) metadata.subject = parsed.subject;
  if (parsed.keywords !== undefined) metadata.keywords = parsed.keywords;
  if (parsed.creator !== undefined) metadata.creator = parsed.creator;
  if (parsed.producer !== undefined) metadata.producer = parsed.producer;
  if (parsed.createdAt !== undefined) metadata.createdAt = parsed.createdAt;
  if (parsed.modifiedAt !== undefined) metadata.modifiedAt = parsed.modifiedAt;
  if (parsed.pageCount !== undefined) metadata.pageCount = parsed.pageCount;

  return metadata;
}

/** Longest first line still treated as a title rather than as body text. */
const MAX_DERIVED_TITLE_LENGTH = 120;

/**
 * Picks a title by a fixed precedence, so the same file always yields the same
 * one: embedded document metadata, then the first section heading, then a short
 * enough opening line, and finally the file name with its extension removed.
 */
function deriveTitle(
  metadata: ParsedDocument["metadata"],
  sections: readonly ExtractedSection[],
  text: string,
  validated: ValidatedDocument
): string {
  const fromMetadata = normalizeInlineText(metadata.title ?? "");
  if (fromMetadata.length > 0) return fromMetadata;

  if (sections.length > 0 && sections[0].title.length > 0) {
    return sections[0].title;
  }

  const firstLine = normalizeInlineText(text.split("\n", 1)[0] ?? "");
  if (firstLine.length > 0 && firstLine.length <= MAX_DERIVED_TITLE_LENGTH) {
    return firstLine;
  }

  const dot = validated.fileName.lastIndexOf(".");
  const base = dot > 0 ? validated.fileName.slice(0, dot) : validated.fileName;
  return base.length > 0 ? base : validated.fileName;
}
