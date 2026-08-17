import { z } from "zod";

export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ConversationMessageSchema = z.object({
  id: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
});

export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  userId: z.string(),
  agentId: z.string().nullable(),
  messages: z.array(ConversationMessageSchema).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Conversation = z.infer<typeof ConversationSchema>;
