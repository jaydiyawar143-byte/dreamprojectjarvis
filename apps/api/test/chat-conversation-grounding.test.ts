// ---------------------------------------------------------------------------
// P0 — conversation context grounding, through the chat route.
//
// The reported failures (TC-034, TC-035): asked about the conversation it was
// in, JARVIS said it could not see it. The history WAS being sent. What was
// wrong was the shape of the request and where some turns were sent:
//
//   - server-made context was glued onto the user's message, so the model
//     could not tell the user's words from the system's;
//   - nothing told the model the earlier messages are a transcript it may read;
//   - an instruction about the conversation ("Summarize our conversation so
//     far.") was taken for work and handed to the Task Planner, which is given
//     one sentence and no history.
//
// Every test here drives the real route with a real Orchestrator, the real
// ConversationalAssistant and the real task services. The only doubles are the
// two models, the stores and the three sources of server context — which are
// all switched ON, so "no server block inside a user message" is tested
// against a turn that really has all three to misplace.
//
// For each of A–J the same four things are checked:
//
//   1. the model is sent the right history — every stored message, in order
//   2. the user's message arrives exactly as typed, last
//   3. no server block sits inside ANY user message
//   4. no task is created and the planner is never consulted
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import type {
  AICompletionRequest,
  AICompletionResponse,
  AIMessage,
  AuditLogger,
  Conversation,
  ConversationMessage,
  ConversationStorePort,
  IAIProvider,
  IApprovalManager,
  IEmbeddingProvider,
  IKnowledgeRetriever,
  IMemoryStore,
  MemoryRecallResult,
  RetrievedChunk,
  SkillContext,
  TaskStatus,
  ToolResult,
} from "@jarvis/core";
import {
  AgentRegistry,
  ConversationalAssistant,
  FIRST_MESSAGE_NOTE,
  Orchestrator,
  TRANSCRIPT_GROUNDING,
  TURN_CONTEXT_HEADER,
} from "@jarvis/agents";
import { BaseTool, ToolExecutor, ToolRegistry } from "@jarvis/tools";
import type { TaskRecord } from "@jarvis/db";
import { createChatRouter, type ChatRouterDeps } from "../src/routes/chat.js";
import { TaskService } from "../src/services/tasks/task-service.js";
import { TaskPlannerService } from "../src/services/tasks/task-planner-service.js";
import { TaskExecutionService } from "../src/services/tasks/task-execution-service.js";
import { TaskConversationService } from "../src/services/tasks/task-conversation-service.js";

const TC035 =
  "What was the exact message I sent immediately before this one? Do not use memory or external tools. If you cannot access the previous message, say so.";
const TC034 = "Analyze the current conversation and identify the latest test/action.";

/** What each of the three server-made blocks opens with. */
const SERVER_BLOCK_MARKERS = ["WHAT YOU CAN ACTUALLY DO RIGHT NOW", "<knowledge_base>", "<user_memories>"];

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A model that records what it was sent and answers from a script. */
class ScriptedModel implements IAIProvider {
  readonly id = "scripted";
  readonly name = "Scripted";
  readonly defaultModel = "scripted-model";
  readonly requests: AICompletionRequest[] = [];
  private queue: AICompletionResponse[] = [];

  constructor(private readonly fallback: (request: AICompletionRequest) => string) {}

  /** Queue a turn in which the model asks for one tool. */
  callsTool(name: string): this {
    this.queue.push({
      message: { role: "assistant", content: "", toolCalls: [{ id: "call-1", name, arguments: {} }] },
      finishReason: "tool_calls",
      model: this.defaultModel,
    });
    return this;
  }

