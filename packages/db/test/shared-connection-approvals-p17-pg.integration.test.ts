// Phase 17 multi-business hardening (review finding H2) — approvals for writes
// through a shared connection, and the per-Organization budget, against REAL
// PostgreSQL.
//
// What only a database can prove:
//   • an approval for a Meta write belongs, from birth, to the Organization the
//     owner record names — never to one a caller passes — and none is created
//     for a connection nobody owns;
//   • the requester can never approve it; another owner or admin of THAT
//     Organization can, and is recorded as the decider; anyone else is refused;
//   • it is consumed once, only with its scope, and only while the requester,
//     the approver and the Organization's ownership all still hold — a
//     demotion, a removal or a moved connection after the approval stops the
//     write;
//   • two approvers answering together: exactly one wins;
//   • a per-Organization window holds across concurrent reservations from
//     different accounts, and one Organization's window is not another's.
//
// SAFETY. DATABASE_URL is read BEFORE the Prisma client is imported. The suite
// runs only against an explicitly supplied, separate test database — never the
// development (5432) or deployment (5433) one — and removes what it creates.
//
// NEVER SKIPPED QUIETLY. With no database configured it is reported as skipped
// (CI fails on a skipped database test). A database that was configured and
// cannot be reached FAILS it — and so does none at all under
// JARVIS_REQUIRE_POSTGRES=1, as CI's database steps set.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { computeParamsHash } from "@jarvis/core";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Client = InstanceType<(typeof import("@prisma/client"))["PrismaClient"]>;
type ApprovalModule = typeof import("../src/repositories/approval-repository.js");
type AuditModule = typeof import("../src/repositories/audit-repository.js");
type Admin = typeof import("../src/maintenance/tenant-admin.js");

let prisma: Client | null = null;
let second: Client | null = null;
let approvals: ApprovalModule | null = null;
let audit: AuditModule | null = null;
let admin: Admin | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  const Prisma = await import("@prisma/client");
  approvals = await import("../src/repositories/approval-repository.js");
  audit = await import("../src/repositories/audit-repository.js");
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
const META = { providerId: "meta", connector: "ads" } as const;
const WRITE_TOOL = "meta.campaign.pause";
const ADMIN_ROLES = ["owner", "admin"] as const;

const userIds: string[] = [];
const tenantIds: string[] = [];
const ids: Record<"actor" | "owner" | "requester" | "approver" | "approver2" | "member" | "outsider", string> = {
  actor: "",
  owner: "",
  requester: "",
  approver: "",
  approver2: "",
  member: "",
  outsider: "",
};
let ORG = "";
let OTHER = "";

const run = async (command: Parameters<Admin["runTenantAdminCommand"]>[1]) => {
  const result = await admin!.runTenantAdminCommand(prisma!, command, { actorUserId: ids.actor, execute: true });
  if (!result.ok) throw new Error(`${command.verb} refused: ${result.code}`);
  return result;
};

const repo = () => new approvals!.PrismaApprovalRepository(prisma!);
const repoOnSecond = () => new approvals!.PrismaApprovalRepository(second!);

let paramsSeq = 0;
/** A fresh Meta write approval for the requester, with params of its own. */
async function newWriteApproval(over: Record<string, unknown> = {}) {
  const params = { accountId: "act_100200300", campaignId: `c-${STAMP}-${paramsSeq++}` };
  const approval = await repo().create({
    userId: ids.requester,
    conversationId: `conv-${STAMP}`,
    toolId: WRITE_TOOL,
    action: "execute",
    params,
    paramsHash: computeParamsHash(params),
    riskLevel: "EXTERNAL_SIDE_EFFECT",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...over,
  });
  return { approval, params };
}

let executionSeq = 0;
/** A claimable execution record, as the tool's journal would have begun it. */
async function newExecution(approvalId: string): Promise<string> {
  const row = await prisma!.toolExecution.create({
    data: {
      userId: ids.requester,
      toolId: WRITE_TOOL,
      idempotencyKey: `idem-${approvalId}-${executionSeq++}`,
      status: "PENDING",
    },
  });
  return row.executionId;
}

const scope = (tenantId = ORG) => ({
  tenantId,
  providerId: META.providerId,
  connector: META.connector,
  requesterRoles: ["owner", "admin"] as const,
  approverRoles: ["owner", "admin"] as const,
});

const consume = async (approvalId: string, params: Record<string, unknown>, withScope: ReturnType<typeof scope> | null = scope()) =>
  repo().consumeForExecution({
    approvalId,
    userId: ids.requester,
    toolId: WRITE_TOOL,
    paramsHash: computeParamsHash(params),
    executionId: await newExecution(approvalId),
    ...(withScope ? { tenantScope: withScope } : {}),
  });

