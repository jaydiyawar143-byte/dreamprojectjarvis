// ---------------------------------------------------------------------------
// Phase 14 — memory relevance and confidence levels.
//
// ONE formula decides which recalled memories reach the model, in the vector
// path and in the fallback alike:
//
//   finalScore = 0.70 × semantic + 0.10 × recency + 0.10 × confidence + 0.10 × importance
//
//   semantic    cosine similarity of the memory to the user's message, 0–1
//   recency     0.5 ^ (whole days since the user last stated it ÷ 30), 0–1
//   confidence  the evidence-derived confidence (S7.2 L4), 0–0.95; a memory
//               from before evidence existed counts as LOW, whatever number
//               the extraction model once gave it
//   importance  the stored importance, 0–1
//
// Every part is in [0, 1] and the weights sum to 1, so the score is in [0, 1].
//
// WHY THESE WEIGHTS. Relevance must decide, and the rest may only break ties:
//   - the similarity FLOOR is applied to `semantic` alone, before any score is
//     computed, so no amount of confidence or freshness can bring an
//     irrelevant memory into a reply;
//   - the three secondary parts together move the score by at most 0.30, so a
//     memory that is more similar by 0.43 or more always ranks first;
//   - between memories about equally similar to the question — the case
//     cosine cannot order, and the one that matters after a preference
//     changed — the one stated more recently, in more conversations, wins.
// The quality evaluation (packages/memory/test/eval) measures exactly this:
// these weights against cosine alone and against each part removed.
//
// Pure: no I/O, no clock (the caller passes `now`), no randomness.
// ---------------------------------------------------------------------------

import type { MemoryRecallResult, MemoryRecord } from "./types/memory.js";
import { memoryEvidenceSummary } from "./memory-management.js";

export interface MemoryRelevanceWeights {
  semantic: number;
  recency: number;
  confidence: number;
  importance: number;
}

export const MEMORY_RELEVANCE_WEIGHTS: Readonly<MemoryRelevanceWeights> = Object.freeze({
  semantic: 0.7,
  recency: 0.1,
  confidence: 0.1,
  importance: 0.1,
});

/**
 * The similarity floor: a memory less similar to the user's message than this
 * is not recalled at all, whatever its other signals. Applied before scoring.
 *
 * Checked against a real embedding model by the opt-in evaluation
 * (packages/memory/test/memory-quality-eval-real-embeddings-p14.test.ts).
 */
export const MEMORY_SIMILARITY_FLOOR = 0.3;

/**
 * How similar a new statement must be to a stored memory of the same scope:
 *   corroborate  at or above: the same statement again — evidence is added
 *   revise       at or above: a newer wording of it — the content is replaced
 * Below `revise` it is a new memory. (A statement and its negation never
 * corroborate, whatever they score.)
 */
export const MEMORY_DEDUP_THRESHOLDS = Object.freeze({ corroborate: 0.95, revise: 0.7 } as const);

/** A memory last stated this long ago counts half as recent. */
export const MEMORY_RECENCY_HALF_LIFE_DAYS = 30;

const DAY_MS = 86_400_000;

function unit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * When the user last stated this memory: the last counted statement of its
 * evidence, or — for a memory from before evidence existed — its creation.
 */
export function memoryLastStatedAt(record: Pick<MemoryRecord, "createdAt" | "metadata">): Date {
  const evidence = memoryEvidenceSummary(record.metadata?.evidence);
  if (evidence) {
    const at = new Date(evidence.lastSeenAt);
    if (Number.isFinite(at.getTime())) return at;
  }
  return record.createdAt;
}

/**
 * Counted in WHOLE days: two memories stated on the same day are equally
 * recent, so milliseconds never decide an order — the id tie-break does.
 */
export function memoryRecency(lastStatedAt: Date, now: Date): number {
  const ageDays = Math.floor(Math.max(0, now.getTime() - lastStatedAt.getTime()) / DAY_MS);
  return Math.pow(0.5, ageDays / MEMORY_RECENCY_HALF_LIFE_DAYS);
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

export const MEMORY_CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export type MemoryConfidenceLevel = (typeof MEMORY_CONFIDENCE_LEVELS)[number];

/** A memory with no recorded evidence is never trusted above this. */
export const LEGACY_MEMORY_CONFIDENCE = 0.5;

/**
 * The confidence a memory is ranked and shown with.
 *
 * It is the stored, evidence-derived number (L4: a direct statement 0.70, an
 * endorsement 0.55, +0.10 for each further conversation it was stated in,
 * never above 0.95). A memory WITHOUT v1 evidence predates L4: its stored
 * number was chosen by the extraction model, so it is capped at
 * LEGACY_MEMORY_CONFIDENCE. No model's number ever ranks a memory.
 */
export function effectiveMemoryConfidence(record: Pick<MemoryRecord, "confidence" | "metadata" | "sourceType">): number {
  const stored = unit(record.confidence);
  const evidenced = record.sourceType === "USER" && memoryEvidenceSummary(record.metadata?.evidence) !== null;
  return evidenced ? Math.min(stored, 0.95) : Math.min(stored, LEGACY_MEMORY_CONFIDENCE);
}

/**
 *   HIGH    0.80 and above  stated directly, in two or more conversations
 *   MEDIUM  0.60 to 0.79    stated directly once, or endorsed in two conversations
 *   LOW     below 0.60      endorsed once, or older than evidence tracking
 */
export function memoryConfidenceLevel(confidence: number): MemoryConfidenceLevel {
  const value = unit(confidence);
  if (value >= 0.8) return "HIGH";
  if (value >= 0.6) return "MEDIUM";
  return "LOW";
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

type Scored = Pick<MemoryRecord, "id" | "createdAt" | "confidence" | "importance" | "metadata" | "sourceType">;

export function scoreMemoryRelevance<T extends Scored>(
  memory: T,
  semanticScore: number,
  now: Date,
  weights: MemoryRelevanceWeights = MEMORY_RELEVANCE_WEIGHTS
): MemoryRecallResult & { memory: T & MemoryRecord } {
  const semantic = unit(semanticScore);
  const recencyScore = memoryRecency(memoryLastStatedAt(memory), now);
  const confidenceScore = effectiveMemoryConfidence(memory);
  const importanceScore = unit(memory.importance);
  const total = weights.semantic + weights.recency + weights.confidence + weights.importance;
  const finalScore =
    total > 0
      ? (weights.semantic * semantic + weights.recency * recencyScore + weights.confidence * confidenceScore + weights.importance * importanceScore) / total
      : 0;
  return {
    memory: memory as T & MemoryRecord,
    semanticScore: semantic,
    recencyScore,
    confidenceScore,
    importanceScore,
    finalScore: Math.min(1, Math.max(0, finalScore)),
  };
}

/**
 * The best `limit` of already-scored candidates: highest score first, the id
 * breaking a tie so the same question always gets the same order.
 */
export function rankMemories<R extends MemoryRecallResult>(results: readonly R[], limit: number): R[] {
  return [...results]
    .sort((a, b) => b.finalScore - a.finalScore || (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0))
    .slice(0, Math.max(0, limit));
}
