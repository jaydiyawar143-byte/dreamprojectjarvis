// Phase 14 — memory, end to end, on the REAL production classes and
// PostgreSQL + pgvector:
//
//   chat route → Orchestrator (recall, then fire-and-forget extraction)
//   → MemoryExtractionService (L1–L4, the one writer) → PrismaMemoryRepository
//   chat route / memory API → memory command → PendingActionService (Approval)
//   → confirm → ToolExecutor → memory.correct / memory.forget
//   retention sweep → ToolExecutor → memory.purge_expired
//
// ONE JOURNEY, in order — each step reads the database or what the model was
// actually sent:
//
//    1– 3  a preference is stated, extracted and stored
//    4– 6  a new conversation recalls it; its confidence is available
//    7– 8  the user corrects it; the corrected value is what is recalled
//    9–13  the user lists it, asks to forget it, confirms; ToolExecutor
//          deletes it; it is no longer recalled
//   14–17  a project memory is created, recalled only in its own project —
//          not in another project, not without a project, not by another user
//   18–19  expiry stops recall at once; the retention sweep removes the row
//
// TWO STAND-INS, both deterministic: the chat model answers "Noted." and
// records what it was sent; the extraction model proposes every user message
// verbatim. Embeddings are a bag-of-words hash. No network.
//
// THERE IS NO IN-MEMORY FALLBACK. Every store here is PostgreSQL. If a
// database was configured and cannot be reached, the suite FAILS — it does not
// skip, and it does not run against something else. With no database
// configured at all it is reported as skipped (CI fails on a skipped database
// test), unless JARVIS_REQUIRE_POSTGRES=1, which turns that into a failure too.
//
// SAFETY. DATABASE_URL is read before anything imports the Prisma client, and
// the suite runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { AICompletionRequest, AICompletionResponse, EmbeddingRequest, EmbeddingResponse, IAIProvider, IEmbeddingProvider } from "@jarvis/core";
import { MEMORY_CORRECT_TOOL_ID, MEMORY_PURGE_TOOL_ID } from "@jarvis/core";
import { AgentRegistry, ConversationalAssistant, Orchestrator, PendingActionService } from "@jarvis/agents";
import { ToolExecutor, ToolRegistry, createMemoryCorrectionTool, createMemoryRetentionTool, createMemoryTools } from "@jarvis/tools";
import { ApprovalService, AuditLogger, PermissionService } from "@jarvis/security";
import { randomUUID } from "node:crypto";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Db = typeof import("@jarvis/db");
let db: Db | null = null;
let mem: typeof import("@jarvis/memory") | null = null;
let routes: {
  chat: typeof import("../src/routes/chat.js");
  memory: typeof import("../src/routes/memory.js");
  projects: typeof import("../src/routes/projects.js");
  pending: typeof import("../src/routes/pending-actions.js");
  port: typeof import("../src/services/memory-tool-port.js");
} | null = null;
let prisma: InstanceType<Db["PrismaClient"]> | null = null;
let dbUp = false;
let dbFailure = "DATABASE_URL is not set to a separate test database (never port 5432 or 5433).";
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  mem = await import("@jarvis/memory");
  routes = {
    chat: await import("../src/routes/chat.js"),
    memory: await import("../src/routes/memory.js"),
    projects: await import("../src/routes/projects.js"),
    pending: await import("../src/routes/pending-actions.js"),
    port: await import("../src/services/memory-tool-port.js"),
  };
  prisma = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbFailure = "DATABASE_URL is set, but PostgreSQL cannot be reached.";
  }
}

// ---------------------------------------------------------------------------
// The deterministic stand-ins
// ---------------------------------------------------------------------------

const DIMS = 1536;
/** The similarity floor that suits bag-of-words vectors: shared vocabulary in, none out. */
const FLOOR = 0.15;
const STOP_WORDS = new Set(["a", "an", "and", "the", "my", "your", "our", "is", "are", "was", "were", "to", "of", "in", "on", "for", "with", "that", "this", "it", "as", "at", "by", "from", "or", "be", "i", "me", "we", "you"]);

