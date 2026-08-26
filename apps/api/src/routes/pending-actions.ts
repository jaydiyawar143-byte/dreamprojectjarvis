// ---------------------------------------------------------------------------
// PHASE 11.9 — Pending Action API
//
//   GET    /api/v1/pending-actions?conversationId=xxx  get active pending action
//   POST   /api/v1/pending-actions/:id/confirm         confirm pending action
//   POST   /api/v1/pending-actions/:id/reject          reject pending action
//   POST   /api/v1/pending-actions/:id/modify          modify pending action params
//
// Security: same auth middleware as approvals. Identity from JWT, never from body.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { randomUUID } from "crypto";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";

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
        req.auth.userId
      );

      if (!result.success) {
        res.status(404).json({
          success: false,
          error: { code: "PENDING_ACTION_NOT_FOUND", message: result.message },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Execute the tool if approved
      if (result.pendingAction) {
        const tool = container.toolRegistry.get(result.pendingAction.toolId);
        if (tool) {
          const executionResult = await container.executor.execute({
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
        req.auth.userId
      );

      res.status(result.success ? 200 : 404).json({
        success: result.success,
        data: result.success ? { message: result.message } : undefined,
        error: result.success ? undefined : { code: "PENDING_ACTION_NOT_FOUND", message: result.message },
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
        newParams
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
