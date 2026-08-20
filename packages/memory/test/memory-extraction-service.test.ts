import { describe, it, expect, beforeEach } from "vitest";
import type {
  IAIProvider,
  IEmbeddingProvider,
  IMemoryStore,
  AICompletionRequest,
  AICompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  MemoryRecord,
  MemoryStoreRequest,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryDeleteRequest,
  MemoryUpdateRequest,
  MemoryListRequest,
  MemoryListResult,
  MemoryType,
} from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";

// ---------------------------------------------------------------------------
// Mock AI Provider — returns configurable extraction responses
// ---------------------------------------------------------------------------

class MockAIProvider implements IAIProvider {
  readonly id = "mock-ai";
  readonly name = "Mock AI Provider";
  readonly defaultModel = "mock-model";

  private responseFn: ((req: AICompletionRequest) => AICompletionResponse) | null = null;
  private shouldFail = false;
  private callCount = 0;

  setResponse(fn: (req: AICompletionRequest) => AICompletionResponse) {
    this.responseFn = fn;
  }

  setShouldFail(fail: boolean) {
    this.shouldFail = fail;
  }

  getCallCount(): number {
    return this.callCount;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.callCount++;
    if (this.shouldFail) {
      throw new Error("AI provider unavailable");
    }
    if (this.responseFn) {
      return this.responseFn(request);
    }
    return {
      message: { role: "assistant", content: '{"candidates":[]}' },
      finishReason: "stop",
      model: this.defaultModel,
    };
  }

  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }

  async isAvailable(): Promise<boolean> {
    return !this.shouldFail;
  }
}

// ---------------------------------------------------------------------------
// Fake Embedding Provider — deterministic word-overlap
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
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const embeddings = inputs.map((text) => textToEmbedding(text, this.dimensions));
    return { embeddings, model: "fake-model" };
  }

  async isAvailable(): Promise<boolean> {
    return !this.shouldFail;
  }
}

// ---------------------------------------------------------------------------
// In-Memory Vector Store (simplified from Phase 3)
// ---------------------------------------------------------------------------

