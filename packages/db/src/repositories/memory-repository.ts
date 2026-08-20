import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  JarvisError,
  type IMemoryStore,
  type MemoryStoreRequest,
  type MemoryRecallRequest,
  type MemoryRecallResult,
  type MemoryDeleteRequest,
  type MemoryUpdateRequest,
  type MemoryListRequest,
  type MemoryListResult,
  type MemoryRecord,
  type MemoryType,
} from "@jarvis/core";

const SECRET_PATTERNS = [
  /sk-(?:proj|ant|org)[a-zA-Z0-9_-]{10,}/,
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
  /(?:api[_-]?key|apikey)\s*[:=]\s*\S+/i,
  /(?:jwt|token)\s*[:=]\s*\S+/i,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/i,
];

function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

function toMemoryRecord(row: {
  id: string;
  userId: string;
  type: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  accessCount: number;
  lastAccessedAt: Date | null;
  metadata: unknown;
  sourceType: string | null;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}): MemoryRecord {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as MemoryType,
    content: row.content,
    summary: row.summary ?? undefined,
    importance: row.importance,
    confidence: row.confidence,
    accessCount: row.accessCount,
    lastAccessedAt: row.lastAccessedAt ?? undefined,
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
    sourceType: row.sourceType ?? undefined,
    sourceConversationId: row.sourceConversationId ?? undefined,
    sourceMessageId: row.sourceMessageId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt ?? undefined,
  };
}

