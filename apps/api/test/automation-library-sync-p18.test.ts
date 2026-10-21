// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — Automation Library synchronization, without a
// database.
//
// The REAL engine and the REAL service over the store port in memory (same
// semantics as the Prisma repository; the PostgreSQL suite proves the core of
// these scenarios against the real one) and a fake n8n whose cursor carries an
// offset, as n8n's does. No network.
//
// What is pinned here: a catalog larger than one run is built by bounded runs
// that resume from the stored checkpoint; a partial scan is never complete; a
// repeated cursor is a cycle; a rejected cursor restarts the scan losing
// nothing; a failure keeps every stored page; the same page twice stores each
// workflow once; deletions are reconciled only after complete scans; one run
// at a time; one Organization's catalog is never another's; and nothing the
// provider said, nor anything secret, reaches a run, an entry or a status.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  LIBRARY_FAILURE_MESSAGES,
  LIBRARY_LEASE_MS,
  libraryInstanceKey,
  normalizeLibraryWorkflow,
  type LibraryRemoteWorkflow,
} from "@jarvis/core";
import { AutomationLibraryService, type LibrarySyncBudgetPort } from "../src/services/automation-library/library-service.js";
import { continueLibraryRun } from "../src/services/automation-library/sync-engine.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "./helpers/shared-access.js";
import {
  fakeN8nCatalog,
  fakeWorkflow,
  memoryLibraryStore,
  steppingClock,
  type FakeN8nCatalog,
  type MemoryLibraryStore,
} from "./helpers/memory-library.js";

const ORG = "org-lib";
const OTHER_ORG = "org-other";
const BASE_URL = "https://n8n.internal.example.test/";
const INSTANCE = libraryInstanceKey(BASE_URL)!;
const SCOPE = { tenantId: ORG, providerId: "n8n", instanceKey: INSTANCE };

const PEOPLE = {
  owner: "owner-1",
  admin: "admin-1",
  member: "member-1",
  viewer: "viewer-1",
  otherOwner: "owner-other",
} as const;

function organization(): MemoryTenancy {
  return memoryTenancy({
    owners: { "n8n/rest": ORG },
    members: [
      { userId: PEOPLE.owner, tenantId: ORG, role: "owner" },
      { userId: PEOPLE.admin, tenantId: ORG, role: "admin" },
      { userId: PEOPLE.member, tenantId: ORG, role: "member" },
      { userId: PEOPLE.viewer, tenantId: ORG, role: "viewer" },
      { userId: PEOPLE.otherOwner, tenantId: OTHER_ORG, role: "owner" },
    ],
  });
}

const unlimited: LibrarySyncBudgetPort = {
  reserveForUser: async () => ({ allowed: true }),
  reserveForOrganization: async () => ({ allowed: true }),
};

interface HarnessOptions {
  workflows?: number;
  pageSize?: number;
  maxPagesPerRun?: number;
  store?: MemoryLibraryStore;
  catalog?: FakeN8nCatalog;
  tenancy?: MemoryTenancy;
  clock?: ReturnType<typeof steppingClock>;
  shouldStop?: () => boolean;
}

function harness(options: HarnessOptions = {}) {
  const tenancy = options.tenancy ?? organization();
  const store = options.store ?? memoryLibraryStore();
  const catalog = options.catalog ?? fakeN8nCatalog(options.workflows ?? 0);
  const clock = options.clock ?? steppingClock();
  const audits: Array<{ userId: string; action: string; result: string; metadata?: Record<string, unknown> }> = [];
  const service = new AutomationLibraryService({
    store,
    access: accessOver(tenancy),
    source: { pages: catalog, instanceKey: INSTANCE },
    budget: unlimited,
    audit: { log: async (entry) => void audits.push(entry) },
    limits: { pageSize: options.pageSize ?? 250, maxPagesPerRun: options.maxPagesPerRun ?? 20 },
    now: clock.now,
    ...(options.shouldStop ? { shouldStop: options.shouldStop } : {}),
  });
  /** One run, started as `userId`, awaited to its end. */
  const sync = async (userId: string = PEOPLE.owner, syncOptions: { restart?: boolean } = {}) => {
    const started = await service.requestSync(userId, syncOptions);
    if (!started.ok) throw new Error(`sync refused: ${started.code}`);
    return started.value.completion;
  };
  const status = async (userId: string = PEOPLE.owner) => {
    const result = await service.status(userId);
    if (!result.ok) throw new Error(`status refused: ${result.code}`);
    return result.value;
  };
  return { service, store, catalog, tenancy, clock, audits, sync, status };
}

