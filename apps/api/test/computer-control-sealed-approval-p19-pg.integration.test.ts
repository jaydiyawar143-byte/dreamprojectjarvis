// ---------------------------------------------------------------------------
// Phase 19, Stage 19.5 — a browser write from request to execution, with
// nothing typed left behind (S3), on PostgreSQL.
//
// The production pieces, together: the chat's PendingActionService creates the
// approval through the Prisma approval store, which keeps only the value-free
// record and seals the exact parameters with the deployment's key; another
// owner or admin approves it; the requester's confirmation reads the waiting
// action back — exactly what was typed — and ToolExecutor runs the browser
// tool, which consumes the approval in PostgreSQL and types into the page.
// Afterwards no row anywhere — approval, sealed parameters, audit, journal —
// holds what was typed, and the Approvals page still says what was asked.
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one. It assigns the
// deployment's browser connection to an Organization of its own, holding the
// connection's lock while it does.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { BrowserRuntimePort, BrowserSessionPort, ToolAccessGate } from "@jarvis/core";
import { PendingActionService } from "@jarvis/agents";
import { BrowserTypeTool, ToolExecutor, ToolRegistry } from "@jarvis/tools";
import { ApprovalService, AuditLogger, generateKey } from "@jarvis/security";

import { createApprovalParamsSealer } from "../src/services/approval-sealer.js";
import { buildApprovalSummary } from "../src/services/approval-summary.js";
import { holdSharedConnection, type SharedConnectionLease } from "./helpers/shared-connection-lock.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Db = typeof import("@jarvis/db");
let db: Db | null = null;
let prisma: InstanceType<Db["PrismaClient"]> | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  prisma = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SECRET = `hunter2-TYPED-${STAMP}`;
const TOKEN = `tok-${STAMP}`;
const PARAMS = { url: `https://shop.example/login?token=${TOKEN}`, selector: "#password", text: SECRET };
const BROWSER = { providerId: "browser", connector: "service" } as const;
const ROLES = ["owner", "admin"] as Array<"owner" | "admin">;

const userIds: string[] = [];
const tenantIds: string[] = [];
const ids = { actor: "", owner: "", requester: "", approver: "" };
let ORG = "";
let lease: SharedConnectionLease | null = null;

/** A browser that records what it was asked to type. */
class RecordingBrowser implements BrowserRuntimePort {
  typed: Array<{ selector: string; text: string }> = [];
  async withSession<T>(_userId: string, run: (session: BrowserSessionPort) => Promise<T>): Promise<T> {
    const page = { url: "https://shop.example/login", title: "Login", status: 200 };
    const session = {
      navigate: async (url: string) => ({ ...page, url, redirected: false }),
      type: async (selector: string, text: string) => {
        this.typed.push({ selector, text });
        return { ...page, selector, navigated: false };
      },
    } as unknown as BrowserSessionPort;
    return run(session);
  }
  async shutdown() {}
}

function services(sealed = true) {
  const sealer = sealed ? createApprovalParamsSealer({ JARVIS_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv) : null;
  const approvals = new db!.PrismaApprovalRepository(prisma!, sealer ? { sealer } : {});
  const browser = new RecordingBrowser();
  const registry = new ToolRegistry();
  const tool = new BrowserTypeTool(browser, new db!.PrismaToolExecutionRepository(prisma!), approvals, {
    resolveWriteScope: async () => ({
      ok: true,
      tenantScope: { tenantId: ORG, ...BROWSER, requesterRoles: ROLES, approverRoles: ROLES },
    }),
  });
  registry.register(tool);
  const allow: ToolAccessGate = { check: async () => ({ allowed: true }) };
  const executor = new ToolExecutor(
    registry,
    { hasPermission: () => true },
    new ApprovalService(approvals),
    new AuditLogger(new db!.PrismaAuditRepository(prisma!)),
    { accessGate: allow }
  );
  const pending = new PendingActionService({ approvalRepo: approvals, toolRegistry: registry });
  return { approvals, browser, executor, pending };
}

const KEY = generateKey();

async function everythingStored(approvalId: string): Promise<string> {
  const rows = await prisma!.$queryRaw<unknown[]>`
    SELECT row_to_json(a)::text AS "approval", row_to_json(s)::text AS "sealed"
    FROM "Approval" a LEFT JOIN "ApprovalSealedParams" s ON s."approval_id" = a."id"
    WHERE a."id" = ${approvalId}`;
  const audit = await prisma!.auditLog.findMany({ where: { userId: { in: userIds } } });
  const journal = await prisma!.toolExecution.findMany({ where: { userId: { in: userIds } } });
  return JSON.stringify({ rows, audit, journal });
}

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) throw new Error("These security tests need a separate PostgreSQL test database, and none could be reached.");
  lease = await holdSharedConnection("browser/service");
  const taken = await prisma!.automationConnectorOwner.findUnique({
    where: { providerId_connector: { providerId: BROWSER.providerId, connector: BROWSER.connector } },
  });
  if (taken) throw new Error("browser/service is already assigned on this database — run this suite against a fresh test database");
  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const user = await prisma!.user.create({
      data: { email: `p195-api-${name}-${STAMP}@jarvis-test.local`, name: `User ${name}`, password: "x", role: "OWNER" },
    });
    ids[name] = user.id;
    userIds.push(user.id);
  }
  const run = async (command: Parameters<Db["runTenantAdminCommand"]>[1]) => {
    const result = await db!.runTenantAdminCommand(prisma!, command, { actorUserId: ids.actor, execute: true });
    if (!result.ok) throw new Error(`${command.verb} refused: ${result.code}`);
    return result;
  };
  ORG = String((await run({ verb: "create-tenant", name: `Org ${STAMP}`, ownerUserId: ids.owner })).detail.tenantId);
  tenantIds.push(ORG);
  await run({ verb: "add-member", tenantId: ORG, userId: ids.requester, role: "admin" });
  await run({ verb: "add-member", tenantId: ORG, userId: ids.approver, role: "admin" });
  await run({ verb: "assign-connector", providerId: BROWSER.providerId, connector: BROWSER.connector, tenantId: ORG });
});