  says(content: string): this {
    this.queue.push({ message: { role: "assistant", content }, finishReason: "stop", model: this.defaultModel });
    return this;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    return (
      this.queue.shift() ?? {
        message: { role: "assistant", content: this.fallback(request) },
        finishReason: "stop",
        model: this.defaultModel,
      }
    );
  }
  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function memoryConversationStore() {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ConversationMessage[]>();
  let seq = 0;

  const store: ConversationStorePort = {
    async create(input) {
      const id = `conv-${++seq}`;
      const conversation: Conversation = {
        id,
        title: input.title ?? null,
        userId: input.userId,
        agentId: input.agentId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      conversations.set(id, conversation);
      messages.set(id, []);
      return conversation;
    },
    async findByIdAndUserId(conversationId, userId) {
      const found = conversations.get(conversationId);
      return found && found.userId === userId ? found : null;
    },
    async getMessages(conversationId) {
      return [...(messages.get(conversationId) ?? [])];
    },
    async addMessage(input) {
      const message: ConversationMessage = {
        id: `msg-${++seq}`,
        role: input.role as ConversationMessage["role"],
        content: input.content,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        createdAt: new Date().toISOString(),
      };
      messages.get(input.conversationId)!.push(message);
      return message;
    },
  };

  return { store, of: (conversationId: string) => messages.get(conversationId) ?? [] };
}

function taskStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;
  return {
    rows,
    async create(userId: string, input: { title: string; description?: string | null; createdBy?: string | null }) {
      const now = new Date();
      const row: TaskRecord = {
        id: `task-${++seq}`, userId, title: input.title,
        description: input.description ?? null, dueAt: null, priority: "NORMAL",
        status: "PENDING", startedAt: null, completedAt: null, error: null,
        remindedAt: null, scheduledAt: null, claimedAt: null, executionId: null,
        createdBy: input.createdBy ?? null, createdAt: now, updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
    },
    async list(userId: string) {
      return [...rows.values()].filter((r) => r.userId === userId);
    },
    async listByStatus(userId: string, status: TaskStatus) {
      return [...rows.values()].filter((r) => r.userId === userId && r.status === status);
    },
    async findOwned(userId: string, taskId: string) {
      const row = rows.get(taskId);
      return row && row.userId === userId ? row : null;
    },
    async transitionOwned(
      userId: string, taskId: string, expectedFrom: TaskStatus, to: TaskStatus,
      options: { error?: string | null } = {}
    ) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) return { ok: false as const, reason: "not_found" as const, current: null };
      if (row.status !== expectedFrom) return { ok: false as const, reason: "state_changed" as const, current: row.status };
      row.status = to;
      if (to === "RUNNING") row.startedAt = new Date();
      if (to === "COMPLETED") { row.completedAt = new Date(); row.error = null; }
      if (to === "FAILED") row.error = options.error ?? null;
      return { ok: true as const, task: row };
    },
  };
}

class ReadTool extends BaseTool {
  public calls = 0;
  constructor(id: string) {
    super(id, id, `Read ${id}.`, "system", [], false, ["read"], "READ_ONLY");
  }
  async execute(): Promise<ToolResult> {
    this.calls += 1;
    return this.success({ ok: true });
  }
}

const SKILL: SkillContext = {
  id: "monitoring",
  title: "System monitoring",
  summary: "Keep an eye on the machine JARVIS runs on.",
  availability: "EXECUTABLE",
  toolIds: ["system.status"],
  blockedBy: [],
};

const CHUNK: RetrievedChunk = {
  chunkId: "chunk-1",
  documentId: "doc-1",
  documentTitle: "Handbook.pdf",
  documentType: "POLICY",
  source: "upload",
  chunkIndex: 0,
  content: "Refunds are issued within fourteen days of purchase.",
  score: 0.82,
  distance: 0.18,
  pageNumbers: [2],
  sections: [],
  metadata: null,
};

const RECALLED = {
  memory: { id: "mem-1", userId: "user-1", type: "PREFERENCE", content: "User prefers concise answers" },
  semanticScore: 0.9,
  recencyScore: 0.9,
  finalScore: 0.9,
} as unknown as MemoryRecallResult;

const tokenService = {
  verifyAccessToken: (token: string) =>
    token === "token-user-1" ? { userId: "user-1", role: "owner", email: "user-1@test.local" } : null,
} as unknown as ChatRouterDeps["tokenService"];

const PLAN_NOTHING = JSON.stringify({ executable: false, reason: "No listed tool does that." });
const PLAN_STATUS = JSON.stringify({
  executable: true,
  toolId: "system.status",
  params: {},
  reason: "Reading the system status answers this.",
});

/**
 * The route with everything real behind it.
 *
 * The assistant's model and the planner's model are SEPARATE doubles, so "was
 * this turn sent to the planner?" has a direct answer instead of an inference.
 */