const offsets = (catalog: FakeN8nCatalog) => catalog.calls.map((c) => c.offset);

// ---------------------------------------------------------------------------

describe("bounded runs build a catalog larger than one traversal", () => {
  it("reads every page of a catalog larger than one page, and completes", async () => {
    const h = harness({ workflows: 600 });
    const outcome = await h.sync();

    expect(outcome).toMatchObject({ status: "COMPLETE", failureCode: null, pagesFetched: 3, created: 600 });
    expect(offsets(h.catalog)).toEqual([0, 250, 500]);
    expect(h.store.entriesOf(SCOPE)).toHaveLength(600);
    const status = await h.status();
    expect(status.state).toBe("complete");
    expect(status.lastCompleteScan?.records).toBe(600);
    expect(status.currentScan).toBeNull();
  });

  it("catalogs 10,500 workflows in three bounded runs, and never calls a partial run complete", async () => {
    const h = harness({ workflows: 10_500 });

    const first = await h.sync();
    expect(first).toMatchObject({ status: "PARTIAL", pagesFetched: 20, created: 5000 });
    let status = await h.status();
    expect(status.state).toBe("partial");
    expect(status.lastCompleteScan).toBeNull();
    expect(status.currentScan).toMatchObject({ pagesFetched: 20, recordsObserved: 5000 });
    expect(status.runs[0]).toMatchObject({ status: "PARTIAL", resumed: false });

    const second = await h.sync();
    expect(second).toMatchObject({ status: "PARTIAL", pagesFetched: 20, created: 5000 });
    status = await h.status();
    expect(status.state).toBe("partial");
    expect(status.runs[0]).toMatchObject({ status: "PARTIAL", resumed: true });

    const third = await h.sync();
    expect(third).toMatchObject({ status: "COMPLETE", pagesFetched: 2, created: 500 });
    status = await h.status();
    expect(status.state).toBe("complete");
    expect(status.lastCompleteScan?.records).toBe(10_500);

    // Every page read exactly once, in order, across the three runs.
    expect(h.catalog.calls).toHaveLength(42);
    expect(offsets(h.catalog)).toEqual(Array.from({ length: 42 }, (_, i) => i * 250));
    expect(new Set(h.store.entriesOf(SCOPE).map((e) => e.externalId)).size).toBe(10_500);
    // Every run's page budget held.
    for (const run of status.runs) expect(run.pagesFetched).toBeLessThanOrEqual(20);
  });

  it("resumes from the saved cursor after a restart — a new service over the same store", async () => {
    const store = memoryLibraryStore();
    const catalog = fakeN8nCatalog(450);
    const before = harness({ store, catalog, pageSize: 100, maxPagesPerRun: 2 });
    expect((await before.sync()).status).toBe("PARTIAL");
    expect(store.syncOf(SCOPE)?.scanCursor).toBe(catalog.cursorAt(200, 100));

    // The process restarts: nothing survives but the store.
    const after = harness({ store, catalog, pageSize: 100, maxPagesPerRun: 20 });
    const outcome = await after.sync();
    expect(outcome).toMatchObject({ status: "COMPLETE", pagesFetched: 3, created: 250 });
    expect(catalog.calls[2]).toMatchObject({ cursor: catalog.cursorAt(200, 100), offset: 200 });
    expect(offsets(catalog)).toEqual([0, 100, 200, 300, 400]);
    expect(store.entriesOf(SCOPE)).toHaveLength(450);
  });

  it("keeps a scan's page size when a later run is configured with another", async () => {
    const store = memoryLibraryStore();
    const catalog = fakeN8nCatalog(300);
    await harness({ store, catalog, pageSize: 100, maxPagesPerRun: 1 }).sync();
    await harness({ store, catalog, pageSize: 250 }).sync();
    // n8n's cursor carries its page size: the open scan keeps its own.
    expect(catalog.calls.map((c) => c.limit)).toEqual([100, 100, 100]);
  });
});

