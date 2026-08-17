import { Router } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";

export function createConversationsRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const conversations = await container.conversationRepo.listByUserId(req.auth.userId);
    res.status(200).json({
      success: true,
      data: conversations,
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const conversation = await container.conversationRepo.findByIdAndUserId(
      req.params.id,
      req.auth.userId,
    );

    if (!conversation) {
      res.status(404).json({
        success: false,
        error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const messages = await container.conversationRepo.getMessages(conversation.id);
    res.status(200).json({
      success: true,
      data: { ...conversation, messages },
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
