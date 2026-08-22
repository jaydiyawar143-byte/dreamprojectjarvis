// ---------------------------------------------------------------------------
// PHASE 10.7 — Production approval API.
//
//   GET    /api/v1/approvals          list OWN approvals (filter + pagination)
//   GET    /api/v1/approvals/:id      detail with server-generated summary
//   POST   /api/v1/approvals/:id/approve
//   POST   /api/v1/approvals/:id/reject
//
// Security architecture:
//  - Reuses the EXISTING bearer-token auth middleware (no parallel mechanism).
//    Bearer tokens live in the Authorization header (not cookies), so the
//    browser cannot attach them cross-site implicitly: classic CSRF does not
//    apply to these mutations. Documented per phase spec §13.
//  - Identity ALWAYS comes from req.auth (verified JWT) — never from body or
//    path. Every query/mutation is scoped to that userId (IDOR-safe).
//  - Approve is a strict single-winner conditional transition; reject is
//    idempotent for already-rejected rows and can never resurrect CONSUMED.
//  - Deterministic error codes only; provider exceptions never leak.
//  - Mutations are rate limited via the shared-database window limiter and
//    every attempt is audited (multi-instance authoritative).
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import {
  buildApprovalSummary,
} from "../services/approval-summary.js";
import {
  APPROVAL_RATE_LIMITS,
  DbBackedRateLimiter,
} from "../services/rate-limiter.js";
import { computeParamsHash, type ApprovalStatus } from "@jarvis/core";
import {
  validateBudgetAmount,
  validateBudgetTransition,
  DEFAULT_BUDGET_GUARDRAILS,
} from "@jarvis/tools";

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
function isValidApprovalId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

