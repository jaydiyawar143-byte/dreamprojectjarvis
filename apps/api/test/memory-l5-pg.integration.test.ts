// S7.2 L5 — memory control end to end, on the REAL production classes and
// PostgreSQL + pgvector:
//
//   chat route → memory command → PendingActionService (PrismaApprovalRepository)
//   → "yes" → ToolExecutor → memory.forget / memory.forget_all
//   → approval CONSUMED with the journal claim (PrismaToolExecutionRepository)
//   → MemoryManagementService → PrismaMemoryRepository → the row is gone.
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client. The
// suite runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
import { describe, it, expect, afterAll } from "vitest";
import type { IOrchestrator, JarvisResponse } from "@jarvis/core";
import { PendingActionService } from "@jarvis/agents";
import { ToolExecutor, ToolRegistry, createMemoryTools } from "@jarvis/tools";
import { ApprovalService, AuditLogger, PermissionService } from "@jarvis/security";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

type Db = typeof import("@jarvis/db");
let db: Db | null = null;
let mem: typeof import("@jarvis/memory") | null = null;
let chat: typeof import("../src/routes/chat.js") | null = null;
let prisma: InstanceType<Db["PrismaClient"]> | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  mem = await import("@jarvis/memory");
  chat = await import("../src/routes/chat.js");
  prisma = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = Date.now();
const userIds: string[] = [];
const T0 = new Date("2026-09-01T10:00:00.000Z");
const DIMS = 1536;
const vector = (i: number) => `[${Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0)).join(",")}]`;