describe("the same page twice stores each workflow once", () => {
  it("a workflow inserted mid-scan shifts n8n's window: the repeated one is stored once", async () => {
    const h = harness({ workflows: 750 });
    h.catalog.intercept = ({ index }, real) => {
      // Before the second page is read, a workflow is created at the front:
      // the offset window moves back one, and page two starts with page one's last.
      if (index === 1) h.catalog.workflows.unshift(fakeWorkflow(900_000));
      return real();
    };
    const outcome = await h.sync();

    expect(outcome.status).toBe("COMPLETE");
    const ids = h.store.entriesOf(SCOPE).map((e) => e.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(750);
    expect(outcome.unchanged).toBe(1);
  });

  it("a page stored twice — a retry after a lost answer — changes nothing the second time", async () => {
    const store = memoryLibraryStore();
    const clock = steppingClock();
    const begun = await store.beginRun({
      scope: SCOPE,
      runId: "run-1",
      newScanId: "scan-1",
      requestedById: PEOPLE.owner,
      pageSize: 250,
      restart: false,
      leaseMs: LIBRARY_LEASE_MS,
      now: clock.now(),
    });
    if (!begun.ok) throw new Error("lease");
    const records = Array.from({ length: 5 }, (_, i) => normalizeLibraryWorkflow(fakeWorkflow(i))!);
    const page = { scope: SCOPE, runId: "run-1", scanId: "scan-1", records, observed: 5, rejected: 0, requestedCursorHash: null, next: { cursor: "c2" }, leaseMs: LIBRARY_LEASE_MS };

    const first = await store.persistPage({ ...page, now: clock.now() });
    const again = await store.persistPage({ ...page, now: clock.now() });
    expect(first).toMatchObject({ ok: true, created: 5, unchanged: 0 });
    expect(again).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 5 });
    expect(store.entriesOf(SCOPE)).toHaveLength(5);
  });

  it("a page that lists one workflow twice stores it once, and counts both rows", async () => {
    const h = harness({ workflows: 3 });
    h.catalog.intercept = (_call, real) => {
      const answer = real();
      return answer.ok ? { ...answer, workflows: [...answer.workflows, answer.workflows[0]!] } : answer;
    };
    const outcome = await h.sync();
    expect(outcome).toMatchObject({ status: "COMPLETE", recordsObserved: 4, created: 3 });
    expect(h.store.entriesOf(SCOPE)).toHaveLength(3);
  });
});

