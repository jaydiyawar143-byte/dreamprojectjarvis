// Phase 18, Stage 18.3B — the trigger allow-list proposal on REAL PostgreSQL:
// the approval store and the allow-list's one writer.
//
// What only a database can prove:
//   • an approval for `automation.library.allowlist.add` belongs to the
//     Organization that owns the n8n connection from the moment it exists —
//     taken from the owner record, never from the caller — and none is
//     created while nobody owns it;
//   • its requester cannot approve it; another owner or admin can; it is
//     consumed once, and only with the Organization's scope;
//   • `registerLibraryWorkflow` is idempotent and never takes a webhook path
//     another row holds — two registrations arriving together on two
//     connections leave one row.
//
// SAFETY. As every suite here: DATABASE_URL is read before the Prisma client
// is imported, only a separate test database is used (never 5432 or 5433),
// and everything created is removed — including the n8n/rest owner record,
// which this suite refuses to run without being free to assign.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { computeParamsHash } from "@jarvis/core";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Client = InstanceType<(typeof import("@prisma/client"))["PrismaClient"]>;
type ApprovalModule = typeof import("../src/repositories/approval-repository.js");
type N8nModule = typeof import("../src/repositories/n8n-repository.js");
type Admin = typeof import("../src/maintenance/tenant-admin.js");

let prisma: Client | null = null;
let second: Client | null = null;
let approvals: ApprovalModule | null = null;
let n8n: N8nModule | null = null;
let admin: Admin | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  const Prisma = await import("@prisma/client");
  approvals = await import("../src/repositories/approval-repository.js");
  n8n = await import("../src/repositories/n8n-repository.js");
  admin = await import("../src/maintenance/tenant-admin.js");
  prisma = new Prisma.PrismaClient();
  second = new Prisma.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    await second.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const N8N = { providerId: "n8n", connector: "rest" } as const;
const ADD = "automation.library.allowlist.add";
const ADMIN_ROLES = ["owner", "admin"] as const;
const userIds: string[] = [];
const tenantIds: string[] = [];
const ids: Record<"actor" | "owner" | "requester" | "approver" | "member" | "other", string> = {
  actor: "",
  owner: "",
  requester: "",
  approver: "",
  member: "",
  other: "",
};
let ORG = "";

const run = async (command: Parameters<Admin["runTenantAdminCommand"]>[1]) => {
  const result = await admin!.runTenantAdminCommand(prisma!, command, { actorUserId: ids.actor, execute: true });
  if (!result.ok) throw new Error(`${command.verb} refused: ${result.code}`);
  return result;
};
const repo = () => new approvals!.PrismaApprovalRepository(prisma!);
const allowlist = () => new n8n!.PrismaN8nRepository(prisma!);
const allowlist2 = () => new n8n!.PrismaN8nRepository(second!);

let seq = 0;
async function proposal(over: Record<string, unknown> = {}) {
  const params = { entryId: `wf-${STAMP}-${seq++}`, versionId: "v-1" };
  const approval = await repo().create({
    userId: ids.requester,
    toolId: ADD,
    action: "execute",
    params,
    paramsHash: computeParamsHash(params),
    riskLevel: "HIGH_IMPACT",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...over,
  });
  return { approval, params };
}

const scope = () => ({
  tenantId: ORG,
  providerId: N8N.providerId,
  connector: N8N.connector,
  requesterRoles: ["owner", "admin"] as const,
  approverRoles: ["owner", "admin"] as const,
});

async function execution(approvalId: string): Promise<string> {
  const row = await prisma!.toolExecution.create({
    data: { userId: ids.requester, toolId: ADD, idempotencyKey: `idem-${approvalId}-${seq++}`, status: "PENDING" },
  });
  return row.executionId;
}

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) throw new Error("These allow-list tests need a separate PostgreSQL test database, and none could be reached.");
  const taken = await prisma!.automationConnectorOwner.findUnique({ where: { providerId_connector: N8N } });
  if (taken) throw new Error("n8n/rest is already assigned on this database — run this suite against a fresh test database");
  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const user = await prisma!.user.create({
      data: { email: `p18al-${name}-${STAMP}@jarvis-test.local`, name: `User ${name}`, password: "x", role: "OWNER" },
    });
    ids[name] = user.id;
    userIds.push(user.id);
  }
  ORG = String((await run({ verb: "create-tenant", name: `Org ${STAMP}`, ownerUserId: ids.owner })).detail.tenantId);
  tenantIds.push(ORG);
  await run({ verb: "add-member", tenantId: ORG, userId: ids.requester, role: "admin" });
  await run({ verb: "add-member", tenantId: ORG, userId: ids.approver, role: "admin" });
  await run({ verb: "add-member", tenantId: ORG, userId: ids.member, role: "member" });
  await run({ verb: "assign-connector", providerId: N8N.providerId, connector: N8N.connector, tenantId: ORG });
});