class InMemoryStore implements IMemoryStore {
  readonly id = "in-memory";
  readonly name = "In-Memory Store";
  private memories: (MemoryRecord & { embedding?: number[] })[] = [];
  private nextId = 1;

  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    const results: MemoryRecord[] = [];
    for (const mem of request.memories) {
      const now = new Date();
      const record: MemoryRecord & { embedding?: number[] } = {
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
      };
      if (mem.metadata && typeof mem.metadata === "object" && "embedding" in (mem.metadata as Record<string, unknown>)) {
        record.embedding = (mem.metadata as { embedding: number[] }).embedding;
      }
      this.memories.push(record);
      results.push(record);
    }
    return results;
  }

  async storeWithEmbedding(request: MemoryStoreRequest, embeddings: number[][]): Promise<MemoryRecord[]> {
    const results: MemoryRecord[] = [];
    for (let i = 0; i < request.memories.length; i++) {
      const mem = request.memories[i];
      const emb = embeddings[i];
      const now = new Date();
      const record: MemoryRecord & { embedding?: number[] } = {
        id: `mem-${this.nextId++}`,
        userId: request.userId,
        type: mem!.type,
        content: mem!.content,
        summary: mem!.summary,
        importance: mem!.importance,
        confidence: mem!.confidence,
        accessCount: 0,
        metadata: mem!.metadata,
        sourceType: mem!.sourceType,
        sourceConversationId: mem!.sourceConversationId,
        sourceMessageId: mem!.sourceMessageId,
        createdAt: now,
        updatedAt: now,
        expiresAt: mem!.expiresAt,
        embedding: emb,
      };
      this.memories.push(record);
      results.push(record);
    }
    return results;
  }

  async getById(userId: string, memoryId: string): Promise<MemoryRecord | null> {
    return this.memories.find((m) => m.id === memoryId && m.userId === userId) ?? null;
  }

  async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult[]> {
    return [];
  }

  async list(request: MemoryListRequest): Promise<MemoryListResult> {
    const limit = request.limit ?? 20;
    const filtered = this.memories.filter((m) => {
      if (m.userId !== request.userId) return false;
      if (request.type && m.type !== request.type) return false;
      if (!request.includeExpired && m.expiresAt && m.expiresAt <= new Date()) return false;
      return true;
    });
    filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { memories: filtered.slice(0, limit), total: filtered.length, hasMore: false };
  }

  async delete(request: MemoryDeleteRequest): Promise<number> {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => {
      if (m.userId !== request.userId) return true;
      if (request.memoryIds && !request.memoryIds.includes(m.id)) return true;
      if (request.type && m.type !== request.type) return true;
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
    const idx = this.memories.findIndex((m) => m.id === request.memoryId && m.userId === request.userId);
    if (idx === -1) throw new Error("Memory not found");
    const m = this.memories[idx];
    if (request.content !== undefined) m.content = request.content;
    if (request.summary !== undefined) m.summary = request.summary;
    if (request.importance !== undefined) m.importance = request.importance;
    if (request.confidence !== undefined) m.confidence = request.confidence;
    if (request.metadata !== undefined) m.metadata = request.metadata;
    if (request.sourceType !== undefined) m.sourceType = request.sourceType;
    if (request.sourceConversationId !== undefined) m.sourceConversationId = request.sourceConversationId;
    if (request.sourceMessageId !== undefined) m.sourceMessageId = request.sourceMessageId;
    m.updatedAt = new Date();
    return m;
  }

  async findSimilar(userId: string, embedding: number[], threshold = 0.5, limit = 10): Promise<MemoryRecord[]> {
    return [];
  }

  async count(userId: string): Promise<number> {
    return this.memories.filter((m) => m.userId === userId).length;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function llmResponse(candidates: object[]): AICompletionResponse {
  return {
    message: {
      role: "assistant",
      content: JSON.stringify({ candidates }),
    },
    finishReason: "stop",
    model: "mock-model",
  };
}

const FACT_CANDIDATE = {
  type: "FACT",
  content: "User's name is Alice Johnson",
  importance: 0.9,
  confidence: 1.0,
};

const PREF_CANDIDATE = {
  type: "PREFERENCE",
  content: "User prefers dark mode over light mode",
  importance: 0.7,
  confidence: 0.9,
};

const GOAL_CANDIDATE = {
  type: "GOAL",
  content: "User wants to launch their SaaS product by Q3 2026",
  importance: 0.8,
  confidence: 0.95,
};

const PROJECT_CANDIDATE = {
  type: "PROJECT",
  content: "User is building a personal finance tracking app called FinTrack",
  importance: 0.8,
  confidence: 0.9,
};

const DECISION_CANDIDATE = {
  type: "DECISION",
  content: "User decided to use PostgreSQL over MongoDB for the backend database",
  importance: 0.7,
  confidence: 0.85,
};

const WORKFLOW_CANDIDATE = {
  type: "WORKFLOW",
  content: "User deploys to staging first, runs tests, then promotes to production",
  importance: 0.6,
  confidence: 0.8,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockAI: MockAIProvider;
let fakeEmbedding: FakeEmbeddingProvider;
let store: InMemoryStore;
let service: MemoryExtractionService;

beforeEach(() => {
  mockAI = new MockAIProvider();
  fakeEmbedding = new FakeEmbeddingProvider();
  store = new InMemoryStore();
  service = new MemoryExtractionService({
    aiProvider: mockAI,
    store,
    embeddingProvider: fakeEmbedding,
    maxRetries: 0,
  });
});

describe("Phase 4: Automatic Memory Extraction", () => {
  describe("1. Explicit FACT extraction", () => {
    it("extracts a FACT from a clear user statement", async () => {
      mockAI.setResponse(() => llmResponse([FACT_CANDIDATE]));
      const result = await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "My name is Alice Johnson" },
          { role: "assistant", content: "Nice to meet you, Alice!" },
        ],
        conversationId: "conv-1",
      });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].type).toBe("FACT");
      expect(result.candidates[0].content).toBe("User's name is Alice Johnson");
      expect(result.meta.memoriesCreated).toBe(1);
    });
  });

  describe("2. PREFERENCE extraction", () => {
    it("extracts a PREFERENCE from user statement", async () => {
      mockAI.setResponse(() => llmResponse([PREF_CANDIDATE]));
      const result = await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "I really prefer dark mode in all my apps" },
        ],
        conversationId: "conv-1",
      });
      expect(result.candidates[0].type).toBe("PREFERENCE");
      expect(result.candidates[0].content).toContain("dark mode");
    });
  });

  describe("3. GOAL extraction", () => {
    it("extracts a GOAL from user statement", async () => {
      mockAI.setResponse(() => llmResponse([GOAL_CANDIDATE]));
      const result = await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "I want to launch my SaaS by Q3 2026" },
        ],
        conversationId: "conv-1",
      });
      expect(result.candidates[0].type).toBe("GOAL");
    });
  });

  describe("4. PROJECT extraction", () => {
    it("extracts a PROJECT from user statement", async () => {
      mockAI.setResponse(() => llmResponse([PROJECT_CANDIDATE]));
      const result = await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "I'm building a finance app called FinTrack" },
        ],
        conversationId: "conv-1",
      });
      expect(result.candidates[0].type).toBe("PROJECT");
    });
  });

  describe("5. DECISION extraction", () => {
    it("extracts a DECISION from user statement", async () => {
      mockAI.setResponse(() => llmResponse([DECISION_CANDIDATE]));
      const result = await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "I decided to use PostgreSQL instead of MongoDB" },
        ],
        conversationId: "conv-1",
      });
      expect(result.candidates[0].type).toBe("DECISION");
    });
  });

  describe("6. WORKFLOW extraction", () => {
    it("extracts a WORKFLOW from user statement", async () => {
      mockAI.setResponse(() => llmResponse([WORKFLOW_CANDIDATE]));
      const result = await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "I always deploy to staging first, test, then push to prod" },
        ],
        conversationId: "conv-1",
      });
      expect(result.candidates[0].type).toBe("WORKFLOW");
    });
  });

  describe("7. No-memory conversation", () => {
    it("returns empty candidates for casual conversation", async () => {
      mockAI.setResponse(() => llmResponse([]));
      const result = await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "Hey, what's up?" },
          { role: "assistant", content: "Not much! How can I help?" },
        ],
      });
      expect(result.candidates).toHaveLength(0);
      expect(result.meta.memoriesCreated).toBe(0);
    });
  });

  describe("8. Transient information rejection", () => {
    it("filters out transient user messages before LLM", async () => {
      mockAI.setResponse(() => llmResponse([]));
      const callSpy = mockAI;
      await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "Hello!" },
          { role: "user", content: "ok" },
        ],
      });
      expect(callSpy.getCallCount()).toBe(0);
    });
  });

  describe("9. Secret rejection", () => {
    it("filters out messages containing API keys", async () => {
      mockAI.setResponse(() => llmResponse([]));
      const callCountBefore = mockAI.getCallCount();
      await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "My api_key is sk-1234567890abcdef1234567890abcdef" },
        ],
      });
      expect(mockAI.getCallCount()).toBe(callCountBefore);
    });
  });

  describe("10. Password rejection", () => {
    it("filters out messages containing passwords", async () => {
      mockAI.setResponse(() => llmResponse([]));
      const callCountBefore = mockAI.getCallCount();
      await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "password: supersecret123" },
        ],
      });
      expect(mockAI.getCallCount()).toBe(callCountBefore);
    });
  });

  describe("11. API-key rejection", () => {
    it("filters out messages with bearer tokens", async () => {
      mockAI.setResponse(() => llmResponse([]));
      const callCountBefore = mockAI.getCallCount();
      await service.extract({
        userId: "user-1",
        messages: [
          { role: "user", content: "Use this bearer token: bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" },
        ],
      });
      expect(mockAI.getCallCount()).toBe(callCountBefore);
    });
  });

  describe("12. Invalid LLM output", () => {
    it("returns empty candidates for invalid JSON", async () => {
      mockAI.setResponse(() => ({
        message: { role: "assistant", content: "not json at all" },
        finishReason: "stop",
        model: "mock",
      }));
      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "Remember my preference for tabs" }],
      });
      expect(result.candidates).toHaveLength(0);
    });

    it("returns empty candidates for missing candidates array", async () => {
      mockAI.setResponse(() => ({
        message: { role: "assistant", content: '{"result": "something"}' },
        finishReason: "stop",
        model: "mock",
      }));
      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "Remember this" }],
      });
      expect(result.candidates).toHaveLength(0);
    });

    it("returns empty candidates for null LLM content", async () => {
      mockAI.setResponse(() => ({
        message: { role: "assistant", content: null },
        finishReason: "stop",
        model: "mock",
      }));
      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "Remember this" }],
      });
      expect(result.candidates).toHaveLength(0);
    });
  });

  describe("13. Hallucinated/inferred memory rejection", () => {
    it("validates candidates have required fields via Zod schema", async () => {
      mockAI.setResponse(() => ({
        message: {
          role: "assistant",
          content: JSON.stringify({
            candidates: [
              { type: "INVALID_TYPE", content: "test", importance: 0.5, confidence: 0.5 },
            ],
          }),
        },
        finishReason: "stop",
        model: "mock",
      }));
      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "test" }],
      });
      expect(result.candidates).toHaveLength(0);
    });

    it("filters candidates with empty content", async () => {
      mockAI.setResponse(() => ({
        message: {
          role: "assistant",
          content: JSON.stringify({
            candidates: [
              { type: "FACT", content: "", importance: 0.5, confidence: 0.5 },
            ],
          }),
        },
        finishReason: "stop",
        model: "mock",
      }));
      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "test" }],
      });
      expect(result.candidates).toHaveLength(0);
    });

    it("filters candidates with out-of-range importance", async () => {
      mockAI.setResponse(() => ({
        message: {
          role: "assistant",
          content: JSON.stringify({
            candidates: [
              { type: "FACT", content: "test", importance: 1.5, confidence: 0.5 },
            ],
          }),
        },
        finishReason: "stop",
        model: "mock",
      }));
      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "test" }],
      });
      expect(result.candidates).toHaveLength(0);
    });
  });

  describe("14. Importance scoring", () => {
    it("preserves importance score from LLM extraction", async () => {
      mockAI.setResponse(() => llmResponse([
        { type: "FACT", content: "Critical fact", importance: 0.95, confidence: 1.0 },
      ]));
      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "This is critical info" }],
      });
      expect(result.candidates[0].importance).toBe(0.95);
    });
  });

  describe("15. Confidence scoring", () => {
    it("preserves confidence score from LLM extraction", async () => {
      mockAI.setResponse(() => llmResponse([
        { type: "FACT", content: "Stated fact", importance: 0.8, confidence: 1.0 },
      ]));
      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Bob" }],
      });
      expect(result.candidates[0].confidence).toBe(1.0);
    });
  });

  describe("16. Duplicate detection", () => {
    it("skips candidates with very high similarity to existing memory", async () => {
      await store.store({
        userId: "user-1",
        memories: [{
          type: "FACT",
          content: "User's name is Alice Johnson",
          importance: 0.9,
          confidence: 1.0,
          metadata: { embedding: textToEmbedding("User's name is Alice Johnson", 16) },
        }],
      });

      mockAI.setResponse(() => llmResponse([
        { type: "FACT", content: "User's name is Alice Johnson", importance: 0.9, confidence: 1.0 },
      ]));

      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Alice Johnson" }],
      });

      expect(result.meta.duplicatesSkipped).toBe(1);
      expect(result.meta.memoriesCreated).toBe(0);
    });
  });

  describe("17. Memory update/merge", () => {
    it("merges with existing memory when similarity is in merge range", async () => {
      await store.store({
        userId: "user-1",
        memories: [{
          type: "PREFERENCE",
          content: "User prefers dark mode",
          importance: 0.5,
          confidence: 0.6,
          metadata: { embedding: textToEmbedding("User prefers dark mode", 16) },
        }],
      });

      mockAI.setResponse(() => llmResponse([
        { type: "PREFERENCE", content: "User prefers dark mode over light mode", importance: 0.7, confidence: 0.9 },
      ]));

      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "I prefer dark mode over light mode" }],
      });

      expect(result.meta.memoriesUpdated).toBe(1);
      expect(result.meta.memoriesCreated).toBe(0);
    });
  });

  describe("18. New memory creation", () => {
    it("creates new memory when no similar existing memory", async () => {
      mockAI.setResponse(() => llmResponse([
        { type: "FACT", content: "User lives in Tokyo, Japan", importance: 0.8, confidence: 0.95 },
      ]));

      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "I live in Tokyo" }],
      });

      expect(result.meta.memoriesCreated).toBe(1);
      expect(result.meta.duplicatesSkipped).toBe(0);
    });
  });

  describe("19. User isolation", () => {
    it("only deduplicates against the same user's memories", async () => {
      await store.store({
        userId: "user-2",
        memories: [{
          type: "FACT",
          content: "User's name is Alice Johnson",
          importance: 0.9,
          confidence: 1.0,
          metadata: { embedding: textToEmbedding("User's name is Alice Johnson", 16) },
        }],
      });

      mockAI.setResponse(() => llmResponse([
        { type: "FACT", content: "User's name is Alice Johnson", importance: 0.9, confidence: 1.0 },
      ]));

      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Alice Johnson" }],
      });

      expect(result.meta.memoriesCreated).toBe(1);
      expect(result.meta.duplicatesSkipped).toBe(0);
    });
  });

  describe("20. Provenance preservation", () => {
    it("sets sourceType, conversationId, and messageId on extracted memories", async () => {
      mockAI.setResponse(() => llmResponse([FACT_CANDIDATE]));

      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Alice Johnson" }],
        conversationId: "conv-42",
        lastMessageId: "msg-99",
      });

      expect(result.candidates[0].sourceType).toBe("conversation");
      expect(result.candidates[0].sourceConversationId).toBe("conv-42");
      expect(result.candidates[0].sourceMessageId).toBe("msg-99");
    });
  });

  describe("21. Expiry", () => {
    it("sets expiry on extracted memories based on expiryDays", async () => {
      mockAI.setResponse(() => llmResponse([FACT_CANDIDATE]));

      const result = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Alice" }],
        expiryDays: 30,
      });

      expect(result.candidates[0].expiresAt).toBeDefined();
      const expiresAt = result.candidates[0].expiresAt!.getTime();
      const now = Date.now();
      const thirtyDaysMs = 30 * 86400000;
      expect(expiresAt).toBeGreaterThan(now + thirtyDaysMs - 1000);
      expect(expiresAt).toBeLessThan(now + thirtyDaysMs + 1000);
    });

    it("uses default expiryDays from config when not specified", async () => {
      const customService = new MemoryExtractionService({
        aiProvider: mockAI,
        store,
        embeddingProvider: fakeEmbedding,
        expiryDays: 60,
        maxRetries: 0,
      });
      mockAI.setResponse(() => llmResponse([FACT_CANDIDATE]));

      const result = await customService.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Alice" }],
      });

      expect(result.candidates[0].expiresAt).toBeDefined();
      const expiresAt = result.candidates[0].expiresAt!.getTime();
      const now = Date.now();
      const sixtyDaysMs = 60 * 86400000;
      expect(expiresAt).toBeGreaterThan(now + sixtyDaysMs - 1000);
      expect(expiresAt).toBeLessThan(now + sixtyDaysMs + 1000);
    });
  });

  describe("22. Provider failure", () => {
    it("throws MEMORY_EXTRACTION_FAILED when AI provider fails", async () => {
      mockAI.setShouldFail(true);
      await expect(
        service.extract({
          userId: "user-1",
          messages: [{ role: "user", content: "Remember this important thing" }],
        }),
      ).rejects.toThrow();
    });

    it("isAvailable returns false when AI provider is down", async () => {
      mockAI.setShouldFail(true);
      expect(await service.isAvailable()).toBe(false);
    });
  });

  describe("23. Retry behavior", () => {
    it("retries on transient failure and succeeds", async () => {
      const retryService = new MemoryExtractionService({
        aiProvider: mockAI,
        store,
        embeddingProvider: fakeEmbedding,
        maxRetries: 2,
        retryDelayMs: 10,
      });

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) throw new Error("Transient error");
        return llmResponse([FACT_CANDIDATE]);
      });

      const result = await retryService.processConversation({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Alice" }],
      });

      expect(result.candidates).toHaveLength(1);
      expect(mockAI.getCallCount()).toBe(2);
    });

    it("throws after exhausting all retries", async () => {
      const retryService = new MemoryExtractionService({
        aiProvider: mockAI,
        store,
        embeddingProvider: fakeEmbedding,
        maxRetries: 1,
        retryDelayMs: 10,
      });

      mockAI.setShouldFail(true);

      await expect(
        retryService.processConversation({
          userId: "user-1",
          messages: [{ role: "user", content: "Remember this" }],
        }),
      ).rejects.toThrow();
    });
  });

  describe("24. Idempotency", () => {
    it("produces same result when called twice with same input", async () => {
      mockAI.setResponse(() => llmResponse([FACT_CANDIDATE]));

      const result1 = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Alice" }],
        conversationId: "conv-1",
      });

      const result2 = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Alice" }],
        conversationId: "conv-1",
      });

      expect(result1.meta.candidatesFound).toBe(1);
      expect(result2.meta.candidatesFound).toBe(1);
      expect(result1.meta.memoriesCreated).toBe(1);
      expect(result2.meta.duplicatesSkipped).toBe(1);
    });

    it("second call deduplicates against first call's stored memories", async () => {
      mockAI.setResponse(() => llmResponse([FACT_CANDIDATE]));

      await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Alice" }],
        conversationId: "conv-1",
      });

      const storeCount = await store.count("user-1");
      expect(storeCount).toBe(1);

      const result2 = await service.extract({
        userId: "user-1",
        messages: [{ role: "user", content: "My name is Alice" }],
        conversationId: "conv-2",
      });

      expect(result2.meta.duplicatesSkipped).toBe(1);
      const finalCount = await store.count("user-1");
      expect(finalCount).toBe(1);
    });
  });

  describe("Empty input handling", () => {
    it("returns empty result for empty messages array", async () => {
      const result = await service.extract({
        userId: "user-1",
        messages: [],
      });
      expect(result.candidates).toHaveLength(0);
      expect(result.meta.candidatesFound).toBe(0);
    });

    it("returns empty result for missing userId", async () => {
      await expect(
        service.extract({ userId: "", messages: [{ role: "user", content: "test" }] }),
      ).rejects.toThrow("userId is required");
    });
  });
});
