// ---------------------------------------------------------------------------
// Atomic pending-action resolution (pre-PR fix after the Phase 14 re-audit).
//
// THE RACE. Confirm, Cancel and Modify each read the waiting action and then
// wrote its status in a second, unconditional step. Two of them that had both
// read "waiting" both wrote: in 41 of 100 simultaneous trials a Cancel was told
// it had succeeded and the action was then approved and run anyway.
//
// THE CONTRACT. Resolving a waiting action is ONE conditional UPDATE in
// PostgreSQL (PrismaApprovalRepository.decideApproval; `fromPendingOnly` for a
// cancel). It changes the row only while it is still PENDING and unexpired, so
// of any two answers to the same action exactly one wins, across connection
// pools as across requests. The other is told the truth (409
// PENDING_ACTION_ALREADY_RESOLVED) and changes nothing. A cancelled action
// never reaches a tool; a confirmed one runs at most once.
//
// DETERMINISM. Every race here is forced, not hoped for. A barrier holds each
// competitor just after it has read the action as waiting, so both have seen it
// before either writes — the interleaving that used to break. Ordered variants
// then choose who writes first; repeated variants release both writes together
// and leave the choice to PostgreSQL's row lock. No assertion depends on time.
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one. With none configured
// it is skipped (CI fails a skipped database test); with
// JARVIS_REQUIRE_POSTGRES=1, or a database that cannot be reached, it fails.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { IToolExecutor, ToolExecutionRequest, ToolExecutionResult } from "@jarvis/core";
import { PendingActionService, PendingActionConflictError } from "@jarvis/agents";
import { ToolExecutor, ToolRegistry, createMemoryTools, type MemoryToolPort } from "@jarvis/tools";
import { ApprovalService, AuditLogger, PermissionService } from "@jarvis/security";
import { createPendingActionsRouter } from "../src/routes/pending-actions.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Db = typeof import("@jarvis/db");
let db: Db | null = null;
let prisma: InstanceType<Db["PrismaClient"]> | null = null;
/** A second connection pool: a second API instance answering the same action. */
let otherInstance: InstanceType<Db["PrismaClient"]> | null = null;
let dbUp = false;
let dbFailure = "DATABASE_URL is not set to a separate test database (never port 5432 or 5433).";
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  prisma = new db.PrismaClient();
  otherInstance = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    await otherInstance.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbFailure = "DATABASE_URL is set, but PostgreSQL cannot be reached.";
  }
}

type Repo = InstanceType<Db["PrismaApprovalRepository"]>;
type Decision = "approve" | "reject";

const STAMP = Date.now();
const userIds: string[] = [];
let conversations = 0;
const FORGET = { memoryIds: ["m-1"], versions: ["2026-10-01T00:00:00.000Z"] };
const BUDGET = { campaignId: "c-1", dailyBudget: 5000 };

