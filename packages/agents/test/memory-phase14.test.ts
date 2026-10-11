// Phase 14 — the agents layer.
//
//   CORRECTIONS   the detector recognises a correction that carries its new
//                 value, returns the value in the user's own words, and still
//                 treats everything else exactly as before.
//   THE BOUNDARY  an agent is handed no memory store, and the orchestrator
//                 holds a read-only one: recall, list, isAvailable.
//   RECALL        is scoped to the conversation's project, skips a memory
//                 learned from a message the user vetoed, recalls nothing when
//                 the controls cannot be read, and ranks its fallback with the
//                 same score as the vector path.
//   POLICY        the two new memory tools are on no agent's allowlist.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type {
  AgentContext,
  AgentInput,
  AgentOutput,
  AuditLogger,
  EmbeddingRequest,
  EmbeddingResponse,
  IAgent,
  IEmbeddingProvider,
  IToolExecutor,
  MemoryLearningControl,
  MemoryListRequest,
  MemoryRecallPort,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  ToolExecutionResult,
} from "@jarvis/core";
import { MEMORY_CORRECT_TOOL_ID, MEMORY_PURGE_TOOL_ID, MEMORY_SIMILARITY_FLOOR } from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { detectMemoryCommand } from "../src/memory-command-detector.js";
import { AGENT_POLICIES } from "../src/agent-policy.js";

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

describe("Phase 14 — a correction that carries its new value", () => {
  it.each([
    ["That's wrong. I prefer light mode.", "I prefer light mode."],
    ["that's wrong, I prefer light mode", "I prefer light mode"],
    ["No, that's wrong — I prefer light mode", "I prefer light mode"],
    ["That is incorrect. My name is Asha", "My name is Asha"],
    ["That's no longer true: I work in Pune", "I work in Pune"],
    ["It's outdated. I prefer Monthly Reports", "I prefer Monthly Reports"],
    ["Hey Jarvis, that's wrong. I prefer light mode", "I prefer light mode"],
    ["ye galat hai, mujhe short captions pasand hain", "mujhe short captions pasand hain"],
    ["change that to I prefer light mode", "I prefer light mode"],
    ["Please change it to: I prefer light mode", "I prefer light mode"],
    ["correct this memory to I always review ad copy", "I always review ad copy"],
    ["replace that with I prefer light mode", "I prefer light mode"],
  ])("%j → the last reply's memory, with the user's own words", (text, statement) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "CORRECT", target: { kind: "LAST_REPLY" }, statement });
  });

  it.each([
    ["change 2 to I prefer light mode", 2, "I prefer light mode"],
    ["Correct memory 3 to My name is Asha", 3, "My name is Asha"],
    ["update #1 with I prefer short captions", 1, "I prefer short captions"],
    ["replace number 12 with I work in Pune", 12, "I work in Pune"],
  ])("%j → a numbered memory from the list shown", (text, position, statement) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "CORRECT", target: { kind: "SELECTION", positions: [position] }, statement });
  });

  it("keeps the user's own casing and punctuation: nothing is rewritten", () => {
    const command = detectMemoryCommand("That's wrong.   I prefer  LIGHT mode, Always!");
    expect(command).toMatchObject({ kind: "CORRECT", statement: "I prefer LIGHT mode, Always!" });
  });

  it("'that's wrong' on its own is unchanged: no statement, the last reply's memory", () => {
    for (const text of ["that's wrong", "That is wrong.", "No, that's wrong", "ye galat hai"]) {
      expect(detectMemoryCommand(text)).toEqual({ kind: "CORRECT", target: { kind: "LAST_REPLY" } });
    }
  });

  it.each([
    // The marker does not END before the rest: this is about the answer, not a memory.
    "that's wrong about the capital, it's Paris",
    "that's wrong for this campaign",
    "change the caption to something shorter",
    "change my mind about this",
    "update the report",
    "replace the image",
    "correct the spelling in the draft",
    "change 2 campaigns to paused",
    "that was wrong of me",
    "",
  ])("%j is not a correction", (text) => {
    expect(detectMemoryCommand(text).kind).not.toBe("CORRECT");
  });

  it("a stated new preference is still REPLACE — learned normally, never a targeted correction", () => {
    expect(detectMemoryCommand("change my preference to professional tone")).toEqual({ kind: "REPLACE" });
    expect(detectMemoryCommand("update my default design style to minimal")).toEqual({ kind: "REPLACE" });
  });

  it("position 0 is no position", () => {
    expect(detectMemoryCommand("change 0 to I prefer light mode").kind).not.toBe("CORRECT");
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const embeddings: IEmbeddingProvider = {
  id: "p14-embeddings",
  name: "P14 embeddings",
  dimensions: 2,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map(() => [1, 0]), model: "p14" };
  },
  async isAvailable() {
    return true;
  },
};

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function memory(id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    userId: "user-1",
    type: "PREFERENCE",
    content,
    importance: 0.5,
    confidence: 0.7,
    accessCount: 0,
    sourceType: "USER",
    metadata: { embedding: [1, 0], evidence: { v: 1, count: 1, conversations: 1, firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), sources: [], revisions: 0, previousSourceMessageIds: [] } },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const recalled = (record: MemoryRecord): MemoryRecallResult => ({ memory: record, semanticScore: 0.9, recencyScore: 1, finalScore: 0.9 });

