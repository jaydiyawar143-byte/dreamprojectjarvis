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
}

export interface MemoryExtractionRequest {
  userId: string;
  messages: ExtractionMessage[];
  conversationId?: string;
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
