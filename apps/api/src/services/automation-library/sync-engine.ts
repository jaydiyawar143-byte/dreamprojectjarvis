// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — one bounded run of an Automation Library scan.
//
// The engine joins the two ports and decides nothing else: it asks the page
// source for the next page (the network), hands the page to the store (the
// database), and stops. It holds no provider client and no database client, so
// each side is tested — and replaced — without the other.
//
// BOUNDED, THEN RESUMED. A run reads at most `maxPages` pages and stops; the
// store has saved the checkpoint after every page, so the next run continues
// exactly there. A catalog larger than one run is built by several runs of one
// scan — never by raising the bound.
//
// THE ORDER OF ONE PAGE.
//   1. Fetch it with the checkpoint's cursor and the scan's page size.
//   2. Normalize and de-duplicate it (pure; nothing secret survives).
//   3. Store it and advance the checkpoint — one transaction, fenced by the
//      lease (see the store). Only then is the next cursor used.
// A failure at step 1 or 3 ends the run with the checkpoint still on the last
// STORED page, so nothing is skipped and nothing is stored twice.
//
// HOW A RUN ENDS.
//   COMPLETE  the provider's cursor ran out; the store reconciled and closed
//             the scan in the transaction of the last page.
//   PARTIAL   the run used its page budget (or the server is stopping); the
//             scan stays open and resumes.
//   FAILED    the provider or the store refused; the code says which. A
//             rejected cursor, a cursor cycle or an unbounded scan closes the
//             scan, so the next run starts again from the first page — and,
//             because only a complete scan reconciles, nothing already stored
//             is lost or wrongly removed by that.
// ---------------------------------------------------------------------------

import {
  LIBRARY_MAX_PAGES_PER_RUN,
  LIBRARY_MAX_PAGES_PER_SCAN,
  LIBRARY_MAX_PAGE_SIZE,
  classifyLibraryFetchFailure,
  dedupeLibraryPage,
  libraryCursorHash,
  normalizeLibraryWorkflow,
  type AutomationLibraryStore,
  type LibraryCheckpoint,
  type LibraryFailureCode,
  type LibraryPageSource,
  type LibraryScope,
  type LibraryWorkflowRecord,
} from "@jarvis/core";

export interface LibraryRunOutcome {
  runId: string;
  scanId: string;
  status: "PARTIAL" | "COMPLETE" | "FAILED";
  failureCode: LibraryFailureCode | null;
  /** Pages this run stored. */
  pagesFetched: number;
  recordsObserved: number;
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  markedMissing: number;
  markedRemoved: number;
}

export interface LibraryRunContext {
  store: AutomationLibraryStore;
  source: LibraryPageSource;
  scope: LibraryScope;
  runId: string;
  checkpoint: LibraryCheckpoint;
  /** Pages this run may read. Clamped to 1..LIBRARY_MAX_PAGES_PER_RUN. */
  maxPages: number;
  leaseMs: number;
  now: () => Date;
  /** True when the server is stopping: the run ends PARTIAL at the next page boundary. */
  shouldStop?: () => boolean;
}

/** A page size the provider accepts. */
export function clampLibraryPageSize(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return LIBRARY_MAX_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(raw), 1), LIBRARY_MAX_PAGE_SIZE);
}

/** A run's page budget. Never more than the hard bound. */
export function clampLibraryPagesPerRun(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return LIBRARY_MAX_PAGES_PER_RUN;
  return Math.min(Math.max(Math.trunc(raw), 1), LIBRARY_MAX_PAGES_PER_RUN);
}

/**
 * Continues the run `beginRun` opened: reads pages from the checkpoint, stores
 * each, and ends the run. Never throws — every way out is an outcome.
 */