/** A read-only memory port that records what it is asked. */
function port(options: { recall?: MemoryRecallResult[] | Error; list?: MemoryRecord[] } = {}) {
  const asked = { recall: [] as MemoryRecallRequest[], list: [] as MemoryListRequest[] };
  const memoryStore: MemoryRecallPort = {
    isAvailable: async () => true,
    async recall(request) {
      asked.recall.push(request);
      if (options.recall instanceof Error) throw options.recall;
      return options.recall ?? [];
    },
    async list(request) {
      asked.list.push(request);
      const memories = options.list ?? [];
      return { memories, total: memories.length, hasMore: false };
    },
  };
  return { memoryStore, asked };
}

/** An agent that records the context it is given and what reaches it as turn context. */
class RecordingAgent implements IAgent {
  id = "general-assistant";
  name = "Recording agent";
  description = "records what it is given";
  category = "ai-core" as const;
  tools: string[] = [];
  config = {} as IAgent["config"];
  /** Every context the orchestrator hands this agent. `process` is given none. */
  contexts: AgentContext[] = [];
  inputs: AgentInput[] = [];
  private status: "idle" | "ready" = "idle";
  async initialize(context: AgentContext) {
    this.contexts.push(context);
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

async function turn(
  memoryStore: MemoryRecallPort,
  options: { projectId?: string; control?: { get(userId: string): Promise<MemoryLearningControl> }; extractor?: { extract: (request: unknown) => Promise<unknown>; isAvailable: () => Promise<boolean> } } = {}
) {
  const agent = new RecordingAgent();
  const registry = new AgentRegistry();
  registry.register(agent);
  const orchestrator = new Orchestrator(registry, executor, audit, {
    memoryStore,
    embeddingProvider: embeddings,
    ...(options.control ? { memoryControl: options.control } : {}),
    ...(options.extractor ? { memoryExtractor: options.extractor as never } : {}),
    memory: { relevanceThreshold: 0.1, maxMemories: 5, contextBudgetChars: 2000, extractionEnabled: options.extractor !== undefined },
  });
  const response = await orchestrator.process(
    { message: "What caption length should I use?", stream: false },
    { auth: { userId: "user-1", role: "member", email: "u@test.local" }, traceId: "00000000-0000-4000-8000-000000000014", conversationId: "conv-1", userMessageId: "msg-1", ...(options.projectId ? { projectId: options.projectId } : {}) }
  );
  const context = String(agent.inputs[0]?.turnContext ?? "");
  return { response, agent, context };
}

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe("Phase 14 — an agent is handed no memory store", () => {
  it("the context an agent receives has no memory object of any kind", async () => {
    const { memoryStore } = port({ recall: [recalled(memory("m1", "I prefer short captions"))] });
    const { agent } = await turn(memoryStore);

    expect(agent.contexts.length).toBeGreaterThanOrEqual(1);
    for (const context of agent.contexts) {
      expect(Object.keys(context).sort()).toEqual(["auditLogger", "conversationId", "toolRegistry", "traceId", "userId"]);
      for (const value of Object.values(context)) {
        for (const method of ["store", "update", "delete", "deleteAll", "recall", "findSimilar"]) {
          expect(typeof (value as Record<string, unknown> | undefined)?.[method], method).not.toBe("function");
        }
      }
    }
  });

  it("recall still reaches the agent — as turn context, not as a store", async () => {
    const { memoryStore } = port({ recall: [recalled(memory("m1", "I prefer short captions"))] });
    const { context, response } = await turn(memoryStore);
    expect(context).toContain("[PREFERENCE] I prefer short captions");
    expect(response.data?.metadata).toMatchObject({ recalledMemoryIds: ["m1"] });
  });

  it("the orchestrator works with a memory port that cannot write at all", async () => {
    // Three methods. There is no store, update, delete or deleteAll to call.
    const { memoryStore } = port({ recall: [recalled(memory("m1", "I prefer short captions"))] });
    expect(Object.keys(memoryStore).sort()).toEqual(["isAvailable", "list", "recall"]);
    expect((await turn(memoryStore)).response.success).toBe(true);
  });

  it("the orchestrator's source names no memory write", () => {
    const source = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/memoryManager/);
    expect(code).not.toMatch(/memoryStore\s*\.\s*(?:store|update|delete|deleteAll|storeWithEmbedding)\b/);
    expect(code).not.toMatch(/createNoopMemoryStore/);
  });

  it("no agent source reaches for a memory store", () => {
    for (const file of ["../src/base-agent.ts", "../src/domain-agent.ts", "../src/agents/conversational-assistant.ts", "../src/agents/meta-ads-agent.ts", "../src/agents/knowledge-agent.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/memoryManager|IMemoryStore|memoryStore/);
    }
  });
});

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

describe("Phase 14 — recall is scoped to the conversation's project", () => {
  it("passes the session's project to the store", async () => {
    const { memoryStore, asked } = port({ recall: [recalled(memory("m1", "x"))] });
    await turn(memoryStore, { projectId: "proj-1" });
    expect(asked.recall[0]).toMatchObject({ userId: "user-1", projectId: "proj-1", limit: 5, minSimilarity: 0.1 });
  });

  it("with no project in the session, asks for personal memories only", async () => {
    const { memoryStore, asked } = port({ recall: [recalled(memory("m1", "x"))] });
    await turn(memoryStore);
    expect(asked.recall[0]!.projectId).toBeNull();
  });

  it("the fallback asks for the same scope, and drops a project's memory the store returned anyway", async () => {
    const { memoryStore, asked } = port({
      recall: new Error("vector recall is down"),
      list: [memory("personal", "I prefer short captions"), memory("mine", "project wording", { projectId: "proj-1" }), memory("other", "another project's wording", { projectId: "proj-2" })],
    });
    const { context } = await turn(memoryStore, { projectId: "proj-1" });

    expect(asked.list[0]).toMatchObject({ userId: "user-1", limit: 50, includeExpired: false, scope: { kind: "VISIBLE_IN", projectId: "proj-1" } });
    expect(context).toContain("I prefer short captions");
    expect(context).toContain("project wording");
    expect(context).not.toContain("another project's wording");
  });

  it("with no project, the fallback never uses a project's memory", async () => {
    const { memoryStore, asked } = port({ recall: new Error("down"), list: [memory("personal", "I prefer short captions"), memory("p", "project wording", { projectId: "proj-1" })] });
    const { context } = await turn(memoryStore);
    expect(asked.list[0]!.scope).toEqual({ kind: "VISIBLE_IN", projectId: null });
    expect(context).toContain("I prefer short captions");
    expect(context).not.toContain("project wording");
  });

  it("the fallback ranks with the same relevance score: equally similar, the recently confirmed one first", async () => {
    const stale = memory("a-stale", "I prefer weekly reports", {
      confidence: 0.55,
      metadata: { embedding: [1, 0], evidence: { v: 1, count: 1, conversations: 1, firstSeenAt: daysAgo(80).toISOString(), lastSeenAt: daysAgo(80).toISOString(), sources: [], revisions: 0, previousSourceMessageIds: [] } },
    });
    const fresh = memory("b-fresh", "I prefer monthly reports", { confidence: 0.9 });
    const { memoryStore } = port({ recall: new Error("down"), list: [stale, fresh] });

    const { response, context } = await turn(memoryStore);

    expect(response.data?.metadata).toMatchObject({ recalledMemoryIds: ["b-fresh", "a-stale"] });
    expect(context.indexOf("monthly")).toBeLessThan(context.indexOf("weekly"));
  });

  it("the default similarity floor is the one the real-embedding evaluation checks", async () => {
    expect(MEMORY_SIMILARITY_FLOOR).toBe(0.3);
    const agent = new RecordingAgent();
    const registry = new AgentRegistry();
    registry.register(agent);
    const { memoryStore, asked } = port({ recall: [recalled(memory("m1", "x"))] });
    await new Orchestrator(registry, executor, audit, { memoryStore, embeddingProvider: embeddings }).process(
      { message: "hello there", stream: false },
      { auth: { userId: "user-1", role: "member", email: "u@test.local" }, traceId: "00000000-0000-4000-8000-000000000015" }
    );
    expect(asked.recall[0]!.minSimilarity).toBe(MEMORY_SIMILARITY_FLOOR);
  });
});

describe("Phase 14 — recall respects the user's controls", () => {
  const controls = (control: MemoryLearningControl) => ({ get: async () => control });

  it("a memory learned from a vetoed message is not recalled", async () => {
    const { memoryStore } = port({
      recall: [recalled(memory("kept", "I prefer short captions", { sourceMessageId: "msg-ok" })), recalled(memory("vetoed", "I am allergic to peanuts", { sourceMessageId: "msg-vetoed" }))],
    });
    const { context, response } = await turn(memoryStore, { control: controls({ learningPaused: false, vetoedSourceMessageIds: ["msg-vetoed"] }) });

    expect(context).toContain("I prefer short captions");
    expect(context).not.toContain("peanuts");
    expect(response.data?.metadata).toMatchObject({ recalledMemoryIds: ["kept"] });
  });

  it("pausing learning does not stop recall: what is already remembered is still used", async () => {
    const { memoryStore } = port({ recall: [recalled(memory("m1", "I prefer short captions"))] });
    const { context } = await turn(memoryStore, { control: controls({ learningPaused: true, vetoedSourceMessageIds: [] }) });
    expect(context).toContain("I prefer short captions");
  });

  it("controls that cannot be read recall NOTHING, and the turn still answers", async () => {
    const { memoryStore } = port({ recall: [recalled(memory("m1", "I prefer short captions"))] });
    const { context, response } = await turn(memoryStore, {
      control: {
        get: async () => {
          throw new Error("settings table unreachable");
        },
      },
    });
    expect(response.success).toBe(true);
    expect(context).not.toContain("I prefer short captions");
    expect((response.data?.metadata as Record<string, unknown> | undefined)?.recalledMemoryIds).toBeUndefined();
  });

  it("without controls configured, recall is exactly as before", async () => {
    const { memoryStore } = port({ recall: [recalled(memory("m1", "I prefer short captions", { sourceMessageId: "msg-any" }))] });
    expect((await turn(memoryStore)).context).toContain("I prefer short captions");
  });
});

describe("Phase 14 — what a turn teaches belongs to its conversation's project", () => {
  it("extraction is given the session's project, and none for a personal conversation", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const extractor = { extract: async (request: unknown) => void seen.push(request as Record<string, unknown>), isAvailable: async () => true };

    await turn(port().memoryStore, { projectId: "proj-1", extractor });
    await turn(port().memoryStore, { extractor });
    await new Promise((resolve) => setTimeout(resolve, 20)); // extraction is fire-and-forget

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ userId: "user-1", conversationId: "conv-1", projectId: "proj-1" });
    expect("projectId" in seen[1]!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("Phase 14 — policy: no agent can correct or purge memory", () => {
  it.each([MEMORY_CORRECT_TOOL_ID, MEMORY_PURGE_TOOL_ID])("%s is on no agent's allowlist", (toolId) => {
    for (const policy of Object.values(AGENT_POLICIES)) {
      expect(policy.allowedTools, `${policy.agentId} -> ${toolId}`).not.toContain(toolId);
    }
  });

  it("no agent holds any memory tool except the read-only list", () => {
    for (const policy of Object.values(AGENT_POLICIES)) {
      const memoryTools = policy.allowedTools.filter((id) => id.startsWith("memory."));
      expect(memoryTools.every((id) => id === "memory.list"), `${policy.agentId}: ${memoryTools.join(", ")}`).toBe(true);
    }
  });
});
