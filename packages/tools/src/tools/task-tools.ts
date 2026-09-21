// ---------------------------------------------------------------------------
// Core V1 — task tools.
//
// What makes "JARVIS, create a task to prepare the Sputnikverse proposal"
// persist something, WITHOUT touching the Orchestrator. The orchestrator
// already routes a turn to an agent and lets it propose tools; a task is just
// another tool it may propose, so the integration point is a registration, not
// a new branch in the chat path.
//
// THE PORT IS THE WHOLE BOUNDARY. These tools receive one object with four
// methods and nothing else — no PrismaClient, no repository, no executor. A
// tool in this package cannot import the database (the dependency graph
// forbids it), so the only writes possible here are the four the service
// exposes, every one of them already scoped to the authenticated user.
//
// `context.userId` IS THE USER. It is never a parameter the model supplies:
// there is no `userId` in any schema below, so no prompt can ask for someone
// else's tasks. Same rule as the ambient tools.
//
// RISK. task.create and task.updateStatus write to JARVIS's OWN store, not to
// anything outside it — no provider is called, no message is sent, nothing is
// spent. They carry LOW_IMPACT and no approval, which is exactly what
// `integration.configure` and `integration.connect` already use for writes
// that stay inside JARVIS; EXTERNAL_SIDE_EFFECT is reserved for writes that
// leave the process, and an approval prompt for "remember this for me" would
// make the feature useless. Nothing here can execute a task; Core V1 has no
// executor, and a PENDING task is a record of intent.
// ---------------------------------------------------------------------------

import { BaseTool } from "../base-tool.js";
import type { ToolContext, ToolResult } from "@jarvis/core";
import { JARVIS_TASK_CREATOR, TaskStatusSchema, type TaskStatus } from "@jarvis/core";

/** One task, in the shape a model may relay. */
export interface TaskView {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

/** What the tools may do. Implemented over TaskService at the composition root. */
export interface TaskPort {
  create(
    userId: string,
    input: { title: string; description?: string | null; createdBy?: string | null }
  ): Promise<{ ok: true; task: TaskView } | { ok: false; message: string }>;

  list(
    userId: string,
    options: { status?: TaskStatus; limit?: number }
  ): Promise<TaskView[]>;

  get(
    userId: string,
    taskId: string
  ): Promise<{ ok: true; task: TaskView } | { ok: false; message: string }>;

  updateStatus(
    userId: string,
    taskId: string,
    status: TaskStatus,
    error?: string
  ): Promise<{ ok: true; task: TaskView } | { ok: false; message: string }>;
}

abstract class TaskTool extends BaseTool {
  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[],
    permissions: ("read" | "write")[] = ["read"]
  ) {
    super(id, name, description, "system", parameters, false, permissions, "READ_ONLY", "1.0.0", true);
  }
}

/** Writes to JARVIS's own task store. Still no approval — see the header. */
abstract class TaskWriteTool extends BaseTool {
  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[]
  ) {
    super(id, name, description, "system", parameters, false, ["read", "write"], "LOW_IMPACT", "1.0.0", true);
  }
}

// ---------------------------------------------------------------------------
// task.create
// ---------------------------------------------------------------------------

