// Phase 17, Stage 3A — the tenant foundation against REAL PostgreSQL.
//
// What only a database can prove:
//   • the migration's constraints: one membership per (tenant, user), one owner
//     per connection, RESTRICT on a tenant that owns a connection, CASCADE on a
//     membership whose account goes;
//   • the repository reads by both ids and reflects a change at once;
//   • every operator change commits WITH its audit row or not at all;
//   • a tenant never loses its last owner, even when two operators demote its
//     two owners at the same moment. The race uses TWO Prisma clients — two
//     connection pools, which is what two command runs are — and is made
//     deterministic: the first transaction holds its row lock while it pauses
//     inside its audit write, so without the lock the second would pass.
//
// SAFETY. DATABASE_URL is read BEFORE the Prisma client is imported, because
// constructing a client loads packages/db/.env. The suite runs only against an
// explicitly supplied, separate test database — never the development (5432)
// or deployment (5433) one. Everything it creates is removed afterwards.
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

type Client = InstanceType<(typeof import("@prisma/client"))["PrismaClient"]>;
type Repo = typeof import("../src/repositories/tenant-repository.js");
type Admin = typeof import("../src/maintenance/tenant-admin.js");

let prisma: Client | null = null;
let second: Client | null = null;
let repoModule: Repo | null = null;
let admin: Admin | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  const Prisma = await import("@prisma/client");
  repoModule = await import("../src/repositories/tenant-repository.js");
  admin = await import("../src/maintenance/tenant-admin.js");
  prisma = new Prisma.PrismaClient();
  // A second client is a second connection pool: another command run.
  second = new Prisma.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    await second.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

/** Whether the shared n8n connection is free to be assigned by this suite (true on a fresh database). */
let connectorFree = false;
if (dbUp) {
  const existing = await prisma!.automationConnectorOwner.findUnique({
    where: { providerId_connector: { providerId: "n8n", connector: "mcp" } },
  });
  connectorFree = existing === null;
}

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const userIds: string[] = [];
const tenantIds: string[] = [];
const ids: Record<"actor" | "alice" | "bob" | "carol", string> = { actor: "", alice: "", bob: "", carol: "" };

const run = (command: Parameters<Admin["runTenantAdminCommand"]>[1], extra: Partial<Parameters<Admin["runTenantAdminCommand"]>[2]> = {}, client: Client = prisma!) =>
  admin!.runTenantAdminCommand(client, command, { actorUserId: ids.actor, execute: true, ...extra });

const repo = () => new repoModule!.PrismaTenantRepository(prisma!);
const auditRows = (action: string) =>
  prisma!.auditLog.findMany({ where: { userId: ids.actor, action }, orderBy: { createdAt: "asc" } });
const owners = (tenantId: string) => prisma!.tenantMembership.count({ where: { tenantId, role: "OWNER" } });

async function newTenant(ownerKey: keyof typeof ids, name = "Org"): Promise<string> {
  const result = await run({ verb: "create-tenant", name: `${name} ${STAMP}`, ownerUserId: ids[ownerKey] });
  if (!result.ok) throw new Error(`create-tenant refused: ${result.code}`);
  const tenantId = String(result.detail.tenantId);
  tenantIds.push(tenantId);
  return tenantId;
}

beforeAll(async () => {
  if (!dbUp) return;
  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const user = await prisma!.user.create({
      data: { email: `p17-${name}-${STAMP}@jarvis-test.local`, name, password: "x", role: "MEMBER" },
    });
    ids[name] = user.id;
    userIds.push(user.id);
  }
});

