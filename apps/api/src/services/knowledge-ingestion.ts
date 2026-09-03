// ---------------------------------------------------------------------------
// Sprint 3.6 — Knowledge ingestion pipeline.
//
// Composes the layers built in Sprints 3.2 through 3.4 into the single
// operation the API exposes:
//
//   extract (3.2) -> persist document (3.1) -> chunk (3.3)
//                 -> persist chunks (3.1) -> embed + persist vectors (3.4)
//
// Nothing here re-implements those layers; it only sequences them and owns the
// document status that records how far the sequence got. Every collaborator is
// injected, so the pipeline is testable without a database, an OpenAI key, or
// a real PDF.
// ---------------------------------------------------------------------------

import {
  JarvisError,
  type DocumentChunkingResult,
  type DocumentExtractionResult,
  type IDocumentExtractor,
  type IKnowledgeRepository,
  type KnowledgeDocumentData,
} from "@jarvis/core";
import {
  toKnowledgeChunkInputs,
  toKnowledgeDocumentInput,
  type DocumentChunkingService,
  type DocumentEmbeddingService,
} from "@jarvis/memory";

/**
 * Document lifecycle states written by this pipeline.
 *
 * The Sprint 3.1 schema stores `status` as a free-form string with a default of
 * `UPLOADED`, so these are the values this layer defines rather than a schema
 * enum. They are deliberately coarse: a caller needs to know whether the
 * document is searchable, not which internal step it reached.
 */
export const KNOWLEDGE_DOCUMENT_STATUS = {
  /** Text and chunks stored, vectors written: searchable. */
  processed: "PROCESSED",
  /**
   * Text and chunks stored, but no embedding provider is configured. The
   * document is readable and will not appear in search results.
   */
  pendingEmbedding: "PENDING_EMBEDDING",
  /** A step after the document row failed. The row is kept for diagnosis. */
  failed: "FAILED",
} as const;

/** Only the chunker method this pipeline uses, so tests can supply a stub. */
export type DocumentChunkerLike = Pick<DocumentChunkingService, "chunkDocument">;

/** Only the embedder method this pipeline uses. */
export type DocumentEmbedderLike = Pick<DocumentEmbeddingService, "embedAndPersist">;

export interface KnowledgeIngestionDeps {
  repository: IKnowledgeRepository;
  extractor: IDocumentExtractor;
  chunker: DocumentChunkerLike;
  /**
   * Null when no embedding provider is configured. Ingestion still stores the
   * document and its chunks — Sprint 3.4 keeps chunks valid as plain text
   * without vectors — and reports the document as PENDING_EMBEDDING.
   */
  embedder: DocumentEmbedderLike | null;
}

export interface KnowledgeIngestionRequest {
  fileName: string;
  content: Uint8Array;
  mimeType?: string;
  source?: string;
  /** Overrides the title derived from the document itself. */
  title?: string;
}

export interface KnowledgeIngestionResult {
  document: KnowledgeDocumentData;
  status: string;
  chunkCount: number;
  embeddedCount: number;
  /** Chunks deliberately not embedded because they were empty or too short. */
  skippedCount: number;
  /** False when no provider was configured, so the document is not searchable. */
  embedded: boolean;
  extraction: DocumentExtractionResult;
}

export class KnowledgeIngestionService {
  private readonly repository: IKnowledgeRepository;
  private readonly extractor: IDocumentExtractor;
  private readonly chunker: DocumentChunkerLike;
  private readonly embedder: DocumentEmbedderLike | null;

  constructor(deps: KnowledgeIngestionDeps) {
    if (!deps?.repository) {
      throw new JarvisError("INVALID_REQUEST", "A knowledge repository is required");
    }
    if (!deps.extractor) {
      throw new JarvisError("INVALID_REQUEST", "A document extractor is required");
    }
    if (!deps.chunker) {
      throw new JarvisError("INVALID_REQUEST", "A document chunker is required");
    }
    this.repository = deps.repository;
    this.extractor = deps.extractor;
    this.chunker = deps.chunker;
    this.embedder = deps.embedder;
  }

  /** True when vectors can be produced, and therefore when search is usable. */
  get embeddingEnabled(): boolean {
    return this.embedder !== null;
  }

  async ingest(
    userId: string,
    request: KnowledgeIngestionRequest
  ): Promise<KnowledgeIngestionResult> {
    if (typeof userId !== "string" || userId.trim().length === 0) {
      throw new JarvisError("INVALID_REQUEST", "A userId is required to ingest");
    }

    // Extraction runs before anything is written. It is the step most likely to
    // reject the input (unsupported format, corrupt bytes, empty text), and a
    // rejected upload should leave no row behind at all.
    const extraction = await this.extractor.extract({
      fileName: request.fileName,
      content: request.content,
      ...(request.mimeType !== undefined ? { mimeType: request.mimeType } : {}),
      ...(request.source !== undefined ? { source: request.source } : {}),
    });

    const documentInput = toKnowledgeDocumentInput(extraction, {
      ...(request.source !== undefined ? { source: request.source } : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
    });

    const document = await this.repository.createDocument(userId, documentInput);

    // From here the row exists, so every later failure marks it FAILED before
    // rethrowing. A document stuck at UPLOADED would be indistinguishable from
    // one whose ingestion is still in flight.
    try {
      const chunking: DocumentChunkingResult = this.chunker.chunkDocument(extraction, {
        ...(request.source !== undefined ? { source: request.source } : {}),
      });

      if (chunking.chunks.length === 0) {
        // A document that normalizes to nothing chunkable is still a valid
        // document; it simply has nothing to index.
        const finished = await this.repository.updateDocumentStatus(
          document.id,
          userId,
          KNOWLEDGE_DOCUMENT_STATUS.processed
        );
        return {
          document: finished,
          status: finished.status,
          chunkCount: 0,
          embeddedCount: 0,
          skippedCount: 0,
          embedded: this.embedder !== null,
          extraction,
        };
      }

      await this.repository.createChunks(
        document.id,
        toKnowledgeChunkInputs(chunking)
      );

      let embeddedCount = 0;
      let skippedCount = 0;

      if (this.embedder) {
        const embeddingResult = await this.embedder.embedAndPersist(
          this.repository,
          document.id,
          chunking.chunks
        );
        embeddedCount = embeddingResult.persistedCount;
        skippedCount = embeddingResult.skippedCount;
      }

      const status = this.embedder
        ? KNOWLEDGE_DOCUMENT_STATUS.processed
        : KNOWLEDGE_DOCUMENT_STATUS.pendingEmbedding;

      const finished = await this.repository.updateDocumentStatus(
        document.id,
        userId,
        status
      );

      return {
        document: finished,
        status: finished.status,
        chunkCount: chunking.chunks.length,
        embeddedCount,
        skippedCount,
        embedded: this.embedder !== null,
        extraction,
      };
    } catch (error) {
      await this.markFailed(document.id, userId);
      throw error;
    }
  }

  /**
   * Best-effort status update on the failure path. A failure to record the
   * failure must not replace the original error, which is the one that explains
   * what actually went wrong.
   */
  private async markFailed(documentId: string, userId: string): Promise<void> {
    try {
      await this.repository.updateDocumentStatus(
        documentId,
        userId,
        KNOWLEDGE_DOCUMENT_STATUS.failed
      );
    } catch {
      // Intentionally swallowed; the caller rethrows the original error.
    }
  }
}
