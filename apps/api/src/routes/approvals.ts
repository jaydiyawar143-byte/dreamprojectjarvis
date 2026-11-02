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
import { clientApproval, clientWritePlan } from "../services/client-views.js";
import {
  APPROVAL_RATE_LIMITS,
  DbBackedRateLimiter,
} from "../services/rate-limiter.js";
import {
  computeParamsHash,
  isDesktopCommandAction,
  needsIndependentApproval,
  parseComputerControlRequest,
  type Approval,
  type ApprovalStatus,
} from "@jarvis/core";
import { rolesHoldingSharedPermission } from "@jarvis/security";
import {
  validateBudgetAmount,
  validateBudgetTransition,
  DEFAULT_BUDGET_GUARDRAILS,
} from "@jarvis/tools";

/**
 * Phase 17 — the tenant roles that may approve an Organization's approval for
 * someone else, from the one policy table (`shared:approve`). The approval
 * store checks the decider's membership against these IN the transaction that
 * writes the decision; this route never decides who is an approver itself.
 */
const APPROVER_ROLES = rolesHoldingSharedPermission("shared:approve");

/**
 * An approval as a client sees it. The Organization's id and the decider's
 * account id are internal: the reader is told only whether the approval
 * waits for someone else, and whether they may decide it.
 */
function publicApproval(approval: Approval, readerIs: "requester" | "approver") {
  const independent = needsIndependentApproval(approval);
  return {
    ...clientApproval(approval),
    needsIndependentApproval: independent,
    // The requester of an Organization's write never approves it; an approver
    // may decide it while it waits. The store enforces both regardless.
    canApprove: independent ? readerIs === "approver" && approval.status === "pending" : approval.status === "pending",
    decidedByAnother: Boolean(approval.decidedById),
  };
}

