import type {
  IMemoryStore,
  IEmbeddingProvider,
  MemoryStoreRequest,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryType,
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";

export interface MemoryEngineConfig {
  store: IMemoryStore;
  embeddingProvider: IEmbeddingProvider;
  defaultTopK?: number;
}

export class MemoryEngine {
  readonly id = "memory-engine";
  readonly name = "Memory Engine";

  private store: IMemoryStore;
  private embeddingProvider: IEmbeddingProvider;
  private defaultTopK: number;

  constructor(config: MemoryEngineConfig) {
    this.store = config.store;
    this.embeddingProvider = config.embeddingProvider;
    this.defaultTopK = config.defaultTopK ?? 10;
  }

  async storeMemory(
    request: MemoryStoreRequest
  ): Promise<MemoryRecord[]> {
    const texts = request.memories.map((m) => m.content);

    let embeddings: number[][];
    try {
      const response = await this.embeddingProvider.embed({ input: texts });
      embeddings = response.embeddings;
    } catch (error) {
      if (error instanceof JarvisError) throw error;
      throw new JarvisError(
        "MEMORY_EMBEDDING_FAILED",
        "Failed to generate embeddings for memory storage",
        { userId: request.userId, count: texts.length }
      );
    }

    if (embeddings.length !== texts.length) {
      throw new JarvisError(
        "MEMORY_EMBEDDING_FAILED",
        "Embedding count mismatch",
        { expected: texts.length, received: embeddings.length }
      );
    }

    for (const emb of embeddings) {
      if (!emb || emb.length === 0) {
        throw new JarvisError(
          "MEMORY_EMBEDDING_FAILED",
          "Received empty embedding from provider"
        );
      }
    }

    if (
      "storeWithEmbedding" in this.store &&
      typeof this.store.storeWithEmbedding === "function"
    ) {
      return (this.store as { storeWithEmbedding: (req: MemoryStoreRequest, emb: number[][]) => Promise<MemoryRecord[]> }).storeWithEmbedding(
        request,
        embeddings
      );
    }

    return this.store.store(request);
  }

  async recall(
    request: MemoryRecallRequest & { limit?: number }
  ): Promise<MemoryRecallResult[]> {
    const limit = request.limit ?? this.defaultTopK;

    if (!request.embedding || request.embedding.length === 0) {
      let embedding: number[];
      try {
        const response = await this.embeddingProvider.embed({
          input: request.query,
        });
        embedding = response.embeddings[0];
      } catch (error) {
        if (error instanceof JarvisError) throw error;
        throw new JarvisError(
          "MEMORY_EMBEDDING_FAILED",
          "Failed to generate query embedding for recall"
        );
      }

      if (!embedding || embedding.length === 0) {
        throw new JarvisError(
          "MEMORY_EMBEDDING_FAILED",
          "Received empty embedding for query"
        );
      }

      return this.store.recall({
        ...request,
        embedding,
        limit,
      });
    }

    return this.store.recall({
      ...request,
      limit,
    });
  }

  async findSimilar(
    userId: string,
    query: string,
    threshold?: number,
    limit?: number
  ): Promise<MemoryRecord[]> {
    const topK = limit ?? this.defaultTopK;

    let embedding: number[];
    try {
      const response = await this.embeddingProvider.embed({ input: query });
      embedding = response.embeddings[0];
    } catch (error) {
      if (error instanceof JarvisError) throw error;
      throw new JarvisError(
        "MEMORY_EMBEDDING_FAILED",
        "Failed to generate query embedding for similarity search"
      );
    }

    if (!embedding || embedding.length === 0) {
      throw new JarvisError(
        "MEMORY_EMBEDDING_FAILED",
        "Received empty embedding for query"
      );
    }

    return this.store.findSimilar(userId, embedding, threshold, topK);
  }

  async delete(request: { userId: string; memoryIds?: string[]; type?: MemoryType; olderThan?: Date }): Promise<number> {
    return this.store.delete(request);
  }

  async deleteAll(userId: string): Promise<number> {
    return this.store.deleteAll(userId);
  }

  async update(request: { userId: string; memoryId: string; content?: string; summary?: string; importance?: number; confidence?: number; metadata?: Record<string, unknown>; sourceType?: string; sourceConversationId?: string; sourceMessageId?: string }): Promise<MemoryRecord> {
    return this.store.update(request);
  }

  async getById(userId: string, memoryId: string): Promise<MemoryRecord | null> {
    return this.store.getById(userId, memoryId);
  }

  async list(request: { userId: string; type?: MemoryType; limit?: number; offset?: number; includeExpired?: boolean }) {
    return this.store.list(request);
  }

  async count(userId: string): Promise<number> {
    return this.store.count(userId);
  }

  async isAvailable(): Promise<boolean> {
    const [storeOk, providerOk] = await Promise.all([
      this.store.isAvailable(),
      this.embeddingProvider.isAvailable(),
    ]);
    return storeOk && providerOk;
  }
}
