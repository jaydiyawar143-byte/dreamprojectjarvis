// ---------------------------------------------------------------------------
// Core V1 — the task API.
//
//   POST   /api/v1/tasks             record a task (always PENDING)
//   GET    /api/v1/tasks             the caller's tasks, optionally by status
//   GET    /api/v1/tasks/:id         one task
//   PATCH  /api/v1/tasks/:id/status  move it through the lifecycle
//   POST   /api/v1/tasks/:id/plan    propose ONE tool call; runs nothing
//   POST   /api/v1/tasks/:id/execute run it once, through the ToolExecutor
//   POST   /api/v1/tasks/:id/schedule   run it ONCE at a future instant
//   DELETE /api/v1/tasks/:id/schedule   cancel that; the task survives
//
// THIS ROUTE DECIDES NOTHING. It reads the body, calls TaskService and
// translates the outcome into HTTP. Which transitions are legal lives in
// @jarvis/core, the ownership filter lives in the repository, and the service
// joins them — so this file and the `task.*` tools cannot drift into two
// different lifecycles.
//
// `req.auth.userId` is the owner, always. No handler reads a user id from the
// body, the query or the path, so there is no admin bypass to add later and no
// parameter a client could supply to reach another user's task. A task that
// does not belong to the caller answers 404, never 403: a distinct status
// would confirm that someone else's task exists.
//
// V1 records work, and — since Task Execution V1 — runs it on demand through
// the existing ToolExecutor. There is still no scheduler and no background
// worker: a task runs when someone asks for it, and not otherwise.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { JARVIS_TASK_CREATOR, TaskStatusSchema } from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import type { Container } from "../services/container.js";
import type { TaskFailureReason } from "../services/tasks/task-service.js";
import type { TaskExecutionRefusal } from "../services/tasks/task-execution-service.js";
import type { ScheduleRefusal } from "../services/tasks/task-scheduler-service.js";

/**
 * An ISO-8601 date-time that carries an explicit offset — `Z` or `±hh:mm`.
 *
 * Checked BEFORE `new Date()`, because `new Date()` accepts an offset-less
 * string happily and silently reads it in the process's zone. The colon in the
 * offset is required: `+0530` is legal ISO-8601 but its handling by `Date` is
 * implementation-defined, and this route's whole purpose is to be the path
 * with no ambiguity in it.
 */
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** One HTTP status per schedule refusal, in one place. */
const STATUS_FOR_SCHEDULE: Record<ScheduleRefusal, number> = {
  // Not yours, not work, or not PENDING — deliberately one answer, so this
  // cannot be used to probe another user's tasks.
  NOT_SCHEDULABLE: 404,
  INVALID_TIME: 400,
  ALREADY_SCHEDULED: 409,
};

/** One HTTP status per execution refusal, in one place. */
const STATUS_FOR_REFUSAL: Record<TaskExecutionRefusal, number> = {
  NOT_FOUND: 404,
  // Terminal or already running: the request was well formed and is simply
  // not applicable to this task now.
  NOT_EXECUTABLE: 409,
  ALREADY_CLAIMED: 409,
  // The tool named is not one this deployment can run for anybody.
  TOOL_NOT_ALLOWED: 400,
};

/** One HTTP status per failure reason, in one place. */
const STATUS_FOR: Record<TaskFailureReason, number> = {
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  // Someone moved it first. 409 as well: the request was valid when written
  // and is simply no longer applicable.
  STATE_CHANGED: 409,
};

