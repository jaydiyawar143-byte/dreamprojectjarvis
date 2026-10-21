// ---------------------------------------------------------------------------
// Phase 18, Stage 18.2 — continue until complete, without a database.
//
// The REAL service and engine over the store port in memory (the repository's
// semantics; the PostgreSQL suites prove the store's half against the real
// one) and a fake n8n whose cursor carries an offset. No network, no workflow
// is activated, edited or run.
//
// What is pinned: a chain is ordinary bounded runs of one scan, chained until
// the store reports the scan complete — and called complete only then; its
// hard limits (runs, pages, time) and its budget stop it with the scan's place
// kept; a failure worth retrying is retried a bounded number of times and any
// other stops it; the requester's authorization and the catalog's scope are
// read again before every run; one chain per catalog, whatever is clicked; an
// idempotency key returns its chain; a single run and a chain never overlap;
// a chain whose process died is shown as interrupted and closed by the next
// start, which resumes from the last stored page; and nothing secret reaches a
// view or an audit row.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  LIBRARY_CHAIN_MAX_CONSECUTIVE_FAILURES,
  LIBRARY_CHAIN_STALE_MS,
  LIBRARY_CHAIN_STOP_MESSAGES,
  LIBRARY_LEASE_MS,
  libraryInstanceKey,
} from "@jarvis/core";
import {
  AutomationLibraryService,
  type AutomationLibraryServiceDeps,
  type LibrarySyncBudgetPort,
} from "../src/services/automation-library/library-service.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "./helpers/shared-access.js";
import {
  fakeN8nCatalog,
  memoryLibraryStore,
  steppingClock,
  type FakeFetchResult,
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

/** A budget that counts what was reserved, and runs out where told. */
function countingBudget(options: { orgLimit?: number; orgUnavailableAfter?: number } = {}) {
  const counts = { user: 0, org: 0 };
  const port: LibrarySyncBudgetPort = {
    reserveForUser: async () => {
      counts.user += 1;
      return { allowed: true };
    },
    reserveForOrganization: async () => {
      counts.org += 1;
      if (options.orgUnavailableAfter !== undefined && counts.org > options.orgUnavailableAfter) {
        return { allowed: false, reason: "UNAVAILABLE" };
      }
      if (options.orgLimit !== undefined && counts.org > options.orgLimit) return { allowed: false, reason: "LIMIT" };
      return { allowed: true };
    },
  };
  return { counts, port };
}

interface HarnessOptions {
  workflows?: number;
  store?: MemoryLibraryStore;
  catalog?: FakeN8nCatalog;
  tenancy?: MemoryTenancy;
  clock?: ReturnType<typeof steppingClock>;
  budget?: LibrarySyncBudgetPort;
  chainLimits?: AutomationLibraryServiceDeps["chainLimits"];
  shouldStop?: () => boolean;
}

/** 10 workflows a page, 2 pages a run: 95 workflows are 10 pages, 5 runs. */
function harness(options: HarnessOptions = {}) {
  const tenancy = options.tenancy ?? organization();
  const store = options.store ?? memoryLibraryStore();
  const catalog = options.catalog ?? fakeN8nCatalog(options.workflows ?? 95);
  const clock = options.clock ?? steppingClock();
  const budget = options.budget ? { counts: null, port: options.budget } : countingBudget();
  const audits: Array<{ userId: string; action: string; result: string; metadata?: Record<string, unknown> }> = [];
  const sleeps: number[] = [];
  const service = new AutomationLibraryService({
    store,
    access: accessOver(tenancy),
    source: { pages: catalog, instanceKey: INSTANCE },
    budget: budget.port,
    audit: { log: async (entry) => void audits.push(entry) },
    limits: { pageSize: 10, maxPagesPerRun: 2 },
    ...(options.chainLimits ? { chainLimits: options.chainLimits } : {}),
    now: clock.now,
    sleep: async (ms) => void sleeps.push(ms),
    ...(options.shouldStop ? { shouldStop: options.shouldStop } : {}),
  });
  /** Starts a chain as `userId` and waits for it to end. */
  const chain = async (userId: string = PEOPLE.owner, opts: { idempotencyKey?: string; restart?: boolean } = {}) => {
    const started = await service.startContinuation(userId, opts);
    if (!started.ok) throw new Error(`chain refused: ${started.code}`);
    if (!started.value.completion) throw new Error("no chain was started");
    return { started: started.value, outcome: await started.value.completion };
  };
  const status = async (userId: string = PEOPLE.owner) => {
    const result = await service.status(userId);
    if (!result.ok) throw new Error(`status refused: ${result.code}`);
    return result.value;
  };
  return { service, store, catalog, tenancy, clock, budget, audits, sleeps, chain, status };
}

const failure = (code: string, httpStatus?: number): FakeFetchResult => ({
  ok: false,
  error: { code, ...(httpStatus !== undefined ? { httpStatus } : {}) },
});

/** Holds the fake n8n's next call at `index` until released. */
function holdCall(catalog: FakeN8nCatalog, index: number): { release: () => void; reached: Promise<void> } {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  const fetch = catalog.fetchPage.bind(catalog);
  let held = false;
  catalog.fetchPage = async (input) => {
    // Once: the call that is held is not yet recorded, so the next caller
    // arrives at the same index.
    if (!held && catalog.calls.length === index) {
      held = true;
      reached();
      await gate;
    }
    return fetch(input);
  };
  return { release, reached: arrived };
}

describe("a chain is bounded runs of one scan, until the store says it is complete", () => {
  it("chains runs to a complete scan, and only then says complete", async () => {
    const h = harness();
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "COMPLETE", stopCode: null, runs: 5, pages: 10 });

    // Every run was an ordinary bounded run of the same scan, carrying the chain.
    const runs = h.store.runsOf(SCOPE);
    expect(runs.map((r) => r.status)).toEqual(["PARTIAL", "PARTIAL", "PARTIAL", "PARTIAL", "COMPLETE"]);
    expect(new Set(runs.map((r) => r.scanId)).size).toBe(1);
    expect(runs.every((r) => r.chainId === outcome.chainId && r.pagesFetched <= 2)).toBe(true);
    // Each page once, in order.
    expect(h.catalog.calls.map((c) => c.offset)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);

    const view = await h.status();
    expect(view).toMatchObject({
      state: "complete",
      lastCompleteScan: { records: 95 },
      currentScan: null,
      continuation: { status: "COMPLETE", stop: null, runFailure: null, runs: 5, pages: 10, recordsObserved: 95 },
    });
    // The Organization's slot was taken for every run; the caller's once.
    expect(h.budget.counts).toEqual({ user: 1, org: 5 });
  });

  it("is never complete when a limit stops it — and the next chain continues where it stopped", async () => {
    const h = harness({ chainLimits: { maxRuns: 2 } });
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "RUN_LIMIT", runs: 2, pages: 4 });
    const view = await h.status();
    expect(view.state).toBe("partial");
    expect(view.lastCompleteScan).toBeNull();
    expect(view.continuation).toMatchObject({ status: "STOPPED", stop: { code: "RUN_LIMIT", message: LIBRARY_CHAIN_STOP_MESSAGES.RUN_LIMIT } });
    expect(view.currentScan).toMatchObject({ pagesFetched: 4, recordsObserved: 40 });

    const second = await h.chain();
    expect(second.outcome).toMatchObject({ status: "STOPPED", stopCode: "RUN_LIMIT", runs: 2 });
    const third = await h.chain();
    expect(third.outcome).toMatchObject({ status: "COMPLETE", runs: 1, pages: 2 });
    // Nothing was read twice across the three chains.
    expect(h.catalog.calls.map((c) => c.offset)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it("stops at its page limit exactly, giving the last run only the pages left", async () => {
    const h = harness({ chainLimits: { maxPages: 3 } });
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "PAGE_LIMIT", runs: 2, pages: 3 });
    expect(h.store.runsOf(SCOPE).map((r) => r.pagesFetched)).toEqual([2, 1]);
    expect(h.catalog.calls).toHaveLength(3);
  });

  it("stops at its time limit at a page boundary, with the scan's place kept", async () => {
    const h = harness({ chainLimits: { maxMs: 25_000 } });
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "TIME_LIMIT" });
    expect(outcome.pages).toBeGreaterThan(0);
    expect(outcome.pages).toBeLessThan(10);
    expect((await h.status()).state).toBe("partial");
    expect((await h.chain()).outcome.status).not.toBe("FAILED");
  });

  it("stops when the server is stopping, its run ending at a page boundary", async () => {
    let stopping = false;
    const h = harness({ shouldStop: () => stopping });
    h.catalog.intercept = ({ index }, real) => {
      if (index === 2) stopping = true;
      return real();
    };
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "SHUTDOWN" });
    expect(h.store.runsOf(SCOPE).at(-1)!.status).toBe("PARTIAL");
    expect((await h.status()).lastCompleteScan).toBeNull();
  });
});

