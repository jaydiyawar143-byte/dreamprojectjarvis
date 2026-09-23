// ---------------------------------------------------------------------------
// V3 — tasks and reminders.
//
// Every method takes `userId` as its FIRST argument and filters on it, without
// exception. That is the tenant boundary: there is no method here that can
// return or mutate another user's task, so a route cannot leak one by
// forgetting a filter. `updateOwned` and `deleteOwned` use updateMany/deleteMany
// with the userId in the WHERE clause rather than a findUnique-then-write, which
// makes ownership part of the same atomic statement instead of a check that
// could race.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";
import type { TaskStatus } from "@jarvis/core";

export type TaskPriority = "LOW" | "NORMAL" | "HIGH";

export interface TaskRecord {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  dueAt: Date | null;
  priority: string;
  /** Core V1 lifecycle state. Legal moves live in @jarvis/core, not here. */
  status: TaskStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Why a run failed. Null unless status is FAILED. */
  error: string | null;
  /**
   * Scheduler V1 — when this work task becomes eligible for execution.
   * Null means "not scheduled", and is also what a consumed schedule leaves.
   */
  scheduledAt: Date | null;
  /**
   * Task Engine V2.1 - when the scheduler took ownership of this schedule.
   * Null means unclaimed. Set by `claimSchedule`, and never cleared in V2.1.
   */
  claimedAt: Date | null;
  /**
   * Task Engine V2.1 - the execution this task performed, correlating it with
   * its `AuditLog` row. Null until the task runs.
   */
  executionId: string | null;
  remindedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  dueAt?: Date | null;
  priority?: TaskPriority;
  /** Which agent created it, when it did not come from the UI. */
  createdBy?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  dueAt?: Date | null;
  priority?: TaskPriority;
  /** true completes, false reopens. Omitted leaves completion untouched. */
  completed?: boolean;
}

/**
 * "Created by anyone except `creator`" — INCLUDING rows where `createdBy` is
 * NULL, which is every task the dashboard itself made.
 *
 * THIS IS NOT THE OBVIOUS SPELLING, AND THE OBVIOUS SPELLING IS WRONG.
 * `NOT: { createdBy: "jarvis" }` renders as `NOT created_by = 'jarvis'` and
 * `createdBy: { not: "jarvis" }` renders as `created_by <> 'jarvis'`. In SQL's
 * three-valued logic both evaluate to NULL — not true — for a row whose
 * `created_by` IS NULL, so both silently DROP every ordinary todo. Verified
 * against Postgres:
 *
 *   rows (1, NULL) (2, 'jarvis') (3, 'other')
 *   WHERE NOT created_by = 'jarvis'                 -> {3}
 *   WHERE created_by <> 'jarvis'                    -> {3}
 *   WHERE created_by IS NULL OR created_by <> '…'   -> {1, 3}   <- correct
 *
 * `POST /command-center/tasks` never sets `createdBy`, so NULL is the normal
 * case for a todo, not an edge case. Written once, here, so the three call
 * sites cannot each rediscover it.
 */
function createdByIsNot(creator: string) {
  return { OR: [{ createdBy: null }, { createdBy: { not: creator } }] };
}

export class PrismaTaskRepository {
  constructor(private prisma: PrismaClient) {}

  async create(userId: string, input: CreateTaskInput): Promise<TaskRecord> {
    return this.prisma.task.create({
      data: {
        userId,
        title: input.title,
        description: input.description ?? null,
        dueAt: input.dueAt ?? null,
        priority: input.priority ?? "NORMAL",
        createdBy: input.createdBy ?? null,
      },
    }) as unknown as Promise<TaskRecord>;
  }

  /**
   * A user's tasks.
   *
   * Ordered so the dashboard can render without re-sorting: undated tasks last
   * (Postgres sorts NULLs first on ASC by default, which would put "someday"
   * items above things due in ten minutes).
   */
  async list(
    userId: string,
    options: {
      includeCompleted?: boolean;
      limit?: number;
      /**
       * Core V1.1 — select by creator.
       *
       * `createdBy` is the existing column that already meant "which agent or
       * flow created it". These two options make the todo and work surfaces
       * read disjoint sets of the same table:
       *
       *   excludeCreatedBy: "jarvis"  the dashboard and `tasks.list` — todos
       *   createdBy:        "jarvis"  Core V1 `task.list` — work
       *
       * Neither weakens the userId filter: both are ANDed with it, so a
       * creator filter can never widen a query past its owner.
       */
      createdBy?: string;
      excludeCreatedBy?: string;
    } = {}
  ): Promise<TaskRecord[]> {
    return this.prisma.task.findMany({
      where: {
        userId,
        ...(options.includeCompleted ? {} : { completedAt: null }),
        ...(options.createdBy !== undefined ? { createdBy: options.createdBy } : {}),
        ...(options.excludeCreatedBy !== undefined
          ? createdByIsNot(options.excludeCreatedBy)
          : {}),
      },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: Math.min(options.limit ?? 50, 200),
    }) as unknown as Promise<TaskRecord[]>;
  }

