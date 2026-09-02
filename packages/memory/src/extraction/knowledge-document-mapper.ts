import type {
  DocumentExtractionResult,
  IKnowledgeRepository,
} from "@jarvis/core";

/**
 * Bridge from an extraction result to the Sprint 3.1 knowledge repository.
 *
 * The return type is pinned to the repository's own parameter type, so this
 * mapper cannot drift from `IKnowledgeRepository.createDocument` without a
 * compile error. Nothing here changes the Sprint 3.1 contract: extraction is a
 * producer of that existing shape, not an extension of it.
 *
 * Persistence stays the caller's decision — the mapper only builds the payload,
 * so extraction remains usable without a database.
 */
export type KnowledgeDocumentInput = Parameters<
  IKnowledgeRepository["createDocument"]
>[1];

export interface KnowledgeDocumentMapOptions {
  /** Provenance label (upload id, URL, path) recorded on the document. */
  source?: string;
  /** Overrides the derived title. */
  title?: string;
}

/**
 * Structural detail is kept in `metadata` rather than spread across columns:
 * the Sprint 3.1 schema stores it as a single JSON blob, and page and section
 * offsets are only meaningful alongside the exact text they index — which
 * `contentHash` and `extractionVersion` let a later stage verify.
 */
export function toKnowledgeDocumentInput(
  result: DocumentExtractionResult,
  options: KnowledgeDocumentMapOptions = {}
): KnowledgeDocumentInput {
  const input: KnowledgeDocumentInput = {
    title: options.title ?? result.title,
    content: result.text,
    documentType: result.format,
    mimeType: result.mimeType,
    metadata: {
      fileName: result.fileName,
      charCount: result.charCount,
      wordCount: result.wordCount,
      byteSize: result.byteSize,
      contentHash: result.contentHash,
      extractionVersion: result.extractionVersion,
      pageCount: result.metadata.pageCount ?? null,
      pages: result.pages,
      sections: result.sections,
      document: result.metadata,
    },
  };

  if (options.source !== undefined) input.source = options.source;

  return input;
}
