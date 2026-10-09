// ---------------------------------------------------------------------------
// Phase 14 — the memory retention policy, in one place.
//
//   LEARNED MEMORIES EXPIRE   `defaultDays` after the user last stated them.
//                             Stating it again, a revision or a correction
//                             starts the period over (L4 `refreshExpiry`).
//   EXPIRED MEANS HIDDEN      at once: never recalled, never deduplicated
//                             against, not in the default list.
//   EXPIRED ROWS ARE PURGED   `purgeGraceDays` after they expired, by the
//                             retention sweep — hard-deleted, like a forget.
//   WHAT NEVER EXPIRES        a memory with no expiry date. Those are rows
//                             from before expiry existed; they stay until the
//                             user forgets them.
//   THE USER'S CONTROLS       pausing learning does not change any expiry;
//                             forgetting deletes at once, whatever the expiry.
//
// The sweep is bounded twice over: at most `sweepUsers` users per run, and at
// most `sweepBatch` memories per user per run. It deletes one user's rows at a
// time, by id, through ToolExecutor (`memory.purge_expired`).
//
// Pure constants and arithmetic; no I/O, no clock.
// ---------------------------------------------------------------------------

export const MEMORY_RETENTION = Object.freeze({
  /** Days a learned memory lives after the user last stated it. */
  defaultDays: 90,
  /** Days an expired memory is kept, hidden, before the sweep deletes it. */
  purgeGraceDays: 30,
  /** The most memories one sweep deletes for one user. */
  sweepBatch: 200,
  /** The most users one sweep visits. */
  sweepUsers: 50,
} as const);

/**
 * Runs through ToolExecutor only, for the retention sweep. On no agent's
 * allowlist; takes no parameters, so nothing can widen what it deletes.
 */
export const MEMORY_PURGE_TOOL_ID = "memory.purge_expired";

const DAY_MS = 86_400_000;

/** A memory that expired before this instant may be purged. */
export function memoryPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - MEMORY_RETENTION.purgeGraceDays * DAY_MS);
}

/** True only for a memory whose expiry is set and lies before the cutoff. */
export function isPurgeable(expiresAt: Date | undefined, cutoff: Date): boolean {
  return expiresAt instanceof Date && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() < cutoff.getTime();
}
