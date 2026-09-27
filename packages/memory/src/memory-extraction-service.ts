import type {
  IAIProvider,
  IMemoryStore,
  IEmbeddingProvider,
  MemoryCandidate,
  MemoryExtractionRequest,
  MemoryExtractionResult,
  ExtractionMessage,
  IMemoryExtractor,
  MemoryType,
  MemoryRecord,
} from "@jarvis/core";
import { ExtractionResultSchema, JarvisError } from "@jarvis/core";
import { validateEmbeddingBatch } from "./embedding/embedding-validator.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MemoryExtractionServiceConfig {
  aiProvider: IAIProvider;
  store: IMemoryStore;
  embeddingProvider: IEmbeddingProvider;
  embeddingModel?: string;
  extractionModel?: string;
  deduplicationThreshold?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  expiryDays?: number;
}

// ---------------------------------------------------------------------------
// Deterministic Pre-Filter — secrets and low-value transient content
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:api[_-]?key|apikey)\s*[:=]\s*\S+/i,
  /\bsk[_-][a-zA-Z0-9]{20,}/,
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
  /\b(?:secret|token|credential)\s*[:=]\s*\S+/i,
  /\bbearer\s+[a-zA-Z0-9._-]{20,}/i,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  /\b(?:jwt|refresh[_-]?token)\s*[:=]\s*\S+/i,
  /\b(?:DATABASE_URL|DB_PASSWORD|DB_PASS)\s*[:=]\s*\S+/i,
  /\bghp_[a-zA-Z0-9]{36,}/,
  /\bsk_live_[a-zA-Z0-9]{20,}/,
  /\bsk_test_[a-zA-Z0-9]{20,}/,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /^(?:hi|hello|hey|yo|sup|ok|okay|yes|no|yeah|nah|sure|cool|nice|great|awesome|thanks|thank you|bye|goodbye|see you|good morning|good afternoon|good evening|good night)[!.?]*$/i,
  /^(?:yes|no|ok|okay|sure|yep|nope|y|n)[!.?]*$/i,
  /\b(?:what(?:'s| is) the (?:time|date|weather))\b/i,
  /\b(?:i (?:am|'m) (?:fine|good|ok|busy))\b/i,
  /\b(?:how are you|how's it going|what's up)\b/i,
];

function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

function isTransient(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return true;
  return TRANSIENT_PATTERNS.some((p) => p.test(trimmed));
}

function characterOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const maxLen = Math.max(wordsA.size, wordsB.size);
  return maxLen === 0 ? 0 : overlap / maxLen;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// ---------------------------------------------------------------------------
// S7 Step 8 — embedding failure policy: DROP + STRUCTURED EVENT.
//
// A memory is stored only with a valid, storable embedding, because a memory
// without one can never be recalled — and would still block later
// restatements of the same fact through the text-overlap dedup. When no such
// embedding can be had, the candidate is dropped and `memory_embedding_failed`
// is logged. There is no retry queue and no re-embedding state.
// ---------------------------------------------------------------------------

interface EmbeddingFailure {
  stage: "embed" | "validate" | "persist";
  reason: "provider_error" | "invalid_response" | "invalid_vector" | "storage_rejected";
  problem?: "dimensions" | "non_finite" | "empty_or_malformed";
  operation?: "create" | "merge";
  candidateIndex?: number;
  candidateCount: number;
  error?: unknown;
}

/** Why a vector was rejected — a category, never the values themselves. */
function vectorProblem(
  vector: unknown,
  dimensions: number,
): "dimensions" | "non_finite" | "empty_or_malformed" {
  if (!Array.isArray(vector) || vector.length === 0) return "empty_or_malformed";
  if (vector.length !== dimensions) return "dimensions";
  if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) return "non_finite";
  return "empty_or_malformed";
}

/** An error's machine code, only when it looks like one. Never the message. */
function safeErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

/** The store refused the vector itself (its write has rolled back). */
function isEmbeddingStorageFailure(error: unknown): boolean {
  return error instanceof JarvisError && error.code === "MEMORY_EMBEDDING_FAILED";
}

// ---------------------------------------------------------------------------
// Extraction Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a memory extraction assistant. Your task is to analyze a conversation and extract durable, user-relevant information that should be stored for future interactions.

EXTRACTION RULES:
1. Extract ONLY explicit user statements or clearly stated facts, preferences, goals, projects, decisions, or workflows.
2. Do NOT invent or infer information not directly stated by the user.
3. Do NOT store secrets, passwords, API keys, tokens, credentials, or any sensitive authentication data.
4. Do NOT store transient, ephemeral, or one-time information (greetings, acknowledgments, weather, time).
5. Prefer explicit user statements over implied information.
6. If nothing in the conversation is worth remembering, return an empty candidates array.

MEMORY TYPES:
- FACT: Verifiable information (e.g., "User's name is John", "Company uses PostgreSQL")
- PREFERENCE: User preferences or opinions (e.g., "Prefers dark mode", "Likes Python over Java")
- GOAL: User goals or objectives (e.g., "Wants to launch product by Q3")
- PROJECT: Project information (e.g., "Building a SaaS app", "Working on Phase 4")
- DECISION: Decisions made (e.g., "Chose PostgreSQL over MongoDB")
- WORKFLOW: Process or workflow patterns (e.g., "Deploys to staging first, then prod")

IMPORTANCE (0.0-1.0):
- 0.9-1.0: Critical长期 information (name, key goals, major decisions)
- 0.7-0.8: Important preferences, project details, regular workflows
- 0.5-0.6: Nice-to-have facts, minor preferences
- 0.0-0.4: Low value (avoid storing these)

CONFIDENCE (0.0-1.0):
- 1.0: Explicitly stated by the user
- 0.8-0.9: Strongly implied by context
- 0.5-0.7: Reasonably inferred
- Below 0.5: Uncertain (avoid storing these)

OUTPUT FORMAT: Return a valid JSON object with a "candidates" array. Each candidate has: type, content, importance, confidence, and optional summary.
If nothing is worth remembering, return {"candidates": []}.`;

function buildExtractionMessages(
  messages: ExtractionMessage[],
): { role: "system" | "user" | "assistant"; content: string }[] {
  const conversation = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: `Analyze this conversation and extract durable memories:\n\n${conversation}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// MemoryExtractionService
// ---------------------------------------------------------------------------

export class MemoryExtractionService implements IMemoryExtractor {
  readonly id = "memory-extraction";
  readonly name = "Memory Extraction Service";

  private aiProvider: IAIProvider;
  private store: IMemoryStore;
  private embeddingProvider: IEmbeddingProvider;
  private embeddingModel: string;
  private extractionModel: string;
  private deduplicationThreshold: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private expiryDays: number;

  constructor(config: MemoryExtractionServiceConfig) {
    this.aiProvider = config.aiProvider;
    this.store = config.store;
    this.embeddingProvider = config.embeddingProvider;
    this.embeddingModel = config.embeddingModel ?? "text-embedding-3-small";
    this.extractionModel = config.extractionModel ?? config.aiProvider.defaultModel;
    this.deduplicationThreshold = config.deduplicationThreshold ?? 0.7;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.expiryDays = config.expiryDays ?? 90;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async extract(
    request: MemoryExtractionRequest,
  ): Promise<MemoryExtractionResult> {
    const start = Date.now();

    if (!request.userId) {
      throw new JarvisError("INVALID_REQUEST", "userId is required");
    }

    if (!request.messages || request.messages.length === 0) {
      return this.emptyResult(start);
    }

    const filteredMessages = this.preFilter(request.messages);
    if (filteredMessages.length === 0) return this.emptyResult(start);

    const hasUserMessage = filteredMessages.some((m) => m.role === "user");
    if (!hasUserMessage) return this.emptyResult(start);

    const rawCandidates = await this.extractFromLLM(filteredMessages);
    const validated = this.validateCandidates(rawCandidates);

    const expiresAt = request.expiryDays
      ? new Date(Date.now() + request.expiryDays * 86400000)
      : request.expiryDays === undefined
        ? new Date(Date.now() + this.expiryDays * 86400000)
        : undefined;

    const enriched = validated.map((c) => ({
      ...c,
      sourceType: "conversation",
      sourceConversationId: request.conversationId,
      sourceMessageId: request.lastMessageId,
      expiresAt,
    }));

    const { accepted, duplicatesSkipped } =
      await this.deduplicateAndStore(enriched, request.userId);

    const created = accepted.filter(
      (c) => !c.metadata?.existingMemoryId,
    ).length;
    const updated = accepted.filter(
      (c) => c.metadata?.existingMemoryId,
    ).length;

    return {
      candidates: accepted,
      meta: {
        candidatesFound: rawCandidates.length,
        candidatesValidated: validated.length,
        candidatesFiltered: enriched.length - validated.length,
        duplicatesSkipped,
        memoriesCreated: created,
        memoriesUpdated: updated,
        processingTimeMs: Date.now() - start,
      },
    };
  }

  async processConversation(
    request: MemoryExtractionRequest,
  ): Promise<MemoryExtractionResult> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.extract(request);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof JarvisError) {
          if (
            error.code === "AUTHENTICATION_REQUIRED" ||
            error.code === "AUTHORIZATION_FAILED" ||
            error.code === "INVALID_REQUEST"
          ) {
            throw error;
          }
        }

        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new JarvisError(
      "MEMORY_EXTRACTION_FAILED",
      `Extraction failed after ${this.maxRetries + 1} attempts`,
      { lastError: lastError?.message },
    );
  }

  async isAvailable(): Promise<boolean> {
    const [aiOk, storeOk, embOk] = await Promise.all([
      this.aiProvider.isAvailable(),
      this.store.isAvailable(),
      this.embeddingProvider.isAvailable(),
    ]);
    return aiOk && storeOk && embOk;
  }

  // -----------------------------------------------------------------------
  // Pre-filter — deterministic, no LLM
  // -----------------------------------------------------------------------

  preFilter(messages: ExtractionMessage[]): ExtractionMessage[] {
    return messages.filter((m) => {
      if (m.role !== "user") return true;
      const text = m.content.trim();
      if (containsSecret(text)) return false;
      if (isTransient(text)) return false;
      return true;
    });
  }

  // -----------------------------------------------------------------------
  // LLM extraction
  // -----------------------------------------------------------------------

  private async extractFromLLM(
    messages: ExtractionMessage[],
  ): Promise<unknown[]> {
    const llmMessages = buildExtractionMessages(messages);

    const response = await this.aiProvider.complete({
      messages: llmMessages,
      model: this.extractionModel,
      temperature: 0.0,
      maxTokens: 2048,
    });

    const content = response.message.content;
    if (!content) return [];

    try {
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.candidates)) {
        return parsed.candidates;
      }
      return [];
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Schema validation
  // -----------------------------------------------------------------------

  private validateCandidates(raw: unknown[]): MemoryCandidate[] {
    const result = ExtractionResultSchema.safeParse({ candidates: raw });
    if (!result.success) {
      return [];
    }

    return result.data.candidates.map((c) => ({
      type: c.type as MemoryType,
      content: c.content,
      summary: c.summary,
      importance: c.importance,
      confidence: c.confidence,
    }));
  }

  // -----------------------------------------------------------------------
  // Deduplication + storage
  // -----------------------------------------------------------------------

  private async deduplicateAndStore(
    candidates: MemoryCandidate[],
    userId: string,
  ): Promise<{ accepted: MemoryCandidate[]; duplicatesSkipped: number }> {
    if (candidates.length === 0) {
      return { accepted: [], duplicatesSkipped: 0 };
    }

    const embeddings = await this.embedCandidates(candidates);
    const existingMemories = await this.fetchExistingMemories(userId);

    // S7 — outcomes in CANDIDATE ORDER. Each new memory carries its OWN
    // embedding (skipped or dropped candidates never shift another's vector),
    // and is only reported as accepted once it has actually been stored.
    const outcomes: Array<
      | { kind: "merged"; candidate: MemoryCandidate; memoryId: string }
      | { kind: "new"; candidate: MemoryCandidate; embedding: number[]; index: number }
    > = [];
    let duplicatesSkipped = 0;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const emb = embeddings[i];

      // S7 Step 8 — DROP: no valid embedding means the memory could never be
      // recalled, so it is not stored. embedCandidates() already logged why.
      if (!emb) {
        continue;
      }

      if (existingMemories.length === 0) {
        outcomes.push({ kind: "new", candidate, embedding: emb, index: i });
        continue;
      }

      let bestMatch: MemoryRecord | null = null;
      let bestScore = 0;

      for (const existing of existingMemories) {
        const textOverlap = characterOverlap(
          candidate.content,
          existing.content,
        );

        if (textOverlap > 0.85) {
          bestMatch = existing;
          bestScore = 1.0;
          break;
        }

        if (existing.metadata?.embedding) {
          const existingEmb = existing.metadata.embedding as number[];
          const score = cosineSimilarity(emb, existingEmb);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = existing;
          }
        }
      }

      if (bestScore >= 0.95) {
        duplicatesSkipped++;
        continue;
      }

      if (bestScore >= this.deduplicationThreshold && bestMatch) {
        let merged: MemoryRecord;
        try {
          merged = await this.mergeMemory(candidate, bestMatch, userId, emb);
        } catch (error) {
          // The merge's vector could not be stored: its transaction rolled
          // back, so the existing memory is unchanged. Drop this candidate.
          if (!isEmbeddingStorageFailure(error)) throw error;
          this.reportEmbeddingFailure({
            stage: "persist",
            reason: "storage_rejected",
            operation: "merge",
            candidateIndex: i,
            candidateCount: candidates.length,
            error,
          });
          continue;
        }
        outcomes.push({ kind: "merged", candidate, memoryId: merged.id });
        continue;
      }

      outcomes.push({ kind: "new", candidate, embedding: emb, index: i });
    }

    const stored = await this.storeMemories(
      outcomes.flatMap((o) => (o.kind === "new" ? [o] : [])),
      userId,
      candidates.length,
    );

    const accepted: MemoryCandidate[] = [];
    for (const outcome of outcomes) {
      if (outcome.kind === "merged") {
        accepted.push({ ...outcome.candidate, metadata: { existingMemoryId: outcome.memoryId } });
      } else if (stored.has(outcome.index)) {
        accepted.push(outcome.candidate);
      }
    }

    return { accepted, duplicatesSkipped };
  }

  // -----------------------------------------------------------------------
  // Embedding helpers
  // -----------------------------------------------------------------------

  /**
   * One validated embedding per candidate, or null where none could be had.
   *
   * S7 Step 8 — failures are handled PER CANDIDATE: one bad vector drops only
   * its own candidate, never a valid neighbour. Every failure is logged as
   * memory_embedding_failed; a null is never stored (see deduplicateAndStore).
   */
  private async embedCandidates(
    candidates: MemoryCandidate[],
  ): Promise<(number[] | null)[]> {
    const texts = candidates.map((c) => c.content);
    const none = () => candidates.map(() => null);

    let response: { embeddings?: unknown };
    try {
      response = await this.embeddingProvider.embed({
        input: texts,
        model: this.embeddingModel,
      });
    } catch (error) {
      this.reportEmbeddingFailure({
        stage: "embed",
        reason: "provider_error",
        candidateCount: texts.length,
        error,
      });
      return none();
    }

    const vectors = response?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      this.reportEmbeddingFailure({
        stage: "embed",
        reason: "invalid_response",
        candidateCount: texts.length,
      });
      return none();
    }

    const dimensions = this.embeddingProvider.dimensions;
    return vectors.map((vector: unknown, index) => {
      try {
        // The same strict check document ingestion uses (a non-empty array of
        // finite numbers of the provider's declared size), applied per
        // vector. The store additionally enforces the column's own size.
        return validateEmbeddingBatch([vector], 1, dimensions, {
          stage: "memory_extraction",
          position: index,
        })[0]!;
      } catch {
        this.reportEmbeddingFailure({
          stage: "validate",
          reason: "invalid_vector",
          problem: vectorProblem(vector, dimensions),
          candidateIndex: index,
          candidateCount: texts.length,
        });
        return null;
      }
    });
  }

  /**
   * Logs one embedding failure. Only structured, non-identifying fields:
   * never the memory text, the conversation, the vector, the user, or the
   * provider's or database's own error message.
   */
  private reportEmbeddingFailure(failure: EmbeddingFailure): void {
    const errorName =
      failure.error === undefined
        ? undefined
        : failure.error instanceof Error
          ? failure.error.name
          : typeof failure.error;
    const errorCode = safeErrorCode(failure.error);
    console.log(JSON.stringify({
      level: "warn",
      event: "memory_embedding_failed",
      stage: failure.stage,
      reason: failure.reason,
      ...(failure.problem ? { problem: failure.problem } : {}),
      ...(failure.operation ? { operation: failure.operation } : {}),
      ...(failure.candidateIndex !== undefined ? { candidateIndex: failure.candidateIndex } : {}),
      candidateCount: failure.candidateCount,
      embeddingModel: this.embeddingModel,
      ...(errorName ? { errorName } : {}),
      ...(errorCode ? { errorCode } : {}),
      action: "dropped",
    }));
  }

  // -----------------------------------------------------------------------
  // Fetch existing memories for dedup
  // -----------------------------------------------------------------------

  private async fetchExistingMemories(
    userId: string,
  ): Promise<MemoryRecord[]> {
    const result = await this.store.list({
      userId,
      limit: 100,
      includeExpired: false,
    });
    return result.memories;
  }

  // -----------------------------------------------------------------------
  // Merge existing memory
  // -----------------------------------------------------------------------

  private async mergeMemory(
    candidate: MemoryCandidate,
    existing: MemoryRecord,
    userId: string,
    embedding: number[],
  ): Promise<MemoryRecord> {
    const updatedConfidence = Math.min(
      1.0,
      Math.max(existing.confidence, candidate.confidence),
    );
    const updatedImportance = Math.min(
      1.0,
      Math.max(existing.importance, candidate.importance),
    );

    return this.store.update({
      userId,
      memoryId: existing.id,
      content: candidate.content,
      summary: candidate.summary ?? existing.summary,
      importance: updatedImportance,
      confidence: updatedConfidence,
      metadata: {
        ...existing.metadata,
        embedding,
        lastMergedAt: new Date().toISOString(),
        mergeCount: ((existing.metadata?.mergeCount as number) ?? 0) + 1,
      },
      sourceType: candidate.sourceType ?? existing.sourceType,
      sourceConversationId:
        candidate.sourceConversationId ?? existing.sourceConversationId,
      sourceMessageId:
        candidate.sourceMessageId ?? existing.sourceMessageId,
      // S7 — the merged content's embedding: the store replaces the vector in
      // the same transaction, so new content never keeps the old vector.
      embedding,
    });
  }

  // -----------------------------------------------------------------------
  // Store new memories
  // -----------------------------------------------------------------------

  /**
   * Stores each new memory in its own write and returns the candidate indexes
   * that were stored.
   *
   * S7 Step 8 — one write per memory, so a vector the store cannot accept
   * drops only that memory (its transaction rolled back; nothing remains) and
   * is logged, while its valid neighbours are still stored. Any other storage
   * failure propagates exactly as before.
   */
  private async storeMemories(
    pending: Array<{ candidate: MemoryCandidate; embedding: number[]; index: number }>,
    userId: string,
    candidateCount: number,
  ): Promise<Set<number>> {
    const stored = new Set<number>();

    for (const { candidate, embedding, index } of pending) {
      try {
        await this.store.store({
          userId,
          memories: [
            {
              type: candidate.type,
              content: candidate.content,
              summary: candidate.summary,
              importance: candidate.importance,
              confidence: candidate.confidence,
              sourceType: candidate.sourceType,
              sourceConversationId: candidate.sourceConversationId,
              sourceMessageId: candidate.sourceMessageId,
              expiresAt: candidate.expiresAt,
              metadata: { embedding },
              // S7 — also written to the vector column, atomically with the row.
              embedding,
            },
          ],
        });
        stored.add(index);
      } catch (error) {
        if (!isEmbeddingStorageFailure(error)) throw error;
        this.reportEmbeddingFailure({
          stage: "persist",
          reason: "storage_rejected",
          operation: "create",
          candidateIndex: index,
          candidateCount,
          error,
        });
      }
    }

    return stored;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private emptyResult(start: number): MemoryExtractionResult {
    return {
      candidates: [],
      meta: {
        candidatesFound: 0,
        candidatesValidated: 0,
        candidatesFiltered: 0,
        duplicatesSkipped: 0,
        memoriesCreated: 0,
        memoriesUpdated: 0,
        processingTimeMs: Date.now() - start,
      },
    };
  }
}