describe("cursor problems never produce a complete scan", () => {
  it("a cursor that comes back after several pages is a cycle: the scan fails, closes, and restarts next time", async () => {
    const h = harness({ workflows: 1500 });
    const sent: Array<string | null> = [];
    h.catalog.intercept = ({ index, cursor }, real) => {
      sent.push(cursor);
      const answer = real();
      // The fourth page points back at the second page's cursor.
      return index === 3 && answer.ok ? { ...answer, nextCursor: sent[1]! } : answer;
    };
    const outcome = await h.sync();

    expect(outcome).toMatchObject({ status: "FAILED", failureCode: "CURSOR_CYCLE", pagesFetched: 4 });
    const status = await h.status();
    expect(status.state).toBe("failed");
    expect(status.lastCompleteScan).toBeNull();
    expect(status.currentScan).toBeNull();
    expect(status.runs[0]!.failure).toEqual({ code: "CURSOR_CYCLE", message: LIBRARY_FAILURE_MESSAGES.CURSOR_CYCLE });
    expect(status.runs[0]!.markedMissing + status.runs[0]!.markedRemoved).toBe(0);

    // The pages it read are kept; the next run starts again from the first page.
    expect(h.store.entriesOf(SCOPE)).toHaveLength(1000);
    h.catalog.intercept = undefined;
    const next = await h.sync();
    expect(h.catalog.calls[4]!.cursor).toBeNull();
    expect(next).toMatchObject({ status: "COMPLETE", pagesFetched: 6 });
    expect((await h.status()).runs[0]).toMatchObject({ status: "COMPLETE", resumed: false });
    expect((await h.status()).state).toBe("complete");
  });

  it("a cursor repeated straight away is a cycle too", async () => {
    const h = harness({ workflows: 1000 });
    h.catalog.intercept = ({ index, cursor }, real) => {
      const answer = real();
      return index === 1 && answer.ok ? { ...answer, nextCursor: cursor } : answer;
    };
    const outcome = await h.sync();
    expect(outcome).toMatchObject({ status: "FAILED", failureCode: "CURSOR_CYCLE", pagesFetched: 2 });
    expect(h.catalog.calls).toHaveLength(2);
  });

  it("a saved cursor n8n rejects restarts the scan from the first page, and loses nothing", async () => {
    const h = harness({ workflows: 1000, maxPagesPerRun: 2 });
    expect((await h.sync()).status).toBe("PARTIAL");

    h.catalog.intercept = ({ index }, real) =>
      index === 2 ? { ok: false, error: { code: "INVALID_REQUEST", httpStatus: 400 } } : real();
    const refused = await h.sync();
    expect(refused).toMatchObject({ status: "FAILED", failureCode: "CURSOR_REJECTED", pagesFetched: 0 });
    expect(h.store.syncOf(SCOPE)?.scanId).toBeNull();
    expect(h.store.entriesOf(SCOPE)).toHaveLength(500);

    h.catalog.intercept = undefined;
    await h.sync(PEOPLE.owner);
    expect(h.catalog.calls[3]!.cursor).toBeNull();
    await h.sync(PEOPLE.owner);
    const status = await h.status();
    expect(status.state).toBe("complete");
    expect(status.lastCompleteScan?.records).toBe(1000);
  });
});

