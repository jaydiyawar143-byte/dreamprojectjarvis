// ---------------------------------------------------------------------------
// Phase 11.9B — Opportunity Queue API Route
//
//   GET /api/v1/opportunities          ranked queue (paginated, filtered)
//   GET /api/v1/opportunities/:id      full detail for human review
//
// Security architecture:
//  - All operations scoped to req.auth.userId — IDOR-safe.
//  - accountId ALWAYS comes from process.env.META_AD_ACCOUNT_ID, never from
//    the client request body, query params, or path. Clients cannot forge it.
//  - isValidId() guard on /:id prevents probing with malformed IDs.
//  - Score, priority, historical evidence are server-computed via the Phase
//    11.9A engine — clients cannot inject forged values.
//  - NO mutation endpoints on this router. No POST. No execute.
//  - ZERO Meta writes on any path through this module.
//  - ZERO LLM calls on any path through this module.
//  - Secrets (tokens, keys) never appear in output.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import {
  buildOpportunityQueue,
  buildOpportunityDetail,
  explainNoOpportunities,
  type OpportunityQueueOptions,
} from "@jarvis/core";

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

/** cuid-ish shape guard: rejects malformed ids without leaking existence. */
function isValidId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

/** Extract a string query param safely. */
function qs(req: AuthenticatedRequest, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" ? v : undefined;
}

export function createOpportunitiesRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const recommendationRepo = container.recommendationRepo;

  // -------------------------------------------------------------------------
  // GET / — ranked opportunity queue
  //
  // Query parameters (all optional, server-capped):
  //   priority    — CRITICAL | HIGH | MEDIUM | LOW | IGNORE
  //   status      — NEW | REVIEWED | APPROVAL_PENDING | APPROVED | REJECTED |
  //                  EXPIRED | EXECUTED | FAILED
  //   entityType  — CAMPAIGN | AD_SET | AD
  //   actionType  — PAUSE_AD | RESUME_AD | PAUSE_AD_SET | … (spec values)
  //   limit       — 1–100 (server cap)
  //   cursor      — opaque cursor from previous response
  //
  // Returns:
  //   { success: true, items, nextCursor, totalEligible, ineligibleCount,
  //     noOpportunityReason?, timestamp }
  // -------------------------------------------------------------------------
  router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const { userId } = req.auth;

    // Account isolation: ALWAYS from server config, never from client.
    const accountId = process.env.META_AD_ACCOUNT_ID;
    if (!accountId) {
      return fail(
        res,
        503,
        "ACCOUNT_NOT_CONFIGURED",
        "Ad account not configured on this server"
      );
    }

    // Parse safe query params (all optional)
    const limitRaw = parseInt(String(req.query.limit ?? "20"), 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
    const cursor = qs(req, "cursor");
    const priorityFilter = qs(req, "priority");
    const statusFilter = qs(req, "status");
    const entityTypeFilter = qs(req, "entityType");
    const actionTypeFilter = qs(req, "actionType");

    const options: OpportunityQueueOptions = {
      limit,
      cursor,
      now: new Date(),
    };

    // Whitelist filter values — unknown values are silently ignored
    const VALID_PRIORITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW", "IGNORE"]);
    const VALID_STATUSES = new Set([
      "NEW", "REVIEWED", "APPROVAL_PENDING", "APPROVED",
      "REJECTED", "EXPIRED", "EXECUTED", "FAILED",
    ]);

    if (priorityFilter && VALID_PRIORITIES.has(priorityFilter.toUpperCase())) {
      options.priority = priorityFilter.toUpperCase() as OpportunityQueueOptions["priority"];
    }
    if (statusFilter && VALID_STATUSES.has(statusFilter.toUpperCase())) {
      options.displayStatus = statusFilter.toUpperCase() as OpportunityQueueOptions["displayStatus"];
    }
    if (entityTypeFilter) {
      options.entityType = entityTypeFilter;
    }
    if (actionTypeFilter) {
      options.actionType = actionTypeFilter;
    }

    try {
      // Fetch records — strictly userId + accountId scoped
      const { items: records, total: dbTotal } =
        await recommendationRepo.listForOpportunityQueue(userId, accountId, {
          entityType: entityTypeFilter,
          actionType: actionTypeFilter,
          limit: 200, // fetch generously; scoring engine does deterministic ranking
        });

      // Build ranked, filtered, paginated queue (pure, no writes)
      const queue = buildOpportunityQueue(records, accountId, userId, options);

      const response: Record<string, unknown> = {
        success: true,
        items: queue.items,
        nextCursor: queue.nextCursor,
        totalEligible: queue.totalEligible,
        ineligibleCount: queue.ineligibleCount,
        dbTotal,
        timestamp: new Date().toISOString(),
      };

      // No-opportunity state: explain why the queue is empty
      if (queue.items.length === 0) {
        response.noOpportunity = explainNoOpportunities(
          records,
          queue.totalEligible,
          queue.ineligibleCount
        );
      }

      res.json(response);
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Failed to load opportunity queue");
    }
  });

  // -------------------------------------------------------------------------
  // GET /:id — full detail for human review
  //
  // Returns the full OpportunityQueueItemDetail with all 10 review sections.
  // Does NOT execute anything. Does NOT write anything.
  // -------------------------------------------------------------------------
  router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const { userId } = req.auth;

    if (!isValidId(req.params.id)) {
      return fail(res, 404, "OPPORTUNITY_NOT_FOUND", "Opportunity not found");
    }

    // Account isolation: ALWAYS from server config
    const accountId = process.env.META_AD_ACCOUNT_ID;
    if (!accountId) {
      return fail(
        res,
        503,
        "ACCOUNT_NOT_CONFIGURED",
        "Ad account not configured on this server"
      );
    }

    try {
      // Fetch the record with strict userId + accountId scope (IDOR-safe)
      const record = await recommendationRepo.getForOpportunityDetail(
        req.params.id,
        userId,
        accountId
      );

      if (!record) {
        return fail(res, 404, "OPPORTUNITY_NOT_FOUND", "Opportunity not found");
      }

      // Build full detail (pure, no writes, no Meta calls, no LLM)
      const detail = buildOpportunityDetail(
        [record],
        req.params.id,
        accountId,
        userId
      );

      if (!detail) {
        return fail(res, 404, "OPPORTUNITY_NOT_FOUND", "Opportunity not found");
      }

      // Stale-state check: surface if the recommendation has stale reasons
      const staleReasons = record.staleReasons ?? [];
      const isStale = staleReasons.length > 0;

      res.json({
        success: true,
        opportunity: detail,
        // Stale-state flag: UI must show this prominently before approval
        staleWarning: isStale
          ? {
              isStale: true,
              reasons: staleReasons,
              message:
                "This recommendation may be stale. Verify the current state of the " +
                "target entity before approving.",
            }
          : null,
        // Approval handoff info: points to existing approval flow (no new mechanism)
        approvalHandoff: detail.approvalId
          ? {
              approvalId: detail.approvalId,
              approvalRoute: `/api/v1/approvals/${detail.approvalId}`,
              message: "An approval request exists. Use the existing approval flow to approve or reject.",
            }
          : {
              approvalId: null,
              approvalRoute: "/api/v1/approvals",
              message:
                "To act on this recommendation, submit it to the existing approval flow " +
                "via the JARVIS chat interface.",
            },
        timestamp: new Date().toISOString(),
      });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Failed to load opportunity detail");
    }
  });

  return router;
}
