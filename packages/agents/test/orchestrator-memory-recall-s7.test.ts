// S7 Step 4 — orchestrator side of the memory retrieval repair contract.
// TESTS FIRST: written before the repair and expected to FAIL against the
// current implementation.
//
//   Part 2 — the relevance threshold reaches recall as MINIMUM SIMILARITY.
//            Today orchestrator.ts passes it as `minImportance`.
//   Part 8 — when vector recall throws, the fallback still supplies memory AND
//            a structured diagnostic event is emitted. Today the error is
//            swallowed with no event at all.
//
// The event shape mirrors the orchestrator's existing precedent for knowledge
// retrieval ({ level: "warn", event: "knowledge_retrieval_failed", ... } via a
// JSON log line). Only `level` and `event` are pinned; whether the event may
// carry the raw error text is an open decision and is NOT asserted here.
//
// `minSimilarity` is the recall-request field the Step 3 contract adds (M2). It
// does not exist on MemoryRecallRequest yet, so it is read through a cast.
import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  AICompletionRequest,
  AICompletionResponse,
  AuditLogger,
  EmbeddingRequest,
  EmbeddingResponse,
  IAIProvider,
  IEmbeddingProvider,
  IMemoryStore,
  IToolExecutor,
  JarvisRequest,
  MemoryListRequest,
  MemoryListResult,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  SessionContext,
  ToolExecutionResult,
} from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";

// ---------------------------------------------------------------------------
// Deterministic stand-ins
// ---------------------------------------------------------------------------

const QUERY_VECTOR = [1, 0, 0, 0];

class CapturingModel implements IAIProvider {
  readonly id = "s7-capturing-model";
  readonly name = "S7 capturing model";
  readonly defaultModel = "s7-capture";
  readonly requests: AICompletionRequest[] = [];
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    return { message: { role: "assistant", content: "ok" }, finishReason: "stop", model: this.defaultModel };
  }
  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  /** Everything the model was shown, as one string. */
  seenText(): string {
    return this.requests.map((r) => JSON.stringify(r.messages)).join("\n");
  }
}

class FixedEmbedding implements IEmbeddingProvider {
  readonly id = "s7-fixed-embedding";
  readonly name = "S7 fixed embedding";
  readonly dimensions = QUERY_VECTOR.length;
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map(() => [...QUERY_VECTOR]), model: "s7-fixed" };
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date();
  return {
    id: "mem-s7-fallback",
    userId: "user-s7",
    type: "PREFERENCE",
    content: "User prefers S7 fallback reports as a short PDF.",
    importance: 0.8,
    confidence: 1,
    accessCount: 0,
    metadata: { embedding: [...QUERY_VECTOR] },
    sourceType: "conversation",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

/** A store whose recall() and list() are scripted; every other method is inert. */
class ScriptedStore implements IMemoryStore {
  readonly id = "s7-scripted-store";
  readonly name = "S7 scripted store";
  readonly recallRequests: MemoryRecallRequest[] = [];
  listCalls = 0;
  constructor(
    private readonly onRecall: (request: MemoryRecallRequest) => Promise<MemoryRecallResult[]>,
    private readonly listed: MemoryRecord[] = []
  ) {}
  async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult[]> {
    this.recallRequests.push(request);
    return this.onRecall(request);
  }
  async list(_request: MemoryListRequest): Promise<MemoryListResult> {
    this.listCalls++;
    return { memories: this.listed, total: this.listed.length, hasMore: false };
  }
  async store(): Promise<MemoryRecord[]> {
    return [];
  }
  async getById(): Promise<MemoryRecord | null> {
    return null;
  }
  async delete(): Promise<number> {
    return 0;
  }
  async deleteAll(): Promise<number> {
    return 0;
  }
  async update(): Promise<MemoryRecord> {
    throw new Error("not used");
  }
  async findSimilar(): Promise<MemoryRecord[]> {
    return [];
  }
  async count(): Promise<number> {
    return this.listed.length;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const noopExecutor: IToolExecutor = {
  async execute(): Promise<ToolExecutionResult> {
    // Never reached: the capturing model requests no tools.
    return { executionId: "s7", toolId: "noop", status: "completed", result: { success: true }, startedAt: new Date() };
  },
};

const audit: AuditLogger = {
  async log() {},
};

function build(store: IMemoryStore, relevanceThreshold: number) {
  const model = new CapturingModel();
  const registry = new AgentRegistry();
  registry.register(new ConversationalAssistant({ provider: model, systemPrompt: "You are JARVIS." }));
  const orchestrator = new Orchestrator(registry, noopExecutor, audit, {
    memoryStore: store,
    embeddingProvider: new FixedEmbedding(),
    memory: { relevanceThreshold, maxMemories: 5, contextBudgetChars: 2000, extractionEnabled: false },
  });
  return { orchestrator, model };
}

const request = (message: string): JarvisRequest => ({ message, stream: false });
const context = (): SessionContext => ({
  auth: { userId: "user-s7", role: "member", email: "user-s7@test.local" },
  traceId: "00000000-0000-0000-0000-0000000000s7",
});

/** Every JSON object logged through console.log / warn / error during the test. */
function structuredEvents(spies: Array<ReturnType<typeof vi.spyOn>>): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        if (typeof arg !== "string") continue;
        try {
          const parsed = JSON.parse(arg);
          if (parsed && typeof parsed === "object") events.push(parsed as Record<string, unknown>);
        } catch {
          // not a structured line
        }
      }
    }
  }
  return events;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Part 2 — threshold contract
