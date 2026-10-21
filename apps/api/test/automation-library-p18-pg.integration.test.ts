// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — the Automation Library end to end, on PostgreSQL.
//
// The real engine, the real service and the real Prisma repository; n8n is a
// fake whose cursor carries an offset, as n8n's does. No network.
//
//   1. 5,600 workflows catalogued by three bounded runs, each on a NEW
//      database connection and a new service — a restarted process — resuming
//      from the stored checkpoint, every page read once.
//   2. n8n failing after two pages: those pages stay; the next run resumes.
//   3. A workflow inserted mid-scan repeats one row: stored once.
//   4. A cursor cycle: the scan fails and is never complete.
//   5. Two API instances (two connections) starting together: one runs.
//   6. One Organization's catalog is never another's.
//   7. Nothing secret, and nothing n8n said, reaches the database.
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client. The
// suite runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one — and removes what it
// creates.
//
// NEVER SKIPPED QUIETLY. With no database configured it is reported as skipped
// (CI fails on a skipped database test). A database that was configured and
// cannot be reached FAILS it — and so does none at all under
// JARVIS_REQUIRE_POSTGRES=1, as CI's database steps set.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LIBRARY_FAILURE_MESSAGES, libraryInstanceKey, type LibraryRemoteWorkflow } from "@jarvis/core";
import { AutomationLibraryService, type LibrarySyncBudgetPort } from "../src/services/automation-library/library-service.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "./helpers/shared-access.js";
import { fakeN8nCatalog, fakeWorkflow, type FakeN8nCatalog } from "./helpers/memory-library.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Db = typeof import("@jarvis/db");
type Client = InstanceType<Db["PrismaClient"]>;

let db: Db | null = null;
let prisma: Client | null = null;
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
const ids = { org: "", other: "", owner: "", admin: "", outsider: "" };
let tenancy: MemoryTenancy;
const extraClients: Client[] = [];

const unlimited: LibrarySyncBudgetPort = {
  reserveForUser: async () => ({ allowed: true }),
  reserveForOrganization: async () => ({ allowed: true }),
};

/** A catalog of its own per test: another instance of n8n. */
const instance = (name: string) => libraryInstanceKey(`https://n8n-${name}-${STAMP}.example.test`)!;

function service(catalog: FakeN8nCatalog, instanceKey: string, options: { client?: Client; maxPagesPerRun?: number } = {}) {
  return new AutomationLibraryService({
    store: new db!.PrismaAutomationLibraryRepository(options.client ?? prisma!),
    access: accessOver(tenancy),
    source: { pages: catalog, instanceKey },
    budget: unlimited,
    audit: { log: async () => undefined },
    limits: { pageSize: 250, maxPagesPerRun: options.maxPagesPerRun ?? 20 },
  });
}

async function run(svc: AutomationLibraryService, userId = ids.owner) {
  const started = await svc.requestSync(userId);
  if (!started.ok) throw new Error(`sync refused: ${started.code}`);
  return started.value.completion;
}

async function status(svc: AutomationLibraryService, userId = ids.owner) {
  const result = await svc.status(userId);
  if (!result.ok) throw new Error(`status refused: ${result.code}`);
  return result.value;
}

const countFor = (instanceKey: string, tenantId = ids.org) =>
  prisma!.automationLibraryEntry.count({ where: { tenantId, providerId: "n8n", instanceKey } });

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) {
    throw new Error("These Automation Library tests need a separate PostgreSQL test database, and none could be reached.");
  }
  for (const key of ["org", "other"] as const) {
    ids[key] = (await prisma!.tenant.create({ data: { name: `p18-e2e-${key}-${STAMP}` } })).id;
  }
  for (const key of ["owner", "admin", "outsider"] as const) {
    ids[key] = (
      await prisma!.user.create({
        data: { email: `p18-e2e-${key}-${STAMP}@jarvis-test.local`, name: key, password: "not-a-real-password-hash", role: "MEMBER" },
      })
    ).id;
  }
  tenancy = memoryTenancy({
    owners: { "n8n/rest": ids.org },
    members: [
      { userId: ids.owner, tenantId: ids.org, role: "owner" },
      { userId: ids.admin, tenantId: ids.org, role: "admin" },
      { userId: ids.outsider, tenantId: ids.other, role: "owner" },
    ],
  });
});

