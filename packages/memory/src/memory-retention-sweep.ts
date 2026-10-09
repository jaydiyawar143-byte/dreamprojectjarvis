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
// It is not a worker and holds no timer: something calls sweep().
// ---------------------------------------------------------------------------

import { MEMORY_RETENTION, memoryPurgeCutoff } from "@jarvis/core";

export interface MemoryRetentionSweepConfig {
  /** Users holding a memory that expired before `before`: ids only, at most `limit`. */
  candidates(before: Date, limit: number): Promise<string[]>;
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
  constructor(private readonly deps: MemoryRetentionSweepConfig) {}

  async sweep(): Promise<MemoryRetentionSweepResult> {
    const cutoff = memoryPurgeCutoff(this.deps.now ? this.deps.now() : new Date());
    const userIds = [...new Set(await this.deps.candidates(cutoff, MEMORY_RETENTION.sweepUsers))].slice(0, MEMORY_RETENTION.sweepUsers);

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
}
