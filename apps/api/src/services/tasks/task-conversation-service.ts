// ---------------------------------------------------------------------------
// TaskConversationService — Task Planner V1.1.
//
// The conversational entry point to work:
//
//   "check digitalonebox.com"  ->  plan -> task -> execute -> a sentence
//   "...plan banao, execute mat karo"  ->  plan -> task -> a sentence
//   nothing here can do it     ->  plan -> (no task) -> back to the assistant
//
// It owns the SEQUENCE and nothing else. Detection is a pure function in
// @jarvis/agents, the task is TaskService's, the plan is TaskPlannerService's,
// the run is TaskExecutionService's, and every safety check belongs to the
// ToolExecutor underneath those. This file adds no authority of its own — if
// it were deleted, nothing about what JARVIS may do would change, only how a
// user reaches it.
//
// WHY IT LIVES BESIDE THE CHAT ROUTE RATHER THAN IN THE ORCHESTRATOR. The
// orchestrator decides which agent answers a turn and which tools that agent
// may propose. This decides something earlier and narrower: whether the turn
// is a request to perform work at all. Putting it in the route, beside the
// CONFIRM / REJECT / MODIFY branches that already sit there for pending
// actions, keeps general chat orchestration untouched — a message that is not
// work never reaches this file.
//
// NOTHING RUNS ON A MAYBE. `detectWorkRequest` returns EXECUTE only for an
// unambiguous imperative; anything questioning, explanatory or hedged falls
// through to the existing path.
// ---------------------------------------------------------------------------

import { JARVIS_TASK_CREATOR, type Role } from "@jarvis/core";
import type { TaskService } from "./task-service.js";
import type { TaskPlannerService } from "./task-planner-service.js";
import type { TaskExecutionService } from "./task-execution-service.js";
import type { TaskSchedulerService } from "./task-scheduler-service.js";

export interface WorkTurnInput {
  userId: string;
  role: Role;
  /** The user's message, already established to be a work request. */
  goal: string;
  /** True when the user explicitly asked NOT to execute. */
  planOnly: boolean;
  /**
   * Scheduler V1 — an explicit future instant. When present the task is
   * recorded and scheduled, and NOTHING runs now.
   */
  scheduledAt?: Date;
  traceId?: string;
  conversationId?: string;
  ipAddress?: string;
}

export interface WorkTurnResult {
  /** The sentence to show the user. Never contains provider or tool internals. */
  message: string;
  taskId: string;
  /** Present when a plan was produced, executable or not. */
  plan?: { executable: boolean; toolId?: string; reason: string };
  /** Present only when something actually ran. */
  execution?: { toolId: string; status: string };
  /** Present when the task was scheduled instead of run. */
  scheduledAt?: string;
}

export interface TaskConversationDeps {
  tasks: TaskService;
  planner: TaskPlannerService;
  execution: TaskExecutionService;
  /** Scheduler V1. Absent on a deployment without scheduling. */
  scheduler?: TaskSchedulerService;
}

const MAX_TITLE = 200;

export class TaskConversationService {
  constructor(private readonly deps: TaskConversationDeps) {}