afterAll(async () => {
  if (prisma) {
    // Approvals first (RESTRICT on the tenant), then the owner record.
    await prisma.approval.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.automationConnectorOwner.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    // Allow-list rows and executions cascade with their users.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  if (second) await second.$disconnect();
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 18.3B — allow-list proposals on PostgreSQL", () => {
  it("binds the proposal to the Organization that owns n8n, from the owner record — never from the caller", async () => {
    const { approval } = await proposal({ tenantId: "someone-elses-org", decidedById: ids.requester });
    expect(approval.tenantId).toBe(ORG);
    expect(approval.decidedById).toBeUndefined();
    expect(await prisma!.approval.findUnique({ where: { id: approval.id } })).toMatchObject({ tenantId: ORG, decidedById: null, status: "PENDING" });
  });

  it("creates no proposal while nobody owns the connection", async () => {
    await run({ verb: "unassign-connector", providerId: N8N.providerId, connector: N8N.connector });
    try {
      await expect(proposal()).rejects.toBeInstanceOf(approvals!.SharedConnectionOwnerUnavailableError);
    } finally {
      await run({ verb: "assign-connector", providerId: N8N.providerId, connector: N8N.connector, tenantId: ORG });
    }
  });

  it("is approved only by another owner or admin, and consumed once, only with the Organization's scope", async () => {
    const { approval, params } = await proposal();
    expect(await repo().decideApproval(approval.id, ids.requester, "approve", { approverRoles: ADMIN_ROLES })).toEqual({ outcome: "self_approval_forbidden" });
    expect(await repo().decideApproval(approval.id, ids.member, "approve", { approverRoles: ADMIN_ROLES })).toEqual({ outcome: "forbidden" });
    expect(await repo().decideApproval(approval.id, ids.approver, "approve", { approverRoles: ADMIN_ROLES })).toEqual({ outcome: "approved" });

    const consume = async (withScope: boolean) =>
      repo().consumeForExecution({
        approvalId: approval.id,
        userId: ids.requester,
        toolId: ADD,
        paramsHash: computeParamsHash(params),
        executionId: await execution(approval.id),
        ...(withScope ? { tenantScope: scope() } : {}),
      });
    expect((await consume(false)).ok).toBe(false);
    expect(await consume(true)).toEqual({ ok: true });
    expect((await consume(true)).ok).toBe(false);
    expect((await prisma!.approval.findUnique({ where: { id: approval.id } }))?.status).toBe("CONSUMED");
  });

  it("registers a library workflow idempotently, and never takes another row's path", async () => {
    const input = { userId: ids.requester, name: "Invoice sync", webhookPath: `hook-${STAMP}`, entryRef: `inst:wf-a-${STAMP}`, versionId: "v-1" };
    expect(await allowlist().registerLibraryWorkflow(input)).toEqual({ outcome: "created" });
    expect(await allowlist().registerLibraryWorkflow(input)).toEqual({ outcome: "unchanged" });
    expect(await allowlist().registerLibraryWorkflow({ ...input, versionId: "v-2" })).toEqual({ outcome: "updated" });
    // The workflow's webhook moved in n8n: the entry's row follows it.
    expect(await allowlist().registerLibraryWorkflow({ ...input, versionId: "v-3", webhookPath: `hook2-${STAMP}` })).toEqual({ outcome: "updated" });
    // Another entry wanting a path this user's allow-list already holds: refused.
    expect(await allowlist().registerLibraryWorkflow({ ...input, entryRef: `inst:wf-b-${STAMP}`, webhookPath: `hook2-${STAMP}` })).toEqual({ outcome: "conflict" });

    const rows = await prisma!.n8nWorkflow.findMany({ where: { userId: ids.requester } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ webhookPath: `hook2-${STAMP}`, libraryEntryRef: `inst:wf-a-${STAMP}`, libraryVersionId: "v-3", isActive: true });
    expect(await allowlist().findLibraryRegistrations(ids.requester, [`inst:wf-a-${STAMP}`])).toEqual([{ entryRef: `inst:wf-a-${STAMP}`, versionId: "v-3" }]);
    // Another user's allow-list is theirs: nothing of this one shows.
    expect(await allowlist().findLibraryRegistrations(ids.other, [`inst:wf-a-${STAMP}`])).toEqual([]);
  });

  it("never takes over a path the allow-list already holds for something else", async () => {
    await prisma!.n8nWorkflow.create({ data: { userId: ids.member, name: "Added by hand", webhookPath: `manual-${STAMP}` } });
    expect(
      await allowlist().registerLibraryWorkflow({ userId: ids.member, name: "Library", webhookPath: `manual-${STAMP}`, entryRef: `inst:wf-m-${STAMP}`, versionId: "v-1" })
    ).toEqual({ outcome: "conflict" });
    expect(await prisma!.n8nWorkflow.findMany({ where: { userId: ids.member } })).toMatchObject([{ name: "Added by hand", libraryEntryRef: null, libraryVersionId: null }]);
  });

  it("leaves one row when two registrations arrive together on two connections", async () => {
    const input = { userId: ids.approver, name: "Race", webhookPath: `race-${STAMP}`, entryRef: `inst:wf-race-${STAMP}`, versionId: "v-1" };
    const outcomes = await Promise.all([allowlist().registerLibraryWorkflow(input), allowlist2().registerLibraryWorkflow(input)]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["created", "unchanged"]);
    expect(await prisma!.n8nWorkflow.count({ where: { userId: ids.approver, webhookPath: `race-${STAMP}` } })).toBe(1);
  });
});
