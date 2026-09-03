import type { PrismaClient } from "@prisma/client";
import type {
  IKnowledgeRepository,
  KnowledgeDocumentData,
  KnowledgeChunkData,
  KnowledgeChunkMatch,
  KnowledgeChunkSearchOptions,
} from "@jarvis/core";

/**
 * pgvector literal form. Prisma models the column as
 * `Unsupported("vector(1536)")`, so it cannot be written through the generated
 * client — the same raw-SQL approach the memory repository uses applies here.
 */
function embeddingToSql(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Dimension declared by the `KnowledgeChunk.embedding` column. */
const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;

export class PrismaKnowledgeRepository implements IKnowledgeRepository {
  constructor(private prisma: PrismaClient) {}

  async createDocument(
    userId: string,
    data: {
      title: string;
      content: string;
      documentType?: string;
      mimeType?: string;
      source?: string;
      metadata?: any;
    }
  ): Promise<KnowledgeDocumentData> {
    const doc = await this.prisma.knowledgeDocument.create({
      data: {
        userId,
        title: data.title,
        content: data.content,
        documentType: data.documentType || null,
        mimeType: data.mimeType || null,
        source: data.source || null,
        metadata: data.metadata || null,
        status: "UPLOADED",
      },
    });

    return {
      id: doc.id,
      userId: doc.userId,
      title: doc.title,
      documentType: doc.documentType,
      mimeType: doc.mimeType,
      content: doc.content,
      source: doc.source,
      status: doc.status,
      metadata: doc.metadata,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  async getDocumentById(
    id: string,
    userId: string
  ): Promise<KnowledgeDocumentData | null> {
    const doc = await this.prisma.knowledgeDocument.findFirst({
      where: { id, userId },
    });

    if (!doc) return null;

    return {
      id: doc.id,
      userId: doc.userId,
      title: doc.title,
      documentType: doc.documentType,
      mimeType: doc.mimeType,
      content: doc.content,
      source: doc.source,
      status: doc.status,
      metadata: doc.metadata,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  async listDocuments(userId: string): Promise<KnowledgeDocumentData[]> {
    const docs = await this.prisma.knowledgeDocument.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return docs.map((doc) => ({
      id: doc.id,
      userId: doc.userId,
      title: doc.title,
      documentType: doc.documentType,
      mimeType: doc.mimeType,
      content: doc.content,
      source: doc.source,
      status: doc.status,
      metadata: doc.metadata,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }));
  }

  async updateDocumentStatus(
    id: string,
    userId: string,
    status: string
  ): Promise<KnowledgeDocumentData> {
    const doc = await this.prisma.knowledgeDocument.update({
      where: { id },
      data: { status },
    });

    // Enforce isolation by verifying owner
    if (doc.userId !== userId) {
      throw new Error("Access denied: you are not the owner of this document");
    }

    return {
      id: doc.id,
      userId: doc.userId,
      title: doc.title,
      documentType: doc.documentType,
      mimeType: doc.mimeType,
      content: doc.content,
      source: doc.source,
      status: doc.status,
      metadata: doc.metadata,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  async deleteDocument(id: string, userId: string): Promise<void> {
    // Check ownership first
    const doc = await this.prisma.knowledgeDocument.findFirst({
      where: { id, userId },
    });

    if (!doc) {
      throw new Error("Access denied or document not found");
    }

    await this.prisma.knowledgeDocument.delete({
      where: { id },
    });
  }

  async createChunks(
    documentId: string,
    chunks: Array<{
      content: string;
      chunkIndex: number;
      metadata?: any;
    }>
  ): Promise<KnowledgeChunkData[]> {
    return this.prisma.$transaction(async (tx) => {
      const created: KnowledgeChunkData[] = [];
      for (const chunk of chunks) {
        const item = await tx.knowledgeChunk.create({
          data: {
            documentId,
            content: chunk.content,
            chunkIndex: chunk.chunkIndex,
            metadata: chunk.metadata || null,
          },
        });
        created.push({
          id: item.id,
          documentId: item.documentId,
          content: item.content,
          chunkIndex: item.chunkIndex,
          metadata: item.metadata,
        });
      }
      return created;
    });
  }

  async getChunksByDocument(
    documentId: string,
    userId: string
  ): Promise<KnowledgeChunkData[]> {
    // Check ownership first
    const doc = await this.prisma.knowledgeDocument.findFirst({
      where: { id: documentId, userId },
    });

    if (!doc) {
      throw new Error("Access denied or document not found");
    }

    const items = await this.prisma.knowledgeChunk.findMany({
      where: { documentId },
      orderBy: { chunkIndex: "asc" },
    });

    return items.map((item) => ({
      id: item.id,
      documentId: item.documentId,
      content: item.content,
      chunkIndex: item.chunkIndex,
      metadata: item.metadata,
    }));
  }

  async deleteChunksByDocument(
    documentId: string,
    userId: string
  ): Promise<void> {
    // Check ownership first
    const doc = await this.prisma.knowledgeDocument.findFirst({
      where: { id: documentId, userId },
    });

    if (!doc) {
      throw new Error("Access denied or document not found");
    }

    await this.prisma.knowledgeChunk.deleteMany({
      where: { documentId },
    });
  }

  async updateChunkEmbeddings(
    documentId: string,
    embeddings: Array<{ chunkIndex: number; embedding: number[] }>
  ): Promise<number> {
    if (embeddings.length === 0) return 0;

    // Dimensions are checked before any write so a bad batch cannot leave the
    // document half-embedded. Postgres would reject the mismatch itself, but
    // only on the offending row — by then earlier rows are already committed.
    for (const item of embeddings) {
      if (item.embedding.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding for chunk ${item.chunkIndex} has ${item.embedding.length} dimensions, expected ${KNOWLEDGE_EMBEDDING_DIMENSIONS}`
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      let updated = 0;
      for (const item of embeddings) {
        // Raw SQL because the vector column is Unsupported() in the schema and
        // therefore absent from the generated client's update types.
        const count = await tx.$executeRawUnsafe(
          'UPDATE "KnowledgeChunk" SET "embedding" = $1::vector WHERE "documentId" = $2 AND "chunkIndex" = $3',
          embeddingToSql(item.embedding),
          documentId,
          item.chunkIndex
        );
        updated += count;
      }
      return updated;
    });
  }

  async searchChunksByEmbedding(
    userId: string,
    embedding: number[],
    options: KnowledgeChunkSearchOptions
  ): Promise<KnowledgeChunkMatch[]> {
    if (!userId) {
      throw new Error("A userId is required to search knowledge chunks");
    }

    // Checked here rather than left to Postgres: a mismatched query vector
    // fails inside the `<=>` operator with a message that says nothing about
    // where the wrong-sized vector came from.
    if (embedding.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Query embedding has ${embedding.length} dimensions, expected ${KNOWLEDGE_EMBEDDING_DIMENSIONS}`
      );
    }

    const { limit } = options;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`Search limit must be a positive integer, received ${limit}`);
    }

    // An empty allow-list permits no value, so it can only match nothing.
    // Short-circuiting also avoids emitting `IN ()`, which is a syntax error.
    const filters = [
      options.documentIds,
      options.documentTypes,
      options.sources,
      options.statuses,
    ];
    if (filters.some((values) => values !== undefined && values.length === 0)) {
      return [];
    }

    // $1 is the query vector and $2 the owner; everything else is appended.
    const params: unknown[] = [embeddingToSql(embedding), userId];
    let paramIdx = 3;
    const clauses: string[] = [];

    if (options.similarityThreshold !== undefined) {
      clauses.push(`AND (1 - (c."embedding" <=> $1::vector)) >= $${paramIdx++}`);
      params.push(options.similarityThreshold);
    }

    const addInClause = (column: string, values?: string[]) => {
      if (!values || values.length === 0) return;
      const placeholders = values.map(() => `$${paramIdx++}`).join(", ");
      clauses.push(`AND ${column} IN (${placeholders})`);
      params.push(...values);
    };

    addInClause('c."documentId"', options.documentIds);
    addInClause('d."documentType"', options.documentTypes);
    addInClause('d."source"', options.sources);
    addInClause('d."status"', options.statuses);

    const limitPlaceholder = `$${paramIdx++}`;
    params.push(limit);

    // Raw SQL because the vector column is Unsupported() in the schema, so the
    // `<=>` operator is unreachable through the generated client — the same
    // approach the memory repository takes for recall.
    //
    // The ORDER BY carries two tiebreakers after the distance. Identical chunk
    // text yields an identical vector and therefore an identical distance, and
    // Postgres gives no row-order guarantee among equal sort keys, so without
    // them the same query could return the same rows in a different order.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        documentId: string;
        content: string;
        chunkIndex: number;
        metadata: unknown;
        documentTitle: string;
        documentType: string | null;
        source: string | null;
        status: string;
        distance: number;
      }>
    >(
      `SELECT c."id",
              c."documentId",
              c."content",
              c."chunkIndex",
              c."metadata",
              d."title" AS "documentTitle",
              d."documentType" AS "documentType",
              d."source" AS "source",
              d."status" AS "status",
              (c."embedding" <=> $1::vector) AS "distance"
       FROM "KnowledgeChunk" c
       JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
       WHERE d."userId" = $2
         AND c."embedding" IS NOT NULL
         ${clauses.join("\n         ")}
       ORDER BY (c."embedding" <=> $1::vector) ASC, c."documentId" ASC, c."chunkIndex" ASC
       LIMIT ${limitPlaceholder}`,
      ...params
    );

    return rows.map((row) => {
      const distance = Number(row.distance);
      return {
        id: row.id,
        documentId: row.documentId,
        content: row.content,
        chunkIndex: Number(row.chunkIndex),
        metadata: (row.metadata as any) ?? null,
        documentTitle: row.documentTitle,
        documentType: row.documentType,
        source: row.source,
        status: row.status,
        distance,
        // pgvector returns cosine distance; the rest of the stack reasons in
        // similarity, the same conversion the memory repository applies.
        score: 1 - distance,
      };
    });
  }
}