function stack(options: { plan?: string } = {}) {
  const conversations = memoryConversationStore();
  const tasks = taskStore();

  // Each reply names the message it answers, so every assistant turn in a
  // transcript is distinct and a misplaced one is visible.
  const assistant = new ScriptedModel(
    (request) => `Answer to: ${request.messages.filter((m) => m.role === "user").at(-1)!.content}`
  );
  const planner = new ScriptedModel(() => options.plan ?? PLAN_NOTHING);

  const status = new ReadTool("system.status");
  const clock = new ReadTool("time.now");
  const tools = new ToolRegistry();
  tools.register(status);
  tools.register(clock);
  const allowedToolIds = new Set(["system.status"]);

  const executor = new ToolExecutor(
    tools,
    { hasPermission: () => true },
    {
      requestApproval: vi.fn().mockResolvedValue({ id: "approval-1", status: "pending" }),
      findApprovalsForTool: vi.fn().mockResolvedValue([]),
    } as unknown as IApprovalManager,
    { log: vi.fn() } as unknown as AuditLogger
  );

  const taskService = new TaskService({ tasks });
  const taskConversation = new TaskConversationService({
    tasks: taskService,
    planner: new TaskPlannerService({ provider: planner, registry: tools, allowedToolIds }),
    execution: new TaskExecutionService({ tasks: taskService, executor, allowedToolIds }),
  });

  const registry = new AgentRegistry({ requirePolicy: true });
  registry.register(new ConversationalAssistant({ provider: assistant, systemPrompt: "You are JARVIS." }));

  // All three sources of server context, on for every turn.
  const orchestrator = new Orchestrator(registry, executor, { log: async () => {} } as unknown as AuditLogger, {
    toolRegistry: tools,
    skillContext: { forAgent: async () => [SKILL] },
    knowledgeRetriever: { retrieve: async () => ({ results: [CHUNK] }) } as unknown as IKnowledgeRetriever,
    memoryStore: {
      isAvailable: async () => true,
      recall: async () => [RECALLED],
      list: async () => ({ memories: [], total: 0, hasMore: false }),
    } as unknown as IMemoryStore,
    embeddingProvider: { embed: async () => ({ embeddings: [[1, 0]] }) } as unknown as IEmbeddingProvider,
  });

  const chat = createChatRouter({
    tokenService,
    conversationRepo: conversations.store,
    orchestrator,
    executor,
    taskConversation,
    googleWrites: null,
  });

  return { chat, conversations, tasks, assistant, planner, status, clock };
}

type Stack = ReturnType<typeof stack>;
type ChatReply = { status: number; body: { success: boolean; data?: Record<string, unknown> } };

function post(s: Stack, body: Record<string, unknown>): Promise<ChatReply> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { authorization: "Bearer token-user-1" };
    const req = {
      method: "POST", path: "/", url: "/", headers, body, params: {}, query: {}, ip: "127.0.0.1",
      get: (name: string) => headers[name.toLowerCase()],
    } as never;
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        resolve({ status: this.statusCode, body: payload as never });
        return this;
      },
      setHeader() {
        return this;
      },
    };
    const layer = (
      s.chat as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => void }> } }>;
      }
    ).stack.find((l) => l.route?.path === "/" && l.route.methods.post);
    const handlers = layer!.route!.stack.map((h) => h.handle);
    let index = 0;
    const next = () => {
      if (index < handlers.length) handlers[index++]!(req, res, next);
    };
    next();
  });
}

/** Send each message in turn, in one conversation. Returns its id. */
async function converse(s: Stack, messages: string[]): Promise<string> {
  let conversationId: string | undefined;
  for (const message of messages) {
    const reply = await post(s, { message, ...(conversationId ? { conversationId } : {}) });
    expect(reply.status, message).toBe(200);
    conversationId = reply.body.data!.conversationId as string;
  }
  return conversationId!;
}

/**
 * Ask `question` and check the four things every case must hold.
 *
 * `earlier` is what the store held BEFORE the question — the transcript the
 * model has to be shown. It is read from the store rather than rebuilt by the
 * test, so a turn the route failed to save cannot hide.
 */