afterAll(async () => {
  if (prisma) {
    // Owners first (RESTRICT), then tenants (memberships cascade), then the
    // audit rows the commands wrote, then the accounts.
    await prisma.automationConnectorOwner.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  if (second) await second.$disconnect();
});

describe.skipIf(!dbUp)("Phase 17 Stage 3A — the tenant foundation on PostgreSQL", () => {
  describe("the migration's constraints", () => {
    it("holds one membership per (tenant, account)", async () => {
      const tenantId = await newTenant("alice");
      await expect(
        prisma!.tenantMembership.create({ data: { tenantId, userId: ids.alice, role: "MEMBER" } })
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("refuses a membership for an account that does not exist", async () => {
      const tenantId = await newTenant("alice");
      await expect(
        prisma!.tenantMembership.create({ data: { tenantId, userId: `missing-${STAMP}`, role: "MEMBER" } })
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("removes an account's memberships with the account", async () => {
      const leaving = await prisma!.user.create({
        data: { email: `p17-leaving-${STAMP}@jarvis-test.local`, name: "leaving", password: "x", role: "MEMBER" },
      });
      const tenantId = await newTenant("alice");
      await prisma!.tenantMembership.create({ data: { tenantId, userId: leaving.id, role: "MEMBER" } });
      await prisma!.user.delete({ where: { id: leaving.id } });
      expect(await repo().findMembership(leaving.id, tenantId)).toBeNull();
    });
  });

  describe("PrismaTenantRepository — an owner record that cannot be resolved is invalid (review finding L1)", () => {
    it(
      "reports a dangling or malformed owner record as invalid, through the real repository, and fails closed",
      async () => {
        // The foreign key forbids such rows, so the only way to make one is to
        // drop it — inside a transaction that is rolled back, so nothing
        // outlives the test. The repository reads through that transaction.
        const realTenant = await newTenant("alice", "Real owner");
        const ROLLBACK = new Error("roll back the probe");
        let seen: Record<string, unknown> = {};
        await expect(
          prisma!.$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe(
                'ALTER TABLE "AutomationConnectorOwner" DROP CONSTRAINT "AutomationConnectorOwner_tenant_id_fkey"'
              );
              const insert = (id: string, connector: string, tenantId: string) =>
                tx.$executeRaw`INSERT INTO "AutomationConnectorOwner" (id, provider_id, connector, tenant_id, created_at, updated_at)
                               VALUES (${id}, 'p17-probe', ${connector}, ${tenantId}, now(), now())`;
              await insert(`p17-dangling-${STAMP}`, "dangling", `ghost-tenant-${STAMP}`);
              await insert(`p17-malformed-${STAMP}`, "malformed", "not an id!");
              await insert(`p17-real-${STAMP}`, "real", realTenant);
              const reader = new repoModule!.PrismaTenantRepository(tx as unknown as Client);
              seen = {
                dangling: await reader.findConnectorOwner("p17-probe", "dangling"),
                malformed: await reader.findConnectorOwner("p17-probe", "malformed"),
                real: await reader.findConnectorOwner("p17-probe", "real"),
                missing: await reader.findConnectorOwner("p17-probe", "never-recorded"),
              };
              throw ROLLBACK;
            },
            { maxWait: 10_000, timeout: 15_000 }
          )
        ).rejects.toBe(ROLLBACK);

        expect(seen).toEqual({
          dangling: { status: "invalid" },
          malformed: { status: "invalid" },
          real: { status: "assigned", tenantId: realTenant },
          missing: { status: "unassigned" },
        });
        // Rolled back: no probe row is left, and the foreign key is back.
        expect(await prisma!.automationConnectorOwner.count({ where: { providerId: "p17-probe" } })).toBe(0);
        const fk = await prisma!.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'AutomationConnectorOwner_tenant_id_fkey'`;
        expect(fk[0]!.n).toBe(1);
      },
      20_000
    );
  });

  describe("PrismaTenantRepository — reads by both ids, and reflects a change at once", () => {
    it("finds a membership only for the tenant asked about", async () => {
      const tenantA = await newTenant("alice", "A");
      const tenantB = await newTenant("bob", "B");
      expect(await repo().findMembership(ids.alice, tenantA)).toEqual({ role: "owner" });
      expect(await repo().findMembership(ids.alice, tenantB)).toBeNull();
      expect(await repo().findMembership(ids.bob, tenantA)).toBeNull();
    });

    it("refuses to look up malformed ids at all", async () => {
      const tenantId = await newTenant("alice");
      expect(await repo().findMembership(`' OR 1=1 --`, tenantId)).toBeNull();
      expect(await repo().findMembership(ids.alice, "")).toBeNull();
    });

    it("sees a removed or re-roled membership on the very next read — nothing is cached", async () => {
      const tenantId = await newTenant("alice");
      expect((await run({ verb: "add-member", tenantId, userId: ids.bob, role: "member" })).ok).toBe(true);
      const reader = repo();
      expect(await reader.findMembership(ids.bob, tenantId)).toEqual({ role: "member" });

      expect((await run({ verb: "set-role", tenantId, userId: ids.bob, role: "viewer" })).ok).toBe(true);
      expect(await reader.findMembership(ids.bob, tenantId)).toEqual({ role: "viewer" });

      expect((await run({ verb: "remove-member", tenantId, userId: ids.bob })).ok).toBe(true);
      expect(await reader.findMembership(ids.bob, tenantId)).toBeNull();
    });
  });

  describe("operator changes — each with its audit row, in one transaction", () => {
    it("creates a tenant together with its first owner and the audit row", async () => {
      const before = (await auditRows("tenant.create")).length;
      const tenantId = await newTenant("carol", "Created");
      expect(await owners(tenantId)).toBe(1);
      const rows = await auditRows("tenant.create");
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)!.metadata).toEqual({ tenantId, userId: ids.carol, role: "owner" });
      expect(rows.at(-1)!.result).toBe("SUCCESS");
    });

    it("a dry run checks and writes nothing", async () => {
      const tenants = await prisma!.tenant.count();
      const audits = await prisma!.auditLog.count({ where: { userId: ids.actor } });
      const result = await admin!.runTenantAdminCommand(
        prisma!,
        { verb: "create-tenant", name: `Dry ${STAMP}`, ownerUserId: ids.alice },
        { actorUserId: ids.actor, execute: false }
      );
      expect(result).toMatchObject({ ok: true, executed: false });
      expect(await prisma!.tenant.count()).toBe(tenants);
      expect(await prisma!.auditLog.count({ where: { userId: ids.actor } })).toBe(audits);
    });

    it("adds, re-roles and removes a member, each recorded with ids and roles only", async () => {
      const tenantId = await newTenant("alice");
      expect((await run({ verb: "add-member", tenantId, userId: ids.bob, role: "admin" })).ok).toBe(true);
      expect((await run({ verb: "set-role", tenantId, userId: ids.bob, role: "member" })).ok).toBe(true);
      expect((await run({ verb: "remove-member", tenantId, userId: ids.bob })).ok).toBe(true);

      const add = (await auditRows("tenant.member.add")).at(-1)!;
      const role = (await auditRows("tenant.member.role")).at(-1)!;
      const remove = (await auditRows("tenant.member.remove")).at(-1)!;
      expect(add.metadata).toEqual({ tenantId, userId: ids.bob, role: "admin" });
      expect(role.metadata).toEqual({ tenantId, userId: ids.bob, role: "member", previousRole: "admin" });
      expect(remove.metadata).toEqual({ tenantId, userId: ids.bob, previousRole: "member" });
    });

    type Command = Parameters<Admin["runTenantAdminCommand"]>[1];
    it.each<[string, (tenantId: string) => Command]>([
      ["create-tenant", () => ({ verb: "create-tenant", name: `Atomic ${STAMP}`, ownerUserId: ids.alice })],
      ["add-member", (tenantId) => ({ verb: "add-member", tenantId, userId: ids.bob, role: "member" })],
      ["set-role", (tenantId) => ({ verb: "set-role", tenantId, userId: ids.carol, role: "viewer" })],
      ["remove-member", (tenantId) => ({ verb: "remove-member", tenantId, userId: ids.carol })],
    ])("rolls the %s change back when its audit row cannot be written", async (_verb, build) => {
      const tenantId = await newTenant("alice");
      expect((await run({ verb: "add-member", tenantId, userId: ids.carol, role: "member" })).ok).toBe(true);
      const tenantsBefore = await prisma!.tenant.count();
      const membershipsBefore = await prisma!.tenantMembership.findMany({
        where: { tenantId },
        select: { userId: true, role: true },
        orderBy: { userId: "asc" },
      });
      const auditsBefore = await prisma!.auditLog.count({ where: { userId: ids.actor } });

      const failingAudit = async () => {
        throw new Error("audit store unavailable");
      };
      await expect(run(build(tenantId), { writeAudit: failingAudit })).rejects.toThrow("audit store unavailable");

      expect(await prisma!.tenant.count()).toBe(tenantsBefore);
      expect(
        await prisma!.tenantMembership.findMany({ where: { tenantId }, select: { userId: true, role: true }, orderBy: { userId: "asc" } })
      ).toEqual(membershipsBefore);
      expect(await prisma!.auditLog.count({ where: { userId: ids.actor } })).toBe(auditsBefore);
    });

    it("refuses with a fixed code and writes nothing", async () => {
      const tenantId = await newTenant("alice");
      const audits = await prisma!.auditLog.count({ where: { userId: ids.actor } });
      const cases: Array<[Parameters<Admin["runTenantAdminCommand"]>[1], string, string?]> = [
        [{ verb: "add-member", tenantId: `missing-${STAMP}`, userId: ids.bob, role: "member" }, "TENANT_NOT_FOUND"],
        [{ verb: "add-member", tenantId, userId: `missing-${STAMP}`, role: "member" }, "USER_NOT_FOUND"],
        [{ verb: "add-member", tenantId, userId: ids.alice, role: "member" }, "ALREADY_MEMBER"],
        [{ verb: "set-role", tenantId, userId: ids.bob, role: "member" }, "NOT_A_MEMBER"],
        [{ verb: "set-role", tenantId, userId: ids.alice, role: "owner" }, "NO_CHANGE"],
        [{ verb: "remove-member", tenantId, userId: ids.bob }, "NOT_A_MEMBER"],
        [{ verb: "assign-connector", providerId: "n8n", connector: "rest", tenantId }, "UNKNOWN_CONNECTOR"],
      ];
      for (const [command, code] of cases) {
        const result = await run(command);
        expect(result, code).toMatchObject({ ok: false, code });
      }
      const ghost = await admin!.runTenantAdminCommand(
        prisma!,
        { verb: "add-member", tenantId, userId: ids.bob, role: "member" },
        { actorUserId: `missing-${STAMP}`, execute: true }
      );
      expect(ghost).toMatchObject({ ok: false, code: "ACTOR_NOT_FOUND" });
      expect(await prisma!.auditLog.count({ where: { userId: ids.actor } })).toBe(audits);
      expect(await repo().findMembership(ids.bob, tenantId)).toBeNull();
    });
  });

  describe("a tenant never loses its last owner", () => {
    it("refuses to demote or remove the only owner", async () => {
      const tenantId = await newTenant("alice");
      expect(await run({ verb: "set-role", tenantId, userId: ids.alice, role: "admin" })).toMatchObject({ ok: false, code: "LAST_OWNER" });
      expect(await run({ verb: "remove-member", tenantId, userId: ids.alice })).toMatchObject({ ok: false, code: "LAST_OWNER" });
      expect(await owners(tenantId)).toBe(1);
    });

    it("allows it once another owner exists", async () => {
      const tenantId = await newTenant("alice");
      expect((await run({ verb: "add-member", tenantId, userId: ids.bob, role: "owner" })).ok).toBe(true);
      expect((await run({ verb: "set-role", tenantId, userId: ids.alice, role: "member" })).ok).toBe(true);
      expect(await owners(tenantId)).toBe(1);
    });

    it(
      "lets exactly one of two concurrent demotions of the two owners through (deterministic overlap)",
      async () => {
        const tenantId = await newTenant("alice");
        expect((await run({ verb: "add-member", tenantId, userId: ids.bob, role: "owner" })).ok).toBe(true);

        // A holds the tenant lock and pauses inside its audit write; B starts
        // while A is still open. With the lock, B waits and then sees one owner.
        const slowAudit = async (tx: Parameters<NonNullable<Parameters<Admin["runTenantAdminCommand"]>[2]["writeAudit"]>>[0], row: { userId: string; action: string; metadata: Record<string, string> }) => {
          await tx.$executeRaw`SELECT pg_sleep(0.4)`;
          await tx.auditLog.create({ data: { userId: row.userId, action: row.action, result: "SUCCESS", metadata: { ...row.metadata } } });
        };
        const first = run({ verb: "set-role", tenantId, userId: ids.alice, role: "member" }, { writeAudit: slowAudit }, prisma!);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const secondRun = run({ verb: "set-role", tenantId, userId: ids.bob, role: "member" }, {}, second!);
        const results = await Promise.all([first, secondRun]);

        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.find((r) => !r.ok)).toMatchObject({ code: "LAST_OWNER" });
        expect(await owners(tenantId)).toBe(1);
      },
      20_000
    );

    it(
      "holds under simultaneous demotions and removals, round after round",
      async () => {
        for (let round = 0; round < 5; round++) {
          const tenantId = await newTenant("alice", `Race ${round}`);
          expect((await run({ verb: "add-member", tenantId, userId: ids.bob, role: "owner" })).ok).toBe(true);
          const demoteOrRemoveAlice: Parameters<Admin["runTenantAdminCommand"]>[1] =
            round % 2
              ? { verb: "remove-member", tenantId, userId: ids.alice }
              : { verb: "set-role", tenantId, userId: ids.alice, role: "viewer" };
          const results = await Promise.all([
            run(demoteOrRemoveAlice, {}, prisma!),
            run({ verb: "remove-member", tenantId, userId: ids.bob }, {}, second!),
          ]);
          expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
          expect(await owners(tenantId), `round ${round}`).toBe(1);
        }
      },
      30_000
    );
  });

  describe.skipIf(!connectorFree)("the shared connection's owner", () => {
    it("is unassigned until an operator assigns it, then readable, movable and removable — each audited", async () => {
      const reader = repo();
      expect(await reader.findConnectorOwner("n8n", "mcp")).toEqual({ status: "unassigned" });

      const tenantA = await newTenant("alice", "Owner A");
      const tenantB = await newTenant("bob", "Owner B");
      expect((await run({ verb: "assign-connector", providerId: "n8n", connector: "mcp", tenantId: tenantA })).ok).toBe(true);
      expect(await reader.findConnectorOwner("n8n", "mcp")).toEqual({ status: "assigned", tenantId: tenantA });

      expect(await run({ verb: "assign-connector", providerId: "n8n", connector: "mcp", tenantId: tenantA })).toMatchObject({
        ok: false,
        code: "NO_CHANGE",
      });

      expect((await run({ verb: "assign-connector", providerId: "n8n", connector: "mcp", tenantId: tenantB })).ok).toBe(true);
      expect(await reader.findConnectorOwner("n8n", "mcp")).toEqual({ status: "assigned", tenantId: tenantB });
      expect((await auditRows("tenant.connector.assign")).at(-1)!.metadata).toEqual({
        providerId: "n8n",
        connector: "mcp",
        tenantId: tenantB,
        previousTenantId: tenantA,
      });

      // RESTRICT: the owning tenant cannot be deleted while it owns the connection.
      await expect(prisma!.tenant.delete({ where: { id: tenantB } })).rejects.toMatchObject({ code: "P2003" });

      expect((await run({ verb: "unassign-connector", providerId: "n8n", connector: "mcp" })).ok).toBe(true);
      expect(await reader.findConnectorOwner("n8n", "mcp")).toEqual({ status: "unassigned" });
      expect(await run({ verb: "unassign-connector", providerId: "n8n", connector: "mcp" })).toMatchObject({
        ok: false,
        code: "CONNECTOR_NOT_ASSIGNED",
      });
    });

    it("rolls an assignment back when its audit row cannot be written", async () => {
      const tenantId = await newTenant("alice", "Atomic owner");
      await expect(
        run({ verb: "assign-connector", providerId: "n8n", connector: "mcp", tenantId }, {
          writeAudit: async () => {
            throw new Error("audit store unavailable");
          },
        })
      ).rejects.toThrow("audit store unavailable");
      expect(await repo().findConnectorOwner("n8n", "mcp")).toEqual({ status: "unassigned" });
    });

    it("lists a tenant's members and the connections it owns", async () => {
      const tenantId = await newTenant("alice", "Listed");
      expect((await run({ verb: "add-member", tenantId, userId: ids.bob, role: "viewer" })).ok).toBe(true);
      expect((await run({ verb: "assign-connector", providerId: "n8n", connector: "mcp", tenantId })).ok).toBe(true);
      const listed = await admin!.runTenantAdminCommand(prisma!, { verb: "list", tenantId }, { actorUserId: ids.actor, execute: false });
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.detail.members).toEqual(
          [
            { userId: ids.alice, role: "owner" },
            { userId: ids.bob, role: "viewer" },
          ].sort((a, b) => (a.userId < b.userId ? -1 : 1))
        );
        expect(listed.detail.connectors).toEqual([{ providerId: "n8n", connector: "mcp" }]);
      }
      expect((await run({ verb: "unassign-connector", providerId: "n8n", connector: "mcp" })).ok).toBe(true);
    });
  });
});
