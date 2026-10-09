// ---------------------------------------------------------------------------
// Phase 14 — the project API.
//
//   GET   /api/v1/projects    the caller's own projects, by name
//   POST  /api/v1/projects    create one: { name, description? }
//
// A project is a scope for memory and nothing more. `req.auth.userId` is the
// owner, always: no handler reads a user id from the body, the query or the
// path.
//
// There is no delete and no rename here on purpose. Deleting a project deletes
// its memories, which is a destructive act on memory and would need the same
// confirmation a forget does; Phase 14 does not ask for it.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import type { ITokenService, Project } from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";

export interface ProjectsRouterDeps {
  tokenService: ITokenService;
  projects: {
    list(userId: string): Promise<Project[]>;
    create(userId: string, input: { name: string; description?: string | null }): Promise<Project>;
  };
}

/** What a client is shown of a project: never the owner's id. */
function view(project: Project) {
  return { id: project.id, name: project.name, description: project.description, createdAt: project.createdAt, updatedAt: project.updatedAt };
}

export function createProjectsRouter(container: ProjectsRouterDeps): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  function ok(res: Response, data: unknown, status = 200): void {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
  }

  function fail(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({ success: false, error: { code, message }, timestamp: new Date().toISOString() });
  }

  router.get(
    "/",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      ok(res, { projects: (await container.projects.list(req.auth.userId)).map(view) });
    })
  );

  router.post(
    "/",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      if (typeof body.name !== "string") return fail(res, 400, "INVALID_REQUEST", "A project needs a name.");
      if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
        return fail(res, 400, "INVALID_REQUEST", "description must be a string when given.");
      }
      // Length, the per-user limit and a duplicate name are the repository's
      // to refuse; they arrive here as INVALID_REQUEST through the error handler.
      const project = await container.projects.create(req.auth.userId, { name: body.name, description: body.description ?? null });
      ok(res, { project: view(project) }, 201);
    })
  );

  return router;
}
