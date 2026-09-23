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

import { JARVIS_TASK_CREATOR, type Role, type TaskStatus } from "@jarvis/core";
import { DEFAULT_TOOL_EXECUTION_TIMEOUT_MS } from "@jarvis/tools";
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

/** What one abandoned claim's recovery produced. */
export interface RecoveryOutcome {
  taskId: string;
  /** `re_armed` - the claim was cleared. `lost` - another worker got there. */
  outcome: "re_armed" | "lost";
}

/**
 * V2.2 default: how old a claim must be before it counts as abandoned.
 *
 * NOT derived from the ToolExecutor's 30 s deadline, which is irrelevant here
 * - the executor is never reached in this window. The bound that matters is
 * the PLANNER's, because a claimed task passes claim -> planTask -> startTask
 * and `planTask` is capped by `AbortSignal.timeout(20_000)`. So the window in
 * which a claim is legitimately PENDING is ~20 s plus database round trips.
 *
 * Five minutes is an order of magnitude above that: conservative on purpose,
 * because being slow to recover costs one scheduler interval while being
 * early costs nothing at all (see `recoverOrphanedClaims`) - but the cheap
 * direction is still the one to err in.
 *
 * THIS IS A DEVELOPMENT DEFAULT. A production value is a deliberate choice
 * and should be set explicitly via JARVIS_TASK_CLAIM_RECOVERY_AFTER_MS.
 */
export const DEFAULT_CLAIM_RECOVERY_AFTER_MS = 300_000;

/** What one due task's run produced. Used for logging, not for control flow. */
export interface SweepOutcome {
  taskId: string;
  outcome: "executed" | "not_planned" | "claim_lost" | "execution_refused";
  detail?: string;
}

export interface TaskSchedulerDeps {
  tasks: Pick<
    PrismaTaskRepository,
    | "setScheduleOwned"
    | "findDueScheduled"
    | "claimSchedule"
    | "findOrphanedClaims"
    | "recoverClaim"
    | "findStaleRunning"
  >;
  /**
   * V2.3 - the read side of the execution evidence. Narrow on purpose: the
   * scheduler may look up an outcome and nothing else.
   */
  audit?: { findExecutionOutcome: AuditEvidenceLookup };
  /**
   * V2.3 - how long AFTER the executor's enforced deadline a RUNNING task
   * must sit before its outcome is reconciled. 0 or negative disables
   * RUNNING recovery.
   */
  runningRecoveryGraceMs?: number;
  /**
   * V2.2 - how old a claim must be before it is treated as abandoned.
   *
   * 0 or negative disables recovery entirely.
   */
  claimRecoveryAfterMs?: number;
  taskService: TaskService;
  planner: TaskPlannerService;
  execution: TaskExecutionService;
  /** Injectable so tests control time rather than sleeping. */
  now?: () => Date;
  /**
   * V2.1 - structured logging, same shape as the scheduler loop's.
   * Optional: a deployment without it is silent, exactly as before.
   */
  log?: SchedulerLog;
}

export type AuditEvidenceLookup = (
  userId: string,
  executionId: string,
  since: Date
) => Promise<{ result: "success" | "failure" | "rejected" | "pending" } | null>;

/** What one stale RUNNING task's reconciliation produced. */
export interface RunningRecoveryOutcome {
  taskId: string;
  outcome: "reconciled" | "unresolved" | "skipped";
  newStatus?: TaskStatus;
}

/**
 * V2.3 default grace ADDED TO the executor deadline before a RUNNING task is
 * considered stale.
 *
 * The total threshold is `DEFAULT_TOOL_EXECUTION_TIMEOUT_MS + this`, derived
 * from the real enforced deadline rather than restated. Two minutes of margin
 * covers the work that sits OUTSIDE the deadline timer - the registry lookup,
 * the permission check, the approval lookup, the audit write and the settle
 * transition - with an order of magnitude to spare.
 *
 * Erring late is cheap: a task stays RUNNING one sweep longer. Erring early
 * would reconcile a live execution, so the margin is deliberately generous.
 */
export const DEFAULT_RUNNING_RECOVERY_GRACE_MS = 120_000;

