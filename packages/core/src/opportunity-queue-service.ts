// ---------------------------------------------------------------------------
// Phase 11.9B — Opportunity Queue Service
// ---------------------------------------------------------------------------
// Pure, deterministic service that:
//   1. Accepts RecommendationRecord[] (already fetched, account-scoped)
//   2. Calls the Phase 11.9A rankOpportunities() engine
//   3. Projects eligible scores into OpportunityQueueItem[] (list view)
//      and OpportunityQueueItemDetail (single review panel)
//   4. Applies server-side pagination + filtering
//
// Guarantees:
//   - NEVER writes to any store.
//   - NEVER calls an LLM, provider API, or external service.
//   - NEVER accepts accountId from the client — always server-supplied.
//   - Score, priority, and evidence are server-computed; clients cannot forge.
//   - All output validated against the existing Zod schemas from Phase 11.9A.
// ---------------------------------------------------------------------------

import type { RecommendationRecord } from "./types/recommendation.js";
import {
  rankOpportunities,
  mapRecommendationStatusToDisplayStatus,
  OpportunityQueueItemSchema,
  OpportunityQueueItemDetailSchema,
  type OpportunityQueueItem,
  type OpportunityQueueItemDetail,
  type OpportunityQueueDisplayStatus,
  type OpportunityPriorityBand,
  type OpportunityScore,
  OPPORTUNITY_SCORING_VERSION,
} from "./opportunity-scoring.js";

// ---------------------------------------------------------------------------
// Filter options — all optional; absence = no restriction
// ---------------------------------------------------------------------------

export interface OpportunityQueueFilter {
  /** Priority band filter: CRITICAL | HIGH | MEDIUM | LOW | IGNORE */
  priority?: OpportunityPriorityBand;
  /** Display status filter: NEW | REVIEWED | APPROVAL_PENDING | … */
  displayStatus?: OpportunityQueueDisplayStatus;
  /** Entity type filter: CAMPAIGN | AD_SET | AD */
  entityType?: string;
  /** Action type filter: PAUSE_AD | RESUME_AD | … */
  actionType?: string;
}

export interface OpportunityQueueOptions extends OpportunityQueueFilter {
  /** Maximum items to return (1–100; capped server-side). */
  limit?: number;
  /** Opaque cursor returned by a previous call for forward pagination. */
  cursor?: string;
  /** Override "now" for deterministic test scenarios. */
  now?: Date;
}

export interface OpportunityQueuePage {
  items: OpportunityQueueItem[];
  /** Opaque cursor. null = no more pages. */
  nextCursor: string | null;
  /** Total eligible items before pagination (for display purposes only). */
  totalEligible: number;
  /** Count of ineligible records skipped (expired/stale/unauthorized/etc.). */
  ineligibleCount: number;
}

// ---------------------------------------------------------------------------
// Explanation builder — deterministic templates, NEVER AI text
// ---------------------------------------------------------------------------

/**
 * Generates a one-paragraph "Why now?" explanation for the queue list view.
 * Uses only data already present in the ranked score — no LLM required.
 */
function buildExplanation(score: OpportunityScore, record: RecommendationRecord): string {
  const parts: string[] = [];

  // Lead with the most severe anomaly signal
  const critAnomaly = record.evidence.anomalies.find(
    (a) => a.severity === "CRITICAL" && a.direction === "NEGATIVE_ANOMALY"
  );
  if (critAnomaly) {
    const pct =
      critAnomaly.percentDeviation !== null
        ? ` (${Math.round(Math.abs(critAnomaly.percentDeviation))}% deviation)`
        : "";
    parts.push(`Critical ${critAnomaly.metric} anomaly detected${pct}.`);
  } else {
    const worstWarning = record.evidence.anomalies.find(
      (a) => a.severity === "WARNING" && a.direction === "NEGATIVE_ANOMALY"
    );
    if (worstWarning) {
      const pct =
        worstWarning.percentDeviation !== null
          ? ` (${Math.round(Math.abs(worstWarning.percentDeviation))}% deviation)`
          : "";
      parts.push(`${worstWarning.metric} deterioration detected${pct}.`);
    }
  }

  // Diagnosis context
  if (record.diagnosisCategory) {
    const pretty = record.diagnosisCategory.replace(/_/g, " ").toLowerCase();
    parts.push(`Diagnosis: likely ${pretty}.`);
  }

  // Historical evidence
  const expl = record.confidenceExplanation;
  if (expl && expl.historicalSampleSize > 0) {
    parts.push(
      `Historical evidence: ${expl.historicalSampleSize} similar case(s) sampled (${expl.sampleQuality}).`
    );
  }

  // Urgency qualifier
  if (score.urgency === "IMMEDIATE") {
    parts.push("Action is time-sensitive.");
  }

  // Risk qualifier
  if (score.risk === "HIGH") {
    parts.push("Note: action carries HIGH risk — review carefully.");
  }

  if (parts.length === 0) {
    parts.push("Opportunity detected based on current performance anomalies.");
  }

  return parts.join(" ").slice(0, 600);
}