export async function continueLibraryRun(context: LibraryRunContext): Promise<LibraryRunOutcome> {
  const { store, source, scope, runId, leaseMs, now } = context;
  const maxPages = clampLibraryPagesPerRun(context.maxPages);
  let checkpoint = context.checkpoint;
  const scanId = checkpoint.scanId;
  const trail = new Set(checkpoint.cursorTrail);
  let cursor = checkpoint.cursor;

  const totals = {
    pagesFetched: 0,
    recordsObserved: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    markedMissing: 0,
    markedRemoved: 0,
  };
  const outcome = (status: LibraryRunOutcome["status"], failureCode: LibraryFailureCode | null): LibraryRunOutcome => ({
    runId,
    scanId,
    status,
    failureCode,
    ...totals,
  });

  /** Ends a run that did not complete its scan. A store failure here is survived: the lease expires and the next run recovers this one. */
  const finish = async (
    status: "PARTIAL" | "FAILED",
    failureCode: LibraryFailureCode | null,
    resetScan: boolean
  ): Promise<LibraryRunOutcome> => {
    try {
      await store.finishRun({ scope, runId, status, failureCode, resetScan, now: now() });
    } catch {
      /* the lease expires; the next run closes this one as INTERRUPTED */
    }
    return outcome(status, failureCode);
  };

  for (let page = 0; page < maxPages; page += 1) {
    if (context.shouldStop?.()) return finish("PARTIAL", null, false);
    if (checkpoint.pagesFetched >= LIBRARY_MAX_PAGES_PER_SCAN) return finish("FAILED", "SCAN_TOO_LONG", true);

    // 1. The network. A source that throws is a source that could not be reached.
    const requestedCursorHash = cursor !== null ? libraryCursorHash(cursor) : null;
    let fetched: Awaited<ReturnType<LibraryPageSource["fetchPage"]>>;
    try {
      fetched = await source.fetchPage({ cursor, limit: checkpoint.pageSize });
    } catch {
      fetched = { ok: false, error: { code: "NETWORK_ERROR" } };
    }
    if (!fetched.ok) {
      const code = classifyLibraryFetchFailure(fetched.error, { cursorSent: cursor !== null });
      // A refused cursor cannot be resumed from: the scan restarts from the
      // first page on the next run (documented recovery). Every other failure
      // keeps the checkpoint, and the next run retries the same page.
      return finish("FAILED", code, code === "CURSOR_REJECTED");
    }

    // 2. Pure: bounded records, one per id; unaddressable rows counted, not stored.
    const records: LibraryWorkflowRecord[] = [];
    let rejected = 0;
    for (const workflow of fetched.workflows) {
      const record = normalizeLibraryWorkflow(workflow);
      if (record) records.push(record);
      else rejected += 1;
    }

    // A cursor already requested in this scan — straight away or pages later —
    // is a cycle. The page is real data and is stored; the scan is not
    // completed by it, and it is closed so the next run starts afresh.
    const next = fetched.nextCursor;
    const nextHash = next !== null ? libraryCursorHash(next) : null;
    const cycle = nextHash !== null && (trail.has(nextHash) || nextHash === requestedCursorHash);

    // 3. The database: the page and the checkpoint past it, together.
    let stored: Awaited<ReturnType<AutomationLibraryStore["persistPage"]>>;
    try {
      stored = await store.persistPage({
        scope,
        runId,
        scanId,
        records: dedupeLibraryPage(records),
        observed: fetched.workflows.length,
        rejected,
        requestedCursorHash,
        next: next === null ? "END" : { cursor: next },
        leaseMs,
        now: now(),
      });
    } catch {
      return finish("FAILED", "PERSISTENCE_FAILED", false);
    }
    if (!stored.ok) {
      // Another run holds the catalog now. This run's row is closed; the lease
      // and the checkpoint are not this run's to touch.
      return finish("FAILED", "LEASE_LOST", false);
    }

    totals.pagesFetched += 1;
    totals.recordsObserved += fetched.workflows.length;
    totals.created += stored.created;
    totals.updated += stored.updated;
    totals.unchanged += stored.unchanged;
    totals.rejected += rejected;
    totals.markedMissing += stored.markedMissing;
    totals.markedRemoved += stored.markedRemoved;

    // The store completed the run with the scan's last page.
    if (next === null) return outcome("COMPLETE", null);
    if (cycle) return finish("FAILED", "CURSOR_CYCLE", true);

    if (requestedCursorHash) trail.add(requestedCursorHash);
    checkpoint = stored.checkpoint ?? checkpoint;
    cursor = next;
  }

  // The page budget is spent and the chain has not run out: PARTIAL, resumable.
  return finish("PARTIAL", null, false);
}
