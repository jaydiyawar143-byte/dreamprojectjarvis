// ---------------------------------------------------------------------------
// Core V1 — the task lifecycle.
//
// A task is the first durable thing JARVIS owns that is not a message, a tool
// call or an approval: a piece of work the user asked it to keep hold of.
//
// This file is the ONLY definition of which transitions are legal. The
// repository writes what it is told and the route translates HTTP; neither
// decides. Putting the rule in core (no I/O, pure) means the API, the tool and
// any future executor all enforce the same lifecycle instead of three
// implementations drifting apart.
//
// NOT in this slice, deliberately: scheduling, retries, resumption, skills.
// A PENDING task is a record of intent — nothing runs it yet, and nothing here
// should imply otherwise.
// ---------------------------------------------------------------------------

import { z } from "zod";

export const TaskStatusSchema = z.enum([
  /** Recorded, not started. The only state a new task may be created in. */
  "PENDING",
  /** Work has begun. Set by whoever starts it; nothing does so automatically. */
  "RUNNING",
  /** Finished successfully. Terminal. */
  "COMPLETED",
  /** Finished unsuccessfully, with a reason. Terminal. */
  "FAILED",
  /**
   * V2.3 - the execution was entered and its outcome CANNOT BE DETERMINED.
   * Terminal, and deliberately NOT a synonym for FAILED.
   *
   * A task reaches this only from RUNNING, which means `executeTask` had
   * already committed PENDING -> RUNNING and called the executor. If the
   * process then died before any evidence was written, the tool may have
   * reached an external system and completed there - a campaign paused, an
   * email sent - or it may never have got that far. Nothing durable says
   * which.
   *
   * FAILED would assert that the work did not happen. That assertion may be
   * FALSE, and acting on it is how a user redoes a write that already landed.
   * UNRESOLVED asserts only what is true: it started, and we cannot say more.
   *
   * It is terminal for the automatic engine. Nothing retries it.
   */
  "UNRESOLVED",
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * The `createdBy` value that marks a row as JARVIS WORK rather than a
 * hand-written todo.
 *
 * `Task.createdBy` already meant "which agent or flow created it, null when
 * manual" — this only names the value the Core V1 flow writes, so the todo
 * surfaces can exclude it and the work surface can select it. One table, one
 * existing column, no new discriminator.
 *
 * BOTH Core V1 entry points stamp it: the `task.create` tool and
 * `POST /api/v1/tasks`. A row created through either is work, regardless of
 * whether a human or the model asked for it — the dashboard CRUD under
 * /command-center/tasks is what creates todos, and it still writes null.
 */
export const JARVIS_TASK_CREATOR = "jarvis";

/**
 * The legal moves, as data rather than as a chain of ifs.
 *
 * COMPLETED and FAILED are terminal and map to an EMPTY list. That is the
 * decision this slice makes explicitly: there is no retry model in this
 * repository to reuse — `ToolExecution` has one, but it governs provider calls
 * with leases and idempotency keys, not user-owned work — so inventing
 * FAILED -> RUNNING here would be designing a retry semantics on a guess.
 * Re-running a failed task is a Phase-2 decision, and until it is taken a
 * terminal task stays terminal.
 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  PENDING: ["RUNNING"],
  // V2.3 - a run that was entered ends in exactly one of three ways: it
  // worked, it demonstrably did not, or nobody can say. The third is a real
  // outcome, not a failure to categorise, and it needs its own edge.
  RUNNING: ["COMPLETED", "FAILED", "UNRESOLVED"],
  COMPLETED: [],
  FAILED: [],
  // Terminal, and terminal on purpose. Resolving an ambiguous external side
  // effect needs evidence this system does not have; re-running it could
  // duplicate a write that already succeeded. A human, or a later
  // reconciliation with real evidence, resolves these - not a retry.
  UNRESOLVED: [],
});

/**
 * Whether `from -> to` is a move the lifecycle allows.
 *
 * Task-scoped name because `canTransition` is already exported by the
 * recommendation lifecycle in this same package; two exported names differing
 * only by argument type would be a trap for the next reader.
 */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The states reachable from `from`. Empty for a terminal state. */
export function allowedTaskTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from];
}

/**
 * A refusal sentence a user can act on.
 *
 * Written here rather than at the route so the HTTP error, the tool result and
 * any future executor all say the same thing about the same refusal.
 */
export function describeInvalidTaskTransition(from: TaskStatus, to: TaskStatus): string {
  const allowed = TRANSITIONS[from];
  if (allowed.length === 0) {
    return `This task is already ${from.toLowerCase()} and cannot be changed.`;
  }
  return `A ${from.toLowerCase()} task cannot become ${to.toLowerCase()}; it can only become ${allowed
    .map((s) => s.toLowerCase())
    .join(" or ")}.`;
}
