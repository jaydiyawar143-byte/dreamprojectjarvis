// ---------------------------------------------------------------------------
// Audit F1 (Phase 14) — the user's memory controls fail closed for LEARNING
// and RECALL alike, through the real services, wired the way the container
// wires them:
//
//   orchestrator recall   memoryControl.get   → MemoryManagementService.recallControl
//   memory writer         learningControl.get → MemoryManagementService.learningControl
//
// (`packages/memory/test/memory-architecture-p14.test.ts` pins that the
// container uses exactly these two.)
//
//   absent controls      learning on,     recall on
//   a valid pause        learning paused, recall on — vetoes still applied
//   corrupt controls     learning off,    recall off — no memory, vetoed or not
//   unreadable store     learning off,    recall off
//
// The audit found that corrupt controls read as an ordinary pause: learning
// stopped, but recall went on with every veto gone.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type {
  AgentContext,
  AgentInput,
  AgentOutput,
  AuditLogger,
  EmbeddingRequest,
  EmbeddingResponse,
  IAgent,
  IAIProvider,
  IEmbeddingProvider,
  IMemoryStore,
  IToolExecutor,
  MemoryRecallResult,
  MemoryRecord,
  ToolExecutionResult,
} from "@jarvis/core";
import { AgentRegistry, Orchestrator } from "@jarvis/agents";
import { MemoryExtractionService, MemoryManagementService, type MemoryControlStore } from "@jarvis/memory";

const T0 = new Date("2026-10-01T10:00:00.000Z");

function memory(id: string, content: string, sourceMessageId: string): MemoryRecord {
  return { id, userId: "user-1", type: "PREFERENCE", content, importance: 0.5, confidence: 0.7, accessCount: 0, sourceType: "USER", sourceMessageId, createdAt: T0, updatedAt: T0 };
}

const recalled = (m: MemoryRecord): MemoryRecallResult => ({ memory: m, semanticScore: 0.9, recencyScore: 1, finalScore: 0.9 });

/** One store for both sides: recall reads two memories; learning must never write. */
function memoryStore() {
  const writes: string[] = [];
  const rows = [memory("kept", "I prefer short captions", "msg-ok"), memory("vetoed", "I am allergic to peanuts", "msg-vetoed")];
  const store = {
    id: "fake",
    name: "fake",
    isAvailable: async () => true,
    recall: async () => rows.map(recalled),
    list: async () => ({ memories: [] as MemoryRecord[], total: 0, hasMore: false }),
    findSimilar: async () => [],
    getById: async () => null,
    count: async () => 0,
    store: async () => {
      writes.push("store");
      return [];
    },
    update: async () => {
      writes.push("update");
      return rows[0]!;
    },
    delete: async () => {
      writes.push("delete");
      return 0;
    },
    deleteAll: async () => {
      writes.push("deleteAll");
      return 0;
    },
  } as unknown as IMemoryStore;
  return { store, writes };
}

const embeddings: IEmbeddingProvider = {
  id: "fake",
  name: "fake",
  dimensions: 3,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map(() => [1, 0, 0]), model: "fake" };
  },
  isAvailable: async () => true,
};

function model() {
  const calls: number[] = [];
  const provider: IAIProvider = {
    id: "fake-model",
    name: "fake model",
    defaultModel: "fake",
    async complete() {
      calls.push(1);
      return { message: { role: "assistant", content: JSON.stringify({ candidates: [] }) }, finishReason: "stop", model: "fake" } as never;
    },
    listModels: async () => ["fake"],
    isAvailable: async () => true,
  };
  return { provider, calls };
}

class RecordingAgent implements IAgent {
  id = "general-assistant";
  name = "Recording agent";
  description = "records the turn context";
  category = "ai-core" as const;
  tools: string[] = [];
  config = {} as IAgent["config"];
  inputs: AgentInput[] = [];
  private status: "idle" | "ready" = "idle";
  async initialize(_context: AgentContext) {
    this.status = "ready";
  }
  async process(input: AgentInput): Promise<AgentOutput> {
    this.inputs.push(input);
    return { message: "ok" };
  }
  async shutdown() {}
  getStatus() {
    return this.status;
  }
}

const executor: IToolExecutor = {
  async execute(): Promise<ToolExecutionResult> {
    return { executionId: "x", toolId: "noop", status: "completed", result: { success: true }, startedAt: new Date() };
  },
};
const audit: AuditLogger = { async log() {} };

