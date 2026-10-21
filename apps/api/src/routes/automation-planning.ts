// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — workflow planning (`/api/v1/n8n/planning`).
//
//   POST /match                       rank the library against a request
//   GET  /drafts                      the organization's drafts
//   POST /drafts                      a new draft (201), or the same one again (200)
//   GET  /drafts/:draftId             a draft — ?version=N for an earlier one
//   POST /drafts/:draftId/versions    a new version from { baseVersion, … }
//
// THE ROUTER DECIDES NOTHING. It authenticates, counts attempts, refuses a
// field that names a scope, and hands the body — unchanged — to the one
// `AutomationPlanningService`, which the JARVIS tools are given too. Core's
// rules check the request there, so the page and a sentence are refused in the
// same words.
//
// NOTHING HERE REACHES n8n, and there is no endpoint that deploys, activates,
// runs, publishes or edits a workflow.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { LIBRARY_SCOPE_REFUSED_MESSAGE, namesLibraryServerScope, type PlanningResult } from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import type { Container } from "../services/container.js";
import { IpRateLimiter, type IpRateLimitRule } from "../services/ip-rate-limiter.js";

/** Attempts per account, per kind, per minute — counted before the database. */
export const PLANNING_ATTEMPT_LIMITS = {
  read: { limit: 120, windowMs: 60_000 },
  write: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<"read" | "write", IpRateLimitRule>;

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}

function send<T>(res: Response, result: PlanningResult<T>, status = 200): void {
  if (result.ok) {
    ok(res, result.value, status);
    return;
  }
  res.status(result.status).json({
    success: false,
    error: { code: result.code, message: result.message, ...(result.issues ? { issues: result.issues } : {}) },
    timestamp: new Date().toISOString(),
  });
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message }, timestamp: new Date().toISOString() });
}

export function createAutomationPlanningRouter(
  container: Pick<Container, "tokenService" | "automationPlanning">,
  deps: { now?: () => Date } = {}
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const planning = container.automationPlanning;
  const now = deps.now ?? (() => new Date());
  const attempts = new IpRateLimiter(() => now().getTime());

  const admit = (req: AuthenticatedRequest, res: Response, bucket: "read" | "write"): string | null => {
    const userId = req.auth?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      return null;
    }
    const attempt = attempts.check(`automation_planning:${bucket}:${userId}`, PLANNING_ATTEMPT_LIMITS[bucket]);
    if (!attempt.allowed) {
      res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
      fail(res, 429, "RATE_LIMITED", "Too many workflow planning requests; retry later");
      return null;
    }
    if ([req.query, req.body].some(namesLibraryServerScope)) {
      fail(res, 400, "REQUEST_SCOPE_REFUSED", LIBRARY_SCOPE_REFUSED_MESSAGE);
      return null;
    }
    return userId;
  };

  router.post(
    "/match",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "read");
      if (!userId) return;
      send(res, await planning.match(userId, req.body ?? {}, { via: "api" }));
    })
  );

  router.get(
    "/drafts",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "read");
      if (!userId) return;
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        fail(res, 400, "INVALID_REQUEST", "Use page (1 or more) and limit (1 to 50).");
        return;
      }
      send(res, await planning.listDrafts(userId, { page, limit }));
    })
  );

  router.post(
    "/drafts",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "write");
      if (!userId) return;
      const result = await planning.createDraft(userId, req.body ?? {}, { via: "api" });
      send(res, result, result.ok && !result.value.existing ? 201 : 200);
    })
  );

  router.get(
    "/drafts/:draftId",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "read");
      if (!userId) return;
      const raw = req.query.version;
      if (raw !== undefined && (typeof raw !== "string" || !/^\d{1,6}$/.test(raw))) {
        fail(res, 400, "INVALID_REQUEST", "version is a whole number from 1.");
        return;
      }
      send(res, await planning.getDraft(userId, req.params.draftId ?? "", raw === undefined ? undefined : Number(raw)));
    })
  );

  router.post(
    "/drafts/:draftId/versions",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "write");
      if (!userId) return;
      const result = await planning.reviseDraft(userId, req.params.draftId ?? "", req.body ?? {}, { via: "api" });
      send(res, result, result.ok && !result.value.unchanged ? 201 : 200);
    })
  );

  return router;
}