export function createTasksRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  function ok(res: Response, data: unknown, status = 200): void {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
  }

  function fail(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({
      success: false,
      error: { code, message },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Every handler starts here.
   *
   * `requireAuth` has already rejected an unauthenticated request; this is the
   * type-level companion that stops a handler reading `req.auth!` and makes
   * the userId the only identity in scope.
   */
  function callerOf(req: AuthenticatedRequest, res: Response): string | null {
    if (!req.auth) {
      fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      return null;
    }
    return req.auth.userId;
  }

  // -------------------------------------------------------------------------
  // POST /  — record a task
  // -------------------------------------------------------------------------
  router.post(
    "/",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;

      const body = (req.body ?? {}) as { title?: unknown; description?: unknown };

      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        fail(res, 400, "INVALID_REQUEST", "A task needs a title.");
        return;
      }
      if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
        fail(res, 400, "INVALID_REQUEST", "description must be a string when given.");
        return;
      }

      const result = await container.taskService.createTask(userId, {
        title: body.title,
        description: typeof body.description === "string" ? body.description : null,
        // Core V1.1 — stamped, like the tool path.
        //
        // This endpoint IS the work surface: a row created here is work, not a
        // dashboard todo, regardless of whether a human or the model asked for
        // it. Leaving it null would put the task in the todo bucket — visible
        // in the Tasks widget and invisible to `task.list`, which is the worst
        // of both. Todos are created through /command-center/tasks, which still
        // writes null.
        createdBy: JARVIS_TASK_CREATOR,
      });

      if (!result.ok) {
        fail(res, 400, "INVALID_REQUEST", result.message);
        return;
      }

      ok(res, result.task, 201);
    })
  );

  // -------------------------------------------------------------------------
  // GET /  — the caller's tasks
  // -------------------------------------------------------------------------
  router.get(
    "/",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;

      const raw = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
      const parsed = TaskStatusSchema.safeParse(raw);

      // An unrecognised filter is refused rather than ignored: silently
      // returning everything for `?status=urgent` answers a different question.
      if (raw !== undefined && !parsed.success) {
        fail(res, 400, "INVALID_REQUEST", "status must be PENDING, RUNNING, COMPLETED or FAILED.");
        return;
      }

      const tasks = await container.taskService.listTasks(userId, {
        ...(parsed.success ? { status: parsed.data } : {}),
      });

      ok(res, { tasks, count: tasks.length });
    })
  );

  // -------------------------------------------------------------------------
  // GET /:id
  // -------------------------------------------------------------------------
  router.get(
    "/:id",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;

      const result = await container.taskService.getTask(userId, req.params.id ?? "");
      if (!result.ok) {
        fail(res, STATUS_FOR[result.reason], result.reason, result.message);
        return;
      }
      ok(res, result.task);
    })
  );

  // -------------------------------------------------------------------------
  // PATCH /:id/status  — the lifecycle
  // -------------------------------------------------------------------------
  router.patch(
    "/:id/status",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;

      const body = (req.body ?? {}) as { status?: unknown; error?: unknown };
      const parsed = TaskStatusSchema.safeParse(
        typeof body.status === "string" ? body.status.toUpperCase() : body.status
      );

      if (!parsed.success) {
        fail(res, 400, "INVALID_REQUEST", "status must be RUNNING, COMPLETED or FAILED.");
        return;
      }
      // PENDING is where a task STARTS, not somewhere it can be moved to. The
      // lifecycle refuses it anyway; saying so here is just a clearer sentence.
      if (parsed.data === "PENDING") {
        fail(res, 400, "INVALID_REQUEST", "A task cannot be moved back to pending.");
        return;
      }

      const taskId = req.params.id ?? "";
      const error = typeof body.error === "string" ? body.error : undefined;

      const result =
        parsed.data === "RUNNING"
          ? await container.taskService.startTask(userId, taskId)
          : parsed.data === "COMPLETED"
            ? await container.taskService.completeTask(userId, taskId)
            : await container.taskService.failTask(userId, taskId, error);

      if (!result.ok) {
        fail(res, STATUS_FOR[result.reason], result.reason, result.message);
        return;
      }

      ok(res, result.task);
    })
  );

  // -------------------------------------------------------------------------
  // POST /:id/execute  — run it once
  // -------------------------------------------------------------------------
  //
  // The tool call is supplied HERE, by the caller, not read from the task: a
  // Task row holds free text, and this codebase does not derive tool names
  // from data. See task-execution-service.ts for the full reasoning and the
  // limitation it implies.
  //
  // `role` comes from the authenticated session and is never read from the
  // body, so a task cannot be used to run something as a role the caller does
  // not hold.
  router.post(
    "/:id/execute",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId || !req.auth) return;

      const body = (req.body ?? {}) as { toolId?: unknown; params?: unknown };

      if (typeof body.toolId !== "string" || body.toolId.trim().length === 0) {
        fail(res, 400, "INVALID_REQUEST", "toolId is required to execute a task.");
        return;
      }
      if (
        body.params !== undefined &&
        (typeof body.params !== "object" || body.params === null || Array.isArray(body.params))
      ) {
        fail(res, 400, "INVALID_REQUEST", "params must be an object when given.");
        return;
      }

      const outcome = await container.taskExecution.executeTask(userId, req.params.id ?? "", {
        toolId: body.toolId.trim(),
        params: (body.params ?? {}) as Record<string, unknown>,
        role: req.auth.role,
        ...(req.ip ? { ipAddress: req.ip } : {}),
      });

      if (!outcome.ok) {
        fail(res, STATUS_FOR_REFUSAL[outcome.refusal], outcome.refusal, outcome.message);
        return;
      }

      // 200 even when the TOOL failed: the execution itself was carried out
      // and its result is the answer. The task's own status is what says
      // whether the work succeeded, so the caller reads that rather than the
      // HTTP code.
      ok(res, {
        task: outcome.task,
        execution: {
          executionId: outcome.execution.executionId,
          toolId: outcome.execution.toolId,
          status: outcome.execution.status,
          ...(outcome.execution.error ? { error: outcome.execution.error } : {}),
        },
      });
    })
  );

  // -------------------------------------------------------------------------
  // POST /:id/plan  — propose one action
  // -------------------------------------------------------------------------
  //
  // Reads the task, asks the planner for ONE tool call, returns it. It does
  // not execute and it does not move the task: planning a PENDING task leaves
  // it PENDING, and only `executeTask` may claim it. That separation is what
  // lets a caller see a proposal before anything happens.
  router.post(
    "/:id/plan",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;

      // Ownership first, through the same service every other handler uses.
      const found = await container.taskService.getTask(userId, req.params.id ?? "");
      if (!found.ok) {
        fail(res, STATUS_FOR[found.reason], found.reason, found.message);
        return;
      }

      const plan = await container.taskPlanner.planTask({
        userId,
        taskId: found.task.id,
        title: found.task.title,
        description: found.task.description,
      });

      // 200 for both outcomes: "no action fits this task" is a successful
      // planning result, not a request error.
      ok(res, { plan });
    })
  );

  // -------------------------------------------------------------------------
  // POST /:id/schedule  — run it once, later
  // -------------------------------------------------------------------------
  //
  // `scheduledAt` is an ISO-8601 timestamp and an OFFSET is REQUIRED (…Z or
  // ±hh:mm). This application has no user-timezone system, so an offset is the
  // only way a client can state an instant unambiguously.
  //
  // It is required rather than merely expected, because the alternative is
  // silent: per the ECMAScript spec a date-time string WITHOUT an offset is
  // parsed as the PROCESS's local time, so "2026-09-22T23:30:00" means a
  // different instant on a UTC container than on an IST one — and neither the
  // client nor the server would ever say so. A schedule that quietly means
  // something else five and a half hours away is exactly the failure this
  // route is the unambiguous path around, so it refuses instead of guessing.
  //
  // Scheduling runs nothing. The task stays PENDING until the sweep claims it.
  router.post(
    "/:id/schedule",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;

      const body = (req.body ?? {}) as { scheduledAt?: unknown; replace?: unknown };
      if (typeof body.scheduledAt !== "string" || body.scheduledAt.trim().length === 0) {
        fail(res, 400, "INVALID_REQUEST", "scheduledAt is required, as an ISO-8601 timestamp.");
        return;
      }

      if (!ISO_WITH_OFFSET.test(body.scheduledAt.trim())) {
        fail(
          res,
          400,
          "INVALID_REQUEST",
          "scheduledAt must be an ISO-8601 timestamp with an explicit offset, " +
            "such as 2026-09-22T23:30:00+05:30 or 2026-09-22T18:00:00Z."
        );
        return;
      }

      const at = new Date(body.scheduledAt);
      if (Number.isNaN(at.getTime())) {
        fail(res, 400, "INVALID_REQUEST", "scheduledAt is not a valid ISO-8601 timestamp.");
        return;
      }

      const result = await container.taskScheduler.scheduleTask(userId, req.params.id ?? "", at, {
        replace: body.replace === true,
      });

      if (!result.ok) {
        fail(res, STATUS_FOR_SCHEDULE[result.refusal], result.refusal, result.message);
        return;
      }

      ok(res, {
        task: result.task,
        scheduledAt: result.task.scheduledAt?.toISOString() ?? null,
      });
    })
  );

  // -------------------------------------------------------------------------
  // DELETE /:id/schedule  — cancel a future run
  // -------------------------------------------------------------------------
  //
  // Clears the schedule only. The task is NOT deleted, stays PENDING, and can
  // be scheduled again. A RUNNING task is refused by the same PENDING filter,
  // so this can never interrupt work in flight.
  router.delete(
    "/:id/schedule",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;

      const result = await container.taskScheduler.cancelScheduledTask(
        userId,
        req.params.id ?? ""
      );

      if (!result.ok) {
        fail(res, STATUS_FOR_SCHEDULE[result.refusal], result.refusal, result.message);
        return;
      }

      ok(res, { task: result.task, scheduledAt: null });
    })
  );

  return router;
}
