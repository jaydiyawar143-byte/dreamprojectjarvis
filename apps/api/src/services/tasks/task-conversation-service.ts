// ---------------------------------------------------------------------------
// TaskConversationService — Task Planner V1.1.
//
// The conversational entry point to work:
//
//   "check digitalonebox.com"  ->  task -> plan -> execute -> a sentence
//   "...plan banao, execute mat karo"  ->  task -> plan -> a sentence
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

export interface WorkTurnInput {
  userId: string;
  role: Role;
  /** The user's message, already established to be a work request. */
  goal: string;
  /** True when the user explicitly asked NOT to execute. */
  planOnly: boolean;
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
}

export interface TaskConversationDeps {
  tasks: TaskService;
  planner: TaskPlannerService;
  execution: TaskExecutionService;
}

const MAX_TITLE = 200;

export class TaskConversationService {
  constructor(private readonly deps: TaskConversationDeps) {}

  /**
   * Record the work, plan it, and — unless the user said not to — run it.
   *
   * The task is created FIRST and always, even when planning then fails. That
   * is deliberate: the user asked for work, and a durable record of what they
   * asked for is worth more than a tidy table. A task whose plan failed stays
   * PENDING with nothing run, which is exactly what happened.
   */
  async handle(input: WorkTurnInput): Promise<WorkTurnResult> {
    const created = await this.deps.tasks.createTask(input.userId, {
      title: input.goal.slice(0, MAX_TITLE),
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

    const plan = await this.deps.planner.planTask({
      userId: input.userId,
      taskId: task.id,
      title: task.title,
      description: task.description,
      ...(input.traceId ? { traceId: input.traceId } : {}),
    });

    if (!plan.executable) {
      // No action fits. The task stays PENDING — a record of something asked
      // for and not done, which is the truthful state.
      return {
        message: `I have saved this as a task, but I cannot carry it out yet: ${plan.reason}`,
        taskId: task.id,
        plan: { executable: false, reason: plan.reason },
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