const status = async (id: string) => (await prisma!.approval.findUnique({ where: { id } }))?.status;

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) {
    throw new Error("These security tests need a separate PostgreSQL test database, and none could be reached.");
  }
  // The Meta connection must be this suite's to assign. On a fresh test
  // database it is; anything else is a database this suite must not touch.
  const taken = await prisma!.automationConnectorOwner.findUnique({
    where: { providerId_connector: { providerId: META.providerId, connector: META.connector } },
  });
  if (taken) {
    throw new Error("meta/ads is already assigned on this database — run this suite against a fresh test database");
  }
  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const user = await prisma!.user.create({
      data: { email: `p17s-${name}-${STAMP}@jarvis-test.local`, name: `User ${name}`, password: "x", role: "OWNER" },
    });
    ids[name] = user.id;
    userIds.push(user.id);
  }
  ORG = String((await run({ verb: "create-tenant", name: `Org ${STAMP}`, ownerUserId: ids.owner })).detail.tenantId);
  OTHER = String((await run({ verb: "create-tenant", name: `Other ${STAMP}`, ownerUserId: ids.outsider })).detail.tenantId);
  tenantIds.push(ORG, OTHER);
  await run({ verb: "add-member", tenantId: ORG, userId: ids.requester, role: "admin" });
  await run({ verb: "add-member", tenantId: ORG, userId: ids.approver, role: "admin" });
  await run({ verb: "add-member", tenantId: ORG, userId: ids.approver2, role: "owner" });
  await run({ verb: "add-member", tenantId: ORG, userId: ids.member, role: "member" });
  await run({ verb: "assign-connector", providerId: META.providerId, connector: META.connector, tenantId: ORG });
});