/** The container's wiring, around one user's stored controls. */
async function turn(control: MemoryControlStore) {
  const { store, writes } = memoryStore();
  const management = new MemoryManagementService({ store, control, audit: { log: async () => undefined } });
  const ai = model();
  const writer = new MemoryExtractionService({
    aiProvider: ai.provider,
    store,
    embeddingProvider: embeddings,
    learningControl: { get: (userId) => management.learningControl(userId) },
  });

  const agent = new RecordingAgent();
  const registry = new AgentRegistry();
  registry.register(agent);
  const orchestrator = new Orchestrator(registry, executor, audit, {
    memoryStore: store,
    embeddingProvider: embeddings,
    memoryControl: { get: (userId: string) => management.recallControl(userId) },
    memory: { relevanceThreshold: 0.1, maxMemories: 5, contextBudgetChars: 2000, extractionEnabled: false },
  });
  const response = await orchestrator.process(
    { message: "What caption length should I use?", stream: false },
    { auth: { userId: "user-1", role: "member", email: "u@test.local" }, traceId: "00000000-0000-4000-8000-0000000000f1", conversationId: "conv-1", userMessageId: "msg-now" }
  );
  const context = String(agent.inputs[0]?.turnContext ?? "");
  const recalledIds = (response.data?.metadata as Record<string, unknown> | undefined)?.recalledMemoryIds;

  // Learning from a durable statement in a later turn, as the orchestrator would hand it over.
  await writer.extract({
    userId: "user-1",
    conversationId: "conv-1",
    messages: [
      { role: "user", content: "I prefer short captions for Instagram posts", messageId: "msg-new", traceId: "00000000-0000-4000-8000-0000000000f2" },
      { role: "assistant", content: "Noted." },
    ],
  });

  return { response, context, recalledIds, modelCalls: ai.calls.length, writes };
}

const stored = (doc: Record<string, unknown> | null): MemoryControlStore => ({ get: async () => doc, put: async () => undefined });

describe("Audit F1 — the controls fail closed for learning and recall alike", () => {
  it("1. a valid pause: learning is paused, recall goes on — and a veto still keeps its memory out", async () => {
    const result = await turn(stored({ v: 1, learningPaused: true, vetoedSourceMessageIds: ["msg-vetoed"] }));

    expect(result.context).toContain("I prefer short captions");
    expect(result.context).not.toContain("peanuts");
    expect(result.recalledIds).toEqual(["kept"]);
    expect(result.modelCalls).toBe(0);
    expect(result.writes).toEqual([]);
  });

  it.each([
    ["text that was not JSON (the store hands back {})", {}],
    ["a pause that is not a boolean", { v: 1, learningPaused: "yes", vetoedSourceMessageIds: ["msg-vetoed"] }],
    ["a valid-looking document of an unknown version", { v: 2, learningPaused: false, vetoedSourceMessageIds: [] }],
  ])("2. corrupt controls (%s): nothing is learned and NOTHING is recalled", async (_label, doc) => {
    const result = await turn(stored(doc));

    expect(result.response.success).toBe(true);
    expect(result.context).not.toContain("<user_memories>");
    expect(result.context).not.toContain("I prefer short captions");
    expect(result.recalledIds).toBeUndefined();
    expect(result.modelCalls).toBe(0);
    expect(result.writes).toEqual([]);
  });

  it("3. a controls store that cannot be read: nothing is learned and nothing is recalled", async () => {
    const result = await turn({
      get: async () => {
        throw new Error("settings table unreachable");
      },
      put: async () => undefined,
    });

    expect(result.response.success).toBe(true);
    expect(result.context).not.toContain("<user_memories>");
    expect(result.recalledIds).toBeUndefined();
    expect(result.modelCalls).toBe(0);
    expect(result.writes).toEqual([]);
  });

  it("3b. no controls stored yet: the defaults — learning on, recall on (the existing contract)", async () => {
    const result = await turn(stored(null));

    expect(result.context).toContain("I prefer short captions");
    expect(result.recalledIds).toEqual(["kept", "vetoed"]);
    expect(result.modelCalls).toBe(1);
  });

  it("4. a vetoed memory never enters the context when the controls cannot be trusted — even though the veto list itself is unreadable", async () => {
    for (const doc of [{}, { v: 1, learningPaused: false, vetoedSourceMessageIds: ["msg-vetoed", ""] }]) {
      const result = await turn(stored(doc));
      expect(result.context).not.toContain("peanuts");
      expect(result.recalledIds).toBeUndefined();
    }
  });
});
