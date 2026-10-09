// ---------------------------------------------------------------------------
// S7.2 L5 — MemoryManagementService.
//
// The one place a user's memories are listed, forgotten, paused or vetoed —
// shared by the chat route's memory commands and the memory tools, the way
// TaskService is shared by the task routes and the task tools.
//
// It has no store of its own: it uses the existing IMemoryStore, and keeps the
// learning controls in the existing per-user settings table. It never learns:
// a new or corrected statement reaches memory only through L1 → L4.
//
//   - Every call is scoped to the user. A foreign id and an unknown id are the
//     same NOT_FOUND, so no answer reveals another user's memory.
//   - Deletion takes explicit ids, each bound to the version the user was
//     shown. A target that changed since is STALE and nothing is deleted.
//   - The audit trail holds ids and counts only — never content, never a
//     source message, conversation or trace id.
//
// Phase 14 adds, on the same store and under the same rules: the owner's
// detailed view for the memory screen and API, project scope on every read a
// conversation makes, the status of the controls, and the retention purge.
// It still never learns — a correction is written by MemoryExtractionService;
// this service only records that one happened.
// ---------------------------------------------------------------------------

import type {
  AuditEntry,
  IMemoryStore,
  MemoryCorrectionStatus,
  MemoryDetail,
  MemoryForgetScope,
  MemoryLearningControl,
  MemoryRecord,
  MemoryScopeFilter,
  MemoryView,
} from "@jarvis/core";
import {
  JarvisError,
  MEMORY_FORGET_LIMIT,
  MEMORY_RETENTION,
  isPurgeable,
  memoryPurgeCutoff,
  toMemoryDetail,
  parseMemoryLearningControl,
  serializeMemoryLearningControl,
  toMemoryView,
  withLearningPaused,
  withVetoedSource,
} from "@jarvis/core";

/** One small JSON document per user, in the existing settings table. */
export interface MemoryControlStore {
  get(userId: string): Promise<Record<string, unknown> | null>;
  put(userId: string, value: Record<string, unknown>): Promise<void>;
}

export interface MemoryAuditPort {
  log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void>;
}

/** A memory the user chose, bound to the version (`changedAt`) they were shown. */
export interface MemoryTarget {
  id: string;
  version: string;
}

export type MemoryForgetOutcome =
  | { status: "FORGOTTEN"; deleted: number; notFound: number }
  | { status: "STALE"; deleted: 0; stale: number }
  | { status: "NOT_FOUND"; deleted: 0 }
  | { status: "NOTHING_TO_FORGET"; deleted: 0 };

export type MemoryForgetAllOutcome = { status: "FORGOTTEN"; deleted: number } | { status: "NOTHING_TO_FORGET"; deleted: 0 };

export { MEMORY_FORGET_LIMIT };

// ponytail: lookups by source message and legacy scans read the user's newest
// 1000 memories; add an indexed query if a user ever holds more.
const SCAN_LIMIT = 1000;

/** The most memories one page of the owner's list may hold. */
export const MEMORY_PAGE_LIMIT = 50;

export interface MemoryListOptions {
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
  /** Phase 14 — project scope. Absent: every memory the user owns. */
  scope?: MemoryScopeFilter;
  /** Phase 14 — only memories whose content contains this text. */
  search?: string;
}

/** Phase 14 — what the memory screen shows above the list. */
export interface MemoryStatus {
  learningPaused: boolean;
  /** Messages the user said not to learn from. */
  vetoedSources: number;
  /** Memories in use: not expired. */
  active: number;
  /** Expired, hidden, and waiting for the retention sweep. */
  expired: number;
  retention: { days: number; purgeGraceDays: number };
}

export interface MemoryManagementServiceConfig {
  store: IMemoryStore;
  control: MemoryControlStore;
  audit: MemoryAuditPort;
  /** The clock, for expiry and retention. Defaults to the system clock. */
  now?: () => Date;
}

export class MemoryManagementService {
  constructor(private readonly deps: MemoryManagementServiceConfig) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(
    userId: string,
    options: MemoryListOptions = {}
  ): Promise<{ memories: MemoryView[]; total: number; hasMore: boolean }> {
    const result = await this.page(userId, options);
    return { memories: result.memories.map(toMemoryView), total: result.total, hasMore: result.hasMore };
  }

  /**
   * Phase 14 — the same page as list(), as the owner manages it: with
   * confidence, project and a provenance summary. `projectNames` (id → name,
   * of this user's own projects) only labels; it never widens what is read.
   */
  async details(
    userId: string,
    options: MemoryListOptions = {},
    projectNames?: ReadonlyMap<string, string>
  ): Promise<{ memories: MemoryDetail[]; total: number; hasMore: boolean }> {
    const result = await this.page(userId, options);
    const now = this.now();
    return { memories: result.memories.map((m) => toMemoryDetail(m, now, projectNames)), total: result.total, hasMore: result.hasMore };
  }