export class TaskCreateTool extends TaskWriteTool {
  constructor(private readonly tasks: TaskPort) {
    super(
      "task.create",
      "Create Task",
      "Save a piece of work the user asked you to track or manage, so it survives this conversation. " +
        "Use it ONLY when they explicitly ask you to remember, track, manage or create a task — " +
        "not for ordinary questions, and not to take notes on your own initiative. " +
        "The task is recorded as pending; creating it does not start it and nothing runs it yet.",
      [
        { name: "title", type: "string", description: "Short name for the work, in the user's own words.", required: true },
        { name: "description", type: "string", description: "Any detail the user gave about what the work involves.", required: false },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const title = typeof params.title === "string" ? params.title.trim() : "";
    if (!title) return this.failure("A task needs a title.");

    const description =
      typeof params.description === "string" && params.description.trim()
        ? params.description.trim()
        : null;

    const result = await this.tasks.create(context.userId, {
      title,
      description,
      // Stamped so the audit trail — and the todo surfaces — can tell JARVIS's
      // own work apart from a task the user typed in themselves.
      createdBy: JARVIS_TASK_CREATOR,
    });

    if (!result.ok) return this.failure(result.message);

    return this.success(
      {
        task: result.task,
        // Said in the result rather than left to the model, so the reply cannot
        // imply the work has started.
        note: "Saved as a pending task. Nothing runs it automatically yet.",
      },
      { taskId: result.task.id }
    );
  }
}

// ---------------------------------------------------------------------------
// task.list
// ---------------------------------------------------------------------------

export class TaskListTool extends TaskTool {
  constructor(private readonly tasks: TaskPort) {
    super(
      "task.list",
      "List JARVIS Work",
      "Work you asked JARVIS to carry out — use for questions like what are you working on, " +
        "what work is pending, or what did JARVIS finish. Optionally filtered by status. " +
        "This is NOT the user's to-do list: for 'what is due', 'what's pending today' or " +
        "'what todos do I have', use tasks.list instead. " +
        "Never answer from memory or from earlier in the conversation.",
      [
        {
          name: "status",
          type: "string",
          description: "Optional filter: PENDING, RUNNING, COMPLETED or FAILED. Omit for all.",
          required: false,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = TaskStatusSchema.safeParse(
      typeof params.status === "string" ? params.status.toUpperCase() : undefined
    );

    // An unrecognised status is refused rather than silently ignored: quietly
    // returning every task for `status: "urgent"` would answer a question the
    // user did not ask.
    if (typeof params.status === "string" && params.status.trim() && !parsed.success) {
      return this.failure(
        `"${params.status}" is not a task status. Use PENDING, RUNNING, COMPLETED or FAILED.`
      );
    }

    const tasks = await this.tasks.list(context.userId, {
      ...(parsed.success ? { status: parsed.data } : {}),
      limit: 50,
    });

    // An empty list is a SUCCESS carrying zero rows. "You have nothing
    // outstanding" is a real answer, not a failure.
    return this.success({ tasks, count: tasks.length });
  }
}

// ---------------------------------------------------------------------------
// task.get
// ---------------------------------------------------------------------------

export class TaskGetTool extends TaskTool {
  constructor(private readonly tasks: TaskPort) {
    super(
      "task.get",
      "Get Task",
      "Read one task the user is tracking, by its id.",
      [{ name: "taskId", type: "string", description: "The task's id.", required: true }]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
    if (!taskId) return this.failure("A task id is required.");

    const result = await this.tasks.get(context.userId, taskId);
    if (!result.ok) return this.failure(result.message);
    return this.success({ task: result.task });
  }
}

// ---------------------------------------------------------------------------
// task.updateStatus
// ---------------------------------------------------------------------------

export class TaskUpdateStatusTool extends TaskWriteTool {
  constructor(private readonly tasks: TaskPort) {
    super(
      "task.updateStatus",
      "Update Task Status",
      "Move a task through its lifecycle: pending to running, then running to completed or failed. " +
        "Use it when the user says work has started, finished or failed. " +
        "A completed or failed task is final and cannot be moved again.",
      [
        { name: "taskId", type: "string", description: "The task's id.", required: true },
        { name: "status", type: "string", description: "RUNNING, COMPLETED or FAILED.", required: true },
        { name: "error", type: "string", description: "Why it failed. Only with FAILED.", required: false },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
    if (!taskId) return this.failure("A task id is required.");

    const parsed = TaskStatusSchema.safeParse(
      typeof params.status === "string" ? params.status.toUpperCase() : params.status
    );
    if (!parsed.success) {
      return this.failure("Status must be RUNNING, COMPLETED or FAILED.");
    }

    // PENDING is the state a task is CREATED in, not one it can be moved to.
    // Rejecting it here gives a clearer sentence than the lifecycle's generic
    // refusal, and the lifecycle still refuses it anyway.
    if (parsed.data === "PENDING") {
      return this.failure("A task cannot be moved back to pending.");
    }

    const error = typeof params.error === "string" ? params.error.trim() : undefined;

    const result = await this.tasks.updateStatus(
      context.userId,
      taskId,
      parsed.data,
      error && parsed.data === "FAILED" ? error : undefined
    );

    if (!result.ok) return this.failure(result.message);
    return this.success({ task: result.task });
  }
}

// ---------------------------------------------------------------------------

/** Every task tool, in registration order. */
export function createTaskTools(tasks: TaskPort): BaseTool[] {
  return [
    new TaskCreateTool(tasks),
    new TaskListTool(tasks),
    new TaskGetTool(tasks),
    new TaskUpdateStatusTool(tasks),
  ];
}

/** The ids, for the agent policy and for tests that assert registration. */
export const TASK_TOOL_IDS = [
  "task.create",
  "task.list",
  "task.get",
  "task.updateStatus",
] as const;
