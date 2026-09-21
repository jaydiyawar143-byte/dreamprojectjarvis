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
  RUNNING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
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
