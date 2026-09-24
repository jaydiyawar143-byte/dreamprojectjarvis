import { Router } from "express";
import type { Response } from "express";

import { isUserFeedback, type AuditEntry } from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import type { Container } from "../services/container.js";

// ---------------------------------------------------------------------------
// UI V2 — GET /api/v1/activity
//
// Every route in this API WRITES audit rows; none of them read any back. The
// data has been accumulating since Phase 10 with no way to see it.
//
// This is a read-only window on the caller's OWN rows. Three properties make it
// safe to expose:
//
//   1. SCOPED. `userId` comes from the verified JWT and is passed to the
//      repository as a filter. There is no query parameter that can widen it,
//      so one user cannot read another's activity.
//
//   2. ALREADY REDACTED. Sprint 9.8 moved redaction to BEFORE persistence, so
//      the stored `parameters` and `metadata` have already had secrets removed
//      by key name and by value shape. This route does not have to re-redact,
//      and deliberately does not pretend to — if a secret ever reaches these
//      rows, the fix belongs at the write, not here.
//
//   3. BOUNDED. The repository clamps to `AUDIT_QUERY_MAX_ROWS`, so a client
//      cannot ask for an unbounded scan.
//
// `parameters` is nonetheless NOT returned. Redacted or not, tool arguments are
// the highest-variance field in the row and the least useful in a timeline; the
// UI needs to know what happened, not replay it. `action`, `toolId` and
// `result` carry that.
// ---------------------------------------------------------------------------

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;

/** One audit row as the UI sees it. */
export interface ActivityEntry {
  id: string;
  timestamp: string;
  action: string;
  result: AuditEntry["result"];
  agentId?: string;
  toolId?: string;
  traceId?: string;
  executionId?: string;
  durationMs?: number;
}

function toActivityEntry(entry: AuditEntry): ActivityEntry {
  const metadata = (entry.metadata ?? {}) as Record<string, unknown>;
  const executionId = typeof metadata.executionId === "string" ? metadata.executionId : undefined;
  const durationMs = typeof metadata.durationMs === "number" ? metadata.durationMs : undefined;

  return {
    id: entry.id,
    timestamp:
      entry.timestamp instanceof Date
        ? entry.timestamp.toISOString()
        : new Date(entry.timestamp).toISOString(),
    action: entry.action,
    result: entry.result,
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.toolId ? { toolId: entry.toolId } : {}),
    ...(entry.traceId ? { traceId: entry.traceId } : {}),
    ...(executionId ? { executionId } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** Rejects anything that is not a sane positive integer within the ceiling. */
function parseLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return ACTIVITY_DEFAULT_LIMIT;
  return Math.min(value, ACTIVITY_MAX_LIMIT);
}

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? undefined : value;
}

function optionalString(raw: unknown, maxLength = 128): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined;
  return trimmed;
}

export function createActivityRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  router.get(
    "/",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) {
        res.status(401).json({
          success: false,
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const limit = parseLimit(req.query.limit);
      const agentId = optionalString(req.query.agentId);
      const toolId = optionalString(req.query.toolId);
      const action = optionalString(req.query.action);
      const result = optionalString(req.query.result, 16);
      const startDate = parseDate(req.query.startDate);
      const endDate = parseDate(req.query.endDate);

      // `userId` is NOT read from the query. It is the one filter a caller
      // must not be able to choose.
      const entries = await container.auditLogger.query({
        userId: req.auth.userId,
        ...(agentId ? { agentId } : {}),
        ...(toolId ? { toolId } : {}),
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        limit,
      });

      // Action and result are filtered here rather than in the repository,
      // which has no column filter for them. Bounded by `limit` above, so this
      // never walks an unbounded set.
      const filtered = entries.filter((entry) => {
        if (action && !String(entry.action).startsWith(action)) return false;
        if (result && entry.result !== result) return false;
        return true;
      });

      res.status(200).json({
        success: true,
        data: {
          entries: filtered.map(toActivityEntry),
          count: filtered.length,
          limit,
        },
        timestamp: new Date().toISOString(),
      });
    })
  );

  // -------------------------------------------------------------------------
  // S5 — GET /api/v1/activity/trace/:traceId
  //
  // The execution outcome of ONE request: which agent ran, which skills and
  // tools took part, what the orchestrator concluded, and the explicit user
  // signal if one was given.
  //
  // Read-only, derived, and scoped by the verified JWT exactly as the timeline
  // above is. A trace belonging to another user answers 404 — the same answer
  // an unknown id gets, so this cannot be used to discover which ids exist.
  // -------------------------------------------------------------------------
  router.get(
    "/trace/:traceId",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) {
        res.status(401).json({
          success: false,
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const traceId = optionalString(req.params.traceId, 64);
      if (!traceId) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_REQUEST", message: "A traceId is required" },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const outcome = await container.executionOutcomes.outcome(req.auth.userId, traceId);
      if (!outcome) {
        res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "No activity for that request" },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: outcome,
        timestamp: new Date().toISOString(),
      });
    })
  );

  // -------------------------------------------------------------------------
  // S5 — POST /api/v1/activity/trace/:traceId/feedback
  //
  // The ONE explicit user signal: HELPFUL or NOT_HELPFUL, and nothing else.
  //
  // WHAT THIS ENDPOINT CANNOT DO. It reaches a service that holds no registry,
  // no executor and no policy, so no request to it can run a tool. It records
  // a signal and returns the re-derived view; nothing downstream consumes it.
  //
  // Absence is not a negative. A request never rated stays `feedback: null`,
  // which is a different thing from NOT_HELPFUL and is kept different.
  // -------------------------------------------------------------------------
  router.post(
    "/trace/:traceId/feedback",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) {
        res.status(401).json({
          success: false,
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const traceId = optionalString(req.params.traceId, 64);
      const feedback = (req.body ?? {}).feedback;

      if (!traceId || !isUserFeedback(feedback)) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "feedback must be HELPFUL or NOT_HELPFUL",
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const outcome = await container.executionOutcomes.record(
        req.auth.userId,
        traceId,
        feedback,
        ...(req.ip ? [{ ipAddress: req.ip }] : [])
      );

      if (!outcome) {
        res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "No activity for that request" },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: outcome,
        timestamp: new Date().toISOString(),
      });
    })
  );

  return router;
}