async function newUser(tag: string): Promise<string> {
  const user = await prisma!.user.create({
    data: { email: `atomic-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `Atomic ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(user.id);
  return user.id;
}

const newConversation = () => `conv-atomic-${STAMP}-${++conversations}`;
const statusOf = async (id: string) => (await prisma!.approval.findUnique({ where: { id }, select: { status: true } }))!.status;

/** Resolves for every party once `parties` of them have arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return () => {
    arrived++;
    if (arrived === parties) open();
    return opened;
  };
}

/** The `first` decision writes first; the other waits until it has finished. */
function writesFirst(first: Decision) {
  let done!: () => void;
  const firstDone = new Promise<void>((resolve) => (done = resolve));
  return {
    beforeWrite: async (decision: Decision) => {
      if (decision !== first) await firstDone;
    },
    afterWrite: (decision: Decision) => {
      if (decision === first) done();
    },
  };
}

interface Hooks {
  /** After the waiting action has been read. */
  afterRead?: () => Promise<void>;
  /** Just before the conditional write that resolves it. */
  beforeWrite?: (decision: Decision) => Promise<void>;
  afterWrite?: (decision: Decision) => void;
}

/** The real repository, with the two points a race needs to hold. */
function instrumented(repo: Repo, hooks: Hooks) {
  return {
    create: (data: Parameters<Repo["create"]>[0]) => repo.create(data),
    findById: (id: string) => repo.findById(id),
    updateStatus: (...args: Parameters<Repo["updateStatus"]>) => repo.updateStatus(...args),
    updateParams: (...args: Parameters<Repo["updateParams"]>) => repo.updateParams(...args),
    async findPendingByConversationId(conversationId: string, userId: string) {
      const found = await repo.findPendingByConversationId(conversationId, userId);
      await hooks.afterRead?.();
      return found;
    },
    async decideApproval(...args: Parameters<Repo["decideApproval"]>) {
      await hooks.beforeWrite?.(args[2]);
      try {
        return await repo.decideApproval(...args);
      } finally {
        hooks.afterWrite?.(args[2]);
      }
    },
  };
}

const registry = { get: () => undefined, getAll: () => [] };

/** One service per API instance, each on its own connection pool, sharing the race's hooks. */
function twoInstances(hooks: Hooks) {
  return {
    a: new PendingActionService({ approvalRepo: instrumented(new db!.PrismaApprovalRepository(prisma!), hooks), toolRegistry: registry }),
    b: new PendingActionService({ approvalRepo: instrumented(new db!.PrismaApprovalRepository(otherInstance!), hooks), toolRegistry: registry }),
  };
}

async function waiting(userId: string, conversationId: string, toolId = "memory.forget", params: Record<string, unknown> = FORGET) {
  const plain = new PendingActionService({ approvalRepo: new db!.PrismaApprovalRepository(prisma!), toolRegistry: registry });
  return (await plain.createPendingAction({ conversationId, userId, toolId, action: `Run ${toolId}`, params, riskLevel: "HIGH_IMPACT" })).pendingAction;
}

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()!.close();
});

afterAll(async () => {
  if (dbUp && userIds.length > 0) {
    await prisma!.toolExecution.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.approval.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma?.$disconnect();
  await otherInstance?.$disconnect();
});

// ---------------------------------------------------------------------------
// The service: two API instances answer the same waiting action
// ---------------------------------------------------------------------------

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Atomic resolution — two API instances, one waiting action (PostgreSQL)", () => {
  let user: string;

  beforeAll(async () => {
    if (!dbUp) throw new Error(`The atomic pending-action tests need PostgreSQL. ${dbFailure}`);
    user = await newUser("service");
  });

  it.each(["approve", "reject"] as const)(
    "Confirm against Cancel, both having read it as waiting: the one that writes first (%s) wins, the other is refused and changes nothing",
    async (first) => {
      const conversationId = newConversation();
      const action = await waiting(user, conversationId);
      const { a, b } = twoInstances({ afterRead: barrier(2), ...writesFirst(first) });

      const [confirm, cancel] = await Promise.all([
        a.confirmPendingAction(conversationId, user, action.id),
        b.rejectPendingAction(conversationId, user, action.id),
      ]);

      const [winner, loser] = first === "approve" ? [confirm, cancel] : [cancel, confirm];
      expect(winner.success).toBe(true);
      expect(loser.success).toBe(false);
      expect(loser.reason).toBe("ALREADY_RESOLVED");
      expect(loser.message).toMatch(first === "approve" ? /already confirmed/ : /cancelled/);
      expect(await statusOf(action.id)).toBe(first === "approve" ? "APPROVED" : "REJECTED");
    }
  );

  it("Confirm and Cancel released together, 40 times: exactly one wins every time, and the row says which", async () => {
    const winners = { confirm: 0, cancel: 0 };
    for (let trial = 0; trial < 40; trial++) {
      const conversationId = newConversation();
      const action = await waiting(user, conversationId);
      const { a, b } = twoInstances({ afterRead: barrier(2) });

      const [confirm, cancel] = await Promise.all([
        a.confirmPendingAction(conversationId, user, action.id),
        b.rejectPendingAction(conversationId, user, action.id),
      ]);

      expect([confirm.success, cancel.success].filter(Boolean)).toHaveLength(1);
      const loser = confirm.success ? cancel : confirm;
      expect(loser.reason).toBe("ALREADY_RESOLVED");
      expect(await statusOf(action.id)).toBe(confirm.success ? "APPROVED" : "REJECTED");
      winners[confirm.success ? "confirm" : "cancel"]++;
    }
    expect(winners.confirm + winners.cancel).toBe(40);
  });

  it("two Confirms released together, 20 times: one confirms; the other is told it was already confirmed", async () => {
    for (let trial = 0; trial < 20; trial++) {
      const conversationId = newConversation();
      const action = await waiting(user, conversationId);
      const { a, b } = twoInstances({ afterRead: barrier(2) });

      const results = await Promise.all([a.confirmPendingAction(conversationId, user, action.id), b.confirmPendingAction(conversationId, user, action.id)]);

      expect(results.filter((r) => r.success)).toHaveLength(1);
      const loser = results.find((r) => !r.success)!;
      expect(loser.reason).toBe("ALREADY_RESOLVED");
      expect(loser.message).toMatch(/already confirmed/);
      expect(await statusOf(action.id)).toBe("APPROVED");
    }
  });

  it("two Cancels released together, 20 times: one cancels; the other is told it was already cancelled — not success", async () => {
    for (let trial = 0; trial < 20; trial++) {
      const conversationId = newConversation();
      const action = await waiting(user, conversationId);
      const { a, b } = twoInstances({ afterRead: barrier(2) });

      const results = await Promise.all([a.rejectPendingAction(conversationId, user, action.id), b.rejectPendingAction(conversationId, user, action.id)]);

      expect(results.filter((r) => r.success)).toHaveLength(1);
      const loser = results.find((r) => !r.success)!;
      expect(loser.reason).toBe("ALREADY_RESOLVED");
      expect(loser.message).toMatch(/already cancelled/);
      expect(await statusOf(action.id)).toBe("REJECTED");
    }
  });

  it.each(["approve", "reject"] as const)(
    "Confirm against Modify of a Meta write, both having read it as waiting (%s writes first): one wins; a losing Modify creates nothing, a losing Confirm approves nothing",
    async (first) => {
      const conversationId = newConversation();
      const action = await waiting(user, conversationId, "meta.campaign.budget.update", BUDGET);
      const { a, b } = twoInstances({ afterRead: barrier(2), ...writesFirst(first) });

      const [confirm, modify] = await Promise.allSettled([
        a.confirmPendingAction(conversationId, user, action.id),
        b.modifyPendingAction(conversationId, user, { dailyBudget: 3000 }, action.id),
      ]);

      const rows = await prisma!.approval.findMany({ where: { userId: user, conversationId }, orderBy: { createdAt: "asc" } });
      if (first === "approve") {
        expect(confirm.status === "fulfilled" && confirm.value.success).toBe(true);
        expect(modify.status).toBe("rejected");
        const error = (modify as PromiseRejectedResult).reason;
        expect(error).toBeInstanceOf(PendingActionConflictError);
        expect((error as PendingActionConflictError).reason).toBe("ALREADY_RESOLVED");
        expect(rows.map((r) => r.status)).toEqual(["APPROVED"]);
      } else {
        expect(modify.status).toBe("fulfilled");
        expect(confirm.status === "fulfilled" && confirm.value.success).toBe(false);
        expect(confirm.status === "fulfilled" && confirm.value.reason).toBe("ALREADY_RESOLVED");
        expect(rows.map((r) => r.status)).toEqual(["REJECTED", "PENDING"]);
        expect(rows[1]!.params).toEqual({ campaignId: "c-1", dailyBudget: 3000 });
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Over HTTP: the real executor, the real tool, approval consumption and audit
// ---------------------------------------------------------------------------

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Atomic resolution — over HTTP, through ToolExecutor, the tool and the audit log (PostgreSQL)", () => {
  beforeAll(() => {
    if (!dbUp) throw new Error(`The atomic pending-action tests need PostgreSQL. ${dbFailure}`);
  });

  interface Reply {
    status: number;
    body: { success: boolean; data?: Record<string, any>; error?: { code: string; message: string } };
  }

  /** The route as the API mounts it, over the real repository — with the race's hooks on its reads and writes. */
  function world(userId: string, hooks: Hooks, executorOverride?: IToolExecutor) {
    const repo = new db!.PrismaApprovalRepository(prisma!);
    const forgotten: string[][] = [];
    const port: MemoryToolPort = {
      async list() {
        return { memories: [], total: 0, hasMore: false };
      },
      async forget(_userId, targets) {
        forgotten.push(targets.map((t) => t.id));
        return { status: "FORGOTTEN", deleted: targets.length, notFound: 0 };
      },
      async forgetAll() {
        return { status: "NOTHING_TO_FORGET", deleted: 0 };
      },
    };
    const tools = new ToolRegistry();
    for (const tool of createMemoryTools(port, new db!.PrismaToolExecutionRepository(prisma!), repo)) tools.register(tool);
    const executor = executorOverride ?? new ToolExecutor(tools, new PermissionService(), new ApprovalService(repo), new AuditLogger(new db!.PrismaAuditRepository(prisma!)));
    const pending = new PendingActionService({ approvalRepo: instrumented(repo, hooks), toolRegistry: tools });
    const tokenService = { verifyAccessToken: (token: string) => (token === `token-${userId}` ? { userId, role: "member", email: "u@test.local" } : null) } as never;

    const app = express();
    app.use(express.json());
    app.use(
      "/pending-actions",
      createPendingActionsRouter({ tokenService, pendingActionService: pending, executor, toolRegistry: executorOverride ? { get: (id: string) => ({ id }) } : tools, googleWrites: null } as never)
    );
    const server = app.listen(0);
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    async function call(path: string, body: unknown): Promise<Reply> {
      const response = await fetch(base + path, {
        method: "POST",
        headers: { authorization: `Bearer token-${userId}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Reply["body"] };
    }
    return { call, executor, forgotten };
  }

  const audited = async (userId: string, result?: string) =>
    prisma!.auditLog.count({ where: { userId, toolId: "memory.forget", ...(result ? { result: result as never } : {}) } });

  it("Cancel writes first: Confirm is refused truthfully, the tool never runs, no run is audited — and the cancelled approval cannot be run later", async () => {
    const user = await newUser("http-cancel");
    const conversationId = newConversation();
    const action = await waiting(user, conversationId);
    const env = world(user, { afterRead: barrier(2), ...writesFirst("reject") });

    const [confirm, cancel] = await Promise.all([
      env.call(`/pending-actions/${action.id}/confirm`, { conversationId }),
      env.call(`/pending-actions/${action.id}/reject`, { conversationId }),
    ]);

    expect(cancel.status).toBe(200);
    expect(confirm.status).toBe(409);
    expect(confirm.body.success).toBe(false);
    expect(confirm.body.error?.code).toBe("PENDING_ACTION_ALREADY_RESOLVED");
    expect(confirm.body.data?.executionResult).toBeUndefined();
    expect(env.forgotten).toEqual([]);
    expect(await audited(user)).toBe(0);
    expect(await statusOf(action.id)).toBe("REJECTED");

    // Handed straight to the executor — a bug or a replay — it is still refused.
    const replay = await env.executor.execute({ toolId: "memory.forget", params: FORGET, userId: user, role: "member", traceId: "00000000-0000-4000-8000-00000000a701", approvalId: action.id });
    expect(replay.status).not.toBe("completed");
    expect(env.forgotten).toEqual([]);
    expect(await audited(user, "SUCCESS")).toBe(0);
  });

  it("Confirm writes first: the tool runs exactly once, Cancel is told it was already confirmed, and the audit records one run", async () => {
    const user = await newUser("http-confirm");
    const conversationId = newConversation();
    const action = await waiting(user, conversationId);
    const env = world(user, { afterRead: barrier(2), ...writesFirst("approve") });

    const [confirm, cancel] = await Promise.all([
      env.call(`/pending-actions/${action.id}/confirm`, { conversationId }),
      env.call(`/pending-actions/${action.id}/reject`, { conversationId }),
    ]);

    expect(confirm.status).toBe(200);
    expect(confirm.body.data?.executionResult).toMatchObject({ status: "completed", result: { success: true } });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error?.code).toBe("PENDING_ACTION_ALREADY_RESOLVED");
    expect(cancel.body.error?.message).toMatch(/already confirmed/);
    expect(env.forgotten).toEqual([["m-1"]]);
    expect(await audited(user, "SUCCESS")).toBe(1);
    expect(await statusOf(action.id)).toBe("CONSUMED");

    // Confirming it again, by the route or straight at the executor, runs nothing more.
    expect((await env.call(`/pending-actions/${action.id}/confirm`, { conversationId })).status).toBe(404);
    const replay = await env.executor.execute({ toolId: "memory.forget", params: FORGET, userId: user, role: "member", traceId: "00000000-0000-4000-8000-00000000a702", approvalId: action.id });
    expect(replay.status).not.toBe("completed");
    expect(env.forgotten).toEqual([["m-1"]]);
    expect(await audited(user, "SUCCESS")).toBe(1);
  });

  it("Confirm and Cancel released together, 20 times: the tool runs exactly when Confirm won, once, and never otherwise", async () => {
    const user = await newUser("http-together");
    let runs = 0;
    for (let trial = 0; trial < 20; trial++) {
      const conversationId = newConversation();
      const action = await waiting(user, conversationId);
      const env = world(user, { afterRead: barrier(2) });

      const [confirm, cancel] = await Promise.all([
        env.call(`/pending-actions/${action.id}/confirm`, { conversationId }),
        env.call(`/pending-actions/${action.id}/reject`, { conversationId }),
      ]);

      expect([confirm.status, cancel.status].sort()).toEqual([200, 409]);
      if (confirm.status === 200) {
        runs++;
        expect(env.forgotten).toHaveLength(1);
        expect(await statusOf(action.id)).toBe("CONSUMED");
      } else {
        expect(env.forgotten).toHaveLength(0);
        expect(await statusOf(action.id)).toBe("REJECTED");
      }
    }
    expect(await audited(user, "SUCCESS")).toBe(runs);
  });

  it("a Meta write resolves the same way: one winner, and the executor is called only when Confirm wins", async () => {
    const user = await newUser("http-meta");
    for (let trial = 0; trial < 10; trial++) {
      const conversationId = newConversation();
      const action = await waiting(user, conversationId, "meta.campaign.pause", { campaignId: "c-1" });
      const executed: ToolExecutionRequest[] = [];
      const recording: IToolExecutor = {
        async execute(request): Promise<ToolExecutionResult> {
          executed.push(request);
          return { executionId: "x", toolId: request.toolId, status: "completed", result: { success: true }, startedAt: new Date() };
        },
      };
      const env = world(user, { afterRead: barrier(2) }, recording);

      const [confirm, cancel] = await Promise.all([
        env.call(`/pending-actions/${action.id}/confirm`, { conversationId }),
        env.call(`/pending-actions/${action.id}/reject`, { conversationId }),
      ]);

      expect([confirm.status, cancel.status].sort()).toEqual([200, 409]);
      expect(executed).toHaveLength(confirm.status === 200 ? 1 : 0);
      if (confirm.status === 200) expect(executed[0]).toMatchObject({ toolId: "meta.campaign.pause", params: { campaignId: "c-1" }, approvalId: action.id });
    }
  });
});