// ---------------------------------------------------------------------------

describe("S7 memory recall contract — orchestrator threshold", () => {
  it("passes the relevance threshold to recall as minimum similarity, not minimum importance", async () => {
    const THRESHOLD = 0.37; // distinctive, so it cannot be confused with a default
    const store = new ScriptedStore(async () => []);
    const { orchestrator } = build(store, THRESHOLD);

    await orchestrator.process(request("What format do I want for S7 reports?"), context());

    expect(store.recallRequests).toHaveLength(1);
    const sent = store.recallRequests[0]! as MemoryRecallRequest & { minSimilarity?: number };
    expect(sent.minSimilarity, "the threshold is a similarity floor").toBe(THRESHOLD);
    expect(sent.minImportance, "the threshold is not an importance floor").not.toBe(THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// Part 8 — recall failure: fallback + diagnostic event
// ---------------------------------------------------------------------------

describe("S7 memory recall contract — vector recall failure", () => {
  it("vector recall failure falls back and emits a structured diagnostic event", async () => {
    const SECRET = "s7-db-password-DO-NOT-LEAK";
    const RAW_ERROR = `Raw query failed: connection postgresql://jarvis:${SECRET}@db:5432/jarvis — Failed to deserialize column of type 'vector'`;
    const store = new ScriptedStore(
      async () => {
        throw new Error(RAW_ERROR);
      },
      [memoryRecord()]
    );
    const { orchestrator, model } = build(store, 0.3);
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];

    const response = await orchestrator.process(request("What format do I want for S7 reports?"), context());

    // The fallback still runs and still supplies the relevant memory.
    expect(response.success).toBe(true);
    expect(store.listCalls, "the fallback list ran").toBeGreaterThanOrEqual(1);
    expect(model.seenText()).toContain("User prefers S7 fallback reports as a short PDF.");

    // A structured diagnostic event is emitted.
    const events = structuredEvents(spies);
    const recallFailure = events.find((e) => e.event === "memory_recall_failed");
    expect(recallFailure, "a memory_recall_failed event is logged").toBeDefined();
    expect(recallFailure!.level).toBe("warn");

    // Nothing of the raw database error reaches user-facing content.
    const userFacing = `${model.seenText()}\n${JSON.stringify(response)}`;
    expect(userFacing).not.toContain(SECRET);
    expect(userFacing).not.toContain("Failed to deserialize");
    expect(userFacing).not.toContain("postgresql://");
  });
});
