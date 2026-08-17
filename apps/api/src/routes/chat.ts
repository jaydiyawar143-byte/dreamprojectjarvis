import { Router } from "express";
import type { Response } from "express";
import { randomUUID } from "crypto";
import { JarvisRequestSchema, JarvisError } from "@jarvis/core";
import type { SessionContext, AuthContext } from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";

export function createChatRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  router.post("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const traceId = randomUUID();

    try {
      if (!req.auth) {
        res.status(401).json({
          success: false,
          error: {
            code: "AUTHENTICATION_REQUIRED",
            message: "Authentication required",
          },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const authContext: AuthContext = req.auth;

      const parsed = JarvisRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid request body",
            details: parsed.error.flatten().fieldErrors,
          },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const jarvisRequest = parsed.data;

      const sessionContext: SessionContext = {
        auth: authContext,
        conversationId: jarvisRequest.conversationId,
        agentId: jarvisRequest.agentId,
        traceId,
        ipAddress: req.ip,
      };

      let conversationId = jarvisRequest.conversationId;

      if (!conversationId) {
        const conversation = await container.conversationRepo.create({
          userId: authContext.userId,
          agentId: jarvisRequest.agentId,
        });
        conversationId = conversation.id;
      } else {
        const existing = await container.conversationRepo.findByIdAndUserId(
          conversationId,
          authContext.userId
        );
        if (!existing) {
          res.status(404).json({
            success: false,
            error: {
              code: "CONVERSATION_NOT_FOUND",
              message: "Conversation not found or access denied",
            },
            traceId,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      sessionContext.conversationId = conversationId;

      await container.conversationRepo.addMessage({
        conversationId,
        role: "user",
        content: jarvisRequest.message,
      });

      const response = await container.orchestrator.process(
        { ...jarvisRequest, conversationId },
        sessionContext
      );

      if (response.success && response.data?.message) {
        await container.conversationRepo.addMessage({
          conversationId,
          role: "assistant",
          content: response.data.message,
          metadata: {
            model: response.data.metadata,
            traceId,
          },
        });
      }

      if (response.data) {
        response.data.conversationId = conversationId;
      }

      res.status(response.success ? 200 : mapErrorCode(response.error?.code)).json(response);
    } catch (error) {
      const message =
        error instanceof Error && !(error instanceof JarvisError)
          ? "Internal server error"
          : (error as JarvisError).message ?? "Internal server error";

      res.status(500).json({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message,
        },
        traceId,
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}

function mapErrorCode(code?: string): number {
  switch (code) {
    case "AUTHENTICATION_REQUIRED": return 401;
    case "AUTHORIZATION_FAILED": return 403;
    case "INVALID_REQUEST": return 400;
    case "AGENT_NOT_FOUND": return 404;
    case "CONVERSATION_NOT_FOUND": return 404;
    case "RATE_LIMITED": return 429;
    case "AGENT_ERROR": return 500;
    default: return 500;
  }
}
