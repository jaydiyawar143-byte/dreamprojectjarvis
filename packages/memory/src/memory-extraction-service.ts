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
  /\bbearer\s+[a-zA-Z0-9._\-]{20,}/i,
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

    const accepted: MemoryCandidate[] = [];
    let duplicatesSkipped = 0;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const emb = embeddings[i];

      if (!emb) {
        accepted.push(candidate);
        continue;
      }

      if (existingMemories.length === 0) {
        accepted.push(candidate);
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
        const merged = await this.mergeMemory(
          candidate,
          bestMatch,
          userId,
          emb,
        );
        accepted.push({
          ...candidate,
          metadata: { existingMemoryId: merged.id },
        });
        continue;
      }

      accepted.push(candidate);
    }

    if (accepted.length > 0) {
      await this.storeMemories(accepted, userId, embeddings);
    }

    return { accepted, duplicatesSkipped };
  }

  // -----------------------------------------------------------------------
  // Embedding helpers
  // -----------------------------------------------------------------------

  private async embedCandidates(
    candidates: MemoryCandidate[],
  ): Promise<(number[] | null)[]> {
    const texts = candidates.map((c) => c.content);
    try {
      const response = await this.embeddingProvider.embed({
        input: texts,
        model: this.embeddingModel,
      });
      return response.embeddings;
    } catch {
      return candidates.map(() => null);
    }
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
    });
  }

  // -----------------------------------------------------------------------
  // Store new memories
  // -----------------------------------------------------------------------

  private async storeMemories(
    candidates: MemoryCandidate[],
    userId: string,
    embeddings: (number[] | null)[],
  ): Promise<void> {
    const toStore = candidates
      .map((c, i) => ({
        candidate: c,
        embedding: embeddings[i],
      }))
      .filter((item) => !item.candidate.metadata?.existingMemoryId);

    if (toStore.length === 0) return;

    const memories = toStore.map((item) => ({
      type: item.candidate.type,
      content: item.candidate.content,
      summary: item.candidate.summary,
      importance: item.candidate.importance,
      confidence: item.candidate.confidence,
      sourceType: item.candidate.sourceType,
      sourceConversationId: item.candidate.sourceConversationId,
      sourceMessageId: item.candidate.sourceMessageId,
      expiresAt: item.candidate.expiresAt,
      metadata: item.embedding ? { embedding: item.embedding } : undefined,
    }));

    await this.store.store({ userId, memories });
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
