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

/** A Memory row as raw reads return it — every column except the vector. */
type MemoryRow = Parameters<typeof toMemoryRecord>[0];
/** A raw row plus one computed similarity column. */
type MemoryRowWithScore<K extends string> = MemoryRow & Record<K, number>;

// ---------------------------------------------------------------------------
// S7 — memory retrieval repair.
//
// VECTOR COLUMN. `Memory.embedding` is `vector(1536)` and `Unsupported()` in the
// schema. Prisma 5.22 cannot deserialize it, so a raw query must NEVER return
// it: every SELECT below names its columns and computes similarity in SQL — the
// same shape the knowledge repository already uses in production. The vector
// is written only through a parameterised `::vector` cast.
//
// ATOMIC WRITES. A vector is always written in the same transaction as the row
// (or the row update) it belongs to, and it is validated before anything is
// written — so a bad vector can never leave a half-created memory, and merged
// content can never keep the previous content's vector.
//
// DUAL WRITE. A vector-backed memory also carries the same embedding in
// `metadata.embedding`, which extraction dedup and the orchestrator's fallback
// still read. Removing that copy is later work, not part of this repair.
// ---------------------------------------------------------------------------

/** The vector column's declared dimension, `vector(1536)`. */
const MEMORY_EMBEDDING_DIMENSIONS = 1536;

/** Every column except the vector — the only safe projection for raw reads. */
const MEMORY_COLUMNS = `m."id", m."userId", m."type", m."content", m."summary", m."importance",
       m."confidence", m."accessCount", m."lastAccessedAt", m."metadata", m."sourceType",
       m."sourceConversationId", m."sourceMessageId", m."createdAt", m."updatedAt", m."expiresAt"`;

/** Rejects, before any write, a vector the column could not hold. */
function assertStorableEmbedding(embedding: unknown, position: number): asserts embedding is number[] {
  const ok =
    Array.isArray(embedding) &&
    embedding.length === MEMORY_EMBEDDING_DIMENSIONS &&
    embedding.every((value) => typeof value === "number" && Number.isFinite(value));
  if (!ok) {
    // S7 Step 8 — a distinct code, so extraction can tell "this vector cannot
    // be stored" (drop the candidate, log memory_embedding_failed) from any
    // other storage failure (propagate, as before).
    throw new JarvisError(
      "MEMORY_EMBEDDING_FAILED",
      `Memory embedding must be ${MEMORY_EMBEDDING_DIMENSIONS} finite numbers`,
      {
        position,
        received: Array.isArray(embedding) ? embedding.length : typeof embedding,
      }
    );
  }
}

function assertNoSecret(content: string): void {
  if (containsSecret(content)) {
    throw new JarvisError(
      "INVALID_REQUEST",
      "Memory content must not contain secrets (passwords, API keys, tokens)"
    );
  }
}

type StoredMemoryInput = MemoryStoreRequest["memories"][number];

/**
 * Writes one row's vector inside the caller's transaction.
 *
 * A vector that passed every check can still be refused by PostgreSQL (for
 * example a value outside pgvector's 32-bit float range). That refusal is
 * re-thrown as MEMORY_EMBEDDING_FAILED — throwing inside the transaction rolls
 * it back — and the database's own message is deliberately not carried.
 */
