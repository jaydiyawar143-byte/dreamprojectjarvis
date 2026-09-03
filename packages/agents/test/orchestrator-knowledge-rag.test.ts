// Sprint 3.7 — RAG / Orchestrator integration.
//
// The Orchestrator depends only on the `IKnowledgeRetriever` interface from
// @jarvis/core, so these tests drive it through a fake implementing that same
// contract. That is the real seam: the agents package has no dependency on
// @jarvis/memory, and the integration must not introduce one.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  AICompletionRequest,
  AICompletionResponse,
  AuditEntry,
  AuditLogger,
  EmbeddingRequest,
  EmbeddingResponse,
  IAIProvider,
  IEmbeddingProvider,
  IKnowledgeRetriever,
  IMemoryStore,
  IToolExecutor,
  JarvisRequest,
  KnowledgeRetrievalOptions,
  KnowledgeRetrievalResult,
  MemoryListResult,
  MemoryRecallResult,
  MemoryRecord,
  MemoryStoreRequest,
  RetrievedChunk,
  SessionContext,
  ToolExecutionRequest,
  ToolExecutionResult,
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import {
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  describeSource,
  formatKnowledgeBlock,
  selectKnowledgeChunks,
  shouldRetrieveKnowledge,
} from "../src/knowledge-context.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class MockAIProvider implements IAIProvider {
  readonly id = "mock-ai";
  readonly name = "Mock AI";
  readonly defaultModel = "mock-model";
  requests: AICompletionRequest[] = [];

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    return {
      message: { role: "assistant", content: "Acknowledged." },
      finishReason: "stop",
      model: this.defaultModel,
    };
  }
  async listModels() {
    return [this.defaultModel];
  }
  async isAvailable() {
    return true;
  }

  /** Every message body the model was shown, joined. */
  lastPrompt(): string {
    const last = this.requests.at(-1);
    if (!last) return "";
    return last.messages.map((m) => String(m.content ?? "")).join("\n");
  }
}

function makeChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    documentTitle: "Refund Policy.pdf",
    documentType: "POLICY",
    source: "upload",
    chunkIndex: 0,
    content: "Refunds are issued within fourteen days of purchase.",
    score: 0.82,
    distance: 0.18,
    pageNumbers: [2],
    sections: [{ title: "Refunds", level: 1, order: 0 }],
    primarySection: { title: "Refunds", level: 1, order: 0 },
    metadata: null,
    ...overrides,
  };
}

interface RetrieverCall {
  userId: string;
  query: string;
  options?: KnowledgeRetrievalOptions;
}

class FakeKnowledgeRetriever implements IKnowledgeRetriever {
  calls: RetrieverCall[] = [];
  results: RetrievedChunk[] = [];
  failWith: unknown = null;

