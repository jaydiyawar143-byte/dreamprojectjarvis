export interface KnowledgeDocumentData {
  id: string;
  userId: string;
  title: string;
  documentType: string | null;
  mimeType: string | null;
  content: string;
  source: string | null;
  status: string;
  metadata: any | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeChunkData {
  id: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  metadata: any | null;
}

export interface IKnowledgeRepository {
  createDocument(
    userId: string,
    data: {
      title: string;
      content: string;
      documentType?: string;
      mimeType?: string;
      source?: string;
      metadata?: any;
    }
  ): Promise<KnowledgeDocumentData>;

  getDocumentById(id: string, userId: string): Promise<KnowledgeDocumentData | null>;

  listDocuments(userId: string): Promise<KnowledgeDocumentData[]>;

  updateDocumentStatus(
    id: string,
    userId: string,
    status: string
  ): Promise<KnowledgeDocumentData>;

  deleteDocument(id: string, userId: string): Promise<void>;

  createChunks(
    documentId: string,
    chunks: Array<{
      content: string;
      chunkIndex: number;
      metadata?: any;
    }>
  ): Promise<KnowledgeChunkData[]>;

  getChunksByDocument(documentId: string, userId: string): Promise<KnowledgeChunkData[]>;

  deleteChunksByDocument(documentId: string, userId: string): Promise<void>;
}