describe("the budget is spent before anything is read, for every run", () => {
  it("stops a chain whose Organization budget runs out, before the next read", async () => {
    const budget = countingBudget({ orgLimit: 2 });
    const h = harness({ budget: budget.port });
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "BUDGET_EXHAUSTED", runs: 2, pages: 4 });
    expect(h.catalog.calls).toHaveLength(4);
  });

  it("stops when the budget cannot be checked — unknown is no", async () => {
    const budget = countingBudget({ orgUnavailableAfter: 1 });
    const h = harness({ budget: budget.port });
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "BUDGET_UNAVAILABLE", runs: 1 });
  });

  it("starts no chain at all when the first run's slot is refused", async () => {
    const budget = countingBudget({ orgLimit: 0 });
    const h = harness({ budget: budget.port });
    const started = await h.service.startContinuation(PEOPLE.owner);
    expect(started).toMatchObject({ ok: false, status: 429, code: "RATE_LIMITED" });
    expect(h.store.chainsOf(SCOPE)).toHaveLength(0);
    expect(h.catalog.calls).toHaveLength(0);
  });
});

describe("a failed run", () => {
  it("stops the chain at once when another try would not help", async () => {
    const h = harness();
    h.catalog.intercept = ({ index }, real) => (index === 3 ? failure("AUTHENTICATION_REQUIRED", 401) : real());
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "RUN_FAILED", failureCode: "PROVIDER_AUTH_FAILED", runs: 2 });
    expect(h.sleeps).toEqual([]);
    expect((await h.status()).continuation).toMatchObject({
      status: "STOPPED",
      stop: { code: "RUN_FAILED" },
      runFailure: { code: "PROVIDER_AUTH_FAILED" },
    });
  });

  it("stops on a rejected cursor, and the scan starts again from the first page next time", async () => {
    const h = harness();
    h.catalog.intercept = ({ index }, real) => (index === 2 ? failure("INVALID_REQUEST", 400) : real());
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ stopCode: "RUN_FAILED", failureCode: "CURSOR_REJECTED" });
    h.catalog.intercept = undefined;
    const next = await h.chain();
    expect(next.outcome.status).toBe("COMPLETE");
    expect(h.catalog.calls[3]!.cursor).toBeNull();
  });

  it("retries a transient failure after a pause, and completes", async () => {
    const h = harness();
    h.catalog.intercept = ({ index }, real) => (index === 3 ? failure("TOOL_TIMEOUT") : real());
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "COMPLETE" });
    expect(h.sleeps).toHaveLength(1);
    expect(h.store.runsOf(SCOPE).map((r) => r.status)).toContain("FAILED");
  });

  it("stops after a bounded number of transient failures in a row", async () => {
    const h = harness();
    h.catalog.intercept = ({ index }, real) => (index >= 2 ? failure("RATE_LIMITED", 429) : real());
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "RETRY_LIMIT", failureCode: "PROVIDER_RATE_LIMITED" });
    expect(outcome.runs).toBe(1 + LIBRARY_CHAIN_MAX_CONSECUTIVE_FAILURES);
    expect(h.sleeps).toHaveLength(LIBRARY_CHAIN_MAX_CONSECUTIVE_FAILURES - 1);
    // Increasing pauses.
    expect([...h.sleeps].sort((a, b) => a - b)).toEqual(h.sleeps);
  });
});

