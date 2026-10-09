// Phase 14 — the memory API, the project API, and what the chat route gained.
//
// Real routers, real HTTP (an Express app on an ephemeral port), the real
// MemoryManagementService, PendingActionService and the memory writer's own
// correction check. The doubles are the stores underneath them.
//
// WHAT IS PINNED HERE:
//   - every answer is the caller's own data; another user's memory or project
//     is the same 404 as one that does not exist;
//   - forgetting and correcting are REQUESTS — a pending action whose
//     parameters are ids — and nothing changes until it is confirmed;
//   - there is no route that deletes or edits a memory directly;
//   - a conversation's project is fixed when it is created, from the user's
//     own projects, and reaches the orchestrator from the conversation row;
//   - "that's wrong. <new value>" becomes a `memory.correct` proposal only
//     when a memory is behind the last reply and the value is learnable.
//
// The same flows against PostgreSQL, end to end, are in
// phase14-memory-e2e-pg.integration.test.ts.
import { describe, it, expect, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type {
  Approval,
  AuditEntry,
  Conversation,
  ConversationMessage,
  IMemoryStore,
  IOrchestrator,
  IToolExecutor,
  JarvisRequest,
  JarvisResponse,
  MemoryListRequest,
  MemoryListResult,
  MemoryRecord,
  Project,
  SessionContext,
  ShutdownLifecycle,
  ToolExecutionRequest,
  ToolExecutionResult,
} from "@jarvis/core";
import { PendingActionService } from "@jarvis/agents";
import { MemoryExtractionService, MemoryManagementService } from "@jarvis/memory";
import { createChatRouter } from "../src/routes/chat.js";
import { createMemoryRouter, MEMORY_SCREEN_CONVERSATION_TITLE } from "../src/routes/memory.js";
import { createProjectsRouter } from "../src/routes/projects.js";
import { correctionStatementOf, createMemoryToolPort } from "../src/services/memory-tool-port.js";
import { startMemoryRetentionSweep } from "../src/services/memory-retention-scheduler.js";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const T0 = new Date("2026-09-01T10:00:00.000Z");
const DAY = 86_400_000;

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
    sourceConversationId: "conv-source",
    sourceMessageId: "msg-source",
    metadata: { embedding: [0.123456], sourceTraceId: "trace-source", evidence: { v: 1, count: 1, conversations: 1, firstSeenAt: T0.toISOString(), lastSeenAt: T0.toISOString(), sources: [], revisions: 0, previousSourceMessageIds: [] } },
    createdAt: T0,
    updatedAt: T0,
    expiresAt: new Date(Date.now() + 60 * DAY),
    ...over,
  };
}