/** Meta budget tools, by either naming the registry has used. */
function isBudgetTool(toolId: string): boolean {
  return toolId.endsWith("update_budget") || toolId.endsWith("budget.update");
}

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
  // ---------------------------------------------------------------------------
  // UI V2 - the tool's declared risk, surfaced to the approval UI.
  //
  // The registry has always carried this; it simply was not returned, so the
  // approval screen could only say "this needs approval" without saying how much
  // is at stake. A budget change and a campaign pause are not the same decision,
  // and the person making it should be able to see which one it is.
  //
  // Read from the SAME registry the executor consults, so it cannot drift from
  // the risk that actually gates execution. An unknown tool reports nothing
  // rather than a guessed default - an invented "LOW_IMPACT" would be worse than
  // a blank, because it would be believed.
  // ---------------------------------------------------------------------------
  function riskOf(toolId: string): string | undefined {
    try {
      return container.toolRegistry.get(toolId)?.risk;
    } catch {
      return undefined;
    }
  }

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

    // Phase 17 — `scope=review`: other members' writes waiting for THIS
    // account's decision, in Organizations where it is an owner or admin.
    // Never its own: those wait for someone else.
    if (req.query.scope === "review") {
      try {
        const { items, total } = await container.approvalRepo.listAwaitingDecision(
          identity.userId,
          APPROVER_ROLES,
          { page, limit }
        );
        res.status(200).json({
          success: true,
          data: items.map((item) => ({
            ...publicApproval(item.approval, "approver"),
            ...buildApprovalSummary(item.approval.toolId, item.approval.params),
            risk: riskOf(item.approval.toolId),
            requestedBy: item.requesterName,
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
      return;
    }

    try {
      const { items, total } = await container.approvalRepo.listByUser(
        identity.userId,
        { status, page, limit }
      );

      res.status(200).json({
        success: true,
        data: items.map((a) => ({
          ...publicApproval(a, "requester"),
          ...buildApprovalSummary(a.toolId, a.params),
          risk: riskOf(a.toolId),
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

    // Its requester — or, for an Organization's write, one of its approvers.
    // Anyone else: not found, exactly as for an approval that does not exist.
    const found = await container.approvalRepo.findByIdForDecider(
      req.params.id,
      identity.userId,
      APPROVER_ROLES
    );
    if (!found) {
      return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
    }
    const approval = found.approval;
    const shown = publicApproval(approval, found.readerIs);

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
        // Phase 19.1 (C1): never the raw approval parameters. A Google write
        // gets its reviewed plan, which is the only part a person needs to
        // decide; every other tool's parameters stay server-side.
        plan: clientWritePlan(approval.toolId, approval.params),
        proposedByAi: false, // values may originate from AI; representation is server-generated
        executionId,
        executionStatus,
        ...buildApprovalSummary(approval.toolId, approval.params),
        risk: riskOf(approval.toolId),
        needsIndependentApproval: shown.needsIndependentApproval,
        canApprove: shown.canApprove,
        decidedByAnother: shown.decidedByAnother,
        ...(found.readerIs === "approver" ? { requestedBy: found.requesterName } : {}),
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

    // Its requester — or, for an Organization's write, one of that
    // Organization's approvers. Anyone else: not found.
    const found = await container.approvalRepo.findByIdForDecider(
      approvalId,
      identity.userId,
      APPROVER_ROLES
    );
    if (!found) {
      await auditAttempt("rejected", { reason: "APPROVAL_NOT_FOUND" });
      return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
    }
    const approval = found.approval;

    // Phase 17 (H2) — an Organization's write is never approved by the
    // person who asked for it. Refused before anything else is looked at; the
    // store refuses it again if anything ever got this far.
    if (needsIndependentApproval(approval) && found.readerIs === "requester") {
      await auditAttempt("rejected", {
        toolId: approval.toolId,
        paramsHash: approval.paramsHash,
        reason: "APPROVAL_SELF_APPROVAL_FORBIDDEN",
      });
      return fail(res, 403, "APPROVAL_SELF_APPROVAL_FORBIDDEN",
        "A change to your organization's connection must be approved by another owner or admin of your organization.");
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
    // Phase 19.6 — a click or a key has no tool to validate it (only a person
    // asks for those), so every desktop approval is held to the desktop contract.
    const desktop = isDesktopCommandAction(approval.toolId);
    const tool = desktop ? undefined : container.toolRegistry.get(approval.toolId);
    const valid = desktop
      ? parseComputerControlRequest({ ...approval.params, action: approval.toolId }).ok
      : !!tool && tool.validate(approval.params);
    if (!valid) {
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
    // the AI cannot bypass them through approval). Phase 17 — matched by both
    // namings, and read from `requestedDailyBudget`, which is what the budget
    // tools take: the check used to match neither the tools' ids
    // (`*.budget.update`) nor their parameter, so it never ran for them.
    if (isBudgetTool(approval.toolId)) {
      const raw =
        approval.params.requestedDailyBudget ??
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
      (desktop || tool?.risk !== "READ_ONLY")
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
      "approve",
      { approverRoles: APPROVER_ROLES }
    );

    switch (decision.outcome) {
      case "approved":
        await auditAttempt("success", {
          toolId: approval.toolId,
          paramsHash: approval.paramsHash,
          // Phase 17 — approved for someone else: the requester runs it next.
          ...(found.readerIs === "approver" ? { forAnother: true } : {}),
        });
        return res.status(200).json({
          success: true,
          data: { approvalId, status: "approved" },
          timestamp: new Date().toISOString(),
        });
      case "not_found":
        await auditAttempt("rejected", { reason: "APPROVAL_NOT_FOUND" });
        return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
      case "self_approval_forbidden":
        await auditAttempt("rejected", { reason: "APPROVAL_SELF_APPROVAL_FORBIDDEN" });
        return fail(res, 403, "APPROVAL_SELF_APPROVAL_FORBIDDEN",
          "A change to your organization's connection must be approved by another owner or admin of your organization.");
      case "forbidden":
        await auditAttempt("rejected", { reason: "APPROVAL_FORBIDDEN" });
        return fail(res, 403, "APPROVAL_FORBIDDEN",
          "You may not decide this approval");
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

    // Its requester (who may withdraw it) or, for an Organization's write, one
    // of that Organization's approvers. Anyone else: not found.
    const exists = await container.approvalRepo.findByIdForDecider(
      approvalId,
      identity.userId,
      APPROVER_ROLES
    );
    if (!exists) {
      await auditAttempt("rejected", { reason: "APPROVAL_NOT_FOUND" });
      return fail(res, 404, "APPROVAL_NOT_FOUND", "Approval not found");
    }

    const decision = await container.approvalRepo.decideApproval(
      approvalId,
      identity.userId,
      "reject",
      { approverRoles: APPROVER_ROLES }
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
          "You may not decide this approval");
      case "conflict":
      default:
        await auditAttempt("rejected", { reason: "APPROVAL_CONFLICT" });
        return fail(res, 409, "APPROVAL_CONFLICT",
          "Approval state changed concurrently");
    }
  });

  return router;
}