function embedText(text: string): number[] {
  const vec = new Array<number>(DIMS).fill(0);
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  if (tokens.length === 0) {
    vec[0] = 1;
    return vec;
  }
  for (const token of new Set(tokens)) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[1 + (Math.abs(h) % (DIMS - 1))] = 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / norm);
}

const embeddings: IEmbeddingProvider = {
  id: "p14-e2e-embeddings",
  name: "P14 E2E embeddings",
  dimensions: DIMS,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map(embedText), model: "bag-of-words" };
  },
  async isAvailable() {
    return true;
  },
};

/** The chat model: answers "Noted." and keeps every request it was sent. */
class ChatModel implements IAIProvider {
  readonly id = "p14-chat-model";
  readonly name = "P14 chat model";
  readonly defaultModel = "p14";
  readonly requests: AICompletionRequest[] = [];
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    return { message: { role: "assistant", content: "Noted." }, finishReason: "stop", model: this.defaultModel };
  }
  async listModels() {
    return [this.defaultModel];
  }
  async isAvailable() {
    return true;
  }
  /** Everything the model was sent on its last turn, after the agent's own prompt. */
  lastContext(): string {
    return this.requests.at(-1)!.messages.slice(1).map((m) => String(m.content ?? "")).join("\n");
  }
}

/** The extraction model: proposes every user message, verbatim, citing itself. */
class EagerExtractionModel implements IAIProvider {
  readonly id = "p14-extraction-model";
  readonly name = "P14 extraction model";
  readonly defaultModel = "p14";
  calls = 0;
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.calls++;
    const prompt = request.messages.map((m) => String(m.content ?? "")).join("\n");
    const candidates = [...prompt.matchAll(/^\[(M\d+)\] USER: (.+)$/gm)].map((m) => ({ type: "PREFERENCE", content: m[2]!, importance: 0.8, confidence: 1, source: m[1]!, evidence: m[2]! }));
    return { message: { role: "assistant", content: JSON.stringify({ candidates }) }, finishReason: "stop", model: this.defaultModel };
  }
  async listModels() {
    return [this.defaultModel];
  }
  async isAvailable() {
    return true;
  }
}

// ---------------------------------------------------------------------------
// The world: the container's wiring, with PostgreSQL underneath all of it
// ---------------------------------------------------------------------------

const STAMP = Date.now();
const userIds: string[] = [];

interface Reply {
  status: number;
  body: { success: boolean; data?: Record<string, any>; error?: { code: string; message: string } };
}

