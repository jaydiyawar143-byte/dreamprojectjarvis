// ---------------------------------------------------------------------------
// Phase 11.6B — Recommendations API Route
//
//   POST   /api/v1/recommendations           create recommendation
//   GET    /api/v1/recommendations/:id        get recommendation (owner-scoped)
//   GET    /api/v1/recommendations            list user's recommendations
//   POST   /api/v1/recommendations/:id/execute execute approved recommendation
//
// Security:
//  - All operations scoped to req.auth.userId — IDOR-safe.
//  - Execution only allowed after human approval consumed via ApprovalService.
//  - RecommendationExecutionService enforces paramsHash + stateHash.
//  - Secrets (tokens, keys) never logged or returned.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import {
  RecommendationExecutionService,
  createExecutorBackedExternalStatePort,
} from "@jarvis/tools";
import {
  PrismaOutcomeRepository,
  PrismaRecommendationRepository,
  prisma,
} from "@jarvis/db";
import type { Role } from "@jarvis/core";

function fail(
  res: Response,
  status: number,
  code: string,
  message: string
): void {
  res.status(status).json({
    success: false,
    error: { code, message },
    timestamp: new Date().toISOString(),
  });
}

function isValidId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

export function createRecommendationsRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const recommendationRepo = new PrismaRecommendationRepository(prisma);
  // R-32 — where an executed recommendation's outcome record is persisted.
  // Creation happens inside RecommendationExecutionService, after the
  // advertising write has already succeeded, and can never fail the write.
  const outcomeRepo = new PrismaOutcomeRepository(prisma);

  // GET /api/v1/recommendations — list own recommendations
  router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const { userId } = req.auth;

    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = parseInt(String(req.query.limit ?? "20"), 10);

    try {
      const result = await recommendationRepo.listByUser(userId, {
        accountId,
        status: statusFilter as never,
        limit,
      });
      res.json({ success: true, ...result, timestamp: new Date().toISOString() });
    } catch (err) {
      fail(res, 500, "INTERNAL_ERROR", "Failed to list recommendations");
    }
  });

  // GET /api/v1/recommendations/:id — get specific recommendation
  router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const { userId } = req.auth;

    if (!isValidId(req.params.id)) {
      return fail(res, 400, "INVALID_ID", "Invalid recommendation ID");
    }

    try {
      const rec = await recommendationRepo.getForUser(req.params.id, userId);
      if (!rec) return fail(res, 404, "NOT_FOUND", "Recommendation not found");
      res.json({ success: true, recommendation: rec, timestamp: new Date().toISOString() });
    } catch (err) {
      fail(res, 500, "INTERNAL_ERROR", "Failed to fetch recommendation");
    }
  });

  // POST /api/v1/recommendations/:id/execute — execute an approved recommendation
  router.post("/:id/execute", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const { userId } = req.auth;

    if (!isValidId(req.params.id)) {
      return fail(res, 400, "INVALID_ID", "Invalid recommendation ID");
    }

    const role: Role = (req.auth.role ?? "member") as Role;
    const traceId = String(req.headers["x-trace-id"] ?? crypto.randomUUID());
    const ipAddress = String(req.ip ?? "");
    const dryRun = req.query.dryRun === "true";

    // Build executor-backed live-state port (READ-ONLY: no direct Meta client)
    const stateOf = createExecutorBackedExternalStatePort({
      executor: container.executor,
      userId,
      role,
    });

    const executionService = new RecommendationExecutionService({
      executor: container.executor,
      recommendations: recommendationRepo,
      journal: container.executionJournal,
      stateOf,
      audit: container.auditLogger,
      // R-32 — outcome records are created here, on the real execution path.
      outcomes: outcomeRepo,
    });

    try {
      const outcome = await executionService.execute({
        recommendationId: req.params.id,
        userId,
        role,
        traceId,
        ipAddress,
        dryRun,
      });

      switch (outcome.status) {
        case "EXECUTED":
          return res.status(200).json({
            success: true,
            outcome,
            timestamp: new Date().toISOString(),
          });

        case "DRY_RUN_OK":
          return res.status(200).json({
            success: true,
            outcome,
            timestamp: new Date().toISOString(),
          });

        case "APPROVAL_PENDING":
          return res.status(202).json({
            success: false,
            outcome,
            message: "Approval required before execution",
            timestamp: new Date().toISOString(),
          });

        case "STALE_RECOMMENDATION":
        case "PARAMS_HASH_MISMATCH":
          return res.status(409).json({
            success: false,
            outcome,
            timestamp: new Date().toISOString(),
          });

        case "RECOMMENDATION_NOT_FOUND":
          return fail(res, 404, outcome.status, "Recommendation not found");

        case "RECOMMENDATION_EXPIRED":
        case "ALREADY_EXECUTED":
          return fail(res, 410, outcome.status, "Recommendation no longer executable");

        case "AUTHORIZATION_DENIED":
          return fail(res, 403, outcome.status, "Not authorized for this account");

        case "PERMISSION_DENIED":
          return fail(res, 403, outcome.status, (outcome as { detail: string }).detail);

        case "AMBIGUOUS_OUTCOME":
          return res.status(202).json({
            success: false,
            outcome,
            message: "Outcome ambiguous — reconciliation will resolve",
            timestamp: new Date().toISOString(),
          });

        default:
          return res.status(422).json({
            success: false,
            outcome,
            timestamp: new Date().toISOString(),
          });
      }
    } catch (err) {
      fail(res, 500, "INTERNAL_ERROR", "Execution failed unexpectedly");
    }
  });

  return router;
}