  /**
   * Updates a task the caller owns.
   *
   * Returns null when nothing matched, which covers both "no such task" and
   * "not yours" — deliberately indistinguishable, so this cannot be used to
   * probe for the existence of another user's task.
   */
  async updateOwned(
    userId: string,
    taskId: string,
    input: UpdateTaskInput,
    options: { excludeCreatedBy?: string } = {}
  ): Promise<TaskRecord | null> {
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.dueAt !== undefined) data.dueAt = input.dueAt;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.completed !== undefined) {
      // Idempotent: completing an already-complete task keeps the original
      // timestamp rather than moving it.
      data.completedAt = input.completed ? new Date() : null;
      // Core V1 — the OTHER half of the two-way sync. This is the todo-shaped
      // path (the Tasks widget's checkbox); `transitionOwned` below is the
      // lifecycle-shaped one. Both write both fields, so `status` and
      // `completedAt` cannot drift apart no matter which surface is used.
      // Reopening returns a task to PENDING rather than RUNNING: unchecking a
      // box is not a statement that work has restarted.
      data.status = input.completed ? "COMPLETED" : "PENDING";
      if (!input.completed) data.error = null;
    }

    if (Object.keys(data).length === 0) {
      // An empty PATCH is a read, and it has to refuse the same things the
      // write does — otherwise `PATCH {}` becomes a way to read a JARVIS work
      // task from a surface that is not allowed to list it.
      const current = await this.findOwned(userId, taskId);
      if (!current) return null;
      if (options.excludeCreatedBy !== undefined && current.createdBy === options.excludeCreatedBy) {
        return null;
      }
      return current;
    }

    const result = await this.prisma.task.updateMany({
      where: {
        id: taskId,
        userId,
        // Core V1.1 — a checkbox may not move work that is RUNNING.
        //
        // This path is the dashboard's todo checkbox, which knows nothing
        // about the lifecycle. BOTH directions are blocked while a task is
        // running, because both are lifecycle moves the rules forbid:
        //
        //   ticking it   RUNNING -> COMPLETED, skipping the transition
        //                rules and stamping a completion over work in flight
        //   unticking it RUNNING -> PENDING, resetting a task that is
        //                actually running to "not started"
        //
        // So the guard keys on `completed` being PRESENT at all, not on its
        // value. Edits that are not lifecycle moves — a rename, a new
        // description, a due date — carry no `completed` field and stay
        // allowed on a running task.
        //
        // The guard lives in the WHERE clause, not in a read-then-write: a
        // task that starts running between the check and the update still
        // matches zero rows, so the race cannot land the write either. Zero
        // rows returns null, which the route already renders as 404 — the
        // same answer it gives for "no such task", and deliberately
        // indistinguishable from it.
        ...(input.completed !== undefined ? { NOT: { status: "RUNNING" } } : {}),
        // Core V1.1 — the todo surface may not edit a JARVIS work task.
        //
        // This matters more than a tidy boundary: Scheduler V1 re-plans from
        // the task's title AT EXECUTION TIME. A rename through the dashboard
        // checkbox UI would therefore change what a scheduled task actually
        // does, silently, between the moment it was agreed and the moment it
        // runs. The title a schedule was accepted against has to be the title
        // it runs against.
        //
        // In the WHERE clause, like the RUNNING guard above, so a task that
        // becomes JARVIS work between a check and a write still matches zero
        // rows. Zero rows returns null, which the route renders as 404 — the
        // same answer "no such task" gets.
        ...(options.excludeCreatedBy !== undefined
          ? createdByIsNot(options.excludeCreatedBy)
          : {}),
      },
      data,
    });
    if (result.count === 0) return null;

    return this.findOwned(userId, taskId);
  }

  /**
   * Core V1 — move a task the caller owns from one lifecycle state to another.
   *
   * `expectedFrom` is part of the WHERE clause, not a check the caller makes
   * first: two confirmations arriving together cannot both move PENDING ->
   * RUNNING, because the second matches zero rows. That is the same
   * compare-and-set shape `updateOwned` already uses for ownership, applied to
   * state, and it is why this returns a discriminated result rather than
   * throwing — "someone else got there first" is an ordinary outcome.
   *
   * The caller is expected to have validated the move with `canTransition`;
   * this guards the write so a race cannot land an illegal one anyway.
   */
  async transitionOwned(
    userId: string,
    taskId: string,
    expectedFrom: TaskStatus,
    to: TaskStatus,
    options: { error?: string | null; executionId?: string } = {}
  ): Promise<
    | { ok: true; task: TaskRecord }
    | { ok: false; reason: "not_found" | "state_changed"; current: TaskStatus | null }
  > {
    const data: Record<string, unknown> = { status: to };

    // V2.1 - the execution link, written in the SAME statement as the status
    // change rather than in a second write. A task that is RUNNING therefore
    // always carries the id of the execution that is running it, with no
    // window in between where the two disagree.
    if (options.executionId !== undefined) data.executionId = options.executionId;

    // The timestamps are derived from the target state, never supplied, so a
    // RUNNING task always has a startedAt and a COMPLETED one always has a
    // completedAt — the fields the existing todo surfaces read.
    if (to === "RUNNING") data.startedAt = new Date();
    if (to === "COMPLETED") {
      data.completedAt = new Date();
      data.error = null;
    }
    if (to === "FAILED") {
      // Deliberately NOT completedAt: a failed task is finished, but it is not
      // done, and the Tasks widget reads completedAt as "done". Leaving it null
      // keeps a failure visible as outstanding work instead of silently
      // checking it off.
      data.error = options.error ?? null;
    }
    if (to === "UNRESOLVED") {
      // V2.3 - same shape as FAILED and for the same reason: finished, not
      // done, so `completedAt` stays null and the task remains visible as
      // outstanding. `error` carries WHY the outcome could not be
      // established - it is the reason for the terminal state, not a claim
      // that the work failed.
      data.error = options.error ?? null;
    }

    const result = await this.prisma.task.updateMany({
      where: { id: taskId, userId, status: expectedFrom },
      data,
    });

    if (result.count === 0) {
      const current = await this.findOwned(userId, taskId);
      if (!current) return { ok: false, reason: "not_found", current: null };
      return { ok: false, reason: "state_changed", current: current.status };
    }

    const task = await this.findOwned(userId, taskId);
    if (!task) return { ok: false, reason: "not_found", current: null };
    return { ok: true, task };
  }

  // -------------------------------------------------------------------------
  // Scheduler V1
  // -------------------------------------------------------------------------

  /**
   * Set or clear a work task's one-time schedule.
   *
   * The WHERE clause carries every eligibility rule, so they hold atomically
   * rather than being checked and then trusted:
   *
   *   userId           the caller owns it
   *   createdBy        it is JARVIS WORK, never a dashboard todo
   *   status PENDING   terminal and running tasks cannot be scheduled
   *
   * Returns null when nothing matched — "no such task", "not yours", "that is
   * a todo" and "it is already running" are deliberately one answer, the same
   * way `updateOwned` treats ownership.
   */
  async setScheduleOwned(
    userId: string,
    taskId: string,
    createdBy: string,
    scheduledAt: Date | null
  ): Promise<TaskRecord | null> {
    const result = await this.prisma.task.updateMany({
      where: { id: taskId, userId, createdBy, status: "PENDING" },
      data: { scheduledAt },
    });
    if (result.count === 0) return null;
    return this.findOwned(userId, taskId);
  }

  /**
   * Work that is due to run.
   *
   * Candidate discovery only — every row returned must still be claimed with
   * `claimSchedule` before anything runs, because between this read and that
   * write another process may have taken it.
   */
  async findDueScheduled(
    createdBy: string,
    now: Date,
    limit = 20
  ): Promise<TaskRecord[]> {
    return this.prisma.task.findMany({
      where: {
        createdBy,
        status: "PENDING",
        scheduledAt: { not: null, lte: now },
        // V2.1 - a claimed schedule is nobody else's to discover. Before, the
        // claim removed `scheduledAt` and the row fell out of this query by
        // disappearing; now it stays, so the claim is filtered explicitly.
        claimedAt: null,
      },
      orderBy: { scheduledAt: "asc" },
      take: Math.min(limit, 100),
    }) as unknown as Promise<TaskRecord[]>;
  }

  /**
   * Take ownership of one due schedule. THE race-safe step.
   *
   * V2.1 - THE CLAIM IS NOW DURABLE. Setting `claimedAt` is the claim, and
   * `scheduledAt` is left INTACT.
   *
   * Before, clearing `scheduledAt` was the claim. That worked for exclusion
   * but destroyed evidence: a crash between this statement and the start of
   * execution left the task PENDING with no schedule, which is exactly what a
   * task that was never scheduled looks like. The work was lost in silence.
   *
   * THE EXACTLY-ONCE GUARANTEE IS UNCHANGED. The compare-and-set moved column,
   * nothing more: `claimedAt: null` in the WHERE is the compare and
   * `data: { claimedAt }` is the set, in ONE conditional statement. A second
   * caller — another tick, another replica, or a restart racing a live sweep
   * — matches zero rows and is told it lost, exactly as before. No lock is
   * held in this process and no read precedes the write.
   *
   * The other three predicates are unchanged and deliberately kept: a task
   * must still be the right creator's, still PENDING, and still actually
   * scheduled. This only ADDS a condition; it weakens none.
   *
   * It deliberately does NOT touch `status`. The PENDING -> RUNNING move stays
   * with TaskService, so a scheduled run and a manual one travel the same
   * lifecycle path and obey the same transition rules.
   *
   * Nothing re-arms a stale claim in V2.1. That is V2.3.
   */
  async claimSchedule(
    taskId: string,
    createdBy: string,
    claimedAt: Date = new Date()
  ): Promise<boolean> {
    const result = await this.prisma.task.updateMany({
      where: {
        id: taskId,
        createdBy,
        status: "PENDING",
        scheduledAt: { not: null },
        claimedAt: null,
      },
      data: { claimedAt },
    });
    return result.count === 1;
  }

  // -------------------------------------------------------------------------
  // Task Engine V2.2 - claim recovery
  //
  // THE SAFETY ARGUMENT, IN ONE LINE: a task that is still PENDING proves the
  // ToolExecutor was never reached, so no external side effect can have
  // occurred and re-arming cannot duplicate one.
  //
  // Why that holds, from the code rather than by assertion:
  //
  //   TaskExecutionService.executeTask runs its steps in this order -
  //     step 4  startTask   PENDING -> RUNNING   (compare-and-set, committed)
  //     step 5  executor.execute                 (the ONLY side-effect path)
  //
  //   so `status = 'PENDING'` means step 4 never committed, which means step 5
  //   was never called. `executionId` is written in the SAME statement as that
  //   transition, so a PENDING task also has `executionId IS NULL` and no
  //   audit evidence can exist for it. Recovery therefore needs no AuditLog
  //   lookup, no index and no migration.
  //
  // A task that crashed AFTER step 4 is RUNNING, not PENDING. That is a
  // different problem with genuinely ambiguous evidence, and it is V2.3's.
  // -------------------------------------------------------------------------

  /**
   * Claims that were taken and then abandoned.
   *
   * Candidate discovery only - every row returned must still be recovered
   * with `recoverClaim`, because between this read and that write the
   * claiming process may have come back to life, or another recovery worker
   * may have taken it.
   */
  async findOrphanedClaims(
    createdBy: string,
    claimedBefore: Date,
    limit = 20
  ): Promise<TaskRecord[]> {
    return this.prisma.task.findMany({
      where: {
        createdBy,
        // The proof that nothing ran. Not a heuristic.
        status: "PENDING",
        // Still armed: recovery restores a schedule, it does not create one.
        scheduledAt: { not: null },
        claimedAt: { not: null, lt: claimedBefore },
        // Belt and braces. The status check already implies this, and if the
        // two ever disagreed the safe reading is "something ran" - so this
        // excludes the row rather than trusting the status alone.
        executionId: null,
      },
      orderBy: { claimedAt: "asc" },
      take: Math.min(limit, 100),
    }) as unknown as Promise<TaskRecord[]>;
  }

  /**
   * Re-arm one abandoned claim. THE race-safe step.
   *
   * Clearing `claimedAt` is the recovery, and it is the exact inverse of the
   * V2.1 claim: `claimedAt: { not: null, lt: ... }` in the WHERE is the
   * compare, `claimedAt: null` is the set, in ONE conditional statement.
   * `count === 1` means this worker recovered it; a second recovery worker,
   * another replica, or a sweep racing a live process matches zero rows.
   *
   * `scheduledAt` is deliberately UNTOUCHED: the task returns to exactly the
   * state it was in before it was claimed, so the ordinary scheduler picks it
   * up on its own terms. Nothing here plans, executes, completes or fails a
   * task - recovery restores eligibility and stops.
   *
   * THE FULL PREDICATE IS REPEATED HERE, not narrowed to the id. A candidate
   * read moments ago is not evidence about now.
   */
  async recoverClaim(
    taskId: string,
    createdBy: string,
    claimedBefore: Date
  ): Promise<boolean> {
    const result = await this.prisma.task.updateMany({
      where: {
        id: taskId,
        createdBy,
        status: "PENDING",
        scheduledAt: { not: null },
        claimedAt: { not: null, lt: claimedBefore },
        executionId: null,
      },
      data: { claimedAt: null },
    });
    return result.count === 1;
  }

  // -------------------------------------------------------------------------
  // Task Engine V2.3 - stale RUNNING discovery
  //
  // A RUNNING task means `executeTask` committed PENDING -> RUNNING and then
  // called the executor. Unlike the V2.2 window, the tool MAY have reached an
  // external system, so nothing here decides an outcome - this only finds
  // candidates whose execution window has certainly closed. The outcome comes
  // from durable evidence, looked up separately.
  // -------------------------------------------------------------------------

  /**
   * RUNNING work whose execution window has expired.
   *
   * `startedBefore` is computed by the caller from the executor's enforced
   * deadline plus a grace period, so a task still inside its legitimate window
   * is never a candidate.
   */
  async findStaleRunning(
    createdBy: string,
    startedBefore: Date,
    limit = 20
  ): Promise<TaskRecord[]> {
    return this.prisma.task.findMany({
      where: {
        createdBy,
        status: "RUNNING",
        startedAt: { not: null, lt: startedBefore },
      },
      orderBy: { startedAt: "asc" },
      take: Math.min(limit, 100),
    }) as unknown as Promise<TaskRecord[]>;
  }

  /** A user's tasks in one lifecycle state. Used by the Core V1 task surface. */
  async listByStatus(
    userId: string,
    status: TaskStatus,
    limit = 50,
    options: { createdBy?: string } = {}
  ): Promise<TaskRecord[]> {
    return this.prisma.task.findMany({
      where: {
        userId,
        status,
        ...(options.createdBy !== undefined ? { createdBy: options.createdBy } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 200),
    }) as unknown as Promise<TaskRecord[]>;
  }

  async findOwned(userId: string, taskId: string): Promise<TaskRecord | null> {
    return this.prisma.task.findFirst({
      where: { id: taskId, userId },
    }) as unknown as Promise<TaskRecord | null>;
  }

  /**
   * True when a row was actually removed.
   *
   * `excludeCreatedBy` is the same Core V1.1 boundary `list()` documents above,
   * applied to deletion: the todo surface passes "jarvis" so that a JARVIS work
   * task cannot be removed through the dashboard. It lives in the WHERE clause
   * rather than in a read-then-delete check in the route, so the guard is
   * atomic and cannot be raced.
   *
   * It only ever NARROWS the query. The userId filter is unconditional.
   */
  async deleteOwned(
    userId: string,
    taskId: string,
    options: { excludeCreatedBy?: string } = {}
  ): Promise<boolean> {
    const result = await this.prisma.task.deleteMany({
      where: {
        id: taskId,
        userId,
        ...(options.excludeCreatedBy !== undefined
          ? createdByIsNot(options.excludeCreatedBy)
          : {}),
      },
    });
    return result.count > 0;
  }

  /**
   * Tasks that are due and have not yet had a reminder raised.
   *
   * Drives the reminder surface. `remindedAt: null` is what stops the same task
   * being announced on every poll.
   */
  async dueForReminder(userId: string, now = new Date()): Promise<TaskRecord[]> {
    return this.prisma.task.findMany({
      where: {
        userId,
        completedAt: null,
        remindedAt: null,
        dueAt: { not: null, lte: now },
      },
      orderBy: { dueAt: "asc" },
      take: 20,
    }) as unknown as Promise<TaskRecord[]>;
  }

  async markReminded(userId: string, taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) return;
    await this.prisma.task.updateMany({
      where: { userId, id: { in: taskIds } },
      data: { remindedAt: new Date() },
    });
  }
}