describe("authorization and scope are read again before every run", () => {
  it("stops when the requester is no longer an owner or admin", async () => {
    const h = harness();
    h.catalog.intercept = ({ index }, real) => {
      if (index === 1) h.tenancy.setRole(PEOPLE.owner, ORG, "member");
      return real();
    };
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "AUTHORIZATION_CHANGED", runs: 1 });
    expect(h.catalog.calls).toHaveLength(2);
  });

  it("stops when the requester leaves the Organization", async () => {
    const h = harness();
    h.catalog.intercept = ({ index }, real) => {
      if (index === 1) h.tenancy.setRole(PEOPLE.owner, ORG, null);
      return real();
    };
    expect((await h.chain()).outcome).toMatchObject({ stopCode: "AUTHORIZATION_CHANGED", runs: 1 });
  });

  it("stops when the connection moves to another Organization — even one the requester also owns", async () => {
    const h = harness();
    h.tenancy.setRole(PEOPLE.owner, OTHER_ORG, "owner");
    h.catalog.intercept = ({ index }, real) => {
      if (index === 1) h.tenancy.setOwner("n8n", "rest", OTHER_ORG);
      return real();
    };
    const { outcome } = await h.chain();
    expect(outcome).toMatchObject({ status: "STOPPED", stopCode: "SCOPE_CHANGED", runs: 1 });
    expect(h.catalog.calls).toHaveLength(2);
    // Nothing was written into the other Organization's catalog.
    expect(h.store.entriesOf({ ...SCOPE, tenantId: OTHER_ORG })).toHaveLength(0);
  });

  it("stops when authorization cannot be checked", async () => {
    const h = harness();
    h.catalog.intercept = ({ index }, real) => {
      if (index === 1) h.tenancy.setFailing(true);
      return real();
    };
    expect((await h.chain()).outcome).toMatchObject({ stopCode: "AUTHORIZATION_UNAVAILABLE", runs: 1 });
  });

  it("is started only by an owner or admin of the owning Organization, before anything is spent", async () => {
    const h = harness();
    expect(await h.service.startContinuation(PEOPLE.member)).toMatchObject({ ok: false, status: 403, code: "PERMISSION_DENIED" });
    expect(await h.service.startContinuation(PEOPLE.viewer)).toMatchObject({ ok: false, status: 403, code: "PERMISSION_DENIED" });
    expect(await h.service.startContinuation(PEOPLE.otherOwner)).toMatchObject({ ok: false, status: 403, code: "NOT_AVAILABLE" });
    expect(h.budget.counts).toEqual({ user: 0, org: 0 });
    expect(h.store.chainsOf(SCOPE)).toHaveLength(0);
    expect((await h.chain(PEOPLE.admin)).outcome.status).toBe("COMPLETE");
  });
});