export function createApprovalsRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const rateLimiter = new DbBackedRateLimiter(container.auditLogger);

  const auth = (
    req: AuthenticatedRequest,
    res: Response
  ): { userId: string } | null => {
    if (!req.auth) {
      fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      return null;
    }
    // Identity from verified token ONLY — request-supplied userIds ignored.
    return { userId: req.auth.userId };
  };

  const rateLimitOr429 = async (
    res: Response,
    userId: string,
    bucket: keyof typeof APPROVAL_RATE_LIMITS
  ): Promise<boolean> => {
    const { limit, windowMs } = APPROVAL_RATE_LIMITS[bucket];
    const decision = await rateLimiter.check(userId, bucket, limit, windowMs);
    if (!decision.allowed) {
      await container.auditLogger.log({
        userId,
        action: `approval.${bucket}`,
        result: "rejected",
        metadata: { rateLimited: true, bucket },
      });
      fail(res, 429, "RATE_LIMITED", "Too many approval requests; retry later");
      return false;
    }
    return true;
  };

  // -------------------------------------------------------------------------
  // GET / — paginated list of the authenticated user's own approvals
  // -------------------------------------------------------------------------
  router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const identity = auth(req, res);
    if (!identity) return;
    if (!(await rateLimitOr429(res, identity.userId, "list"))) return;

    const page = Math.max(Number(req.query.page ?? 1) || 1, 1);
    const limitRaw = Number(req.query.limit ?? 20) || 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100); // server-side cap
    const status =
      typeof req.query.status === "string"
        ? (req.query.status as ApprovalStatus)
        : undefined;

    try {
      const { items, total } = await container.approvalRepo.listByUser(
        identity.userId,
        { status, page, limit }
      );

      res.status(200).json({
        success: true,
        data: items.map((a) => ({
          ...a,
          ...buildApprovalSummary(a.toolId, a.params),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(Math.ceil(total / limit), 1),
        },
        timestamp: new Date().toISOString(),
      });
    } catch {
      fail(res, 400, "APPROVAL_INVALID_QUERY", "Invalid list query parameters");
    }
  });

  // -------------------------------------------------------------------------
  // GET /:id — human-readable detail of an owned approval
  // -------------------------------------------------------------------------
  router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const identity = auth(req, res);
    if (!identity) return;
    if (!isValidApprovalId(req.params.id)) {
      return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
    }

    const approval = await container.approvalRepo.findByIdForUser(
      req.params.id,
      identity.userId
    );
    if (!approval) {
      return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
    }

    // Durable execution link (if this approval already authorized a run).
    let executionId: string | undefined;
    let executionStatus: string | undefined;
    try {
      const exec =
        await container.executionJournal.findLatestByApprovalId(approval.id);
      if (exec) {
        executionId = exec.executionId;
        executionStatus = exec.status;
      }
    } catch {
      // Journal lookup is supplementary — never fails the read.
    }

    res.status(200).json({
      success: true,
      data: {
        approvalId: approval.id,
        toolId: approval.toolId,
        paramsHash: approval.paramsHash,
        status: approval.status,
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
        resolvedAt: approval.resolvedAt ?? undefined,
        params: approval.params,
        proposedByAi: false, // values may originate from AI; representation is server-generated
        executionId,
        executionStatus,
        ...buildApprovalSummary(approval.toolId, approval.params),
      },
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /:id/approve
  // -------------------------------------------------------------------------
  router.post("/:id/approve", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const started = Date.now();
    const identity = auth(req, res);
    if (!identity) return;
    if (!(await rateLimitOr429(res, identity.userId, "approve"))) return;
    if (!isValidApprovalId(req.params.id)) {
      return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
    }
    const approvalId = req.params.id;

    const auditAttempt = async (
      result: "success" | "rejected" | "failure",
      extra?: Record<string, unknown>
    ) => {
      await container.auditLogger.log({
        userId: identity.userId,
        toolId: extra?.toolId as string | undefined,
        action: "approval.approve",
        parameters: {
          approvalId,
          paramsHash: extra?.paramsHash as string | undefined,
        },
        result,
        traceId: typeof req.headers["x-trace-id"] === "string"
          ? req.headers["x-trace-id"]
          : undefined,
        metadata: {
          durationMs: Date.now() - started,
          ...(extra ?? {}),
        },
      });
    };

    const approval = await container.approvalRepo.findByIdForUser(
      approvalId,
      identity.userId
    );
    if (!approval) {
      await auditAttempt("rejected", { reason: "APPROVAL_NOT_FOUND" });
      return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
    }

    // Integrity: stored hash must match a recomputation over durable params.
    const recomputed = computeParamsHash(approval.params);
    if (!approval.paramsHash || approval.paramsHash !== recomputed) {
      await auditAttempt("rejected", {
        toolId: approval.toolId,
        paramsHash: approval.paramsHash,
        reason: "APPROVAL_PARAMS_MISMATCH",
      });
      return fail(res, 409, "APPROVAL_PARAMS_MISMATCH",
        "Approval parameters do not match their recorded hash");
    }

    // Tool must still exist and still accept exactly these parameters.
    const tool = container.toolRegistry.get(approval.toolId);
    if (!tool || !tool.validate(approval.params)) {
      await auditAttempt("rejected", {
        toolId: approval.toolId,
        paramsHash: approval.paramsHash,
        reason: "APPROVAL_PARAMS_MISMATCH",
      });
      return fail(res, 409, "APPROVAL_PARAMS_MISMATCH",
        "Parameters no longer satisfy validation for this tool");
    }

    // Target account must STILL be authorized (server-side configured account).
    const configuredAccount = process.env.META_AD_ACCOUNT_ID;
    const requestedAccount = approval.params.accountId;
    if (
      typeof requestedAccount === "string" &&
      requestedAccount.length > 0 &&
      configuredAccount &&
      requestedAccount !== configuredAccount
    ) {
      await auditAttempt("rejected", {
        toolId: approval.toolId,
        paramsHash: approval.paramsHash,
        reason: "APPROVAL_ACCOUNT_UNAUTHORIZED",
      });
      return fail(res, 403, "APPROVAL_ACCOUNT_UNAUTHORIZED",
        "Target account is not authorized");
    }

    // Budget guardrails re-checked at decision time (server-side authority;
    // the AI cannot bypass them through approval).
    if (approval.toolId.endsWith("update_budget")) {
      const raw =
        approval.params.dailyBudget ??
        approval.params.budget ??
        approval.params.amount;
      // Format/positivity validation.
      const amountCheck = validateBudgetAmount(raw);
      if (!amountCheck.valid || amountCheck.amount === undefined) {
        await auditAttempt("rejected", {
          toolId: approval.toolId,
          paramsHash: approval.paramsHash,
          reason: "APPROVAL_BUDGET_EXCEEDED",
        });
        return fail(res, 409, "APPROVAL_BUDGET_EXCEEDED",
          amountCheck.error ?? "Budget violates guardrails");
      }
      // Hard cap + transition limits from the single guardrail authority.
      const requested = amountCheck.amount;
      const currentRaw =
        approval.params.currentBudget ?? approval.params.current_daily_budget;
      const current = Number(currentRaw);
      const withinCap = requested <= DEFAULT_BUDGET_GUARDRAILS.maxDailyBudget;
      const transitionOk =
        !Number.isFinite(current) || current <= 0
          ? true
          : validateBudgetTransition(
              current,
              requested,
              DEFAULT_BUDGET_GUARDRAILS
            ).valid;
      if (!withinCap || !transitionOk) {
        await auditAttempt("rejected", {
          toolId: approval.toolId,
          paramsHash: approval.paramsHash,
          reason: "APPROVAL_BUDGET_EXCEEDED",
        });
        return fail(res, 409, "APPROVAL_BUDGET_EXCEEDED",
          `Requested budget exceeds guardrails (max daily ${DEFAULT_BUDGET_GUARDRAILS.maxDailyBudget})`);
      }
    }

    // Draining: view remains possible; NEW write decisions are refused
    // deterministically WITHOUT consuming anything. The pending approval is
    // preserved durably so the decision can be retaken after restart
    // ("approved action is never silently lost").
    if (
      container.lifecycle?.isShuttingDown() &&
      tool.risk !== "READ_ONLY"
    ) {
      await auditAttempt("rejected", {
        toolId: approval.toolId,
        paramsHash: approval.paramsHash,
        reason: "EXECUTION_DRAINING",
      });
      return fail(res, 503, "EXECUTION_DRAINING",
        "Service is shutting down; approval was not consumed and stays pending");
    }

    const decision = await container.approvalRepo.decideApproval(
      approvalId,
      identity.userId,
      "approve"
    );

    switch (decision.outcome) {
      case "approved":
        await auditAttempt("success", {
          toolId: approval.toolId,
          paramsHash: approval.paramsHash,
        });
        return res.status(200).json({
          success: true,
          data: { approvalId, status: "approved" },
          timestamp: new Date().toISOString(),
        });
      case "not_found":
        await auditAttempt("rejected", { reason: "APPROVAL_NOT_FOUND" });
        return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
      case "forbidden":
        await auditAttempt("rejected", { reason: "APPROVAL_FORBIDDEN" });
        return fail(res, 403, "APPROVAL_FORBIDDEN",
          "Approval belongs to another user");
      case "already_consumed":
        await auditAttempt("rejected", { reason: "APPROVAL_ALREADY_CONSUMED" });
        return fail(res, 409, "APPROVAL_ALREADY_CONSUMED",
          "Approval was already consumed by an execution");
      case "already_rejected":
        await auditAttempt("rejected", { reason: "APPROVAL_ALREADY_REJECTED" });
        return fail(res, 409, "APPROVAL_ALREADY_REJECTED",
          "Approval was rejected");
      case "expired":
        await auditAttempt("rejected", { reason: "APPROVAL_EXPIRED" });
        return fail(res, 410, "APPROVAL_EXPIRED", "Approval has expired");
      case "conflict":
      default:
        await auditAttempt("rejected", { reason: "APPROVAL_CONFLICT" });
        return fail(res, 409, "APPROVAL_CONFLICT",
          "Approval state changed concurrently");
    }
  });

  // -------------------------------------------------------------------------
  // POST /:id/reject
  // -------------------------------------------------------------------------
  router.post("/:id/reject", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const started = Date.now();
    const identity = auth(req, res);
    if (!identity) return;
    if (!(await rateLimitOr429(res, identity.userId, "reject"))) return;
    if (!isValidApprovalId(req.params.id)) {
      return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
    }
    const approvalId = req.params.id;

    const auditAttempt = async (
      result: "success" | "rejected",
      extra?: Record<string, unknown>
    ) => {
      await container.auditLogger.log({
        userId: identity.userId,
        action: "approval.reject",
        parameters: { approvalId },
        result,
        traceId: typeof req.headers["x-trace-id"] === "string"
          ? req.headers["x-trace-id"]
          : undefined,
        metadata: {
          durationMs: Date.now() - started,
          ...(extra ?? {}),
        },
      });
    };

    const exists = await container.approvalRepo.findByIdForUser(
      approvalId,
      identity.userId
    );
    if (!exists) {
      await auditAttempt("rejected", { reason: "APPROVAL_NOT_FOUND" });
      return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
    }

    const decision = await container.approvalRepo.decideApproval(
      approvalId,
      identity.userId,
      "reject"
    );

    switch (decision.outcome) {
      case "rejected":
        await auditAttempt("success", {});
        return res.status(200).json({
          success: true,
          data: { approvalId, status: "rejected" },
          timestamp: new Date().toISOString(),
        });
      case "already_rejected":
        // Idempotent: rejecting twice leaves the world unchanged & succeeds.
        await auditAttempt("success", { idempotent: true });
        return res.status(200).json({
          success: true,
          data: { approvalId, status: "rejected" },
          timestamp: new Date().toISOString(),
        });
      case "already_consumed":
        await auditAttempt("rejected", { reason: "APPROVAL_ALREADY_CONSUMED" });
        return fail(res, 409, "APPROVAL_ALREADY_CONSUMED",
          "Approval was already consumed; cannot reject retroactively");
      case "expired":
        await auditAttempt("rejected", { reason: "APPROVAL_EXPIRED" });
        return fail(res, 410, "APPROVAL_EXPIRED", "Approval has expired");
      case "not_found":
        await auditAttempt("rejected", { reason: "APPROVAL_NOT_FOUND" });
        return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
      case "forbidden":
        await auditAttempt("rejected", { reason: "APPROVAL_FORBIDDEN" });
        return fail(res, 403, "APPROVAL_FORBIDDEN",
          "Approval belongs to another user");
      case "conflict":
      default:
        await auditAttempt("rejected", { reason: "APPROVAL_CONFLICT" });
        return fail(res, 409, "APPROVAL_CONFLICT",
          "Approval state changed concurrently");
    }
  });

  return router;
}
