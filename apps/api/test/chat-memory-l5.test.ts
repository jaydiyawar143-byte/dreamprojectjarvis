// S7.2 L5 — memory commands in the chat route.
//
// The branch sits after the pending-action branches (so "forget it" still
// cancels an action, and a memory confirmation is an ordinary CONFIRM/REJECT)
// and before the work and orchestrator paths (so a memory command never
// reaches the model and is never itself learned). Nothing in the branch
// deletes: a deletion is a pending action the user confirms, and only
// ToolExecutor runs it.
import { describe, it, expect } from "vitest";
import type {
  Approval,
  AuditEntry,
  Conversation,
  ConversationMessage,
  ConversationStorePort,
  IMemoryStore,
  IOrchestrator,
  IToolExecutor,
  JarvisRequest,
  JarvisResponse,
  MemoryDeleteRequest,
  MemoryListRequest,
  MemoryListResult,
  MemoryRecord,
  SessionContext,
  ToolExecutionRequest,
  ToolExecutionResult,
} from "@jarvis/core";
import { PendingActionService } from "@jarvis/agents";
import { MemoryManagementService } from "@jarvis/memory";
import { createChatRouter, type ChatRouterDeps } from "../src/routes/chat.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function conversationStore() {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ConversationMessage[]>();
  let seq = 0;
  const store: ConversationStorePort = {
    async create(input) {
      const id = `conv-${++seq}`;
      const now = new Date().toISOString();
      conversations.set(id, { id, title: null, userId: input.userId, agentId: null, createdAt: now, updatedAt: now });
      messages.set(id, []);
      return conversations.get(id)!;
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
  return { store, of: (id: string) => messages.get(id) ?? [] };
}

const T0 = new Date("2026-09-01T10:00:00.000Z");

function memory(id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    userId: "user-1",
    type: "PREFERENCE",
    content,
    importance: 0.7,
    confidence: 0.7,
    accessCount: 0,
    sourceType: "USER",
    sourceMessageId: "msg-old",
    metadata: { embedding: [0.1], evidence: { v: 1, count: 1, conversations: 1, firstSeenAt: T0.toISOString(), lastSeenAt: T0.toISOString(), sources: [], revisions: 0, previousSourceMessageIds: [] } },
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

class FakeMemoryStore implements IMemoryStore {
  readonly id = "fake";
  readonly name = "fake";
  deletes: MemoryDeleteRequest[] = [];
  constructor(public rows: MemoryRecord[]) {}
  async getById(userId: string, id: string) {
    return this.rows.find((r) => r.id === id && r.userId === userId) ?? null;
  }
  async list(request: MemoryListRequest): Promise<MemoryListResult> {
    const mine = this.rows.filter((r) => r.userId === request.userId);
    const page = mine.slice(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? 20));
    return { memories: page, total: mine.length, hasMore: page.length < mine.length };
  }
  async delete(request: MemoryDeleteRequest) {
    this.deletes.push(request);
    return 0;
  }
  async deleteAll() {
    this.deletes.push({ userId: "ALL" });
    return 0;
  }
  async store(): Promise<MemoryRecord[]> {
    return [];
  }
  async update(): Promise<MemoryRecord> {
    throw new Error("not used");
  }
  async recall() {
    return [];
  }
  async findSimilar() {
    return [];
  }
  async count() {
    return this.rows.length;
  }
  async isAvailable() {
    return true;
  }
}

function approvalRepo() {
  const rows = new Map<string, Approval>();
  let seq = 0;
  return {
    rows,
    async create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval> {
      const approval = { ...data, id: `ap-${++seq}`, status: "pending", createdAt: new Date().toISOString() } as Approval;
      rows.set(approval.id, approval);
      return approval;
    },
    async findById(id: string) {
      return rows.get(id) ?? null;
    },
    async updateStatus(id: string, status: string) {
      const approval = rows.get(id);
      if (!approval) return null;
      approval.status = status as Approval["status"];
      return approval;
    },
    async findPendingByConversationId(conversationId: string, userId: string) {
      return [...rows.values()].reverse().find((a) => a.conversationId === conversationId && a.userId === userId && a.status === "pending") ?? null;
    },
    async updateParams() {
      return null;
    },
  };
}

function recordingExecutor() {
  const requests: ToolExecutionRequest[] = [];
  const executor: IToolExecutor = {
    async execute(request): Promise<ToolExecutionResult> {
      requests.push(request);
      return { executionId: "exec-1", toolId: request.toolId, status: "completed", result: { success: true, data: { forgotten: 1 } }, startedAt: new Date(), completedAt: new Date(), durationMs: 1 };
    },
  };
  return { executor, requests };
}

function orchestrator(metadata: Record<string, unknown> = {}) {
  const seen: Array<{ request: JarvisRequest; context: SessionContext }> = [];
  const o: IOrchestrator = {
    async process(request, context): Promise<JarvisResponse> {
      seen.push({ request, context });
      return {
        success: true,
        data: { message: "Here's my answer.", conversationId: context.conversationId ?? "", agentId: "conversational-assistant", metadata },
        traceId: context.traceId,
        timestamp: new Date().toISOString(),
      };
    },
  };
  return { orchestrator: o, seen };
}

const tokenService = {
  verifyAccessToken: (token: string) => (token === "token-user-1" ? { userId: "user-1", role: "member", email: "u@test.local" } : null),
} as unknown as ChatRouterDeps["tokenService"];

function setup(opts: { rows?: MemoryRecord[]; metadata?: Record<string, unknown>; withMemory?: boolean } = {}) {
  const conversations = conversationStore();
  const memoryStore = new FakeMemoryStore(
    opts.rows ?? [memory("m-1", "User prefers short captions"), memory("m-2", "User works late"), memory("theirs", "Their secret", { userId: "user-2" })]
  );
  const settings = new Map<string, Record<string, unknown>>();
  const audit: Array<Omit<AuditEntry, "id" | "timestamp">> = [];
  const memoryManagement = new MemoryManagementService({
    store: memoryStore,
    control: { get: async (u) => settings.get(u) ?? null, put: async (u, v) => void settings.set(u, v) },
    audit: { log: async (e) => void audit.push(e) },
  });
  const approvals = approvalRepo();
  const pendingActionService = new PendingActionService({ approvalRepo: approvals, toolRegistry: { get: () => undefined, getAll: () => [] } });
  const { executor, requests } = recordingExecutor();
  const { orchestrator: o, seen } = orchestrator(opts.metadata);
  const router = createChatRouter({
    tokenService,
    conversationRepo: conversations.store,
    orchestrator: o,
    executor,
    pendingActionService,
    googleWrites: null,
    ...(opts.withMemory === false ? {} : { memoryManagement }),
  });
  return { router, conversations, memoryStore, settings, audit, approvals, requests, seen, memoryManagement };
}

type Reply = { status: number; body: { success: boolean; traceId?: string; data?: { message?: string; conversationId?: string; pendingAction?: Record<string, unknown> } } };

function post(router: ReturnType<typeof createChatRouter>, body: Record<string, unknown>): Promise<Reply> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { authorization: "Bearer token-user-1" };
    const req = { method: "POST", path: "/", url: "/", headers, body, params: {}, query: {}, ip: "127.0.0.1", get: (n: string) => headers[n.toLowerCase()] } as never;
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
    const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => void }> } }> }).stack.find(
      (l) => l.route?.path === "/" && l.route.methods.post
    );
    const handlers = layer!.route!.stack.map((s) => s.handle);
    let i = 0;
    const next = () => {
      if (i < handlers.length) handlers[i++]!(req, res, next);
    };
    next();
  });
}