function buildWorld() {
  const approvalRepo = new db!.PrismaApprovalRepository(prisma!);
  const auditLogger = new AuditLogger(new db!.PrismaAuditRepository(prisma!));
  const journal = new db!.PrismaToolExecutionRepository(prisma!);
  const memoryRepository = new db!.PrismaMemoryRepository(prisma!);
  const conversationRepo = new db!.PrismaConversationRepository(prisma!);
  const projects = new db!.PrismaProjectRepository(prisma!);

  const memoryManagement = new mem!.MemoryManagementService({
    store: memoryRepository,
    control: new db!.PrismaPreferenceRepository(prisma!, "prefs:memory", "unreadable"),
    audit: auditLogger,
  });
  const extractionModel = new EagerExtractionModel();
  const writer = new mem!.MemoryExtractionService({
    aiProvider: extractionModel,
    store: memoryRepository,
    embeddingProvider: embeddings,
    maxRetries: 0,
    learningControl: { get: (userId) => memoryManagement.learningControl(userId) },
  });

  const port = routes!.port.createMemoryToolPort({ memoryManagement, conversations: conversationRepo, corrector: () => writer });
  const toolRegistry = new ToolRegistry();
  for (const tool of createMemoryTools(port, journal, approvalRepo)) toolRegistry.register(tool);
  toolRegistry.register(createMemoryCorrectionTool(port, journal, approvalRepo));
  toolRegistry.register(createMemoryRetentionTool(port));
  const executor = new ToolExecutor(toolRegistry, new PermissionService(), new ApprovalService(approvalRepo), auditLogger);
  const pendingActionService = new PendingActionService({ approvalRepo, toolRegistry });

  const chatModel = new ChatModel();
  const agents = new AgentRegistry();
  agents.register(new ConversationalAssistant({ provider: chatModel, systemPrompt: "You are JARVIS." }));
  const orchestrator = new Orchestrator(agents, executor, auditLogger, {
    memoryStore: memoryRepository,
    memoryExtractor: writer,
    embeddingProvider: embeddings,
    memoryControl: { get: (userId) => memoryManagement.learningControl(userId) },
    memory: { relevanceThreshold: FLOOR, maxMemories: 5, contextBudgetChars: 2000, extractionEnabled: true },
  });

  const tokens = new Map<string, string>();
  const tokenService = { verifyAccessToken: (t: string) => (tokens.has(t) ? { userId: tokens.get(t)!, role: "member", email: "x@test.local" } : null) } as never;
  const memoryCorrections = { check: (input: Parameters<typeof writer.checkCorrection>[0]) => writer.checkCorrection(input) };

  const app = express();
  app.use(express.json());
  app.use("/chat", routes!.chat.createChatRouter({ tokenService, conversationRepo, orchestrator, executor, pendingActionService, googleWrites: null, memoryManagement, projects, memoryCorrections }));
  app.use("/memories", routes!.memory.createMemoryRouter({ tokenService, memoryManagement, projects, conversationRepo, pendingActionService, memoryCorrections }));
  app.use("/projects", routes!.projects.createProjectsRouter({ tokenService, projects }));
  app.use("/pending-actions", routes!.pending.createPendingActionsRouter({ tokenService, pendingActionService, executor, toolRegistry, googleWrites: null } as never));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(userId: string, method: string, path: string, body?: unknown): Promise<Reply> {
    const token = `token-${userId}`;
    tokens.set(token, userId);
    const response = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Reply["body"] };
  }

  /** A new conversation, optionally in a project. Returns its id and a way to keep talking in it. */
  async function open(userId: string, message: string, projectId?: string) {
    const first = await call(userId, "POST", "/chat", { message, ...(projectId ? { projectId } : {}) });
    const conversationId = first.body.data?.conversationId as string;
    return { first, conversationId, say: (text: string) => call(userId, "POST", "/chat", { message: text, conversationId }) };
  }

  // The retention sweep, wired as the container wires it — narrowed to this
  // suite's users, because the test database is shared with other files.
  const retention = new mem!.MemoryRetentionSweep({
    candidates: async (before, limit) => (await memoryRepository.usersWithExpiredMemories(before, 500)).filter((id) => userIds.includes(id)).slice(0, limit),
    purge: async (userId) => {
      const run = await executor.execute({ toolId: MEMORY_PURGE_TOOL_ID, params: {}, userId, role: "member", traceId: randomUUID() });
      if (run.status !== "completed" || !run.result?.success) throw new Error("memory.purge_expired did not complete");
      return Number((run.result.data as { purged?: unknown } | undefined)?.purged ?? 0);
    },
  });

  return { call, open, chatModel, extractionModel, retention, close: () => server.close() };
}

