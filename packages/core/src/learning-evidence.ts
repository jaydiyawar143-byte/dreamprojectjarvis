// S7.2 L4 — learning evidence.
//
// How many genuine USER statements stand behind a durable memory, and from how
// many distinct conversations. Ids, kinds, counts and timestamps only — never
// the words of the user, a quote, a claim or anything JARVIS said.
//
// Three events, one per dedup outcome in MemoryExtractionService:
//   NEW          a new memory: evidence starts with this source
//   CORROBORATE  the same memory stated again: the source is added
//   REVISE       a merge replaced the memory's content: evidence restarts
//                with this source, and the revision is recorded (ids only)
//
// Confidence is derived from the evidence and is not a probability:
// DIRECT 0.70, ENDORSEMENT 0.55, +0.10 per additional distinct conversation,
// never above 0.95. A message already counted is a replay: nothing changes,
// and expiry is not refreshed again.
//
// Pure: no imports, no clock, no randomness, no environment. The caller
// supplies every timestamp. It never throws; an invalid event, or existing
// evidence it cannot read, is refused rather than overwritten.

export const LEARNING_EVIDENCE_KINDS = ["DIRECT", "ENDORSEMENT"] as const;
export type LearningEvidenceKind = (typeof LEARNING_EVIDENCE_KINDS)[number];

/** Sources, and previous source ids, kept per memory. */
export const LEARNING_EVIDENCE_LIMIT = 10;

export interface LearningEvidenceSource {
  messageId: string;
  conversationId: string;
  traceId?: string;
  kind: LearningEvidenceKind;
  at: string;
}

/** Stored as `metadata.evidence` on the memory. */
export interface LearningEvidence {
  v: 1;
  /** Distinct source messages ever counted. */
  count: number;
  /** Distinct conversations ever counted. */
  conversations: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** The last LEARNING_EVIDENCE_LIMIT sources. */
  sources: LearningEvidenceSource[];
  revisions: number;
  lastRevisedAt?: string;
  /** The message that established each replaced statement — the last LEARNING_EVIDENCE_LIMIT. */
  previousSourceMessageIds: string[];
}

export interface LearningEvidenceEvent {
  kind: "NEW" | "CORROBORATE" | "REVISE";
  evidenceKind: LearningEvidenceKind;
  sourceMessageId: string;
  conversationId: string;
  traceId?: string;
  /** ISO 8601, supplied by the caller. */
  occurredAt: string;
}

export interface LearningEvidenceContext {
  /** The existing memory's own source columns and creation time, exactly as stored. Never invented. */
  memorySource?: { messageId?: string; conversationId?: string; createdAt?: string };
}

export type LearningEvidenceResult =
  | {
      accepted: true;
      reason: "CREATED" | "CORROBORATED" | "REVISED" | "SOURCE_ALREADY_COUNTED";
      changed: boolean;
      refreshExpiry: boolean;
      confidence: number;
      evidence: LearningEvidence;
    }
  | { accepted: false; reason: "INVALID_EVENT" | "INVALID_EXISTING_EVIDENCE" };

const EVENT_KINDS: ReadonlySet<unknown> = new Set(["NEW", "CORROBORATE", "REVISE"]);
const KINDS: ReadonlySet<unknown> = new Set(LEARNING_EVIDENCE_KINDS);

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function counter(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isSource(value: unknown): value is LearningEvidenceSource {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    nonBlank(s.messageId) &&
    nonBlank(s.conversationId) &&
    (s.traceId === undefined || nonBlank(s.traceId)) &&
    KINDS.has(s.kind) &&
    nonBlank(s.at)
  );
}

/** True only for well-formed v1 evidence. */
export function isLearningEvidence(value: unknown): value is LearningEvidence {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === 1 &&
    counter(e.count) &&
    counter(e.conversations) &&
    nonBlank(e.firstSeenAt) &&
    nonBlank(e.lastSeenAt) &&
    Array.isArray(e.sources) &&
    e.sources.length <= LEARNING_EVIDENCE_LIMIT &&
    e.sources.every(isSource) &&
    counter(e.revisions) &&
    (e.lastRevisedAt === undefined || nonBlank(e.lastRevisedAt)) &&
    Array.isArray(e.previousSourceMessageIds) &&
    e.previousSourceMessageIds.length <= LEARNING_EVIDENCE_LIMIT &&
    e.previousSourceMessageIds.every(nonBlank)
  );
}

function isEvent(value: unknown): value is LearningEvidenceEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    EVENT_KINDS.has(e.kind) &&
    KINDS.has(e.evidenceKind) &&
    nonBlank(e.sourceMessageId) &&
    nonBlank(e.conversationId) &&
    (e.traceId === undefined || nonBlank(e.traceId)) &&
    nonBlank(e.occurredAt) &&
    /^\d{4}-\d{2}-\d{2}T/.test(e.occurredAt)
  );
}