class FakeMemoryStore implements IMemoryStore {
  readonly id = "fake";
  readonly name = "fake";
  writes: string[] = [];
  constructor(public rows: MemoryRecord[]) {}
  async getById(userId: string, id: string) {
    return this.rows.find((r) => r.id === id && r.userId === userId) ?? null;
  }
  async list(request: MemoryListRequest): Promise<MemoryListResult> {
    const now = Date.now();
    const mine = this.rows.filter((r) => {
      if (r.userId !== request.userId) return false;
      if (!request.includeExpired && r.expiresAt && r.expiresAt.getTime() <= now) return false;
      if (request.search && !r.content.toLowerCase().includes(request.search.toLowerCase())) return false;
      const scope = request.scope;
      if (scope?.kind === "PERSONAL" && r.projectId) return false;
      if (scope?.kind === "PROJECT" && r.projectId !== scope.projectId) return false;
      if (scope?.kind === "VISIBLE_IN" && r.projectId && r.projectId !== scope.projectId) return false;
      return true;
    });
    const offset = request.offset ?? 0;
    const page = mine.slice(offset, offset + (request.limit ?? 20));
    return { memories: page, total: mine.length, hasMore: offset + page.length < mine.length };
  }
  async delete() {
    this.writes.push("delete");
    return 0;
  }
  async deleteAll() {
    this.writes.push("deleteAll");
    return 0;
  }
  async store(): Promise<MemoryRecord[]> {
    this.writes.push("store");
    return [];
  }
  async update(): Promise<MemoryRecord> {
    this.writes.push("update");
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

function conversationStore() {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ConversationMessage[]>();
  let seq = 0;
  const store = {
    async create(input: { userId: string; title?: string; projectId?: string }) {
      const id = `conv-${++seq}`;
      const now = new Date().toISOString();
      conversations.set(id, { id, title: input.title ?? null, userId: input.userId, agentId: null, projectId: input.projectId ?? null, createdAt: now, updatedAt: now });
      messages.set(id, []);
      return conversations.get(id)!;
    },
    async findByIdAndUserId(conversationId: string, userId: string) {
      const found = conversations.get(conversationId);
      return found && found.userId === userId ? found : null;
    },
    async getMessages(conversationId: string) {
      return [...(messages.get(conversationId) ?? [])];
    },
    async addMessage(input: { conversationId: string; role: string; content: string; metadata?: Record<string, unknown> }) {
      const message: ConversationMessage = { id: `msg-${++seq}`, role: input.role as ConversationMessage["role"], content: input.content, ...(input.metadata ? { metadata: input.metadata } : {}), createdAt: new Date().toISOString() };
      messages.get(input.conversationId)!.push(message);
      return message;
    },
    async findOrCreateTitled(userId: string, title: string) {
      return [...conversations.values()].find((c) => c.userId === userId && c.title === title) ?? store.create({ userId, title });
    },
    async findMessageOwned(userId: string, messageId: string) {
      for (const [conversationId, list] of messages) {
        const found = list.find((m) => m.id === messageId);
        if (found && conversations.get(conversationId)!.userId === userId) return { ...found, conversationId };
      }
      return null;
    },
  };
  return { store, conversations, of: (id: string) => messages.get(id) ?? [] };
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

function projectStore(initial: Array<{ id: string; userId: string; name: string }>) {
  const rows: Project[] = initial.map((p) => ({ ...p, description: null, createdAt: T0.toISOString(), updatedAt: T0.toISOString() }));
  return {
    rows,
    list: async (userId: string) => rows.filter((p) => p.userId === userId),
    findOwned: async (userId: string, projectId: string) => rows.find((p) => p.id === projectId && p.userId === userId) ?? null,
    async create(userId: string, input: { name: string; description?: string | null }) {
      const project: Project = { id: `proj-new-${rows.length + 1}`, userId, name: input.name.trim(), description: input.description ?? null, createdAt: T0.toISOString(), updatedAt: T0.toISOString() };
      rows.push(project);
      return project;
    },
  };
}

const tokenService = {
  verifyAccessToken: (token: string) => (/^token-user-\d+$/.test(token) ? { userId: token.slice(6), role: "member", email: "u@test.local" } : null),
} as never;

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()!.close();
});

interface Reply {
  status: number;
  body: { success: boolean; data?: Record<string, any>; error?: { code: string; message: string } };
}

function world(options: { rows?: MemoryRecord[]; withCorrections?: boolean; withPending?: boolean; recalled?: string[] } = {}) {
  const conversations = conversationStore();
  const memoryStore = new FakeMemoryStore(
    options.rows ?? [
      memory("m-1", "I prefer dark mode"),
      memory("m-2", "I work late", { confidence: 0.8, metadata: { embedding: [0.5], evidence: { v: 1, count: 2, conversations: 2, firstSeenAt: T0.toISOString(), lastSeenAt: T0.toISOString(), sources: [], revisions: 0, previousSourceMessageIds: [] } } }),
      memory("m-p1", "I prefer playful captions", { projectId: "proj-1" }),
      memory("m-p2", "I prefer formal captions", { projectId: "proj-2" }),
      memory("m-old", "An expired memory", { expiresAt: new Date(Date.now() - DAY) }),
      memory("theirs", "Their secret preference", { userId: "user-2" }),
    ]
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
  const projects = projectStore([
    { id: "proj-1", userId: "user-1", name: "Alpha" },
    { id: "proj-2", userId: "user-1", name: "Beta" },
    { id: "proj-theirs", userId: "user-2", name: "Theirs" },
  ]);

  // The memory writer's OWN answer to "may this replace a memory?" — pure, so
  // no model, store or embedding is ever reached by it.
  const writer = new MemoryExtractionService({
    aiProvider: { id: "none", name: "none", defaultModel: "none", complete: async () => Promise.reject(new Error("no model in a correction")), listModels: async () => [], isAvailable: async () => true },
    store: memoryStore,
    embeddingProvider: { id: "none", name: "none", dimensions: 1, embed: async () => Promise.reject(new Error("unused")), isAvailable: async () => true },
  });
  const memoryCorrections = { check: (input: Parameters<MemoryExtractionService["checkCorrection"]>[0]) => writer.checkCorrection(input) };

  const executed: ToolExecutionRequest[] = [];
  const executor: IToolExecutor = {
    async execute(request): Promise<ToolExecutionResult> {
      executed.push(request);
      return { executionId: "exec-1", toolId: request.toolId, status: "completed", result: { success: true, data: { corrected: 1 } }, startedAt: new Date(), completedAt: new Date(), durationMs: 1 };
    },
  };
  const seen: Array<{ request: JarvisRequest; context: SessionContext }> = [];
  const orchestrator: IOrchestrator = {
    async process(request, context): Promise<JarvisResponse> {
      seen.push({ request, context });
      return {
        success: true,
        data: { message: "Here's my answer.", conversationId: context.conversationId ?? "", agentId: "conversational-assistant", metadata: options.recalled ? { recalledMemoryIds: options.recalled } : {} },
        traceId: context.traceId,
        timestamp: new Date().toISOString(),
      };
    },
  };

  const pending = options.withPending === false ? {} : { pendingActionService };
  const corrections = options.withCorrections === false ? {} : { memoryCorrections };

  const app = express();
  app.use(express.json());
  app.use("/memories", createMemoryRouter({ tokenService, memoryManagement, projects, conversationRepo: conversations.store, ...pending, ...corrections }));
  app.use("/projects", createProjectsRouter({ tokenService, projects }));
  app.use("/chat", createChatRouter({ tokenService, conversationRepo: conversations.store, orchestrator, executor, googleWrites: null, memoryManagement, projects, ...pending, ...corrections }));
  app.use((_req, res) => res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "No such route" } }));
  const server = app.listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, body?: unknown, user: string | null = "user-1"): Promise<Reply> {
    const response = await fetch(base + path, {
      method,
      headers: { ...(user ? { authorization: `Bearer token-${user}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Reply["body"] };
  }

  return { call, memoryStore, conversations, approvals, audit, settings, projects, executed, seen, memoryManagement };
}

const pendingApprovals = (env: ReturnType<typeof world>) => [...env.approvals.rows.values()].filter((a) => a.status === "pending");

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("Phase 14 API — every endpoint needs a signed-in user", () => {
  it.each([
    ["GET", "/memories"],
    ["GET", "/memories/status"],
    ["GET", "/memories/m-1"],
    ["POST", "/memories/learning/pause"],
    ["POST", "/memories/learning/resume"],
    ["POST", "/memories/m-1/forget"],
    ["POST", "/memories/m-1/correction"],
    ["GET", "/projects"],
    ["POST", "/projects"],
  ])("%s %s answers 401 without a token, and changes nothing", async (method, path) => {
    const env = world();
    const reply = await env.call(method, path, method === "POST" ? { statement: "I prefer light mode", name: "X" } : undefined, null);
    expect(reply.status).toBe(401);
    expect(env.approvals.rows.size).toBe(0);
    expect(env.settings.size).toBe(0);
    expect(env.memoryStore.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("Phase 14 API — GET /memories", () => {
  it("lists the caller's own memories, with confidence, project and provenance", async () => {
    const reply = await world().call("GET", "/memories");

    expect(reply.status).toBe(200);
    expect(reply.body.data).toMatchObject({ total: 4, hasMore: false, limit: 20, offset: 0 });
    const byId = new Map<string, any>(reply.body.data!.memories.map((m: any) => [m.id, m]));
    expect([...byId.keys()].sort()).toEqual(["m-1", "m-2", "m-p1", "m-p2"]);
    expect(byId.get("m-1")).toMatchObject({ type: "PREFERENCE", content: "I prefer dark mode", confidence: 0.7, confidenceLevel: "MEDIUM", projectId: null, expired: false, provenance: { source: "USER", statements: 1, conversations: 1, revisions: 0 } });
    expect(byId.get("m-2")).toMatchObject({ confidence: 0.8, confidenceLevel: "HIGH", provenance: { statements: 2, conversations: 2 } });
    expect(byId.get("m-p1")).toMatchObject({ projectId: "proj-1", projectName: "Alpha" });
    for (const field of ["id", "type", "content", "confidence", "createdAt", "updatedAt", "expiresAt", "provenance", "projectId"]) expect(byId.get("m-1"), field).toHaveProperty(field);
  });

  it("never returns another user's memory, the vector, raw metadata or a source id", async () => {
    const text = JSON.stringify((await world().call("GET", "/memories?includeExpired=true")).body);
    for (const forbidden of ["Their secret", "theirs", "user-2", "embedding", "0.123456", "metadata", "msg-source", "conv-source", "trace-source", "userId", "modelConfidence"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("pages, searches, filters by project, and hides expired memories unless asked", async () => {
    const env = world();
    expect((await env.call("GET", "/memories?limit=1")).body.data).toMatchObject({ total: 4, hasMore: true, limit: 1 });
    expect((await env.call("GET", "/memories?limit=2&offset=2")).body.data!.memories).toHaveLength(2);
    expect((await env.call("GET", "/memories?q=CAPTIONS")).body.data!.memories.map((m: any) => m.id).sort()).toEqual(["m-p1", "m-p2"]);
    expect((await env.call("GET", "/memories?project=personal")).body.data!.memories.map((m: any) => m.id).sort()).toEqual(["m-1", "m-2"]);
    expect((await env.call("GET", "/memories?project=proj-1")).body.data!.memories.map((m: any) => m.id)).toEqual(["m-p1"]);
    const withExpired = (await env.call("GET", "/memories?includeExpired=true")).body.data!;
    expect(withExpired.total).toBe(5);
    expect(withExpired.memories.find((m: any) => m.id === "m-old").expired).toBe(true);
  });

  it("another user's project is the same 404 as one that does not exist", async () => {
    const env = world();
    for (const project of ["proj-theirs", "no-such-project", "../etc"]) {
      const reply = await env.call("GET", `/memories?project=${encodeURIComponent(project)}`);
      expect(reply.status, project).toBe(404);
      expect(reply.body.error!.code).toBe("PROJECT_NOT_FOUND");
    }
  });

  it.each(["limit=0", "limit=51", "limit=abc", "limit=1.5", "offset=-1", "offset=x"])("refuses %s", async (query) => {
    expect((await world().call("GET", `/memories?${query}`)).status).toBe(400);
  });
});

describe("Phase 14 API — GET /memories/:id and /status", () => {
  it("returns one of the caller's memories", async () => {
    const reply = await world().call("GET", "/memories/m-p1");
    expect(reply.status).toBe(200);
    expect(reply.body.data!.memory).toMatchObject({ id: "m-p1", content: "I prefer playful captions", projectId: "proj-1", projectName: "Alpha", confidenceLevel: "MEDIUM" });
  });

  it("another user's memory, an unknown id and a malformed id are all the same 404", async () => {
    const env = world();
    for (const id of ["theirs", "no-such-memory", "a b", "x".repeat(80)]) {
      const reply = await env.call("GET", `/memories/${encodeURIComponent(id)}`);
      expect(reply.status, id).toBe(404);
      expect(reply.body.error!.code).toBe("MEMORY_NOT_FOUND");
      expect(JSON.stringify(reply.body)).not.toContain("Their secret");
    }
    // And user-2 sees their own.
    expect((await env.call("GET", "/memories/theirs", undefined, "user-2")).status).toBe(200);
  });

  it("status reports the controls, the counts and the retention policy", async () => {
    const reply = await world().call("GET", "/memories/status");
    expect(reply.body.data).toEqual({ learningPaused: false, vetoedSources: 0, active: 4, expired: 1, retention: { days: 90, purgeGraceDays: 30 }, correctionAvailable: true });
  });
});

// ---------------------------------------------------------------------------
// The learning switch
// ---------------------------------------------------------------------------

describe("Phase 14 API — pausing and resuming learning", () => {
  it("pause and resume flip the user's own switch, are audited, and delete nothing", async () => {
    const env = world();

    expect((await env.call("POST", "/memories/learning/pause")).body.data).toMatchObject({ learningPaused: true, active: 4 });
    expect((await env.call("GET", "/memories/status")).body.data!.learningPaused).toBe(true);
    // Another user's switch is untouched.
    expect((await env.call("GET", "/memories/status", undefined, "user-2")).body.data!.learningPaused).toBe(false);

    expect((await env.call("POST", "/memories/learning/resume")).body.data).toMatchObject({ learningPaused: false });
    expect(env.audit.map((a) => [a.userId, a.action])).toEqual([["user-1", "memory.learning_pause"], ["user-1", "memory.learning_resume"]]);
    expect(env.memoryStore.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requests to forget and to correct
// ---------------------------------------------------------------------------

describe("Phase 14 API — POST /memories/:id/forget is a request, not a deletion", () => {
  it("creates the same pending action the chat creates — ids and versions only — and deletes nothing", async () => {
    const env = world();
    const reply = await env.call("POST", "/memories/m-1/forget");

    expect(reply.status).toBe(202);
    expect(reply.body.data!.pendingAction).toMatchObject({ toolId: "memory.forget", riskLevel: "HIGH_IMPACT", state: "WAITING_CONFIRMATION", params: { memoryIds: ["m-1"], versions: [T0.toISOString()] } });
    expect(reply.body.data!.summary).toContain("I prefer dark mode");
    expect(env.memoryStore.writes).toEqual([]);

    // It waits in the user's own "Memory controls" conversation.
    const conversation = env.conversations.conversations.get(reply.body.data!.conversationId)!;
    expect(conversation).toMatchObject({ userId: "user-1", title: MEMORY_SCREEN_CONVERSATION_TITLE, projectId: null });
    expect(pendingApprovals(env).map((a) => [a.conversationId, a.toolId])).toEqual([[conversation.id, "memory.forget"]]);
    expect(env.audit.at(-1)).toMatchObject({ action: "memory.command", metadata: { command: "FORGET", outcome: "PROPOSED" } });
  });

  it("another user's memory cannot be asked about: 404, and no pending action", async () => {
    const env = world();
    expect((await env.call("POST", "/memories/theirs/forget")).status).toBe(404);
    expect((await env.call("POST", "/memories/no-such/forget")).status).toBe(404);
    expect(env.approvals.rows.size).toBe(0);
  });

  it("a new request replaces one the user never confirmed: only one waits at a time", async () => {
    const env = world();
    await env.call("POST", "/memories/m-1/forget");
    const second = await env.call("POST", "/memories/m-2/forget");

    expect(second.status).toBe(202);
    expect([...env.approvals.rows.values()].map((a) => [a.status, (a.params as { memoryIds: string[] }).memoryIds[0]])).toEqual([["rejected", "m-1"], ["pending", "m-2"]]);
  });

  it("without the confirmation service it refuses, rather than deleting some other way", async () => {
    const env = world({ withPending: false });
    const reply = await env.call("POST", "/memories/m-1/forget");
    expect(reply.status).toBe(503);
    expect(env.memoryStore.writes).toEqual([]);
  });
});

describe("Phase 14 API — POST /memories/:id/correction is a request, not an edit", () => {
  it("saves the user's statement as their own message and proposes memory.correct with ids only", async () => {
    const env = world();
    const reply = await env.call("POST", "/memories/m-1/correction", { statement: "  I prefer light mode  " });

    expect(reply.status).toBe(202);
    const conversationId = reply.body.data!.conversationId as string;
    const [saved] = env.conversations.of(conversationId);
    expect(saved).toMatchObject({ role: "user", content: "I prefer light mode" });

    const action = reply.body.data!.pendingAction;
    expect(action).toMatchObject({ toolId: "memory.correct", riskLevel: "HIGH_IMPACT", state: "WAITING_CONFIRMATION" });
    expect(action.params).toEqual({ memoryId: "m-1", version: T0.toISOString(), sourceMessageId: saved!.id });
    // The words are in what the user reads, never in the action's parameters.
    expect(reply.body.data!.summary).toContain("I prefer light mode");
    expect(JSON.stringify(action.params)).not.toContain("light");
    expect(JSON.stringify([...env.approvals.rows.values()].map((a) => a.params))).not.toContain("light");

    // Nothing has changed yet.
    expect(env.memoryStore.writes).toEqual([]);
    expect(env.memoryStore.rows.find((r) => r.id === "m-1")!.content).toBe("I prefer dark mode");
  });

  it.each([
    ["a task", "Remind me to call the printer tomorrow"],
    ["a goal", "My goal is to reach 10,000 followers this year"],
    ["a secret", "My password is hunter2-example"],
    ["a grant of authority", "You can post without asking me"],
    ["something that is not about the user", "People usually like short captions"],
    ["a question", "What is the best time to post?"],
  ])("refuses %s with 422 — nothing is saved, nothing is proposed", async (_name, statement) => {
    const env = world();
    const reply = await env.call("POST", "/memories/m-1/correction", { statement });

    expect(reply.status).toBe(422);
    expect(reply.body.error!.code).toBe("MEMORY_NOT_LEARNABLE");
    expect(env.approvals.rows.size).toBe(0);
    expect([...env.conversations.conversations.values()].flatMap((c) => env.conversations.of(c.id))).toEqual([]);
    expect(env.memoryStore.writes).toEqual([]);
    // The refusal is audited by kind — never with the words.
    expect(JSON.stringify(env.audit)).not.toContain(statement);
  });

  it.each([
    ["no statement", {}],
    ["an empty statement", { statement: "   " }],
    ["a statement that is not text", { statement: 42 }],
    ["a statement that is too long", { statement: `I prefer ${"very ".repeat(120)}long captions` }],
  ])("refuses %s with 400", async (_name, body) => {
    const env = world();
    expect((await env.call("POST", "/memories/m-1/correction", body)).status).toBe(400);
    expect(env.approvals.rows.size).toBe(0);
  });

  it("another user's memory cannot be corrected: 404, nothing saved, nothing proposed", async () => {
    const env = world();
    expect((await env.call("POST", "/memories/theirs/correction", { statement: "I prefer light mode" })).status).toBe(404);
    expect(env.approvals.rows.size).toBe(0);
    expect(env.conversations.conversations.size).toBe(0);
  });

  it("without a memory writer, or without confirmations, it refuses with 503", async () => {
    expect((await world({ withCorrections: false }).call("POST", "/memories/m-1/correction", { statement: "I prefer light mode" })).status).toBe(503);
    expect((await world({ withPending: false }).call("POST", "/memories/m-1/correction", { statement: "I prefer light mode" })).status).toBe(503);
    expect((await world({ withCorrections: false }).call("GET", "/memories/status")).body.data!.correctionAvailable).toBe(false);
  });
});

describe("Phase 14 API — there is no route that deletes or edits a memory directly", () => {
  it.each([
    ["DELETE", "/memories/m-1"],
    ["DELETE", "/memories"],
    ["PUT", "/memories/m-1"],
    ["PATCH", "/memories/m-1"],
    ["POST", "/memories"],
    ["POST", "/memories/m-1"],
    ["POST", "/memories/forget-all"],
    ["DELETE", "/projects/proj-1"],
    ["PATCH", "/projects/proj-1"],
  ])("%s %s does not exist", async (method, path) => {
    const env = world();
    const reply = await env.call(method, path, { content: "overwritten", statement: "I prefer light mode" });
    expect(reply.status).toBe(404);
    expect(env.memoryStore.writes).toEqual([]);
    expect(env.approvals.rows.size).toBe(0);
  });

  it("the memory router registers only GET and POST handlers, and holds no store", () => {
    const router = createMemoryRouter({
      tokenService,
      memoryManagement: {} as never,
      projects: {} as never,
      conversationRepo: {} as never,
    }) as unknown as { stack: Array<{ route?: { methods: Record<string, boolean> } }> };
    const methods = new Set(router.stack.flatMap((layer) => Object.keys(layer.route?.methods ?? {})));
    expect([...methods].sort()).toEqual(["get", "post"]);
  });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

describe("Phase 14 API — /projects", () => {
  it("lists the caller's own projects, without the owner's id", async () => {
    const env = world();
    const reply = await env.call("GET", "/projects");
    expect(reply.body.data!.projects.map((p: any) => p.name)).toEqual(["Alpha", "Beta"]);
    expect(JSON.stringify(reply.body)).not.toMatch(/userId|Theirs|proj-theirs/);
    expect((await env.call("GET", "/projects", undefined, "user-2")).body.data!.projects.map((p: any) => p.name)).toEqual(["Theirs"]);
  });

  it("creates a project for the caller, whatever user id the body names", async () => {
    const env = world();
    const reply = await env.call("POST", "/projects", { name: "Gamma", description: "Spring launch", userId: "user-2" });
    expect(reply.status).toBe(201);
    expect(reply.body.data!.project).toMatchObject({ name: "Gamma", description: "Spring launch" });
    expect(env.projects.rows.at(-1)).toMatchObject({ userId: "user-1", name: "Gamma" });
  });

  it.each([{}, { name: 42 }, { name: "ok", description: 7 }])("refuses %j", async (body) => {
    expect((await world().call("POST", "/projects", body)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Chat — the conversation's project
// ---------------------------------------------------------------------------

describe("Phase 14 chat — the active project is the conversation's", () => {
  it("a new conversation takes one of the user's own projects, and the orchestrator is told from the row", async () => {
    const env = world();
    const first = await env.call("POST", "/chat", { message: "Hello", projectId: "proj-1" });

    expect(first.status).toBe(200);
    const conversationId = first.body.data!.conversationId as string;
    expect(env.conversations.conversations.get(conversationId)!.projectId).toBe("proj-1");
    expect(env.seen[0]!.context.projectId).toBe("proj-1");

    // A later turn does not name the project: it is still the conversation's.
    await env.call("POST", "/chat", { message: "And another thing", conversationId });
    expect(env.seen[1]!.context.projectId).toBe("proj-1");
  });

  it("a conversation with no project is personal — and stays personal whatever a later request says", async () => {
    const env = world();
    const first = await env.call("POST", "/chat", { message: "Hello" });
    const conversationId = first.body.data!.conversationId as string;
    expect(env.seen[0]!.context.projectId).toBeUndefined();

    const forged = await env.call("POST", "/chat", { message: "Use my project", conversationId, projectId: "proj-1" });
    expect(forged.status).toBe(409);
    expect(forged.body.error!.code).toBe("PROJECT_MISMATCH");
    expect(env.seen).toHaveLength(1);
    expect(env.conversations.conversations.get(conversationId)!.projectId).toBeNull();
  });

  it("a conversation cannot be moved to another of the user's projects", async () => {
    const env = world();
    const conversationId = (await env.call("POST", "/chat", { message: "Hello", projectId: "proj-1" })).body.data!.conversationId as string;

    expect((await env.call("POST", "/chat", { message: "Switch", conversationId, projectId: "proj-2" })).status).toBe(409);
    expect((await env.call("POST", "/chat", { message: "Same one", conversationId, projectId: "proj-1" })).status).toBe(200);
    expect(env.seen.map((s) => s.context.projectId)).toEqual(["proj-1", "proj-1"]);
  });

  it.each(["proj-theirs", "no-such-project"])("naming %s creates no conversation and reaches no model", async (projectId) => {
    const env = world();
    const reply = await env.call("POST", "/chat", { message: "Hello", projectId });

    expect(reply.status).toBe(404);
    expect(reply.body.error!.code).toBe("PROJECT_NOT_FOUND");
    expect(env.conversations.conversations.size).toBe(0);
    expect(env.seen).toEqual([]);
  });

  it("'show my memories' lists only what the conversation may see", async () => {
    const env = world();
    const inAlpha = (await env.call("POST", "/chat", { message: "Hello", projectId: "proj-1" })).body.data!.conversationId as string;
    const personal = (await env.call("POST", "/chat", { message: "Hello" })).body.data!.conversationId as string;

    const alphaList = (await env.call("POST", "/chat", { message: "show my memories", conversationId: inAlpha })).body.data!.message as string;
    expect(alphaList).toContain("I prefer dark mode");
    expect(alphaList).toContain("I prefer playful captions");
    expect(alphaList).not.toContain("I prefer formal captions");

    const personalList = (await env.call("POST", "/chat", { message: "show my memories", conversationId: personal })).body.data!.message as string;
    expect(personalList).toContain("I prefer dark mode");
    expect(personalList).not.toContain("captions");
  });
});

// ---------------------------------------------------------------------------
// Chat — corrections
// ---------------------------------------------------------------------------

describe("Phase 14 chat — a correction with its new value", () => {
  async function afterAReplyBuiltOn(recalled: string[]) {
    const env = world({ recalled });
    const conversationId = (await env.call("POST", "/chat", { message: "Which mode do I use?" })).body.data!.conversationId as string;
    return { env, conversationId, say: (message: string) => env.call("POST", "/chat", { message, conversationId }) };
  }

  it("proposes changing the memory the last reply was built on — ids only, and nothing changes yet", async () => {
    const { env, conversationId, say } = await afterAReplyBuiltOn(["m-1"]);
    const reply = await say("That's wrong. I prefer light mode.");

    expect(reply.body.data!.message).toContain("I'll change this memory");
    expect(reply.body.data!.message).toContain("I prefer dark mode");
    expect(reply.body.data!.message).toContain("I prefer light mode.");

    const saved = env.conversations.of(conversationId).filter((m) => m.role === "user").at(-1)!;
    expect(saved.content).toBe("That's wrong. I prefer light mode.");
    expect(reply.body.data!.pendingAction).toMatchObject({ toolId: "memory.correct", riskLevel: "HIGH_IMPACT", params: { memoryId: "m-1", version: T0.toISOString(), sourceMessageId: saved.id } });
    expect(JSON.stringify(reply.body.data!.pendingAction.params)).not.toContain("light");

    // The turn never reached the model, and nothing was written or executed.
    expect(env.seen).toHaveLength(1);
    expect(env.memoryStore.writes).toEqual([]);
    expect(env.executed).toEqual([]);
  });

  it("'yes' runs it through the tool executor with the approval; it is never run before", async () => {
    const { env, say } = await afterAReplyBuiltOn(["m-1"]);
    const proposed = await say("That's wrong. I prefer light mode.");
    const reply = await say("yes");

    expect(env.executed).toHaveLength(1);
    expect(env.executed[0]).toMatchObject({ toolId: "memory.correct", userId: "user-1", approvalId: proposed.body.data!.pendingAction.approvalId, params: proposed.body.data!.pendingAction.params });
    expect(reply.body.data!.message).toContain("Action executed successfully");
  });

  it("'no' cancels it, and a correction can never be modified", async () => {
    const { env, say } = await afterAReplyBuiltOn(["m-1"]);
    await say("That's wrong. I prefer light mode.");
    const modify = await say("make it ₹200 per day");
    expect(modify.body.data!.message).toContain("can't be changed");
    // Another correction while one waits is not stacked on it either.
    expect((await say("change it to I prefer blue mode")).body.data!.message).toContain("waiting for your confirmation");
    expect(pendingApprovals(env)).toHaveLength(1);

    await say("no");
    expect(pendingApprovals(env)).toHaveLength(0);
    expect(env.executed).toEqual([]);
  });

  it.each([
    ["a fact about the world", "That's wrong. It's Paris."],
    ["an apology", "That's wrong, sorry"],
    ["a task", "That's wrong. Remind me tomorrow."],
    ["a secret", "That's wrong. My password is hunter2-example"],
  ])("with %s it is ordinary conversation, exactly as before: no proposal", async (_name, message) => {
    const { env, say } = await afterAReplyBuiltOn(["m-1"]);
    await say(message);
    expect(env.approvals.rows.size).toBe(0);
    expect(env.seen).toHaveLength(2); // answered by the assistant
  });

  it("with no memory behind the last reply it is ordinary conversation", async () => {
    const { env, say } = await afterAReplyBuiltOn([]);
    await say("That's wrong. I prefer light mode.");
    expect(env.approvals.rows.size).toBe(0);
    expect(env.seen).toHaveLength(2);
  });

  it("with several memories behind the reply it asks which, and proposes nothing", async () => {
    const { env, say } = await afterAReplyBuiltOn(["m-1", "m-2"]);
    const reply = await say("That's wrong. I prefer light mode.");
    expect(reply.body.data!.message).toContain("Which one should I change?");
    expect(reply.body.data!.message).toContain("change 2 to I prefer light mode.");
    expect(env.approvals.rows.size).toBe(0);

    // "change 1 to …" then names it.
    const chosen = await say("change 1 to I prefer light mode");
    expect(chosen.body.data!.pendingAction).toMatchObject({ toolId: "memory.correct", params: { memoryId: "m-1" } });
  });

  it("'change 2 to …' works from a list, and a position that was not shown is refused", async () => {
    const env = world();
    const conversationId = (await env.call("POST", "/chat", { message: "Hello" })).body.data!.conversationId as string;
    const say = (message: string) => env.call("POST", "/chat", { message, conversationId });
    await say("show my memories");

    expect((await say("change 9 to I prefer light mode")).body.data!.message).toContain("I only showed 2 memories");
    expect(env.approvals.rows.size).toBe(0);

    await say("show my memories");
    const reply = await say("change 2 to I always work late");
    expect(reply.body.data!.pendingAction).toMatchObject({ toolId: "memory.correct", params: { memoryId: "m-2" } });
  });

  it("another user's memory id behind a reply is not a target: it does not exist for this user", async () => {
    const { env, say } = await afterAReplyBuiltOn(["theirs"]);
    await say("That's wrong. I prefer light mode.");
    expect(env.approvals.rows.size).toBe(0);
  });

  it("'that's wrong' on its own still offers to forget, as before", async () => {
    const { say } = await afterAReplyBuiltOn(["m-1"]);
    const reply = await say("that's wrong");
    expect(reply.body.data!.pendingAction).toMatchObject({ toolId: "memory.forget", params: { memoryIds: ["m-1"] } });
  });

  it("without a memory writer, a correction with a value is ordinary conversation", async () => {
    const env = world({ recalled: ["m-1"], withCorrections: false });
    const conversationId = (await env.call("POST", "/chat", { message: "Which mode?" })).body.data!.conversationId as string;
    await env.call("POST", "/chat", { message: "That's wrong. I prefer light mode.", conversationId });
    expect(env.approvals.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The tools' port
// ---------------------------------------------------------------------------

describe("Phase 14 — the memory tools' port", () => {
  function setup(corrector: Parameters<typeof createMemoryToolPort>[0]["corrector"] = () => null) {
    const conversations = conversationStore();
    const store = new FakeMemoryStore([memory("m-1", "I prefer dark mode"), memory("m-p1", "Project wording", { projectId: "proj-1" }), memory("m-p2", "Other project wording", { projectId: "proj-2" })]);
    const audit: Array<Omit<AuditEntry, "id" | "timestamp">> = [];
    const memoryManagement = new MemoryManagementService({ store, control: { get: async () => null, put: async () => undefined }, audit: { log: async (e) => void audit.push(e) } });
    return { port: createMemoryToolPort({ memoryManagement, conversations: conversations.store, corrector }), conversations, audit, store };
  }
  const TARGET = { id: "m-1", version: T0.toISOString() };

  it("memory.list sees what the conversation may see: personal, plus its own project's", async () => {
    const { port, conversations } = setup();
    const inProject = await conversations.store.create({ userId: "user-1", projectId: "proj-1" });
    const personal = await conversations.store.create({ userId: "user-1" });
    const contents = async (conversationId?: string, userId = "user-1") =>
      (await port.list(userId, { includeExpired: false, ...(conversationId ? { conversationId } : {}) })).memories.map((m) => m.content).sort();

    expect(await contents(inProject.id)).toEqual(["I prefer dark mode", "Project wording"]);
    expect(await contents(personal.id)).toEqual(["I prefer dark mode"]);
    // No conversation, an unknown one, or someone else's: personal only.
    expect(await contents()).toEqual(["I prefer dark mode"]);
    expect(await contents("no-such-conversation")).toEqual(["I prefer dark mode"]);
    const theirs = await conversations.store.create({ userId: "user-2", projectId: "proj-1" });
    expect(await contents(theirs.id)).toEqual(["I prefer dark mode"]);
  });

  it("a correction takes its value from the saved message — the statement of a chat correction, or a screen message whole", () => {
    expect(correctionStatementOf("That's wrong. I prefer light mode.")).toBe("I prefer light mode.");
    expect(correctionStatementOf("change 2 to I prefer light mode")).toBe("I prefer light mode");
    expect(correctionStatementOf("  I prefer light mode  ")).toBe("I prefer light mode");
  });

  it("hands the writer the message's own ids and trace, and records the outcome by id", async () => {
    const correct = vi.fn(async () => ({ status: "CORRECTED" as const }));
    const { port, conversations, audit } = setup(() => ({ correct }));
    const conversation = await conversations.store.create({ userId: "user-1" });
    const message = await conversations.store.addMessage({ conversationId: conversation.id, role: "user", content: "That's wrong. I prefer light mode.", metadata: { traceId: "trace-of-the-message" } });

    expect(await port.correct!("user-1", { ...TARGET, sourceMessageId: message.id }, {})).toEqual({ status: "CORRECTED" });
    expect(correct).toHaveBeenCalledWith({
      userId: "user-1",
      memoryId: "m-1",
      version: T0.toISOString(),
      statement: "I prefer light mode.",
      userMessage: "That's wrong. I prefer light mode.",
      conversationId: conversation.id,
      messageId: message.id,
      traceId: "trace-of-the-message",
    });
    expect(audit).toEqual([{ userId: "user-1", action: "memory.correct", result: "success", metadata: { memoryIds: ["m-1"], status: "CORRECTED" } }]);
    expect(JSON.stringify(audit)).not.toContain("light");
  });

  it("refuses a source that is not this user's own saved USER message", async () => {
    const correct = vi.fn(async () => ({ status: "CORRECTED" as const }));
    const { port, conversations, audit } = setup(() => ({ correct }));
    const mine = await conversations.store.create({ userId: "user-1" });
    const theirs = await conversations.store.create({ userId: "user-2" });
    const assistant = await conversations.store.addMessage({ conversationId: mine.id, role: "assistant", content: "I prefer light mode" });
    const foreign = await conversations.store.addMessage({ conversationId: theirs.id, role: "user", content: "I prefer light mode" });

    for (const sourceMessageId of [assistant.id, foreign.id, "no-such-message"]) {
      expect(await port.correct!("user-1", { ...TARGET, sourceMessageId }, {})).toEqual({ status: "SOURCE_NOT_FOUND" });
    }
    expect(correct).not.toHaveBeenCalled();
    expect(audit.map((a) => [a.result, (a.metadata as { status: string }).status])).toEqual([["rejected", "SOURCE_NOT_FOUND"], ["rejected", "SOURCE_NOT_FOUND"], ["rejected", "SOURCE_NOT_FOUND"]]);
  });

  it("with no memory writer, or one that throws, a correction fails closed", async () => {
    const none = setup(() => null);
    expect(await none.port.correct!("user-1", { ...TARGET, sourceMessageId: "x" }, {})).toEqual({ status: "FAILED" });

    const throwing = setup(() => ({
      correct: async () => {
        throw new Error("database down");
      },
    }));
    const conversation = await throwing.conversations.store.create({ userId: "user-1" });
    const message = await throwing.conversations.store.addMessage({ conversationId: conversation.id, role: "user", content: "I prefer light mode" });
    expect(await throwing.port.correct!("user-1", { ...TARGET, sourceMessageId: message.id }, {})).toEqual({ status: "FAILED" });
  });
});

// ---------------------------------------------------------------------------
// When the retention sweep runs
// ---------------------------------------------------------------------------

describe("Phase 14 — the retention sweep's scheduler", () => {
  function lifecycle(state: "RUNNING" | "DRAINING" = "RUNNING") {
    const listeners: Array<(s: string) => void> = [];
    const tracked: string[] = [];
    let current: string = state;
    const value = {
      getState: () => current,
      canAcceptNewWork: () => current === "RUNNING",
      trackExecution: (id: string) => {
        tracked.push(id);
        return { complete: () => void tracked.splice(tracked.indexOf(id), 1) };
      },
      onStateChange: (listener: (s: string) => void) => {
        listeners.push(listener);
        return () => void listeners.splice(listeners.indexOf(listener), 1);
      },
    } as unknown as ShutdownLifecycle;
    return { value, tracked, drain: () => { current = "DRAINING"; for (const l of [...listeners]) l(current); } };
  }
  const quiet = () => undefined;

  it("an interval of 0 disables it: nothing runs, and it says so", async () => {
    const sweep = vi.fn(async () => ({ users: 0, deleted: 0, failed: 0 }));
    const events: string[] = [];
    const scheduler = startMemoryRetentionSweep({ sweep: { sweep }, lifecycle: lifecycle().value, intervalMs: 0, log: (_level, event) => void events.push(event) });
    await scheduler.sweep();
    await scheduler.stop();
    expect(sweep).not.toHaveBeenCalled();
    expect(events).toEqual(["memory_retention_disabled"]);
  });

  it("sweeps once at start, never overlaps, and logs counts only", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sweep = vi.fn(async () => {
      await gate;
      return { users: 2, deleted: 7, failed: 0 };
    });
    const logged: Array<[string, Record<string, unknown> | undefined]> = [];
    const scheduler = startMemoryRetentionSweep({ sweep: { sweep }, lifecycle: lifecycle().value, intervalMs: 60_000, log: (_level, event, meta) => void logged.push([event, meta]) });

    // Two more requests while the first is still running: they join it.
    const joined = Promise.all([scheduler.sweep(), scheduler.sweep()]);
    release();
    await joined;
    await scheduler.stop();

    expect(sweep).toHaveBeenCalledTimes(1);
    const completed = logged.find(([event]) => event === "memory_retention_sweep_completed")![1]!;
    expect(completed).toMatchObject({ users: 2, deleted: 7, failed: 0 });
    expect(Object.keys(completed).sort()).toEqual(["deleted", "durationMs", "failed", "users"]);
  });

  it("starts nothing once draining has begun, and nothing after stop", async () => {
    const sweep = vi.fn(async () => ({ users: 0, deleted: 0, failed: 0 }));
    const life = lifecycle();
    const scheduler = startMemoryRetentionSweep({ sweep: { sweep }, lifecycle: life.value, intervalMs: 60_000, log: quiet });
    await scheduler.sweep();
    expect(sweep).toHaveBeenCalledTimes(1);

    life.drain();
    await scheduler.sweep();
    expect(sweep).toHaveBeenCalledTimes(1);

    await scheduler.stop();
    await scheduler.sweep();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(life.tracked).toEqual([]);
  });

  it("a sweep that throws is logged without its message, and the next one still runs", async () => {
    const sweep = vi.fn().mockRejectedValueOnce(new Error("postgresql://user:secret@host is down")).mockResolvedValue({ users: 0, deleted: 0, failed: 0 });
    const logged: unknown[] = [];
    const scheduler = startMemoryRetentionSweep({ sweep: { sweep }, lifecycle: lifecycle().value, intervalMs: 60_000, log: (_level, event, meta) => void logged.push([event, meta]) });
    await scheduler.sweep();
    await scheduler.sweep();
    await scheduler.stop();

    expect(sweep).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logged)).not.toContain("secret");
    expect(JSON.stringify(logged)).toContain("memory_retention_sweep_error");
  });
});
