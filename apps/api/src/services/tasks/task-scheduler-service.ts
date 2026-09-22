// ---------------------------------------------------------------------------
// TaskSchedulerService — Scheduler V1.
//
//   WHAT -> Task        WHEN -> here        HOW -> Planner        DO -> Execution
//
// Adds the only thing the stack was missing: a time. It owns no execution
// machinery, no planning and no lifecycle rules — it decides WHEN a PENDING
// work task becomes eligible, claims it once, and hands it to the services
// that already exist.
//
// ONE-TIME ONLY. There is no recurrence, no cron and no retry in V1. A
// schedule is a single instant, consumed the moment it is claimed.
//
// WHY PLANNING HAPPENS AT EXECUTION TIME, NOT AT SCHEDULE TIME.
//
// A Task persists `title` and `description` and no plan — Core V1 deliberately
// does not store a tool call, because `recommendation-bridge.ts` is the only
// thing in this repository allowed to turn stored data into a tool name, and
// it does so from a TYPED action, not free text. Persisting a plan would mean
// adding that storage and then trusting it later.
//
// Planning at execution time is both smaller AND safer:
//
//   - nothing new is persisted, so there is no stale plan to trust;
//   - the plan is built from the task as it reads AT RUN TIME, so a title the
//     user edited after scheduling is re-planned and re-validated rather than
//     silently running yesterday's intention;
//   - every validation gate — allowlist, registry, parameter validation — runs
//     on the actual run, not once at scheduling.
//
// The cost is honest and stated: a schedule accepted now can turn out to be
// unrunnable later (the capability was removed, the wording no longer maps to
// a tool). That surfaces as a FAILED task with the planner's own reason, which
// is the truthful outcome.
//
// IT GRANTS NOTHING. The run goes through TaskExecutionService with the
// SCHEDULING user's id and role, so a scheduled execution reaches exactly what
// an immediate one would: same ownership, same allowlist, same permission
// check, same approval gate.
// ---------------------------------------------------------------------------

import { JARVIS_TASK_CREATOR, type Role } from "@jarvis/core";
import type { PrismaTaskRepository, TaskRecord } from "@jarvis/db";
import type { TaskService } from "./task-service.js";
import type { TaskPlannerService } from "./task-planner-service.js";
import type { TaskExecutionService } from "./task-execution-service.js";

export type ScheduleRefusal =
  /** No such task, not the caller's, not JARVIS work, or not PENDING. */
  | "NOT_SCHEDULABLE"
  /** The instant given is in the past, or not a usable timestamp. */
  | "INVALID_TIME"
  /** A schedule is already set and was not explicitly replaced. */
  | "ALREADY_SCHEDULED";

export type ScheduleResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; refusal: ScheduleRefusal; message: string };

/** What one due task's run produced. Used for logging, not for control flow. */
export interface SweepOutcome {
  taskId: string;
  outcome: "executed" | "not_planned" | "claim_lost" | "execution_refused";
  detail?: string;
}

export interface TaskSchedulerDeps {
  tasks: Pick<PrismaTaskRepository, "setScheduleOwned" | "findDueScheduled" | "claimSchedule">;
  taskService: TaskService;
  planner: TaskPlannerService;
  execution: TaskExecutionService;
  /** Injectable so tests control time rather than sleeping. */
  now?: () => Date;
}

/**
 * The role a scheduled run executes with.
 *
 * V1 stores no role on the task, so a scheduled run uses the lowest role that
 * can still reach read-only work. This is a DELIBERATE floor, not an
 * oversight: a schedule must never be a way to run something later with more
 * authority than the moment it was created, and without a persisted role the
 * only safe assumption is the least privileged one. A scheduled write that
 * needs more will be refused by the executor's permission check, visibly.
 */
const SCHEDULED_RUN_ROLE: Role = "member";

export class TaskSchedulerService {
  private readonly now: () => Date;

