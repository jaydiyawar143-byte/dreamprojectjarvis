import type { DocumentChunk } from "./document-chunking.js";

// ---------------------------------------------------------------------------
// Sprint 3.4 — Document Embeddings
//
// Turns the deterministic chunks produced by Sprint 3.3 into vectors, using the
// project's existing `IEmbeddingProvider` abstraction. This layer stops at
// vector generation and persistence: it performs no similarity search, ranking,
// or retrieval.
//
// A remote embedding model is not bit-reproducible, so "deterministic" here is
// an application-level guarantee, not a numerical one:
//   - chunks are embedded in `index` order and paired back by position;
//   - identical chunk text is sent once and reuses the same vector within a run;
//   - the batch split is a pure function of chunk count and batch size;
//   - every response is length- and dimension-checked before it is accepted.
// ---------------------------------------------------------------------------

/**
 * Version of the embedding input + validation contract. Recorded on every
 * vector so rows produced under an older contract can be found and rebuilt.
 */
export const DOCUMENT_EMBEDDING_VERSION = "3.4.0";

/**
 * Chunks per provider request. 64 keeps a single failed batch cheap to retry
 * while staying well inside typical provider input limits.
 */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 64;

/** Upper bound on batch size, guarding against absurd configuration. */
export const MAX_EMBEDDING_BATCH_SIZE = 2048;

/**
 * Minimum non-whitespace characters a chunk must carry to be worth embedding.
 * A one- or two-character fragment produces a vector that is noise in a
 * similarity space, so such chunks are skipped rather than embedded.
 */
export const DEFAULT_MIN_EMBEDDABLE_CHARS = 3;

// ---------------------------------------------------------------------------
// Skips
// ---------------------------------------------------------------------------

export type EmbeddingSkipReason = "empty" | "too-short";

/**
 * A chunk deliberately not embedded. Reported rather than silently dropped, so
 * a caller can tell the difference between "this document had 40 chunks and 40
 * vectors" and "40 chunks, 38 vectors, 2 too short to be useful".
 */
export interface SkippedChunk {
  chunkId: string;
  index: number;
  reason: EmbeddingSkipReason;
  /** Non-whitespace character count that triggered the skip. */
  charCount: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ChunkEmbedding {
  /** The Sprint 3.3 deterministic chunk id. */
  chunkId: string;
  /** The chunk's position in its document; also the persistence key. */
  index: number;
  embedding: number[];
  dimensions: number;
  /** Model reported by the provider for this vector. */
  model: string;
  embeddingVersion: string;
}

export interface DocumentEmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface DocumentEmbeddingResult {
  /** Vectors in ascending chunk index order. */
  embeddings: ChunkEmbedding[];
  embeddedCount: number;
  skipped: SkippedChunk[];
  skippedCount: number;
  model: string;
  dimensions: number;
  embeddingVersion: string;
  /** Provider calls actually made. */
  batchCount: number;
  /** Chunks that reused an identical earlier chunk's vector instead of a call. */
  deduplicatedCount: number;
  usage?: DocumentEmbeddingUsage;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DocumentEmbeddingOptions {
  /** Chunks per provider request. Positive integer, defaults to 64. */
  batchSize?: number;
  /** Minimum non-whitespace characters to embed a chunk. Defaults to 3. */
  minChars?: number;
  /** Overrides the provider's default model for this call. */
  model?: string;
}

export interface ResolvedEmbeddingOptions {
  batchSize: number;
  minChars: number;
  model?: string;
}

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export interface IDocumentEmbedder {
  /**
   * Embeds chunks, skipping any that are empty or too short to be meaningful.
   * An empty input, or one where every chunk is skipped, yields a result with
   * no vectors rather than an error.
   *
   * Throws a `JarvisError` with code `DOCUMENT_EMBEDDING_FAILED` when the
   * provider fails or returns a response that does not validate, and
   * `INVALID_REQUEST` for invalid options.
   */
  embedChunks(
    chunks: readonly DocumentChunk[],
    options?: DocumentEmbeddingOptions
  ): Promise<DocumentEmbeddingResult>;
}
