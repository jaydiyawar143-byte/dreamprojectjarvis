import type { ChunkSectionRef } from "./document-chunking.js";

// ---------------------------------------------------------------------------
// Sprint 3.5 — Knowledge Vector Retrieval
//
// Takes a text query, embeds it through the same `IEmbeddingProvider`
// abstraction Sprint 3.4 uses, and finds the nearest stored knowledge chunks by
// cosine distance.
//
// This layer stops at ranked chunks. It performs no answer generation, no
// prompt assembly and no RAG orchestration — a caller decides what to do with
// the passages it returns.
//
// On determinism: the ranking is exact (a full scan with pgvector's `<=>`),
// never approximate, and ties are broken on `(documentId, chunkIndex)`. Two
// chunks holding identical text produce identical vectors and therefore an
// identical distance, and Postgres does not promise a row order for those — so
// without an explicit tiebreak the "same" query could return the same rows in a
// different order between runs.
// ---------------------------------------------------------------------------

/** Version of the retrieval scoring + ordering contract. */
export const KNOWLEDGE_RETRIEVAL_VERSION = "3.5.0";

/** Chunks returned when the caller does not ask for a specific count. */
export const DEFAULT_RETRIEVAL_TOP_K = 5;

/** Upper bound on `topK`, guarding against absurd configuration. */
export const MAX_RETRIEVAL_TOP_K = 100;

/**
 * The default floor keeps only chunks that point the same way as the query.
 *
 * A similarity below 0 means the vectors point away from each other, which is
 * never a useful passage, so 0 costs nothing real. Anything stricter is left to
 * the caller: a useful cutoff depends entirely on the embedding model — 0.5 is
 * a strong match for one and background noise for another — so a higher default
 * would silently drop results for a reason the caller never chose. Pass -1 to
 * disable the floor entirely.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0;

/** Cosine similarity is `1 - cosine distance`, so it spans [-1, 1]. */
export const MIN_SIMILARITY_THRESHOLD = -1;
export const MAX_SIMILARITY_THRESHOLD = 1;

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Restrictions applied alongside the vector search.
 *
 * Only fields the Sprint 3.1 schema actually stores as columns are filterable:
 * `KnowledgeDocument.documentType`, `.source` and `.status`, plus the chunk's
 * own document id. Chunk metadata is a JSON blob with no index behind it, so
 * filtering on it is left out rather than offered as a trap.
 *
 * An empty array means "no value is allowed" and yields no results. It does not
 * mean "unfiltered" — a caller that computed an empty allow-list expects
 * nothing back, not everything.
 */
export interface KnowledgeRetrievalFilters {
  documentIds?: string[];
  documentTypes?: string[];
  sources?: string[];
  statuses?: string[];
}

export interface KnowledgeRetrievalOptions extends KnowledgeRetrievalFilters {
  /** Maximum chunks to return. Positive integer, defaults to 5. */
  topK?: number;
  /**
   * Minimum cosine similarity a chunk must reach to be returned.
   * Between -1 and 1, defaults to 0 (no filtering).
   */
  similarityThreshold?: number;
  /** Overrides the provider's default model when embedding the query. */
  model?: string;
}

export interface ResolvedRetrievalOptions {
  topK: number;
  similarityThreshold: number;
  filters: KnowledgeRetrievalFilters;
  model?: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * One matching chunk with its full provenance.
 *
 * Page and section fields are lifted out of the chunk metadata Sprint 3.3
 * wrote, so a caller can cite "page 4, Refund Policy" without re-parsing a JSON
 * blob. The untouched blob stays on `metadata` so nothing is lost in the lift.
 */
export interface RetrievedChunk {
  /** The `KnowledgeChunk` row id. */
  chunkId: string;
  /** The Sprint 3.3 deterministic chunk id, when the chunk carries one. */
  deterministicChunkId?: string;
  documentId: string;
  documentTitle: string;
  documentType: string | null;
  source: string | null;
  /** Position within the document; the Sprint 3.3 ordering. */
  chunkIndex: number;
  content: string;
  /** Cosine similarity, `1 - distance`. Higher is closer. */
  score: number;
  /** Raw cosine distance from pgvector. Lower is closer. */
  distance: number;
  /** Source pages this chunk overlaps, ascending. Empty when unpaginated. */
  pageNumbers: number[];
  /** Sections this chunk overlaps, in document order. */
  sections: ChunkSectionRef[];
  /** The section containing the chunk's first character, when there is one. */
  primarySection?: ChunkSectionRef;
  /** Offsets into the source document text, when the chunk carries them. */
  startOffset?: number;
  endOffset?: number;
  /** The chunk metadata exactly as stored. */
  metadata: Record<string, unknown> | null;
}

export interface KnowledgeRetrievalResult {
  /** The query as received, before trimming. */
  query: string;
  /** Matches in descending relevance order. */
  results: RetrievedChunk[];
  resultCount: number;
  topK: number;
  similarityThreshold: number;
  /** Dimensions of the query vector, as declared by the provider. */
  dimensions: number;
  /** Model the provider reported for the query embedding. */
  model: string;
  retrievalVersion: string;
  /**
   * True when the query held no searchable text, so no provider call and no
   * database query were made. Lets a caller tell an empty query apart from a
   * query that genuinely matched nothing.
   */
  emptyQuery: boolean;
}

// ---------------------------------------------------------------------------
// Retriever
// ---------------------------------------------------------------------------

export interface IKnowledgeRetriever {
  /**
   * Finds the knowledge chunks closest to `query` for one user.
   *
   * An empty or whitespace-only query returns an empty result rather than an
   * error, as does a query that matches nothing — both are ordinary outcomes,
   * not failures.
   *
   * Throws a `JarvisError` with code `INVALID_REQUEST` for invalid options,
   * `DOCUMENT_EMBEDDING_FAILED` when the query cannot be embedded, and
   * `KNOWLEDGE_RETRIEVAL_FAILED` when the similarity search itself fails.
   */
  retrieve(
    userId: string,
    query: string,
    options?: KnowledgeRetrievalOptions
  ): Promise<KnowledgeRetrievalResult>;
}
