// ---------------------------------------------------------------------------
// PHASE 11.9 — Pending Action API
//
//   GET    /api/v1/pending-actions?conversationId=xxx  get active pending action
//   POST   /api/v1/pending-actions/:id/confirm         confirm pending action
//   POST   /api/v1/pending-actions/:id/reject          reject pending action
//   POST   /api/v1/pending-actions/:id/modify          modify pending action params
//
// Security: same auth middleware as approvals. Identity from JWT, never from body.
//
// Audit F2 (Phase 14) — `:id` IS THE ACTION BEING ANSWERED. Confirm, reject
// and modify act only when it is the action waiting in the conversation. Any
// other id — one that was superseded, already used, or never existed — gets
// 409 PENDING_ACTION_MISMATCH (or 404 when nothing is waiting) and changes
// nothing: no approval moves and no tool runs. A screen still showing an older
// request can no longer answer a newer one.
//
// ONE WINNER. Answers that arrive together for the SAME action are resolved by
// one conditional write in PostgreSQL (PendingActionService.decide): exactly
// one wins; the others get 409 PENDING_ACTION_ALREADY_RESOLVED and change
// nothing. A cancelled action is never executed.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { randomUUID } from "crypto";
import { PendingActionConflictError, type PendingActionRefusal } from "@jarvis/agents";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import {
  executeApprovedGoogleWrite,
  isGoogleWriteApprovalAction,
} from "../services/google/execute-approved-action.js";

/**
 * How a refused answer is reported: a different action waiting, or an action
 * another answer resolved first, is a conflict; nothing waiting is not found.
 */
function refusalOf(reason: PendingActionRefusal | undefined): { status: number; code: string } {
  if (reason === "MISMATCH") return { status: 409, code: "PENDING_ACTION_MISMATCH" };
  if (reason === "ALREADY_RESOLVED") return { status: 409, code: "PENDING_ACTION_ALREADY_RESOLVED" };
  return { status: 404, code: "PENDING_ACTION_NOT_FOUND" };
}

const CONFLICT_CODES = {
  MISMATCH: "PENDING_ACTION_MISMATCH",
  NOT_MODIFIABLE: "PENDING_ACTION_NOT_MODIFIABLE",
  ALREADY_RESOLVED: "PENDING_ACTION_ALREADY_RESOLVED",
} as const;

export function createPendingActionsRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  // GET / — get active pending action for a conversation
  router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const traceId = randomUUID();
    try {
      if (!req.auth) {
        res.status(401).json({
          success: false,
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const conversationId = req.query.conversationId as string;
      if (!conversationId) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_REQUEST", message: "conversationId query parameter required" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!container.pendingActionService) {
        res.status(200).json({
          success: true,
          data: null,
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const pending = await container.pendingActionService.getActivePendingAction(
        conversationId,
        req.auth.userId
      );

      res.status(200).json({
        success: true,
        data: pending,
        traceId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        traceId,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // POST /:id/confirm — confirm a pending action
  router.post("/:id/confirm", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const traceId = randomUUID();
    try {
      if (!req.auth) {
        res.status(401).json({
          success: false,
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!container.pendingActionService) {
        res.status(500).json({
          success: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "Pending action service not available" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const conversationId = req.body?.conversationId as string;

      if (!conversationId) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_REQUEST", message: "conversationId required in body" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const result = await container.pendingActionService.confirmPendingAction(
        conversationId,
        req.auth.userId,
        String(req.params.id)
      );

      if (!result.success) {
        const refusal = refusalOf(result.reason);
        res.status(refusal.status).json({
          success: false,
          error: { code: refusal.code, message: result.message },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Execute the tool if approved
      if (result.pendingAction) {
        // A Google write approval names an ACTION, not a registered tool — see
        // execute-approved-action.ts. The registry lookup below finds nothing
        // for one, so without this branch the approval was marked APPROVED and
        // then quietly nothing happened: no execution, no error, no draft.
        const isGoogleWrite = isGoogleWriteApprovalAction(result.pendingAction.action);
        const tool = isGoogleWrite
          ? undefined
          : container.toolRegistry.get(result.pendingAction.toolId);

        if (isGoogleWrite || tool) {
          const executionResult = isGoogleWrite
            ? await executeApprovedGoogleWrite(container.googleWrites, {
                approvalId: result.pendingAction.approvalId,
                action: result.pendingAction.action,
                userId: req.auth.userId,
                conversationId,
                traceId,
              })
            : await container.executor.execute({
                toolId: result.pendingAction.toolId,
                params: result.pendingAction.params,
                userId: req.auth.userId,
                role: req.auth.role,
                conversationId,
                traceId,
                approvalId: result.pendingAction.approvalId,
              });

          res.status(200).json({
            success: true,
            data: {
              pendingAction: result.pendingAction,
              executionResult: {
                status: executionResult.status,
                result: executionResult.result,
                error: executionResult.error,
              },
            },
            traceId,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      res.status(200).json({
        success: true,
        data: { pendingAction: result.pendingAction },
        traceId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        traceId,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // POST /:id/reject — reject a pending action
  router.post("/:id/reject", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const traceId = randomUUID();
    try {
      if (!req.auth) {
        res.status(401).json({
          success: false,
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!container.pendingActionService) {
        res.status(500).json({
          success: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "Pending action service not available" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const conversationId = req.body?.conversationId as string;
      if (!conversationId) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_REQUEST", message: "conversationId required in body" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const result = await container.pendingActionService.rejectPendingAction(
        conversationId,
        req.auth.userId,
        String(req.params.id)
      );

      const refusal = refusalOf(result.reason);
      res.status(result.success ? 200 : refusal.status).json({
        success: result.success,
        data: result.success ? { message: result.message } : undefined,
        error: result.success ? undefined : { code: refusal.code, message: result.message },
        traceId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        traceId,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // POST /:id/modify — modify pending action parameters
  router.post("/:id/modify", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const traceId = randomUUID();
    try {
      if (!req.auth) {
        res.status(401).json({
          success: false,
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!container.pendingActionService) {
        res.status(500).json({
          success: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "Pending action service not available" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const conversationId = req.body?.conversationId as string;
      const newParams = req.body?.params as Record<string, unknown>;

      if (!conversationId || !newParams) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_REQUEST", message: "conversationId and params required in body" },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const result = await container.pendingActionService.modifyPendingAction(
        conversationId,
        req.auth.userId,
        newParams,
        String(req.params.id)
      );

      res.status(200).json({
        success: true,
        data: {
          pendingAction: result.pendingAction,
          message: result.message,
        },
        traceId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof PendingActionConflictError) {
        res.status(409).json({
          success: false,
          error: { code: CONFLICT_CODES[error.reason], message: error.message },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      res.status(500).json({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        traceId,
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
