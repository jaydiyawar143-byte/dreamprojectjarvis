import { describe, it, expect, beforeEach } from "vitest";
import type {
  IEmbeddingProvider,
  IMemoryStore,
  EmbeddingRequest,
  EmbeddingResponse,
  MemoryStoreRequest,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryDeleteRequest,
  MemoryUpdateRequest,
  MemoryListRequest,
  MemoryListResult,
  MemoryRecord,
  MemoryType,
} from "@jarvis/core";
import { MemoryEngine } from "../src/memory-engine.js";

// ---------------------------------------------------------------------------
// Fake Embedding Provider — deterministic, no network calls
// Uses word-level hashing so that texts sharing words produce similar vectors.
// ---------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function textToEmbedding(text: string, dimensions = 16): number[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const vec = new Array(dimensions).fill(0);
  for (const w of words) {
    const idx = hashString(w) % dimensions;
    vec[idx] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

class FakeEmbeddingProvider implements IEmbeddingProvider {
  readonly id = "fake-embedding";
  readonly name = "Fake Embedding Provider";
  readonly dimensions = 16;
  private shouldFail = false;

  setShouldFail(fail: boolean) {
    this.shouldFail = fail;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (this.shouldFail) {
      throw new Error("Embedding provider unavailable");
    }

    const inputs = Array.isArray(request.input)
      ? request.input
      : [request.input];

    const embeddings = inputs.map((text) => textToEmbedding(text, this.dimensions));

    return {
      embeddings,
      model: request.model ?? "fake-model",
      usage: {
        promptTokens: inputs.join("").length,
        totalTokens: inputs.join("").length,
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    return !this.shouldFail;
  }
}

// ---------------------------------------------------------------------------
// In-Memory Store with vector search (simulates pgvector)
// ---------------------------------------------------------------------------

interface StoredMemory extends MemoryRecord {
  embedding: number[] | null;
}

class InMemoryVectorStore implements IMemoryStore {
  readonly id = "in-memory-vector";
  readonly name = "In-Memory Vector Store";
  private memories: StoredMemory[] = [];
  private nextId = 1;

  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    const results: MemoryRecord[] = [];
    for (const mem of request.memories) {
      const now = new Date();
      const record: StoredMemory = {
        id: `mem-${this.nextId++}`,
        userId: request.userId,
        type: mem.type,
        content: mem.content,
        summary: mem.summary,
        importance: mem.importance,
        confidence: mem.confidence,
        accessCount: 0,
        metadata: mem.metadata,
        sourceType: mem.sourceType,
        sourceConversationId: mem.sourceConversationId,
        sourceMessageId: mem.sourceMessageId,
        createdAt: now,
        updatedAt: now,
        expiresAt: mem.expiresAt,
        embedding: null,
      };
      this.memories.push(record);
      results.push(record);
    }
    return results;
  }

  async storeWithEmbedding(
    request: MemoryStoreRequest,
    embeddings: number[][]
  ): Promise<MemoryRecord[]> {
    const results: MemoryRecord[] = [];
    for (let i = 0; i < request.memories.length; i++) {
      const mem = request.memories[i];
      const emb = embeddings[i];
      const now = new Date();
      const record: StoredMemory = {
        id: `mem-${this.nextId++}`,
        userId: request.userId,
        type: mem.type,
        content: mem.content,
        summary: mem.summary,
        importance: mem.importance,
        confidence: mem.confidence,
        accessCount: 0,
        metadata: mem.metadata,
        sourceType: mem.sourceType,
        sourceConversationId: mem.sourceConversationId,
        sourceMessageId: mem.sourceMessageId,
        createdAt: now,
        updatedAt: now,
        expiresAt: mem.expiresAt,
        embedding: emb ?? null,
      };
      this.memories.push(record);
      results.push(record);
    }
    return results;
  }

  async getById(userId: string, memoryId: string): Promise<MemoryRecord | null> {
    const found = this.memories.find((m) => m.id === memoryId && m.userId === userId);
    return found ?? null;
  }

  async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult[]> {
    const limit = request.limit ?? 10;
    const queryEmb = request.embedding;

    let candidates = this.memories.filter((m) => {
      if (m.userId !== request.userId) return false;
      if (!m.embedding) return false;
      if (request.types && request.types.length > 0) {
        if (!request.types.includes(m.type as MemoryType)) return false;
      }
      if (request.minImportance != null && m.importance < request.minImportance) {
        return false;
      }
      return true;
    });

    const results: MemoryRecallResult[] = candidates.map((m) => {
      const semanticScore = cosineSimilarity(queryEmb, m.embedding!);
      const hoursSinceAccess = m.lastAccessedAt
        ? (Date.now() - m.lastAccessedAt.getTime()) / (1000 * 60 * 60)
        : 168;
      const recencyScore = Math.exp(-hoursSinceAccess / 168);
      return {
        memory: m,
        semanticScore,
        recencyScore,
        finalScore: semanticScore * 0.7 + recencyScore * 0.3,
      };
    });

    results.sort((a, b) => b.finalScore - a.finalScore);
    return results.slice(0, limit);
  }

  async list(request: MemoryListRequest): Promise<MemoryListResult> {
    const limit = request.limit ?? 20;
    const offset = request.offset ?? 0;

    let filtered = this.memories.filter((m) => {
      if (m.userId !== request.userId) return false;
      if (request.type && m.type !== request.type) return false;
      if (!request.includeExpired) {
        if (m.expiresAt && m.expiresAt <= new Date()) return false;
      }
      return true;
    });

    filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    return {
      memories: page,
      total,
      hasMore: offset + page.length < total,
    };
  }

  async delete(request: MemoryDeleteRequest): Promise<number> {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => {
      if (m.userId !== request.userId) return true;
      if (request.memoryIds && request.memoryIds.length > 0) {
        if (!request.memoryIds.includes(m.id)) return true;
      }
      if (request.type && m.type !== request.type) return true;
      if (request.olderThan && m.createdAt >= request.olderThan) return true;
      return false;
    });
    return before - this.memories.length;
  }

  async deleteAll(userId: string): Promise<number> {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => m.userId !== userId);
    return before - this.memories.length;
  }

  async update(request: MemoryUpdateRequest): Promise<MemoryRecord> {
    const idx = this.memories.findIndex(
      (m) => m.id === request.memoryId && m.userId === request.userId
    );
    if (idx === -1) throw new Error("Memory not found");
    const m = this.memories[idx];
    if (request.content !== undefined) m.content = request.content;
    if (request.summary !== undefined) m.summary = request.summary;
    if (request.importance !== undefined) m.importance = request.importance;
    if (request.confidence !== undefined) m.confidence = request.confidence;
    if (request.metadata !== undefined) m.metadata = request.metadata;
    m.updatedAt = new Date();
    return m;
  }

  async findSimilar(
    userId: string,
    embedding: number[],
    threshold = 0.5,
    limit = 10
  ): Promise<MemoryRecord[]> {
    const results = this.memories
      .filter((m) => m.userId === userId && m.embedding)
      .map((m) => ({
        memory: m as MemoryRecord,
        score: cosineSimilarity(embedding, m.embedding!),
      }))
      .filter((r) => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return results.map((r) => r.memory);
  }

  async count(userId: string): Promise<number> {
    return this.memories.filter((m) => m.userId === userId).length;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let provider: FakeEmbeddingProvider;
let store: InMemoryVectorStore;
let engine: MemoryEngine;

beforeEach(() => {
  provider = new FakeEmbeddingProvider();
  store = new InMemoryVectorStore();
  engine = new MemoryEngine({ store, embeddingProvider: provider });
});

describe("Phase 3: Semantic Memory Retrieval", () => {
  describe("1. Embedding generation", () => {
    it("generates deterministic embeddings for text", async () => {
      const r1 = await provider.embed({ input: "hello world" });
      const r2 = await provider.embed({ input: "hello world" });
      expect(r1.embeddings).toHaveLength(1);
      expect(r2.embeddings).toHaveLength(1);
      expect(r1.embeddings[0]).toEqual(r2.embeddings[0]);
    });

    it("generates different embeddings for different text", async () => {
      const r1 = await provider.embed({ input: "cats are great" });
      const r2 = await provider.embed({ input: "dogs are great" });
      expect(r1.embeddings[0]).not.toEqual(r2.embeddings[0]);
    });
  });

  describe("2. Embedding dimension validation", () => {
    it("returns embeddings with correct dimensions", async () => {
      const result = await provider.embed({ input: "test" });
      expect(result.embeddings[0]).toHaveLength(provider.dimensions);
    });

    it("handles batch embedding", async () => {
      const result = await provider.embed({
        input: ["text one", "text two", "text three"],
      });
      expect(result.embeddings).toHaveLength(3);
      for (const emb of result.embeddings) {
        expect(emb).toHaveLength(provider.dimensions);
      }
    });
  });

  describe("3. Memory embedding persistence", () => {
    it("stores memory with embedding via MemoryEngine", async () => {
      const results = await engine.storeMemory({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "The sky is blue", importance: 0.8, confidence: 0.9 },
        ],
      });
      expect(results).toHaveLength(1);

      const list = await store.list({ userId: "user-a" });
      expect(list.memories).toHaveLength(1);
      expect(list.memories[0].content).toBe("The sky is blue");
    });

    it("persists provenance through embedding pipeline", async () => {
      const results = await engine.storeMemory({
        userId: "user-a",
        memories: [
          {
            type: "FACT",
            content: "User prefers dark mode",
            importance: 0.7,
            confidence: 0.8,
            sourceType: "conversation",
            sourceConversationId: "conv-1",
            sourceMessageId: "msg-1",
          },
        ],
      });
      const record = await store.getById("user-a", results[0].id);
      expect(record).not.toBeNull();
      expect(record!.sourceType).toBe("conversation");
      expect(record!.sourceConversationId).toBe("conv-1");
      expect(record!.sourceMessageId).toBe("msg-1");
    });
  });

  describe("4. Semantic similarity retrieval", () => {
    it("retrieves memories by semantic similarity", async () => {
      await engine.storeMemory({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "the big red cat sat", importance: 0.5, confidence: 0.5 },
          { type: "FACT", content: "a small blue dog ran", importance: 0.5, confidence: 0.5 },
          { type: "FACT", content: "the big red fox ran", importance: 0.5, confidence: 0.5 },
        ],
      });

      const results = await engine.recall({
        userId: "user-a",
        query: "the big red cat",
        embedding: textToEmbedding("the big red cat", provider.dimensions),
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.content).toBe("the big red cat sat");
      expect(results[0].semanticScore).toBeGreaterThan(0);
    });
  });

  describe("5. Top-K limit", () => {
    it("returns at most K results", async () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        type: "FACT" as MemoryType,
        content: `memory item number ${i}`,
        importance: 0.5,
        confidence: 0.5,
      }));

      await engine.storeMemory({ userId: "user-a", memories });

      const results = await engine.recall({
        userId: "user-a",
        query: "memory item",
        embedding: textToEmbedding("memory item", provider.dimensions),
        limit: 3,
      });

      expect(results).toHaveLength(3);
    });

    it("uses default top-K from config", async () => {
      const customEngine = new MemoryEngine({
        store,
        embeddingProvider: provider,
        defaultTopK: 2,
      });

      const memories = Array.from({ length: 5 }, (_, i) => ({
        type: "FACT" as MemoryType,
        content: `item ${i}`,
        importance: 0.5,
        confidence: 0.5,
      }));

      await customEngine.storeMemory({ userId: "user-a", memories });

      const results = await customEngine.recall({
        userId: "user-a",
        query: "item",
        embedding: textToEmbedding("item", provider.dimensions),
      });

      expect(results).toHaveLength(2);
    });
  });

  describe("6. User isolation", () => {
    it("User A cannot recall User B memories", async () => {
      await engine.storeMemory({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "secret A info", importance: 0.9, confidence: 0.9 },
        ],
      });
      await engine.storeMemory({
        userId: "user-b",
        memories: [
          { type: "FACT", content: "secret B info", importance: 0.9, confidence: 0.9 },
        ],
      });

      const resultsA = await engine.recall({
        userId: "user-a",
        query: "secret info",
        embedding: textToEmbedding("secret info", provider.dimensions),
      });

      for (const r of resultsA) {
        expect(r.memory.userId).toBe("user-a");
      }
    });

    it("findSimilar is scoped to userId", async () => {
      await engine.storeMemory({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "user a specific memory", importance: 0.5, confidence: 0.5 },
        ],
      });
      await engine.storeMemory({
        userId: "user-b",
        memories: [
          { type: "FACT", content: "user b specific memory", importance: 0.5, confidence: 0.5 },
        ],
      });

      const emb = textToEmbedding("specific memory", provider.dimensions);
      const results = await engine.findSimilar("user-a", "specific memory", 0, 10);
      for (const r of results) {
        expect(r.userId).toBe("user-a");
      }
    });
  });

  describe("7. Empty results", () => {
    it("returns empty array when no memories exist", async () => {
      const results = await engine.recall({
        userId: "non-existent",
        query: "anything",
        embedding: textToEmbedding("anything", provider.dimensions),
      });
      expect(results).toHaveLength(0);
    });

    it("returns empty array when findSimilar finds nothing above threshold", async () => {
      await engine.storeMemory({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "completely unrelated", importance: 0.5, confidence: 0.5 },
        ],
      });

      const results = await engine.findSimilar(
        "user-a",
        "completely different topic",
        0.99,
        10
      );
      expect(results).toHaveLength(0);
    });
  });

  describe("8. Provider failure", () => {
    it("throws MEMORY_EMBEDDING_FAILED when embedding provider fails on store", async () => {
      provider.setShouldFail(true);
      await expect(
        engine.storeMemory({
          userId: "user-a",
          memories: [
            { type: "FACT", content: "test", importance: 0.5, confidence: 0.5 },
          ],
        })
      ).rejects.toThrow("embedding");
    });

    it("throws MEMORY_EMBEDDING_FAILED when embedding provider fails on recall", async () => {
      provider.setShouldFail(true);
      await expect(
        engine.recall({
          userId: "user-a",
          query: "test",
          embedding: [],
        })
      ).rejects.toThrow("embedding");
    });

    it("provider.isAvailable returns false when failing", async () => {
      provider.setShouldFail(false);
      expect(await provider.isAvailable()).toBe(true);
      provider.setShouldFail(true);
      expect(await provider.isAvailable()).toBe(false);
    });
  });

  describe("9. Invalid embedding", () => {
    it("throws when provider returns empty embedding", async () => {
      const emptyProvider: IEmbeddingProvider = {
        id: "empty",
        name: "Empty",
        dimensions: 0,
        embed: async () => ({ embeddings: [], model: "empty" }),
        isAvailable: async () => true,
      };
      const eng = new MemoryEngine({ store, embeddingProvider: emptyProvider });
      await expect(
        eng.storeMemory({
          userId: "user-a",
          memories: [
            { type: "FACT", content: "test", importance: 0.5, confidence: 0.5 },
          ],
        })
      ).rejects.toThrow();
    });
  });

  describe("10. Missing embedding", () => {
    it("generates query embedding when not provided in recall", async () => {
      await engine.storeMemory({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "the capital of France is Paris", importance: 0.8, confidence: 0.9 },
        ],
      });

      const results = await engine.recall({
        userId: "user-a",
        query: "France capital",
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it("uses provided embedding when given in recall", async () => {
      await engine.storeMemory({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "Python is a programming language", importance: 0.7, confidence: 0.8 },
        ],
      });

      const emb = textToEmbedding("Python programming", provider.dimensions);
      const results = await engine.recall({
        userId: "user-a",
        query: "Python programming",
        embedding: emb,
      });

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("11. Multiple users with similar memories", () => {
    it("returns user-scoped results for similar queries", async () => {
      await engine.storeMemory({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "I love coffee in the morning", importance: 0.6, confidence: 0.7 },
        ],
      });
      await engine.storeMemory({
        userId: "user-b",
        memories: [
          { type: "FACT", content: "I love tea in the morning", importance: 0.6, confidence: 0.7 },
        ],
      });
      await engine.storeMemory({
        userId: "user-c",
        memories: [
          { type: "FACT", content: "I love coffee in the evening", importance: 0.6, confidence: 0.7 },
        ],
      });

      const resultsA = await engine.recall({
        userId: "user-a",
        query: "morning drink",
        embedding: textToEmbedding("morning drink", provider.dimensions),
      });

      expect(resultsA.length).toBeGreaterThan(0);
      expect(resultsA[0].memory.userId).toBe("user-a");
    });
  });

  describe("12. Provenance remains intact", () => {
    it("preserves all provenance fields through store+recall cycle", async () => {
      await engine.storeMemory({
        userId: "user-a",
        memories: [
          {
            type: "GOAL",
            content: "Deploy to production by Friday",
            importance: 0.9,
            confidence: 0.95,
            sourceType: "conversation",
            sourceConversationId: "conv-deploy-1",
            sourceMessageId: "msg-deploy-42",
          },
        ],
      });

      const results = await engine.recall({
        userId: "user-a",
        query: "deploy production",
        embedding: textToEmbedding("deploy production", provider.dimensions),
      });

      expect(results).toHaveLength(1);
      const m = results[0].memory;
      expect(m.sourceType).toBe("conversation");
      expect(m.sourceConversationId).toBe("conv-deploy-1");
      expect(m.sourceMessageId).toBe("msg-deploy-42");
      expect(m.type).toBe("GOAL");
    });
  });
});
