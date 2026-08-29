import type { PrismaClient } from "@prisma/client";
import type {
  IKnowledgeRepository,
  KnowledgeDocumentData,
  KnowledgeChunkData,
} from "@jarvis/core";

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
}