afterAll(async () => {
  if (prisma) {
    await prisma.approval.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.automationConnectorOwner.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  await lease?.release();
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.5 — a browser write keeps nothing typed, end to end (PostgreSQL)", () => {
  it("is asked for, approved by another admin, run with exactly what was typed — and leaves none of it stored", async () => {
    const { approvals, browser, executor, pending } = services();
    const conversationId = `conv-${STAMP}`;

    // The chat asks for it.
    const { pendingAction, message } = await pending.createPendingAction({
      conversationId,
      userId: ids.requester,
      toolId: "browser.type",
      action: "browser.type",
      params: PARAMS,
      riskLevel: "LOW_IMPACT",
    });
    expect(message).toContain("Type into a field on https://shop.example.");
    expect(message).not.toContain(SECRET);
    const stored = await everythingStored(pendingAction.approvalId);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(TOKEN);

    // Another admin of the Organization approves it.
    expect(await approvals.decideApproval(pendingAction.approvalId, ids.approver, "approve", { approverRoles: ROLES })).toEqual({
      outcome: "approved",
    });

    // The requester confirms: the waiting action is read back, exactly.
    const waiting = await pending.getActivePendingAction(conversationId, ids.requester);
    expect(waiting?.params).toEqual(PARAMS);
    const result = await executor.execute({
      toolId: "browser.type",
      params: waiting!.params,
      userId: ids.requester,
      role: "owner",
      conversationId,
      approvalId: waiting!.approvalId,
      traceId: `trace-${STAMP}`,
    });
    expect(result.status, result.error).toBe("completed");
    expect(browser.typed).toEqual([{ selector: "#password", text: SECRET }]);

    // Nothing typed is stored anywhere, and the sealed copy is gone.
    expect(await prisma!.approvalSealedParams.findUnique({ where: { approvalId: pendingAction.approvalId } })).toBeNull();
    expect((await prisma!.approval.findUnique({ where: { id: pendingAction.approvalId } }))?.status).toBe("CONSUMED");
    const after = await everythingStored(pendingAction.approvalId);
    expect(after).not.toContain(SECRET);
    expect(after).not.toContain(TOKEN);

    // The Approvals page still says what was asked, from the record alone.
    const listed = (await approvals.listByUser(ids.requester, { limit: 100 })).items.find((a) => a.id === pendingAction.approvalId)!;
    expect(buildApprovalSummary(listed.toolId, listed.params)).toMatchObject({
      actionSummary: "Type into a field on https://shop.example.",
      targetResource: "https://shop.example",
    });

    // And the same approval cannot run a second time.
    const again = await executor.execute({
      toolId: "browser.type",
      params: PARAMS,
      userId: ids.requester,
      role: "owner",
      approvalId: waiting!.approvalId,
      traceId: `trace-again-${STAMP}`,
    });
    expect(again.status).not.toBe("completed");
    expect(browser.typed).toHaveLength(1);
  });

  it("is never asked for at all where nothing can seal it, and nothing is written", async () => {
    const { pending } = services(false);
    const before = await prisma!.approval.count({ where: { userId: ids.requester } });
    await expect(
      pending.createPendingAction({
        conversationId: `conv-unsealed-${STAMP}`,
        userId: ids.requester,
        toolId: "browser.type",
        action: "browser.type",
        params: PARAMS,
        riskLevel: "LOW_IMPACT",
      })
    ).rejects.toBeInstanceOf(db!.ApprovalParamsSealingUnavailableError);
    expect(await prisma!.approval.count({ where: { userId: ids.requester } })).toBe(before);
  });
});
