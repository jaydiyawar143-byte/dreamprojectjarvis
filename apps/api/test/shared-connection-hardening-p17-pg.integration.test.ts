// Phase 17 multi-business hardening (review finding H2) — a Meta write through
// the deployment's shared connection, end to end, on REAL PostgreSQL.
//
//   ToolExecutor (access gate) → MetaPauseCampaignTool (Organization Meta
//   authorizer) → PrismaApprovalRepository (Organization-scoped approvals,
//   independent decision, scoped consumption) → mock Meta provider
//
//   POST /approvals/:id/approve, POST /pending-actions/:id/confirm — the real
//   routers, over HTTP.
//
// The only doubles are the session tokens and the Meta provider, which is the
// in-memory mock with its read and write spied on, so every test can say
// exactly what reached it. Tenants, memberships and the connection's owner are
// written by the operator command, as an operator would.
//
// What it proves that the suites with fakes cannot:
//   1. an outsider can neither read nor change the shared Meta account, and a
//      viewer cannot ask for a change — nothing reaches the provider, and no
//      approval is created for either;
//   2. the requester cannot approve their own change — on the Approvals page
//      or in the chat — and the approval belongs to the Organization;
//   3. an independent approval is bound to the exact action and parameters and
//      runs once;
//   4. a membership demoted, an approver removed, or the connection moved
//      after the approval stops the write at execution time;
//   5. the chat's pending action waits for the approver, then runs on the
//      requester's confirm.
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client. The
// suite runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one. Everything it creates
// is removed afterwards.
//
// NEVER SKIPPED QUIETLY. With no database configured it is reported as skipped
// (CI fails on a skipped database test). A database that was configured and
// cannot be reached FAILS it — and so does none at all under
// JARVIS_REQUIRE_POSTGRES=1, as CI's database steps set.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Db = typeof import("@jarvis/db");
type Security = typeof import("@jarvis/security");
type Tools = typeof import("@jarvis/tools");
type Agents = typeof import("@jarvis/agents");
type Client = InstanceType<Db["PrismaClient"]>;

let db: Db | null = null;
let security: Security | null = null;
let tools: Tools | null = null;
let agents: Agents | null = null;
let access: typeof import("../src/services/tenancy/shared-connection-access.js") | null = null;
let metaAccess: typeof import("../src/services/tenancy/meta-ads-access.js") | null = null;
let approvalsRoute: typeof import("../src/routes/approvals.js") | null = null;
let pendingRoute: typeof import("../src/routes/pending-actions.js") | null = null;
let prisma: Client | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  security = await import("@jarvis/security");
  tools = await import("@jarvis/tools");
  agents = await import("@jarvis/agents");
  access = await import("../src/services/tenancy/shared-connection-access.js");
  metaAccess = await import("../src/services/tenancy/meta-ads-access.js");
  approvalsRoute = await import("../src/routes/approvals.js");
  pendingRoute = await import("../src/routes/pending-actions.js");
  prisma = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

/**
 * This suite holds the Meta connection's ONE owner row while it runs, under a
 * lease another suite that needs it waits for (helpers/shared-connection-lock).
 */
let lease: import("./helpers/shared-connection-lock.js").SharedConnectionLease | null = null;

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACCOUNT = "act_111111111";
const CAMPAIGN = "100000001";
const PARAMS = { accountId: ACCOUNT, campaignId: CAMPAIGN };
const PEOPLE = [
  "operator", "owner", "approver", "member", "viewer", "outsider",
  "req1", "req2", "req3", "req4", "req5", "req6",
] as const;
type Person = (typeof PEOPLE)[number];
const ids = Object.fromEntries(PEOPLE.map((p) => [p, ""])) as Record<Person, string>;
const userIds: string[] = [];
const tenantIds: string[] = [];
let ORG = "";
let OTHER = "";

const operator = async (command: Parameters<Db["runTenantAdminCommand"]>[1]) => {
  const result = await db!.runTenantAdminCommand(prisma!, command, { actorUserId: ids.operator, execute: true });
  if (!result.ok) throw new Error(`${command.verb} refused: ${result.code}`);
  return result;
};

let server: Server;
let base = "";
/** The real `fetch`, kept for the HTTP calls: the Meta provider is a mock and needs no network. */
const http = globalThis.fetch.bind(globalThis);

/**
 * One stack per test: a fresh mock provider (its campaigns start ACTIVE), the
 * real store, executor, tool, pending-action service and routers.
 */
