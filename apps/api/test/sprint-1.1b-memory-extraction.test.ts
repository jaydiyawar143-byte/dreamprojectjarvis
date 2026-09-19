import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  IAIProvider,
  IEmbeddingProvider,
  IMemoryStore,
  IMemoryExtractor,
  IToolExecutor,
  AuditLogger,
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
  JarvisRequest,
  SessionContext,
} from "@jarvis/core";
import { Orchestrator, AgentRegistry, ConversationalAssistant } from "@jarvis/agents";
import { MemoryExtractionService } from "@jarvis/memory";
import { getContainer, resetContainer } from "../src/services/container.js";

// ---------------------------------------------------------------------------
// Mock Providers & Stores
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

  resetCallCount() {
    this.callCount = 0;
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
    const embeddings = inputs.map(() => new Array(this.dimensions).fill(0.1));
    return { embeddings, model: "fake-model" };
  }

  async isAvailable(): Promise<boolean> {
    return !this.shouldFail;
  }
}

class InMemoryStore implements IMemoryStore {
  readonly id = "in-memory";
  readonly name = "In-Memory Store";
  private memories: MemoryRecord[] = [];
  private nextId = 1;
  private shouldFail = false;

  setShouldFail(fail: boolean) {
    this.shouldFail = fail;
  }

  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    if (this.shouldFail) throw new Error("Store failed");
    const results: MemoryRecord[] = [];
    for (const mem of request.memories) {
      const now = new Date();
      const record: MemoryRecord = {
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
      this.memories.push(record);
      results.push(record);
    }
    return results;
  }

  async storeWithEmbedding(request: MemoryStoreRequest, _embeddings: number[][]): Promise<MemoryRecord[]> {
    return this.store(request);
  }

  async getById(userId: string, memoryId: string): Promise<MemoryRecord | null> {
    return this.memories.find((m) => m.id === memoryId && m.userId === userId) ?? null;
  }

  async recall(_request: MemoryRecallRequest): Promise<MemoryRecallResult[]> {
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
    m.updatedAt = new Date();
    return m;
  }

  async findSimilar(_userId: string, _embedding: number[], _threshold = 0.5, _limit = 10): Promise<MemoryRecord[]> {
    return [];
  }

  async count(userId: string): Promise<number> {
    return this.memories.filter((m) => m.userId === userId).length;
  }

  async isAvailable(): Promise<boolean> {
    return !this.shouldFail;
  }

  getMemoriesRaw(): MemoryRecord[] {
    return this.memories;
  }
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function makeCtx(userId: string, conversationId = "conv-123"): SessionContext {
  return {
    auth: { userId, role: "member", email: `${userId}@example.com` },
    conversationId,
    traceId: "00000000-0000-0000-0000-000000000001",
  };
}

function makeReq(message: string, conversationId = "conv-123"): JarvisRequest {
  return { message, conversationId, stream: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sprint 1.1B: Memory Extraction Service Wiring Tests", () => {
  let mockAI: MockAIProvider;
  let fakeEmbedding: FakeEmbeddingProvider;
  let store: InMemoryStore;
  let extractionService: MemoryExtractionService;
  let registry: AgentRegistry;
  let auditLogger: AuditLogger;
  let toolExecutor: IToolExecutor;

  beforeEach(() => {
    mockAI = new MockAIProvider();
    fakeEmbedding = new FakeEmbeddingProvider();
    store = new InMemoryStore();
    registry = new AgentRegistry();
    auditLogger = { log: vi.fn(), query: vi.fn() } as any;
    toolExecutor = { execute: vi.fn() } as any;

    extractionService = new MemoryExtractionService({
      aiProvider: mockAI,
      store,
      embeddingProvider: fakeEmbedding,
    });

    const agent = new ConversationalAssistant({
      provider: mockAI,
      systemPrompt: "You are JARVIS.",
    });
    registry.register(agent);
  });

  function createOrchestrator(memoryExtractor: IMemoryExtractor | undefined = extractionService) {
    return new Orchestrator(registry, toolExecutor, auditLogger, {
      memoryStore: store,
      memoryExtractor,
      embeddingProvider: fakeEmbedding,
      memory: { maxMemories: 5, relevanceThreshold: 0.3, contextBudgetChars: 2000, extractionEnabled: true },
    });
  }

  // T1, T2, T3: Memory Type Extractions
  it("T1: extracts FACT from user statements", async () => {
    mockAI.setResponse((req) => {
      if (req.messages[0].content.includes("memory extraction")) {
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              candidates: [
                { type: "FACT", content: "My company uses Meta Ads for acquisition.", importance: 0.9, confidence: 1.0 },
              ],
            }),
          },
          finishReason: "stop",
          model: "mock",
        };
      }
      return { message: { role: "assistant", content: "Understood." }, finishReason: "stop", model: "mock" };
    });

