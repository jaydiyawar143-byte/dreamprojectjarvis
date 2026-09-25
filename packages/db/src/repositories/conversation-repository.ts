import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type {
  AddMessageInput,
  Conversation,
  ConversationMessage,
  ConversationStorePort,
  CreateConversationInput,
} from "@jarvis/core";

// The input shapes now live beside `Conversation` in core, so the port and the
// implementation cannot drift apart. Re-exported here because `@jarvis/db`
// has always exported these names and nothing about that should change.
export type { CreateConversationInput, AddMessageInput };

/**
 * S6 — hard ceiling on one trace-message read. A request stores one user
 * message and at most one reply; the evaluator asks for ten. The ceiling only
 * guarantees that no caller can turn this read into a history scan.
 */
export const TRACE_MESSAGE_MAX_ROWS = 50;

function toConversation(row: {
  id: string;
  title: string | null;
  userId: string;
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Conversation {
  return {
    id: row.id,
    title: row.title,
    userId: row.userId,
    agentId: row.agentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessage(row: {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
}): ConversationMessage {
  return {
    id: row.id,
    role: row.role as ConversationMessage["role"],
    content: row.content,
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaConversationRepository implements ConversationStorePort {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateConversationInput): Promise<Conversation> {
    const row = await this.prisma.conversation.create({
      data: {
        userId: input.userId,
        title: input.title ?? null,
        agentId: input.agentId ?? null,
      },
    });
    return toConversation(row);
  }

  async findById(conversationId: string): Promise<Conversation | null> {
    const row = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    return row ? toConversation(row) : null;
  }

  async findByIdAndUserId(
    conversationId: string,
    userId: string
  ): Promise<Conversation | null> {
    const row = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
    });
    return row ? toConversation(row) : null;
  }

  async addMessage(input: AddMessageInput): Promise<ConversationMessage> {
    const row = await this.prisma.message.create({
      data: {
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        metadata: input.metadata as unknown as Prisma.InputJsonValue ?? undefined,
      },
    });

    await this.prisma.conversation.update({
      where: { id: input.conversationId },
      data: { updatedAt: new Date() },
    });

    return toMessage(row);
  }

  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toMessage);
  }

  /**
   * S6 — the messages of ONE request, for objective evaluation. Read-only.
   *
   * OWNERSHIP IS THE QUERY, not a check after it: the filter runs through
   * `Conversation.userId`, so a trace id stamped on another user's message is
   * simply not found — "not yours" and "does not exist" are the same answer.
   *
   * `metadata.traceId` must EQUAL the trace id (the chat route writes it on
   * every user and assistant message since S6 PD-2). Bounded by the window and
   * the limit; oldest first. `Message` carries no index, so this scans the
   * window — the same class of scan the chat route's `getMessages` already
   * performs on every turn. No schema change.
   */
  async findTraceMessages(
    userId: string,
    traceId: string,
    since: Date,
    limit: number
  ): Promise<ConversationMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        createdAt: { gte: since },
        metadata: { path: ["traceId"], equals: traceId },
        conversation: { userId },
      },
      orderBy: { createdAt: "asc" },
      take: Math.max(0, Math.min(limit, TRACE_MESSAGE_MAX_ROWS)),
    });
    return rows.map(toMessage);
  }

  async listByUserId(userId: string): Promise<Conversation[]> {
    const rows = await this.prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(toConversation);
  }

  async delete(conversationId: string, userId: string): Promise<boolean> {
    const result = await this.prisma.conversation.deleteMany({
      where: { id: conversationId, userId },
    });
    return result.count > 0;
  }
}
