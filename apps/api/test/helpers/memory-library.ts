// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — the Automation Library's two ports, in memory.
//
// `memoryLibraryStore` implements `AutomationLibraryStore` with the semantics
// the Prisma repository has: one lease per catalog, every page fenced by it, a
// page and its checkpoint stored together, idempotent upserts, reconciliation
// only at the end of a complete scan. Each method makes its decision without
// awaiting in between, so — JavaScript being single-threaded — each one is as
// atomic as the repository's transaction. The PostgreSQL suites prove the same
// scenarios against the real repository.
//
// Stage 18.2 adds the chain methods with the repository's semantics: one
// chain holds the catalog through `activeChainId`; while it is alive (a run
// of it holds the lease, or its heartbeat is fresh) only its runs begin; a
// start that finds it dead closes it as INTERRUPTED.
//
// `fakeN8nCatalog` is an n8n instance's workflow list: pages addressed by an
// offset carried inside an opaque cursor, as n8n's own cursor is, so a deletion
// between pages shifts the window exactly as it would there. `intercept` lets a
// test replace any one answer — a failure, a repeated page, a cycling cursor.
// ---------------------------------------------------------------------------

import {
  LIBRARY_CHAIN_STALE_MS,
  LIBRARY_MISSED_SCANS_BEFORE_REMOVED,
  libraryEntryPresence,
  normalizeLibrarySearch,
  type AutomationLibraryStore,
  type LibraryBeginInput,
  type LibraryBeginResult,
  type LibraryChainFinishInput,
  type LibraryChainProgressInput,
  type LibraryChainRecord,
  type LibraryChainStartInput,
  type LibraryChainStartResult,
  type LibraryChainState,
  type LibraryCheckpoint,
  type LibraryEntryQuery,
  type LibraryEntryRecord,
  type LibraryFailureCode,
  type LibraryFinishInput,
  type LibraryPageSource,
  type LibraryPersistInput,
  type LibraryPersistResult,
  type LibraryRemoteWorkflow,
  type LibraryRunRecord,
  type LibraryRunStatus,
  type LibraryScope,
  type LibraryStatusRecord,
  type LibraryWorkflowRecord,
} from "@jarvis/core";

interface SyncRow {
  scanId: string | null;
  scanCursor: string | null;
  scanPageSize: number | null;
  scanPages: number;
  scanRecords: number;
  scanCursorTrail: string[];
  scanStartedAt: Date | null;
  lastCompleteScanId: string | null;
  lastCompleteAt: Date | null;
  lastCompleteRecords: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  activeChainId: string | null;
  chainHeartbeatAt: Date | null;
}

interface ChainRow extends LibraryChainRecord {
  scopeKey: string;
  idempotencyKey: string | null;
}

interface EntryRow extends LibraryWorkflowRecord {
  scopeKey: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSeenScanId: string;
  contentChangedAt: Date;
  missedScans: number;
  missingSince: Date | null;
  removedAt: Date | null;
}