  /**
   * Plan the work, record it, and — unless the user said not to — run it.
   *
   * Returns NULL when this is not work after all: nothing here can carry it
   * out and the user named no time. The caller then sends the turn to the
   * assistant, which — unlike the planner — can see the conversation.
   *
   * WHY THE PLAN COMES FIRST. The task used to be created first and always, so
   * a turn the planner could do nothing with — "Summarize our conversation" —
   * left a PENDING task nobody could run and the answer "I cannot carry it out
   * yet". A task is a record of WORK; with no executable action there is none
   * to record, and the user's words are in the conversation either way.
   *
   * A TURN WITH AN EXPLICIT TIME IS NEVER HANDED BACK. The assistant answers
   * now, and the one thing a stated time must never become is "run it now" —
   * so that turn is still recorded and still answered here, as it always was.
   */
  async handle(input: WorkTurnInput): Promise<WorkTurnResult | null> {
    const title = input.goal.slice(0, MAX_TITLE);

    const plan = await this.deps.planner.planTask({
      userId: input.userId,
      title,
      description: input.goal,
      ...(input.traceId ? { traceId: input.traceId } : {}),
    });

    if (!plan.executable && !input.scheduledAt) return null;

    const created = await this.deps.tasks.createTask(input.userId, {
      title,
      description: input.goal,
      // The same stamp the `task.create` tool and POST /api/v1/tasks use, so
      // this task is JARVIS work and stays out of the todo surfaces.
      createdBy: JARVIS_TASK_CREATOR,
    });

    if (!created.ok) {
      return {
        message: "I could not record that as a task, so I have not started anything.",
        taskId: "",
      };
    }

    const task = created.task;

    if (!plan.executable) {
      // A scheduled turn no action fits. The task stays PENDING — a record of
      // something asked for and not done, which is the truthful state.
      return {
        message: `I have saved this as a task, but I cannot carry it out yet: ${plan.reason}`,
        taskId: task.id,
        plan: { executable: false, reason: plan.reason },
      };
    }

    if (input.scheduledAt && this.deps.scheduler) {
      // Scheduler V1 — record it for later and run NOTHING now.
      //
      // The plan above was a FEASIBILITY check, not a commitment: it is not
      // persisted, and the scheduler re-plans from the task at run time. Doing
      // it here anyway is what lets the answer be "I can, and I will at 10"
      // rather than "scheduled" followed by a failure tomorrow — the user
      // finds out now, while they can still rephrase.
      const scheduled = await this.deps.scheduler.scheduleTask(
        input.userId,
        task.id,
        input.scheduledAt
      );

      if (!scheduled.ok) {
        return {
          message: `I could not schedule that: ${scheduled.message}`,
          taskId: task.id,
          plan: { executable: true, toolId: plan.toolId, reason: plan.reason },
        };
      }

      return {
        // The resolved absolute time is stated back deliberately. There is no
        // user-timezone system in this application, so "10 AM" was read in the
        // server's zone — saying which instant that became is what makes a
        // mismatch visible now instead of at 10 AM.
        message:
          `Scheduled for ${scheduled.task.scheduledAt?.toLocaleString() ?? "the requested time"}. ` +
          `I will run ${plan.toolId} then. Nothing has run yet.`,
        taskId: task.id,
        plan: { executable: true, toolId: plan.toolId, reason: plan.reason },
        ...(scheduled.task.scheduledAt
          ? { scheduledAt: scheduled.task.scheduledAt.toISOString() }
          : {}),
      };
    }

    if (input.planOnly) {
      // Explicitly asked to plan and not run. Nothing is claimed, nothing is
      // executed, and the task is left PENDING so it can be run later.
      return {
        message:
          `Here is the plan for "${task.title}": run ${plan.toolId}. ${plan.reason} ` +
          "I have not executed it, as you asked. The task is saved and pending.",
        taskId: task.id,
        plan: { executable: true, toolId: plan.toolId, reason: plan.reason },
      };
    }

    // The only path that runs anything — and it runs through the same service
    // the REST endpoint uses, so ownership, the allowlist, the permission
    // check and the approval gate all apply unchanged.
    const outcome = await this.deps.execution.executeTask(input.userId, task.id, {
      toolId: plan.toolId,
      params: plan.params,
      role: input.role,
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
    });

    if (!outcome.ok) {
      return {
        message: `I planned this as ${plan.toolId}, but could not run it: ${outcome.message}`,
        taskId: task.id,
        plan: { executable: true, toolId: plan.toolId, reason: plan.reason },
      };
    }

    // The task's own status is the authority on whether the work succeeded —
    // the executor may have refused it for permission or approval, which is a
    // FAILED task and a message that says why.
    const succeeded = outcome.task.status === "COMPLETED";

    return {
      message: succeeded
        ? `Done — I ran ${plan.toolId} for "${task.title}".`
        : `I tried to run ${plan.toolId} for "${task.title}", but it did not complete: ${
            outcome.task.error ?? "no reason was recorded"
          }`,
      taskId: task.id,
      plan: { executable: true, toolId: plan.toolId, reason: plan.reason },
      execution: { toolId: plan.toolId, status: outcome.execution.status },
    };
  }
}
