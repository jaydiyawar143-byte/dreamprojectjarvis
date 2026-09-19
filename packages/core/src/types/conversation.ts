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

// ---------------------------------------------------------------------------
// Conversation storage port
// ---------------------------------------------------------------------------

/** What `create` needs. Mirrors `PrismaConversationRepository.create`. */
export interface CreateConversationInput {
  userId: string;
  title?: string;
  agentId?: string;
}

/**
 * What `addMessage` needs.
 *
 * `role` is `string`, not `MessageRole`, because that is what the repository
 * accepts and stores today. Narrowing it here would be a behaviour change
 * disguised as a type, so it is left exactly as the implementation has it.
 */
export interface AddMessageInput {
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * The four conversation operations a chat turn performs.
 *
 * Deliberately NOT the whole repository: `findById`, `listByUserId` and
 * `delete` are real operations that other routes use, and a chat turn has no
 * business being able to reach them. The narrower surface is the point — it is
 * what a reader of `createChatRouter` can trust about what a chat request may
 * do to stored conversations.
 *
 * Lives beside `Conversation` and `ConversationMessage` in core, next to the
 * other repository interfaces (`IApprovalRepository`, `IKnowledgeRepository`),
 * so `packages/db` can implement it without core depending on the database.
 */
export interface ConversationStorePort {
  create(input: CreateConversationInput): Promise<Conversation>;
  findByIdAndUserId(
    conversationId: string,
    userId: string
  ): Promise<Conversation | null>;
  getMessages(conversationId: string): Promise<ConversationMessage[]>;
  addMessage(input: AddMessageInput): Promise<ConversationMessage>;
}
