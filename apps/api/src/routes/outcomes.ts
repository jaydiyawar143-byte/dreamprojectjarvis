// ---------------------------------------------------------------------------
// Phase 11.7B — Outcomes API Route
//
//   GET   /api/v1/recommendations/:id/outcome   get outcome for recommendation
//   GET   /api/v1/outcomes/:id                  get specific outcome record
//
// Security:
//  - All operations scoped to req.auth.userId — IDOR-safe.
//  - Account authorization and user ownership strictly verified.
//  - Revisions list is paginated.
//  - No mutation endpoints allowed.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import { PrismaOutcomeRepository } from "@jarvis/db";
import { PrismaRecommendationRepository } from "@jarvis/db";
import { prisma } from "@jarvis/db";

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

export function createOutcomesRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const outcomeRepo = new PrismaOutcomeRepository(prisma);
  const recommendationRepo = new PrismaRecommendationRepository(prisma);

  // GET /api/v1/recommendations/:id/outcome
  router.get(
    "/recommendations/:id/outcome",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
      const { userId } = req.auth;

      if (!isValidId(req.params.id)) {
        return fail(res, 400, "INVALID_ID", "Invalid recommendation ID");
      }

      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "10"), 10), 1), 100);
      const page = Math.max(parseInt(String(req.query.page ?? "1"), 10), 1);
      const offset = (page - 1) * limit;

      try {
        // Enforce user ownership on the recommendation first (IDOR check)
        const rec = await recommendationRepo.getForUser(req.params.id, userId);
        if (!rec) {
          return fail(res, 404, "NOT_FOUND", "Recommendation not found or access denied");
        }

        // Fetch outcome associated with this recommendation
        const outcome = await outcomeRepo.getByRecommendation(req.params.id, userId);
        if (!outcome) {
          return fail(res, 404, "NOT_FOUND", "Outcome not found for this recommendation");
        }

        // Fetch paginated revisions
        const revisions = await outcomeRepo.getRevisions(outcome.outcomeId, userId, {
          limit,
          offset,
        });

        res.json({
          success: true,
          outcome,
          history: {
            items: revisions.items,
            total: revisions.total,
            page,
            limit,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        fail(res, 500, "INTERNAL_ERROR", "Failed to retrieve outcome");
      }
    }
  );

  // GET /api/v1/outcomes/:id
  router.get(
    "/outcomes/:id",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
      const { userId } = req.auth;

      if (!isValidId(req.params.id)) {
        return fail(res, 400, "INVALID_ID", "Invalid outcome ID");
      }

      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "10"), 10), 1), 100);
      const page = Math.max(parseInt(String(req.query.page ?? "1"), 10), 1);
      const offset = (page - 1) * limit;

      try {
        // Fetch outcome with strict user-scoped check (IDOR protection)
        const outcome = await outcomeRepo.get(req.params.id, userId);
        if (!outcome) {
          return fail(res, 404, "NOT_FOUND", "Outcome not found or access denied");
        }

        // Fetch paginated revisions
        const revisions = await outcomeRepo.getRevisions(outcome.outcomeId, userId, {
          limit,
          offset,
        });

        res.json({
          success: true,
          outcome,
          history: {
            items: revisions.items,
            total: revisions.total,
            page,
            limit,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        fail(res, 500, "INTERNAL_ERROR", "Failed to retrieve outcome");
      }
    }
  );

  return router;
}
