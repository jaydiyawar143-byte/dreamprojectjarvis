import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_MIN_EMBEDDABLE_CHARS,
  DOCUMENT_EMBEDDING_VERSION,
  JarvisError,
  MAX_EMBEDDING_BATCH_SIZE,
  type ChunkEmbedding,
  type DocumentChunk,
  type DocumentEmbeddingOptions,
  type DocumentEmbeddingResult,
  type DocumentEmbeddingUsage,
  type IDocumentEmbedder,
  type IEmbeddingProvider,
  type IKnowledgeRepository,
  type ResolvedEmbeddingOptions,
  type SkippedChunk,
} from "@jarvis/core";
import { validateEmbeddingBatch, wrapProviderFailure } from "./embedding-validator.js";

/**
 * Sprint 3.4 — document embeddings.
 *
 * Generates vectors for Sprint 3.3 chunks through the project's existing
 * `IEmbeddingProvider` abstraction, and optionally writes them onto the
 * Sprint 3.1 knowledge chunks. It performs no similarity search or retrieval.
 *
 * The provider is injected, never constructed here, so swapping OpenAI for
 * another backend is a wiring change rather than an edit to this file.
 *
 * On determinism: a hosted embedding model is not bit-reproducible, so this
 * layer guarantees what it actually can —
 *   - chunks are processed in `index` order and vectors paired back by
 *     position, never by similarity or arrival order;
 *   - identical chunk text is sent to the provider once per run and shares the
 *     resulting vector, so a document with repeated boilerplate cannot end up
 *     with two different vectors for the same string;
 *   - the batch split is a pure function of chunk count and batch size;
 *   - every response is length-, dimension- and finiteness-checked before use.
 */

export interface DocumentEmbeddingServiceConfig extends DocumentEmbeddingOptions {
  /** The embedding backend. Required — this service never creates one. */
  provider: IEmbeddingProvider;
}

export function resolveEmbeddingOptions(
  options: DocumentEmbeddingOptions = {}
): ResolvedEmbeddingOptions {
  const batchSize = options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
  const minChars = options.minChars ?? DEFAULT_MIN_EMBEDDABLE_CHARS;

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new JarvisError("INVALID_REQUEST", "batchSize must be a positive integer", {
      batchSize,
    });
  }
  if (batchSize > MAX_EMBEDDING_BATCH_SIZE) {
    throw new JarvisError(
      "INVALID_REQUEST",
      `batchSize must not exceed ${MAX_EMBEDDING_BATCH_SIZE}`,
      { batchSize, maxBatchSize: MAX_EMBEDDING_BATCH_SIZE }
    );
  }
  if (!Number.isInteger(minChars) || minChars < 0) {
    throw new JarvisError("INVALID_REQUEST", "minChars must be a non-negative integer", {
      minChars,
    });
  }

  const resolved: ResolvedEmbeddingOptions = { batchSize, minChars };
  if (options.model !== undefined) resolved.model = options.model;
  return resolved;
}

/** A chunk that passed the skip filter, with the text that will be sent. */
interface EmbeddableChunk {
  chunk: DocumentChunk;
  text: string;
}

export class DocumentEmbeddingService implements IDocumentEmbedder {
  private readonly provider: IEmbeddingProvider;
  private readonly defaults: ResolvedEmbeddingOptions;