async function writeVector(
  tx: Prisma.TransactionClient,
  embedding: number[],
  where: { id: string; userId?: string }
): Promise<void> {
  try {
    if (where.userId === undefined) {
      await tx.$executeRawUnsafe(
        'UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2',
        embeddingToSql(embedding),
        where.id
      );
    } else {
      await tx.$executeRawUnsafe(
        'UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2 AND "userId" = $3',
        embeddingToSql(embedding),
        where.id,
        where.userId
      );
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    throw new JarvisError("MEMORY_EMBEDDING_FAILED", "The memory embedding could not be stored", {
      ...(typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? { databaseErrorCode: code } : {}),
    });
  }
}

function createData(
  userId: string,
  mem: StoredMemoryInput,
  metadata: Record<string, unknown> | undefined
): Prisma.MemoryUncheckedCreateInput {
  return {
    userId,
    type: mem.type,
    content: mem.content,
    summary: mem.summary ?? null,
    importance: mem.importance,
    confidence: mem.confidence,
    metadata: metadata as unknown as Prisma.InputJsonValue ?? undefined,
    sourceType: mem.sourceType ?? null,
    sourceConversationId: mem.sourceConversationId ?? null,
    sourceMessageId: mem.sourceMessageId ?? null,
    expiresAt: mem.expiresAt ?? null,
  };
}

function updateData(request: MemoryUpdateRequest): Prisma.MemoryUpdateInput {
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
  if (request.expiresAt !== undefined) data.expiresAt = request.expiresAt;

  return data;
}

export class PrismaMemoryRepository implements IMemoryStore {
  readonly id = "prisma-memory";
  readonly name = "Prisma Memory Store";

  constructor(private prisma: PrismaClient) {}

  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    // Any vector in the batch: the whole batch is written atomically.
    if (request.memories.some((mem) => mem.embedding !== undefined)) {
      return this.storeAtomically(
        request.userId,
        request.memories.map((mem) => ({ mem, embedding: mem.embedding }))
      );
    }

    // No vector: unchanged behaviour.
    const results: MemoryRecord[] = [];

    for (const mem of request.memories) {
      assertNoSecret(mem.content);
      const row = await this.prisma.memory.create({
        data: createData(request.userId, mem, mem.metadata),
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

    return this.storeAtomically(
      request.userId,
      request.memories.map((mem, i) => {
        const emb = embeddings[i];
        // An absent or empty embedding means "no vector", as it always has.
        return { mem, embedding: emb && emb.length > 0 ? emb : undefined };
      })
    );
  }

  /**
   * Creates every memory, and every vector, in one transaction.
   *
   * Everything is checked before anything is written (the knowledge
   * repository's rule), and the transaction covers what a check cannot
   * foresee: if any vector write fails, no row of the batch remains.
   */
  private async storeAtomically(
    userId: string,
    items: Array<{ mem: StoredMemoryInput; embedding: number[] | undefined }>
  ): Promise<MemoryRecord[]> {
    items.forEach(({ mem, embedding }, position) => {
      assertNoSecret(mem.content);
      if (embedding !== undefined) assertStorableEmbedding(embedding, position);
    });

    return this.prisma.$transaction(async (tx) => {
      const results: MemoryRecord[] = [];
      for (const { mem, embedding } of items) {
        const metadata = embedding ? { ...(mem.metadata ?? {}), embedding } : mem.metadata;
        const row = await tx.memory.create({ data: createData(userId, mem, metadata) });
        if (embedding) {
          await writeVector(tx, embedding, { id: row.id });
        }
        results.push(toMemoryRecord(row));
      }
      return results;
    });
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

    // S7 — a similarity floor, when the caller sets one.
    let similarityClause = "";
    if (request.minSimilarity != null) {
      similarityClause = `AND (1 - (m."embedding" <=> $1::vector)) >= $${paramIdx++}`;
      params.push(request.minSimilarity);
    }

    const limitPlaceholder = `$${paramIdx++}`;
    params.push(limit);

    // S7 — explicit columns only (never the vector, which Prisma cannot
    // deserialize), expired rows excluded, and ties broken by id so the same
    // query always returns the same order.
    const rows = await this.prisma.$queryRawUnsafe<MemoryRowWithScore<"semanticScore">[]>(
      `SELECT ${MEMORY_COLUMNS}, 1 - (m."embedding" <=> $1::vector) AS "semanticScore"
       FROM "Memory" m
       WHERE m."userId" = $2
         AND m."embedding" IS NOT NULL
         AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
         ${typeClause}
         ${importanceClause}
         ${similarityClause}
       ORDER BY m."embedding" <=> $1::vector, m."id"
       LIMIT ${limitPlaceholder}`,
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
    // S7.2 L5 — an explicit selection of nothing deletes nothing. The id
    // filter used to be dropped for an empty list, which deleted every memory
    // the user had.
    if (request.memoryIds !== undefined && request.memoryIds.length === 0) return 0;

    const where: Prisma.MemoryWhereInput = {
      userId: request.userId,
    };

    if (request.memoryIds) {
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
    // S7 — new content with a new embedding: row, vector and
    // metadata.embedding change together or not at all.
    if (request.embedding !== undefined) {
      return this.updateWithEmbedding(request, request.embedding);
    }

    // No embedding: unchanged behaviour.
    const row = await this.prisma.memory.update({
      where: {
        id: request.memoryId,
        userId: request.userId,
      },
      data: updateData(request),
    });

    return toMemoryRecord(row);
  }

  private async updateWithEmbedding(
    request: MemoryUpdateRequest,
    embedding: number[]
  ): Promise<MemoryRecord> {
    assertStorableEmbedding(embedding, 0);

    return this.prisma.$transaction(async (tx) => {
      // The embedding is merged into the metadata the caller sent, or — when
      // the caller sent none — into the metadata the row already has.
      let baseMetadata = request.metadata;
      if (baseMetadata === undefined) {
        const current = await tx.memory.findFirst({
          where: { id: request.memoryId, userId: request.userId },
          select: { metadata: true },
        });
        baseMetadata = (current?.metadata as Record<string, unknown> | null) ?? undefined;
      }

      const row = await tx.memory.update({
        where: { id: request.memoryId, userId: request.userId },
        data: updateData({ ...request, metadata: { ...(baseMetadata ?? {}), embedding } }),
      });
      await writeVector(tx, embedding, { id: request.memoryId, userId: request.userId });

      return toMemoryRecord(row);
    });
  }

  async findSimilar(
    userId: string,
    embedding: number[],
    threshold = 0.5,
    limit = 10
  ): Promise<MemoryRecord[]> {
    const embStr = embeddingToSql(embedding);

    // S7 — the same safe shape as recall(): explicit columns, no expired rows,
    // a similarity floor and an id tie-breaker.
    const rows = await this.prisma.$queryRawUnsafe<MemoryRowWithScore<"score">[]>(
      `SELECT ${MEMORY_COLUMNS}, 1 - (m."embedding" <=> $1::vector) AS "score"
       FROM "Memory" m
       WHERE m."userId" = $2
         AND m."embedding" IS NOT NULL
         AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
         AND (1 - (m."embedding" <=> $1::vector)) >= $3
       ORDER BY m."embedding" <=> $1::vector, m."id"
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
