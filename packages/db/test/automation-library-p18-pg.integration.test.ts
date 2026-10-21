// Phase 18, Stage 18.1 — the Automation Library's storage, against REAL
// PostgreSQL.
//
// What only a database can prove:
//   • of two runs starting together — two connections, as two API instances
//     would be — exactly one takes the catalog's lease;
//   • a run whose lease expired and was taken stores nothing (fencing);
//   • a page and the checkpoint past it are ONE transaction: when the page
//     cannot be stored, the checkpoint does not move;
//   • a page stored twice changes nothing; a changed listing updates in place;
//   • only the last page of a scan reconciles; an entry is removed after two
//     consecutive complete scans without it, and never deleted;
//   • a run that died holding the lease is closed as interrupted, and its
//     scan resumes;
//   • Organizations and instances never mix.
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
import {
  LIBRARY_LEASE_MS,
  libraryCursorHash,
  normalizeLibraryWorkflow,
  type LibraryRemoteWorkflow,
  type LibraryScope,
  type LibraryWorkflowRecord,
} from "@jarvis/core";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Client = InstanceType<(typeof import("@prisma/client"))["PrismaClient"]>;
type RepoModule = typeof import("../src/repositories/automation-library-repository.js");

let prisma: Client | null = null;
let second: Client | null = null;
let mod: RepoModule | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  const Prisma = await import("@prisma/client");
  mod = await import("../src/repositories/automation-library-repository.js");
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
const tenantIds: string[] = [];
let userId = "";
let A: LibraryScope;
let B: LibraryScope;
let A2: LibraryScope;

const repo = () => new mod!.PrismaAutomationLibraryRepository(prisma!);
const repo2 = () => new mod!.PrismaAutomationLibraryRepository(second!);

let tick = Date.parse("2026-10-19T09:00:00.000Z");
const now = () => new Date((tick += 1000));

const wf = (i: number, over: Partial<LibraryRemoteWorkflow> = {}): LibraryWorkflowRecord =>
  normalizeLibraryWorkflow({ id: `wf-${i}`, name: `Workflow ${i}`, active: i % 2 === 0, versionId: `v${i}`, tags: ["t"], nodeTypes: ["n8n-nodes-base.slack"], nodeCount: 1, ...over })!;

let runSeq = 0;
async function begin(scope: LibraryScope, options: { restart?: boolean; at?: Date; client?: "first" | "second" } = {}) {
  const runId = `run-${STAMP}-${(runSeq += 1)}`;
  const store = options.client === "second" ? repo2() : repo();
  const result = await store.beginRun({
    scope,
    runId,
    newScanId: `scan-${STAMP}-${runSeq}`,
    requestedById: userId,
    pageSize: 250,
    restart: options.restart ?? false,
    leaseMs: LIBRARY_LEASE_MS,
    now: options.at ?? now(),
  });
  return { runId, result };
}

async function page(
  scope: LibraryScope,
  run: { runId: string; scanId: string },
  records: LibraryWorkflowRecord[],
  next: { cursor: string } | "END",
  requested: string | null = null,
  at: Date = now()
) {
  return repo().persistPage({
    scope,
    runId: run.runId,
    scanId: run.scanId,
    records,
    observed: records.length,
    rejected: 0,
    requestedCursorHash: requested ? libraryCursorHash(requested) : null,
    next,
    leaseMs: LIBRARY_LEASE_MS,
    now: at,
  });
}

/** One complete scan of exactly these records, in one page. */
async function completeScan(scope: LibraryScope, records: LibraryWorkflowRecord[]) {
  const { runId, result } = await begin(scope);
  if (!result.ok) throw new Error("lease held");
  return page(scope, { runId, scanId: result.checkpoint.scanId }, records, "END");
}

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) {
    throw new Error("These Automation Library tests need a separate PostgreSQL test database, and none could be reached.");
  }
  const user = await prisma!.user.create({
    data: { email: `p18-library-${STAMP}@jarvis-test.local`, name: "Library", password: "not-a-real-password-hash", role: "MEMBER" },
  });
  userId = user.id;
  for (const name of ["a", "b"]) {
    const tenant = await prisma!.tenant.create({ data: { name: `p18-library-${name}-${STAMP}` } });
    tenantIds.push(tenant.id);
  }
  A = { tenantId: tenantIds[0]!, providerId: "n8n", instanceKey: `inst-a-${STAMP}` };
  B = { tenantId: tenantIds[1]!, providerId: "n8n", instanceKey: `inst-a-${STAMP}` };
  A2 = { tenantId: tenantIds[0]!, providerId: "n8n", instanceKey: `inst-b-${STAMP}` };
});

