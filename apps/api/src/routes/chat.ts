import { Router } from "express";
import type { Response } from "express";
import { randomUUID } from "crypto";
import { JarvisRequestSchema, JarvisError } from "@jarvis/core";
import { maskIdentifiersInText } from "@jarvis/core";
import type { SessionContext, AuthContext } from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { detectIntent, detectWorkRequest, type PendingActionService } from "@jarvis/agents";
import type {
  ConversationStorePort,
  IOrchestrator,
  ITokenService,
  IToolExecutor,
  PendingAction,
  Role,
} from "@jarvis/core";
import type { GoogleWriteService } from "../services/google/write-service.js";
import {
  executeApprovedGoogleWrite,
  isGoogleWriteApprovalAction,
} from "../services/google/execute-approved-action.js";

/**
 * The four pending-action operations a chat turn performs.
 *
 * Derived with `Pick` from the service itself rather than hand-written: a
 * duplicated interface would silently drift the first time a signature
 * changed, whereas this cannot — if `PendingActionService` changes, this
 * changes with it. `Pick` over a class also drops its private fields, which is
 * what makes the result satisfiable by an ordinary object in a test.
 */
export type PendingActionPort = Pick<
  PendingActionService,
  | "getActivePendingAction"
  | "confirmPendingAction"
  | "rejectPendingAction"
  | "modifyPendingAction"
>;

/**
 * What a chat turn actually needs — six dependencies, not the 23-field
 * `Container`.
 *
 * The `Container` still satisfies this structurally, so `index.ts` passes the
 * same object it always did and the production object graph is unchanged. The
 * gain is that this signature now states the truth about what a chat request
 * can reach: it cannot touch approvals, the agent registry, memory, knowledge
 * or the integration command service, and a reader no longer has to take that
 * on trust from the body of the file.
 *
 * `googleWrites` stays the concrete `GoogleWriteService` on purpose:
 * `executeApprovedGoogleWrite` takes that type, and narrowing it would mean
 * changing a shared helper that `pending-actions.ts` also uses. That is a
 * separate decision, deliberately not made here.
 */
/**
 * The conversational work path. One method, so the route cannot reach the
 * planner or the executor directly.
 */
export interface TaskConversationPort {
  handle(input: {
    userId: string;
    role: Role;
    goal: string;
    planOnly: boolean;
    scheduledAt?: Date;
    traceId?: string;
    conversationId?: string;
    ipAddress?: string;
  }): Promise<{
    message: string;
    taskId: string;
    plan?: unknown;
    execution?: unknown;
    /** Present when the turn scheduled the task instead of running it. */
    scheduledAt?: string;
  }>;
}

export interface ChatRouterDeps {
  tokenService: ITokenService;
  conversationRepo: ConversationStorePort;
  orchestrator: IOrchestrator;
  executor: IToolExecutor;
  /** Absent on deployments without the pending-action flow. */
  pendingActionService?: PendingActionPort;
  /**
   * Task Planner V1.1 — handles a turn that asks JARVIS to DO something.
   *
   * Optional, like `pendingActionService`: a deployment without it simply
   * routes every message to the orchestrator, which is the behaviour that
   * existed before this branch. Nothing else in this file depends on it.
   */
  taskConversation?: TaskConversationPort;
  googleWrites: GoogleWriteService | null;
}

export function createChatRouter(container: ChatRouterDeps): Router {
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
      // TASK PLANNER V1.1 — a turn that asks JARVIS to DO something.
      //
      // Sits here, beside the pending-action branches above, for the same
      // reason they do: it is a narrow special case decided BEFORE the general
      // path, and the general path below is untouched by it.
      //
      // `detectWorkRequest` is a pure heuristic whose default is NONE, so an
      // ordinary question — "what is blockchain?", "website ka response?" —
      // never reaches this branch and behaves exactly as it did before. Only
      // an unambiguous imperative gets here, and only one without an explicit
      // "don't execute" actually runs anything.
      // -----------------------------------------------------------------------
      const workRequest = detectWorkRequest(jarvisRequest.message);

      if (workRequest.type !== "NONE" && container.taskConversation) {
        await container.conversationRepo.addMessage({
          conversationId,
          role: "user",
          content: jarvisRequest.message,
        });

        // NEEDS_TIME never reaches the work path: a vague time is answered
        // with a question, not a guess, and nothing is created or run.
        if (workRequest.type === "NEEDS_TIME") {
          const ask =
            "I can do that, but I need a specific time — for example \"tomorrow at 10 am\" or \"in 30 minutes\".";
          await container.conversationRepo.addMessage({
            conversationId,
            role: "assistant",
            content: ask,
            metadata: { traceId },
          });
          res.status(200).json({
            success: true,
            data: { message: ask, conversationId },
            traceId,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        const result = await container.taskConversation.handle({
          userId: authContext.userId,
          // The AUTHENTICATED role, never anything from the body: the work
          // runs with exactly the permissions this caller already has.
          role: authContext.role as Role,
          goal: workRequest.goal,
          planOnly: workRequest.type === "PLAN_ONLY",
          ...(workRequest.type === "SCHEDULE" ? { scheduledAt: workRequest.at } : {}),
          traceId,
          conversationId,
          ...(req.ip ? { ipAddress: req.ip } : {}),
        });

        await container.conversationRepo.addMessage({
          conversationId,
          role: "assistant",
          content: result.message,
          metadata: { traceId, taskId: result.taskId },
        });

        res.status(200).json({
          success: true,
          data: {
            message: result.message,
            conversationId,
            taskId: result.taskId,
            ...(result.plan ? { plan: result.plan } : {}),
            ...(result.execution ? { execution: result.execution } : {}),
            ...(result.scheduledAt ? { scheduledAt: result.scheduledAt } : {}),
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