async function newUser(tag: string): Promise<string> {
  const user = await prisma!.user.create({
    data: { email: `p14-e2e-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `P14 E2E ${tag}`, password: "not-a-real-password-hash", role: "MEMBER" },
  });
  userIds.push(user.id);
  return user.id;
}

interface MemoryRow {
  id: string;
  content: string;
  type: string;
  confidence: number;
  sourceType: string | null;
  sourceMessageId: string | null;
  projectId: string | null;
  expiresAt: Date | null;
  evidence: { count: number; revisions: number; previousSourceMessageIds: string[] } | undefined;
}

async function memoriesOf(userId: string): Promise<MemoryRow[]> {
  const rows = await prisma!.memory.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    type: r.type,
    confidence: r.confidence,
    sourceType: r.sourceType,
    sourceMessageId: r.sourceMessageId,
    projectId: r.projectId,
    expiresAt: r.expiresAt,
    evidence: (r.metadata as { evidence?: MemoryRow["evidence"] } | null)?.evidence,
  }));
}

/** Extraction is fire-and-forget: wait for what it should produce, never a fixed sleep. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const Q_MODE = "Which mode should the dashboard use?";
const Q_CAPTIONS = "Which captions should I write?";

// ---------------------------------------------------------------------------

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 14 — memory end to end (PostgreSQL, production classes)", () => {
  let world: ReturnType<typeof buildWorld>;
  let alice: string;
  let bob: string;
  let memoryId: string;
  let alpha: string;
  let beta: string;
  let projectMemoryId: string;

  beforeAll(async () => {
    // No fallback: without PostgreSQL every test below fails, here.
    if (!dbUp) throw new Error(`Phase 14 memory E2E needs PostgreSQL and has no in-memory fallback. ${dbFailure}`);
    world = buildWorld();
    alice = await newUser("alice");
    bob = await newUser("bob");
  });

  afterAll(async () => {
    world?.close();
    if (dbUp && userIds.length > 0) {
      const conversations = await prisma!.conversation.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      await prisma!.message.deleteMany({ where: { conversationId: { in: conversations.map((c) => c.id) } } });
      await prisma!.conversation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma!.toolExecution.deleteMany({ where: { userId: { in: userIds } } });
      await prisma!.approval.deleteMany({ where: { userId: { in: userIds } } });
      await prisma!.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma!.userSetting.deleteMany({ where: { userId: { in: userIds } } });
      await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma?.$disconnect();
  });

  it("runs on PostgreSQL — the store is the real repository, not a stand-in", async () => {
    expect(dbUp).toBe(true);
    expect((await prisma!.$queryRaw<Array<{ extname: string }>>`SELECT extname FROM pg_extension WHERE extname = 'vector'`).length).toBe(1);
  });

  it("steps 1–3: a stated preference is extracted and stored, with the user's own message as its source", async () => {
    const conversation = await world.open(alice, "I prefer dark mode");
    expect(conversation.first.status).toBe(200);

    const [stored] = await until(() => memoriesOf(alice), (rows) => rows.length === 1, "the memory to be stored");
    memoryId = stored!.id;

    const [saved] = await prisma!.message.findMany({ where: { conversationId: conversation.conversationId, role: "user" } });
    expect(stored).toMatchObject({ content: "I prefer dark mode", type: "PREFERENCE", sourceType: "USER", sourceMessageId: saved!.id, projectId: null });
    // The model said 1.0; what is stored is the evidence's 0.70.
    expect(stored!.confidence).toBe(0.7);
    expect(stored!.evidence).toMatchObject({ count: 1, revisions: 0 });
    expect(stored!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    // The vector column and the metadata copy were written together.
    const [aligned] = await prisma!.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT ("embedding" IS NOT NULL) AS ok FROM "Memory" WHERE "id" = $1`, memoryId);
    expect(aligned!.ok).toBe(true);
  });

  it("steps 4–6: a new conversation recalls it, and its confidence is available to its owner", async () => {
    const conversation = await world.open(alice, Q_MODE);
    expect(conversation.first.status).toBe(200);

    const sent = world.chatModel.lastContext();
    expect(sent).toContain("<user_memories>");
    expect(sent).toContain("[PREFERENCE] I prefer dark mode");
    // The user's message reaches the model exactly as typed (P0 layout).
    expect(world.chatModel.requests.at(-1)!.messages.at(-1)).toMatchObject({ role: "user", content: Q_MODE });

    const listed = await world.call(alice, "GET", "/memories");
    expect(listed.body.data!.memories).toHaveLength(1);
    expect(listed.body.data!.memories[0]).toMatchObject({ id: memoryId, content: "I prefer dark mode", confidence: 0.7, confidenceLevel: "MEDIUM", projectId: null, provenance: { source: "USER", statements: 1 } });
    expect(JSON.stringify(listed.body)).not.toMatch(/embedding|metadata|sourceMessageId/);

    // Step 7 begins in THIS conversation: its last reply was built on the memory.
    const proposal = await conversation.say("That's wrong. I prefer light mode.");
    const action = proposal.body.data!.pendingAction;
    expect(action).toMatchObject({ toolId: MEMORY_CORRECT_TOOL_ID, riskLevel: "HIGH_IMPACT" });
    expect(Object.keys(action.params).sort()).toEqual(["memoryId", "sourceMessageId", "version"]);
    expect(action.params.memoryId).toBe(memoryId);
    // Proposed, not done.
    expect((await memoriesOf(alice))[0]!.content).toBe("I prefer dark mode");

    const confirmed = await conversation.say("yes");
    expect(confirmed.body.data!.message).toContain("Action executed successfully");
  });

  it("steps 7–8: the correction replaced the memory — through ToolExecutor, with provenance and evidence — and is what is recalled", async () => {
    const rows = await memoriesOf(alice);
    expect(rows).toHaveLength(1);
    const corrected = rows[0]!;
    expect(corrected.id).toBe(memoryId);
    expect(corrected).toMatchObject({ content: "I prefer light mode.", type: "PREFERENCE", sourceType: "USER", projectId: null, confidence: 0.7 });
    expect(corrected.evidence).toMatchObject({ count: 1, revisions: 1 });
    expect(corrected.evidence!.previousSourceMessageIds).toHaveLength(1);

    // It points at the user's own correction message.
    const source = await prisma!.message.findUnique({ where: { id: corrected.sourceMessageId! } });
    expect(source).toMatchObject({ role: "user", content: "That's wrong. I prefer light mode." });

    // ToolExecutor ran it: one journal record, the approval consumed, audited by id.
    const executions = await prisma!.toolExecution.findMany({ where: { userId: alice, toolId: MEMORY_CORRECT_TOOL_ID } });
    expect(executions.map((e) => e.status)).toEqual(["SUCCEEDED"]);
    const approvals = await prisma!.approval.findMany({ where: { userId: alice, toolId: MEMORY_CORRECT_TOOL_ID } });
    expect(approvals).toHaveLength(1);
    expect(JSON.stringify(approvals[0]!.params)).not.toContain("light");
    const audit = await prisma!.auditLog.findMany({ where: { userId: alice, action: "memory.correct" } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.metadata)).not.toMatch(/light|dark/);

    // Step 8 — a new conversation: the corrected value, and not the old one.
    await world.open(alice, Q_MODE);
    const sent = world.chatModel.lastContext();
    expect(sent).toContain("[PREFERENCE] I prefer light mode.");
    expect(sent).not.toContain("dark mode");
  });

  it("steps 9–13: listed, asked to be forgotten, confirmed, deleted by ToolExecutor, and no longer recalled", async () => {
    const conversation = await world.open(alice, "Hello there");

    // 9 — the list.
    const listed = await conversation.say("show my memories");
    expect(listed.body.data!.message).toContain("1. I prefer light mode.");

    // 10 — a request, not a deletion.
    const proposal = await conversation.say("forget 1");
    expect(proposal.body.data!.pendingAction).toMatchObject({ toolId: "memory.forget", riskLevel: "HIGH_IMPACT", params: { memoryIds: [memoryId] } });
    expect(await memoriesOf(alice)).toHaveLength(1);

    // 11–12 — confirmed; ToolExecutor runs it.
    const confirmed = await conversation.say("yes");
    expect(confirmed.body.data!.message).toContain("Action executed successfully");
    expect(await memoriesOf(alice)).toEqual([]);
    expect((await prisma!.toolExecution.findMany({ where: { userId: alice, toolId: "memory.forget" } })).map((e) => e.status)).toEqual(["SUCCEEDED"]);

    // 13 — nothing to recall.
    const before = world.extractionModel.calls;
    await world.open(alice, Q_MODE);
    expect(world.chatModel.lastContext()).not.toContain("<user_memories>");
    expect(world.chatModel.lastContext()).not.toContain("light mode");
    // A question teaches nothing: the store stays empty.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(world.extractionModel.calls).toBe(before);
    expect(await memoriesOf(alice)).toEqual([]);
  });

  it("the memory screen's path: a correction asked for over the API is confirmed and executed the same way", async () => {
    await world.open(alice, "I always want my reports as a PDF");
    const [stored] = await until(() => memoriesOf(alice), (rows) => rows.length === 1, "the memory to be stored");

    // Not learnable: refused before anything is proposed.
    const refused = await world.call(alice, "POST", `/memories/${stored!.id}/correction`, { statement: "Remind me to call the printer tomorrow" });
    expect(refused.status).toBe(422);
    // Bob cannot even see it.
    expect((await world.call(bob, "GET", `/memories/${stored!.id}`)).status).toBe(404);
    expect((await world.call(bob, "POST", `/memories/${stored!.id}/correction`, { statement: "I prefer light mode" })).status).toBe(404);
    expect((await world.call(bob, "POST", `/memories/${stored!.id}/forget`)).status).toBe(404);

    const proposal = await world.call(alice, "POST", `/memories/${stored!.id}/correction`, { statement: "I always want my reports as a spreadsheet" });
    expect(proposal.status).toBe(202);
    const { pendingAction, conversationId } = proposal.body.data!;
    expect((await memoriesOf(alice))[0]!.content).toBe("I always want my reports as a PDF");

    // The existing on-screen confirmation endpoint — unchanged — runs it.
    const confirmed = await world.call(alice, "POST", `/pending-actions/${pendingAction.id}/confirm`, { conversationId });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data!.executionResult).toMatchObject({ status: "completed", result: { success: true } });

    const [after] = await memoriesOf(alice);
    expect(after).toMatchObject({ id: stored!.id, content: "I always want my reports as a spreadsheet", sourceType: "USER" });
    expect(after!.evidence).toMatchObject({ revisions: 1 });

    // The same approval cannot be used again.
    const again = await world.call(alice, "POST", `/pending-actions/${pendingAction.id}/confirm`, { conversationId });
    expect(again.status).toBe(404);

    // And the screen's forget request, confirmed, deletes it.
    const forget = await world.call(alice, "POST", `/memories/${stored!.id}/forget`);
    expect(forget.status).toBe(202);
    expect(await memoriesOf(alice)).toHaveLength(1);
    await world.call(alice, "POST", `/pending-actions/${forget.body.data!.pendingAction.id}/confirm`, { conversationId: forget.body.data!.conversationId });
    expect(await memoriesOf(alice)).toEqual([]);
  });

  it("steps 14–15: a project memory is created in its project and recalled there", async () => {
    alpha = (await world.call(alice, "POST", "/projects", { name: "Alpha" })).body.data!.project.id;
    beta = (await world.call(alice, "POST", "/projects", { name: "Beta" })).body.data!.project.id;

    await world.open(alice, "I prefer playful captions", alpha);
    const [stored] = await until(() => memoriesOf(alice), (rows) => rows.length === 1, "the project memory to be stored");
    projectMemoryId = stored!.id;
    expect(stored).toMatchObject({ content: "I prefer playful captions", projectId: alpha, sourceType: "USER" });

    await world.open(alice, Q_CAPTIONS, alpha);
    expect(world.chatModel.lastContext()).toContain("[PREFERENCE] I prefer playful captions");

    // The owner sees which project it belongs to.
    const listed = await world.call(alice, "GET", `/memories?project=${alpha}`);
    expect(listed.body.data!.memories).toEqual([expect.objectContaining({ id: projectMemoryId, projectId: alpha, projectName: "Alpha" })]);
    expect((await world.call(alice, "GET", "/memories?project=personal")).body.data!.memories).toEqual([]);
  });

  it("step 16: another project, and no project, cannot recall it", async () => {
    await world.open(alice, Q_CAPTIONS, beta);
    expect(world.chatModel.lastContext()).not.toContain("playful");

    const personal = await world.open(alice, Q_CAPTIONS);
    expect(world.chatModel.lastContext()).not.toContain("playful");

    // Not through the list either: what a conversation lists is saved in its history.
    expect((await personal.say("show my memories")).body.data!.message).not.toContain("playful");

    // A conversation cannot be moved into the project to reach it.
    const forged = await world.call(alice, "POST", "/chat", { message: Q_CAPTIONS, conversationId: personal.conversationId, projectId: alpha });
    expect(forged.status).toBe(409);
  });

  it("step 17: another user cannot recall it — not even naming the project", async () => {
    const forged = await world.call(bob, "POST", "/chat", { message: Q_CAPTIONS, projectId: alpha });
    expect(forged.status).toBe(404);
    expect(forged.body.error!.code).toBe("PROJECT_NOT_FOUND");

    await world.open(bob, Q_CAPTIONS);
    expect(world.chatModel.lastContext()).not.toContain("playful");

    expect((await world.call(bob, "GET", `/memories?project=${alpha}`)).status).toBe(404);
    expect((await world.call(bob, "GET", "/memories")).body.data!.memories).toEqual([]);
    expect((await world.call(bob, "GET", `/memories/${projectMemoryId}`)).status).toBe(404);
    expect((await world.call(bob, "GET", "/projects")).body.data!.projects).toEqual([]);
    // Nothing of Bob's was created by any of this.
    expect(await memoriesOf(bob)).toEqual([]);
  });

  it("step 18: once it has expired it is not recalled — at once, before anything is purged", async () => {
    await prisma!.$executeRawUnsafe(`UPDATE "Memory" SET "expiresAt" = now() - interval '1 hour' WHERE "id" = $1`, projectMemoryId);

    await world.open(alice, Q_CAPTIONS, alpha);
    expect(world.chatModel.lastContext()).not.toContain("playful");

    // Hidden from the default list, still there for its owner to see as expired.
    expect((await world.call(alice, "GET", "/memories")).body.data!.memories).toEqual([]);
    const withExpired = await world.call(alice, "GET", "/memories?includeExpired=true");
    expect(withExpired.body.data!.memories).toEqual([expect.objectContaining({ id: projectMemoryId, expired: true })]);
    expect((await world.call(alice, "GET", "/memories/status")).body.data).toMatchObject({ active: 0, expired: 1, retention: { days: 90, purgeGraceDays: 30 } });
    // Within its grace period the sweep leaves it alone.
    expect(await world.retention.sweep()).toEqual({ users: 0, deleted: 0, failed: 0 });
    expect(await memoriesOf(alice)).toHaveLength(1);
  });

  it("step 19: the retention sweep removes the long-expired row — through ToolExecutor, for its own user only", async () => {
    await prisma!.$executeRawUnsafe(`UPDATE "Memory" SET "expiresAt" = now() - interval '40 days' WHERE "id" = $1`, projectMemoryId);
    // Bob's memory expired only recently, and one of his never expires: both stay.
    const recent = await prisma!.memory.create({ data: { userId: bob, type: "FACT", content: "expired two days ago", importance: 0.5, confidence: 0.7, expiresAt: new Date(Date.now() - 2 * 86_400_000) } });
    const forever = await prisma!.memory.create({ data: { userId: bob, type: "FACT", content: "never expires", importance: 0.5, confidence: 0.7, expiresAt: null } });

    expect(await world.retention.sweep()).toEqual({ users: 1, deleted: 1, failed: 0 });

    expect(await memoriesOf(alice)).toEqual([]);
    expect((await memoriesOf(bob)).map((m) => m.id).sort()).toEqual([recent.id, forever.id].sort());

    // Audited: the executor's own row for the tool, and the purge by count.
    const purge = await prisma!.auditLog.findMany({ where: { userId: alice, action: "memory.retention_purge" } });
    expect(purge.map((a) => a.metadata)).toEqual([{ deleted: 1 }]);
    expect(await prisma!.auditLog.count({ where: { userId: alice, toolId: MEMORY_PURGE_TOOL_ID } })).toBeGreaterThanOrEqual(1);
    expect(await prisma!.auditLog.count({ where: { userId: bob, action: "memory.retention_purge" } })).toBe(0);

    // Nothing left to do.
    expect(await world.retention.sweep()).toEqual({ users: 0, deleted: 0, failed: 0 });
  });

  it("across the whole journey, memory was written only by the extraction service and deleted only through ToolExecutor", async () => {
    // Every deletion and every correction of Alice's has a journal record.
    const executions = await prisma!.toolExecution.findMany({ where: { userId: alice }, select: { toolId: true, status: true } });
    const byTool = (toolId: string) => executions.filter((e) => e.toolId === toolId).map((e) => e.status);
    expect(byTool(MEMORY_CORRECT_TOOL_ID)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(byTool("memory.forget")).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    // No approval was left usable.
    expect(await prisma!.approval.count({ where: { userId: alice, status: { in: ["PENDING", "APPROVED"] } } })).toBe(0);
    // No memory content, embedding or secret reached an audit row.
    const audit = JSON.stringify(await prisma!.auditLog.findMany({ where: { userId: { in: userIds } } }));
    for (const content of ["dark mode", "light mode", "playful captions", "spreadsheet"]) expect(audit, content).not.toContain(content);
  });
});
