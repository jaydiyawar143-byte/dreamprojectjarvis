// ---------------------------------------------------------------------------
// Phase 18, Stage 18.2 — continue until complete, end to end on PostgreSQL.
//
// The real service, engine and Prisma repository; n8n is a fake whose cursor
// carries an offset. No network, no workflow is activated, edited or run.
//
//   1. 1,300 workflows in one chain of bounded runs: complete, every page read
//      once, every run the chain's — and the status says complete only then.
//   2. Two API instances (two connections) asked to continue at once: one
//      chain, both answered with it; a single run is refused while it lives.
//   3. A restart mid-chain: the chain is shown interrupted, the next start on
//      a new connection closes it and resumes from the last stored page.
//   4. A role taken away mid-chain: the chain stops, never complete.
//
// SAFETY and NEVER SKIPPED QUIETLY: as the Stage 18.1 suite — only a separate
// test database (never 5432 or 5433), everything created is removed, and it
// fails under JARVIS_REQUIRE_POSTGRES=1 when no database is reachable.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LIBRARY_CHAIN_STALE_MS, LIBRARY_LEASE_MS, libraryInstanceKey } from "@jarvis/core";
import { AutomationLibraryService, type LibrarySyncBudgetPort } from "../src/services/automation-library/library-service.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "./helpers/shared-access.js";
import { fakeN8nCatalog, type FakeN8nCatalog } from "./helpers/memory-library.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Db = typeof import("@jarvis/db");
type Client = InstanceType<Db["PrismaClient"]>;

let db: Db | null = null;
let prisma: Client | null = null;
let second: Client | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  prisma = new db.PrismaClient();
  second = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    await second.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ids = { org: "", owner: "", admin: "" };
let tenancy: MemoryTenancy;

const unlimited: LibrarySyncBudgetPort = {
  reserveForUser: async () => ({ allowed: true }),
  reserveForOrganization: async () => ({ allowed: true }),
};

const instance = (name: string) => libraryInstanceKey(`https://n8n-chain-${name}-${STAMP}.example.test`)!;
const scopeOf = (instanceKey: string) => ({ tenantId: ids.org, providerId: "n8n", instanceKey });

/** A shared clock, so a "restart" can be made to happen after the lease and heartbeat went stale. */
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);

function service(catalog: FakeN8nCatalog, instanceKey: string, client: Client = prisma!) {
  return new AutomationLibraryService({
    store: new db!.PrismaAutomationLibraryRepository(client),
    access: accessOver(tenancy),
    source: { pages: catalog, instanceKey },
    budget: unlimited,
    audit: { log: async () => undefined },
    limits: { pageSize: 100, maxPagesPerRun: 3 },
    now: clock,
    sleep: async () => undefined,
  });
}

async function chain(svc: AutomationLibraryService, userId = ids.owner) {
  const started = await svc.startContinuation(userId);
  if (!started.ok) throw new Error(`chain refused: ${started.code}`);
  if (!started.value.completion) throw new Error("joined an existing chain");
  return started.value.completion;
}

async function status(svc: AutomationLibraryService, userId = ids.owner) {
  const result = await svc.status(userId);
  if (!result.ok) throw new Error(`status refused: ${result.code}`);
  return result.value;
}

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) {
    throw new Error("These Automation Library chain tests need a separate PostgreSQL test database, and none could be reached.");
  }
  ids.org = (await prisma!.tenant.create({ data: { name: `p18-chain-e2e-${STAMP}` } })).id;
  for (const key of ["owner", "admin"] as const) {
    ids[key] = (
      await prisma!.user.create({
        data: { email: `p18-chain-e2e-${key}-${STAMP}@jarvis-test.local`, name: key, password: "not-a-real-password-hash", role: "MEMBER" },
      })
    ).id;
  }
  tenancy = memoryTenancy({
    owners: { "n8n/rest": ids.org },
    members: [
      { userId: ids.owner, tenantId: ids.org, role: "owner" },
      { userId: ids.admin, tenantId: ids.org, role: "admin" },
    ],
  });
});

