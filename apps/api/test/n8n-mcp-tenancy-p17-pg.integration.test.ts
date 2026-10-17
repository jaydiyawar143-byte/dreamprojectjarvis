// Phase 17 Stage 3A — the n8n MCP read routes on the REAL organization reads
// and the REAL audit log, against PostgreSQL.
//
//   GET /api/v1/n8n/mcp/tools  →  PrismaTenantRepository  →  "AutomationConnectorOwner",
//                                                             "TenantMembership"
//                              →  AuditLogger → PrismaAuditRepository → "AuditLog"
//
// The only doubles are the session (the terminal handler is driven directly,
// as in the other route suites) and the n8n connector, which counts what
// reached it and calls no provider. Everything else is the production code:
// tenants, memberships and the connection's owner are written by the operator
// command's writer (`runTenantAdminCommand`), as an operator would.
//
// What it proves that the suites with fakes cannot:
//   - the route authorizes from database state: owner, admin and member are
//     served; a viewer, an outsider and an account-wide admin who is not a
//     member are refused;
//   - a membership removed, or the owner unassigned, by the operator command
//     applies to the very next request (review finding: missing end-to-end);
//   - a dangling owner record is refused as INVALID, not as an outage
//     (review finding L1);
//   - a flood of refusals writes at most the attempt window's rows plus one
//     to the real audit table (review finding M1).
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client. The
// suite runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one. Everything it creates
// is removed afterwards.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Response } from "express";
import type { Container } from "../src/services/container.js";
import type { N8nMcpTenancy } from "../src/routes/n8n-mcp.js";
import type { N8nMcpConnector } from "@jarvis/n8n";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

type Db = typeof import("@jarvis/db");
type Route = typeof import("../src/routes/n8n-mcp.js");
type Security = typeof import("@jarvis/security");
type Client = InstanceType<Db["PrismaClient"]>;

let db: Db | null = null;
let route: Route | null = null;
let security: Security | null = null;
let prisma: Client | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  route = await import("../src/routes/n8n-mcp.js");
  security = await import("@jarvis/security");
  prisma = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

/** True on a fresh database: this suite owns the shared n8n connection's owner row while it runs. */
let connectorFree = false;
if (dbUp) {
  const existing = await prisma!.automationConnectorOwner.findUnique({
    where: { providerId_connector: { providerId: "n8n", connector: "mcp" } },
  });
  connectorFree = existing === null;
}

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PEOPLE = ["operator", "owner", "admin", "member", "viewer", "outsider", "platformAdmin", "flooder"] as const;
type Person = (typeof PEOPLE)[number];
const ids = Object.fromEntries(PEOPLE.map((p) => [p, ""])) as Record<Person, string>;
const userIds: string[] = [];
const tenantIds: string[] = [];
let tenantId = "";

/** The account-wide role each person signs in with — unrelated to their membership. */
const ACCOUNT_ROLE: Record<Person, "OWNER" | "ADMIN" | "MEMBER"> = {
  operator: "OWNER",
  owner: "MEMBER",
  admin: "MEMBER",
  member: "MEMBER",
  viewer: "MEMBER",
  outsider: "MEMBER",
  platformAdmin: "ADMIN",
  flooder: "MEMBER",
};

const admin = (command: Parameters<Db["runTenantAdminCommand"]>[1]) =>
  db!.runTenantAdminCommand(prisma!, command, { actorUserId: ids.operator, execute: true });

beforeAll(async () => {
  if (!dbUp || !connectorFree) return;
  for (const person of PEOPLE) {
    const user = await prisma!.user.create({
      data: {
        email: `p17-route-${person}-${STAMP}@jarvis-test.local`,
        name: person,
        password: "not-a-real-password-hash",
        role: ACCOUNT_ROLE[person],
      },
    });
    ids[person] = user.id;
    userIds.push(user.id);
  }
  const created = await admin({ verb: "create-tenant", name: `Route Org ${STAMP}`, ownerUserId: ids.owner });
  if (!created.ok) throw new Error(`create-tenant refused: ${created.code}`);
  tenantId = String(created.detail.tenantId);
  tenantIds.push(tenantId);
  for (const [person, role] of [
    ["admin", "admin"],
    ["member", "member"],
    ["viewer", "viewer"],
  ] as const) {
    const added = await admin({ verb: "add-member", tenantId, userId: ids[person], role });
    if (!added.ok) throw new Error(`add-member refused: ${added.code}`);
  }
  const assigned = await admin({ verb: "assign-connector", providerId: "n8n", connector: "mcp", tenantId });
  if (!assigned.ok) throw new Error(`assign-connector refused: ${assigned.code}`);
});