async function newUser(tag: string): Promise<string> {
  const u = await prisma!.user.create({
    data: { email: `s7-l5-api-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `L5 ${tag}`, password: "not-a-real-password-hash", role: "MEMBER" },
  });
  userIds.push(u.id);
  return u.id;
}

/** A learned memory, as L1–L4 leave it: USER provenance, v1 evidence, a vector. */
async function learned(userId: string, content: string, i: number): Promise<string> {
  const row = await prisma!.memory.create({
    data: {
      userId,
      type: "PREFERENCE",
      content,
      importance: 0.8,
      confidence: 0.7,
      sourceType: "USER",
      metadata: { evidence: { v: 1, count: 1, conversations: 1, firstSeenAt: T0.toISOString(), lastSeenAt: T0.toISOString(), sources: [], revisions: 0, previousSourceMessageIds: [] } },
    },
  });
  await prisma!.$executeRawUnsafe('UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2', vector(i), row.id);
  return row.id;
}

function world() {
  const approvalRepo = new db!.PrismaApprovalRepository(prisma!);
  const auditLogger = new AuditLogger(new db!.PrismaAuditRepository(prisma!));
  const memoryManagement = new mem!.MemoryManagementService({
    store: new db!.PrismaMemoryRepository(prisma!),
    control: new db!.PrismaPreferenceRepository(prisma!, "prefs:memory"),
    audit: auditLogger,
  });
  const registry = new ToolRegistry();
  for (const tool of createMemoryTools(memoryManagement, new db!.PrismaToolExecutionRepository(prisma!), approvalRepo)) registry.register(tool);
  const executor = new ToolExecutor(registry, new PermissionService(), new ApprovalService(approvalRepo), auditLogger);
  const orchestrator: IOrchestrator = {
    async process(_request, context): Promise<JarvisResponse> {
      return { success: true, data: { message: "Hello.", conversationId: context.conversationId ?? "", agentId: "conversational-assistant" }, traceId: context.traceId, timestamp: new Date().toISOString() };
    },
  };
  const tokens = new Map<string, string>();
  const router = chat!.createChatRouter({
    tokenService: {
      verifyAccessToken: (t: string) => (tokens.has(t) ? { userId: tokens.get(t)!, role: "member", email: "x@test.local" } : null),
    } as never,
    conversationRepo: new db!.PrismaConversationRepository(prisma!),
    orchestrator,
    executor,
    pendingActionService: new PendingActionService({ approvalRepo, toolRegistry: registry }),
    googleWrites: null,
    memoryManagement,
  });
  return { router, tokens };
}

type Reply = { status: number; body: { success: boolean; data?: { message?: string; conversationId?: string; pendingAction?: Record<string, unknown> } } };

function post(env: ReturnType<typeof world>, userId: string, body: Record<string, unknown>): Promise<Reply> {
  const token = `token-${userId}`;
  env.tokens.set(token, userId);
  return new Promise((resolve) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
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
    const layer = (env.router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => void }> } }> }).stack.find(
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

async function conversationFor(env: ReturnType<typeof world>, userId: string) {
  const opened = await post(env, userId, { message: "Hello" });
  const conversationId = opened.body.data!.conversationId!;
  return (message: string) => post(env, userId, { message, conversationId });
}

async function exists(memoryId: string): Promise<boolean> {
  const [row] = await prisma!.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "Memory" WHERE "id" = $1`, memoryId);
  return Number(row!.n) === 1;
}

afterAll(async () => {
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

describe.skipIf(!dbUp)("S7.2 L5 — memory control end to end (PostgreSQL)", () => {
  it("list → forget 2 → yes: ToolExecutor runs memory.forget, the approval is consumed once, and exactly that row (with its vector) is gone", async () => {
    const env = world();
    const u = await newUser("forget");
    const keep = await learned(u, "User prefers short captions", 1);
    const drop = await learned(u, "User works late", 2);
    const say = await conversationFor(env, u);

    // The number is whatever the list showed (newest first) — read it, never assume it.
    const listed = await say("show my memories");
    const position = listed.body.data!.message!.split("\n").find((line) => line.endsWith("User works late"))!.split(".")[0];
    const proposal = await say(`forget ${position}`);
    expect(proposal.body.data!.pendingAction).toMatchObject({ toolId: "memory.forget", params: { memoryIds: [drop] }, state: "WAITING_CONFIRMATION" });
    expect(await exists(drop)).toBe(true);

    const confirmed = await say("yes");

    expect(confirmed.body.data!.message).toMatch(/executed successfully/i);
    expect(await exists(drop)).toBe(false);
    expect(await exists(keep)).toBe(true);
    const approval = await prisma!.approval.findUnique({ where: { id: proposal.body.data!.pendingAction!.approvalId as string } });
    expect(approval!.status).toBe("CONSUMED");
    const executions = await prisma!.toolExecution.findMany({ where: { userId: u, toolId: "memory.forget" } });
    expect(executions.map((e) => e.status)).toEqual(["SUCCEEDED"]);

    const audit = await prisma!.auditLog.findMany({ where: { userId: u }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["memory.command", "tool.execute", "memory.forget"]));
    const text = JSON.stringify(audit);
    for (const forbidden of ["captions", "works late"]) expect(text, forbidden).not.toContain(forbidden);
  });

  it("forget everything: a loose \"yes\" deletes nothing; \"yes, forget all\" forgets every memory of this user only", async () => {
    const env = world();
    const u = await newUser("all");
    const other = await newUser("all-other");
    await learned(u, "User prefers short captions", 3);
    await learned(u, "User works late", 4);
    const theirs = await learned(other, "User prefers dark mode", 5);
    const say = await conversationFor(env, u);

    await say("forget everything you remember about me");
    await say("yes");
    expect(await prisma!.memory.count({ where: { userId: u } })).toBe(2);

    await say("yes, forget all");
    expect(await prisma!.memory.count({ where: { userId: u } })).toBe(0);
    expect(await exists(theirs)).toBe(true);
  });

  it("a memory that changed between proposal and confirmation is not deleted", async () => {
    const env = world();
    const u = await newUser("stale");
    const id = await learned(u, "User prefers short captions", 6);
    const say = await conversationFor(env, u);

    await say("show my memories");
    await say("forget 1");
    await prisma!.$executeRawUnsafe(`UPDATE "Memory" SET "content" = 'User prefers long captions', "updatedAt" = now() + interval '1 second' WHERE "id" = $1`, id);
    const confirmed = await say("yes");

    expect(confirmed.body.data!.message).toMatch(/changed/i);
    expect(await exists(id)).toBe(true);
    const executions = await prisma!.toolExecution.findMany({ where: { userId: u, toolId: "memory.forget" } });
    expect(executions.map((e) => e.status)).toEqual(["FAILED"]);
  });

  it("another user cannot confirm, or even reach, a memory action in someone else's conversation", async () => {
    const env = world();
    const u = await newUser("owner");
    const intruder = await newUser("intruder");
    const id = await learned(u, "User prefers short captions", 7);
    const say = await conversationFor(env, u);
    await say("show my memories");
    const proposal = await say("forget 1");

    const attempt = await post(env, intruder, { message: "yes", conversationId: proposal.body.data!.conversationId });

    expect(attempt.status).toBe(404);
    expect(await exists(id)).toBe(true);
    const approval = await prisma!.approval.findUnique({ where: { id: proposal.body.data!.pendingAction!.approvalId as string } });
    expect(approval!.status).toBe("PENDING");
  });
});