/** A conversation: the first message goes through the orchestrator path. */
async function chat(env: ReturnType<typeof setup>, first = "Hello") {
  const opened = await post(env.router, { message: first });
  const conversationId = opened.body.data!.conversationId!;
  return { conversationId, say: (message: string) => post(env.router, { message, conversationId }) };
}

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------

describe("L5 chat — LIST is read-only and never reaches the model", () => {
  it("lists the user's own memories, numbered, and remembers the numbering server-side", async () => {
    const env = setup();
    const { conversationId, say } = await chat(env);
    const res = await say("show my memories");

    expect(res.status).toBe(200);
    expect(res.body.data!.message).toContain("1. User prefers short captions");
    expect(res.body.data!.message).toContain("2. User works late");
    expect(res.body.data!.message).not.toContain("Their secret");
    expect(env.seen).toHaveLength(1); // only the opening message reached the orchestrator
    const [user, reply] = env.conversations.of(conversationId).slice(-2);
    expect(user!.metadata).toEqual({ traceId: res.body.traceId });
    expect(reply!.metadata).toMatchObject({ memorySelection: [{ id: "m-1", version: T0.toISOString() }, { id: "m-2", version: T0.toISOString() }] });
    expect(env.requests).toEqual([]);
    expect(env.approvals.rows.size).toBe(0);
  });

  it("says plainly when there is nothing, and when learning is paused", async () => {
    const env = setup({ rows: [] });
    const { say } = await chat(env);
    await say("stop remembering things about me");
    const res = await say("what do you remember about me?");
    expect(res.body.data!.message).toMatch(/don't have any memories/i);
    expect(res.body.data!.message).toMatch(/paused/i);
  });
});

// ---------------------------------------------------------------------------
// FORGET → pending action → confirmation through ToolExecutor
// ---------------------------------------------------------------------------

describe("L5 chat — forgetting is a pending action, confirmed only through ToolExecutor", () => {
  it("\"forget 2\" after a list proposes exactly that memory, in the shape the voice guard reads — and deletes nothing yet", async () => {
    const env = setup();
    const { say } = await chat(env);
    await say("show my memories");
    const res = await say("forget 2");

    expect(res.body.data!.message).toContain("User works late");
    expect(res.body.data!.pendingAction).toMatchObject({
      toolId: "memory.forget",
      params: { memoryIds: ["m-2"], versions: [T0.toISOString()] },
      riskLevel: "HIGH_IMPACT",
      state: "WAITING_CONFIRMATION",
    });
    expect(env.memoryStore.deletes).toEqual([]);
    expect(env.requests).toEqual([]);
    expect(env.seen).toHaveLength(1);
  });

  it("\"yes\" runs it through ToolExecutor with the approved ids and approval — the route never deletes itself", async () => {
    const env = setup();
    const { say } = await chat(env);
    await say("show my memories");
    const proposal = await say("forget 1 and 2");
    await say("yes");

    expect(env.requests).toHaveLength(1);
    expect(env.requests[0]).toMatchObject({
      toolId: "memory.forget",
      params: { memoryIds: ["m-1", "m-2"], versions: [T0.toISOString(), T0.toISOString()] },
      userId: "user-1",
      approvalId: proposal.body.data!.pendingAction!.approvalId,
    });
    expect(env.memoryStore.deletes).toEqual([]);
  });

  it("\"no\" cancels it: nothing runs", async () => {
    const env = setup();
    const { say } = await chat(env);
    await say("show my memories");
    await say("forget 2");
    await say("no");

    expect(env.requests).toEqual([]);
    expect([...env.approvals.rows.values()].map((a) => a.status)).toEqual(["rejected"]);
  });

  it("a memory action cannot be modified: it stays exactly as proposed", async () => {
    const env = setup();
    const { say } = await chat(env);
    await say("show my memories");
    await say("forget 2");
    const res = await say("make it ₹200 per day");

    expect(res.body.data!.message).toMatch(/can't be changed/i);
    const [approval] = [...env.approvals.rows.values()];
    expect(approval).toMatchObject({ status: "pending", params: { memoryIds: ["m-2"], versions: [T0.toISOString()] } });
    expect(env.approvals.rows.size).toBe(1);
  });

  it("a number with no list before it is not a memory command", async () => {
    const env = setup();
    const { say } = await chat(env);
    await say("forget 2");
    expect(env.seen).toHaveLength(2);
    expect(env.approvals.rows.size).toBe(0);
  });

  it("\"forget this memory\" with nothing to point at asks, and deletes nothing", async () => {
    const env = setup();
    const { say } = await chat(env);
    const res = await say("forget this memory");
    expect(res.body.data!.message).toMatch(/which memory/i);
    expect(env.approvals.rows.size).toBe(0);
    expect(env.seen).toHaveLength(1);
  });
});

describe("L5 chat — forget everything needs the exact phrase or the on-screen button", () => {
  it("a loose \"yes\" does not confirm; \"yes, forget all\" does, through ToolExecutor", async () => {
    const env = setup();
    const { say } = await chat(env);
    const proposal = await say("forget everything you remember about me");

    expect(proposal.body.data!.message).toContain("2 memories");
    expect(proposal.body.data!.message).toContain("yes, forget all");
    expect(proposal.body.data!.pendingAction).toMatchObject({ toolId: "memory.forget_all", params: { scope: "ALL" }, riskLevel: "HIGH_IMPACT", state: "WAITING_CONFIRMATION" });

    const loose = await say("yes");
    expect(loose.body.data!.message).toContain("yes, forget all");
    expect(env.requests).toEqual([]);

    await say("yes, forget all");
    expect(env.requests).toHaveLength(1);
    expect(env.requests[0]).toMatchObject({ toolId: "memory.forget_all", params: { scope: "ALL" } });
    expect(env.memoryStore.deletes).toEqual([]);
  });

  it("with nothing stored, there is nothing to confirm", async () => {
    const env = setup({ rows: [] });
    const { say } = await chat(env);
    const res = await say("delete all my memories");
    expect(res.body.data!.message).toMatch(/nothing to forget/i);
    expect(env.approvals.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Collisions with pending actions
// ---------------------------------------------------------------------------

describe("L5 chat — existing pending-action semantics are preserved", () => {
  it("\"forget it\" still cancels an active action and touches no memory", async () => {
    const env = setup();
    const { conversationId, say } = await chat(env);
    await env.approvals.create({ userId: "user-1", conversationId, toolId: "meta.campaign.pause", action: "pause", params: { campaignId: "c1" }, paramsHash: "h", riskLevel: "EXTERNAL_SIDE_EFFECT", expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const res = await say("forget it");

    expect(res.body.data!.message).toMatch(/cancelled/i);
    expect([...env.approvals.rows.values()].map((a) => [a.toolId, a.status])).toEqual([["meta.campaign.pause", "rejected"]]);
    expect(env.memoryStore.deletes).toEqual([]);
  });

  it("with an action waiting, a deletion is not stacked on top of it — listing still works", async () => {
    const env = setup();
    const { conversationId, say } = await chat(env);
    await say("show my memories");
    await env.approvals.create({ userId: "user-1", conversationId, toolId: "meta.campaign.pause", action: "pause", params: {}, paramsHash: "h", riskLevel: "EXTERNAL_SIDE_EFFECT", expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const blocked = await say("forget 2");
    expect(blocked.body.data!.message).toMatch(/confirm or cancel/i);
    expect(env.approvals.rows.size).toBe(1);

    const listed = await say("show my memories");
    expect(listed.body.data!.message).toContain("User works late");
  });
});

// ---------------------------------------------------------------------------
// VETO
// ---------------------------------------------------------------------------

describe("L5 chat — \"forget that\" vetoes the message the user just sent", () => {
  it("saves the command, records the veto for the previous message, and never runs the model on it", async () => {
    const env = setup();
    const { conversationId, say } = await chat(env, "I prefer long captions.");
    const [statement] = env.conversations.of(conversationId);
    const res = await say("forget that");

    expect(res.body.data!.message).toMatch(/won't remember/i);
    expect(await env.memoryManagement.learningControl("user-1")).toEqual({ learningPaused: false, vetoedSourceMessageIds: [statement!.id] });
    expect(env.seen).toHaveLength(1);
    const saved = env.conversations.of(conversationId).at(-2)!;
    expect([saved.role, saved.content, saved.metadata]).toEqual(["user", "forget that", { traceId: res.body.traceId }]);
    expect(env.approvals.rows.size).toBe(0);
  });

  it("what that message had already taught is offered for forgetting — confirmed, never silently deleted", async () => {
    const env = setup();
    const { conversationId, say } = await chat(env, "I prefer long captions.");
    const [statement] = env.conversations.of(conversationId);
    env.memoryStore.rows.push(memory("m-new", "User prefers long captions", { sourceMessageId: statement!.id }));

    const res = await say("don't remember what I just said");

    expect(res.body.data!.message).toContain("User prefers long captions");
    expect(res.body.data!.pendingAction).toMatchObject({ toolId: "memory.forget", params: { memoryIds: ["m-new"] } });
    expect(env.memoryStore.deletes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CORRECT
// ---------------------------------------------------------------------------

describe("L5 chat — \"that's wrong\" targets only a memory the last reply was built on", () => {
  it("one recalled memory: its forgetting is proposed", async () => {
    const env = setup({ metadata: { recalledMemoryIds: ["m-1"] } });
    const { say } = await chat(env, "What caption length should I use?");
    const res = await say("that's wrong");

    expect(res.body.data!.message).toContain("User prefers short captions");
    expect(res.body.data!.pendingAction).toMatchObject({ toolId: "memory.forget", params: { memoryIds: ["m-1"] } });
    expect(env.seen).toHaveLength(1);
  });

  it("several: it asks which, by number, then proposes the one chosen", async () => {
    const env = setup({ metadata: { recalledMemoryIds: ["m-1", "m-2"] } });
    const { say } = await chat(env, "Plan my week");
    const asked = await say("that is wrong");
    expect(asked.body.data!.message).toContain("1. User prefers short captions");
    expect(asked.body.data!.pendingAction).toBeUndefined();

    const proposed = await say("forget 2");
    expect(proposed.body.data!.pendingAction).toMatchObject({ params: { memoryIds: ["m-2"] } });
  });

  it("no memory behind the last reply: it is ordinary conversation, answered by the assistant", async () => {
    const env = setup();
    const { say } = await chat(env, "What is the capital of Australia?");
    await say("that's wrong");
    expect(env.seen).toHaveLength(2);
    expect(env.approvals.rows.size).toBe(0);
  });

  it("another user's memory id in the last reply is never offered", async () => {
    const env = setup({ metadata: { recalledMemoryIds: ["theirs"] } });
    const { say } = await chat(env, "Hello");
    await say("that's wrong");
    expect(env.approvals.rows.size).toBe(0);
    expect(env.seen).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Pause, resume, replace, and no L5 at all
// ---------------------------------------------------------------------------

describe("L5 chat — pause, resume, replace", () => {
  it("pause and resume change only the learning flag; nothing is deleted", async () => {
    const env = setup();
    const { say } = await chat(env);
    await say("stop remembering things about me");
    expect((await env.memoryManagement.learningControl("user-1")).learningPaused).toBe(true);
    await say("start remembering again");
    expect((await env.memoryManagement.learningControl("user-1")).learningPaused).toBe(false);
    expect(env.memoryStore.deletes).toEqual([]);
    expect(env.seen).toHaveLength(1);
  });

  it("\"change my preference to …\" is an ordinary statement: answered and learned normally", async () => {
    const env = setup();
    const { say } = await chat(env);
    await say("change my preference to professional tone");
    expect(env.seen).toHaveLength(2);
    expect(env.approvals.rows.size).toBe(0);
  });

  it("without memory management wired, every message flows exactly as before", async () => {
    const env = setup({ withMemory: false });
    const { say } = await chat(env);
    await say("show my memories");
    await say("forget everything you remember about me");
    expect(env.seen).toHaveLength(3);
    expect(env.approvals.rows.size).toBe(0);
  });
});

describe("L5 chat — the audit trail holds no memory content", () => {
  it("proposals and ambiguous requests are recorded with a kind, an outcome and a count", async () => {
    const env = setup({ metadata: { recalledMemoryIds: ["m-1", "m-2"] } });
    const { say } = await chat(env, "Plan my week");
    await say("that's wrong");
    await say("forget 1");
    await say("forget this memory");

    expect(env.audit.map((a) => a.metadata)).toEqual([
      { command: "CORRECT", outcome: "AMBIGUOUS", candidates: 2 },
      { command: "FORGET", outcome: "PROPOSED", candidates: 1 },
      { command: "FORGET", outcome: "BLOCKED_BY_PENDING_ACTION", candidates: 0 },
    ]);
    const text = JSON.stringify(env.audit);
    for (const forbidden of ["captions", "works late", "msg-", "conv-"]) expect(text, forbidden).not.toContain(forbidden);
  });
});