describe("a failure keeps every stored page and resumes after it", () => {
  it("n8n failing after two pages: those pages stay, and the next run continues at the third", async () => {
    const h = harness({ workflows: 1000 });
    h.catalog.intercept = ({ index }, real) => (index === 2 ? { ok: false, error: { code: "NETWORK_ERROR" } } : real());
    const failed = await h.sync();

    expect(failed).toMatchObject({ status: "FAILED", failureCode: "PROVIDER_UNAVAILABLE", pagesFetched: 2 });
    expect(h.store.entriesOf(SCOPE)).toHaveLength(500);
    expect(h.store.syncOf(SCOPE)?.scanCursor).toBe(h.catalog.cursorAt(500, 250));
    expect((await h.status()).state).toBe("failed");

    h.catalog.intercept = undefined;
    const resumed = await h.sync();
    expect(resumed).toMatchObject({ status: "COMPLETE", pagesFetched: 2 });
    expect(offsets(h.catalog)).toEqual([0, 250, 500, 500, 750]);
    expect(h.store.entriesOf(SCOPE)).toHaveLength(1000);
  });

  it("a page the database could not store is read again by the next run", async () => {
    const h = harness({ workflows: 750 });
    h.catalog.intercept = ({ index }, real) => {
      if (index === 1) h.store.failNextPersists(1);
      return real();
    };
    const failed = await h.sync();
    expect(failed).toMatchObject({ status: "FAILED", failureCode: "PERSISTENCE_FAILED", pagesFetched: 1 });
    expect(h.store.entriesOf(SCOPE)).toHaveLength(250);

    h.catalog.intercept = undefined;
    expect((await h.sync()).status).toBe("COMPLETE");
    expect(offsets(h.catalog)).toEqual([0, 250, 250, 500]);
    expect(h.store.entriesOf(SCOPE)).toHaveLength(750);
  });

  it("a run that died holding the lease is closed as interrupted, and its scan resumes", async () => {
    const h = harness({ workflows: 500 });
    // A run opens its scan, stores one page, and the process dies.
    const begun = await h.store.beginRun({
      scope: SCOPE,
      runId: "run-dead",
      newScanId: "scan-1",
      requestedById: PEOPLE.owner,
      pageSize: 250,
      restart: false,
      leaseMs: LIBRARY_LEASE_MS,
      now: h.clock.now(),
    });
    if (!begun.ok) throw new Error("lease");
    const dead = await continueLibraryRun({
      store: h.store,
      source: h.catalog,
      scope: SCOPE,
      runId: "run-dead",
      checkpoint: begun.checkpoint,
      maxPages: 1,
      leaseMs: LIBRARY_LEASE_MS,
      now: h.clock.now,
    });
    expect(dead.status).toBe("PARTIAL");
    // Simulate the crash: re-take the lease as if that run never let go.
    await h.store.beginRun({ scope: SCOPE, runId: "run-crashed", newScanId: "unused", requestedById: null, pageSize: 250, restart: false, leaseMs: LIBRARY_LEASE_MS, now: h.clock.now() });
    expect((await h.service.requestSync(PEOPLE.owner)).ok).toBe(false);

    h.clock.advance(LIBRARY_LEASE_MS + 1);
    const outcome = await h.sync();
    expect(outcome).toMatchObject({ status: "COMPLETE", pagesFetched: 1 });
    const status = await h.status();
    const interrupted = status.runs.find((r) => r.runId === "run-crashed");
    expect(interrupted?.failure).toEqual({ code: "INTERRUPTED", message: LIBRARY_FAILURE_MESSAGES.INTERRUPTED });
    expect(status.runs[0]).toMatchObject({ status: "COMPLETE", resumed: true });
    expect(h.store.entriesOf(SCOPE)).toHaveLength(500);
  });

  it("a run that lost its lease stores nothing more", async () => {
    const h = harness({ workflows: 500 });
    const clock = h.clock;
    const a = await h.store.beginRun({ scope: SCOPE, runId: "run-a", newScanId: "scan-a", requestedById: null, pageSize: 250, restart: false, leaseMs: LIBRARY_LEASE_MS, now: clock.now() });
    if (!a.ok) throw new Error("lease");
    clock.advance(LIBRARY_LEASE_MS + 1);
    const b = await h.store.beginRun({ scope: SCOPE, runId: "run-b", newScanId: "scan-b", requestedById: null, pageSize: 250, restart: false, leaseMs: LIBRARY_LEASE_MS, now: clock.now() });
    expect(b.ok).toBe(true);

    const late = await continueLibraryRun({ store: h.store, source: h.catalog, scope: SCOPE, runId: "run-a", checkpoint: a.checkpoint, maxPages: 5, leaseMs: LIBRARY_LEASE_MS, now: clock.now });
    expect(late).toMatchObject({ status: "FAILED", failureCode: "LEASE_LOST", pagesFetched: 0 });
    expect(h.store.entriesOf(SCOPE)).toHaveLength(0);
    // The run that holds the lease still does.
    expect(h.store.syncOf(SCOPE)?.leaseOwner).toBe("run-b");
  });
});

describe("partial is never complete", () => {
  it("a run that spends its budget is PARTIAL even when the next page would be the last", async () => {
    const h = harness({ workflows: 500, maxPagesPerRun: 1 });
    expect((await h.sync()).status).toBe("PARTIAL");
    expect((await h.status()).state).toBe("partial");
    expect((await h.sync()).status).toBe("COMPLETE");
    expect((await h.status()).state).toBe("complete");
  });

  it("a stopping server ends the run PARTIAL with its place saved", async () => {
    let stopping = false;
    const h = harness({ workflows: 1000, shouldStop: () => stopping });
    h.catalog.intercept = ({ index }, real) => {
      if (index === 1) stopping = true;
      return real();
    };
    const outcome = await h.sync();
    expect(outcome).toMatchObject({ status: "PARTIAL", pagesFetched: 2 });
    expect(h.store.syncOf(SCOPE)?.scanCursor).toBe(h.catalog.cursorAt(500, 250));
    expect(h.store.syncOf(SCOPE)?.leaseOwner).toBeNull();
  });

  it("a scan restarted on request starts from the first page", async () => {
    const h = harness({ workflows: 1000, maxPagesPerRun: 2 });
    await h.sync();
    const restarted = await h.sync(PEOPLE.owner, { restart: true });
    expect(restarted.status).toBe("PARTIAL");
    expect(h.catalog.calls[2]!.cursor).toBeNull();
  });
});

