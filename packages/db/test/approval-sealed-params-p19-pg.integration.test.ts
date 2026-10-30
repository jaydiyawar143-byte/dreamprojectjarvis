// ---------------------------------------------------------------------------
// Phase 19, Stage 19.5 — value-free approval records on PostgreSQL (S3).
//
// A browser or desktop approval is bound to its exact parameters by their
// hash, and they must still run once approved. What the Approval row keeps in
// their place is the value-free record — action, summary, origin, field names
// and counts. The exact parameters are sealed apart from it, in
// ApprovalSealedParams, and that row is gone once the approval is rejected,
// consumed or expired. These tests read the rows themselves: nothing a person
// typed may be in either table in the clear, and nothing may outlive the
// approval's use.
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one. It assigns the
// deployment's browser connection to an Organization of its own, so it refuses
// a database where that connection is already assigned.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { COMPUTER_CONTROL_APPROVAL_RECORD, computeParamsHash, type ApprovalParamsSealer } from "@jarvis/core";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Client = InstanceType<(typeof import("@prisma/client"))["PrismaClient"]>;
type ApprovalModule = typeof import("../src/repositories/approval-repository.js");
type Admin = typeof import("../src/maintenance/tenant-admin.js");

let prisma: Client | null = null;
let second: Client | null = null;
let approvals: ApprovalModule | null = null;
let admin: Admin | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  const Prisma = await import("@prisma/client");
  approvals = await import("../src/repositories/approval-repository.js");
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