afterAll(async () => {
  if (prisma) {
    // Entries, sync rows and runs cascade with their Organization.
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    if (userId) await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  if (second) await second.$disconnect();
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 18 — the Automation Library on PostgreSQL", () => {
  it("lets exactly one of two runs starting together take the lease — on two connections, five times over", async () => {
    for (let round = 0; round < 5; round += 1) {
      const at = now();
      const [x, y] = await Promise.all([begin(A, { at, client: "first" }), begin(A, { at, client: "second" })]);
      const winners = [x, y].filter((r) => r.result.ok);
      expect(winners).toHaveLength(1);
      expect([x, y].find((r) => !r.result.ok)!.result).toEqual({ ok: false, reason: "LEASE_HELD" });
      await repo().finishRun({ scope: A, runId: winners[0]!.runId, status: "PARTIAL", failureCode: null, resetScan: false, now: now() });
    }
  });

  it("stores a page and moves the checkpoint past it together — and moves nothing when the page cannot be stored", async () => {
    const { runId, result } = await begin(A2, { restart: true });
    if (!result.ok) throw new Error("lease");
    const run = { runId, scanId: result.checkpoint.scanId };

    const stored = await page(A2, run, [wf(1), wf(2)], { cursor: "cursor-2" });
    expect(stored).toMatchObject({ ok: true, created: 2 });
    let sync = await prisma!.automationLibrarySync.findUniqueOrThrow({ where: { tenantId_providerId_instanceKey: A2 } });
    expect(sync).toMatchObject({ scanCursor: "cursor-2", scanPages: 1, scanRecords: 2 });

    // PostgreSQL refuses a NUL byte in text: the page's transaction fails.
    const poisoned = { ...wf(3), name: "bad\u0000name" };
    await expect(page(A2, run, [wf(4), poisoned], { cursor: "cursor-3" }, "cursor-2")).rejects.toThrow();
    sync = await prisma!.automationLibrarySync.findUniqueOrThrow({ where: { tenantId_providerId_instanceKey: A2 } });
    expect(sync).toMatchObject({ scanCursor: "cursor-2", scanPages: 1, scanRecords: 2, scanCursorTrail: [] });
    expect(await prisma!.automationLibraryEntry.count({ where: A2 })).toBe(2);

    // The same page again — a retry — and a changed listing.
    const again = await page(A2, run, [wf(1), wf(2, { name: "Renamed" })], { cursor: "cursor-3" }, "cursor-2");
    expect(again).toMatchObject({ ok: true, created: 0, updated: 1, unchanged: 1 });
    const renamed = await prisma!.automationLibraryEntry.findFirstOrThrow({ where: { ...A2, externalId: "wf-2" } });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.contentChangedAt.getTime()).toBeGreaterThan(renamed.firstSeenAt.getTime());
    expect(await prisma!.automationLibraryEntry.count({ where: A2 })).toBe(2);
    sync = await prisma!.automationLibrarySync.findUniqueOrThrow({ where: { tenantId_providerId_instanceKey: A2 } });
    expect(sync.scanCursorTrail).toEqual([libraryCursorHash("cursor-2")]);
    await repo().finishRun({ scope: A2, runId, status: "PARTIAL", failureCode: null, resetScan: false, now: now() });
  });

  it("refuses a run whose lease expired and was taken: it stores nothing", async () => {
    const start = now();
    const a = await begin(A2, { at: start });
    if (!a.result.ok) throw new Error("lease");
    const later = new Date(start.getTime() + LIBRARY_LEASE_MS + 1);
    const b = await begin(A2, { at: later });
    expect(b.result.ok).toBe(true);

    const before = await prisma!.automationLibraryEntry.count({ where: A2 });
    const late = await page(A2, { runId: a.runId, scanId: a.result.checkpoint.scanId }, [wf(99)], { cursor: "x" }, null, new Date(later.getTime() + 1000));
    expect(late).toEqual({ ok: false, reason: "LEASE_LOST" });
    expect(await prisma!.automationLibraryEntry.count({ where: A2 })).toBe(before);
    // The first run was closed as interrupted when the second took over.
    const closed = await prisma!.automationLibrarySyncRun.findUniqueOrThrow({ where: { id: a.runId } });
    expect(closed).toMatchObject({ status: "FAILED", failureCode: "INTERRUPTED" });
    // The second resumed the open scan.
    expect(b.result.ok && b.result.resumed).toBe(true);
    if (b.result.ok) await repo().finishRun({ scope: A2, runId: b.runId, status: "PARTIAL", failureCode: null, resetScan: true, now: now() });
    // Later tests' clock continues after this one's jump.
    tick = Math.max(tick, later.getTime() + 10_000);
  });

  it("reconciles only at the end of a complete scan: missing once, then removed after two in a row — never deleted", async () => {
    const scope: LibraryScope = { ...A, instanceKey: `inst-reconcile-${STAMP}` };
    expect(await completeScan(scope, [1, 2, 3, 4, 5].map((i) => wf(i)))).toMatchObject({ ok: true, created: 5, markedMissing: 0 });

    // A partial scan without 4 and 5: nothing is reconciled.
    const partial = await begin(scope);
    if (!partial.result.ok) throw new Error("lease");
    await page(scope, { runId: partial.runId, scanId: partial.result.checkpoint.scanId }, [wf(1), wf(2), wf(3)], { cursor: "c2" });
    await repo().finishRun({ scope, runId: partial.runId, status: "PARTIAL", failureCode: null, resetScan: true, now: now() });
    expect(await prisma!.automationLibraryEntry.count({ where: { ...scope, missedScans: { gt: 0 } } })).toBe(0);

    // A complete scan without them: missing once.
    expect(await completeScan(scope, [wf(1), wf(2), wf(3)])).toMatchObject({ ok: true, markedMissing: 2, markedRemoved: 0 });
    expect((await repo().readStatus(scope, now())).entries).toEqual({ present: 3, missing: 2, removed: 0 });

    // A second complete scan in a row: removed — and still on record.
    expect(await completeScan(scope, [wf(1), wf(2), wf(3)])).toMatchObject({ ok: true, markedMissing: 0, markedRemoved: 2 });
    expect((await repo().readStatus(scope, now())).entries).toEqual({ present: 3, missing: 0, removed: 2 });
    expect(await prisma!.automationLibraryEntry.count({ where: scope })).toBe(5);

    // Seen again: present.
    await completeScan(scope, [wf(1), wf(2), wf(3), wf(4)]);
    expect((await repo().readStatus(scope, now())).entries).toEqual({ present: 4, missing: 0, removed: 1 });
    const status = await repo().readStatus(scope, now());
    expect(status.lastComplete?.records).toBe(4);
    expect(status.runs[0]).toMatchObject({ status: "COMPLETE", markedMissing: 0, markedRemoved: 0 });
  });

  it("never mixes Organizations or instances, and lists with filters", async () => {
    await completeScan(B, [wf(1, { name: "B only" }), wf(500)]);
    const forA = await repo().listEntries(A2, { page: 1, limit: 100 });
    const forB = await repo().listEntries(B, { page: 1, limit: 100 });
    expect(forB.items.map((i) => i.name).sort()).toEqual(["B only", "Workflow 500"]);
    expect(forA.items.some((i) => i.name === "B only")).toBe(false);

    const searched = await repo().listEntries(B, { page: 1, limit: 10, search: "  b ONLY " });
    expect(searched.items.map((i) => i.externalId)).toEqual(["wf-1"]);
    const active = await repo().listEntries(B, { page: 1, limit: 10, active: true });
    expect(active.items.map((i) => i.externalId)).toEqual(["wf-500"]);
    expect(forB.items[0]).toMatchObject({ source: "rest", presence: "present", tags: ["t"], nodeTypes: ["n8n-nodes-base.slack"] });
  });

  it("stores metadata a listing did not carry as unknown — on create and on a changed listing", async () => {
    const scope: LibraryScope = { ...A, instanceKey: `inst-unknown-${STAMP}` };
    const bare = normalizeLibraryWorkflow({ id: "wf-bare", name: "Bare", active: true })!;
    await completeScan(scope, [bare, wf(2)]);
    let listed = await repo().listEntries(scope, { page: 1, limit: 10 });
    expect(listed.items.find((i) => i.externalId === "wf-bare")).toMatchObject({ tags: null, nodeTypes: null, nodeCount: null, versionId: null });

    // A listing that loses its tags and nodes: back to unknown, in place.
    await completeScan(scope, [bare, wf(2, { tags: null, nodeTypes: null, nodeCount: null })]);
    listed = await repo().listEntries(scope, { page: 1, limit: 10 });
    expect(listed.items.find((i) => i.externalId === "wf-2")).toMatchObject({ tags: null, nodeTypes: null, nodeCount: null });
    expect(listed.total).toBe(2);
  });

  it("keeps the cursor on the server: no read returns it", async () => {
    const { runId, result } = await begin(A2, { restart: true });
    if (!result.ok) throw new Error("lease");
    await page(A2, { runId, scanId: result.checkpoint.scanId }, [wf(7)], { cursor: "eyJTRUNSRVQtQ1VSU09SIjp0cnVlfQ==" });
    const status = await repo().readStatus(A2, now());
    const listed = await repo().listEntries(A2, { page: 1, limit: 10 });
    expect(JSON.stringify(status) + JSON.stringify(listed)).not.toContain("eyJTRUNSRVQtQ1VSU09SIjp0cnVlfQ");
    expect(status.leaseHeld).toBe(true);
    await repo().finishRun({ scope: A2, runId, status: "FAILED", failureCode: "PROVIDER_TIMEOUT", resetScan: false, now: now() });
    const after = await repo().readStatus(A2, now());
    expect(after.leaseHeld).toBe(false);
    expect(after.runs[0]).toMatchObject({ status: "FAILED", failureCode: "PROVIDER_TIMEOUT" });
  });
});