describe("deletions are reconciled only after complete scans, and never deleted", () => {
  it("missing once is 'missing'; missing from two complete scans in a row is 'removed'; seen again is 'present'", async () => {
    const h = harness({ workflows: 300 });
    expect((await h.sync()).status).toBe("COMPLETE");

    // Ten workflows are deleted in n8n.
    const deleted = h.catalog.workflows.splice(0, 10).map((w) => w.id);

    // A PARTIAL scan says nothing about absence.
    const partial = harness({ store: h.store, catalog: h.catalog, maxPagesPerRun: 1 });
    expect((await partial.sync()).status).toBe("PARTIAL");
    expect(h.store.entriesOf(SCOPE).filter((e) => e.missedScans > 0)).toHaveLength(0);

    // The first complete scan without them: missing, not removed.
    const first = await h.sync();
    expect(first).toMatchObject({ status: "COMPLETE", markedMissing: 10, markedRemoved: 0 });
    let missing = (await h.service.list(PEOPLE.owner, { page: 1, limit: 100, presence: "missing" }));
    expect(missing.ok && missing.value.items.map((i) => i.externalId).sort()).toEqual([...deleted].sort());
    expect((await h.status()).catalog).toEqual({ present: 290, missing: 10, removed: 0 });

    // A FAILED scan reconciles nothing either.
    h.catalog.intercept = ({ index }, real) => (index === h.catalog.calls.length - 1 && index > 4 ? { ok: false, error: { code: "TOOL_TIMEOUT" } } : real());
    expect((await h.sync()).status).toBe("FAILED");
    h.catalog.intercept = undefined;
    expect((await h.status()).catalog).toEqual({ present: 290, missing: 10, removed: 0 });

    // Finish that scan, then one more complete scan: removed — and still there, marked.
    await h.sync();
    let status = await h.status();
    expect(status.catalog).toEqual({ present: 290, missing: 0, removed: 10 });
    expect(h.store.entriesOf(SCOPE)).toHaveLength(300);

    // One comes back: present again.
    h.catalog.workflows.push(fakeWorkflow(0));
    await h.sync();
    status = await h.status();
    expect(status.catalog).toEqual({ present: 291, missing: 0, removed: 9 });
    missing = await h.service.list(PEOPLE.owner, { page: 1, limit: 100, presence: "removed" });
    expect(missing.ok && missing.value.total).toBe(9);
  });
});

describe("one run at a time, per catalog", () => {
  it("of two starts together, one runs and the other is told one is running", async () => {
    const h = harness({ workflows: 2000 });
    const [a, b] = await Promise.all([h.service.requestSync(PEOPLE.owner), h.service.requestSync(PEOPLE.admin)]);
    const started = [a, b].filter((r) => r.ok);
    const refused = [a, b].filter((r) => !r.ok);
    expect(started).toHaveLength(1);
    expect(refused).toEqual([
      { ok: false, status: 409, code: "SYNC_ALREADY_RUNNING", message: "A synchronization of this library is already running. Follow it on the status endpoint." },
    ]);
    if (started[0]!.ok) await started[0]!.value.completion;
    // Once it ended, a new one may start.
    expect((await h.service.requestSync(PEOPLE.admin)).ok).toBe(true);
  });
});

