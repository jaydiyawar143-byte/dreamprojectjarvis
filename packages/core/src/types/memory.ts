import { z } from "zod";

// ---------------------------------------------------------------------------
// Memory Type Enum
// ---------------------------------------------------------------------------

export const MemoryTypeSchema = z.enum([
  "FACT",
  "PREFERENCE",
  "GOAL",
  "PROJECT",
  "DECISION",
  "WORKFLOW",
]);

export type MemoryType = z.infer<typeof MemoryTypeSchema>;

// ---------------------------------------------------------------------------
// Memory Record
// ---------------------------------------------------------------------------

export interface MemoryRecord {
  id: string;
  userId: string;
  type: MemoryType;
  content: string;
  summary?: string;
  importance: number;
  confidence: number;
  accessCount: number;
  lastAccessedAt?: Date;
  metadata?: Record<string, unknown>;
  sourceType?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

// ---------------------------------------------------------------------------
// Store Request
// ---------------------------------------------------------------------------

export interface MemoryStoreRequest {
  userId: string;
  memories: Array<{
    type: MemoryType;
    content: string;
    summary?: string;
    importance: number;
    confidence: number;
    sourceType?: string;
    sourceConversationId?: string;
    sourceMessageId?: string;
    metadata?: Record<string, unknown>;
    expiresAt?: Date;
    /**
     * S7 — the content's embedding. When present, the store writes it to the
     * vector column AND to `metadata.embedding` in the same transaction as the
     * row, so a memory is never half-created and never recallable by one path
     * only. Absent: the row is stored exactly as before, with no vector.
     */
    embedding?: number[];
  }>;
}

// ---------------------------------------------------------------------------
// Recall Request & Result
// ---------------------------------------------------------------------------

export interface MemoryRecallRequest {
  userId: string;
  query: string;
  embedding: number[];
  limit?: number;
  types?: MemoryType[];
  minImportance?: number;
  /**
   * S7 — minimum semantic (cosine) similarity, 0–1. Rows below it are not
   * returned. The orchestrator passes its relevance threshold here; it is a
   * similarity floor, never an importance floor. Absent: no floor.
   */
  minSimilarity?: number;
}

export interface MemoryRecallResult {
  memory: MemoryRecord;
  semanticScore: number;
  recencyScore: number;
  finalScore: number;
}

// ---------------------------------------------------------------------------
// Delete Request
// ---------------------------------------------------------------------------

export interface MemoryDeleteRequest {
  userId: string;
  memoryIds?: string[];
  type?: MemoryType;
  olderThan?: Date;
}

// ---------------------------------------------------------------------------
// Update Request
// ---------------------------------------------------------------------------

export interface MemoryUpdateRequest {
  userId: string;
  memoryId: string;
  content?: string;
  summary?: string;
  importance?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
  sourceType?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  /**
   * S7 — the embedding of the (new) content. When present, the vector column
   * and `metadata.embedding` are replaced in the same transaction as the other
   * fields, so merged content never keeps the old content's vector.
   */
  embedding?: number[];
}

// ---------------------------------------------------------------------------
// List Request
// ---------------------------------------------------------------------------

export interface MemoryListRequest {
  userId: string;
  type?: MemoryType;
  limit?: number;
  offset?: number;
  includeExpired?: boolean;
}

export interface MemoryListResult {
  memories: MemoryRecord[];
  total: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// IMemoryStore — Production memory interface (user-scoped)
// ---------------------------------------------------------------------------

export interface IMemoryStore {
  readonly id: string;
  readonly name: string;

  store(request: MemoryStoreRequest): Promise<MemoryRecord[]>;
  getById(userId: string, memoryId: string): Promise<MemoryRecord | null>;
  recall(request: MemoryRecallRequest): Promise<MemoryRecallResult[]>;
  list(request: MemoryListRequest): Promise<MemoryListResult>;
  delete(request: MemoryDeleteRequest): Promise<number>;
  deleteAll(userId: string): Promise<number>;
  update(request: MemoryUpdateRequest): Promise<MemoryRecord>;
  findSimilar(
    userId: string,
    embedding: number[],
    threshold?: number,
    limit?: number
  ): Promise<MemoryRecord[]>;
  count(userId: string): Promise<number>;
  isAvailable(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Memory Candidate (output of extraction, input to store pipeline)
// ---------------------------------------------------------------------------

export interface MemoryCandidate {
  type: MemoryType;
  content: string;
  summary?: string;
  importance: number;
  confidence: number;
  sourceType?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  /** S7.2 L2 — the trace of the source message; stored in `metadata` (no column). */
  sourceTraceId?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
}

// ---------------------------------------------------------------------------
// Extraction Zod Schemas — for validating LLM-structured output
// ---------------------------------------------------------------------------

export const MemoryCandidateSchema = z.object({
  type: MemoryTypeSchema,
  content: z.string().min(1),
  summary: z.string().optional(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
});

export const ExtractionResultSchema = z.object({
  candidates: z.array(MemoryCandidateSchema),
});

// ---------------------------------------------------------------------------
// Extraction Request & Result
// ---------------------------------------------------------------------------

export interface ExtractionMessage {
  role: "user" | "assistant";
  content: string;
  /** S7.2 L2 — the saved Message id. Required for a USER memory to cite this message. */
  messageId?: string;
  /** S7.2 L2 — the trace of the request that saved this message. */
  traceId?: string;
}

export interface MemoryExtractionRequest {
  userId: string;
  messages: ExtractionMessage[];
  conversationId?: string;
  /** Not used for provenance: a memory's source is the USER message it cites (S7.2 L2). */
  lastMessageId?: string;
  expiryDays?: number;
}

export interface MemoryExtractionResult {
  candidates: MemoryCandidate[];
  meta: {
    candidatesFound: number;
    candidatesValidated: number;
    candidatesFiltered: number;
    duplicatesSkipped: number;
    memoriesCreated: number;
    memoriesUpdated: number;
    processingTimeMs: number;
  };
}

// ---------------------------------------------------------------------------
// IMemoryExtractor — Provider-agnostic extraction interface
// ---------------------------------------------------------------------------

export interface IMemoryExtractor {
  readonly id: string;
  readonly name: string;

  extract(request: MemoryExtractionRequest): Promise<MemoryExtractionResult>;
  isAvailable(): Promise<boolean>;
}
