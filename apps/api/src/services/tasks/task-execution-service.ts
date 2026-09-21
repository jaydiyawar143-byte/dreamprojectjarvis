// ---------------------------------------------------------------------------
// TaskExecutionService — Task Execution V1.
//
//   PENDING -> RUNNING -> [ the existing ToolExecutor ] -> COMPLETED | FAILED
//
// This service owns the SEQUENCE. It owns no execution machinery of its own:
// the permission check, the approval gate, the deadline, the execution journal
// and the audit row all belong to `ToolExecutor`, and every state change
// belongs to `TaskService`. What lives here is the order those two are called
// in, and the mapping between them.
//
// WHY THE TOOL CALL IS NOT READ FROM THE TASK.
//
// A `Task` row carries `title` and `description` — free text written by a
// person or produced by a model. It has no `toolId` and no `params`. Deriving
// a tool name from that text is precisely what this codebase already refuses
// to do elsewhere: `recommendation-bridge.ts` resolves its tool through a
// closed allowlist keyed on a TYPED `actionType`, under the comment "tool
// names NEVER derive from data". A recommendation can be executed because it
// was built with an executable shape; a task was not.
//
// So V1 takes the tool call from the CALLER, explicitly, and the task supplies
// only identity and lifecycle. That is the whole of the deliberate limitation:
// JARVIS can execute a task, but it cannot yet decide what a task means. There
// is no planner here and no inference from text — adding one is a later phase
// with its own safety argument.
//
// WHAT THIS CANNOT BECOME. A task is not a privilege. The executor is handed
// the AUTHENTICATED CALLER'S role, never a role stored on the task, so running
// work through a task reaches exactly the tools that caller could already
// reach — no more. The extra allowlist check below narrows that further.
// ---------------------------------------------------------------------------

import type { Role, ToolExecutionResult } from "@jarvis/core";
import type { IToolExecutor } from "@jarvis/core";
import type { TaskRecord } from "@jarvis/db";
import type { TaskService } from "./task-service.js";

/**
 * The tool call to run for this task.
 *
 * Supplied by the caller, not by the task. `role` comes from the authenticated
 * session at the route — it is deliberately part of this type rather than read
 * from a stored field, so there is no way to express "run this as someone
 * else".
 */
export interface TaskExecutionRequest {
  toolId: string;
  params: Record<string, unknown>;
  /** The AUTHENTICATED caller's role. Never a value from a request body. */
  role: Role;
  traceId?: string;
  agentId?: string;
  conversationId?: string;
  ipAddress?: string;
}

/** Why a task could not be executed, before the executor was ever reached. */
export type TaskExecutionRefusal =
  /** No such task for this caller — also the answer for another user's task. */
  | "NOT_FOUND"
  /** Terminal, already running, or otherwise not in PENDING. */
  | "NOT_EXECUTABLE"
  /** Lost the race to claim it. Another execution has it. */
  | "ALREADY_CLAIMED"
  /** The named tool is not one any agent may call on this deployment. */
  | "TOOL_NOT_ALLOWED";

export type TaskExecutionOutcome =
  | {
      ok: true;
      /** COMPLETED or FAILED — the task's state after the run. */
      task: TaskRecord;
      execution: ToolExecutionResult;
    }
  | {
      ok: false;
      refusal: TaskExecutionRefusal;
      message: string;
      /** Present when the refusal was about the task's state. */
      task?: TaskRecord;
    };

export interface TaskExecutionDeps {
  tasks: TaskService;
  executor: IToolExecutor;
  /**
   * Tool ids some agent policy grants.
   *
   * The SAME set CapabilityService is built with, so "what JARVIS can do" and
   * "what a task may run" cannot diverge. A registered tool that no policy
   * grants is unreachable in conversation, and a task must not be the loophole
   * that reaches it. This narrows the caller's reach; it never widens it —
   * ToolExecutor still runs every one of its own checks afterwards.
   */
  allowedToolIds: ReadonlySet<string>;
}

export class TaskExecutionService {
  constructor(private readonly deps: TaskExecutionDeps) {}

