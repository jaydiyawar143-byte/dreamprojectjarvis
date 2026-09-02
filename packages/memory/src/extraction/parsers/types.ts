import type { ExtractedDocumentMetadata } from "@jarvis/core";

/**
 * Internal contract between a format parser and the extraction service.
 *
 * Parsers return raw, un-normalized text. Normalization, offset arithmetic and
 * section assembly happen once in the service so that every format is treated
 * identically — a parser that normalized its own output could drift from the
 * others.
 */

/** One unit of source text. PDFs emit one block per page; other formats emit one. */
export interface ParsedBlock {
  /** 1-based page number. Always 1 for non-paginated formats. */
  pageNumber: number;
  text: string;
}

/** A heading recovered from a structured format, in document order. */
export interface ParsedHeading {
  title: string;
  /** 1-6, mirroring HTML heading levels. */
  level: number;
}

export interface ParsedDocument {
  blocks: ParsedBlock[];
  /** True when `blocks` correspond to real source pages worth reporting. */
  paginated: boolean;
  /**
   * Headings the parser recovered. Omitted when the format carries no heading
   * structure, or when sections are derived from the normalized text instead
   * (Markdown), which yields exact offsets without a search.
   */
  headings?: ParsedHeading[];
  metadata: Omit<ExtractedDocumentMetadata, "warnings"> & { warnings: string[] };
}