// ---------------------------------------------------------------------------
// Projection — OpportunityScore + RecommendationRecord → OpportunityQueueItem
// ---------------------------------------------------------------------------

/**
 * Projects one scored opportunity into the safe public list-view shape.
 * All server-computed fields; client cannot forge any value.
 */
export function buildQueueItem(
  score: OpportunityScore,
  record: RecommendationRecord,
  now: Date
): OpportunityQueueItem {
  const displayStatus = mapRecommendationStatusToDisplayStatus(
    record.status,
    record.expiresAt,
    record.approvalId,
    now
  );

  const explanation = buildExplanation(score, record);

  return OpportunityQueueItemSchema.parse({
    recommendationId: record.recommendationId,
    accountId: record.accountId,
    entityId: record.entityId,
    entityType: record.entityLevel,
    actionType: record.actionType,
    objective: null,
    // Server-computed from Phase 11.9A
    score: score.score,
    priority: score.priority,
    severity: score.severity,
    confidence: score.confidence,
    expectedImpact: score.expectedImpact,
    risk: score.risk,
    urgency: score.urgency,
    reversibility: score.reversibility,
    historicalEvidenceStrength: score.historicalEvidenceStrength,
    explanation,
    rationale: score.rationale,
    // Evidence references (IDs only — no raw payload in list view)
    diagnosisId: record.diagnosisId,
    anomalyCount: record.evidence.anomalies.length,
    historicalSampleSize: record.confidenceExplanation?.historicalSampleSize ?? 0,
    // Lifecycle
    displayStatus,
    status: record.status,
    approvalId: record.approvalId,
    conflicted: score.conflicted,
    conflictWith: score.conflictWith,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    scoringVersion: OPPORTUNITY_SCORING_VERSION,
    calculatedAt: score.calculatedAt,
  });
}

// ---------------------------------------------------------------------------
// Projection — detail view (full human-review panel)
// ---------------------------------------------------------------------------

/**
 * Builds the full human-review detail for one opportunity.
 * Extends the list-item projection with full evidence breakdown.
 *
 * Secret exclusion:
 *   - approvalId references are safe (no token/key)
 *   - currentState / proposedState are the exact JSON stored at
 *     recommendation creation time; they contain entity IDs and status
 *     snapshots but NEVER access tokens.
 *   - raw evidence payloads (evidence.currentMetrics etc.) are projected
 *     into the safe subset defined in OpportunityQueueItemDetailSchema.
 */