describe("one chain per catalog, whatever is clicked", () => {
  it("answers two clicks at once with one chain", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.service.startContinuation(PEOPLE.owner), h.service.startContinuation(PEOPLE.admin)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.chainId).toBe(b.value.chainId);
    expect([a.value.existing, b.value.existing].sort()).toEqual([false, true]);
    await (a.value.completion ?? b.value.completion);
    expect(h.store.chainsOf(SCOPE)).toHaveLength(1);
    expect(h.store.runsOf(SCOPE)).toHaveLength(5);
  });

  it("answers a repeated click while it runs with the same chain, spending nothing", async () => {
    const h = harness();
    const held = holdCall(h.catalog, 1);
    const first = await h.service.startContinuation(PEOPLE.owner);
    await held.reached;
    const spent = { ...h.budget.counts };
    const again = await h.service.startContinuation(PEOPLE.owner);
    const other = await h.service.startContinuation(PEOPLE.admin, { idempotencyKey: "another-click-1" });
    expect(again).toMatchObject({ ok: true, value: { existing: true, state: "running", completion: null } });
    expect(other).toMatchObject({ ok: true, value: { existing: true, state: "running" } });
    if (first.ok && again.ok) expect(again.value.chainId).toBe(first.value.chainId);
    expect(h.budget.counts).toEqual(spent);
    // A single run is refused while the chain holds the catalog — between its runs too.
    expect(await h.service.requestSync(PEOPLE.admin)).toMatchObject({ ok: false, status: 409, code: "SYNC_ALREADY_RUNNING" });
    held.release();
    if (first.ok) await first.value.completion;
    expect(h.store.chainsOf(SCOPE)).toHaveLength(1);
  });

  it("returns the chain a key started, after it ended too — a retry is not a new chain", async () => {
    const h = harness();
    const key = "4f0d2c1e-9b8a-4c3d-8e7f-6a5b4c3d2e1f";
    const { started } = await h.chain(PEOPLE.owner, { idempotencyKey: key });
    const spent = { ...h.budget.counts };
    const retry = await h.service.startContinuation(PEOPLE.owner, { idempotencyKey: key });
    expect(retry).toMatchObject({ ok: true, value: { chainId: started.chainId, existing: true, state: "COMPLETE", completion: null } });
    expect(h.budget.counts).toEqual(spent);
    expect(h.store.runsOf(SCOPE)).toHaveLength(5);
    // The key is the requester's: another person's same key is their own request.
    const theirs = await h.service.startContinuation(PEOPLE.admin, { idempotencyKey: key });
    expect(theirs.ok && theirs.value.chainId).not.toBe(started.chainId);
    if (theirs.ok) await theirs.value.completion;
  });

  it("is refused while a single run holds the lease", async () => {
    const h = harness();
    const held = holdCall(h.catalog, 0);
    const single = await h.service.requestSync(PEOPLE.owner);
    await held.reached;
    expect(await h.service.startContinuation(PEOPLE.admin)).toMatchObject({ ok: false, status: 409, code: "SYNC_ALREADY_RUNNING" });
    held.release();
    if (single.ok) await single.value.completion;
    expect(h.store.chainsOf(SCOPE)).toHaveLength(0);
  });
});

