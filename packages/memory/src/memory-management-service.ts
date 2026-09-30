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
// ---------------------------------------------------------------------------

import type {
  AuditEntry,
  IMemoryStore,
  MemoryForgetScope,
  MemoryLearningControl,
  MemoryRecord,
  MemoryView,
} from "@jarvis/core";
import {
  JarvisError,
  MEMORY_FORGET_LIMIT,
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

export interface MemoryManagementServiceConfig {
  store: IMemoryStore;
  control: MemoryControlStore;
  audit: MemoryAuditPort;
}

export class MemoryManagementService {
  constructor(private readonly deps: MemoryManagementServiceConfig) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(
    userId: string,
    options: { includeExpired?: boolean; limit?: number; offset?: number } = {}
  ): Promise<{ memories: MemoryView[]; total: number; hasMore: boolean }> {
    const result = await this.deps.store.list({
      userId,
      includeExpired: options.includeExpired ?? false,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    });
    return { memories: result.memories.map(toMemoryView), total: result.total, hasMore: result.hasMore };
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
    return (await this.scan(userId)).filter((m) => m.sourceMessageId === messageId).map(toMemoryView);
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

  /**
   * A memory command that ended without a deletion — proposed, ambiguous,
   * nothing to act on. Kind, outcome and a count; never the words.
   */
  async recordCommand(userId: string, command: string, outcome: string, candidates: number): Promise<void> {
    await this.record(userId, "memory.command", outcome === "PROPOSED" ? "pending" : "rejected", { command, outcome, candidates });
  }

  // -------------------------------------------------------------------------

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
