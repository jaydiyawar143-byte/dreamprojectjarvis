// ---------------------------------------------------------------------------
// Phase 14 — memory correction: the contract's names.
//
// "That's wrong. I prefer light mode." used to offer only to FORGET the wrong
// memory. A correction replaces it — with the user's own words, and only with
// them:
//
//   - THE TARGET is a memory id the server resolved from what the user was
//     shown or what the last reply was built on. Never a similarity search,
//     never text.
//   - THE NEW VALUE is the statement the user wrote, verbatim. No model reads
//     it, rewrites it or proposes it.
//   - IT IS LEARNED LIKE ANY OTHER STATEMENT. The learning gate, the source
//     check against the saved USER message, and validation (S7.2 L1–L3) decide
//     whether it may be stored at all. A statement that would not be learned
//     on its own cannot be smuggled in as a correction.
//   - IT OVERWRITES, so it is confirmed like a deletion: a HIGH_IMPACT pending
//     action, run by the tool executor as `memory.correct`, bound to the
//     version of the memory the user was shown.
//
// The decision and the write both belong to MemoryExtractionService — the one
// memory writer and the one consumer of the L1–L4 contracts. This file holds
// only what the other layers need to name.
//
// Pure: no imports, no I/O, no clock, no randomness.
// ---------------------------------------------------------------------------

/** Runs through the tool executor only, for a confirmed pending action. On no agent's allowlist. */
export const MEMORY_CORRECT_TOOL_ID = "memory.correct";

/** The longest statement a correction may carry. */
export const MEMORY_CORRECTION_MAX_LENGTH = 500;

export type MemoryCorrectionStatus =
  /** The memory now holds the user's statement. */
  | "CORRECTED"
  /** No such memory of this user. */
  | "NOT_FOUND"
  /** The memory changed after the user was shown it. */
  | "STALE"
  /** The statement may not be stored as a memory (L1–L3). */
  | "NOT_LEARNABLE"
  /** Learning is paused, the source message is vetoed, or the controls cannot be read. */
  | "BLOCKED"
  /** The statement's source message could not be found for this user. */
  | "SOURCE_NOT_FOUND"
  /** This source message already corrected the memory: a retry or a replay. */
  | "ALREADY_APPLIED"
  /** Correction is not configured, or no embedding, evidence or write could be made. Nothing changed. */
  | "FAILED";

export interface MemoryCorrectionOutcome {
  status: MemoryCorrectionStatus;
}

/** What a correction is made of: the target, its version, and the saved USER message holding the new value. */
export interface MemoryCorrectionTarget {
  id: string;
  /** The memory's `changedAt` when the user was shown it. */
  version: string;
  /** The saved USER message the new value is quoted from. Never the value itself. */
  sourceMessageId: string;
}