async function ask(s: Stack, question: string, conversationId?: string) {
  const earlier = conversationId
    ? s.conversations.of(conversationId).map((m) => [m.role, m.content])
    : [];

  const reply = await post(s, { message: question, ...(conversationId ? { conversationId } : {}) });
  expect(reply.status).toBe(200);

  const sent: AIMessage[] = s.assistant.requests.at(-1)!.messages;

  // The agent's prompt, carrying the transcript rules — and saying that this
  // is the first message when, and only when, nothing came before it.
  expect(sent[0]!.role).toBe("system");
  expect(sent[0]!.content).toContain("You are JARVIS.");
  expect(sent[0]!.content).toContain(TRANSCRIPT_GROUNDING);
  expect(String(sent[0]!.content).includes(FIRST_MESSAGE_NOTE)).toBe(earlier.length === 0);

  // 1. The history: everything stored before this turn, in order, verbatim.
  expect(sent.slice(1, 1 + earlier.length).map((m) => [m.role, m.content])).toEqual(earlier);

  // The server's context for this turn: one system message, all three blocks.
  const context = sent[1 + earlier.length]!;
  expect(context.role).toBe("system");
  expect(String(context.content).startsWith(TURN_CONTEXT_HEADER)).toBe(true);
  for (const marker of SERVER_BLOCK_MARKERS) expect(context.content).toContain(marker);

  // 2. Then the user's message — exact, and the last thing sent.
  expect(sent.slice(2 + earlier.length)).toEqual([{ role: "user", content: question }]);

  // 3. No server block inside any user message, this turn's or an earlier one.
  for (const message of sent.filter((m) => m.role === "user")) {
    for (const marker of [...SERVER_BLOCK_MARKERS, "CONTEXT FOR THIS TURN"]) {
      expect(String(message.content), `"${marker}" inside a user message`).not.toContain(marker);
    }
  }

  // 4. A turn about the conversation is not work.
  expect(s.planner.requests).toHaveLength(0);
  expect(s.tasks.rows.size).toBe(0);
  expect(reply.body.data).not.toHaveProperty("taskId");

  // And it was saved as typed, once.
  const stored = s.conversations.of(reply.body.data!.conversationId as string);
  expect(stored.filter((m) => m.role === "user" && m.content === question)).toHaveLength(1);

  return { reply, sent, earlier };
}

// ---------------------------------------------------------------------------
// A–J
// ---------------------------------------------------------------------------

describe("a question about the conversation is answered from the conversation", () => {
  it("A. the immediately previous user message is in front of the model", async () => {
    const s = stack();
    const conversationId = await converse(s, ["My marker word is TEAL-42."]);

    const { earlier } = await ask(s, "What was my previous message?", conversationId);

    expect(earlier).toEqual([
      ["user", "My marker word is TEAL-42."],
      ["assistant", "Answer to: My marker word is TEAL-42."],
    ]);
  });

  it("B. the previous assistant response is in front of the model", async () => {
    const s = stack();
    s.assistant.says("Your codename is FALCON-9.");
    const conversationId = await converse(s, ["Give me a codename."]);

    const { earlier } = await ask(s, "What did you just say?", conversationId);

    expect(earlier.at(-1)).toEqual(["assistant", "Your codename is FALCON-9."]);
  });

  it("C. a three-turn conversation arrives whole and in order", async () => {
    const s = stack();
    const turns = ["First: the sky is blue.", "Second: grass is green.", "Third: snow is white."];
    const conversationId = await converse(s, turns);

    const { earlier } = await ask(s, "What have I told you so far?", conversationId);

    expect(earlier).toHaveLength(6);
    expect(earlier.filter(([role]) => role === "user").map(([, content]) => content)).toEqual(turns);
  });

  it("D. a ten-turn conversation arrives whole and in order", async () => {
    const s = stack();
    const turns = Array.from({ length: 10 }, (_, i) => `Fact number ${i + 1} is F-${i + 1}.`);
    const conversationId = await converse(s, turns);

    const { earlier } = await ask(s, "What was fact number 3?", conversationId);

    expect(earlier).toHaveLength(20);
    expect(earlier.filter(([role]) => role === "user").map(([, content]) => content)).toEqual(turns);
    expect(earlier.map(([role]) => role)).toEqual(Array.from({ length: 20 }, (_, i) => (i % 2 ? "assistant" : "user")));
  });

  it("E. after a turn that ran a tool, the next turn still sees that turn", async () => {
    const s = stack();
    s.assistant.callsTool("time.now").says("It is noon.");
    const conversationId = await converse(s, ["What time is it?"]);
    expect(s.clock.calls).toBe(1);

    // The tool round itself was sent the user's own words and separate context.
    const afterTool = s.assistant.requests[1]!.messages;
    expect(afterTool.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "tool"]);
    expect(afterTool[2]).toEqual({ role: "user", content: "What time is it?" });

    const { earlier } = await ask(s, "What did you just do?", conversationId);

    expect(earlier).toEqual([
      ["user", "What time is it?"],
      ["assistant", "It is noon."],
    ]);
  });

  it("F. a new conversation is sent nothing from an old one", async () => {
    const s = stack();
    await converse(s, ["My secret word is ORCHID-77."]);

    const { sent, earlier } = await ask(s, "What was my previous message?");

    expect(earlier).toEqual([]);
    expect(sent.map((m) => m.role)).toEqual(["system", "system", "user"]);
    expect(JSON.stringify(sent)).not.toContain("ORCHID-77");
  });

  it('G. "Summarize our conversation so far." goes to the assistant, not the planner', async () => {
    const s = stack();
    const conversationId = await converse(s, ["We sell handmade soap.", "Our best seller is lavender."]);

    const { reply, earlier } = await ask(s, "Summarize our conversation so far.", conversationId);

    expect(earlier).toHaveLength(4);
    expect(reply.body.data!.message).toBe("Answer to: Summarize our conversation so far.");
  });

  it('H. "What was my second question?" has all the questions to count', async () => {
    const s = stack();
    const questions = ["What is SEO?", "What is a backlink?", "What is a sitemap?"];
    const conversationId = await converse(s, questions);

    const { earlier } = await ask(s, "What was my second question?", conversationId);

    expect(earlier.filter(([role]) => role === "user")[1]).toEqual(["user", "What is a backlink?"]);
  });

  it("I. TC-035, word for word", async () => {
    const s = stack();
    const conversationId = await converse(s, ["My marker word is TEAL-42."]);

    const { earlier } = await ask(s, TC035, conversationId);

    expect(earlier[0]).toEqual(["user", "My marker word is TEAL-42."]);
  });

  it("J. TC-034 — an instruction to analyse the conversation is not handed to the planner", async () => {
    const s = stack();
    const conversationId = await converse(s, ["What is SEO?", "What is a backlink?", "What is a sitemap?"]);

    const { reply, earlier } = await ask(s, TC034, conversationId);

    expect(earlier).toHaveLength(6);
    expect(reply.body.data!.message).toBe(`Answer to: ${TC034}`);
  });
});