interface RunRow extends Omit<LibraryRunRecord, "startedAt" | "finishedAt"> {
  scopeKey: string;
  chainId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const keyOf = (scope: LibraryScope) => `${scope.tenantId}|${scope.providerId}|${scope.instanceKey}`;

const closedScan = (): Pick<
  SyncRow,
  "scanId" | "scanCursor" | "scanPageSize" | "scanPages" | "scanRecords" | "scanCursorTrail" | "scanStartedAt"
> => ({
  scanId: null,
  scanCursor: null,
  scanPageSize: null,
  scanPages: 0,
  scanRecords: 0,
  scanCursorTrail: [],
  scanStartedAt: null,
});

export interface MemoryLibraryStore extends AutomationLibraryStore {
  /** Every entry, by scope key, for assertions. */
  entriesOf(scope: LibraryScope): EntryRow[];
  /** The scope's raw sync row — the checkpoint a test inspects. */
  syncOf(scope: LibraryScope): SyncRow | undefined;
  /** Makes the next N persistPage calls throw (the database failing). */
  failNextPersists(count: number): void;
  /** Every chain of the scope, oldest first. */
  chainsOf(scope: LibraryScope): ChainRow[];
  /** Every run of the scope, oldest first, with its chain. */
  runsOf(scope: LibraryScope): RunRow[];
}

export function memoryLibraryStore(): MemoryLibraryStore {
  const syncs = new Map<string, SyncRow>();
  const entries = new Map<string, EntryRow>();
  const runs = new Map<string, RunRow>();
  const chains = new Map<string, ChainRow>();
  let persistFailures = 0;

  const syncFor = (scope: LibraryScope): SyncRow => {
    const key = keyOf(scope);
    let row = syncs.get(key);
    if (!row) {
      row = {
        ...closedScan(),
        lastCompleteScanId: null,
        lastCompleteAt: null,
        lastCompleteRecords: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        activeChainId: null,
        chainHeartbeatAt: null,
      };
      syncs.set(key, row);
    }
    return row;
  };

  const checkpointOf = (row: SyncRow): LibraryCheckpoint => ({
    scanId: row.scanId!,
    cursor: row.scanCursor,
    pageSize: row.scanPageSize!,
    pagesFetched: row.scanPages,
    recordsObserved: row.scanRecords,
    cursorTrail: [...row.scanCursorTrail],
    scanStartedAt: row.scanStartedAt!.toISOString(),
  });

  const scopeEntries = (scope: LibraryScope) => [...entries.values()].filter((e) => e.scopeKey === keyOf(scope));

  /** An entry as the store hands it out — the repository's mapping. */
  const toRecord = (e: EntryRow): LibraryEntryRecord => ({
    externalId: e.externalId,
    name: e.name,
    active: e.active,
    remoteCreatedAt: e.remoteCreatedAt,
    remoteUpdatedAt: e.remoteUpdatedAt,
    versionId: e.versionId,
    tags: e.tags,
    nodeTypes: e.nodeTypes,
    nodeCount: e.nodeCount,
    fingerprint: e.fingerprint,
    source: "rest" as const,
    presence: libraryEntryPresence(e),
    firstSeenAt: e.firstSeenAt.toISOString(),
    lastSeenAt: e.lastSeenAt.toISOString(),
    contentChangedAt: e.contentChangedAt.toISOString(),
    missingSince: e.missingSince?.toISOString() ?? null,
    removedAt: e.removedAt?.toISOString() ?? null,
  });

  const leaseLive = (row: SyncRow, now: Date) => row.leaseOwner !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt > now;
  const chainAlive = (row: SyncRow, now: Date, staleMs: number) =>
    row.activeChainId !== null &&
    (leaseLive(row, now) || (row.chainHeartbeatAt !== null && row.chainHeartbeatAt.getTime() > now.getTime() - staleMs));
  const closeRunningChains = (scope: LibraryScope, now: Date) => {
    for (const chain of chains.values()) {
      if (chain.scopeKey === keyOf(scope) && chain.status === "RUNNING") {
        chain.status = "INTERRUPTED";
        chain.stopCode = "INTERRUPTED";
        chain.finishedAt = now.toISOString();
      }
    }
  };
  const publicChain = (chain: ChainRow): LibraryChainRecord => {
    const { scopeKey: _scope, idempotencyKey: _key, ...record } = chain;
    return { ...record };
  };
  const stateOf = (chain: ChainRow, row: SyncRow, now: Date, staleMs: number): LibraryChainState => ({
    ...publicChain(chain),
    alive: chain.status === "RUNNING" && row.activeChainId === chain.chainId && chainAlive(row, now, staleMs),
  });
  const byKey = (scope: LibraryScope, requestedById: string, key: string | undefined) =>
    key === undefined
      ? undefined
      : [...chains.values()].find((c) => c.scopeKey === keyOf(scope) && c.requestedById === requestedById && c.idempotencyKey === key);

  return {
    async beginRun(input: LibraryBeginInput): Promise<LibraryBeginResult> {
      const row = syncFor(input.scope);
      const { now } = input;
      const chainId = input.chainId ?? null;
      const staleMs = input.chainStaleMs ?? LIBRARY_CHAIN_STALE_MS;
      if (chainId !== null && row.activeChainId !== chainId) return { ok: false, reason: "CHAIN_LOST" };
      if (leaseLive(row, now)) return { ok: false, reason: "LEASE_HELD" };
      if (chainId === null && chainAlive(row, now, staleMs)) return { ok: false, reason: "LEASE_HELD" };
      row.leaseOwner = input.runId;
      row.leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
      if (chainId !== null) {
        row.chainHeartbeatAt = now;
        const chain = chains.get(chainId)!;
        chain.runs += 1;
        chain.heartbeatAt = now.toISOString();
      } else {
        row.activeChainId = null;
        row.chainHeartbeatAt = null;
        closeRunningChains(input.scope, now);
      }
      let recoveredRuns = 0;
      for (const run of runs.values()) {
        if (run.scopeKey === keyOf(input.scope) && run.status === "RUNNING") {
          run.status = "FAILED";
          run.failureCode = "INTERRUPTED";
          run.finishedAt = now;
          recoveredRuns += 1;
        }
      }
      const resumed = !input.restart && row.scanId !== null && row.scanPageSize !== null && row.scanStartedAt !== null;
      if (!resumed) {
        Object.assign(row, closedScan(), { scanId: input.newScanId, scanPageSize: input.pageSize, scanStartedAt: now });
      }
      runs.set(input.runId, {
        scopeKey: keyOf(input.scope),
        chainId,
        runId: input.runId,
        scanId: row.scanId!,
        status: "RUNNING",
        resumed,
        pagesFetched: 0,
        recordsObserved: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        rejected: 0,
        markedMissing: 0,
        markedRemoved: 0,
        failureCode: null,
        startedAt: now,
        finishedAt: null,
      });
      return { ok: true, resumed, checkpoint: checkpointOf(row), recoveredRuns };
    },

    async persistPage(input: LibraryPersistInput): Promise<LibraryPersistResult> {
      if (persistFailures > 0) {
        persistFailures -= 1;
        throw new Error("database unavailable");
      }
      const { scope, now } = input;
      const row = syncFor(scope);
      if (row.leaseOwner !== input.runId || !row.leaseExpiresAt || row.leaseExpiresAt <= now || row.scanId !== input.scanId) {
        return { ok: false, reason: "LEASE_LOST" };
      }
      row.leaseExpiresAt = new Date(now.getTime() + input.leaseMs);

      let created = 0;
      let updated = 0;
      let unchanged = 0;
      for (const record of input.records) {
        const key = `${keyOf(scope)}|${record.externalId}`;
        const existing = entries.get(key);
        const seen = { lastSeenAt: now, lastSeenScanId: input.scanId, missedScans: 0, missingSince: null, removedAt: null };
        if (!existing) {
          entries.set(key, { ...record, scopeKey: keyOf(scope), firstSeenAt: now, contentChangedAt: now, ...seen });
          created += 1;
        } else if (existing.fingerprint === record.fingerprint) {
          Object.assign(existing, seen);
          unchanged += 1;
        } else {
          Object.assign(existing, record, seen, { contentChangedAt: now });
          updated += 1;
        }
      }

      const run = runs.get(input.runId)!;
      run.pagesFetched += 1;
      run.recordsObserved += input.observed;
      run.created += created;
      run.updated += updated;
      run.unchanged += unchanged;
      run.rejected += input.rejected;

      if (input.next === "END") {
        let markedMissing = 0;
        let markedRemoved = 0;
        for (const entry of scopeEntries(scope)) {
          if (entry.removedAt || entry.lastSeenScanId === input.scanId) continue;
          entry.missingSince ??= now;
          entry.missedScans += 1;
          if (entry.missedScans >= LIBRARY_MISSED_SCANS_BEFORE_REMOVED) {
            entry.removedAt = now;
            markedRemoved += 1;
          } else {
            markedMissing += 1;
          }
        }
        const records = scopeEntries(scope).filter((e) => e.lastSeenScanId === input.scanId).length;
        Object.assign(row, closedScan(), {
          lastCompleteScanId: input.scanId,
          lastCompleteAt: now,
          lastCompleteRecords: records,
          leaseOwner: null,
          leaseExpiresAt: null,
          chainHeartbeatAt: now,
        });
        run.status = "COMPLETE";
        run.finishedAt = now;
        run.markedMissing += markedMissing;
        run.markedRemoved += markedRemoved;
        return { ok: true, checkpoint: null, created, updated, unchanged, markedMissing, markedRemoved };
      }

      row.scanCursor = input.next.cursor;
      row.scanPages += 1;
      row.scanRecords += input.observed;
      if (input.requestedCursorHash) row.scanCursorTrail.push(input.requestedCursorHash);
      return { ok: true, checkpoint: checkpointOf(row), created, updated, unchanged, markedMissing: 0, markedRemoved: 0 };
    },

    async finishRun(input: LibraryFinishInput): Promise<void> {
      const run = runs.get(input.runId);
      if (run && run.status === "RUNNING") {
        run.status = input.status;
        run.failureCode = input.failureCode;
        run.finishedAt = input.now;
      }
      const row = syncFor(input.scope);
      if (row.leaseOwner === input.runId) {
        if (input.resetScan) Object.assign(row, closedScan());
        row.leaseOwner = null;
        row.leaseExpiresAt = null;
        row.chainHeartbeatAt = input.now;
      }
    },

    async readStatus(scope: LibraryScope, now: Date, chainStaleMs: number = LIBRARY_CHAIN_STALE_MS): Promise<LibraryStatusRecord> {
      const all = scopeEntries(scope);
      const entryCounts = {
        present: all.filter((e) => !e.removedAt && e.missedScans === 0).length,
        missing: all.filter((e) => !e.removedAt && e.missedScans > 0).length,
        removed: all.filter((e) => e.removedAt).length,
      };
      const row = syncs.get(keyOf(scope));
      if (!row) return { leaseHeld: false, scan: null, lastComplete: null, runs: [], entries: entryCounts, chain: null };
      const latestChain = [...chains.values()].filter((c) => c.scopeKey === keyOf(scope)).at(-1);
      const scopeRuns = [...runs.values()]
        .filter((r) => r.scopeKey === keyOf(scope))
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, 10);
      return {
        leaseHeld: row.leaseOwner !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt > now,
        scan: row.scanId && row.scanStartedAt ? { pagesFetched: row.scanPages, recordsObserved: row.scanRecords, startedAt: row.scanStartedAt.toISOString() } : null,
        lastComplete: row.lastCompleteAt && row.lastCompleteRecords !== null ? { at: row.lastCompleteAt.toISOString(), records: row.lastCompleteRecords } : null,
        runs: scopeRuns.map((r) => ({
          runId: r.runId,
          scanId: r.scanId,
          status: r.status as LibraryRunStatus,
          resumed: r.resumed,
          pagesFetched: r.pagesFetched,
          recordsObserved: r.recordsObserved,
          created: r.created,
          updated: r.updated,
          unchanged: r.unchanged,
          rejected: r.rejected,
          markedMissing: r.markedMissing,
          markedRemoved: r.markedRemoved,
          failureCode: r.failureCode as LibraryFailureCode | null,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null,
        })),
        entries: entryCounts,
        chain: latestChain ? stateOf(latestChain, row, now, chainStaleMs) : null,
      };
    },

    async peekChain(scope, input): Promise<LibraryChainState | null> {
      const row = syncs.get(keyOf(scope));
      if (!row) return null;
      const same = byKey(scope, input.requestedById, input.idempotencyKey);
      if (same) return stateOf(same, row, input.now, input.staleMs);
      if (!chainAlive(row, input.now, input.staleMs)) return null;
      const holder = chains.get(row.activeChainId!);
      return holder ? stateOf(holder, row, input.now, input.staleMs) : null;
    },

    async startChain(input: LibraryChainStartInput): Promise<LibraryChainStartResult> {
      const row = syncFor(input.scope);
      const { now } = input;
      const same = byKey(input.scope, input.requestedById, input.idempotencyKey);
      if (same) return { ok: true, created: false, chain: stateOf(same, row, now, input.staleMs) };
      if (chainAlive(row, now, input.staleMs)) {
        const holder = chains.get(row.activeChainId!);
        if (holder) return { ok: true, created: false, chain: stateOf(holder, row, now, input.staleMs) };
      }
      if (leaseLive(row, now)) return { ok: false, reason: "SYNC_RUNNING" };
      closeRunningChains(input.scope, now);
      row.activeChainId = input.chainId;
      row.chainHeartbeatAt = now;
      const chain: ChainRow = {
        scopeKey: keyOf(input.scope),
        idempotencyKey: input.idempotencyKey ?? null,
        chainId: input.chainId,
        status: "RUNNING",
        stopCode: null,
        failureCode: null,
        runs: 0,
        pages: 0,
        recordsObserved: 0,
        maxRuns: input.limits.maxRuns,
        maxPages: input.limits.maxPages,
        deadlineAt: new Date(now.getTime() + input.limits.maxMs).toISOString(),
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        finishedAt: null,
        requestedById: input.requestedById,
      };
      chains.set(input.chainId, chain);
      return { ok: true, created: true, chain: { ...publicChain(chain), alive: true } };
    },

    async recordChainProgress(input: LibraryChainProgressInput): Promise<boolean> {
      const row = syncFor(input.scope);
      if (row.activeChainId !== input.chainId) return false;
      row.chainHeartbeatAt = input.now;
      const chain = chains.get(input.chainId);
      if (chain && chain.status === "RUNNING") {
        chain.heartbeatAt = input.now.toISOString();
        if (input.run) {
          chain.pages += input.run.pages;
          chain.recordsObserved += input.run.records;
        }
      }
      return true;
    },

    async finishChain(input: LibraryChainFinishInput): Promise<void> {
      const chain = chains.get(input.chainId);
      if (chain && chain.status === "RUNNING") {
        Object.assign(chain, {
          status: input.status,
          stopCode: input.stopCode,
          failureCode: input.failureCode,
          finishedAt: input.now.toISOString(),
          heartbeatAt: input.now.toISOString(),
        });
      }
      const row = syncFor(input.scope);
      if (row.activeChainId === input.chainId) {
        row.activeChainId = null;
        row.chainHeartbeatAt = null;
      }
    },

    async listEntries(scope: LibraryScope, query: LibraryEntryQuery): Promise<{ items: LibraryEntryRecord[]; total: number }> {
      const search = query.search ? normalizeLibrarySearch(query.search) : "";
      const matching = scopeEntries(scope)
        .filter((e) => {
          switch (query.presence ?? "current") {
            case "present":
              return !e.removedAt && e.missedScans === 0;
            case "missing":
              return !e.removedAt && e.missedScans > 0;
            case "removed":
              return Boolean(e.removedAt);
            case "all":
              return true;
            default:
              return !e.removedAt;
          }
        })
        .filter((e) => query.active === undefined || e.active === query.active)
        .filter((e) => search.length === 0 || e.searchText.includes(search))
        .sort((a, b) => (a.name === b.name ? (a.externalId < b.externalId ? -1 : 1) : a.name < b.name ? -1 : 1));
      const page = matching.slice((query.page - 1) * query.limit, query.page * query.limit);
      return { total: matching.length, items: page.map(toRecord) };
    },

    async findEntry(scope: LibraryScope, entryId: string): Promise<LibraryEntryRecord | null> {
      const entry = entries.get(`${keyOf(scope)}|${entryId}`);
      return entry ? toRecord(entry) : null;
    },

    entriesOf: scopeEntries,
    syncOf: (scope) => syncs.get(keyOf(scope)),
    failNextPersists(count) {
      persistFailures = count;
    },
    chainsOf: (scope) => [...chains.values()].filter((c) => c.scopeKey === keyOf(scope)),
    runsOf: (scope) => [...runs.values()].filter((r) => r.scopeKey === keyOf(scope)),
  };
}

