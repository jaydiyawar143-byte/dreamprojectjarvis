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
  /**
   * Phase 14 — the project this memory belongs to. Absent: a PERSONAL memory.
   * Set once, by the server, from the conversation it was learned in; no
   * update ever changes it.
   */
  projectId?: string;
}

// ---------------------------------------------------------------------------
// Phase 14 — project scope
//
// A memory is personal (no project) or belongs to exactly one project of its
// owner. Every filter below is applied TOGETHER with the user id, never
// instead of it.
// ---------------------------------------------------------------------------

/**
 * Which of ONE user's memories a read may see.
 *   VISIBLE_IN  what a conversation may use: personal memories, plus those of
 *               its own project. `projectId: null` — no active project — is
 *               personal memories only.
 *   PERSONAL    memories with no project.
 *   PROJECT     memories of exactly that project.
 * Absent on a list request: every memory the user owns. That is the owner's
 * own management view; it is never what a model is shown.
 */
export type MemoryScopeFilter =
  | { kind: "VISIBLE_IN"; projectId: string | null }
  | { kind: "PERSONAL" }
  | { kind: "PROJECT"; projectId: string };

/** The exact scope a memory is stored in: one project, or `null` for personal. */
export interface MemoryExactScope {
  projectId: string | null;
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
    /** Phase 14 — the project scope. Absent: personal. */
    projectId?: string;
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
  /**
   * Phase 14 — the conversation's active project. Recall returns personal
   * memories plus that project's. Absent or null: PERSONAL MEMORIES ONLY — a
   * project memory is never recalled without its own project being active.
   */
  projectId?: string | null;
}

export interface MemoryRecallResult {
  memory: MemoryRecord;
  semanticScore: number;
  recencyScore: number;
  finalScore: number;
  /** Phase 14 — the other two parts of `finalScore` (see memory-relevance.ts). */
  confidenceScore?: number;
  importanceScore?: number;
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
  /** S7.2 L4 — refreshed when genuine new USER evidence is accepted. */
  expiresAt?: Date;
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
  /** Phase 14 — project scope. Absent: every memory the user owns. */
  scope?: MemoryScopeFilter;
  /** Phase 14 — only memories whose content contains this text (case-insensitive). */
  search?: string;
  /** Phase 14 — only memories learned from this saved USER message. */
  sourceMessageId?: string;
  /** Phase 14 — only memories that expired before this instant (retention). */
  expiredBefore?: Date;
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
  /**
   * `scope` (Phase 14) — only memories stored in exactly that scope. Absent:
   * every memory the user owns, as before.
   */
  findSimilar(
    userId: string,
    embedding: number[],
    threshold?: number,
    limit?: number,
    scope?: MemoryExactScope
  ): Promise<MemoryRecord[]>;
  count(userId: string): Promise<number>;
  isAvailable(): Promise<boolean>;
}

/**
 * Phase 14 — everything the orchestrator may do with memory: ask whether it is
 * available, recall, and read the bounded fallback list. It cannot store,
 * update or delete — those are not on the type it is given.
 */
export type MemoryRecallPort = Pick<IMemoryStore, "isAvailable" | "recall" | "list">;

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
  /** Phase 14 — the project the turn belongs to; absent for a personal memory. */
  projectId?: string;
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
  /**
   * Phase 14 — the project of the conversation this turn belongs to, taken by
   * the server from the conversation row. What is learned from the turn is
   * stored in that project. Absent: learned as a personal memory.
   */
  projectId?: string;
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
