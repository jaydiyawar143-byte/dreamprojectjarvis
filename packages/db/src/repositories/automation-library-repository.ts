// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — the Automation Library's storage.
//
// The database side of a catalog synchronization (`AutomationLibraryStore` in
// @jarvis/core). Three guarantees live here, each in one place:
//
//   ONE RUN AT A TIME. `beginRun` takes the catalog's lease with ONE
//   conditional UPDATE (free, or expired) — of two runs starting together,
//   exactly one gets it; the other is told LEASE_HELD and touches nothing. A
//   run that died holding the lease is recovered by the next one: its row is
//   closed as INTERRUPTED and its scan resumes from the last stored page.
//
//   A CHECKPOINT NEVER POINTS PAST AN UNSTORED PAGE. `persistPage` stores a
//   page AND advances the checkpoint past it in ONE transaction, which first
//   renews the lease — fencing: a run whose lease expired and was taken stores
//   nothing, and a failure anywhere rolls back both.
//
//   IDEMPOTENT. Entries are keyed by (Organization, provider, instance,
//   external id). A page stored twice changes nothing the second time; a page
//   that repeats a workflow writes it once.
//
//   ONE CHAIN AT A TIME (Stage 18.2). A continue-until-complete chain holds
//   the catalog through `activeChainId` on the sync row, taken by ONE
//   conditional UPDATE in `startChain` — only while no run holds the lease and
//   no live chain holds the catalog. While a chain is alive only its own runs
//   may begin; a single run is told LEASE_HELD. A chain is alive while one of
//   its runs holds the lease or its heartbeat is fresh; a chain found dead is
//   closed as INTERRUPTED by whichever start takes the catalog from it.
//
// Reconciliation runs only inside the transaction that stores a scan's LAST
// page — the one whose provider cursor ran out. Entries that scan did not see
// gain a missed scan; an entry missing from consecutive complete scans
// (`LIBRARY_MISSED_SCANS_BEFORE_REMOVED`) is marked removed. Nothing is ever
// deleted, and a partial or failed scan reconciles nothing.
//
// Every conditional UPDATE filters on plain columns only, so it is one SQL
// statement and its condition is decided under the row lock.
// ---------------------------------------------------------------------------

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
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
  type LibraryChainStatus,
  type LibraryChainStopCode,
  type LibraryCheckpoint,
  type LibraryEntryQuery,
  type LibraryEntryRecord,
  type LibraryFailureCode,
  type LibraryFinishInput,
  type LibraryPersistInput,
  type LibraryPersistResult,
  type LibraryRunRecord,
  type LibraryRunStatus,
  type LibraryScope,
  type LibraryStatusRecord,
  type LibraryWorkflowRecord,
} from "@jarvis/core";

type Tx = Prisma.TransactionClient;

/** How long a page's transaction may take: up to 250 rows, each possibly changed. */
const PAGE_TRANSACTION = { maxWait: 10_000, timeout: 60_000 } as const;

const scopeWhere = (scope: LibraryScope) => ({
  tenantId: scope.tenantId,
  providerId: scope.providerId,
  instanceKey: scope.instanceKey,
});

/** A closed scan: nothing open, the next run starts from the first page. */
const CLOSED_SCAN = {
  scanId: null,
  scanCursor: null,
  scanPageSize: null,
  scanPages: 0,
  scanRecords: 0,
  scanCursorTrail: [] as string[],
  scanStartedAt: null,
};

function toCheckpoint(row: {
  scanId: string | null;
  scanCursor: string | null;
  scanPageSize: number | null;
  scanPages: number;
  scanRecords: number;
  scanCursorTrail: string[] | null;
  scanStartedAt: Date | null;
}): LibraryCheckpoint {
  if (!row.scanId || row.scanPageSize === null || !row.scanStartedAt) {
    throw new Error("the library has no open scan");
  }
  return {
    scanId: row.scanId,
    cursor: row.scanCursor,
    pageSize: row.scanPageSize,
    pagesFetched: row.scanPages,
    recordsObserved: row.scanRecords,
    cursorTrail: row.scanCursorTrail ?? [],
    scanStartedAt: row.scanStartedAt.toISOString(),
  };
}