// ponytail: the DIRECT base, the distinct-conversation test and the replay
// check look at the last LEARNING_EVIDENCE_LIMIT sources only — a conversation,
// the only DIRECT source or an already-counted message older than that can be
// miscounted. Keep id sets if memories ever gather that much evidence.
function confidenceOf(evidence: LearningEvidence): number {
  const base = evidence.sources.some((s) => s.kind === "DIRECT") ? 0.7 : 0.55;
  const value = base + 0.1 * Math.max(0, evidence.conversations - 1);
  return Math.round(Math.min(0.95, Math.max(0, value)) * 100) / 100;
}

function start(source: LearningEvidenceSource): LearningEvidence {
  return {
    v: 1,
    count: 1,
    conversations: 1,
    firstSeenAt: source.at,
    lastSeenAt: source.at,
    sources: [source],
    revisions: 0,
    previousSourceMessageIds: [],
  };
}

/**
 * A memory from before L4, with no evidence: its own ids become one source —
 * recorded as the weaker kind, since its kind was never recorded — or, when it
 * lacks a message id, conversation id or creation time, nothing at all.
 */
function legacy(memorySource: LearningEvidenceContext["memorySource"]): LearningEvidence | null {
  const { messageId, conversationId, createdAt } = memorySource ?? {};
  if (!nonBlank(messageId) || !nonBlank(conversationId) || !nonBlank(createdAt)) return null;
  return start({ messageId, conversationId, kind: "ENDORSEMENT", at: createdAt });
}

function accepted(reason: "CREATED" | "CORROBORATED" | "REVISED", evidence: LearningEvidence): LearningEvidenceResult {
  return { accepted: true, reason, changed: true, refreshExpiry: true, confidence: confidenceOf(evidence), evidence };
}

/**
 * The next evidence of a memory for one event. Deterministic; the inputs are
 * never mutated.
 */
export function resolveLearningEvidence(
  event: LearningEvidenceEvent,
  existing: unknown,
  context: LearningEvidenceContext = {}
): LearningEvidenceResult {
  if (!isEvent(event)) return { accepted: false, reason: "INVALID_EVENT" };
  const source: LearningEvidenceSource = {
    messageId: event.sourceMessageId,
    conversationId: event.conversationId,
    ...(event.traceId !== undefined ? { traceId: event.traceId } : {}),
    kind: event.evidenceKind,
    at: event.occurredAt,
  };

  if (event.kind === "NEW") return accepted("CREATED", start(source));

  let base: LearningEvidence | null;
  if (existing === undefined || existing === null) base = legacy(context.memorySource);
  else if (isLearningEvidence(existing)) base = existing;
  else return { accepted: false, reason: "INVALID_EXISTING_EVIDENCE" };

  // A message already counted — a retry, a replay — changes nothing.
  if (base?.sources.some((s) => s.messageId === source.messageId)) {
    return { accepted: true, reason: "SOURCE_ALREADY_COUNTED", changed: false, refreshExpiry: false, confidence: confidenceOf(base), evidence: base };
  }

  if (event.kind === "REVISE") {
    const previous = context.memorySource?.messageId;
    return accepted("REVISED", {
      ...start(source),
      revisions: (base?.revisions ?? 0) + 1,
      lastRevisedAt: source.at,
      previousSourceMessageIds: [...(base?.previousSourceMessageIds ?? []), ...(nonBlank(previous) ? [previous] : [])].slice(
        -LEARNING_EVIDENCE_LIMIT
      ),
    });
  }

  if (!base) return accepted("CORROBORATED", start(source));
  const newConversation = !base.sources.some((s) => s.conversationId === source.conversationId);
  return accepted("CORROBORATED", {
    ...base,
    count: base.count + 1,
    conversations: base.conversations + (newConversation ? 1 : 0),
    lastSeenAt: source.at,
    sources: [...base.sources, source].slice(-LEARNING_EVIDENCE_LIMIT),
  });
}

// ---------------------------------------------------------------------------
// S7.2 L4.1 — negation safety.
//
// A statement and its negation are never the same statement, however many
// words they share: "prefers to receive the report" and "prefers not to
// receive the report" overlap 0.92 by words. Dedup asks this before it lets a
// match corroborate. A short, closed list of clear English negations; anything
// uncertain ("no", "nothing", "without", Hinglish) does not count as one.
// ---------------------------------------------------------------------------

/** "not" that negates nothing: "not only / just / merely", "whether or not", a contrast ", not …". */
const NOT_A_NEGATION = /\bnot\s+(?:only|just|merely)\b|\bwhether\s+or\s+not\b|,\s*not\b/g;
/** not (but not "not-for-profit"), never, cannot, no longer, and any n't contraction. */
const NEGATION = /\b(?:not\b(?!-)|never\b|cannot\b|no\s+longer\b)|\b[a-z]+n't\b/;

function negated(text: string): boolean {
  return NEGATION.test(text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(NOT_A_NEGATION, " "));
}

/** True when exactly one of the two statements carries a clear negation. */
export function hasNegationConflict(a: string, b: string): boolean {
  return negated(a) !== negated(b);
}