/** AES-256-GCM, as the API's EncryptionService is: what the store is handed. */
function testSealer(key = randomBytes(32)): ApprovalParamsSealer {
  return {
    seal(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return `t1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${body.toString("base64")}`;
    },
    unseal(sealed) {
      const [tag, iv, auth, body] = sealed.split(":");
      if (tag !== "t1" || !iv || !auth || !body) throw new Error("not sealed here");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(auth, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
    },
  };
}

const KEY = randomBytes(32);
const SEALER = testSealer(KEY);

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const BROWSER = { providerId: "browser", connector: "service" } as const;
const SECRET = `hunter2-TYPED-${STAMP}`;
const TOKEN = `tok-${STAMP}`;

const userIds: string[] = [];
const tenantIds: string[] = [];
const ids: Record<"actor" | "owner" | "requester" | "approver", string> = { actor: "", owner: "", requester: "", approver: "" };
let ORG = "";

const run = async (command: Parameters<Admin["runTenantAdminCommand"]>[1]) => {
  const result = await admin!.runTenantAdminCommand(prisma!, command, { actorUserId: ids.actor, execute: true });
  if (!result.ok) throw new Error(`${command.verb} refused: ${result.code}`);
  return result;
};

const repo = (sealer: ApprovalParamsSealer | null = SEALER, client = prisma!) =>
  new approvals!.PrismaApprovalRepository(client, sealer ? { sealer } : {});

let seq = 0;
function typeParams() {
  return { url: `https://shop.example/login?token=${TOKEN}`, selector: "#password", text: `${SECRET}-${seq++}` };
}

async function newTypeApproval(params = typeParams(), over: Record<string, unknown> = {}, sealer: ApprovalParamsSealer | null = SEALER) {
  const approval = await repo(sealer).create({
    userId: ids.requester,
    conversationId: `conv-${STAMP}`,
    toolId: "browser.type",
    action: "execute",
    params,
    paramsHash: computeParamsHash(params),
    riskLevel: "EXTERNAL_SIDE_EFFECT",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...over,
  });
  return { approval, params };
}

const sealedRow = (approvalId: string) => prisma!.approvalSealedParams.findUnique({ where: { approvalId } });
const storedParams = async (approvalId: string) => (await prisma!.approval.findUnique({ where: { id: approvalId } }))!.params;

/** Everything both tables hold for an approval, as text — what a dump would show. */
async function rawText(approvalId: string): Promise<string> {
  const rows = await prisma!.$queryRaw<Array<{ approval: unknown; sealed: unknown }>>`
    SELECT row_to_json(a)::text AS "approval", row_to_json(s)::text AS "sealed"
    FROM "Approval" a LEFT JOIN "ApprovalSealedParams" s ON s."approval_id" = a."id"
    WHERE a."id" = ${approvalId}`;
  return JSON.stringify(rows);
}

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) throw new Error("These security tests need a separate PostgreSQL test database, and none could be reached.");
  const taken = await prisma!.automationConnectorOwner.findUnique({
    where: { providerId_connector: { providerId: BROWSER.providerId, connector: BROWSER.connector } },
  });
  if (taken) {
    throw new Error("browser/service is already assigned on this database — run this suite against a fresh test database");
  }
  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const user = await prisma!.user.create({
      data: { email: `p195-${name}-${STAMP}@jarvis-test.local`, name: `User ${name}`, password: "x", role: "OWNER" },
    });
    ids[name] = user.id;
    userIds.push(user.id);
  }
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
  if (second) await second.$disconnect();
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.5 — browser approvals keep no typed value (PostgreSQL)", () => {
  it("stores the value-free record in the approval, and the exact parameters only sealed", async () => {
    const { approval, params } = await newTypeApproval();

    const stored = (await storedParams(approval.id)) as Record<string, unknown>;
    expect(stored).toMatchObject({
      withheld: COMPUTER_CONTROL_APPROVAL_RECORD,
      action: "browser.type",
      targetResource: "https://shop.example",
    });
    const sealed = await sealedRow(approval.id);
    expect(sealed?.sealed).toMatch(/^t1:/);
    // Bound to the exact parameters, as before.
    expect((await prisma!.approval.findUnique({ where: { id: approval.id } }))!.paramsHash).toBe(computeParamsHash(params));

    const dump = await rawText(approval.id);
    for (const value of [params.text, SECRET, TOKEN, "/login"]) expect(dump).not.toContain(value);
  });

  it("hands every reader the exact parameters while the approval can still run — on any instance", async () => {
    const { approval, params } = await newTypeApproval();
    const hash = computeParamsHash(params);
    const reads = [
      await repo().findById(approval.id),
      await repo().findPendingByConversationId(`conv-${STAMP}`, ids.requester),
      (await repo().listByUser(ids.requester, { limit: 100 })).items.find((a) => a.id === approval.id),
      (await repo().findByIdForDecider(approval.id, ids.approver, ["owner", "admin"]))?.approval,
      (await repo().listAwaitingDecision(ids.approver, ["owner", "admin"], { limit: 100 })).items.find((i) => i.approval.id === approval.id)?.approval,
      // A second API instance, and a restarted one: the same key, another pool.
      await repo(testSealer(KEY), second!).findById(approval.id),
    ];
    for (const read of reads) {
      expect(read?.params).toEqual(params);
      expect(computeParamsHash(read!.params)).toBe(hash);
    }
  });

  it("refuses to create one when nothing can seal it, and writes nothing", async () => {
    const before = await prisma!.approval.count({ where: { userId: ids.requester } });
    await expect(newTypeApproval(typeParams(), {}, null)).rejects.toBeInstanceOf(approvals!.ApprovalParamsSealingUnavailableError);
    expect(await prisma!.approval.count({ where: { userId: ids.requester } })).toBe(before);
  });

  it("answers with the value-free record — never runnable — to a reader without the key, with another key, or after tampering", async () => {
    const { approval, params } = await newTypeApproval();
    const other = await newTypeApproval();
    const recordOnly = (read: { params: Record<string, unknown> } | null) => {
      expect(read?.params).toMatchObject({ withheld: COMPUTER_CONTROL_APPROVAL_RECORD });
      expect(computeParamsHash(read!.params)).not.toBe(computeParamsHash(params));
    };
    recordOnly(await repo(null).findById(approval.id));
    recordOnly(await repo(testSealer()).findById(approval.id));

    // Another approval's sealed parameters, moved onto this one: they decrypt,
    // and do not hash to what this approval was bound to.
    const theirs = (await sealedRow(other.approval.id))!.sealed;
    await prisma!.approvalSealedParams.update({ where: { approvalId: approval.id }, data: { sealed: theirs } });
    recordOnly(await repo().findById(approval.id));
  });

  it("forgets the exact parameters once the approval is rejected — and keeps the record to show", async () => {
    const { approval } = await newTypeApproval();
    expect(await repo().decideApproval(approval.id, ids.requester, "reject", { fromPendingOnly: true })).toEqual({ outcome: "rejected" });
    expect(await sealedRow(approval.id)).toBeNull();
    expect(await storedParams(approval.id)).toMatchObject({ withheld: COMPUTER_CONTROL_APPROVAL_RECORD, action: "browser.type" });
  });

  it("keeps them through an approval for the requester to run, and forgets them in the transaction that consumes it", async () => {
    const { approval, params } = await newTypeApproval();
    expect(await repo().decideApproval(approval.id, ids.approver, "approve", { approverRoles: ["owner", "admin"] })).toEqual({ outcome: "approved" });
    expect(await sealedRow(approval.id)).not.toBeNull();
    expect((await repo().findById(approval.id))?.params).toEqual(params);

    const execution = await prisma!.toolExecution.create({
      data: { userId: ids.requester, toolId: "browser.type", idempotencyKey: `idem-${approval.id}`, status: "PENDING" },
    });
    const consumed = await repo().consumeForExecution({
      approvalId: approval.id,
      userId: ids.requester,
      toolId: "browser.type",
      paramsHash: computeParamsHash(params),
      executionId: execution.executionId,
      tenantScope: { tenantId: ORG, ...BROWSER, requesterRoles: ["owner", "admin"], approverRoles: ["owner", "admin"] },
    });
    expect(consumed).toEqual({ ok: true });
    expect(await sealedRow(approval.id)).toBeNull();
    for (const value of [params.text, TOKEN]) expect(await rawText(approval.id)).not.toContain(value);
  });

  it("keeps them when a consumption is refused, so nothing is lost by a refusal", async () => {
    const { approval, params } = await newTypeApproval();
    const execution = await prisma!.toolExecution.create({
      data: { userId: ids.requester, toolId: "browser.type", idempotencyKey: `idem-refused-${approval.id}`, status: "PENDING" },
    });
    // Not approved yet: refused, and rolled back.
    const refused = await repo().consumeForExecution({
      approvalId: approval.id,
      userId: ids.requester,
      toolId: "browser.type",
      paramsHash: computeParamsHash(params),
      executionId: execution.executionId,
      tenantScope: { tenantId: ORG, ...BROWSER, requesterRoles: ["owner", "admin"], approverRoles: ["owner", "admin"] },
    });
    expect(refused.ok).toBe(false);
    expect(await sealedRow(approval.id)).not.toBeNull();
  });

  it("purges the sealed parameters of an expired approval, and only those", async () => {
    const expired = await newTypeApproval();
    const live = await newTypeApproval();
    await prisma!.approvalSealedParams.update({
      where: { approvalId: expired.approval.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await repo().purgeExpiredSealedParams()).toBeGreaterThanOrEqual(1);
    expect(await sealedRow(expired.approval.id)).toBeNull();
    expect(await sealedRow(live.approval.id)).not.toBeNull();
    // Creating an approval also purges what has expired.
    const already = await newTypeApproval(typeParams(), { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await newTypeApproval();
    expect(await sealedRow(already.approval.id)).toBeNull();
  });

  it("purges the sealed parameters of an approval that can no longer run, whatever its expiry says", async () => {
    // A rejection whose own deletion was lost: the sealed row is still there.
    const { approval } = await newTypeApproval();
    const sealed = (await sealedRow(approval.id))!;
    await prisma!.approval.update({ where: { id: approval.id }, data: { status: "REJECTED" } });
    expect(await sealedRow(approval.id)).toEqual(sealed);
    await repo().purgeExpiredSealedParams();
    expect(await sealedRow(approval.id)).toBeNull();
  });

  it("forgets them when the status is set directly to a state that never runs, and only then", async () => {
    const approved = await newTypeApproval();
    expect((await repo().updateStatus(approved.approval.id, "approved"))?.params).toEqual(approved.params);
    expect(await sealedRow(approved.approval.id)).not.toBeNull();

    for (const status of ["rejected", "expired"] as const) {
      const { approval } = await newTypeApproval();
      const updated = await repo().updateStatus(approval.id, status);
      expect(updated?.params).toMatchObject({ withheld: COMPUTER_CONTROL_APPROVAL_RECORD });
      expect(await sealedRow(approval.id)).toBeNull();
    }
  });

  it("seals new parameters given to a waiting approval, too", async () => {
    const { approval } = await newTypeApproval();
    const changed = typeParams();
    const updated = await repo().updateParams(approval.id, changed, computeParamsHash(changed));
    expect(updated?.params).toEqual(changed);
    const dump = await rawText(approval.id);
    expect(dump).not.toContain(changed.text);
    expect(await storedParams(approval.id)).toMatchObject({ withheld: COMPUTER_CONTROL_APPROVAL_RECORD });
  });

  it("goes with its approval when the approval is deleted", async () => {
    const { approval } = await newTypeApproval();
    await prisma!.approval.delete({ where: { id: approval.id } });
    expect(await sealedRow(approval.id)).toBeNull();
  });

  it("leaves every other tool's approval exactly as it was", async () => {
    const params = { memoryIds: ["m-1"], versions: ["2026-10-01T00:00:00.000Z"] };
    const approval = await repo().create({
      userId: ids.requester,
      conversationId: `conv-other-${STAMP}`,
      toolId: "memory.forget",
      action: "Forget 1 memory",
      params,
      paramsHash: computeParamsHash(params),
      riskLevel: "HIGH_IMPACT",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(await storedParams(approval.id)).toEqual(params);
    expect(await sealedRow(approval.id)).toBeNull();
    // Nor does it need a sealer.
    expect((await repo(null).findById(approval.id))?.params).toEqual(params);
  });
});