  /** Phase 14 — one of the user's own memories, or null. A foreign id is null too. */
  async detail(userId: string, memoryId: string, projectNames?: ReadonlyMap<string, string>): Promise<MemoryDetail | null> {
    const record = await this.deps.store.getById(userId, memoryId);
    return record ? toMemoryDetail(record, this.now(), projectNames) : null;
  }

  /** Phase 14 — the state of the user's controls and how much is stored. */
  async status(userId: string): Promise<MemoryStatus> {
    const [control, active, all] = await Promise.all([
      this.learningControl(userId),
      this.deps.store.list({ userId, includeExpired: false, limit: 1 }),
      this.deps.store.list({ userId, includeExpired: true, limit: 1 }),
    ]);
    return {
      learningPaused: control.learningPaused,
      vetoedSources: control.vetoedSourceMessageIds.length,
      active: active.total,
      expired: Math.max(0, all.total - active.total),
      retention: { days: MEMORY_RETENTION.defaultDays, purgeGraceDays: MEMORY_RETENTION.purgeGraceDays },
    };
  }

  /** The user's own memories among `ids`, in that order. Anything else is simply absent. */
  async views(userId: string, ids: readonly string[]): Promise<MemoryView[]> {
    const views: MemoryView[] = [];
    for (const id of new Set(ids)) {
      const record = await this.deps.store.getById(userId, id);
      if (record) views.push(toMemoryView(record));
    }
    return views;
  }

  /** What one of the user's own messages taught (L2 provenance). */
  async fromSourceMessage(userId: string, messageId: string): Promise<MemoryView[]> {
    // Phase 14 — asked of the store by source message, instead of reading the
    // user's newest 1000 memories to find a handful. The filter below stays:
    // a store that ignored the request must still never return another
    // message's memories.
    const result = await this.deps.store.list({ userId, includeExpired: true, limit: SCAN_LIMIT, sourceMessageId: messageId });
    return result.memories.filter((m) => m.sourceMessageId === messageId).map(toMemoryView);
  }

  /** How many memories a forget-all of `scope` would remove — expired ones included. */
  async count(userId: string, scope: MemoryForgetScope): Promise<number> {
    if (scope === "ALL") return (await this.deps.store.list({ userId, includeExpired: true, limit: 1 })).total;
    return (await this.legacyIds(userId)).length;
  }

  // -------------------------------------------------------------------------
  // Forgetting — reached only through a confirmed pending action (memory tools)
  // -------------------------------------------------------------------------

  async forget(userId: string, targets: readonly MemoryTarget[]): Promise<MemoryForgetOutcome> {
    const unique = [...new Map(targets.map((t) => [t.id, t])).values()];
    if (unique.length === 0) return { status: "NOTHING_TO_FORGET", deleted: 0 };
    if (unique.length > MEMORY_FORGET_LIMIT) {
      throw new JarvisError("INVALID_REQUEST", `At most ${MEMORY_FORGET_LIMIT} memories can be forgotten at once`);
    }

    const current: string[] = [];
    let notFound = 0;
    let stale = 0;
    for (const target of unique) {
      const record = await this.deps.store.getById(userId, target.id);
      if (!record) notFound++;
      else if (record.updatedAt.toISOString() !== target.version) stale++;
      else current.push(record.id);
    }

    // ponytail: a memory changed between this check and the delete below (a
    // few ms) is still deleted; a conditional delete on updatedAt closes it.
    if (stale > 0) {
      await this.record(userId, "memory.forget", "rejected", { memoryIds: [], requested: unique.length, deleted: 0, notFound, stale });
      return { status: "STALE", deleted: 0, stale };
    }
    if (current.length === 0) {
      await this.record(userId, "memory.forget", "rejected", { memoryIds: [], requested: unique.length, deleted: 0, notFound, stale });
      return { status: "NOT_FOUND", deleted: 0 };
    }

    const deleted = await this.deps.store.delete({ userId, memoryIds: current });
    await this.record(userId, "memory.forget", "success", { memoryIds: current, requested: unique.length, deleted, notFound, stale });
    return { status: "FORGOTTEN", deleted, notFound };
  }