function stack() {
  const provider = tools!.createMockMetaProvider();
  const write = vi.spyOn(provider, "updateCampaignStatus");
  const reads = vi.spyOn(provider, "getCampaigns");
  const sharedAccess = new access!.SharedConnectionAccess(new db!.PrismaTenantRepository(prisma!));
  const tokenReaches = { getAuthorizedAccountIds: async () => [ACCOUNT], isAuthorized: async () => true };
  const authorizer = metaAccess!.createOrganizationMetaAuthorizer({
    provider: tokenReaches,
    access: sharedAccess,
    configuredAccountId: ACCOUNT,
  });
  const approvalRepo = new db!.PrismaApprovalRepository(prisma!);
  const journal = new db!.PrismaToolExecutionRepository(prisma!);
  const registry = new tools!.ToolRegistry();
  registry.register(new tools!.MetaPauseCampaignTool(provider, authorizer, journal, approvalRepo));
  registry.register(new tools!.MetaGetCampaignsTool(provider, authorizer));
  const auditLogger = new security!.AuditLogger(new db!.PrismaAuditRepository(prisma!));
  const executor = new tools!.ToolExecutor(
    registry,
    new security!.PermissionService(),
    new security!.ApprovalService(approvalRepo),
    auditLogger,
    { accessGate: access!.createSharedConnectionToolGate(sharedAccess) }
  );
  const pendingActions = new agents!.PendingActionService({ approvalRepo, toolRegistry: registry });
  const run = (person: Person, params: Record<string, unknown> = PARAMS, toolId = "meta.campaign.pause") =>
    executor.execute({ toolId, params, userId: ids[person], role: "member", traceId: `t-${STAMP}` });
  return { provider, write, reads, approvalRepo, registry, executor, pendingActions, auditLogger, journal, run };
}

let current: ReturnType<typeof stack> | null = null;