export type SchedulerLog = (
  level: "info" | "warn",
  event: string,
  meta?: Record<string, unknown>
) => void;

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
  private readonly log: SchedulerLog;
  private readonly claimRecoveryAfterMs: number;
  private readonly runningRecoveryGraceMs: number;

  constructor(private readonly deps: TaskSchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.claimRecoveryAfterMs =
      deps.claimRecoveryAfterMs ?? DEFAULT_CLAIM_RECOVERY_AFTER_MS;
    this.runningRecoveryGraceMs =
      deps.runningRecoveryGraceMs ?? DEFAULT_RUNNING_RECOVERY_GRACE_MS;
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
   * V2.2 - re-arm claims that were taken and then abandoned.
   *
   * WHY THIS IS SAFE, AND WHY IT NEEDS NO AUDIT LOOKUP.
   *
   * `executeTask` commits PENDING -> RUNNING (step 4) BEFORE it calls the
   * executor (step 5). A task that is still PENDING therefore proves the
   * executor was never reached: no tool ran, nothing happened outside JARVIS,
   * and re-arming cannot duplicate a side effect. The evidence is the task's
   * own status, which is stronger than any after-the-fact log - and it is why
   * the ambiguity that makes RUNNING recovery hard does not arise here.
   *
   * EVEN A PREMATURE RECOVERY IS HARMLESS. Suppose a claim is re-armed while
   * its original process is somehow still alive and later calls `startTask`.
   * Both processes then race on the SAME compare-and-set against
   * `status = PENDING`, so exactly one wins and only one execution happens.
   * The status CAS is the final gate in front of every tool call, and
   * recovery does not weaken it. Being early costs a wasted plan, never a
   * duplicate run.
   *
   * WHAT IT DOES NOT DO. It does not plan, execute, complete, fail or cancel
   * anything, and it never calls a tool. It clears one column and stops; the
   * ordinary scheduler then picks the task up on its own terms.
   */
  async recoverOrphanedClaims(): Promise<RecoveryOutcome[]> {
    if (this.claimRecoveryAfterMs <= 0) return [];

    const claimedBefore = new Date(this.now().getTime() - this.claimRecoveryAfterMs);
    const orphans = await this.deps.tasks.findOrphanedClaims(
      JARVIS_TASK_CREATOR,
      claimedBefore
    );
    if (orphans.length === 0) return [];

    const outcomes: RecoveryOutcome[] = [];
    for (const task of orphans) {
      this.log("warn", "task_scheduler_claim_orphaned", {
        taskId: task.id,
        scheduledAt: task.scheduledAt?.toISOString(),
        claimedAt: task.claimedAt?.toISOString(),
        claimAgeMs: task.claimedAt
          ? this.now().getTime() - task.claimedAt.getTime()
          : null,
      });

      // The same full predicate again, atomically. A candidate read a moment
      // ago is not evidence about now: the claiming process may have moved
      // the task to RUNNING in between, and another recovery worker may have
      // taken it. Either way this matches zero rows and reports `lost`.
      const reArmed = await this.deps.tasks.recoverClaim(
        task.id,
        JARVIS_TASK_CREATOR,
        claimedBefore
      );

      if (reArmed) {
        this.log("info", "task_scheduler_claim_recovered", {
          taskId: task.id,
          scheduledAt: task.scheduledAt?.toISOString(),
        });
      } else {
        this.log("info", "task_scheduler_claim_recovery_skipped", {
          taskId: task.id,
          reason: "claim_changed_or_taken_by_another_worker",
        });
      }
      outcomes.push({ taskId: task.id, outcome: reArmed ? "re_armed" : "lost" });
    }

    return outcomes;
  }

  /**
   * V2.3 - reconcile RUNNING tasks whose execution window has closed.
   *
   * WHY THIS IS HARDER THAN V2.2, AND WHY IT IS STILL SAFE.
   *
   * A PENDING claim proved nothing had run. RUNNING proves the opposite is
   * possible: `executeTask` committed PENDING -> RUNNING and then called the
   * executor, so the tool MAY have reached an external system. Recovery here
   * therefore decides NOTHING on its own - it reads durable evidence and
   * reports what that evidence says.
   *
   * THE EVIDENCE. `ToolExecutor` writes exactly one `tool.execute` audit row
   * immediately before EVERY return path, and its deadline is enforced by a
   * race rather than by the tool's cooperation. So:
   *
   *   audit row present  ->  the executor RETURNED; its result is the outcome
   *   audit row absent
   *     within the window ->  still running; leave it alone
   *     past the window   ->  the process died mid-call. The tool may or may
   *                           not have completed its external write, and
   *                           nothing durable says which: UNRESOLVED.
   *
   * IT NEVER RETRIES. No tool is called, no executionId is minted, no
   * scheduledAt is touched. `UNRESOLVED` is terminal precisely because
   * re-running could duplicate a write that already succeeded.
   */
  async recoverStaleRunning(): Promise<RunningRecoveryOutcome[]> {
    if (this.runningRecoveryGraceMs <= 0) return [];

    // Derived from the executor's OWN enforced deadline, not restated.
    const staleAfterMs = DEFAULT_TOOL_EXECUTION_TIMEOUT_MS + this.runningRecoveryGraceMs;
    const startedBefore = new Date(this.now().getTime() - staleAfterMs);

    const stale = await this.deps.tasks.findStaleRunning(JARVIS_TASK_CREATOR, startedBefore);
    if (stale.length === 0) return [];

    this.log("info", "task_scheduler_running_recovery_started", {
      candidates: stale.length,
      staleAfterMs,
      executionDeadlineMs: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
      graceMs: this.runningRecoveryGraceMs,
    });

    const outcomes: RunningRecoveryOutcome[] = [];
    for (const task of stale) {
      outcomes.push(await this.reconcileOne(task, staleAfterMs));
    }
    return outcomes;
  }

  /** One stale RUNNING task, decided entirely by its evidence. */
  private async reconcileOne(
    task: TaskRecord,
    staleAfterMs: number
  ): Promise<RunningRecoveryOutcome> {
    const ageMs = task.startedAt ? this.now().getTime() - task.startedAt.getTime() : null;

    // No executionId means the executor was never even named for this task -
    // a RUNNING state set by hand, or a run that died before the claim wrote
    // it. Either way there is nothing to look evidence up by, so the honest
    // answer is the same: we cannot say.
    const evidence =
      task.executionId && task.startedAt && this.deps.audit
        ? await this.deps.audit.findExecutionOutcome(
            task.userId,
            task.executionId,
            task.startedAt
          )
        : null;

    const base = {
      taskId: task.id,
      executionId: task.executionId,
      previousStatus: task.status,
      auditEvidenceFound: evidence !== null,
      ageMs,
      staleAfterMs,
    };

    if (evidence) {
      // The executor returned. Its recorded result IS the outcome - recovery
      // is only writing down what already happened.
      const settled =
        evidence.result === "success"
          ? await this.deps.taskService.completeTask(task.userId, task.id)
          : await this.deps.taskService.failTask(
              task.userId,
              task.id,
              `The run finished while JARVIS was interrupted; the execution was recorded as ${evidence.result}.`
            );

      if (!settled.ok) {
        // A worker settled it first. An ordinary compare-and-set loss, not an
        // error, and NOT something to retry: whoever won wrote a terminal
        // state and there is exactly one of those.
        this.log("info", "task_scheduler_running_recovery_skipped", {
          ...base,
          recoveryReason: "already_settled_by_another_writer",
        });
        return { taskId: task.id, outcome: "skipped" };
      }

      const newStatus: TaskStatus = evidence.result === "success" ? "COMPLETED" : "FAILED";
      this.log("info", "task_scheduler_running_recovery_reconciled", {
        ...base,
        newStatus,
        recoveryReason: `audit_result_${evidence.result}`,
      });
      return { taskId: task.id, outcome: "reconciled", newStatus };
    }

    // No evidence past the window. The executor was entered and its outcome
    // cannot be established. This is NOT a failure and must never be recorded
    // as one.
    const unresolved = await this.deps.taskService.unresolveTask(
      task.userId,
      task.id,
      "The run was interrupted and no record of its outcome was found. " +
        "It may or may not have completed; JARVIS will not repeat it."
    );

    if (!unresolved.ok) {
      this.log("info", "task_scheduler_running_recovery_skipped", {
        ...base,
        recoveryReason: "already_settled_by_another_writer",
      });
      return { taskId: task.id, outcome: "skipped" };
    }

    this.log("warn", "task_scheduler_running_recovery_unknown", {
      ...base,
      newStatus: "UNRESOLVED" satisfies TaskStatus,
      recoveryReason: task.executionId
        ? "no_audit_evidence_after_execution_window"
        : "no_execution_linked",
    });
    return { taskId: task.id, outcome: "unresolved", newStatus: "UNRESOLVED" };
  }

  /**
   * Claim one due task and run it.
   *
   * The claim comes FIRST and is atomic. Only the winner plans or executes, so
   * a second sweep — or a second replica — does no work and calls no tool.
   */
  private async runOne(task: TaskRecord): Promise<SweepOutcome> {
    const claimedAt = this.now();
    const claimed = await this.deps.tasks.claimSchedule(
      task.id,
      JARVIS_TASK_CREATOR,
      claimedAt
    );
    if (!claimed) {
      return { taskId: task.id, outcome: "claim_lost" };
    }

    // V2.1 - the claim is now durable, so it is worth recording. `lateness` is
    // the gap between the instant the task was due and the instant it was
    // taken, which is the number that says whether the sweep interval is
    // keeping up. Ids and times only - never the title.
    this.log("info", "task_schedule_claimed", {
      taskId: task.id,
      scheduledAt: task.scheduledAt?.toISOString(),
      latenessMs: task.scheduledAt
        ? claimedAt.getTime() - task.scheduledAt.getTime()
        : null,
    });

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

    // The other half of the pair: the task now carries the id of the run that
    // performed it, and that id is what the audit row was written under.
    this.log("info", "task_execution_linked", {
      taskId: task.id,
      executionId: result.execution.executionId,
    });

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