  async forgetAll(userId: string, scope: MemoryForgetScope): Promise<MemoryForgetAllOutcome> {
    let deleted: number;
    if (scope === "ALL") {
      deleted = await this.deps.store.deleteAll(userId);
    } else {
      const ids = await this.legacyIds(userId);
      deleted = ids.length === 0 ? 0 : await this.deps.store.delete({ userId, memoryIds: ids });
    }
    if (deleted === 0) return { status: "NOTHING_TO_FORGET", deleted: 0 };
    await this.record(userId, "memory.forget_all", "success", { scope, deleted });
    return { status: "FORGOTTEN", deleted };
  }

  // -------------------------------------------------------------------------
  // Learning controls
  // -------------------------------------------------------------------------

  /** The user's controls, read fail-closed. Throws when the store cannot be read. */
  async learningControl(userId: string): Promise<MemoryLearningControl> {
    return parseMemoryLearningControl(await this.deps.control.get(userId));
  }

  async pauseLearning(userId: string): Promise<void> {
    await this.saveControl(userId, withLearningPaused(await this.learningControl(userId), true));
    await this.record(userId, "memory.learning_pause", "success", {});
  }

  async resumeLearning(userId: string): Promise<void> {
    await this.saveControl(userId, withLearningPaused(await this.learningControl(userId), false));
    await this.record(userId, "memory.learning_resume", "success", {});
  }

  /** Nothing from `messageId` may be learned from now on. The id is not audited. */
  async vetoSource(userId: string, messageId: string): Promise<void> {
    await this.saveControl(userId, withVetoedSource(await this.learningControl(userId), messageId));
    await this.record(userId, "memory.veto", "success", {});
  }

  // -------------------------------------------------------------------------
  // Phase 14 — retention and correction records
  // -------------------------------------------------------------------------

  /**
   * Deletes this user's memories that expired more than the grace period ago
   * — at most MEMORY_RETENTION.sweepBatch of them. Reached only through the
   * `memory.purge_expired` tool, for the retention sweep.
   *
   * Nothing here can delete a memory that is still in use: the store is asked
   * for rows expired before the cutoff, and every row it returns is checked
   * against the cutoff AGAIN before its id is deleted — so a store that
   * ignored the filter deletes nothing it should not. Deletion is by id, for
   * this user only.
   */
  async purgeExpired(userId: string): Promise<number> {
    const cutoff = memoryPurgeCutoff(this.now());
    const result = await this.deps.store.list({
      userId,
      includeExpired: true,
      expiredBefore: cutoff,
      limit: MEMORY_RETENTION.sweepBatch,
    });
    const ids = result.memories.filter((m) => m.userId === userId && isPurgeable(m.expiresAt, cutoff)).map((m) => m.id);
    if (ids.length === 0) return 0;
    const deleted = await this.deps.store.delete({ userId, memoryIds: ids });
    await this.record(userId, "memory.retention_purge", "success", { deleted });
    return deleted;
  }

  /** A correction's outcome: the memory's id and the status. Never the old or the new words. */
  async recordCorrection(userId: string, memoryId: string, status: MemoryCorrectionStatus): Promise<void> {
    await this.record(userId, "memory.correct", status === "CORRECTED" ? "success" : "rejected", { memoryIds: [memoryId], status });
  }

  /**
   * A memory command that ended without a deletion — proposed, ambiguous,
   * nothing to act on. Kind, outcome and a count; never the words.
   */
  async recordCommand(userId: string, command: string, outcome: string, candidates: number): Promise<void> {
    await this.record(userId, "memory.command", outcome === "PROPOSED" ? "pending" : "rejected", { command, outcome, candidates });
  }

  // -------------------------------------------------------------------------

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private page(userId: string, options: MemoryListOptions) {
    return this.deps.store.list({
      userId,
      includeExpired: options.includeExpired ?? false,
      limit: Math.max(1, Math.min(options.limit ?? 20, MEMORY_PAGE_LIMIT)),
      offset: Math.max(0, options.offset ?? 0),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.search ? { search: options.search } : {}),
    });
  }

  private async scan(userId: string): Promise<MemoryRecord[]> {
    return (await this.deps.store.list({ userId, includeExpired: true, limit: SCAN_LIMIT })).memories;
  }

  private async legacyIds(userId: string): Promise<string[]> {
    return (await this.scan(userId)).filter((m) => toMemoryView(m).legacy).map((m) => m.id);
  }

  private async saveControl(userId: string, control: MemoryLearningControl): Promise<void> {
    await this.deps.control.put(userId, serializeMemoryLearningControl(control));
  }

  /** Best effort, like the other deletion routes: an audit outage never undoes the user's request. */
  private async record(userId: string, action: string, result: AuditEntry["result"], metadata: Record<string, unknown>): Promise<void> {
    await this.deps.audit.log({ userId, action, result, metadata }).catch(() => undefined);
  }
}
