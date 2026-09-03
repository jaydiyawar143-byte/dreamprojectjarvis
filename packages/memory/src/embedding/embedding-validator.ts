import { JarvisError } from "@jarvis/core";

/**
 * Validation of embedding provider responses.
 *
 * A provider is a remote service behind an interface — its response is input,
 * not a guarantee. Everything downstream (a `vector(1536)` column, cosine
 * distance) breaks in confusing ways if a malformed vector gets through, so the
 * checks here are deliberately strict and run before anything is persisted:
 *
 *   - the vector count must match the inputs sent, or the pairing between chunk
 *     and vector is meaningless;
 *   - every vector must be a non-empty array of finite numbers — NaN silently
 *     poisons every later distance computation;
 *   - dimensions must be identical across the whole document, and must match
 *     what the provider declares.
 */

/** Throws unless `embeddings` is a usable batch of `expectedCount` vectors. */
export function validateEmbeddingBatch(
  embeddings: unknown,
  expectedCount: number,
  expectedDimensions: number,
  context: Record<string, unknown> = {}
): number[][] {
  if (!Array.isArray(embeddings)) {
    throw new JarvisError(
      "DOCUMENT_EMBEDDING_FAILED",
      "Embedding provider returned a non-array response",
      { ...context, received: typeof embeddings }
    );
  }

  if (embeddings.length !== expectedCount) {
    throw new JarvisError(
      "DOCUMENT_EMBEDDING_FAILED",
      "Embedding count does not match the number of inputs sent",
      { ...context, expected: expectedCount, received: embeddings.length }
    );
  }

  embeddings.forEach((vector, i) => {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new JarvisError(
        "DOCUMENT_EMBEDDING_FAILED",
        "Embedding provider returned an empty or malformed vector",
        { ...context, position: i }
      );
    }

    if (vector.length !== expectedDimensions) {
      throw new JarvisError(
        "DOCUMENT_EMBEDDING_FAILED",
        `Embedding has ${vector.length} dimensions, expected ${expectedDimensions}`,
        { ...context, position: i, expected: expectedDimensions, received: vector.length }
      );
    }

    for (let j = 0; j < vector.length; j++) {
      const value = vector[j];
      // Number.isFinite rejects NaN, ±Infinity and non-numbers in one check.
      if (!Number.isFinite(value)) {
        throw new JarvisError(
          "DOCUMENT_EMBEDDING_FAILED",
          "Embedding contains a non-finite value",
          { ...context, position: i, dimension: j, value: String(value) }
        );
      }
    }
  });

  return embeddings as number[][];
}

/**
 * Wraps a provider failure in a document-scoped error.
 *
 * A `JarvisError` the provider already raised is passed through untouched —
 * the OpenAI provider, for instance, distinguishes `RATE_LIMITED` from
 * `INVALID_REQUEST`, and flattening those into one code would lose the
 * caller's ability to decide whether retrying is worthwhile. This mirrors the
 * pass-through in `MemoryEngine.storeMemory`.
 */
export function wrapProviderFailure(
  error: unknown,
  context: Record<string, unknown>
): never {
  if (error instanceof JarvisError) throw error;

  throw new JarvisError(
    "DOCUMENT_EMBEDDING_FAILED",
    "Embedding provider request failed",
    {
      ...context,
      cause: error instanceof Error ? error.message : String(error),
    }
  );
}