function stringArray(value: Prisma.JsonValue | null): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

const jsonOrDbNull = (value: string[] | null) => (value === null ? Prisma.DbNull : value);

/** The lease is free: never taken, released, or expired. */
const leaseFree = (now: Date): Prisma.AutomationLibrarySyncWhereInput => ({
  OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
});

/** No live chain holds the catalog: none ever did, or its heartbeat went stale. */
const noLiveChain = (staleBefore: Date): Prisma.AutomationLibrarySyncWhereInput => ({
  OR: [{ activeChainId: null }, { chainHeartbeatAt: null }, { chainHeartbeatAt: { lte: staleBefore } }],
});

/** A chain whose process died: closed by the start that takes the catalog from it. */
const INTERRUPTED_CHAIN = (now: Date) => ({
  status: "INTERRUPTED" as const,
  stopCode: "INTERRUPTED" satisfies LibraryChainStopCode,
  finishedAt: now,
});

/** Whether the chain the sync row names is alive: one of its runs holds the lease, or it beat recently. */
function chainAlive(
  sync: { activeChainId: string | null; chainHeartbeatAt: Date | null; leaseOwner: string | null; leaseExpiresAt: Date | null },
  now: Date,
  staleMs: number
): boolean {
  if (!sync.activeChainId) return false;
  const leaseLive = sync.leaseOwner !== null && sync.leaseExpiresAt !== null && sync.leaseExpiresAt > now;
  const fresh = sync.chainHeartbeatAt !== null && sync.chainHeartbeatAt.getTime() > now.getTime() - staleMs;
  return leaseLive || fresh;
}

type ChainRow = {
  id: string;
  status: string;
  stopCode: string | null;
  failureCode: string | null;
  runsStarted: number;
  pagesFetched: number;
  recordsObserved: number;
  maxRuns: number;
  maxPages: number;
  deadlineAt: Date;
  startedAt: Date;
  heartbeatAt: Date;
  finishedAt: Date | null;
  requestedById: string | null;
};

function chainRecord(row: ChainRow): LibraryChainRecord {
  return {
    chainId: row.id,
    status: row.status as LibraryChainStatus,
    stopCode: (row.stopCode as LibraryChainStopCode | null) ?? null,
    failureCode: (row.failureCode as LibraryFailureCode | null) ?? null,
    runs: row.runsStarted,
    pages: row.pagesFetched,
    recordsObserved: row.recordsObserved,
    maxRuns: row.maxRuns,
    maxPages: row.maxPages,
    deadlineAt: row.deadlineAt.toISOString(),
    startedAt: row.startedAt.toISOString(),
    heartbeatAt: row.heartbeatAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    requestedById: row.requestedById,
  };
}