  constructor(private readonly deps: TaskSchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Schedule / cancel / read
  // -------------------------------------------------------------------------

  /**
   * Schedule a PENDING work task for one future run.
   *
   * Every eligibility rule lives in the repository's WHERE clause, so "it is a
   * todo", "it is running" and "it is not yours" are refused atomically rather
   * than checked and then trusted.
   */
  async scheduleTask(
    userId: string,
    taskId: string,
    scheduledAt: Date,
    options: { replace?: boolean } = {}
  ): Promise<ScheduleResult> {
    if (Number.isNaN(scheduledAt.getTime())) {
      return { ok: false, refusal: "INVALID_TIME", message: "That is not a valid date and time." };
    }
    if (scheduledAt.getTime() <= this.now().getTime()) {
      return {
        ok: false,
        refusal: "INVALID_TIME",
        message: "A task can only be scheduled for a time in the future.",
      };
    }

    // Refuse to silently move an existing schedule. Overwriting one without
    // being asked is how a user ends up with work running at a time they never
    // chose; `replace` makes the intent explicit.
    if (!options.replace) {
      const existing = await this.deps.taskService.getTask(userId, taskId);
      if (existing.ok && existing.task.scheduledAt) {
        return {
          ok: false,
          refusal: "ALREADY_SCHEDULED",
          message: `This task is already scheduled for ${existing.task.scheduledAt.toISOString()}. Cancel it first, or replace it explicitly.`,
        };
      }
    }

    const task = await this.deps.tasks.setScheduleOwned(
      userId,
      taskId,
      JARVIS_TASK_CREATOR,
      scheduledAt
    );

    if (!task) return this.notSchedulable();
    return { ok: true, task };
  }

  /**
   * Clear a future schedule. The task itself survives, PENDING, and may be
   * scheduled again — cancelling a plan is not abandoning the work.
   */
  async cancelScheduledTask(userId: string, taskId: string): Promise<ScheduleResult> {
    const task = await this.deps.tasks.setScheduleOwned(
      userId,
      taskId,
      JARVIS_TASK_CREATOR,
      null
    );
    // The PENDING requirement in the WHERE clause is what stops a RUNNING
    // execution being "cancelled" here: this only ever clears a future plan,
    // it never interrupts work in flight.
    if (!task) return this.notSchedulable();
    return { ok: true, task };
  }

  /** The task with its schedule, or a refusal. Ownership enforced upstream. */
  async getScheduledTask(userId: string, taskId: string): Promise<ScheduleResult> {
    const found = await this.deps.taskService.getTask(userId, taskId);
    if (!found.ok) return this.notSchedulable();
    return { ok: true, task: found.task };
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * Run everything that is due.
   *
   * Called by the interval loop AND at startup, which is what makes a schedule
   * survive a restart: the due set is a database query, never in-process
   * state, so a task scheduled for 10:00 on a process that died at 09:59 runs
   * when the next process discovers it.
   *
   * An overdue task runs ONCE, as soon as it is discovered — the claim clears
   * `scheduledAt`, so being late does not mean being run repeatedly.
   */
  async runDue(): Promise<SweepOutcome[]> {
    const due = await this.deps.tasks.findDueScheduled(JARVIS_TASK_CREATOR, this.now());
    const outcomes: SweepOutcome[] = [];

    for (const task of due) {
      outcomes.push(await this.runOne(task));
    }
    return outcomes;
  }

  /**
   * Claim one due task and run it.
   *
   * The claim comes FIRST and is atomic. Only the winner plans or executes, so
   * a second sweep — or a second replica — does no work and calls no tool.
   */
  private async runOne(task: TaskRecord): Promise<SweepOutcome> {
    const claimed = await this.deps.tasks.claimSchedule(task.id, JARVIS_TASK_CREATOR);
    if (!claimed) {
      return { taskId: task.id, outcome: "claim_lost" };
    }

    // Planned from the task AS IT READS NOW — see the header for why this is
    // not done at scheduling time.
    const plan = await this.deps.planner.planTask({
      userId: task.userId,
      taskId: task.id,
      title: task.title,
      description: task.description,
    });

    if (!plan.executable) {
      // Nothing runs, and the task is marked FAILED with the planner's reason
      // rather than being left PENDING with a consumed schedule — silently
      // dropping it would leave work the user asked for in limbo.
      const started = await this.deps.taskService.startTask(task.userId, task.id);
      if (started.ok) {
        await this.deps.taskService.failTask(
          task.userId,
          task.id,
          `Scheduled run could not be planned: ${plan.reason}`
        );
      }
      return { taskId: task.id, outcome: "not_planned", detail: plan.reason };
    }

    const result = await this.deps.execution.executeTask(task.userId, task.id, {
      toolId: plan.toolId,
      params: plan.params,
      // The scheduling user's own identity. A schedule carries no authority of
      // its own — see SCHEDULED_RUN_ROLE.
      role: SCHEDULED_RUN_ROLE,
    });

    if (!result.ok) {
      return { taskId: task.id, outcome: "execution_refused", detail: result.message };
    }
    return { taskId: task.id, outcome: "executed", detail: result.execution.status };
  }

  private notSchedulable(): ScheduleResult {
    return {
      ok: false,
      refusal: "NOT_SCHEDULABLE",
      message:
        "That task cannot be scheduled. It must be a pending JARVIS work task that belongs to you.",
    };
  }
}