  constructor(config: DocumentEmbeddingServiceConfig) {
    if (!config?.provider) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "An embedding provider is required"
      );
    }
    this.provider = config.provider;
    // Validated at construction so misconfiguration surfaces on creation
    // rather than on the first document, matching extraction and chunking.
    this.defaults = resolveEmbeddingOptions(config);
  }

  async embedChunks(
    chunks: readonly DocumentChunk[],
    options?: DocumentEmbeddingOptions
  ): Promise<DocumentEmbeddingResult> {
    const resolved = options
      ? resolveEmbeddingOptions({ ...this.defaults, ...options })
      : this.defaults;

    const dimensions = this.provider.dimensions;
    const skipped: SkippedChunk[] = [];
    const embeddable: EmbeddableChunk[] = [];

    // Ordered by index so batching — and therefore the provider calls — is a
    // pure function of the input, independent of how the caller assembled it.
    const ordered = [...chunks].sort((a, b) => a.index - b.index);

    for (const chunk of ordered) {
      const text = chunk.content.trim();
      if (text.length === 0) {
        skipped.push({
          chunkId: chunk.id,
          index: chunk.index,
          reason: "empty",
          charCount: 0,
        });
        continue;
      }
      if (text.length < resolved.minChars) {
        skipped.push({
          chunkId: chunk.id,
          index: chunk.index,
          reason: "too-short",
          charCount: text.length,
        });
        continue;
      }
      embeddable.push({ chunk, text });
    }

    if (embeddable.length === 0) {
      return {
        embeddings: [],
        embeddedCount: 0,
        skipped,
        skippedCount: skipped.length,
        model: resolved.model ?? "",
        dimensions,
        embeddingVersion: DOCUMENT_EMBEDDING_VERSION,
        batchCount: 0,
        deduplicatedCount: 0,
      };
    }

    // Deduplicate by exact text. Repeated boilerplate (headers, footers,
    // overlap-heavy chunking) is common, and sending it once keeps both cost
    // and the resulting vectors consistent within a run.
    const uniqueTexts: string[] = [];
    const textToPosition = new Map<string, number>();
    for (const item of embeddable) {
      if (!textToPosition.has(item.text)) {
        textToPosition.set(item.text, uniqueTexts.length);
        uniqueTexts.push(item.text);
      }
    }
    const deduplicatedCount = embeddable.length - uniqueTexts.length;

    const vectors: number[][] = [];
    let model = resolved.model ?? "";
    let batchCount = 0;
    let promptTokens = 0;
    let totalTokens = 0;
    let sawUsage = false;

    for (let offset = 0; offset < uniqueTexts.length; offset += resolved.batchSize) {
      const batch = uniqueTexts.slice(offset, offset + resolved.batchSize);
      batchCount++;

      let response;
      try {
        response = await this.provider.embed(
          resolved.model ? { input: batch, model: resolved.model } : { input: batch }
        );
      } catch (error) {
        wrapProviderFailure(error, {
          provider: this.provider.id,
          batchIndex: batchCount - 1,
          batchSize: batch.length,
        });
      }

      const validated = validateEmbeddingBatch(
        response!.embeddings,
        batch.length,
        dimensions,
        { provider: this.provider.id, batchIndex: batchCount - 1 }
      );

      vectors.push(...validated);

      // The provider reports the model it actually used, which may differ from
      // what was requested (aliases, version pinning). Record that, not the ask.
      if (response!.model) model = response!.model;
      if (response!.usage) {
        sawUsage = true;
        promptTokens += response!.usage.promptTokens;
        totalTokens += response!.usage.totalTokens;
      }
    }

    // Defensive: the per-batch checks make this unreachable, but a silent
    // mismatch here would misalign every chunk-to-vector pairing below.
    if (vectors.length !== uniqueTexts.length) {
      throw new JarvisError(
        "DOCUMENT_EMBEDDING_FAILED",
        "Collected embedding count does not match the inputs sent",
        { expected: uniqueTexts.length, received: vectors.length }
      );
    }

    const embeddings: ChunkEmbedding[] = embeddable.map((item) => {
      const position = textToPosition.get(item.text)!;
      return {
        chunkId: item.chunk.id,
        index: item.chunk.index,
        embedding: vectors[position]!,
        dimensions,
        model,
        embeddingVersion: DOCUMENT_EMBEDDING_VERSION,
      };
    });

    const result: DocumentEmbeddingResult = {
      embeddings,
      embeddedCount: embeddings.length,
      skipped,
      skippedCount: skipped.length,
      model,
      dimensions,
      embeddingVersion: DOCUMENT_EMBEDDING_VERSION,
      batchCount,
      deduplicatedCount,
    };

    if (sawUsage) {
      const usage: DocumentEmbeddingUsage = { promptTokens, totalTokens };
      result.usage = usage;
    }

    return result;
  }

  /**
   * Embeds chunks and writes the vectors onto already-persisted knowledge
   * chunks, addressed by `chunkIndex`.
   *
   * Embedding happens first and persistence second: if the provider fails,
   * nothing is written and the chunks remain valid as plain text.
   */
  async embedAndPersist(
    repository: IKnowledgeRepository,
    documentId: string,
    chunks: readonly DocumentChunk[],
    options?: DocumentEmbeddingOptions
  ): Promise<DocumentEmbeddingResult & { persistedCount: number }> {
    const result = await this.embedChunks(chunks, options);

    if (result.embeddings.length === 0) {
      return { ...result, persistedCount: 0 };
    }

    const persistedCount = await repository.updateChunkEmbeddings(
      documentId,
      result.embeddings.map((item) => ({
        chunkIndex: item.index,
        embedding: item.embedding,
      }))
    );

    return { ...result, persistedCount };
  }
}