/** A chain row with whether it is alive, read against its catalog's sync row. */
function chainState(
  row: ChainRow,
  sync: { activeChainId: string | null; chainHeartbeatAt: Date | null; leaseOwner: string | null; leaseExpiresAt: Date | null },
  now: Date,
  staleMs: number
): LibraryChainState {
  return { ...chainRecord(row), alive: row.status === "RUNNING" && sync.activeChainId === row.id && chainAlive(sync, now, staleMs) };
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** The stored columns of one record, as written on create and on a changed listing. */
function entryFields(record: LibraryWorkflowRecord) {
  return {
    name: record.name,
    searchText: record.searchText,
    active: record.active,
    remoteCreatedAt: record.remoteCreatedAt ? new Date(record.remoteCreatedAt) : null,
    remoteUpdatedAt: record.remoteUpdatedAt ? new Date(record.remoteUpdatedAt) : null,
    versionId: record.versionId,
    tags: jsonOrDbNull(record.tags),
    nodeTypes: jsonOrDbNull(record.nodeTypes),
    nodeCount: record.nodeCount,
    fingerprint: record.fingerprint,
  };
}

/** Seen in this scan: present again, whatever earlier scans recorded. */
const seenIn = (scanId: string, now: Date) => ({
  lastSeenAt: now,
  lastSeenScanId: scanId,
  missedScans: 0,
  missingSince: null,
  removedAt: null,
});

type EntryRow = Prisma.AutomationLibraryEntryGetPayload<Record<string, never>>;

function toEntryRecord(row: EntryRow): LibraryEntryRecord {
  return {
    externalId: row.externalId,
    name: row.name,
    active: row.active,
    remoteCreatedAt: row.remoteCreatedAt?.toISOString() ?? null,
    remoteUpdatedAt: row.remoteUpdatedAt?.toISOString() ?? null,
    versionId: row.versionId,
    tags: stringArray(row.tags),
    nodeTypes: stringArray(row.nodeTypes),
    nodeCount: row.nodeCount,
    fingerprint: row.fingerprint,
    source: "rest",
    presence: libraryEntryPresence(row),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    contentChangedAt: row.contentChangedAt.toISOString(),
    missingSince: row.missingSince?.toISOString() ?? null,
    removedAt: row.removedAt?.toISOString() ?? null,
  };
}

export class PrismaAutomationLibraryRepository implements AutomationLibraryStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** The catalog's sync row, created on first use (concurrent creators converge). */
  private async syncIdFor(scope: LibraryScope): Promise<string> {
    await this.prisma.automationLibrarySync.createMany({ data: [scopeWhere(scope)], skipDuplicates: true });
    const row = await this.prisma.automationLibrarySync.findUnique({
      where: { tenantId_providerId_instanceKey: scopeWhere(scope) },
      select: { id: true },
    });
    if (!row) throw new Error("the library's sync row could not be created");
    return row.id;
  }

  async beginRun(input: LibraryBeginInput): Promise<LibraryBeginResult> {
    const syncId = await this.syncIdFor(input.scope);
    const { now } = input;
    const chainId = input.chainId ?? null;
    const staleBefore = new Date(now.getTime() - (input.chainStaleMs ?? LIBRARY_CHAIN_STALE_MS));
    return this.prisma.$transaction(async (tx) => {
      // The lease, in ONE conditional statement: free, or expired — and, in
      // the same statement, the catalog's chain. A chain's run begins only
      // while that chain still holds the catalog; a single run only while no
      // live chain does, and it releases a dead chain's hold as it begins.
      const taken = await tx.automationLibrarySync.updateMany({
        where: { id: syncId, AND: [leaseFree(now), chainId ? { activeChainId: chainId } : noLiveChain(staleBefore)] },
        data: {
          leaseOwner: input.runId,
          leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
          ...(chainId ? { chainHeartbeatAt: now } : { activeChainId: null, chainHeartbeatAt: null }),
        },
      });
      if (taken.count === 0) {
        if (chainId) {
          const row = await tx.automationLibrarySync.findUnique({ where: { id: syncId }, select: { activeChainId: true } });
          if (row?.activeChainId !== chainId) return { ok: false as const, reason: "CHAIN_LOST" as const };
        }
        return { ok: false as const, reason: "LEASE_HELD" as const };
      }

      if (chainId) {
        await tx.automationLibrarySyncChain.update({
          where: { id: chainId },
          data: { runsStarted: { increment: 1 }, heartbeatAt: now },
        });
      } else {
        // Any chain still RUNNING here lost its hold without finishing.
        await tx.automationLibrarySyncChain.updateMany({ where: { syncId, status: "RUNNING" }, data: INTERRUPTED_CHAIN(now) });
      }

      // Any run still RUNNING lost its lease without finishing: it is closed as
      // interrupted. Its stored pages stay, and its scan resumes below.
      const recovered = await tx.automationLibrarySyncRun.updateMany({
        where: { syncId, status: "RUNNING" },
        data: { status: "FAILED", failureCode: "INTERRUPTED" satisfies LibraryFailureCode, finishedAt: now },
      });

      let row = await tx.automationLibrarySync.findUniqueOrThrow({ where: { id: syncId } });
      const resumed = !input.restart && row.scanId !== null && row.scanPageSize !== null && row.scanStartedAt !== null;
      if (!resumed) {
        row = await tx.automationLibrarySync.update({
          where: { id: syncId },
          data: { ...CLOSED_SCAN, scanId: input.newScanId, scanPageSize: input.pageSize, scanStartedAt: now },
        });
      }
      const checkpoint = toCheckpoint(row);
      await tx.automationLibrarySyncRun.create({
        data: {
          id: input.runId,
          syncId,
          scanId: checkpoint.scanId,
          requestedById: input.requestedById,
          status: "RUNNING",
          resumed,
          startedAt: now,
          heartbeatAt: now,
          chainId,
        },
      });
      return { ok: true as const, resumed, checkpoint, recoveredRuns: recovered.count };
    });
  }

  async persistPage(input: LibraryPersistInput): Promise<LibraryPersistResult> {
    const { scope, now } = input;
    return this.prisma.$transaction(async (tx) => {
      // Fencing: renew the lease ONLY while this run still holds it, for this
      // scan. Otherwise nothing below runs, and nothing of the page is stored.
      const held = await tx.automationLibrarySync.updateMany({
        where: {
          ...scopeWhere(scope),
          leaseOwner: input.runId,
          leaseExpiresAt: { gt: now },
          scanId: input.scanId,
        },
        data: { leaseExpiresAt: new Date(now.getTime() + input.leaseMs) },
      });
      if (held.count === 0) return { ok: false as const, reason: "LEASE_LOST" as const };

      const counts = await this.storeRecords(tx, scope, input.scanId, input.records, now);
      const runCounters = {
        pagesFetched: { increment: 1 },
        recordsObserved: { increment: input.observed },
        recordsCreated: { increment: counts.created },
        recordsUpdated: { increment: counts.updated },
        recordsUnchanged: { increment: counts.unchanged },
        recordsRejected: { increment: input.rejected },
        heartbeatAt: now,
      };

      if (input.next === "END") {
        // The chain ran out with every page stored: the scan is complete. Only
        // now is anything reconciled, and the run completes in the same
        // transaction that closes the scan and releases the lease.
        const reconciled = await this.reconcile(tx, scope, input.scanId, now);
        const records = await tx.automationLibraryEntry.count({
          where: { ...scopeWhere(scope), lastSeenScanId: input.scanId },
        });
        await tx.automationLibrarySync.updateMany({
          where: { ...scopeWhere(scope), leaseOwner: input.runId },
          data: {
            ...CLOSED_SCAN,
            lastCompleteScanId: input.scanId,
            lastCompleteAt: now,
            lastCompleteRecords: records,
            leaseOwner: null,
            leaseExpiresAt: null,
            // A chain is alive while its run holds the lease; as the lease is
            // let go, its heartbeat takes over, with no gap between the two.
            chainHeartbeatAt: now,
          },
        });
        await tx.automationLibrarySyncRun.update({
          where: { id: input.runId },
          data: {
            ...runCounters,
            status: "COMPLETE",
            finishedAt: now,
            markedMissing: { increment: reconciled.markedMissing },
            markedRemoved: { increment: reconciled.markedRemoved },
          },
        });
        return { ok: true as const, checkpoint: null, ...counts, ...reconciled };
      }

      const advanced = await tx.automationLibrarySync.update({
        where: { tenantId_providerId_instanceKey: scopeWhere(scope) },
        data: {
          scanCursor: input.next.cursor,
          scanPages: { increment: 1 },
          scanRecords: { increment: input.observed },
          ...(input.requestedCursorHash ? { scanCursorTrail: { push: input.requestedCursorHash } } : {}),
        },
      });
      await tx.automationLibrarySyncRun.update({ where: { id: input.runId }, data: runCounters });
      return { ok: true as const, checkpoint: toCheckpoint(advanced), ...counts, markedMissing: 0, markedRemoved: 0 };
    }, PAGE_TRANSACTION);
  }

  /** Creates new entries, refreshes changed ones, and marks the rest as seen in this scan. */
  private async storeRecords(
    tx: Tx,
    scope: LibraryScope,
    scanId: string,
    records: readonly LibraryWorkflowRecord[],
    now: Date
  ): Promise<{ created: number; updated: number; unchanged: number }> {
    if (records.length === 0) return { created: 0, updated: 0, unchanged: 0 };
    const existing = await tx.automationLibraryEntry.findMany({
      where: { ...scopeWhere(scope), externalId: { in: records.map((r) => r.externalId) } },
      select: { externalId: true, fingerprint: true },
    });
    const known = new Map(existing.map((row) => [row.externalId, row.fingerprint]));
    const fresh = records.filter((r) => !known.has(r.externalId));
    const unchanged = records.filter((r) => known.get(r.externalId) === r.fingerprint);
    const changed = records.filter((r) => known.has(r.externalId) && known.get(r.externalId) !== r.fingerprint);

    if (fresh.length > 0) {
      // skipDuplicates: the unique key decides, so a row can never be stored twice.
      await tx.automationLibraryEntry.createMany({
        data: fresh.map((record) => ({
          ...scopeWhere(scope),
          externalId: record.externalId,
          ...entryFields(record),
          firstSeenAt: now,
          lastSeenAt: now,
          lastSeenScanId: scanId,
          contentChangedAt: now,
        })),
        skipDuplicates: true,
      });
    }
    if (unchanged.length > 0) {
      await tx.automationLibraryEntry.updateMany({
        where: { ...scopeWhere(scope), externalId: { in: unchanged.map((r) => r.externalId) } },
        data: seenIn(scanId, now),
      });
    }
    for (const record of changed) {
      await tx.automationLibraryEntry.update({
        where: { tenantId_providerId_instanceKey_externalId: { ...scopeWhere(scope), externalId: record.externalId } },
        data: { ...entryFields(record), ...seenIn(scanId, now), contentChangedAt: now },
      });
    }
    return { created: fresh.length, updated: changed.length, unchanged: unchanged.length };
  }

  /** After a COMPLETE scan only: what it did not see is missed once more; enough misses in a row, removed. */
  private async reconcile(
    tx: Tx,
    scope: LibraryScope,
    scanId: string,
    now: Date
  ): Promise<{ markedMissing: number; markedRemoved: number }> {
    const unseen = { ...scopeWhere(scope), removedAt: null, NOT: { lastSeenScanId: scanId } };
    await tx.automationLibraryEntry.updateMany({ where: { ...unseen, missingSince: null }, data: { missingSince: now } });
    const missed = await tx.automationLibraryEntry.updateMany({ where: unseen, data: { missedScans: { increment: 1 } } });
    const removed = await tx.automationLibraryEntry.updateMany({
      where: { ...unseen, missedScans: { gte: LIBRARY_MISSED_SCANS_BEFORE_REMOVED } },
      data: { removedAt: now },
    });
    return { markedMissing: missed.count - removed.count, markedRemoved: removed.count };
  }

  async finishRun(input: LibraryFinishInput): Promise<void> {
    const { scope, now } = input;
    await this.prisma.$transaction(async (tx) => {
      await tx.automationLibrarySyncRun.updateMany({
        where: { id: input.runId, status: "RUNNING" },
        data: { status: input.status, failureCode: input.failureCode, finishedAt: now },
      });
      // The lease is released — and the scan closed, when asked — only while
      // this run still holds it. A run that lost it changes nothing here.
      await tx.automationLibrarySync.updateMany({
        where: { ...scopeWhere(scope), leaseOwner: input.runId },
        data: { ...(input.resetScan ? CLOSED_SCAN : {}), leaseOwner: null, leaseExpiresAt: null, chainHeartbeatAt: now },
      });
    });
  }

  async readStatus(scope: LibraryScope, now: Date, chainStaleMs: number = LIBRARY_CHAIN_STALE_MS): Promise<LibraryStatusRecord> {
    const where = scopeWhere(scope);
    const [sync, present, missing, removed] = await Promise.all([
      this.prisma.automationLibrarySync.findUnique({ where: { tenantId_providerId_instanceKey: where } }),
      this.prisma.automationLibraryEntry.count({ where: { ...where, removedAt: null, missedScans: 0 } }),
      this.prisma.automationLibraryEntry.count({ where: { ...where, removedAt: null, missedScans: { gt: 0 } } }),
      this.prisma.automationLibraryEntry.count({ where: { ...where, removedAt: { not: null } } }),
    ]);
    const entries = { present, missing, removed };
    if (!sync) return { leaseHeld: false, scan: null, lastComplete: null, runs: [], entries, chain: null };

    const [runs, latestChain] = await Promise.all([
      this.prisma.automationLibrarySyncRun.findMany({
        where: { syncId: sync.id },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: 10,
      }),
      this.prisma.automationLibrarySyncChain.findFirst({
        where: { syncId: sync.id },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    ]);
    return {
      leaseHeld: sync.leaseOwner !== null && sync.leaseExpiresAt !== null && sync.leaseExpiresAt > now,
      scan:
        sync.scanId && sync.scanStartedAt
          ? { pagesFetched: sync.scanPages, recordsObserved: sync.scanRecords, startedAt: sync.scanStartedAt.toISOString() }
          : null,
      lastComplete:
        sync.lastCompleteAt && sync.lastCompleteRecords !== null
          ? { at: sync.lastCompleteAt.toISOString(), records: sync.lastCompleteRecords }
          : null,
      runs: runs.map(
        (run): LibraryRunRecord => ({
          runId: run.id,
          scanId: run.scanId,
          status: run.status as LibraryRunStatus,
          resumed: run.resumed,
          pagesFetched: run.pagesFetched,
          recordsObserved: run.recordsObserved,
          created: run.recordsCreated,
          updated: run.recordsUpdated,
          unchanged: run.recordsUnchanged,
          rejected: run.recordsRejected,
          markedMissing: run.markedMissing,
          markedRemoved: run.markedRemoved,
          failureCode: (run.failureCode as LibraryFailureCode | null) ?? null,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
        })
      ),
      entries,
      chain: latestChain ? chainState(latestChain, sync, now, chainStaleMs) : null,
    };
  }

  async findEntry(scope: LibraryScope, entryId: string): Promise<LibraryEntryRecord | null> {
    // The scope is part of the key: another Organization's or instance's entry is not found.
    const row = await this.prisma.automationLibraryEntry.findUnique({
      where: { tenantId_providerId_instanceKey_externalId: { ...scopeWhere(scope), externalId: entryId } },
    });
    return row ? toEntryRecord(row) : null;
  }

  async listEntries(scope: LibraryScope, query: LibraryEntryQuery): Promise<{ items: LibraryEntryRecord[]; total: number }> {
    const where: Prisma.AutomationLibraryEntryWhereInput = { ...scopeWhere(scope) };
    switch (query.presence ?? "current") {
      case "present":
        Object.assign(where, { removedAt: null, missedScans: 0 });
        break;
      case "missing":
        Object.assign(where, { removedAt: null, missedScans: { gt: 0 } });
        break;
      case "removed":
        Object.assign(where, { removedAt: { not: null } });
        break;
      case "all":
        break;
      default:
        Object.assign(where, { removedAt: null });
    }
    if (query.active !== undefined) where.active = query.active;
    const search = query.search ? normalizeLibrarySearch(query.search) : "";
    if (search.length > 0) where.searchText = { contains: search };

    const [rows, total] = await Promise.all([
      this.prisma.automationLibraryEntry.findMany({
        where,
        orderBy: [{ name: "asc" }, { externalId: "asc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.automationLibraryEntry.count({ where }),
    ]);
    return { total, items: rows.map(toEntryRecord) };
  }

  // -------------------------------------------------------------------------
  // Stage 18.2 — continue-until-complete chains
  // -------------------------------------------------------------------------

  async peekChain(
    scope: LibraryScope,
    input: { requestedById: string; idempotencyKey?: string; now: Date; staleMs: number }
  ): Promise<LibraryChainState | null> {
    const sync = await this.prisma.automationLibrarySync.findUnique({
      where: { tenantId_providerId_instanceKey: scopeWhere(scope) },
    });
    if (!sync) return null;
    if (input.idempotencyKey) {
      const same = await this.prisma.automationLibrarySyncChain.findFirst({
        where: { syncId: sync.id, requestedById: input.requestedById, idempotencyKey: input.idempotencyKey },
      });
      if (same) return chainState(same, sync, input.now, input.staleMs);
    }
    if (!sync.activeChainId || !chainAlive(sync, input.now, input.staleMs)) return null;
    const holder = await this.prisma.automationLibrarySyncChain.findUnique({ where: { id: sync.activeChainId } });
    return holder ? chainState(holder, sync, input.now, input.staleMs) : null;
  }

  async startChain(input: LibraryChainStartInput): Promise<LibraryChainStartResult> {
    const syncId = await this.syncIdFor(input.scope);
    const { now } = input;
    /** The chain this request's key already started, with whether it is alive now. */
    const sameKey = async (): Promise<LibraryChainState | null> => {
      if (!input.idempotencyKey) return null;
      const same = await this.prisma.automationLibrarySyncChain.findFirst({
        where: { syncId, requestedById: input.requestedById, idempotencyKey: input.idempotencyKey },
      });
      if (!same) return null;
      const sync = await this.prisma.automationLibrarySync.findUniqueOrThrow({ where: { id: syncId } });
      return chainState(same, sync, now, input.staleMs);
    };

    const replay = await sameKey();
    if (replay) return { ok: true, created: false, chain: replay };

    try {
      return await this.prisma.$transaction(async (tx) => {
        // The catalog, in ONE conditional statement: no run holds the lease
        // and no live chain holds the catalog.
        const taken = await tx.automationLibrarySync.updateMany({
          where: { id: syncId, AND: [leaseFree(now), noLiveChain(new Date(now.getTime() - input.staleMs))] },
          data: { activeChainId: input.chainId, chainHeartbeatAt: now },
        });
        if (taken.count === 0) {
          // A live chain holds it: that chain is the answer to this request
          // too. A single run holds it: refused.
          const sync = await tx.automationLibrarySync.findUniqueOrThrow({ where: { id: syncId } });
          if (sync.activeChainId && chainAlive(sync, now, input.staleMs)) {
            const holder = await tx.automationLibrarySyncChain.findUnique({ where: { id: sync.activeChainId } });
            if (holder) return { ok: true as const, created: false, chain: chainState(holder, sync, now, input.staleMs) };
          }
          return { ok: false as const, reason: "SYNC_RUNNING" as const };
        }

        // A chain that held the catalog and died is closed as it is replaced.
        await tx.automationLibrarySyncChain.updateMany({ where: { syncId, status: "RUNNING" }, data: INTERRUPTED_CHAIN(now) });
        const row = await tx.automationLibrarySyncChain.create({
          data: {
            id: input.chainId,
            syncId,
            requestedById: input.requestedById,
            idempotencyKey: input.idempotencyKey ?? null,
            status: "RUNNING",
            maxRuns: input.limits.maxRuns,
            maxPages: input.limits.maxPages,
            deadlineAt: new Date(now.getTime() + input.limits.maxMs),
            startedAt: now,
            heartbeatAt: now,
          },
        });
        return { ok: true as const, created: true, chain: { ...chainRecord(row), alive: true } };
      });
    } catch (error) {
      // Two requests with one key, the first already finished: the key decides.
      if (isUniqueViolation(error)) {
        const same = await sameKey();
        if (same) return { ok: true, created: false, chain: same };
      }
      throw error;
    }
  }

  async recordChainProgress(input: LibraryChainProgressInput): Promise<boolean> {
    const { now } = input;
    return this.prisma.$transaction(async (tx) => {
      const held = await tx.automationLibrarySync.updateMany({
        where: { ...scopeWhere(input.scope), activeChainId: input.chainId },
        data: { chainHeartbeatAt: now },
      });
      if (held.count === 0) return false;
      await tx.automationLibrarySyncChain.updateMany({
        where: { id: input.chainId, status: "RUNNING" },
        data: {
          heartbeatAt: now,
          ...(input.run
            ? { pagesFetched: { increment: input.run.pages }, recordsObserved: { increment: input.run.records } }
            : {}),
        },
      });
      return true;
    });
  }

  async finishChain(input: LibraryChainFinishInput): Promise<void> {
    const { now } = input;
    await this.prisma.$transaction(async (tx) => {
      await tx.automationLibrarySyncChain.updateMany({
        where: { id: input.chainId, status: "RUNNING" },
        data: { status: input.status, stopCode: input.stopCode, failureCode: input.failureCode, finishedAt: now, heartbeatAt: now },
      });
      // The catalog is let go only by the chain that holds it.
      await tx.automationLibrarySync.updateMany({
        where: { ...scopeWhere(input.scope), activeChainId: input.chainId },
        data: { activeChainId: null, chainHeartbeatAt: null },
      });
    });
  }
}
