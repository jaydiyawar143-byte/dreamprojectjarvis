// S7.2 L5 — which memories a reply was built on.
//
// "That's wrong" needs a target that is not a guess. The orchestrator now
// returns the ids of the memories it actually put in front of the model (after
// the context budget), as `recalledMemoryIds` in the reply metadata; the chat
// route stores that metadata on the assistant message. Recall itself — what is
// retrieved, how it is ranked, what the model sees — is unchanged: the ids
// never enter the prompt.
import { describe, it, expect } from "vitest";
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
  MemoryRecallResult,
  MemoryRecord,
  ToolExecutionResult,
} from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";

class CapturingModel implements IAIProvider {
  readonly id = "l5-model";
  readonly name = "L5 model";
  readonly defaultModel = "l5";
  readonly requests: AICompletionRequest[] = [];
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    return { message: { role: "assistant", content: "ok" }, finishReason: "stop", model: this.defaultModel };
  }
  async listModels() {
    return [this.defaultModel];
  }
  async isAvailable() {
    return true;
  }
}

const embeddings: IEmbeddingProvider = {
  id: "l5-embeddings",
  name: "L5 embeddings",
  dimensions: 2,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map(() => [1, 0]), model: "l5" };
  },
  async isAvailable() {
    return true;
  },
};

function recalled(id: string, content: string): MemoryRecallResult {
  const now = new Date();
  const memory: MemoryRecord = { id, userId: "user-1", type: "PREFERENCE", content, importance: 0.8, confidence: 0.7, accessCount: 0, createdAt: now, updatedAt: now };
  return { memory, semanticScore: 0.9, recencyScore: 0.5, finalScore: 0.8 };
}

function store(results: MemoryRecallResult[]): IMemoryStore {
  return {
    id: "l5-store",
    name: "L5 store",
    recall: async () => results,
    list: async () => ({ memories: [], total: 0, hasMore: false }),
    store: async () => [],
    getById: async () => null,
    delete: async () => 0,
    deleteAll: async () => 0,
    update: async () => {
      throw new Error("not used");
    },
    findSimilar: async () => [],
    count: async () => results.length,
    isAvailable: async () => true,
  };
}

const executor: IToolExecutor = {
  async execute(): Promise<ToolExecutionResult> {
    return { executionId: "x", toolId: "noop", status: "completed", result: { success: true }, startedAt: new Date() };
  },
};
const audit: AuditLogger = { async log() {} };

async function turn(memoryStore: IMemoryStore | undefined, contextBudgetChars = 2000) {
  const model = new CapturingModel();
  const registry = new AgentRegistry();
  registry.register(new ConversationalAssistant({ provider: model, systemPrompt: "You are JARVIS." }));
  const orchestrator = new Orchestrator(registry, executor, audit, {
    ...(memoryStore ? { memoryStore, embeddingProvider: embeddings } : {}),
    memory: { relevanceThreshold: 0.1, maxMemories: 5, contextBudgetChars, extractionEnabled: false },
  });
  const response = await orchestrator.process(
    { message: "What caption length should I use?", stream: false },
    { auth: { userId: "user-1", role: "member", email: "u@test.local" }, traceId: "trace-l5" }
  );
  return { response, model };
}

describe("L5 — the reply names the memories it was built on", () => {
  it("records the ids of the memories put in front of the model, in order", async () => {
    const { response } = await turn(store([recalled("mem-a", "User prefers short captions"), recalled("mem-b", "User works late")]));
    expect(response.success).toBe(true);
    expect(response.data?.metadata).toMatchObject({ recalledMemoryIds: ["mem-a", "mem-b"] });
  });

  it("only the ones that fit the context budget — never one the model did not see", async () => {
    const { response } = await turn(store([recalled("mem-a", "User prefers short captions"), recalled("mem-b", "x".repeat(500))]), 60);
    expect(response.data?.metadata?.recalledMemoryIds).toEqual(["mem-a"]);
  });

  it("no memory recalled, no key", async () => {
    const { response } = await turn(store([]));
    expect(response.data?.metadata ?? {}).not.toHaveProperty("recalledMemoryIds");
  });

  it("no memory store, no key", async () => {
    const { response } = await turn(undefined);
    expect(response.data?.metadata ?? {}).not.toHaveProperty("recalledMemoryIds");
  });

  it("the ids never reach the model: the prompt is as before", async () => {
    const { model } = await turn(store([recalled("mem-a", "User prefers short captions")]));
    const seen = JSON.stringify(model.requests.map((r) => r.messages));
    expect(seen).toContain("[PREFERENCE] User prefers short captions");
    expect(seen).not.toContain("mem-a");
  });
});