// ---------------------------------------------------------------------------
// A fake n8n workflow list
// ---------------------------------------------------------------------------

export type FakeFetchResult = Awaited<ReturnType<LibraryPageSource["fetchPage"]>>;

export interface FakeN8nCatalog extends LibraryPageSource {
  /** The instance's workflows now — a test may add or delete. */
  workflows: LibraryRemoteWorkflow[];
  /** Every request, in order: the cursor sent (decoded offset, or null) and the page size. */
  readonly calls: Array<{ cursor: string | null; offset: number | null; limit: number }>;
  /** Replace the answer to one call (by 0-based index across the catalog's life). Return undefined to answer normally. */
  intercept?: (call: { index: number; cursor: string | null; limit: number }, real: () => FakeFetchResult) => FakeFetchResult | undefined;
  /** n8n's cursor for an offset, as it would encode it. */
  cursorAt(offset: number, limit: number): string;
}

export function fakeWorkflow(index: number, extra: Partial<LibraryRemoteWorkflow> = {}): LibraryRemoteWorkflow {
  return {
    id: `wf${String(index).padStart(6, "0")}`,
    name: `Workflow ${String(index).padStart(6, "0")}`,
    active: index % 3 === 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    versionId: `v${index}-1`,
    tags: index % 2 === 0 ? ["sales"] : ["ops"],
    nodeTypes: ["n8n-nodes-base.webhook", index % 2 === 0 ? "n8n-nodes-base.slack" : "n8n-nodes-base.gmail"],
    nodeCount: 2,
    ...extra,
  };
}