afterAll(async () => {
  for (const client of extraClients) await client.$disconnect().catch(() => undefined);
  if (prisma) {
    await prisma.tenant.deleteMany({ where: { id: { in: [ids.org, ids.other].filter(Boolean) } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.admin, ids.outsider].filter(Boolean) } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 18 — the Automation Library on PostgreSQL, end to end", () => {
  it("catalogs 5,600 workflows in three bounded runs, each after a restart, reading every page once", async () => {
    const instanceKey = instance("large");
    const catalog = fakeN8nCatalog(5600);
    const outcomes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // A restarted process: a new connection and a new service; only the database remains.
      const client = new db!.PrismaClient();
      extraClients.push(client);
      const svc = service(catalog, instanceKey, { client, maxPagesPerRun: 10 });
      outcomes.push(await run(svc));
      const seen = await status(svc);
      if (attempt < 2) {
        expect(seen.state).toBe("partial");
        expect(seen.lastCompleteScan).toBeNull();
      } else {
        expect(seen.state).toBe("complete");
        expect(seen.lastCompleteScan?.records).toBe(5600);
        expect(seen.runs.map((r) => [r.status, r.resumed])).toEqual([
          ["COMPLETE", true],
          ["PARTIAL", true],
          ["PARTIAL", false],
        ]);
      }
      await client.$disconnect();
    }
    expect(outcomes.map((o) => [o.status, o.pagesFetched, o.created])).toEqual([
      ["PARTIAL", 10, 2500],
      ["PARTIAL", 10, 2500],
      ["COMPLETE", 3, 600],
    ]);
    expect(catalog.calls.map((c) => c.offset)).toEqual(Array.from({ length: 23 }, (_, i) => i * 250));
    expect(await countFor(instanceKey)).toBe(5600);
    const distinct = await prisma!.automationLibraryEntry.groupBy({
      by: ["externalId"],
      where: { tenantId: ids.org, instanceKey },
      _count: { _all: true },
      having: { externalId: { _count: { gt: 1 } } },
    });
    expect(distinct).toEqual([]);
  });

  it("keeps the pages stored before n8n failed, and resumes after them", async () => {
    const instanceKey = instance("failure");
    const catalog = fakeN8nCatalog(1000);
    catalog.intercept = ({ index }, real) => (index === 2 ? { ok: false, error: { code: "TOOL_TIMEOUT" } } : real());
    const svc = service(catalog, instanceKey);

    expect(await run(svc)).toMatchObject({ status: "FAILED", failureCode: "PROVIDER_TIMEOUT", pagesFetched: 2 });
    expect(await countFor(instanceKey)).toBe(500);
    const failed = await status(svc);
    expect(failed.state).toBe("failed");
    expect(failed.runs[0]!.failure).toEqual({ code: "PROVIDER_TIMEOUT", message: LIBRARY_FAILURE_MESSAGES.PROVIDER_TIMEOUT });

    catalog.intercept = undefined;
    expect(await run(svc)).toMatchObject({ status: "COMPLETE", pagesFetched: 2 });
    expect(catalog.calls.map((c) => c.offset)).toEqual([0, 250, 500, 500, 750]);
    expect(await countFor(instanceKey)).toBe(1000);
  });

  it("stores a workflow n8n repeats across pages once", async () => {
    const instanceKey = instance("duplicate");
    const catalog = fakeN8nCatalog(750);
    catalog.intercept = ({ index }, real) => {
      if (index === 1) catalog.workflows.unshift(fakeWorkflow(900_000));
      return real();
    };
    const outcome = await run(service(catalog, instanceKey));
    expect(outcome).toMatchObject({ status: "COMPLETE", created: 750, unchanged: 1 });
    expect(await countFor(instanceKey)).toBe(750);
  });

  it("fails a scan whose cursor cycles, and never calls it complete", async () => {
    const instanceKey = instance("cycle");
    const catalog = fakeN8nCatalog(1500);
    const sent: Array<string | null> = [];
    catalog.intercept = ({ index, cursor }, real) => {
      sent.push(cursor);
      const answer = real();
      return index === 3 && answer.ok ? { ...answer, nextCursor: sent[1]! } : answer;
    };
    const svc = service(catalog, instanceKey);
    expect(await run(svc)).toMatchObject({ status: "FAILED", failureCode: "CURSOR_CYCLE", pagesFetched: 4 });
    const seen = await status(svc);
    expect(seen).toMatchObject({ state: "failed", lastCompleteScan: null, currentScan: null });
    const sync = await prisma!.automationLibrarySync.findFirstOrThrow({ where: { tenantId: ids.org, instanceKey } });
    expect(sync).toMatchObject({ scanId: null, scanCursor: null, lastCompleteAt: null });
  });

  it("lets one of two API instances starting together run, and tells the other one runs", async () => {
    const instanceKey = instance("concurrent");
    const catalog = fakeN8nCatalog(600);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchPage = catalog.fetchPage.bind(catalog);
    catalog.fetchPage = async (input) => {
      await gate;
      return fetchPage(input);
    };
    const second = new db!.PrismaClient();
    extraClients.push(second);

    const [a, b] = await Promise.all([
      service(catalog, instanceKey).requestSync(ids.owner),
      service(catalog, instanceKey, { client: second }).requestSync(ids.admin),
    ]);
    const started = [a, b].filter((r) => r.ok);
    expect(started).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ ok: false, status: 409, code: "SYNC_ALREADY_RUNNING" });
    release();
    if (started[0]!.ok) expect((await started[0]!.value.completion).status).toBe("COMPLETE");
    expect(catalog.calls).toHaveLength(3);
    expect(await countFor(instanceKey)).toBe(600);
  });

  it("never shows one Organization's catalog to another", async () => {
    const instanceKey = instance("isolation");
    const catalog = fakeN8nCatalog(40);
    const svc = service(catalog, instanceKey);
    await run(svc);

    expect(await svc.list(ids.outsider, { page: 1, limit: 100 })).toEqual({
      ok: false,
      status: 403,
      code: "NOT_AVAILABLE",
      message: "n8n is not available to your account.",
    });
    tenancy.setOwner("n8n", "rest", ids.other);
    try {
      const theirs = await svc.list(ids.outsider, { page: 1, limit: 100 });
      expect(theirs.ok && theirs.value.total).toBe(0);
      expect((await svc.status(ids.owner)).ok).toBe(false);
    } finally {
      tenancy.setOwner("n8n", "rest", ids.org);
    }
    const ours = await svc.list(ids.owner, { page: 1, limit: 100 });
    expect(ours.ok && ours.value.total).toBe(40);
  });

  it("stores nothing secret and nothing n8n said", async () => {
    const instanceKey = instance("secrets");
    const catalog = fakeN8nCatalog(0);
    catalog.workflows.push({
      ...fakeWorkflow(1),
      parameters: { headers: { Authorization: "Bearer SECRET-NODE-TOKEN" } },
      credentials: { httpHeaderAuth: { name: "SECRET-CREDENTIAL" } },
      staticData: { token: "SECRET-STATIC" },
    } as unknown as LibraryRemoteWorkflow);
    const svc = service(catalog, instanceKey);
    await run(svc);
    catalog.intercept = () => ({ ok: false, error: { code: "AUTHENTICATION_REQUIRED", httpStatus: 401, message: "x-n8n-api-key: SECRET-KEY" } }) as never;
    const restarted = await svc.requestSync(ids.owner, { restart: true });
    if (restarted.ok) await restarted.value.completion;

    const rows = await prisma!.$queryRaw<Array<{ row: unknown }>>`
      SELECT row_to_json(e) AS row FROM "AutomationLibraryEntry" e WHERE e.tenant_id = ${ids.org} AND e.instance_key = ${instanceKey}`;
    const sync = await prisma!.automationLibrarySync.findFirstOrThrow({ where: { tenantId: ids.org, instanceKey }, include: { runs: true } });
    const stored = JSON.stringify(rows) + JSON.stringify(sync);
    expect(rows).toHaveLength(1);
    expect(stored).not.toMatch(/SECRET|api-key|n8n-secrets/);
    expect(sync.runs.find((r) => r.status === "FAILED")?.failureCode).toBe("PROVIDER_AUTH_FAILED");
  });
});