afterAll(async () => {
  if (second) await second.$disconnect().catch(() => undefined);
  if (prisma) {
    await prisma.tenant.deleteMany({ where: { id: { in: [ids.org].filter(Boolean) } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.admin].filter(Boolean) } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 18.2 — continue until complete on PostgreSQL", () => {
  it("chains bounded runs to a complete scan of 1,300 workflows, reading every page once", async () => {
    const instanceKey = instance("large");
    const catalog = fakeN8nCatalog(1_300);
    const svc = service(catalog, instanceKey);
    const outcome = await chain(svc);
    expect(outcome).toMatchObject({ status: "COMPLETE", runs: 5, pages: 13 });
    expect(catalog.calls.map((c) => c.offset)).toEqual(Array.from({ length: 13 }, (_, i) => i * 100));

    const runs = await prisma!.automationLibrarySyncRun.findMany({ where: { chainId: outcome.chainId }, orderBy: { startedAt: "asc" } });
    expect(runs.map((r) => r.status)).toEqual(["PARTIAL", "PARTIAL", "PARTIAL", "PARTIAL", "COMPLETE"]);
    expect(runs.every((r) => r.pagesFetched <= 3)).toBe(true);
    expect(await prisma!.automationLibraryEntry.count({ where: scopeOf(instanceKey) })).toBe(1_300);
    expect(await status(svc)).toMatchObject({
      state: "complete",
      lastCompleteScan: { records: 1_300 },
      continuation: { status: "COMPLETE", runs: 5, pages: 13, recordsObserved: 1_300 },
    });
  });

  it("answers two instances asked at once with one chain, and refuses a single run while it lives", async () => {
    const instanceKey = instance("race");
    const catalog = fakeN8nCatalog(700);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = catalog.fetchPage.bind(catalog);
    let held = false;
    catalog.fetchPage = async (input) => {
      if (!held) {
        held = true;
        await gate;
      }
      return fetch(input);
    };
    const one = service(catalog, instanceKey);
    const two = service(catalog, instanceKey, second!);
    const [a, b] = await Promise.all([one.startContinuation(ids.owner), two.startContinuation(ids.admin)]);
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(a.value.chainId).toBe(b.value.chainId);
    expect([a.value.existing, b.value.existing].sort()).toEqual([false, true]);
    expect(await two.requestSync(ids.admin)).toMatchObject({ ok: false, code: "SYNC_ALREADY_RUNNING" });
    release();
    const outcome = await (a.value.completion ?? b.value.completion);
    expect(outcome).toMatchObject({ status: "COMPLETE" });
    const sync = await prisma!.automationLibrarySync.findUniqueOrThrow({ where: { tenantId_providerId_instanceKey: scopeOf(instanceKey) } });
    expect(await prisma!.automationLibrarySyncChain.count({ where: { syncId: sync.id } })).toBe(1);
    expect(sync.activeChainId).toBeNull();
  });

  it("recovers after a restart mid-chain: shown interrupted, closed by the next start, resumed from the last stored page", async () => {
    const instanceKey = instance("restart");
    const catalog = fakeN8nCatalog(900);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = catalog.fetchPage.bind(catalog);
    let held = false;
    catalog.fetchPage = async (input) => {
      // The fifth page never comes back: the process is gone.
      if (!held && catalog.calls.length === 4) {
        held = true;
        await gate;
      }
      return fetch(input);
    };
    const before = service(catalog, instanceKey);
    const started = await before.startContinuation(ids.owner);
    if (!started.ok) throw new Error("refused");
    while (!held) await new Promise((resolve) => setTimeout(resolve, 10));

    offsetMs += Math.max(LIBRARY_LEASE_MS, LIBRARY_CHAIN_STALE_MS) + 5_000;
    const after = service(catalog, instanceKey, second!);
    expect((await status(after)).continuation).toMatchObject({ status: "INTERRUPTED", stop: { code: "INTERRUPTED" } });

    const resumed = await chain(after, ids.admin);
    expect(resumed).toMatchObject({ status: "COMPLETE" });
    expect(catalog.calls.map((c) => c.offset)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800]);
    const sync = await prisma!.automationLibrarySync.findUniqueOrThrow({ where: { tenantId_providerId_instanceKey: scopeOf(instanceKey) } });
    const chains = await prisma!.automationLibrarySyncChain.findMany({ where: { syncId: sync.id }, orderBy: { startedAt: "asc" } });
    expect(chains.map((c) => c.status)).toEqual(["INTERRUPTED", "COMPLETE"]);
    expect(await prisma!.automationLibraryEntry.count({ where: scopeOf(instanceKey) })).toBe(900);

    release();
    const late = await started.value.completion!;
    expect(late.status).toBe("STOPPED");
    expect((await prisma!.automationLibrarySyncChain.findUniqueOrThrow({ where: { id: started.value.chainId } })).status).toBe("INTERRUPTED");
    expect((await status(after)).continuation).toMatchObject({ status: "COMPLETE" });
  });

  it("stops when the requester's role is taken away mid-chain — and is never complete", async () => {
    const instanceKey = instance("demoted");
    const catalog = fakeN8nCatalog(900);
    catalog.intercept = ({ index }, real) => {
      if (index === 3) tenancy.setRole(ids.admin, ids.org, "member");
      return real();
    };
    try {
      const outcome = await chain(service(catalog, instanceKey), ids.admin);
      expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "AUTHORIZATION_CHANGED", runs: 2 });
      // The run in progress finishes its pages; the next one is never begun.
      expect(catalog.calls).toHaveLength(6);
      const view = await status(service(catalog, instanceKey));
      expect(view.lastCompleteScan).toBeNull();
      expect(view.state).toBe("partial");
    } finally {
      tenancy.setRole(ids.admin, ids.org, "admin");
    }
  });
});