afterAll(async () => {
  if (prisma) {
    await prisma.automationConnectorOwner.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// Harness — the router's terminal handler, a stub connector, the real reads.
// ---------------------------------------------------------------------------

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

function stubConnector() {
  const calls = { discover: 0, invoke: 0 };
  const connector: N8nMcpConnector = {
    endpoint: "https://n8n.example.test/mcp-server/http",
    async discoverTools() {
      calls.discover += 1;
      return {
        ok: true,
        data: {
          tools: [{ name: "list_sheets", description: null, inputSchema: null, readOnly: true, destructive: false }],
          serverInfo: null,
          truncated: false,
        },
      };
    },
    async invokeTool() {
      calls.invoke += 1;
      return { ok: true, content: [] };
    },
    async close() {
      /* nothing */
    },
  };
  return { calls, getConnector: () => connector };
}

function router(tenancy: N8nMcpTenancy) {
  const auditLogger = new security!.AuditLogger(new db!.PrismaAuditRepository(prisma!));
  const container = { tokenService: { verifyAccessToken: () => null }, auditLogger } as unknown as Container;
  const connector = stubConnector();
  const built = route!.createN8nMcpRouter(container, { getConnector: connector.getConnector, tenancy });
  const layer = (
    built as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
    }
  ).stack.find((l) => l.route?.path === "/tools" && l.route.methods.get)!;
  const handler = layer.route!.stack.at(-1)!.handle;

  const send = async (person: Person): Promise<Captured> => {
    const captured: Captured = { status: 0, body: {} };
    const res = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: Record<string, unknown>) {
        captured.body = body;
        return this;
      },
      setHeader() {
        return this;
      },
    } as unknown as Response;
    const req = {
      method: "GET",
      path: "/tools",
      query: {},
      headers: {},
      auth: { userId: ids[person], role: ACCOUNT_ROLE[person].toLowerCase(), email: `${person}@jarvis-test.local` },
    } as never;
    await handler(req, res, () => undefined);
    return captured;
  };
  return { send, connector };
}

const realReads = () => new db!.PrismaTenantRepository(prisma!);
const code = (r: Captured) => (r.body.error as { code?: string } | undefined)?.code;
const auditOf = (person: Person) =>
  prisma!.auditLog.findMany({
    where: { userId: ids[person], action: "n8n_mcp.discover" },
    orderBy: { createdAt: "asc" },
    select: { result: true, metadata: true },
  });

