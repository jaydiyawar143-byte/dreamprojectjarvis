import { Router } from "express";
import type { Response } from "express";
import { randomUUID } from "crypto";
import { JarvisRequestSchema, JarvisError } from "@jarvis/core";
import { maskIdentifiersInText } from "@jarvis/core";
import type { SessionContext, AuthContext } from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import { detectIntent } from "@jarvis/agents";
import type { PendingAction } from "@jarvis/core";
import {
  executeApprovedGoogleWrite,
  isGoogleWriteApprovalAction,
} from "../services/google/execute-approved-action.js";

export function createChatRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  // ---------------------------------------------------------------------------
  // Phase 10.4 — CLIENT DISCONNECT POLICY (authoritative)
  // ---------------------------------------------------------------------------
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

      const existingMessages = await container.conversationRepo.getMessages(conversationId);

      const conversationHistory = existingMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          createdAt: m.createdAt,
          ...(m.metadata && { metadata: m.metadata }),
        }));

      // -----------------------------------------------------------------------
      // PHASE 11.9 — INTENT DETECTION + PENDING ACTION RESOLUTION
      // -----------------------------------------------------------------------
      let pendingAction: PendingAction | null = null;
      if (container.pendingActionService && conversationId) {
        pendingAction = await container.pendingActionService.getActivePendingAction(
          conversationId,
          authContext.userId
        );
      }

      const intent = detectIntent(jarvisRequest.message, pendingAction);

      // Handle CONFIRM intent
      if (intent.type === "CONFIRM" && pendingAction && container.pendingActionService) {
        // Save user message
        await container.conversationRepo.addMessage({
          conversationId,
          role: "user",
          content: jarvisRequest.message,
        });

        const confirmResult = await container.pendingActionService.confirmPendingAction(
          conversationId,
          authContext.userId
        );

        if (confirmResult.success && confirmResult.pendingAction) {
          // TWO EXECUTION PATHS, ONE APPROVAL CONCEPT.
          //
          // A Google write approval stores the ACTION as its tool id
          // ("gmail.createDraft") because that is what makes a consume unable
          // to cross actions. There is no registered tool by that name — the
          // registered tool is the planner, `google.plan.gmail.createDraft`,
          // and execution is a GoogleWriteService call. Sending it to the
          // ToolExecutor produced "Tool not found" immediately after the user
          // approved, which reads as a broken system when nothing was wrong.
          //
          // Both paths enforce approval; they just live in different places.
          const executionResult = isGoogleWriteApprovalAction(pendingAction.action)
            ? await executeApprovedGoogleWrite(container.googleWrites, {
                approvalId: pendingAction.approvalId,
                action: pendingAction.action,
                userId: authContext.userId,
                conversationId,
                traceId,
              })
            : // The executor resolves sanitized names internally.
              await container.executor.execute({
                toolId: pendingAction.toolId,
                params: pendingAction.params,
                userId: authContext.userId,
                role: authContext.role,
                conversationId,
                traceId,
                ipAddress: req.ip,
                approvalId: pendingAction.approvalId,
              });

            let assistantMessage: string;
            if (executionResult.status === "completed" && executionResult.result?.success) {
              assistantMessage = `Action executed successfully: ${pendingAction.action}.\nResult: ${JSON.stringify(executionResult.result.data, null, 2)}`;
            } else {
              assistantMessage = `Action failed: ${pendingAction.action}.\nError: ${executionResult.error ?? "Unknown error"}`;
            }

            await container.conversationRepo.addMessage({
              conversationId,
              role: "assistant",
              content: assistantMessage,
              metadata: {
                traceId,
                pendingActionId: pendingAction.id,
                executionStatus: executionResult.status,
              },
            });

            res.status(200).json({
              success: true,
              data: {
                message: assistantMessage,
                conversationId,
                metadata: {
                  traceId,
                  pendingActionId: pendingAction.id,
                  executionStatus: executionResult.status,
                },
              },
              traceId,
              timestamp: new Date().toISOString(),
            });
            return;
          }

        // If confirm failed, fall through to normal flow
        const errorMsg = confirmResult.message;
        await container.conversationRepo.addMessage({
          conversationId,
          role: "assistant",
          content: errorMsg,
          metadata: { traceId },
        });

        res.status(200).json({
          success: true,
          data: { message: errorMsg, conversationId },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Handle REJECT intent
      if (intent.type === "REJECT" && pendingAction && container.pendingActionService) {
        await container.conversationRepo.addMessage({
          conversationId,
          role: "user",
          content: jarvisRequest.message,
        });

        const rejectResult = await container.pendingActionService.rejectPendingAction(
          conversationId,
          authContext.userId
        );

        const assistantMessage = rejectResult.message;
        await container.conversationRepo.addMessage({
          conversationId,
          role: "assistant",
          content: assistantMessage,
          metadata: { traceId },
        });

        res.status(200).json({
          success: true,
          data: { message: assistantMessage, conversationId },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Handle MODIFY intent
      if (intent.type === "MODIFY" && pendingAction && container.pendingActionService && intent.extractedParams) {
        await container.conversationRepo.addMessage({
          conversationId,
          role: "user",
          content: jarvisRequest.message,
        });

        const modifyResult = await container.pendingActionService.modifyPendingAction(
          conversationId,
          authContext.userId,
          intent.extractedParams
        );

        const assistantMessage = modifyResult.message;
        await container.conversationRepo.addMessage({
          conversationId,
          role: "assistant",
          content: assistantMessage,
          metadata: {
            traceId,
            pendingAction: {
              id: modifyResult.pendingAction.id,
              toolId: modifyResult.pendingAction.toolId,
              action: modifyResult.pendingAction.action,
              params: modifyResult.pendingAction.params,
              riskLevel: modifyResult.pendingAction.riskLevel,
              state: modifyResult.pendingAction.state,
              approvalId: modifyResult.pendingAction.approvalId,
              expiresAt: modifyResult.pendingAction.expiresAt,
            },
          },
        });

        res.status(200).json({
          success: true,
          data: {
            message: assistantMessage,
            conversationId,
            pendingAction: {
              id: modifyResult.pendingAction.id,
              toolId: modifyResult.pendingAction.toolId,
              action: modifyResult.pendingAction.action,
              params: modifyResult.pendingAction.params,
              riskLevel: modifyResult.pendingAction.riskLevel,
              state: modifyResult.pendingAction.state,
              approvalId: modifyResult.pendingAction.approvalId,
              expiresAt: modifyResult.pendingAction.expiresAt,
              summary: modifyResult.message,
            },
          },
          traceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // -----------------------------------------------------------------------
      // NORMAL FLOW — route to orchestrator
      // -----------------------------------------------------------------------
      await container.conversationRepo.addMessage({
        conversationId,
        role: "user",
        content: jarvisRequest.message,
      });

      const response = await container.orchestrator.process(
        { ...jarvisRequest, conversationId, conversationHistory },
        sessionContext
      );

      // Check if the response contains a pending action (from orchestrator)
      let pendingActionData: Record<string, unknown> | undefined;
      if (response.success && response.data?.metadata) {
        const meta = response.data.metadata as Record<string, unknown>;
        if (meta.pendingAction) {
          pendingActionData = meta.pendingAction as Record<string, unknown>;
        }
      }

      // -----------------------------------------------------------------
      // Outbound identifier masking.
      //
      // The model is instructed never to print an account id, and the Meta id
      // reaches it only as a tool PARAMETER. But a model that has a value in
      // context will sometimes echo it, and the cost of that leaking into a
      // screenshot or a screen share is real, so the value is scrubbed on the
      // way out as well as withheld on the way in.
      //
      // Applied BEFORE persistence, so the stored transcript never holds a full
      // identifier either — a chat history is long-lived and widely read, and
      // masking only the live response would leave the durable copy exposed.
      // -----------------------------------------------------------------
      if (response.success && response.data?.message) {
        response.data.message = maskIdentifiersInText(response.data.message);
      }

      if (response.success && response.data?.message) {
        await container.conversationRepo.addMessage({
          conversationId,
          role: "assistant",
          content: response.data.message,
          metadata: {
            model: response.data.metadata,
            traceId,
            ...(pendingActionData && { pendingAction: pendingActionData }),
          },
        });
      }

      if (response.data) {
        response.data.conversationId = conversationId;
        if (pendingActionData) {
          (response.data as Record<string, unknown>).pendingAction = pendingActionData;
        }
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
    // R-21 — no OpenAI key on this server: unavailable, not broken.
    case "AI_PROVIDER_NOT_CONFIGURED": return 503;
    // R-29 — the provider rejected the SERVER's key. Never 401: the browser
    // would take it for an expired session, refresh and resend the message.
    case "AI_PROVIDER_AUTH_FAILED": return 503;
    // R-27 — the provider circuit is open.
    case "AI_PROVIDER_UNAVAILABLE": return 503;
    // R-25 — this conversation no longer fits the model's context window.
    case "CONTEXT_LENGTH_EXCEEDED": return 413;
    default: return 500;
  }
}