afterAll(async () => {
  if (prisma) {
    // Approvals first (RESTRICT on the tenant), then owners, tenants, audit
    // rows and accounts; executions cascade with their account.
    await prisma.approval.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.automationConnectorOwner.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  if (second) await second.$disconnect();
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 17 — shared-connection approvals on PostgreSQL", () => {
  describe("an approval belongs to the connection's Organization from birth", () => {
    it("takes the Organization from the owner record, never from the caller", async () => {
      const { approval } = await newWriteApproval({ tenantId: OTHER, decidedById: ids.requester });
      expect(approval.tenantId).toBe(ORG);
      expect(approval.decidedById).toBeUndefined();
      const row = await prisma!.approval.findUnique({ where: { id: approval.id } });
      expect(row).toMatchObject({ tenantId: ORG, decidedById: null, status: "PENDING" });
    });

    it("gives a read tool's or an ordinary tool's approval no Organization", async () => {
      for (const toolId of ["meta.insights", "whatsapp.send"]) {
        const approval = await repo().create({
          userId: ids.requester,
          toolId,
          action: "execute",
          params: {},
          paramsHash: computeParamsHash({}),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        expect(approval.tenantId).toBeUndefined();
      }
    });

    it("creates nothing for a connection nobody owns", async () => {
      await run({ verb: "unassign-connector", providerId: META.providerId, connector: META.connector });
      try {
        const before = await prisma!.approval.count({ where: { userId: ids.requester } });
        await expect(newWriteApproval()).rejects.toBeInstanceOf(approvals!.SharedConnectionOwnerUnavailableError);
        expect(await prisma!.approval.count({ where: { userId: ids.requester } })).toBe(before);
      } finally {
        await run({ verb: "assign-connector", providerId: META.providerId, connector: META.connector, tenantId: ORG });
      }
    });
  });

  describe("who may decide it", () => {
    it("never lets the requester approve their own write — an admin included", async () => {
      const { approval } = await newWriteApproval();
      expect(await repo().decideApproval(approval.id, ids.requester, "approve", { approverRoles: ADMIN_ROLES })).toEqual({
        outcome: "self_approval_forbidden",
      });
      expect(await status(approval.id)).toBe("PENDING");
    });

    it("refuses a member, an owner of another Organization, and anyone when no approver roles are given", async () => {
      const { approval } = await newWriteApproval();
      for (const [decider, roles] of [
        [ids.member, ADMIN_ROLES],
        [ids.outsider, ADMIN_ROLES],
        [ids.approver, []],
        [ids.approver, undefined],
      ] as const) {
        const decided = await repo().decideApproval(approval.id, decider, "approve", roles ? { approverRoles: roles } : {});
        expect(decided).toEqual({ outcome: "forbidden" });
      }
      expect(await status(approval.id)).toBe("PENDING");
    });

    it("lets another admin of the Organization approve, and records who did", async () => {
      const { approval } = await newWriteApproval();
      expect(await repo().decideApproval(approval.id, ids.approver, "approve", { approverRoles: ADMIN_ROLES })).toEqual({
        outcome: "approved",
      });
      expect(await prisma!.approval.findUnique({ where: { id: approval.id } })).toMatchObject({
        status: "APPROVED",
        decidedById: ids.approver,
      });
    });

    it("lets the requester withdraw their own pending write", async () => {
      const { approval } = await newWriteApproval();
      expect(await repo().decideApproval(approval.id, ids.requester, "reject", { fromPendingOnly: true })).toEqual({
        outcome: "rejected",
      });
      expect(await prisma!.approval.findUnique({ where: { id: approval.id } })).toMatchObject({
        status: "REJECTED",
        decidedById: null,
      });
    });

    it("tells an outsider nothing about the approval's state", async () => {
      const { approval } = await newWriteApproval();
      await prisma!.approval.update({ where: { id: approval.id }, data: { status: "CONSUMED" } });
      expect(await repo().decideApproval(approval.id, ids.outsider, "approve", { approverRoles: ADMIN_ROLES })).toEqual({
        outcome: "forbidden",
      });
    });

    it("lets exactly one of two approvers answering together win", async () => {
      const { approval } = await newWriteApproval();
      const results = await Promise.all([
        repo().decideApproval(approval.id, ids.approver, "approve", { approverRoles: ADMIN_ROLES }),
        repoOnSecond().decideApproval(approval.id, ids.approver2, "approve", { approverRoles: ADMIN_ROLES }),
      ]);
      expect(results.filter((r) => r.outcome === "approved")).toHaveLength(1);
      const row = await prisma!.approval.findUnique({ where: { id: approval.id } });
      expect([ids.approver, ids.approver2]).toContain(row!.decidedById);
    });
  });

  describe("consuming it runs on what holds now", () => {
    async function approved() {
      const created = await newWriteApproval();
      await repo().decideApproval(created.approval.id, ids.approver, "approve", { approverRoles: ADMIN_ROLES });
      return created;
    }

    it("consumes an independently approved write once, with its scope", async () => {
      const { approval, params } = await approved();
      expect(await consume(approval.id, params)).toEqual({ ok: true });
      expect(await status(approval.id)).toBe("CONSUMED");
      expect(await consume(approval.id, params)).toMatchObject({ ok: false });
    });

    it("never consumes an Organization's approval without its scope", async () => {
      const { approval, params } = await approved();
      expect(await consume(approval.id, params, null)).toEqual({
        ok: false,
        reason: "approval belongs to an organization and cannot be used without its checks",
      });
      expect(await status(approval.id)).toBe("APPROVED");
    });

    it("refuses the scope of another Organization", async () => {
      const { approval, params } = await approved();
      expect(await consume(approval.id, params, scope(OTHER))).toEqual({
        ok: false,
        reason: "approval does not belong to this organization",
      });
    });

    it("refuses an approval the requester decided themselves, however it was written", async () => {
      const { approval, params } = await newWriteApproval();
      await prisma!.approval.update({
        where: { id: approval.id },
        data: { status: "APPROVED", decidedById: ids.requester },
      });
      expect(await consume(approval.id, params)).toEqual({
        ok: false,
        reason: "approval was not given by an independent approver",
      });
    });

    it("refuses when the requester was demoted after the approval", async () => {
      const { approval, params } = await approved();
      await run({ verb: "set-role", tenantId: ORG, userId: ids.requester, role: "member" });
      try {
        expect(await consume(approval.id, params)).toEqual({
          ok: false,
          reason: "the requester's organization role no longer allows this change",
        });
        expect(await status(approval.id)).toBe("APPROVED");
      } finally {
        await run({ verb: "set-role", tenantId: ORG, userId: ids.requester, role: "admin" });
      }
    });

    it("refuses when the approver was removed after approving", async () => {
      const { approval, params } = await approved();
      await run({ verb: "remove-member", tenantId: ORG, userId: ids.approver });
      try {
        expect(await consume(approval.id, params)).toEqual({
          ok: false,
          reason: "the approver's organization role no longer allows approving this change",
        });
      } finally {
        await run({ verb: "add-member", tenantId: ORG, userId: ids.approver, role: "admin" });
      }
    });

    it("refuses when the connection moved to another Organization after the approval", async () => {
      const { approval, params } = await approved();
      await run({ verb: "assign-connector", providerId: META.providerId, connector: META.connector, tenantId: OTHER });
      try {
        expect(await consume(approval.id, params)).toEqual({
          ok: false,
          reason: "the organization no longer owns this connection",
        });
      } finally {
        await run({ verb: "assign-connector", providerId: META.providerId, connector: META.connector, tenantId: ORG });
      }
    });

    it("refuses other parameters than the ones approved", async () => {
      const { approval, params } = await approved();
      expect(await consume(approval.id, { ...params, campaignId: "someone-elses" })).toMatchObject({ ok: false });
      expect(await status(approval.id)).toBe("APPROVED");
    });

    it("refuses an ordinary approval presented with an Organization's scope", async () => {
      const params = { accountId: "act_1", campaignId: `plain-${STAMP}` };
      const plain = await prisma!.approval.create({
        data: {
          userId: ids.requester,
          toolId: WRITE_TOOL,
          action: "execute",
          params,
          paramsHash: computeParamsHash(params),
          status: "APPROVED",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect(await consume(plain.id, params)).toEqual({ ok: false, reason: "approval does not belong to this organization" });
    });
  });

  describe("what a conversation and an approver see", () => {
    it("keeps a write waiting in its conversation until it runs — pending, then approved by someone else", async () => {
      const conversationId = `waiting-${STAMP}`;
      const { approval } = await newWriteApproval({ conversationId });
      expect((await repo().findPendingByConversationId(conversationId, ids.requester))?.id).toBe(approval.id);
      await repo().decideApproval(approval.id, ids.approver, "approve", { approverRoles: ADMIN_ROLES });
      const waiting = await repo().findPendingByConversationId(conversationId, ids.requester);
      expect(waiting).toMatchObject({ id: approval.id, status: "approved", decidedById: ids.approver });
    });

    it("never keeps an ordinary approved approval waiting", async () => {
      const conversationId = `ordinary-${STAMP}`;
      await prisma!.approval.create({
        data: {
          userId: ids.requester,
          conversationId,
          toolId: "whatsapp.send",
          action: "execute",
          params: {},
          status: "APPROVED",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect(await repo().findPendingByConversationId(conversationId, ids.requester)).toBeNull();
    });

    it("lists a member's pending write for the Organization's approvers only", async () => {
      const { approval } = await newWriteApproval();
      const seen = async (userId: string) =>
        (await repo().listAwaitingDecision(userId, ADMIN_ROLES, { limit: 100 })).items.map((i) => i.approval.id);
      expect(await seen(ids.approver)).toContain(approval.id);
      expect(await seen(ids.owner)).toContain(approval.id);
      expect(await seen(ids.requester)).not.toContain(approval.id);
      expect(await seen(ids.member)).not.toContain(approval.id);
      expect(await seen(ids.outsider)).not.toContain(approval.id);
      const item = (await repo().listAwaitingDecision(ids.approver, ADMIN_ROLES, { limit: 100 })).items.find(
        (i) => i.approval.id === approval.id
      );
      expect(item).toMatchObject({ requesterName: "User requester", readerIs: "approver" });
      expect((await repo().listAwaitingDecision(ids.approver, [])).items).toEqual([]);
    });

    it("shows one approval to its requester and its approvers, and to nobody else", async () => {
      const { approval } = await newWriteApproval();
      expect((await repo().findByIdForDecider(approval.id, ids.requester, ADMIN_ROLES))?.readerIs).toBe("requester");
      expect((await repo().findByIdForDecider(approval.id, ids.approver, ADMIN_ROLES))?.readerIs).toBe("approver");
      expect(await repo().findByIdForDecider(approval.id, ids.member, ADMIN_ROLES)).toBeNull();
      expect(await repo().findByIdForDecider(approval.id, ids.outsider, ADMIN_ROLES)).toBeNull();
      expect(await repo().findByIdForDecider(`missing-${STAMP}`, ids.approver, ADMIN_ROLES)).toBeNull();
    });
  });

  describe("a per-Organization window", () => {
    it("holds across accounts reserving at the same moment, and is not another Organization's", async () => {
      const store = new audit!.PrismaAuditRepository(prisma!);
      const storeOnSecond = new audit!.PrismaAuditRepository(second!);
      const action = `integration.test_budget.${ORG}.meta.${STAMP}`;
      const others = `integration.test_budget.${OTHER}.meta.${STAMP}`;
      const reservers = [ids.owner, ids.requester, ids.approver, ids.approver2];
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 === 0 ? store : storeOnSecond).reserveSharedSlot({
            action,
            userId: reservers[i % reservers.length]!,
            limit: 5,
            windowMs: 60_000,
          })
        )
      );
      expect(results.filter((r) => r.reserved)).toHaveLength(5);
      expect(await prisma!.auditLog.count({ where: { action } })).toBe(5);
      expect(await store.reserveSharedSlot({ action: others, userId: ids.outsider, limit: 5, windowMs: 60_000 })).toEqual({
        reserved: true,
        count: 1,
      });
    });
  });
});