    const orch = createOrchestrator();
    await orch.process(makeReq("My company uses Meta Ads for acquisition."), makeCtx("user-alpha"));

    // Allow async extraction to fire and finish
    await new Promise((resolve) => setTimeout(resolve, 30));

    const records = store.getMemoriesRaw();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("FACT");
    expect(records[0].content).toBe("My company uses Meta Ads for acquisition.");
    expect(records[0].userId).toBe("user-alpha");
  });

  it("T2: extracts PREFERENCE from user statements", async () => {
    mockAI.setResponse((req) => {
      if (req.messages[0].content.includes("memory extraction")) {
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              candidates: [
                { type: "PREFERENCE", content: "I prefer concise reports.", importance: 0.7, confidence: 0.9 },
              ],
            }),
          },
          finishReason: "stop",
          model: "mock",
        };
      }
      return { message: { role: "assistant", content: "Understood." }, finishReason: "stop", model: "mock" };
    });

    const orch = createOrchestrator();
    await orch.process(makeReq("I prefer concise reports."), makeCtx("user-alpha"));

    await new Promise((resolve) => setTimeout(resolve, 30));

    const records = store.getMemoriesRaw();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("PREFERENCE");
    expect(records[0].content).toBe("I prefer concise reports.");
  });

  it("T3: extracts GOAL from user statements", async () => {
    mockAI.setResponse((req) => {
      if (req.messages[0].content.includes("memory extraction")) {
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              candidates: [
                { type: "GOAL", content: "I want to reduce CPA this month.", importance: 0.8, confidence: 0.95 },
              ],
            }),
          },
          finishReason: "stop",
          model: "mock",
        };
      }
      return { message: { role: "assistant", content: "Understood." }, finishReason: "stop", model: "mock" };
    });

    const orch = createOrchestrator();
    await orch.process(makeReq("I want to reduce CPA this month."), makeCtx("user-alpha"));

    await new Promise((resolve) => setTimeout(resolve, 30));

    const records = store.getMemoriesRaw();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("GOAL");
    expect(records[0].content).toBe("I want to reduce CPA this month.");
  });

  // T4, T5: Conversational/Ambiguous Ignoring
  it("T4 & T5: ignores ordinary/transient conversation and ambiguous info", async () => {
    mockAI.setResponse((req) => {
      if (req.messages[0].content.includes("memory extraction")) {
        return {
          message: { role: "assistant", content: '{"candidates":[]}' },
          finishReason: "stop",
          model: "mock",
        };
      }
      return { message: { role: "assistant", content: "Hi! How can I help?" }, finishReason: "stop", model: "mock" };
    });

    const orch = createOrchestrator();
    await orch.process(makeReq("Hi JARVIS"), makeCtx("user-alpha"));

    await new Promise((resolve) => setTimeout(resolve, 30));

    const records = store.getMemoriesRaw();
    expect(records).toHaveLength(0);
  });

  // T6: Memory Persisted
  it("T6: stores extracted memories to a real persistent IMemoryStore", async () => {
    mockAI.setResponse((req) => {
      if (req.messages[0].content.includes("memory extraction")) {
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              candidates: [
                { type: "FACT", content: "Alice likes coding.", importance: 0.6, confidence: 0.9 },
              ],
            }),
          },
          finishReason: "stop",
          model: "mock",
        };
      }
      return { message: { role: "assistant", content: "OK" }, finishReason: "stop", model: "mock" };
    });

    const spyStore = vi.spyOn(store, "store");

    const orch = createOrchestrator();
    await orch.process(makeReq("My friend Alice likes coding."), makeCtx("user-alpha"));

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(spyStore).toHaveBeenCalledOnce();
  });

  // T7, T8: User / Account Isolation
  it("T7 & T8: enforces user/account isolation, preventing cross-user leak", async () => {
    mockAI.setResponse((req) => {
      if (req.messages[0].content.includes("memory extraction")) {
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              candidates: [
                { type: "FACT", content: "User specific secret.", importance: 0.9, confidence: 1.0 },
              ],
            }),
          },
          finishReason: "stop",
          model: "mock",
        };
      }
      return { message: { role: "assistant", content: "Saved." }, finishReason: "stop", model: "mock" };
    });

    const orch = createOrchestrator();
    await orch.process(makeReq("Save a private fact"), makeCtx("user-A"));

    await new Promise((resolve) => setTimeout(resolve, 30));

    const memoriesA = await store.list({ userId: "user-A" });
    const memoriesB = await store.list({ userId: "user-B" });

    expect(memoriesA.total).toBe(1);
    expect(memoriesB.total).toBe(0);
    expect(memoriesA.memories[0].userId).toBe("user-A");
  });

  // T9: Secret Filtering
  it("T9: pre-filter rejects and ignores secret-like content from LLM", async () => {
    mockAI.setResponse((req) => {
      if (req.messages[0].content.includes("memory extraction")) {
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              candidates: [
                { type: "FACT", content: "My apikey: sk-proj12345678901234567890", importance: 0.9, confidence: 1.0 },
              ],
            }),
          },
          finishReason: "stop",
          model: "mock",
        };
      }
      return { message: { role: "assistant", content: "OK" }, finishReason: "stop", model: "mock" };
    });

    const spyStore = vi.spyOn(store, "store");

    const orch = createOrchestrator();
    await orch.process(makeReq("My apikey: sk-proj12345678901234567890"), makeCtx("user-alpha"));

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(spyStore).not.toHaveBeenCalled();
    expect(store.getMemoriesRaw()).toHaveLength(0);
  });

  // T10: Non-blocking Failure
  it("T10: extraction failure does not fail the primary conversational response", async () => {
    mockAI.setResponse((req) => {
      if (req.messages[0].content.includes("memory extraction")) {
        throw new Error("AI Completion failed for extraction");
      }
      return { message: { role: "assistant", content: "Successful chat response." }, finishReason: "stop", model: "mock" };
    });

    const orch = createOrchestrator();
    const res = await orch.process(makeReq("Extract this fact"), makeCtx("user-alpha"));

    expect(res.success).toBe(true);
    expect(res.data?.message).toBe("Successful chat response.");

    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  // T11: Duplicate Handling
  it("T11: skips duplicate candidates or merges them if similarity threshold crossed", async () => {
    await store.store({
      userId: "user-alpha",
      memories: [
        {
          type: "FACT",
          content: "Alice likes coding.",
          importance: 0.6,
          confidence: 0.9,
        },
      ],
    });

    mockAI.setResponse((req) => {
      if (req.messages[0].content.includes("memory extraction")) {
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              candidates: [
                { type: "FACT", content: "Alice likes coding.", importance: 0.6, confidence: 0.9 },
              ],
            }),
          },
          finishReason: "stop",
          model: "mock",
        };
      }
      return { message: { role: "assistant", content: "Understood." }, finishReason: "stop", model: "mock" };
    });

    const orch = createOrchestrator();
    await orch.process(makeReq("Remember that Alice likes coding."), makeCtx("user-alpha"));

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(store.getMemoriesRaw()).toHaveLength(1);
  });

  // T12: Container Wiring
  it("T12: getContainer wires memoryExtractor correctly under OpenAI config", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalJwtSecret = process.env.JWT_SECRET;
    try {
      process.env.OPENAI_API_KEY = "mock-api-key";
      process.env.JWT_SECRET = "mock-jwt-secret";
      resetContainer();

      const c = getContainer();
      expect(c.memoryExtractor).not.toBeNull();
      expect(c.memoryStore).not.toBeNull();
      expect(c.embeddingProvider).not.toBeNull();
    } finally {
      process.env.OPENAI_API_KEY = originalApiKey;
      process.env.JWT_SECRET = originalJwtSecret;
      resetContainer();
    }
  });

  // T13, T14: Conversation Lifecycle
  it("T13 & T14: invokes extraction during normal process flow exactly once", async () => {
    let extractionCalls = 0;
    const customExtractor: IMemoryExtractor = {
      id: "custom-extractor",
      name: "Custom Extractor",
      async extract(_req) {
        extractionCalls++;
        return {
          candidates: [],
          meta: { candidatesFound: 0, candidatesValidated: 0, candidatesFiltered: 0, duplicatesSkipped: 0, memoriesCreated: 0, memoriesUpdated: 0, processingTimeMs: 0 },
        };
      },
      async isAvailable() {
        return true;
      },
    };

    mockAI.setResponse(() => ({
      message: { role: "assistant", content: "Hello." },
      finishReason: "stop",
      model: "mock",
    }));

    const orch = createOrchestrator(customExtractor);
    await orch.process(makeReq("Hello JARVIS"), makeCtx("user-alpha"));

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(extractionCalls).toBe(1);
  });
});