export function fakeN8nCatalog(count: number): FakeN8nCatalog {
  const encode = (offset: number, limit: number) => Buffer.from(JSON.stringify({ limit, offset })).toString("base64");
  const decode = (cursor: string): { offset: number } | null => {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as { offset?: unknown };
      return typeof parsed.offset === "number" && parsed.offset >= 0 ? { offset: parsed.offset } : null;
    } catch {
      return null;
    }
  };
  const catalog: FakeN8nCatalog = {
    workflows: Array.from({ length: count }, (_, i) => fakeWorkflow(i)),
    calls: [],
    cursorAt: encode,
    async fetchPage({ cursor, limit }) {
      const index = catalog.calls.length;
      const decoded = cursor === null ? null : decode(cursor);
      catalog.calls.push({ cursor, offset: cursor === null ? 0 : (decoded?.offset ?? null), limit });
      const real = (): FakeFetchResult => {
        if (cursor !== null && !decoded) return { ok: false, error: { code: "INVALID_REQUEST", httpStatus: 400 } };
        const offset = decoded?.offset ?? 0;
        const page = catalog.workflows.slice(offset, offset + limit);
        const nextOffset = offset + limit;
        return { ok: true, workflows: page, nextCursor: nextOffset < catalog.workflows.length ? encode(nextOffset, limit) : null };
      };
      return catalog.intercept?.({ index, cursor, limit }, real) ?? real();
    },
  };
  return catalog;
}

/** A clock that moves forward one second every time it is read. */
export function steppingClock(start = Date.parse("2026-10-19T09:00:00.000Z")): { now: () => Date; advance(ms: number): void } {
  let t = start;
  return {
    now: () => {
      t += 1000;
      return new Date(t);
    },
    advance(ms: number) {
      t += ms;
    },
  };
}