describe.skipIf(!dbUp || !connectorFree)("Phase 17 Stage 3A — n8n MCP discovery on the real organization reads", () => {
  it("serves owner, admin and member; refuses a viewer, an outsider and an account-wide admin who is not a member", async () => {
    const { send, connector } = router(realReads());

    for (const person of ["owner", "admin", "member"] as const) {
      expect((await send(person)).status, person).toBe(200);
    }
    const viewer = await send("viewer");
    expect([viewer.status, code(viewer)]).toEqual([403, "SURFACE_PERMISSION_DENIED"]);
    for (const person of ["outsider", "platformAdmin"] as const) {
      const refused = await send(person);
      expect([refused.status, code(refused)], person).toEqual([403, "TENANT_ACCESS_DENIED"]);
    }
    expect(connector.calls).toEqual({ discover: 3, invoke: 0 });

    // The real audit rows: the served member's names the organization; the
    // outsider's keeps the precise reason and names none.
    const member = await auditOf("member");
    expect(member.at(-1)).toMatchObject({ result: "SUCCESS", metadata: { tenantId } });
    const outsider = await auditOf("outsider");
    expect(outsider.at(-1)).toMatchObject({ result: "REJECTED", metadata: { authz: "TENANT_MEMBERSHIP_REQUIRED" } });
    expect(JSON.stringify(outsider)).not.toContain(tenantId);
  });

  it("applies a removal by the operator command to the very next request", async () => {
    const { send } = router(realReads());
    expect((await send("member")).status).toBe(200);

    expect((await admin({ verb: "remove-member", tenantId, userId: ids.member })).ok).toBe(true);
    const next = await send("member");
    expect([next.status, code(next)]).toEqual([403, "TENANT_ACCESS_DENIED"]);

    expect((await admin({ verb: "add-member", tenantId, userId: ids.member, role: "member" })).ok).toBe(true);
    expect((await send("member")).status).toBe(200);
  });

  it("refuses everyone while the connection is unassigned, with RESOURCE_OWNERSHIP_MISSING recorded", async () => {
    const { send, connector } = router(realReads());
    expect((await admin({ verb: "unassign-connector", providerId: "n8n", connector: "mcp" })).ok).toBe(true);
    try {
      for (const person of ["owner", "member", "platformAdmin"] as const) {
        const refused = await send(person);
        expect([refused.status, code(refused)], person).toEqual([403, "TENANT_ACCESS_DENIED"]);
      }
      expect(connector.calls.discover).toBe(0);
      expect((await auditOf("owner")).at(-1)).toMatchObject({ metadata: { authz: "RESOURCE_OWNERSHIP_MISSING" } });
    } finally {
      expect((await admin({ verb: "assign-connector", providerId: "n8n", connector: "mcp", tenantId })).ok).toBe(true);
    }
  });

  it(
    "refuses a dangling owner record as INVALID — not as an outage (review finding L1)",
    async () => {
      // The foreign key forbids such a record, so it is made inside a
      // transaction that is rolled back; the route reads through it. The audit
      // row is written by the real logger, outside the transaction, so it stays.
      const ROLLBACK = new Error("roll back the probe");
      let answer: Captured | null = null;
      let discovered = -1;
      await expect(
        prisma!.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              'ALTER TABLE "AutomationConnectorOwner" DROP CONSTRAINT "AutomationConnectorOwner_tenant_id_fkey"'
            );
            await tx.$executeRaw`UPDATE "AutomationConnectorOwner" SET tenant_id = ${`ghost-${STAMP}`}
                                 WHERE provider_id = 'n8n' AND connector = 'mcp'`;
            const { send, connector } = router(new db!.PrismaTenantRepository(tx as unknown as Client));
            answer = await send("owner");
            discovered = connector.calls.discover;
            throw ROLLBACK;
          },
          { maxWait: 10_000, timeout: 15_000 }
        )
      ).rejects.toBe(ROLLBACK);

      expect([answer!.status, code(answer!)]).toEqual([403, "TENANT_ACCESS_DENIED"]);
      expect(discovered).toBe(0);
      expect((await auditOf("owner")).at(-1)).toMatchObject({ metadata: { authz: "RESOURCE_OWNERSHIP_INVALID" } });
      // Rolled back: the real owner and the foreign key are back.
      expect(await realReads().findConnectorOwner("n8n", "mcp")).toEqual({ status: "assigned", tenantId });
    },
    20_000
  );

  it("writes at most the attempt window's rows plus one to the real audit log under a flood of refusals (M1)", async () => {
    const { send } = router(realReads());
    const { limit } = route!.N8N_MCP_ATTEMPT_LIMITS.discover;

    const statuses: number[] = [];
    for (let i = 0; i < limit + 20; i++) statuses.push((await send("flooder")).status);

    expect(statuses.filter((s) => s === 403)).toHaveLength(limit);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
    const rows = await auditOf("flooder");
    expect(rows).toHaveLength(limit + 1);
    expect(rows.filter((row) => (row.metadata as { throttled?: boolean } | null)?.throttled === true)).toHaveLength(1);
  });
});
