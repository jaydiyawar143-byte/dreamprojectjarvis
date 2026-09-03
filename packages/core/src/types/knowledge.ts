export interface KnowledgeDocumentData {
  id: string;
  userId: string;
  title: string;
  documentType: string | null;
  mimeType: string | null;
  content: string;
  source: string | null;
  status: string;
  metadata: any | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeChunkData {
  id: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  metadata: any | null;
}

// ---------------------------------------------------------------------------
// Sprint 3.5 — vector search over stored chunks
// ---------------------------------------------------------------------------

/**
 * Restrictions applied to a similarity search, alongside the mandatory
 * ownership scope. Every field maps to a real column on `KnowledgeDocument` or
 * `KnowledgeChunk`; nothing here reaches into the JSON metadata blob.
 *
 * An empty array means no value is allowed, so the search returns nothing.
 */
export interface KnowledgeChunkSearchOptions {
  /** Maximum rows to return. Positive integer. */
  limit: number;
  /** Minimum cosine similarity, between -1 and 1. Omitted means no floor. */
  similarityThreshold?: number;
  documentIds?: string[];
  documentTypes?: string[];
  sources?: string[];
  statuses?: string[];
}

/** A chunk that matched, joined to the document fields needed to cite it. */
export interface KnowledgeChunkMatch extends KnowledgeChunkData {
  documentTitle: string;
  documentType: string | null;
  source: string | null;
  status: string;
  /** Cosine similarity, `1 - distance`. Higher is closer. */
  score: number;
  /** Raw cosine distance. Lower is closer. */
  distance: number;
}

export interface IKnowledgeRepository {
  createDocument(
    userId: string,
    data: {
      title: string;
      content: string;
      documentType?: string;
      mimeType?: string;
      source?: string;
      metadata?: any;
    }
  ): Promise<KnowledgeDocumentData>;

  getDocumentById(id: string, userId: string): Promise<KnowledgeDocumentData | null>;

  listDocuments(userId: string): Promise<KnowledgeDocumentData[]>;

  updateDocumentStatus(
    id: string,
    userId: string,
    status: string
  ): Promise<KnowledgeDocumentData>;

  deleteDocument(id: string, userId: string): Promise<void>;

  createChunks(
    documentId: string,
    chunks: Array<{
      content: string;
      chunkIndex: number;
      metadata?: any;
    }>
  ): Promise<KnowledgeChunkData[]>;

  getChunksByDocument(documentId: string, userId: string): Promise<KnowledgeChunkData[]>;

  deleteChunksByDocument(documentId: string, userId: string): Promise<void>;

  /**
   * Writes vectors onto chunks already created by `createChunks`.
   *
   * Chunks are addressed by `chunkIndex` rather than by row id: that index is
   * the stable document ordering the chunker guarantees, so a caller can embed
   * and persist without holding onto generated row ids.
   *
   * Separate from `createChunks` because embedding is a remote call that can
   * fail on its own — chunks stay usable as plain text if it does.
   *
   * Returns the number of chunks actually updated.
   */
  updateChunkEmbeddings(
    documentId: string,
    embeddings: Array<{ chunkIndex: number; embedding: number[] }>
  ): Promise<number>;

  /**
   * Ranks this user's knowledge chunks by cosine distance to `embedding`.
   *
   * Scoped to the caller by joining through `KnowledgeDocument.userId`: chunks
   * carry no owner of their own, so ownership has to come from the join rather
   * than from a filter the caller supplies.
   *
   * Chunks without an embedding are excluded — a NULL vector has no distance to
   * anything, and a document whose embedding step has not run yet should be
   * absent from results rather than ranked last.
   *
   * Ordering is exact and total: nearest first, ties broken on
   * `(documentId, chunkIndex)` so repeated identical queries return identical
   * result orders.
   */
  searchChunksByEmbedding(
    userId: string,
    embedding: number[],
    options: KnowledgeChunkSearchOptions
  ): Promise<KnowledgeChunkMatch[]>;
}
