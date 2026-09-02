import { z } from "zod";

// ---------------------------------------------------------------------------
// Supported Formats (Sprint 3.2)
//
// Extraction is deliberately limited to formats whose text can be recovered
// deterministically. Anything outside this set is rejected at validation time
// rather than best-effort parsed.
// ---------------------------------------------------------------------------

export const SupportedDocumentFormatSchema = z.enum(["PDF", "DOCX", "TXT", "MD"]);

export type SupportedDocumentFormat = z.infer<typeof SupportedDocumentFormatSchema>;

/**
 * Static description of a supported format.
 *
 * `mimeTypes` is an allowlist: a caller-supplied MIME type must appear here for
 * the declared extension, otherwise the pair is treated as a mismatch. The
 * first entry is the canonical type recorded on the extracted document.
 *
 * `magicBytes` is the leading byte signature every valid file of a binary
 * format must carry. Text formats have no signature and are validated by
 * strict UTF-8 decoding instead.
 */
export interface DocumentFormatDescriptor {
  readonly format: SupportedDocumentFormat;
  readonly extensions: readonly string[];
  readonly mimeTypes: readonly string[];
  readonly canonicalMimeType: string;
  readonly binary: boolean;
  readonly magicBytes?: readonly number[];
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const; // "PK\x03\x04" (OOXML container)

export const DOCUMENT_FORMATS: Readonly<
  Record<SupportedDocumentFormat, DocumentFormatDescriptor>
> = {
  PDF: {
    format: "PDF",
    extensions: [".pdf"],
    mimeTypes: ["application/pdf", "application/x-pdf"],
    canonicalMimeType: "application/pdf",
    binary: true,
    magicBytes: PDF_MAGIC,
  },
  DOCX: {
    format: "DOCX",
    extensions: [".docx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    canonicalMimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    binary: true,
    magicBytes: ZIP_MAGIC,
  },
  TXT: {
    format: "TXT",
    extensions: [".txt"],
    mimeTypes: ["text/plain"],
    canonicalMimeType: "text/plain",
    binary: false,
  },
  MD: {
    format: "MD",
    extensions: [".md", ".markdown"],
    mimeTypes: ["text/markdown", "text/x-markdown", "text/plain"],
    canonicalMimeType: "text/markdown",
    binary: false,
  },
};

export const SUPPORTED_DOCUMENT_FORMATS: readonly SupportedDocumentFormat[] = [
  "PDF",
  "DOCX",
  "TXT",
  "MD",
];

/** Every extension accepted by the extractor, lowercase and dot-prefixed. */
export const SUPPORTED_DOCUMENT_EXTENSIONS: readonly string[] =
  SUPPORTED_DOCUMENT_FORMATS.flatMap((f) => [...DOCUMENT_FORMATS[f].extensions]);

// ---------------------------------------------------------------------------
// Extraction Limits
// ---------------------------------------------------------------------------

/** Default maximum accepted upload size. Overridable per extractor instance. */
export const DEFAULT_MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Upper bound on a file name, matching the common filesystem limit. */
export const DEFAULT_MAX_FILE_NAME_LENGTH = 255;

/**
 * Version of the normalization + offset contract. Recorded in extracted
 * metadata so documents indexed under an older contract can be identified and
 * re-extracted later without guessing.
 */
export const DOCUMENT_EXTRACTION_VERSION = "3.2.0";

// ---------------------------------------------------------------------------
// Extraction Result
// ---------------------------------------------------------------------------

/**
 * One source page of a paginated document.
 *
 * Offsets index into `DocumentExtractionResult.text` — `text.slice(start, end)`
 * is exactly this page's normalized content. A page whose text normalized to
 * nothing is still reported, with `startOffset === endOffset`.
 */
export interface ExtractedPage {
  pageNumber: number;
  charCount: number;
  startOffset: number;
  endOffset: number;
}

/**
 * A heading-delimited region of a structured document.
 *
 * Sections are a flat sequence in document order: each one runs from its own
 * heading to the next heading of any level, so ranges never overlap and nesting
 * is expressed by `level` rather than containment.
 */
export interface ExtractedSection {
  title: string;
  level: number;
  order: number;
  startOffset: number;
  endOffset: number;
}

/**
 * Metadata recovered from the document itself. Every field is optional because
 * it is only ever populated from what the source actually declared — nothing
 * here is inferred or defaulted.
 */
export interface ExtractedDocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  createdAt?: string;
  modifiedAt?: string;
  pageCount?: number;
  /** Non-fatal parser diagnostics, retained for auditability. */
  warnings: string[];
}

/**
 * Result of a successful extraction.
 *
 * The whole object is a pure function of the input bytes and file name: it
 * carries no timestamps, ids, or other ambient state, so identical input always
 * produces a deeply equal result.
 */
export interface DocumentExtractionResult {
  format: SupportedDocumentFormat;
  mimeType: string;
  fileName: string;
  /** Best available human-readable title; never empty. */
  title: string;
  /** Normalized full text. */
  text: string;
  charCount: number;
  wordCount: number;
  byteSize: number;
  /** SHA-256 hex digest of the normalized text. */
  contentHash: string;
  pages: ExtractedPage[];
  sections: ExtractedSection[];
  metadata: ExtractedDocumentMetadata;
  extractionVersion: string;
}

// ---------------------------------------------------------------------------
// Extraction Request
// ---------------------------------------------------------------------------

export interface DocumentExtractionRequest {
  /** Base file name including extension. Must not contain a path. */
  fileName: string;
  /** Raw file bytes. */
  content: Uint8Array;
  /** Client-declared MIME type, validated against the extension when present. */
  mimeType?: string;
  /** Provenance label (e.g. an upload id or URL) carried through to metadata. */
  source?: string;
}

export interface IDocumentExtractor {
  /** Extracts normalized text and metadata, or throws a `JarvisError`. */
  extract(request: DocumentExtractionRequest): Promise<DocumentExtractionResult>;

  /** True when the file name (and MIME type, if given) resolve to a supported format. */
  supports(fileName: string, mimeType?: string): boolean;
}
