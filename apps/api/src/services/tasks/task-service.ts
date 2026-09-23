// ---------------------------------------------------------------------------
// TaskService — Core V1.
//
// The first durable thing JARVIS owns that is not a message, a tool call or an
// approval: a piece of work the user asked it to keep hold of.
//
// WHERE THE RULES LIVE. The legal transitions are in @jarvis/core
// (`canTransitionTask`), the ownership filter and the compare-and-set are in
// PrismaTaskRepository, and this service is what joins them: it validates the
// move, then asks for it under a guard. The REST route and the task tools both
// call this, so "a task cannot go from COMPLETED back to RUNNING" is one rule
// with one implementation rather than one per surface.
//
// EVERY METHOD TAKES userId FIRST and passes it down. There is no method here
// that can read or move another user's task, because the repository has none —
// the tenant boundary is the same one the rest of the codebase uses.
//
// WHAT THIS DOES NOT DO. It does not run anything. Creating a task records
// intent; `start` records that something began, and a human or a later slice
// is what actually begins it. There is no scheduler, no queue and no
// background execution in Core V1, and nothing here should read as if a
// PENDING task were on its way to being done.
// ---------------------------------------------------------------------------

import {
  canTransitionTask,
  describeInvalidTaskTransition,
  JARVIS_TASK_CREATOR,
  type TaskStatus,
} from "@jarvis/core";
import type { PrismaTaskRepository, TaskRecord } from "@jarvis/db";

/** Why a task operation could not be performed. */
export type TaskFailureReason =
  /** No such task for this user. Also the answer for another user's task. */
  | "NOT_FOUND"
  /** The move is not one the lifecycle allows. */
  | "INVALID_TRANSITION"
  /** Someone else moved it first; the caller's view was stale. */
  | "STATE_CHANGED";

export type TaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: TaskFailureReason; message: string; current?: TaskStatus };

export interface CreateTaskRequest {
  title: string;
  description?: string | null;
  /**
   * Which agent or surface created it. Recorded on the row, and the existing
   * `createdBy` column is what distinguishes JARVIS work from a hand-written
   * todo without needing a new discriminator.
   */
  createdBy?: string | null;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  limit?: number;
}

export interface TaskServiceDeps {
  tasks: Pick<
    PrismaTaskRepository,
    "create" | "list" | "listByStatus" | "findOwned" | "transitionOwned"
  >;
}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_ERROR = 1000;

export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  /**
   * Records a new task. Always PENDING — a task cannot be created already
   * running, because nothing has run.
   */
  async createTask(userId: string, input: CreateTaskRequest): Promise<TaskResult> {
    const title = input.title.trim();
    if (title.length === 0) {
      return { ok: false, reason: "NOT_FOUND", message: "A task needs a title." };
    }

    const task = await this.deps.tasks.create(userId, {
      title: title.slice(0, MAX_TITLE),
      description: input.description ? input.description.slice(0, MAX_DESCRIPTION) : null,
      createdBy: input.createdBy ?? null,
    });

    return { ok: true, task };
  }

  async getTask(userId: string, taskId: string): Promise<TaskResult> {
    const task = await this.deps.tasks.findOwned(userId, taskId);
    if (!task) return this.notFound();
    return { ok: true, task };
  }

  /**
   * A user's tasks.
   *
   * With no status filter this includes completed ones, because the caller
   * asked for the task list and a finished task is part of it. The existing
   * todo surfaces keep their own default (outstanding only); that behaviour is
   * untouched.
   */
  async listTasks(userId: string, options: ListTasksOptions = {}): Promise<TaskRecord[]> {
    // Core V1.1 — WORK only, selected positively rather than inferred.
    //
    // Filtering on `createdBy` instead of on `completedAt` is what makes this
    // and the todo surfaces read disjoint sets: a dashboard todo is not work
    // JARVIS was asked to carry out, and listing one here would answer "what
    // are you working on?" with the user's shopping list.
    if (options.status) {
      return this.deps.tasks.listByStatus(userId, options.status, options.limit ?? 50, {
        createdBy: JARVIS_TASK_CREATOR,
      });
    }
    // Completed work stays listed: "what did you finish?" is a question this
    // surface has to be able to answer.
    return this.deps.tasks.list(userId, {
      includeCompleted: true,
      limit: options.limit ?? 50,
      createdBy: JARVIS_TASK_CREATOR,
    });
  }

  /** PENDING -> RUNNING. */
  async startTask(
    userId: string,
    taskId: string,
    options: { executionId?: string } = {}
  ): Promise<TaskResult> {
    // V2.1 - the caller may name the execution it is about to start. Written
    // in the SAME statement as PENDING -> RUNNING, so a RUNNING task always
    // carries the id of the run that claimed it.
    return this.move(userId, taskId, "RUNNING", undefined, options);
  }

  /** RUNNING -> COMPLETED. */
  async completeTask(userId: string, taskId: string): Promise<TaskResult> {
    return this.move(userId, taskId, "COMPLETED");
  }

  /** RUNNING -> FAILED, with a reason the user can read. */
  async failTask(userId: string, taskId: string, error?: string): Promise<TaskResult> {
    return this.move(userId, taskId, "FAILED", error);
  }

  /**
   * RUNNING -> UNRESOLVED. V2.3.
   *
   * For a run whose outcome cannot be established. The `reason` is shown to
   * the user and should say what is unknown, not guess at it - the whole
   * point of this state is that it makes no claim about whether the external
   * side effect happened.
   *
   * This is the lifecycle primitive only. NOTHING calls it automatically:
   * detecting an ambiguous run is V2.3 Phase 2, and is not implemented.
   */
  async unresolveTask(userId: string, taskId: string, reason?: string): Promise<TaskResult> {
    return this.move(userId, taskId, "UNRESOLVED", reason);
  }

  /**
   * The one place a lifecycle move happens.
   *
   * Validates against the rule in core, then writes under a compare-and-set on
   * the CURRENT status. The second check is not redundant: between reading and
   * writing, another request may have moved the task, and the repository guard
   * is what makes the loser of that race fail instead of overwriting.
   */
  private async move(
    userId: string,
    taskId: string,
    to: TaskStatus,
    error?: string,
    options: { executionId?: string } = {}
  ): Promise<TaskResult> {
    const existing = await this.deps.tasks.findOwned(userId, taskId);
    if (!existing) return this.notFound();

    if (!canTransitionTask(existing.status, to)) {
      return {
        ok: false,
        reason: "INVALID_TRANSITION",
        message: describeInvalidTaskTransition(existing.status, to),
        current: existing.status,
      };
    }

    const result = await this.deps.tasks.transitionOwned(userId, taskId, existing.status, to, {
      error: error ? error.slice(0, MAX_ERROR) : null,
      ...(options.executionId !== undefined ? { executionId: options.executionId } : {}),
    });

    if (result.ok) return { ok: true, task: result.task };
    if (result.reason === "not_found") return this.notFound();

    return {
      ok: false,
      reason: "STATE_CHANGED",
      message: result.current
        ? `This task is now ${result.current.toLowerCase()}; it changed while the request was in flight.`
        : "This task changed while the request was in flight.",
      ...(result.current ? { current: result.current } : {}),
    };
  }

  /**
   * One sentence for "no such task" and "not yours" alike.
   *
   * Deliberately indistinguishable, matching the repository: a different
   * message for someone else's task would confirm that it exists.
   */
  private notFound(): TaskResult {
    return { ok: false, reason: "NOT_FOUND", message: "No such task." };
  }
}