  async retrieve(
    userId: string,
    query: string,
    options?: KnowledgeRetrievalOptions
  ): Promise<KnowledgeRetrievalResult> {
    this.calls.push({ userId, query, ...(options ? { options } : {}) });
    if (this.failWith) throw this.failWith;

    const threshold = options?.similarityThreshold ?? 0;
    const topK = options?.topK ?? 5;
    const results = this.results
      .filter((chunk) => chunk.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return {
      query,
      results,
      resultCount: results.length,
      topK,
      similarityThreshold: threshold,
      dimensions: 3,
      model: "fake-embed-v1",
      retrievalVersion: "3.5.0",
      emptyQuery: query.trim().length === 0,
    };
  }
}

/** Minimal memory store, present only to prove RAG and memory coexist. */
class StubMemoryStore implements IMemoryStore {
  readonly id = "stub-memory";
  readonly name = "Stub Memory Store";
  records: MemoryRecord[] = [];

  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    const created = request.memories.map((mem, i) => ({
      id: `mem-${this.records.length + i}`,
      userId: request.userId,
      type: mem.type,
      content: mem.content,
      importance: mem.importance,
      confidence: mem.confidence,
      accessCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as MemoryRecord[];
    this.records.push(...created);
    return created;
  }
  async getById() {
    return null;
  }
  async recall(): Promise<MemoryRecallResult[]> {
    return this.records.map((memory) => ({
      memory,
      semanticScore: 0.9,
      recencyScore: 0.5,
      finalScore: 0.8,
    }));
  }
  async list(): Promise<MemoryListResult> {
    return { memories: this.records, total: this.records.length, hasMore: false };
  }
  async delete() {
    return 0;
  }
  async deleteAll() {
    return 0;
  }
  async update(): Promise<MemoryRecord> {
    throw new JarvisError("MEMORY_ERROR", "not implemented");
  }
  async findSimilar() {
    return [];
  }
  async count() {
    return this.records.length;
  }
  async isAvailable() {
    return true;
  }
}

class FakeEmbeddingProvider implements IEmbeddingProvider {
  readonly id = "fake-embedding";
  readonly name = "Fake Embedding";
  readonly dimensions = 3;
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map(() => [1, 0, 0]), model: "fake" };
  }
  async isAvailable() {
    return true;
  }
}

const noopToolExecutor: IToolExecutor = {
  async execute(_request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    return { executionId: "exec-1", toolId: "noop", status: "success", result: { success: true } };
  },
};

function createMockAuditLogger(): AuditLogger {
  const entries: AuditEntry[] = [];
  return {
    async log(entry) {
      entries.push({ ...entry, id: `audit-${entries.length}`, timestamp: new Date() } as AuditEntry);
    },
    async query() {
      return entries;
    },
  } as AuditLogger;
}

function ctx(userId = "user-1"): SessionContext {
  return {
    auth: { userId, role: "member", email: `${userId}@test.com` },
    traceId: "00000000-0000-0000-0000-000000000001",
  };
}

const req = (message: string): JarvisRequest => ({ message, stream: false });

// ---------------------------------------------------------------------------

describe("Sprint 3.7 — RAG orchestrator integration", () => {
  let mockAI: MockAIProvider;
  let retriever: FakeKnowledgeRetriever;
  let auditLogger: AuditLogger;
  let registry: AgentRegistry;

  beforeEach(() => {
    mockAI = new MockAIProvider();
    retriever = new FakeKnowledgeRetriever();
    auditLogger = createMockAuditLogger();
    registry = new AgentRegistry();
    registry.register(
      new ConversationalAssistant({ provider: mockAI, systemPrompt: "You are JARVIS." })
    );
  });

  function orchestrator(
    config: Record<string, unknown> = {},
    withRetriever: IKnowledgeRetriever | null = retriever
  ): Orchestrator {
    return new Orchestrator(registry, noopToolExecutor, auditLogger, {
      ...(withRetriever ? { knowledgeRetriever: withRetriever } : {}),
      ...config,
    });
  }

  // -------------------------------------------------------------------------
  // 1. Relevant knowledge retrieval
  // -------------------------------------------------------------------------

  describe("relevant knowledge retrieval", () => {
    beforeEach(() => {
      retriever.results = [makeChunk()];
    });

    it("1. retrieves for a knowledge-style question", async () => {
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      expect(retriever.calls).toHaveLength(1);
      expect(retriever.calls[0]!.query).toBe("What is our refund policy?");
    });

    it("2. injects the retrieved passage into the prompt", async () => {
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      const prompt = mockAI.lastPrompt();
      expect(prompt).toContain("<knowledge_base>");
      expect(prompt).toContain("Refunds are issued within fourteen days");
      expect(prompt).toContain("</knowledge_base>");
    });

    it("3. keeps the user's own question in the prompt", async () => {
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      expect(mockAI.lastPrompt()).toContain("What is our refund policy?");
    });

    it("4. scopes retrieval to the authenticated user", async () => {
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx("user-77"));

      expect(retriever.calls[0]!.userId).toBe("user-77");
    });

    it("5. returns a successful response", async () => {
      const orch = orchestrator();
      const res = await orch.process(req("What is our refund policy?"), ctx());

      expect(res.success).toBe(true);
      expect(res.data!.message).toBe("Acknowledged.");
    });

    it("6. uses the original message as the query, not the memory-augmented one", async () => {
      const memoryStore = new StubMemoryStore();
      await memoryStore.store({
        userId: "user-1",
        memories: [
          { type: "PREFERENCE", content: "User prefers concise answers", importance: 0.8, confidence: 0.9 },
        ],
      });

      const orch = orchestrator({
        memoryStore,
        embeddingProvider: new FakeEmbeddingProvider(),
      });
      await orch.process(req("What is our refund policy?"), ctx());

      expect(retriever.calls[0]!.query).toBe("What is our refund policy?");
      expect(retriever.calls[0]!.query).not.toContain("user_memories");
      expect(retriever.calls[0]!.query).not.toContain("concise answers");
    });

    it("7. passes the configured topK and threshold to the retriever", async () => {
      const orch = orchestrator({ knowledge: { maxChunks: 2, minScore: 0.5 } });
      await orch.process(req("What is our refund policy?"), ctx());

      expect(retriever.calls[0]!.options).toMatchObject({
        topK: 2,
        similarityThreshold: 0.5,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Irrelevant requests must not retrieve
  // -------------------------------------------------------------------------

  describe("requests that must not trigger retrieval", () => {
    beforeEach(() => {
      retriever.results = [makeChunk()];
    });

    const skipped = [
      ["a bare confirmation", "yes"],
      ["a Hinglish confirmation", "haan kar do"],
      ["a rejection", "nahi"],
      ["an English rejection", "cancel"],
      ["a greeting", "hello"],
      ["a Hinglish greeting", "namaste"],
      ["small talk", "how are you"],
      ["an acknowledgement", "thanks"],
      ["a two-character message", "ok"],
      ["whitespace", "   "],
    ] as const;

    for (const [label, message] of skipped) {
      it(`8.${skipped.findIndex((s) => s[1] === message)} skips retrieval for ${label}`, async () => {
        const orch = orchestrator();
        await orch.process(req(message), ctx());

        expect(retriever.calls).toHaveLength(0);
        expect(mockAI.lastPrompt()).not.toContain("<knowledge_base>");
      });
    }

    it("9. still retrieves for a short but genuine question", async () => {
      const orch = orchestrator();
      await orch.process(req("refund policy?"), ctx());

      expect(retriever.calls).toHaveLength(1);
    });

    it("10. still retrieves for a message that merely starts with a greeting word", async () => {
      const orch = orchestrator();
      await orch.process(req("hi, what is our refund policy?"), ctx());

      expect(retriever.calls).toHaveLength(1);
    });

    it("11. answers a skipped message normally", async () => {
      const orch = orchestrator();
      const res = await orch.process(req("yes"), ctx());

      expect(res.success).toBe(true);
      expect(res.data!.message).toBe("Acknowledged.");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Multiple relevant chunks
  // -------------------------------------------------------------------------

  describe("multiple relevant chunks", () => {
    beforeEach(() => {
      retriever.results = [
        makeChunk({ chunkId: "c1", content: "Refunds are issued within fourteen days.", score: 0.9 }),
        makeChunk({
          chunkId: "c2",
          chunkIndex: 1,
          content: "A refund request must include the order number.",
          score: 0.7,
          pageNumbers: [3],
        }),
        makeChunk({
          chunkId: "c3",
          documentId: "doc-2",
          documentTitle: "Shipping FAQ.docx",
          content: "Shipping takes three to five days.",
          score: 0.5,
          pageNumbers: [],
          primarySection: undefined,
        }),
      ];
    });

    it("12. injects every passage above the floor", async () => {
      const orch = orchestrator();
      await orch.process(req("Tell me about refunds and shipping"), ctx());

      const prompt = mockAI.lastPrompt();
      expect(prompt).toContain("Refunds are issued within fourteen days");
      expect(prompt).toContain("must include the order number");
      expect(prompt).toContain("Shipping takes three to five days");
    });

    it("13. numbers the passages", async () => {
      const orch = orchestrator();
      await orch.process(req("Tell me about refunds and shipping"), ctx());

      const prompt = mockAI.lastPrompt();
      expect(prompt).toContain("[1] source:");
      expect(prompt).toContain("[2] source:");
      expect(prompt).toContain("[3] source:");
    });

    it("14. keeps them in descending relevance order", async () => {
      const orch = orchestrator();
      await orch.process(req("Tell me about refunds and shipping"), ctx());

      const prompt = mockAI.lastPrompt();
      const first = prompt.indexOf("fourteen days");
      const second = prompt.indexOf("order number");
      const third = prompt.indexOf("three to five days");

      expect(first).toBeGreaterThan(-1);
      expect(first).toBeLessThan(second);
      expect(second).toBeLessThan(third);
    });

    it("15. respects the configured maximum", async () => {
      const orch = orchestrator({ knowledge: { maxChunks: 2 } });
      await orch.process(req("Tell me about refunds and shipping"), ctx());

      const prompt = mockAI.lastPrompt();
      expect(prompt).toContain("[2] source:");
      expect(prompt).not.toContain("[3] source:");
    });
  });

  // -------------------------------------------------------------------------
  // 4. No results
  // -------------------------------------------------------------------------

  describe("no results", () => {
    it("16. injects nothing when retrieval finds nothing", async () => {
      retriever.results = [];
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      expect(retriever.calls).toHaveLength(1);
      expect(mockAI.lastPrompt()).not.toContain("<knowledge_base>");
    });

    it("17. leaves the user's message untouched", async () => {
      retriever.results = [];
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      const userMessages = mockAI.requests.at(-1)!.messages.filter((m) => m.role === "user");
      expect(userMessages.at(-1)!.content).toBe("What is our refund policy?");
    });

    it("18. still answers normally", async () => {
      retriever.results = [];
      const orch = orchestrator();
      const res = await orch.process(req("What is our refund policy?"), ctx());

      expect(res.success).toBe(true);
      expect(res.data!.message).toBe("Acknowledged.");
    });

    it("19. drops results that fall below the score floor", async () => {
      retriever.results = [makeChunk({ score: 0.1 })];
      const orch = orchestrator({ knowledge: { minScore: 0.5 } });
      await orch.process(req("What is our refund policy?"), ctx());

      expect(mockAI.lastPrompt()).not.toContain("<knowledge_base>");
    });

    it("20. injects a weak match when the floor is lowered to allow it", async () => {
      retriever.results = [makeChunk({ score: 0.2 })];
      const orch = orchestrator({ knowledge: { minScore: 0.1 } });
      await orch.process(req("What is our refund policy?"), ctx());

      expect(mockAI.lastPrompt()).toContain("<knowledge_base>");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Retrieval failures
  // -------------------------------------------------------------------------

  describe("retrieval failures", () => {
    it("21. survives an embedding provider failure", async () => {
      retriever.failWith = new JarvisError(
        "DOCUMENT_EMBEDDING_FAILED",
        "Embedding provider request failed"
      );
      const orch = orchestrator();
      const res = await orch.process(req("What is our refund policy?"), ctx());

      expect(res.success).toBe(true);
      expect(res.data!.message).toBe("Acknowledged.");
    });

    it("22. survives a database failure", async () => {
      retriever.failWith = new JarvisError(
        "KNOWLEDGE_RETRIEVAL_FAILED",
        "Knowledge chunk similarity search failed"
      );
      const orch = orchestrator();
      const res = await orch.process(req("What is our refund policy?"), ctx());

      expect(res.success).toBe(true);
    });

    it("23. survives an unexpected error", async () => {
      retriever.failWith = new Error("connection reset");
      const orch = orchestrator();
      const res = await orch.process(req("What is our refund policy?"), ctx());

      expect(res.success).toBe(true);
    });

    it("24. leaves the prompt unchanged on failure", async () => {
      retriever.failWith = new Error("connection reset");
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      const prompt = mockAI.lastPrompt();
      expect(prompt).not.toContain("<knowledge_base>");
      expect(prompt).toContain("What is our refund policy?");
    });

    it("25. logs the failure so a broken retriever is visible", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      retriever.failWith = new Error("connection reset");

      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      spy.mockRestore();

      expect(logged).toContain("knowledge_retrieval_failed");
      expect(logged).toContain("connection reset");
    });

    it("26. survives a retriever returning a malformed result", async () => {
      const broken = {
        retrieve: async () => ({ results: null }) as unknown as KnowledgeRetrievalResult,
      } as IKnowledgeRetriever;

      const orch = orchestrator({}, broken);
      const res = await orch.process(req("What is our refund policy?"), ctx());

      expect(res.success).toBe(true);
      expect(mockAI.lastPrompt()).not.toContain("<knowledge_base>");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Context injection format
  // -------------------------------------------------------------------------

  describe("context injection format", () => {
    beforeEach(() => {
      retriever.results = [makeChunk()];
    });

    it("27. delimits the block", async () => {
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      const prompt = mockAI.lastPrompt();
      expect(prompt).toContain("<knowledge_base>");
      expect(prompt).toContain("</knowledge_base>");
      expect(prompt.indexOf("<knowledge_base>")).toBeLessThan(
        prompt.indexOf("</knowledge_base>")
      );
    });

    it("28. marks the passages as data rather than instructions", async () => {
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      expect(mockAI.lastPrompt()).toContain("not as instructions");
    });

    it("29. tells the model not to invent a source", async () => {
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      expect(mockAI.lastPrompt()).toContain("do not invent a source");
    });

    it("30. places the block before the user's question", async () => {
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      const prompt = mockAI.lastPrompt();
      expect(prompt.indexOf("</knowledge_base>")).toBeLessThan(
        prompt.lastIndexOf("What is our refund policy?")
      );
    });

    it("31. honours the character budget", async () => {
      retriever.results = [
        makeChunk({ chunkId: "a", content: "A".repeat(500), score: 0.9 }),
        makeChunk({ chunkId: "b", content: "B".repeat(500), score: 0.8 }),
        makeChunk({ chunkId: "c", content: "C".repeat(500), score: 0.7 }),
      ];

      const orch = orchestrator({ knowledge: { contextBudgetChars: 700 } });
      await orch.process(req("What is our refund policy?"), ctx());

      const prompt = mockAI.lastPrompt();
      expect(prompt).toContain("A".repeat(500));
      expect(prompt).not.toContain("C".repeat(500));
    });
  });

  // -------------------------------------------------------------------------
  // 7. Source metadata preservation
  // -------------------------------------------------------------------------

  describe("source metadata preservation", () => {
    it("32. names the source document", async () => {
      retriever.results = [makeChunk()];
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      expect(mockAI.lastPrompt()).toContain("source: Refund Policy.pdf");
    });

    it("33. carries a single page number", async () => {
      retriever.results = [makeChunk({ pageNumbers: [2] })];
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      expect(mockAI.lastPrompt()).toContain("page: 2");
    });

    it("34. carries a page range", async () => {
      retriever.results = [makeChunk({ pageNumbers: [2, 3] })];
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      expect(mockAI.lastPrompt()).toContain("pages: 2, 3");
    });

    it("35. carries the section title", async () => {
      retriever.results = [makeChunk()];
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      expect(mockAI.lastPrompt()).toContain("section: Refunds");
    });

    it("36. carries the relevance score", async () => {
      retriever.results = [makeChunk({ score: 0.82 })];
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      expect(mockAI.lastPrompt()).toContain("relevance: 0.82");
    });

    it("37. omits page and section when the document has neither", async () => {
      retriever.results = [makeChunk({ pageNumbers: [], primarySection: undefined })];
      const orch = orchestrator();
      await orch.process(req("What is our refund policy?"), ctx());

      const prompt = mockAI.lastPrompt();
      expect(prompt).toContain("source: Refund Policy.pdf");
      expect(prompt).not.toContain("page:");
      expect(prompt).not.toContain("section:");
    });
  });

  // -------------------------------------------------------------------------
  // 8. Existing behaviour must be unchanged
  // -------------------------------------------------------------------------

  describe("existing non-RAG behaviour", () => {
    it("38. behaves exactly as before when no retriever is configured", async () => {
      const orch = orchestrator({}, null);
      const res = await orch.process(req("What is our refund policy?"), ctx());

      expect(res.success).toBe(true);
      expect(res.data!.message).toBe("Acknowledged.");
      expect(mockAI.lastPrompt()).not.toContain("<knowledge_base>");
      expect(retriever.calls).toHaveLength(0);
    });

    it("39. never retrieves when knowledge is disabled by config", async () => {
      retriever.results = [makeChunk()];
      const orch = orchestrator({ knowledge: { enabled: false } });
      await orch.process(req("What is our refund policy?"), ctx());

      expect(retriever.calls).toHaveLength(0);
      expect(mockAI.lastPrompt()).not.toContain("<knowledge_base>");
    });

    it("40. leaves memory injection working", async () => {
      const memoryStore = new StubMemoryStore();
      await memoryStore.store({
        userId: "user-1",
        memories: [
          { type: "PREFERENCE", content: "User prefers dark mode", importance: 0.8, confidence: 0.9 },
        ],
      });
      retriever.results = [];

      const orch = orchestrator({
        memoryStore,
        embeddingProvider: new FakeEmbeddingProvider(),
      });
      await orch.process(req("What is my theme preference?"), ctx());

      expect(mockAI.lastPrompt()).toContain("<user_memories>");
      expect(mockAI.lastPrompt()).toContain("User prefers dark mode");
    });

    it("41. injects both blocks when both have something to say", async () => {
      const memoryStore = new StubMemoryStore();
      await memoryStore.store({
        userId: "user-1",
        memories: [
          { type: "PREFERENCE", content: "User prefers dark mode", importance: 0.8, confidence: 0.9 },
        ],
      });
      retriever.results = [makeChunk()];

      const orch = orchestrator({
        memoryStore,
        embeddingProvider: new FakeEmbeddingProvider(),
      });
      await orch.process(req("What is our refund policy?"), ctx());

      const prompt = mockAI.lastPrompt();
      expect(prompt).toContain("<user_memories>");
      expect(prompt).toContain("<knowledge_base>");
      expect(prompt).toContain("What is our refund policy?");
    });

    it("42. a knowledge failure does not disturb memory injection", async () => {
      const memoryStore = new StubMemoryStore();
      await memoryStore.store({
        userId: "user-1",
        memories: [
          { type: "FACT", content: "Company founded in 2019", importance: 0.8, confidence: 0.9 },
        ],
      });
      retriever.failWith = new Error("retriever down");

      const orch = orchestrator({
        memoryStore,
        embeddingProvider: new FakeEmbeddingProvider(),
      });
      const res = await orch.process(req("When was the company founded?"), ctx());

      expect(res.success).toBe(true);
      expect(mockAI.lastPrompt()).toContain("Company founded in 2019");
    });
  });

  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------

  describe("knowledge-context helpers", () => {
    it("43. the gate accepts real questions and rejects filler", () => {
      expect(shouldRetrieveKnowledge("What is the refund window?")).toBe(true);
      expect(shouldRetrieveKnowledge("refund policy?")).toBe(true);
      expect(shouldRetrieveKnowledge("yes")).toBe(false);
      expect(shouldRetrieveKnowledge("  haan kar do  ")).toBe(false);
      expect(shouldRetrieveKnowledge("hello!")).toBe(false);
      expect(shouldRetrieveKnowledge("")).toBe(false);
      expect(shouldRetrieveKnowledge(null)).toBe(false);
    });

    it("43b. the gate handles open-ended confirmation phrasing", () => {
      // Phrase enumeration missed these; token matching covers the combinations.
      expect(shouldRetrieveKnowledge("haan kar do")).toBe(false);
      expect(shouldRetrieveKnowledge("yes please go ahead")).toBe(false);
      expect(shouldRetrieveKnowledge("nahi mat karo")).toBe(false);
      expect(shouldRetrieveKnowledge("ok, thanks!")).toBe(false);
      expect(shouldRetrieveKnowledge("theek hai chalo")).toBe(false);
    });

    it("43c. one content word is enough to trigger retrieval", () => {
      expect(shouldRetrieveKnowledge("haan refund policy batao")).toBe(true);
      expect(shouldRetrieveKnowledge("ok what about shipping")).toBe(true);
      expect(shouldRetrieveKnowledge("thanks, where is the warranty clause")).toBe(true);
      expect(shouldRetrieveKnowledge("why")).toBe(true);
    });

    it("44. selection applies the floor and the cap", () => {
      const chunks = [
        makeChunk({ chunkId: "a", score: 0.9 }),
        makeChunk({ chunkId: "b", score: 0.4 }),
        makeChunk({ chunkId: "c", score: 0.2 }),
      ];

      expect(selectKnowledgeChunks(chunks, 0.3, 5).map((c) => c.chunkId)).toEqual(["a", "b"]);
      expect(selectKnowledgeChunks(chunks, 0, 1).map((c) => c.chunkId)).toEqual(["a"]);
      expect(selectKnowledgeChunks([], 0, 5)).toEqual([]);
    });

    it("45. an empty selection formats to an empty string", () => {
      expect(formatKnowledgeBlock([])).toBe("");
    });

    it("46. the top passage is truncated rather than dropped when oversized", () => {
      const block = formatKnowledgeBlock([makeChunk({ content: "X".repeat(5000) })], 200);

      expect(block).toContain("<knowledge_base>");
      expect(block).toContain("[…truncated]");
      expect(block).toContain("source: Refund Policy.pdf");
    });

    it("47. describeSource renders provenance without internal identifiers", () => {
      const line = describeSource(makeChunk(), 1);

      expect(line).toBe(
        "[1] source: Refund Policy.pdf | page: 2 | section: Refunds | relevance: 0.82"
      );
      expect(line).not.toContain("chunk-1");
      expect(line).not.toContain("doc-1");
    });

    it("48. the default budget is large enough for the default chunk count", () => {
      const chunks = [
        makeChunk({ chunkId: "a", content: "A".repeat(1000) }),
        makeChunk({ chunkId: "b", content: "B".repeat(1000) }),
        makeChunk({ chunkId: "c", content: "C".repeat(1000) }),
      ];
      const block = formatKnowledgeBlock(chunks, DEFAULT_KNOWLEDGE_BUDGET_CHARS);

      expect(block).toContain("[3] source:");
      expect(block).not.toContain("[…truncated]");
    });
  });
});
