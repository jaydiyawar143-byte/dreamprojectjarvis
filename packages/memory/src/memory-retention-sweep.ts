// ---------------------------------------------------------------------------
// Phase 14 — the memory retention sweep.
//
// One pass: find the users who hold a memory that expired more than the grace
// period ago, and ask for each of those users' expired memories to be purged.
//
// It deletes nothing itself and reads no memory. Both things it does are
// ports, given at the composition root:
//
//   candidates  user ids only — the one read that is not scoped to a user
//   purge       runs `memory.purge_expired` for ONE user through the tool
//               executor, which is what deletes
//
// BOUNDED. At most MEMORY_RETENTION.sweepUsers users per pass, and the purge
// deletes at most MEMORY_RETENTION.sweepBatch memories for each. Whatever is
// left is taken by a later pass. One user's failure never stops the others.
//
// PROGRESS (audit F3). A pass continues after the last user the previous pass
// visited, and starts over from the first once it reaches the end. Users whose
// purge keeps failing therefore cannot keep everyone after them waiting: every
// eligible user is visited within a bounded number of passes.
//
// It is not a worker and holds no timer: something calls sweep().
// ---------------------------------------------------------------------------

import { MEMORY_RETENTION, memoryPurgeCutoff } from "@jarvis/core";

export interface MemoryRetentionSweepConfig {
  /**
   * Users holding a memory that expired before `before`: ids only, at most
   * `limit`, in ascending id order, and only ids after `after` when given.
   */
  candidates(before: Date, limit: number, after?: string): Promise<string[]>;
  /** Purge one user's long-expired memories; resolves to how many were deleted. */
  purge(userId: string): Promise<number>;
  now?: () => Date;
}

export interface MemoryRetentionSweepResult {
  users: number;
  deleted: number;
  failed: number;
}

export class MemoryRetentionSweep {
  /** The last user of the previous pass, when that pass found a full page. */
  private after: string | undefined;

  constructor(private readonly deps: MemoryRetentionSweepConfig) {}

  async sweep(): Promise<MemoryRetentionSweepResult> {
    const cutoff = memoryPurgeCutoff(this.deps.now ? this.deps.now() : new Date());
    const limit = MEMORY_RETENTION.sweepUsers;
    let found = await this.page(cutoff, limit, this.after);
    // The previous pass ended on the last user: start over now, not next time.
    if (found.length === 0 && this.after !== undefined) found = await this.page(cutoff, limit, undefined);
    const userIds = [...new Set(found)].slice(0, limit);
    // A full page may have more after it; a short one means the next pass starts over.
    this.after = userIds.length === limit ? userIds[userIds.length - 1] : undefined;

    const result: MemoryRetentionSweepResult = { users: userIds.length, deleted: 0, failed: 0 };
    for (const userId of userIds) {
      try {
        result.deleted += await this.deps.purge(userId);
      } catch {
        result.failed++;
      }
    }
    return result;
  }

  private page(cutoff: Date, limit: number, after: string | undefined): Promise<string[]> {
    return after === undefined ? this.deps.candidates(cutoff, limit) : this.deps.candidates(cutoff, limit, after);
  }
}
