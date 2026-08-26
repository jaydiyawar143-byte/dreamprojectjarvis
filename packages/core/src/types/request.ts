import { z } from "zod";
import { ConversationMessageSchema } from "./conversation.js";

export const JarvisRequestSchema = z.object({
  message: z.string().min(1, "Message cannot be empty"),
  conversationId: z.string().optional(),
  agentId: z.string().optional(),
  conversationHistory: z.array(ConversationMessageSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
  stream: z.boolean().default(false),
  /** Set by the chat route when intent detection identifies this as a confirmation/reject/modify. */
  intent: z.enum(["CONFIRM", "REJECT", "MODIFY", "NEW_ACTION", "CLARIFY"]).optional(),
});

export type JarvisRequest = z.infer<typeof JarvisRequestSchema>;

export const JarvisResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      message: z.string(),
      conversationId: z.string(),
      agentId: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
      /** Present when a write tool created a pending action awaiting confirmation. */
      pendingAction: z
        .object({
          id: z.string(),
          toolId: z.string(),
          action: z.string(),
          params: z.record(z.unknown()),
          riskLevel: z.string(),
          state: z.string(),
          approvalId: z.string(),
          expiresAt: z.string(),
          summary: z.string(),
        })
        .optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.unknown()).optional(),
    })
    .optional(),
  traceId: z.string().uuid(),
  timestamp: z.string().datetime(),
});

export type JarvisResponse = z.infer<typeof JarvisResponseSchema>;