async function call(person: Person, method: string, path: string, body?: unknown) {
  const response = await http(base + path, {
    method,
    headers: { authorization: `Bearer tok-${person}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as { success: boolean; data?: any; error?: { code: string; message: string } } };
}

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) {
    throw new Error("These security tests need a separate PostgreSQL test database, and none could be reached.");
  }
  lease = await (await import("./helpers/shared-connection-lock.js")).holdSharedConnection("meta/ads");
  const taken = await prisma!.automationConnectorOwner.findUnique({
    where: { providerId_connector: { providerId: "meta", connector: "ads" } },
  });
  if (taken) throw new Error("meta/ads is already assigned on this database — run this suite against a fresh test database");
  for (const person of PEOPLE) {
    const user = await prisma!.user.create({
      data: { email: `p17-h2-${person}-${STAMP}@jarvis-test.local`, name: person, password: "not-a-real-password-hash", role: "MEMBER" },
    });
    ids[person] = user.id;
    userIds.push(user.id);
  }
  ORG = String((await operator({ verb: "create-tenant", name: `H2 Org ${STAMP}`, ownerUserId: ids.owner })).detail.tenantId);
  OTHER = String((await operator({ verb: "create-tenant", name: `H2 Other ${STAMP}`, ownerUserId: ids.outsider })).detail.tenantId);
  tenantIds.push(ORG, OTHER);
  await operator({ verb: "add-member", tenantId: ORG, userId: ids.approver, role: "admin" });
  await operator({ verb: "add-member", tenantId: ORG, userId: ids.member, role: "member" });
  await operator({ verb: "add-member", tenantId: ORG, userId: ids.viewer, role: "viewer" });
  for (const person of ["req1", "req2", "req3", "req4", "req5", "req6"] as const) {
    await operator({ verb: "add-member", tenantId: ORG, userId: ids[person], role: "admin" });
  }
  await operator({ verb: "assign-connector", providerId: "meta", connector: "ads", tenantId: ORG });

  // The routers read the CURRENT test's stack; one exists before they are
  // built, because the approvals router takes its audit logger as it is built.
  current = stack();
  const container = new Proxy(
    {},
    {
      get(_target, key: string) {
        if (key === "tokenService") {
          return {
            verifyAccessToken: (token: string) => {
              const person = token.replace(/^tok-/, "") as Person;
              return ids[person] ? { userId: ids[person], role: "member", email: `${person}@jarvis-test.local` } : null;
            },
          };
        }
        const s = current!;
        if (key === "auditLogger") return s.auditLogger;
        if (key === "approvalRepo") return s.approvalRepo;
        if (key === "toolRegistry") return s.registry;
        if (key === "executionJournal") return s.journal;
        if (key === "executor") return s.executor;
        if (key === "pendingActionService") return s.pendingActions;
        return undefined;
      },
    }
  ) as never;
  const app = express();
  app.use(express.json());
  app.use("/approvals", approvalsRoute!.createApprovalsRouter(container));
  app.use("/pending-actions", pendingRoute!.createPendingActionsRouter(container));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 300_000);

afterAll(async () => {
  server?.close();
  if (prisma) {
    await prisma.approval.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.automationConnectorOwner.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  await lease?.release().catch(() => undefined);
});

const approvalsOf = (person: Person) => prisma!.approval.findMany({ where: { userId: ids[person] } });

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 17 H2 — a Meta write through the shared connection, on PostgreSQL", () => {
  it("1. an outsider can neither read nor change the shared account, and a viewer cannot ask for a change", async () => {
    current = stack();
    const read = await current.run("outsider", { accountId: ACCOUNT }, "meta.campaigns");
    const write = await current.run("outsider");
    expect(read).toMatchObject({ status: "permission_denied", error: "Meta Ads is not available to your account." });
    expect(write).toMatchObject({ status: "permission_denied", error: "Meta Ads is not available to your account." });

    const viewerWrite = await current.run("viewer");
    expect(viewerWrite.status).toBe("permission_denied");
    expect(viewerWrite.error).toMatch(/does not allow changes through Meta Ads/);

    expect(current.reads).not.toHaveBeenCalled();
    expect(current.write).not.toHaveBeenCalled();
    expect(await approvalsOf("outsider")).toEqual([]);
    expect(await approvalsOf("viewer")).toEqual([]);

    // A member of the Organization reads.
    const memberRead = await current.run("member", { accountId: ACCOUNT }, "meta.campaigns");
    expect(memberRead.status).toBe("completed");
  });

  it("2. the requester cannot approve their own change — on the Approvals page or in the chat", async () => {
    current = stack();
    const asked = await current.run("req1");
    expect(asked.status).toBe("approval_pending");
    const row = await prisma!.approval.findUnique({ where: { id: asked.approvalId! } });
    expect(row).toMatchObject({ tenantId: ORG, status: "PENDING", decidedById: null });

    const selfApprove = await call("req1", "POST", `/approvals/${asked.approvalId}/approve`);
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error?.code).toBe("APPROVAL_SELF_APPROVAL_FORBIDDEN");

    // The chat: a pending action for the same write, confirmed by its requester.
    const { pendingAction } = await current.pendingActions.createPendingAction({
      conversationId: `conv-${STAMP}-2`,
      userId: ids.req1,
      toolId: "meta.campaign.pause",
      action: "meta.campaign.pause",
      params: PARAMS,
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });
    expect(pendingAction.needsIndependentApproval).toBe(true);
    const confirm = await call("req1", "POST", `/pending-actions/${pendingAction.id}/confirm`, { conversationId: `conv-${STAMP}-2` });
    expect(confirm.status).toBe(403);
    expect(confirm.body.error?.code).toBe("PENDING_ACTION_NEEDS_INDEPENDENT_APPROVAL");

    // Neither a member nor an outsider can see it, let alone decide it.
    expect((await call("member", "POST", `/approvals/${asked.approvalId}/approve`)).status).toBe(404);
    expect((await call("outsider", "POST", `/approvals/${asked.approvalId}/approve`)).status).toBe(404);
    expect((await call("outsider", "GET", `/approvals/${asked.approvalId}`)).status).toBe(404);

    // It waits for the Organization's approvers.
    const review = await call("approver", "GET", "/approvals?scope=review");
    expect(review.body.data.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining([asked.approvalId, pendingAction.id]));
    expect((await call("member", "GET", "/approvals?scope=review")).body.data).toEqual([]);

    expect(current.write).not.toHaveBeenCalled();
    for (const id of [asked.approvalId!, pendingAction.id]) {
      expect((await prisma!.approval.findUnique({ where: { id } }))!.status).toBe("PENDING");
    }
  });

  it("3. an independent approval is bound to the exact action and parameters, and runs once", async () => {
    current = stack();
    const asked = await current.run("req2");
    const approved = await call("approver", "POST", `/approvals/${asked.approvalId}/approve`);
    expect(approved.status).toBe(200);
    expect(await prisma!.approval.findUnique({ where: { id: asked.approvalId! } })).toMatchObject({
      status: "APPROVED",
      decidedById: ids.approver,
    });

    // Other parameters are not what was approved: a new request, nothing written.
    const other = await current.run("req2", { accountId: ACCOUNT, campaignId: "100000002" });
    expect(other.status).toBe("approval_pending");
    expect(other.approvalId).not.toBe(asked.approvalId);
    expect(current.write).not.toHaveBeenCalled();

    // The approved one runs, once.
    const ran = await current.run("req2");
    expect(ran.status).toBe("completed");
    expect(ran.result?.success).toBe(true);
    expect(current.write).toHaveBeenCalledTimes(1);
    expect(current.write).toHaveBeenCalledWith(ACCOUNT, CAMPAIGN, "PAUSED", expect.anything());
    expect((await prisma!.approval.findUnique({ where: { id: asked.approvalId! } }))!.status).toBe("CONSUMED");

    const again = await current.run("req2");
    expect(again.status).not.toBe("completed");
    expect(current.write).toHaveBeenCalledTimes(1);
  });

  it("4a. a requester demoted after the approval is refused at execution, and nothing is written", async () => {
    current = stack();
    const asked = await current.run("req3");
    expect((await call("approver", "POST", `/approvals/${asked.approvalId}/approve`)).status).toBe(200);
    await operator({ verb: "set-role", tenantId: ORG, userId: ids.req3, role: "member" });
    try {
      const ran = await current.run("req3");
      expect(ran.status).toBe("permission_denied");
      expect(current.write).not.toHaveBeenCalled();
      expect((await prisma!.approval.findUnique({ where: { id: asked.approvalId! } }))!.status).toBe("APPROVED");
    } finally {
      await operator({ verb: "set-role", tenantId: ORG, userId: ids.req3, role: "admin" });
    }
  });

  it("4b. an approver removed after approving: the store refuses the consumption, and nothing is written", async () => {
    current = stack();
    const asked = await current.run("req4");
    expect((await call("approver", "POST", `/approvals/${asked.approvalId}/approve`)).status).toBe(200);
    await operator({ verb: "remove-member", tenantId: ORG, userId: ids.approver });
    try {
      const ran = await current.run("req4");
      expect(ran.status).not.toBe("completed");
      expect(JSON.stringify(ran)).toMatch(/approver's organization role no longer allows/);
      expect(current.write).not.toHaveBeenCalled();
      expect((await prisma!.approval.findUnique({ where: { id: asked.approvalId! } }))!.status).toBe("APPROVED");
    } finally {
      await operator({ verb: "add-member", tenantId: ORG, userId: ids.approver, role: "admin" });
    }
  });

  it("4c. the connection moved to another Organization after the approval: refused, nothing written", async () => {
    current = stack();
    const asked = await current.run("req5");
    expect((await call("approver", "POST", `/approvals/${asked.approvalId}/approve`)).status).toBe(200);
    await operator({ verb: "assign-connector", providerId: "meta", connector: "ads", tenantId: OTHER });
    try {
      const ran = await current.run("req5");
      expect(ran.status).toBe("permission_denied");
      expect(current.write).not.toHaveBeenCalled();
    } finally {
      await operator({ verb: "assign-connector", providerId: "meta", connector: "ads", tenantId: ORG });
    }
  });

  it("5. the chat's pending action waits for the approver, then runs on the requester's confirm", async () => {
    current = stack();
    const conversationId = `conv-${STAMP}-5`;
    const { pendingAction } = await current.pendingActions.createPendingAction({
      conversationId,
      userId: ids.req6,
      toolId: "meta.campaign.pause",
      action: "meta.campaign.pause",
      params: PARAMS,
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });
    expect((await call("approver", "POST", `/approvals/${pendingAction.id}/approve`)).status).toBe(200);

    const waiting = await call("req6", "GET", `/pending-actions?conversationId=${conversationId}`);
    expect(waiting.body.data).toMatchObject({ id: pendingAction.id, state: "APPROVED", needsIndependentApproval: true });

    const confirmed = await call("req6", "POST", `/pending-actions/${pendingAction.id}/confirm`, { conversationId });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.executionResult.status).toBe("completed");
    expect(current.write).toHaveBeenCalledTimes(1);
    expect((await prisma!.approval.findUnique({ where: { id: pendingAction.id } }))!.status).toBe("CONSUMED");

    const twice = await call("req6", "POST", `/pending-actions/${pendingAction.id}/confirm`, { conversationId });
    expect(twice.status).not.toBe(200);
    expect(current.write).toHaveBeenCalledTimes(1);
  });

  it("6. refuses everyone — owners included — while nobody owns the Meta connection", async () => {
    current = stack();
    await operator({ verb: "unassign-connector", providerId: "meta", connector: "ads" });
    try {
      for (const person of ["owner", "approver", "req1"] as const) {
        const read = await current.run(person, { accountId: ACCOUNT }, "meta.campaigns");
        expect(read.status, person).toBe("permission_denied");
      }
      expect(current.reads).not.toHaveBeenCalled();
    } finally {
      await operator({ verb: "assign-connector", providerId: "meta", connector: "ads", tenantId: ORG });
    }
  });
});