describe("one Organization's catalog is never another's", () => {
  it("moving the connection gives the new owner an empty catalog and the old one nothing", async () => {
    const tenancy = organization();
    const h = harness({ workflows: 50, tenancy });
    await h.sync();
    expect((await h.status(PEOPLE.member)).catalog.present).toBe(50);

    // An outsider is refused, and told nothing about who owns it.
    const outsider = await h.service.list(PEOPLE.otherOwner, { page: 1, limit: 10 });
    expect(outsider).toEqual({ ok: false, status: 403, code: "NOT_AVAILABLE", message: "n8n is not available to your account." });

    // The operator moves the connection to the other Organization.
    tenancy.setOwner("n8n", "rest", OTHER_ORG);
    const theirs = await h.service.list(PEOPLE.otherOwner, { page: 1, limit: 10 });
    expect(theirs.ok && theirs.value.total).toBe(0);
    expect((await h.service.status(PEOPLE.owner)).ok).toBe(false);

    // Their own sync builds their own catalog; the first is untouched.
    await h.sync(PEOPLE.otherOwner);
    expect(h.store.entriesOf({ ...SCOPE, tenantId: OTHER_ORG })).toHaveLength(50);
    expect(h.store.entriesOf(SCOPE)).toHaveLength(50);
    tenancy.setOwner("n8n", "rest", ORG);
    expect((await h.status(PEOPLE.member)).catalog.present).toBe(50);
  });

  it("a member reads and cannot sync; a viewer reads; nobody but the owning Organization's owners and admins starts a run", async () => {
    const h = harness({ workflows: 10 });
    expect((await h.service.requestSync(PEOPLE.member))).toMatchObject({ ok: false, status: 403, code: "PERMISSION_DENIED" });
    expect((await h.service.requestSync(PEOPLE.viewer))).toMatchObject({ ok: false, status: 403, code: "PERMISSION_DENIED" });
    expect((await h.service.requestSync(PEOPLE.otherOwner))).toMatchObject({ ok: false, status: 403, code: "NOT_AVAILABLE" });
    expect(h.catalog.calls).toHaveLength(0);
    expect((await h.service.status(PEOPLE.viewer)).ok).toBe(true);
    expect((await h.service.requestSync(PEOPLE.admin)).ok).toBe(true);
  });
});

describe("nothing the provider said, and nothing secret, is kept or shown", () => {
  it("drops node parameters, credentials and the provider's words; says fixed sentences", async () => {
    const h = harness({ workflows: 0 });
    const leaky = {
      ...fakeWorkflow(1),
      // What a full n8n workflow carries that the library must never keep.
      parameters: { headers: { Authorization: "Bearer SECRET-NODE-TOKEN" } },
      credentials: { httpHeaderAuth: { id: "7", name: "SECRET-CREDENTIAL-NAME" } },
      staticData: { token: "SECRET-STATIC" },
      pinData: { node: [{ json: { password: "SECRET-PIN" } }] },
    } as unknown as LibraryRemoteWorkflow;
    h.catalog.workflows.push(leaky);
    h.catalog.intercept = ({ index }, real) =>
      index === 1
        ? ({ ok: false, error: { code: "AUTHENTICATION_REQUIRED", httpStatus: 401, message: "x-n8n-api-key: SECRET-API-KEY rejected" } } as never)
        : real();

    expect((await h.sync()).status).toBe("COMPLETE");
    const listed = await h.service.list(PEOPLE.owner, { page: 1, limit: 10 });
    const stored = JSON.stringify(h.store.entriesOf(SCOPE));
    expect(stored).not.toMatch(/SECRET/);
    expect(JSON.stringify(listed)).not.toMatch(/SECRET/);

    // A failing run: a fixed sentence, not n8n's words.
    await h.sync(PEOPLE.owner, { restart: true });
    const status = await h.status();
    expect(status.runs[0]!.failure).toEqual({ code: "PROVIDER_AUTH_FAILED", message: LIBRARY_FAILURE_MESSAGES.PROVIDER_AUTH_FAILED });
    const shown = JSON.stringify(status) + JSON.stringify(listed) + JSON.stringify(h.audits);
    expect(shown).not.toMatch(/SECRET|api-key|n8n\.internal|eyJ/);
    // No cursor, no instance key, no Organization id in what a reader sees.
    expect(JSON.stringify(status) + JSON.stringify(listed)).not.toContain(INSTANCE);
    expect(JSON.stringify(status) + JSON.stringify(listed)).not.toContain(ORG);
  });
});
