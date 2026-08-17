import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type {
  Conversation,
  ConversationMessage,
} from "@jarvis/core";

export interface CreateConversationInput {
  userId: string;
  title?: string;
  agentId?: string;
}

export interface AddMessageInput {
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}

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

export class PrismaConversationRepository {
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