describe("recovery after the process that drove a chain died", () => {
  it("shows it interrupted, closes it at the next start, and resumes from the last stored page", async () => {
    const store = memoryLibraryStore();
    const clock = steppingClock();
    const catalog = fakeN8nCatalog(50);
    const tenancy = organization();
    const before = harness({ store, clock, catalog, tenancy });
    const held = holdCall(catalog, 3);
    const dead = await before.service.startContinuation(PEOPLE.owner);
    await held.reached;
    // Its progress is in the store as it goes: the chain's counters per
    // finished run (two pages from run one, run two started), the open scan's
    // page by page (three stored).
    const midway = await before.status();
    expect(midway.state).toBe("running");
    expect(midway.continuation).toMatchObject({ status: "RUNNING", runs: 2, pages: 2 });
    expect(midway.currentScan).toMatchObject({ pagesFetched: 3, recordsObserved: 30 });

    // The server restarts: a new service over the same store, and time passes.
    clock.advance(Math.max(LIBRARY_LEASE_MS, LIBRARY_CHAIN_STALE_MS) + 1_000);
    const after = harness({ store, clock, catalog, tenancy });
    const shown = await after.status();
    expect(shown.continuation).toMatchObject({ status: "INTERRUPTED", stop: { code: "INTERRUPTED" } });
    expect(shown.state).not.toBe("running");
    expect(shown.state).not.toBe("complete");

    const resumed = await after.chain(PEOPLE.admin);
    expect(resumed.outcome).toMatchObject({ status: "COMPLETE" });
    // The interrupted chain is closed as that; the scan went on from page four.
    const chains = store.chainsOf(SCOPE);
    expect(chains.map((c) => c.status)).toEqual(["INTERRUPTED", "COMPLETE"]);
    expect(catalog.calls.map((c) => c.offset)).toEqual([0, 10, 20, 30, 40]);
    expect((await after.status()).lastCompleteScan).toMatchObject({ records: 50 });

    // The old driver wakes: it holds nothing any more, stores nothing and claims nothing.
    held.release();
    const late = dead.ok ? await dead.value.completion : null;
    expect(late).toMatchObject({ status: "STOPPED" });
    expect(late!.stopCode === "CHAIN_LOST" || late!.stopCode === "SYNC_ALREADY_RUNNING").toBe(true);
    expect(store.chainsOf(SCOPE)[0]!.status).toBe("INTERRUPTED");
    expect((await after.status()).continuation).toMatchObject({ status: "COMPLETE" });
  });
});

describe("what is shown and what is recorded", () => {
  it("tells each reader whether they may start a sync — the server's answer, not the screen's", async () => {
    const h = harness();
    expect((await h.status(PEOPLE.owner)).canSync).toBe(true);
    expect((await h.status(PEOPLE.admin)).canSync).toBe(true);
    expect((await h.status(PEOPLE.member)).canSync).toBe(false);
    expect((await h.status(PEOPLE.viewer)).canSync).toBe(false);
    expect(await h.service.status(PEOPLE.otherOwner)).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });
  });

  it("keeps the requester, the key, cursors and the instance out of every view and audit row", async () => {
    const h = harness();
    const key = "abcdefgh-1234-secret-looking";
    await h.chain(PEOPLE.owner, { idempotencyKey: key });
    const view = JSON.stringify(await h.status(PEOPLE.member));
    expect(view).not.toContain(PEOPLE.owner);
    expect(view).not.toContain(key);
    expect(view).not.toContain("requestedById");
    const audits = JSON.stringify(h.audits);
    expect(audits).not.toContain(BASE_URL);
    expect(audits).not.toContain(INSTANCE);
    expect(audits).not.toContain(key);
    expect(audits).not.toMatch(/"cursor"|eyJ/);
    for (const cursor of h.catalog.calls.map((c) => c.cursor).filter(Boolean)) {
      expect(view).not.toContain(cursor!);
      expect(audits).not.toContain(cursor!);
    }
    expect(h.audits.map((a) => a.action)).toEqual([
      "automation_library.sync",
      ...Array(5).fill("automation_library.sync_run"),
      "automation_library.sync_chain",
    ]);
    expect(h.audits.at(-1)).toMatchObject({ result: "success", metadata: { status: "COMPLETE", runs: 5, pages: 10 } });
  });
});