// ---------------------------------------------------------------------------
// Nothing executable -> the assistant. Something executable -> still a task.
// ---------------------------------------------------------------------------

describe("the work path only keeps a turn it can actually do", () => {
  it("an instruction no tool can carry out is answered by the assistant, with the history", async () => {
    const s = stack({ plan: PLAN_NOTHING });
    const conversationId = await converse(s, ["My marker word is TEAL-42."]);
    const plannerCallsBefore = s.planner.requests.length;

    const reply = await post(s, { message: "Check the moon landing telemetry", conversationId });

    // The planner WAS asked — and said there is nothing to run.
    expect(s.planner.requests).toHaveLength(plannerCallsBefore + 1);
    // So no task was recorded, and nothing claims to have saved one.
    expect(s.tasks.rows.size).toBe(0);
    expect(reply.body.data).not.toHaveProperty("taskId");
    expect(reply.body.data!.message).toBe("Answer to: Check the moon landing telemetry");

    // The assistant answered it, seeing the conversation.
    const sent = s.assistant.requests.at(-1)!.messages;
    expect(sent.slice(1, 3).map((m) => [m.role, m.content])).toEqual([
      ["user", "My marker word is TEAL-42."],
      ["assistant", "Answer to: My marker word is TEAL-42."],
    ]);
    expect(sent.at(-1)).toEqual({ role: "user", content: "Check the moon landing telemetry" });

    // Saved once — the work branch and the assistant branch did not both save it.
    const stored = s.conversations.of(conversationId).slice(2);
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ["user", "Check the moon landing telemetry"],
      ["assistant", "Answer to: Check the moon landing telemetry"],
    ]);
  });

  it("an instruction a tool CAN carry out is still a task, run once, without the assistant", async () => {
    const s = stack({ plan: PLAN_STATUS });

    const reply = await post(s, { message: "Check my system status" });

    expect(reply.status).toBe(200);
    expect(s.status.calls).toBe(1);
    expect(s.assistant.requests).toHaveLength(0);

    const [task] = [...s.tasks.rows.values()];
    expect(s.tasks.rows.size).toBe(1);
    expect(task!.status).toBe("COMPLETED");
    expect(reply.body.data).toMatchObject({ taskId: task!.id, plan: { executable: true, toolId: "system.status" } });
    expect(reply.body.data!.message).toMatch(/^Done — I ran system\.status/);
  });

  it("a vague time is still answered with a question, and nothing is planned or run", async () => {
    const s = stack({ plan: PLAN_STATUS });

    const reply = await post(s, { message: "Check my system status later" });

    expect(reply.body.data!.message).toMatch(/need a specific time/);
    expect(s.planner.requests).toHaveLength(0);
    expect(s.assistant.requests).toHaveLength(0);
    expect(s.tasks.rows.size).toBe(0);
    expect(s.status.calls).toBe(0);
  });
});