export function buildQueueItemDetail(
  score: OpportunityScore,
  record: RecommendationRecord,
  now: Date
): OpportunityQueueItemDetail {
  const displayStatus = mapRecommendationStatusToDisplayStatus(
    record.status,
    record.expiresAt,
    record.approvalId,
    now
  );

  const explanation = buildExplanation(score, record);
  const expl = record.confidenceExplanation;

  // Safe metric details — only what's needed for review
  // MetricFact fields: { metric, current, previous, changePercent, unit, window, provenance }
  // OpportunityQueueItemDetail schema expects: { metric, currentValue, baselineValue, changePercent, direction }
  const metricDetails = record.evidence.metricDetails.map((d) => ({
    metric: d.metric,
    currentValue: typeof d.current === "number" ? d.current : null,
    baselineValue: typeof d.previous === "number" ? d.previous : null,
    changePercent: typeof d.changePercent === "number" ? d.changePercent : null,
    // Derive direction from changePercent (MetricFact has no explicit direction field)
    direction:
      d.changePercent === null || d.changePercent === undefined ? "STABLE"
      : d.changePercent > 5 ? "INCREASING"
      : d.changePercent < -5 ? "DECREASING"
      : "STABLE",
  }));

  // Safe anomaly summaries
  const anomalies = record.evidence.anomalies.map((a) => ({
    metric: a.metric,
    severity: a.severity,
    direction: a.direction,
    percentDeviation: typeof a.percentDeviation === "number" ? a.percentDeviation : null,
    detectedAt: a.detectedAt,
  }));

  // Historical evidence narrative
  const historicalNote =
    expl && expl.historicalSampleSize > 0
      ? `${expl.historicalSampleSize} relevant historical outcome(s) sampled (${expl.sampleQuality}); ${expl.contradictoryEvidence.length} contradictory.`
      : null;

  // Approval requirements (Phase 10 constraint summary — never implementation details)
  const toolId =
    record.actionType === "PAUSE_AD" ? "meta.ad.pause"
    : record.actionType === "RESUME_AD" ? "meta.ad.resume"
    : record.actionType === "PAUSE_AD_SET" ? "meta.adset.pause"
    : record.actionType === "RESUME_AD_SET" ? "meta.adset.resume"
    : record.actionType === "PAUSE_CAMPAIGN" ? "meta.campaign.pause"
    : record.actionType === "RESUME_CAMPAIGN" ? "meta.campaign.resume"
    : record.actionType === "INCREASE_BUDGET" ? "meta.campaign.budget.update"
    : "meta.campaign.budget.update";

  return OpportunityQueueItemDetailSchema.parse({
    recommendationId: record.recommendationId,
    accountId: record.accountId,
    entityId: record.entityId,
    entityType: record.entityLevel,
    actionType: record.actionType,
    objective: null,
    // Scoring
    score: score.score,
    priority: score.priority,
    severity: score.severity,
    confidence: score.confidence,
    expectedImpact: score.expectedImpact,
    risk: score.risk,
    urgency: score.urgency,
    reversibility: score.reversibility,
    historicalEvidenceStrength: score.historicalEvidenceStrength,
    explanation,
    diagnosisId: record.diagnosisId,
    anomalyCount: record.evidence.anomalies.length,
    historicalSampleSize: record.confidenceExplanation?.historicalSampleSize ?? 0,
    displayStatus,
    status: record.status,
    approvalId: record.approvalId,
    conflicted: score.conflicted,
    conflictWith: score.conflictWith,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    scoringVersion: OPPORTUNITY_SCORING_VERSION,
    calculatedAt: score.calculatedAt,
    // Detail-only fields
    diagnosisCategory: record.diagnosisCategory ?? null,
    reason: record.reason.slice(0, 2000),
    currentMetrics: record.evidence.currentMetrics,
    metricDetails,
    anomalies,
    currency: record.evidence.currency,
    currentState: record.currentState,
    proposedState: record.proposedState,
    historicalConsistency: expl?.historicalConsistency,
    contradictoryEvidenceCount: expl?.contradictoryEvidence.length ?? 0,
    sampleQuality: expl?.sampleQuality,
    historicalLimitations: expl?.limitations.slice(0, 20) ?? [],
    positiveFactors: score.rationale.positiveFactors,
    negativeFactors: score.rationale.negativeFactors,
    riskNote: score.rationale.riskNote,
    historicalNote,
    limitations: score.rationale.limitations,
    preconditions: record.preconditions,
    requiresApproval: true,
    approvalRequirements: {
      requiresHumanApproval: true,
      boundToUser: true,
      boundToTool: toolId,
      paramsHashProtected: true,
      expiresAt: record.expiresAt,
      staleStateProtected: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Queue builder — main entry point
// ---------------------------------------------------------------------------

/**
 * Build a ranked, paginated, filtered opportunity queue for one account.
 *
 * Isolation contract:
 *   - `accountId` is always supplied by the server (from ENV); never the client.
 *   - `requestingUserId` is always from `req.auth.userId`; never the client body.
 *   - Records whose accountId or userId doesn't match are silently excluded by
 *     the ranking engine (they land in `ineligible`).
 *
 * No writes. No LLM calls. No Meta calls.
 */
export function buildOpportunityQueue(
  records: RecommendationRecord[],
  accountId: string,
  requestingUserId: string,
  options: OpportunityQueueOptions = {}
): OpportunityQueuePage {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  // Phase 11.9A ranking (conflict detection + deterministic sort built in)
  const ranking = rankOpportunities({
    accountId,
    records,
    context: { requestingUserId, now },
  });

  // Build queue items from all eligible scores
  const allItems: OpportunityQueueItem[] = [];
  for (const score of ranking.items) {
    const record = records.find(
      (r) => r.recommendationId === score.recommendationId
    );
    if (!record) continue; // should never happen
    allItems.push(buildQueueItem(score, record, now));
  }

  // Apply display filters (server-side, after ranking)
  let filtered = allItems;
  if (options.priority) {
    filtered = filtered.filter((i) => i.priority === options.priority);
  }
  if (options.displayStatus) {
    filtered = filtered.filter((i) => i.displayStatus === options.displayStatus);
  }
  if (options.entityType) {
    filtered = filtered.filter(
      (i) => i.entityType.toUpperCase() === options.entityType!.toUpperCase()
    );
  }
  if (options.actionType) {
    filtered = filtered.filter(
      (i) => i.actionType.toUpperCase() === options.actionType!.toUpperCase()
    );
  }

  // Cursor-based pagination (cursor = recommendationId of the first excluded item)
  let startIdx = 0;
  if (options.cursor) {
    const cursorIdx = filtered.findIndex(
      (i) => i.recommendationId === options.cursor
    );
    if (cursorIdx >= 0) startIdx = cursorIdx;
  }

  const page = filtered.slice(startIdx, startIdx + limit);
  const nextCursorItem = filtered[startIdx + limit];
  const nextCursor = nextCursorItem ? nextCursorItem.recommendationId : null;

  return {
    items: page,
    nextCursor,
    totalEligible: filtered.length,
    ineligibleCount: ranking.ineligible.length,
  };
}

// ---------------------------------------------------------------------------
// Single-item detail lookup
// ---------------------------------------------------------------------------

/**
 * Find one recommendation by ID and build its full detail view.
 *
 * Returns null if:
 *   - Record not found in the provided list (caller should pre-filter by userId)
 *   - Record's accountId doesn't match the server-supplied accountId
 *   - Record is ineligible (expired/stale/etc.) — returns detail with
 *     appropriate displayStatus so the UI can show an expired notice
 */
export function buildOpportunityDetail(
  records: RecommendationRecord[],
  recommendationId: string,
  accountId: string,
  requestingUserId: string,
  now: Date = new Date()
): OpportunityQueueItemDetail | null {
  const record = records.find(
    (r) =>
      r.recommendationId === recommendationId &&
      r.accountId === accountId &&
      r.userId === requestingUserId
  );
  if (!record) return null;

  // Score the individual record (may be ineligible)
  const ranking = rankOpportunities({
    accountId,
    records: [record],
    context: { requestingUserId, now },
  });

  let score: OpportunityScore;

  if (ranking.items.length > 0) {
    score = ranking.items[0];
  } else {
    // Ineligible — synthesize a minimal score so the UI can show status
    const ineligibleReason = ranking.ineligible[0]?.reason ?? "EXPIRED";
    score = {
      recommendationId: record.recommendationId,
      accountId: record.accountId,
      entityId: record.entityId,
      actionType: record.actionType,
      score: 0,
      priority: "IGNORE",
      severity: "LOW",
      confidence: record.confidence,
      expectedImpact: "IMPACT_UNKNOWN",
      risk: record.risk,
      urgency: "LOW",
      historicalEvidenceStrength: "NONE",
      reversibility: "HIGHLY_REVERSIBLE",
      rationale: {
        positiveFactors: [],
        negativeFactors: [`Not eligible: ${ineligibleReason}`],
        riskNote: "Not eligible for review.",
        historicalNote: null,
        limitations: ["NOT_ELIGIBLE"],
      },
      conflicted: false,
      conflictWith: [],
      scoringVersion: OPPORTUNITY_SCORING_VERSION,
      calculatedAt: now.toISOString(),
    };
  }

  return buildQueueItemDetail(score, record, now);
}

// ---------------------------------------------------------------------------
// No-opportunity state explainer
// ---------------------------------------------------------------------------

export interface NoOpportunityExplanation {
  reason: "NO_ANOMALIES" | "BELOW_THRESHOLD" | "ALL_EXPIRED" | "INSUFFICIENT_DATA" | "NO_RECORDS";
  message: string;
}

/**
 * Provides a user-facing explanation when the queue is empty.
 * Never fabricates opportunities.
 */
export function explainNoOpportunities(
  records: RecommendationRecord[],
  totalEligible: number,
  ineligibleCount: number
): NoOpportunityExplanation {
  if (records.length === 0) {
    return {
      reason: "NO_RECORDS",
      message:
        "No recommendations have been generated for this account yet. " +
        "JARVIS will create opportunities when performance anomalies are detected.",
    };
  }
  if (ineligibleCount > 0 && totalEligible === 0) {
    return {
      reason: "ALL_EXPIRED",
      message:
        "All current recommendations have expired, been rejected, or already executed. " +
        "JARVIS will generate new opportunities when fresh anomalies are detected.",
    };
  }
  if (totalEligible === 0) {
    return {
      reason: "NO_ANOMALIES",
      message:
        "No actionable opportunities found. " +
        "This may mean no anomalies were detected in the current performance window, " +
        "or all detected issues require further investigation before a recommendation can be made.",
    };
  }
  return {
    reason: "BELOW_THRESHOLD",
    message:
      "Opportunities exist but were filtered by the selected criteria. " +
      "Try clearing filters to see all opportunities.",
  };
}