function embeddingToSql(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class PrismaMemoryRepository implements IMemoryStore {
  readonly id = "prisma-memory";
  readonly name = "Prisma Memory Store";

  constructor(private prisma: PrismaClient) {}

  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    const results: MemoryRecord[] = [];

    for (const mem of request.memories) {
      if (containsSecret(mem.content)) {
        throw new JarvisError(
          "INVALID_REQUEST",
          "Memory content must not contain secrets (passwords, API keys, tokens)"
        );
      }

      const row = await this.prisma.memory.create({
        data: {
          userId: request.userId,
          type: mem.type,
          content: mem.content,
          summary: mem.summary ?? null,
          importance: mem.importance,
          confidence: mem.confidence,
          metadata: mem.metadata as unknown as Prisma.InputJsonValue ?? undefined,
          sourceType: mem.sourceType ?? null,
          sourceConversationId: mem.sourceConversationId ?? null,
          sourceMessageId: mem.sourceMessageId ?? null,
          expiresAt: mem.expiresAt ?? null,
        },
      });

      results.push(toMemoryRecord(row));
    }

    return results;
  }

  async storeWithEmbedding(
    request: MemoryStoreRequest,
    embeddings: number[][]
  ): Promise<MemoryRecord[]> {
    if (request.memories.length !== embeddings.length) {
      throw new Error(
        `Memory count (${request.memories.length}) must match embedding count (${embeddings.length})`
      );
    }

    const results: MemoryRecord[] = [];

    for (let i = 0; i < request.memories.length; i++) {
      const mem = request.memories[i];
      const emb = embeddings[i];

      if (mem && containsSecret(mem.content)) {
        throw new JarvisError(
          "INVALID_REQUEST",
          "Memory content must not contain secrets (passwords, API keys, tokens)"
        );
      }

      const row = await this.prisma.memory.create({
        data: {
          userId: request.userId,
          type: mem!.type,
          content: mem!.content,
          summary: mem!.summary ?? null,
          importance: mem!.importance,
          confidence: mem!.confidence,
          metadata: mem!.metadata as unknown as Prisma.InputJsonValue ?? undefined,
          sourceType: mem!.sourceType ?? null,
          sourceConversationId: mem!.sourceConversationId ?? null,
          sourceMessageId: mem!.sourceMessageId ?? null,
          expiresAt: mem!.expiresAt ?? null,
        },
      });

      if (emb && emb.length > 0) {
        await this.prisma.$executeRawUnsafe(
          'UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2',
          embeddingToSql(emb),
          row.id
        );
      }

      results.push(toMemoryRecord(row));
    }

    return results;
  }

  async getById(userId: string, memoryId: string): Promise<MemoryRecord | null> {
    const row = await this.prisma.memory.findFirst({
      where: { id: memoryId, userId },
    });
    if (!row) return null;
    return toMemoryRecord(row);
  }

  async list(request: MemoryListRequest): Promise<MemoryListResult> {
    const limit = request.limit ?? 20;
    const offset = request.offset ?? 0;

    const where: Prisma.MemoryWhereInput = {
      userId: request.userId,
    };

    if (request.type) {
      where.type = request.type;
    }

    if (!request.includeExpired) {
      where.OR = [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ];
    }

    const [memories, total] = await Promise.all([
      this.prisma.memory.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      }),
      this.prisma.memory.count({ where }),
    ]);

    return {
      memories: memories.map(toMemoryRecord),
      total,
      hasMore: offset + memories.length < total,
    };
  }

  async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult[]> {
    const limit = request.limit ?? 10;
    const embStr = embeddingToSql(request.embedding);

    const params: unknown[] = [embStr, request.userId];
    let paramIdx = 3;

    let typeClause = "";
    if (request.types && request.types.length > 0) {
      const placeholders = request.types.map(() => `$${paramIdx++}`).join(", ");
      typeClause = `AND m."type" IN (${placeholders})`;
      params.push(...request.types);
    }

    let importanceClause = "";
    if (request.minImportance != null) {
      importanceClause = `AND m."importance" >= $${paramIdx++}`;
      params.push(request.minImportance);
    }

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        userId: string;
        type: string;
        content: string;
        summary: string | null;
        importance: number;
        confidence: number;
        accessCount: number;
        lastAccessedAt: Date | null;
        metadata: unknown;
        sourceType: string | null;
        sourceConversationId: string | null;
        sourceMessageId: string | null;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date | null;
        semanticScore: number;
      }>
    >(
      `SELECT m.*, 1 - (m."embedding" <=> $1::vector) AS "semanticScore"
       FROM "Memory" m
       WHERE m."userId" = $2
         AND m."embedding" IS NOT NULL
         ${typeClause}
         ${importanceClause}
       ORDER BY m."embedding" <=> $1::vector
       LIMIT ${limit}`,
      ...params
    );

    const now = Date.now();

    return rows.map((row) => {
      const semanticScore = Number(row.semanticScore) || 0;
      const hoursSinceAccess = row.lastAccessedAt
        ? (now - row.lastAccessedAt.getTime()) / (1000 * 60 * 60)
        : 168;
      const recencyScore = Math.exp(-hoursSinceAccess / 168);

      return {
        memory: toMemoryRecord(row),
        semanticScore,
        recencyScore,
        finalScore: semanticScore * 0.7 + recencyScore * 0.3,
      };
    });
  }

  async delete(request: MemoryDeleteRequest): Promise<number> {
    const where: Prisma.MemoryWhereInput = {
      userId: request.userId,
    };

    if (request.memoryIds && request.memoryIds.length > 0) {
      where.id = { in: request.memoryIds };
    }

    if (request.type) {
      where.type = request.type;
    }

    if (request.olderThan) {
      where.createdAt = { lt: request.olderThan };
    }

    const result = await this.prisma.memory.deleteMany({ where });
    return result.count;
  }

  async deleteAll(userId: string): Promise<number> {
    const result = await this.prisma.memory.deleteMany({
      where: { userId },
    });
    return result.count;
  }

  async update(request: MemoryUpdateRequest): Promise<MemoryRecord> {
    const data: Prisma.MemoryUpdateInput = {};

    if (request.content !== undefined) data.content = request.content;
    if (request.summary !== undefined) data.summary = request.summary;
    if (request.importance !== undefined) data.importance = request.importance;
    if (request.confidence !== undefined) data.confidence = request.confidence;
    if (request.metadata !== undefined) {
      data.metadata = request.metadata as unknown as Prisma.InputJsonValue;
    }
    if (request.sourceType !== undefined) data.sourceType = request.sourceType;
    if (request.sourceConversationId !== undefined) {
      data.sourceConversationId = request.sourceConversationId;
    }
    if (request.sourceMessageId !== undefined) {
      data.sourceMessageId = request.sourceMessageId;
    }

    const row = await this.prisma.memory.update({
      where: {
        id: request.memoryId,
        userId: request.userId,
      },
      data,
    });

    return toMemoryRecord(row);
  }

  async findSimilar(
    userId: string,
    embedding: number[],
    threshold = 0.5,
    limit = 10
  ): Promise<MemoryRecord[]> {
    const embStr = embeddingToSql(embedding);

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        userId: string;
        type: string;
        content: string;
        summary: string | null;
        importance: number;
        confidence: number;
        accessCount: number;
        lastAccessedAt: Date | null;
        metadata: unknown;
        sourceType: string | null;
        sourceConversationId: string | null;
        sourceMessageId: string | null;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date | null;
        score: number;
      }>
    >(
      `SELECT m.*, 1 - (m."embedding" <=> $1::vector) AS score
       FROM "Memory" m
       WHERE m."userId" = $2
         AND m."embedding" IS NOT NULL
         AND (1 - (m."embedding" <=> $1::vector)) >= $3
       ORDER BY m."embedding" <=> $1::vector
       LIMIT $4`,
      embStr,
      userId,
      threshold,
      limit
    );

    return rows.map(toMemoryRecord);
  }

  async count(userId: string): Promise<number> {
    const result = await this.prisma.memory.count({
      where: { userId },
    });
    return result;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