  /**
   * Run one PENDING task, once.
   *
   * The order matters and is the point of this method:
   *
   *   1. ownership          TaskService.getTask (404-shaped for a stranger)
   *   2. executability      PENDING only; terminal and RUNNING are refused
   *   3. tool admissibility checked BEFORE the claim, so a bad request does
   *                         not leave a task stranded in RUNNING
   *   4. atomic claim       TaskService.startTask — compare-and-set on status
   *   5. execution          ToolExecutor, with the CALLER's role
   *   6. settle             TaskService.completeTask / failTask
   *
   * Steps 4 and 6 are the only writes, and both go through TaskService, so the
   * transition rules in @jarvis/core apply to an executed task exactly as they
   * apply to one moved by hand.
   */
  async executeTask(
    userId: string,
    taskId: string,
    request: TaskExecutionRequest
  ): Promise<TaskExecutionOutcome> {
    // 1. Ownership. Indistinguishable from "no such task" on purpose.
    const found = await this.deps.tasks.getTask(userId, taskId);
    if (!found.ok) {
      return { ok: false, refusal: "NOT_FOUND", message: "No such task." };
    }

    // 2. Only PENDING work runs. COMPLETED and FAILED are terminal in V1 —
    //    there is no retry — and RUNNING is already someone else's.
    if (found.task.status !== "PENDING") {
      return {
        ok: false,
        refusal: "NOT_EXECUTABLE",
        message: `This task is ${found.task.status.toLowerCase()} and cannot be executed.`,
        task: found.task,
      };
    }

    // 3. Admissibility BEFORE the claim.
    //
    //    Deliberately ordered this way: refusing after the claim would leave
    //    the task RUNNING with nothing running it, and RUNNING is terminal in
    //    practice for V1 because nothing can move it back.
    if (!this.deps.allowedToolIds.has(request.toolId)) {
      return {
        ok: false,
        refusal: "TOOL_NOT_ALLOWED",
        message: `"${request.toolId}" is not a tool this deployment can run.`,
        task: found.task,
      };
    }

    // 4. The claim. This is the whole of the concurrency control: `startTask`
    //    goes through `transitionOwned`, whose WHERE clause pins the current
    //    status, so two callers arriving together produce exactly one winner
    //    and the loser matches zero rows. No read-then-write, no lock held in
    //    this process, and nothing here needs to know it raced.
    const claimed = await this.deps.tasks.startTask(userId, taskId);
    if (!claimed.ok) {
      return {
        ok: false,
        refusal: "ALREADY_CLAIMED",
        message:
          claimed.reason === "STATE_CHANGED"
            ? "This task was claimed by another execution."
            : claimed.message,
      };
    }

    // 5. The ONLY side-effect path. Everything that makes a tool call safe is
    //    inside this call: registry lookup, parameter validation, the
    //    permission check against the CALLER'S role, the approval gate, the
    //    shutdown gate, the deadline, the journal and the audit row.
    const execution = await this.deps.executor.execute({
      toolId: request.toolId,
      params: request.params,
      userId,
      role: request.role,
      traceId: request.traceId ?? crypto.randomUUID(),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      ...(request.ipAddress ? { ipAddress: request.ipAddress } : {}),
    });

    // 6. Settle. A run that did not produce a successful result is a failure,
    //    whatever shape it arrived in.
    const succeeded = execution.status === "completed" && execution.result?.success === true;

    if (succeeded) {
      const done = await this.deps.tasks.completeTask(userId, taskId);
      return done.ok
        ? { ok: true, task: done.task, execution }
        : // The task moved under us after a successful run. The work HAPPENED;
          // reporting the execution is more honest than reporting a failure.
          { ok: true, task: found.task, execution };
    }

    const failed = await this.deps.tasks.failTask(userId, taskId, this.describeFailure(execution));
    return failed.ok
      ? { ok: true, task: failed.task, execution }
      : { ok: true, task: found.task, execution };
  }

  /**
   * One sentence for the `error` column, in the user's terms.
   *
   * An approval-gated tool is the case worth naming: the executor did NOT run
   * it, so nothing happened outside JARVIS — but V1 has no PENDING_APPROVAL
   * state and no retry, so the task becomes FAILED and the message has to say
   * what to do instead of just "failed".
   */
  private describeFailure(execution: ToolExecutionResult): string {
    if (execution.status === "approval_pending" || execution.status === "approval_required") {
      return (
        "This action needs your approval before it can run, so the task was not executed. " +
        "Approve it on the Approvals page, then run the action from there."
      );
    }
    if (execution.status === "permission_denied") {
      return execution.error ?? "You do not have permission to run this action.";
    }
    if (execution.status === "timed_out") {
      return "The action took too long and was stopped.";
    }
    return execution.error ?? execution.result?.error ?? "The action did not complete.";
  }
}
