import { z } from "zod";
import { RecommendationRecordSchema } from "./types/recommendation.js";
import {
  actionsConflict,
  type RecommendationAction,
  type RecommendationRecord,
  type RecommendationRisk,
} from "./types/recommendation.js";
import type { ConfidenceAssessment } from "./types/recommendation.js";

// ---------------------------------------------------------------------------
// Phase 11.9A — Controlled Optimization Opportunity Scoring
// ---------------------------------------------------------------------------
// Ranks ALREADY-VALID Phase 11.5 recommendations by relative business
// importance and execution suitability. This layer:
//   - NEVER creates, modifies, or executes recommendations.
//   - NEVER calls an LLM or any provider API. Pure functions over
//     server-validated records only.
//   - The score is NOT validity and NOT a probability of success. It expresses
//     "relative opportunity priority" for human review.
//
// Component provenance (no second systems invented):
//   severity    <- Phase 11.3 anomaly severities on the bound evidence
//   confidence  <- Phase 11.8B final combined confidence (consumed as-is)
//   risk        <- Phase 11.5 assessRisk result stored on the record
//   historical  <- Phase 11.8B ConfidenceAssessment fields (consumed as-is)
//   impact      <- relative exposure buckets from evidence metrics (never
//                  fabricated forecasts; IMPACT_UNKNOWN when unestimable)
//   urgency     <- anomaly age + deterioration velocity (deterministic)
//   reversibility<- fixed action-family classification table
//
// No durable score table: scoring is recomputed deterministically from the
// recommendation + its bound evidence (versioned via scoringVersion).
// ---------------------------------------------------------------------------

export const OPPORTUNITY_SCORING_VERSION = 1;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const OpportunityPriorityBandSchema = z.enum([
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "IGNORE",
]);
export type OpportunityPriorityBand = z.infer<typeof OpportunityPriorityBandSchema>;

/** Derived label — mirrors Phase 11.3 severities directly (spec §4). */
export const OpportunitySeverityLabelSchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
export type OpportunitySeverityLabel = z.infer<typeof OpportunitySeverityLabelSchema>;

export const OpportunityUrgencyLabelSchema = z.enum(["IMMEDIATE", "HIGH", "NORMAL", "LOW"]);
export type OpportunityUrgencyLabel = z.infer<typeof OpportunityUrgencyLabelSchema>;

/**
 * RELATIVE business-impact label. IMPACT_UNKNOWN is mandatory whenever the
 * evidence carries no usable exposure signals — numbers are never fabricated.
 */
export const OpportunityImpactLabelSchema = z.enum([
  "HIGH",
  "MODERATE",
  "LOW",
  "NEGLIGIBLE",
  "IMPACT_UNKNOWN",
]);
export type OpportunityImpactLabel = z.infer<typeof OpportunityImpactLabelSchema>;

export const OpportunityReversibilitySchema = z.enum([
  "HIGHLY_REVERSIBLE",
  "MODERATELY_REVERSIBLE",
  "HIGHER_IMPACT",
]);
export type OpportunityReversibility = z.infer<typeof OpportunityReversibilitySchema>;

export const OpportunityHistoricalStrengthSchema = z.enum(["NONE", "WEAK", "MODERATE", "STRONG"]);
export type OpportunityHistoricalStrength = z.infer<typeof OpportunityHistoricalStrengthSchema>;

export const OpportunityRationaleSchema = z
  .object({
    positiveFactors: z.array(z.string().max(200)).max(10),
    negativeFactors: z.array(z.string().max(200)).max(10),
    riskNote: z.string().max(300),
    historicalNote: z.string().max(300).nullable(),
    limitations: z.array(z.string().max(120)).max(20),
  })
  .strict();
export type OpportunityRationale = z.infer<typeof OpportunityRationaleSchema>;

export const OpportunityScoreSchema = z
  .object({
    recommendationId: z.string().min(1),
    accountId: z.string().min(1),
    entityId: z.string().min(1),
    actionType: z.string().min(1),
    /** Normalized relative opportunity priority, 0–100. NOT a probability. */
    score: z.number().int().min(0).max(100),
    priority: OpportunityPriorityBandSchema,
    severity: OpportunitySeverityLabelSchema,
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
    expectedImpact: OpportunityImpactLabelSchema,
    risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
    urgency: OpportunityUrgencyLabelSchema,
    historicalEvidenceStrength: OpportunityHistoricalStrengthSchema,
    reversibility: OpportunityReversibilitySchema,
    rationale: OpportunityRationaleSchema,
    /** True when this recommendation conflicts with another in the same batch (spec §13). */
    conflicted: z.boolean(),
    conflictWith: z.array(z.string()).max(50),
    scoringVersion: z.literal(OPPORTUNITY_SCORING_VERSION),
    calculatedAt: z.string().datetime(),
  })
  .strict();
export type OpportunityScore = z.infer<typeof OpportunityScoreSchema>;

// ---------------------------------------------------------------------------
// Eligibility (spec §12) — only records that already passed Phase 11.5 may be
// scored. Anything else is NOT_ELIGIBLE with a deterministic reason.
// ---------------------------------------------------------------------------

export type NotEligibleReason =
  | "INVALID_RECORD"
  | "UNAUTHORIZED"
  | "EXPIRED"
  | "STALE"
  | "REJECTED"
  | "ALREADY_EXECUTED"
  | "ALREADY_EXECUTING"
  | "MISSING_EVIDENCE";

export type OpportunityResult =
  | { eligible: true; score: OpportunityScore }
  | { eligible: false; reason: NotEligibleReason; recommendationId?: string };

export function evaluateEligibility(
  record: RecommendationRecord,
  requestingUserId: string,
  now: Date
): NotEligibleReason | null {
  // Contract re-validation: tampered/partial rows are simply not scoreable.
  if (!RecommendationRecordSchema.safeParse(record).success) return "INVALID_RECORD";
  if (record.userId !== requestingUserId) return "UNAUTHORIZED";
  if (!record.evidence?.evidenceHash || record.evidence.evidenceHash.length < 16) {
    return "MISSING_EVIDENCE";
  }
  // Executable recommendations are always bound to at least one anomaly by
  // the Phase 11.5 engine; an empty anomaly list means evidence was lost.
  if (!Array.isArray(record.evidence.anomalies) || record.evidence.anomalies.length === 0) {
    return "MISSING_EVIDENCE";
  }
  if (new Date(record.expiresAt).getTime() <= now.getTime()) return "EXPIRED";
  switch (record.status) {
    case "PROPOSED":
    case "APPROVED":
      break;
    case "EXECUTING":
      return "ALREADY_EXECUTING";
    case "EXECUTED":
      return "ALREADY_EXECUTED";
    case "REJECTED":
      return "REJECTED";
    case "STALE":
      return "STALE";
    case "FAILED":
      return "STALE";
    case "EXPIRED":
      return "EXPIRED";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reversibility classification (spec §9) — fixed table, no new categories.
// ---------------------------------------------------------------------------

export function classifyReversibility(actionType: RecommendationAction): {
  label: OpportunityReversibility;
  component: number;
} {
  switch (actionType) {
    case "PAUSE_AD":
    case "RESUME_AD":
      return { label: "HIGHLY_REVERSIBLE", component: 1.0 };
    case "PAUSE_AD_SET":
    case "RESUME_AD_SET":
      return { label: "MODERATELY_REVERSIBLE", component: 0.7 };
    case "INCREASE_BUDGET":
    case "DECREASE_BUDGET":
    case "PAUSE_CAMPAIGN":
    case "RESUME_CAMPAIGN":
      return { label: "HIGHER_IMPACT", component: 0.4 };
  }
}

// ---------------------------------------------------------------------------
// Configurable weights (spec §10). Defaults sum to 1.0.
// ---------------------------------------------------------------------------

export interface OpportunityWeights {
  severity: number;
  impact: number;
  urgency: number;
  confidence: number;
  historical: number;
  reversibility: number;
}

export const DEFAULT_OPPORTUNITY_WEIGHTS: Readonly<OpportunityWeights> = {
  severity: 0.25,
  impact: 0.2,
  urgency: 0.15,
  confidence: 0.15,
  historical: 0.1,
  reversibility: 0.05,
};

/** Risk penalty in points on the 0–100 scale (risk is never ignored — §6). */
export const RISK_PENALTY_POINTS: Record<RecommendationRisk, number> = {
  LOW: 0,
  MEDIUM: 6,
  HIGH: 12,
};

// ---------------------------------------------------------------------------
// Priority bands (spec §11) — inclusive lower bounds.
// ---------------------------------------------------------------------------

export function bandOf(score: number): OpportunityPriorityBand {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 40) return "MEDIUM";
  if (score >= 20) return "LOW";
  return "IGNORE";
}

// ---------------------------------------------------------------------------
// Deterministic components
// ---------------------------------------------------------------------------

function negativeAnomalies(record: RecommendationRecord) {
  return record.evidence.anomalies.filter((a) => a.direction === "NEGATIVE_ANOMALY");
}

function severityComponent(record: RecommendationRecord): { component: number; label: OpportunitySeverityLabel } {
  const neg = negativeAnomalies(record);
  const criticals = neg.filter((a) => a.severity === "CRITICAL").length;
  const warnings = neg.filter((a) => a.severity === "WARNING").length;
  // Any single CRITICAL anomaly already signals maximum severity pressure;
  // WARNING-class findings accumulate toward it.
  const component = criticals > 0 ? 1.0 : Math.min(1, warnings * 0.4);
  // Label mirrors Phase 11.3 vocabulary directly — no second severity system.
  const label: OpportunitySeverityLabel =
    criticals > 0 ? "CRITICAL" : warnings > 0 ? "MEDIUM" : "LOW";
  return { component, label };
}

/**
 * Relative business impact from evidence-supported signals ONLY:
 * spend exposure bucket + worst adverse metric change (CPA/ROAS/conversion/
 * revenue/CTR family). Never fabricates financial figures; when no signal
 * exists the component takes a documented neutral default and the contract
 * reports IMPACT_UNKNOWN (spec §3).
 */
function impactComponent(record: RecommendationRecord): {
  component: number;
  label: OpportunityImpactLabel;
  unknown: boolean;
} {
  let hadSignal = false;
  let component = 0;

  const spend = record.evidence.currentMetrics["spend"];
  if (typeof spend === "number" && Number.isFinite(spend) && spend > 0) {
    hadSignal = true;
    const bucket = spend >= 1000 ? 1.0 : spend >= 500 ? 0.8 : spend >= 100 ? 0.6 : 0.4;
    component = Math.max(component, bucket);
  }

  const HIGHER_IS_BETTER = new Set(["roas", "revenue", "conversions", "ctr", "cvr"]);
  let worstAdversePct = 0;
  for (const d of record.evidence.metricDetails) {
    const m = d.metric.toLowerCase();
    const pct = d.changePercent;
    if (pct === null || !Number.isFinite(pct)) continue;
    const adverse = HIGHER_IS_BETTER.has(m) ? -pct : pct > 0 ? pct : 0;
    if (adverse > worstAdversePct) worstAdversePct = adverse;
  }
  if (worstAdversePct >= 10) {
    hadSignal = true;
    const bump = worstAdversePct >= 50 ? 0.5 : worstAdversePct >= 25 ? 0.35 : 0.2;
    component = Math.min(1, component + bump);
  }

  if (!hadSignal) {
    return { component: 0.3, label: "IMPACT_UNKNOWN", unknown: true };
  }
  const label: OpportunityImpactLabel =
    component >= 0.7
      ? "HIGH"
      : component >= 0.45
      ? "MODERATE"
      : component >= 0.2
      ? "LOW"
      : "NEGLIGIBLE";
  return { component, label, unknown: false };
}

/**
 * Urgency from anomaly age × deterioration velocity (spec §7). Purely numeric;
 * arbitrary text is never consulted. Safe defaults when data is missing.
 */
function urgencyComponent(record: RecommendationRecord, now: Date): {
  component: number;
  label: OpportunityUrgencyLabel;
} {
  const neg = negativeAnomalies(record);
  if (neg.length === 0) return { component: 0.3, label: "LOW" };

  let ageFactor = 0.3;
  let newestMs = Number.POSITIVE_INFINITY;
  for (const a of neg) {
    const t = new Date(a.detectedAt).getTime();
    if (!Number.isNaN(t)) newestMs = Math.min(newestMs, now.getTime() - t);
  }
  if (newestMs !== Number.POSITIVE_INFINITY) {
    const hours = newestMs / 3_600_000;
    ageFactor = hours <= 24 ? 1.0 : hours <= 72 ? 0.75 : hours <= 168 ? 0.5 : 0.3;
  }

  let velocityFactor = 0.4;
  for (const a of neg) {
    const pct = a.percentDeviation !== null ? Math.abs(a.percentDeviation) : 0;
    const f = pct >= 50 ? 1.0 : pct >= 25 ? 0.8 : pct >= 10 ? 0.6 : 0.4;
    if (f > velocityFactor || velocityFactor === 0.4) velocityFactor = Math.max(velocityFactor, f);
  }

  const component = Math.min(1, 0.6 * ageFactor + 0.4 * velocityFactor);
  const label: OpportunityUrgencyLabel =
    component >= 0.8 ? "IMMEDIATE" : component >= 0.55 ? "HIGH" : component >= 0.35 ? "NORMAL" : "LOW";
  return { component, label };
}

function confidenceComponent(level: "HIGH" | "MEDIUM" | "LOW"): number {
  return level === "HIGH" ? 1.0 : level === "MEDIUM" ? 0.6 : 0.3;
}

/**
 * Historical contribution consumed from the Phase 11.8B assessment (never
 * recalculated here). May lift the score only when relevant, sufficiently
 * sampled, good-quality AND non-contradictory; mixed/negative consistency
 * caps it hard. Absent history is neutral (0.4), never punitive (§21).
 */
function historicalComponent(expl: ConfidenceAssessment | null | undefined): {
  component: number;
  strength: OpportunityHistoricalStrength;
} {
  if (!expl) return { component: 0.4, strength: "NONE" };
  const base =
    expl.historicalEvidence === "STRONG"
      ? 1.0
      : expl.historicalEvidence === "MODERATE"
      ? 0.65
      : expl.historicalEvidence === "WEAK"
      ? 0.25
      : 0.4;
  let capped = base;
  if (expl.historicalConsistency === "MIXED") capped = Math.min(capped, 0.3);
  if (expl.historicalConsistency === "CONSISTENT_NEGATIVE") capped = Math.min(capped, 0.2);
  return { component: capped, strength: expl.historicalEvidence };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface OpportunityContext {
  requestingUserId: string;
  now?: Date;
  weights?: Partial<OpportunityWeights>;
}

/**
 * Score ONE already-valid recommendation. Returns NOT_ELIGIBLE for anything
 * that should not be ranked (expired/stale/executed/invalid/unauthorized…).
 */
export function scoreOpportunity(
  record: RecommendationRecord,
  ctx: OpportunityContext
): OpportunityResult {
  const now = ctx.now ?? new Date();
  const reason = evaluateEligibility(record, ctx.requestingUserId, now);
  if (reason) return { eligible: false, reason, recommendationId: record.recommendationId };

  const w = { ...DEFAULT_OPPORTUNITY_WEIGHTS, ...ctx.weights };

  const sev = severityComponent(record);
  const imp = impactComponent(record);
  const urg = urgencyComponent(record, now);
  const conf = confidenceComponent(record.confidence);
  const hist = historicalComponent(record.confidenceExplanation);
  const rev = classifyReversibility(record.actionType);

  const raw =
    w.severity * sev.component +
    w.impact * imp.component +
    w.urgency * urg.component +
    w.confidence * conf +
    w.historical * hist.component +
    w.reversibility * rev.component;

  const penalty = RISK_PENALTY_POINTS[record.risk];
  const score = Math.max(0, Math.min(100, Math.round(raw * 100) - penalty));
  const priority = bandOf(score);

  // --- Explainability (deterministic templates — never AI text) ------------
  const positiveFactors: string[] = [];
  const negativeFactors: string[] = [];
  const limitations: string[] = [
    "SCORE_IS_RELATIVE_OPPORTUNITY_PRIORITY_NOT_SUCCESS_PROBABILITY",
  ];

  const critAnomaly = negativeAnomalies(record).find((a) => a.severity === "CRITICAL");
  if (critAnomaly) {
    positiveFactors.push(`severe ${critAnomaly.metric} deterioration`);
  }
  const spend = record.evidence.currentMetrics["spend"];
  if (typeof spend === "number" && spend >= 100) {
    positiveFactors.push(`high spend exposure (${Math.round(spend)} ${record.evidence.currency} window)`);
  }
  if (record.confidence === "HIGH") positiveFactors.push("strong diagnosis confidence");
  if (urg.label === "IMMEDIATE") positiveFactors.push("rapid recent deterioration");
  if (hist.strength === "STRONG") positiveFactors.push("strong consistent historical support");

  if (record.risk !== "LOW") negativeFactors.push(`action risk ${record.risk}`);
  if (imp.unknown) negativeFactors.push("business impact cannot be estimated");
  if (record.confidenceExplanation?.historicalConsistency === "MIXED") {
    negativeFactors.push("mixed historical outcomes");
  }
  if (record.confidence === "LOW") negativeFactors.push("low diagnosis confidence");

  const expl = record.confidenceExplanation;
  let historicalNote: string | null = null;
  if (expl && expl.historicalSampleSize > 0) {
    historicalNote = `${expl.historicalSampleSize} relevant historical outcome(s) sampled (${expl.sampleQuality}); ${expl.contradictoryEvidence.length} contradictory.`;
  } else {
    historicalNote = "No relevant historical evidence.";
  }

  if (imp.unknown) limitations.push("IMPACT_UNKNOWN_NO_RELIABLE_IMPACT_ESTIMATE");
  if (record.confidenceExplanation) {
    limitations.push(...record.confidenceExplanation.limitations.slice(0, 10));
  } else {
    limitations.push("NO_PHASE_118B_CONFIDENCE_ASSESSMENT_ON_RECORD");
  }

  const parsed = OpportunityScoreSchema.parse({
    recommendationId: record.recommendationId,
    accountId: record.accountId,
    entityId: record.entityId,
    actionType: record.actionType,
    score,
    priority,
    severity: sev.label,
    confidence: record.confidence,
    expectedImpact: imp.label,
    risk: record.risk,
    urgency: urg.label,
    historicalEvidenceStrength: hist.strength,
    reversibility: rev.label,
    rationale: {
      positiveFactors: positiveFactors.slice(0, 10),
      negativeFactors: negativeFactors.slice(0, 10),
      riskNote: `Action risk ${record.risk}. Higher risk reduces execution priority.`,
      historicalNote,
      limitations: limitations.slice(0, 20),
    },
    conflicted: false,
    conflictWith: [],
    scoringVersion: OPPORTUNITY_SCORING_VERSION,
    calculatedAt: now.toISOString(),
  });

  return { eligible: true, score: parsed };
}

// ---------------------------------------------------------------------------
// Conflict detection (spec §13) — flag only, never silently resolve.
// ---------------------------------------------------------------------------

export function detectConflicts(scores: OpportunityScore[]): void {
  const byEntity = new Map<string, OpportunityScore[]>();
  for (const s of scores) {
    const key = `${s.accountId}|${s.entityId}`;
    const list = byEntity.get(key);
    if (list) list.push(s);
    else byEntity.set(key, [s]);
  }
  for (const group of byEntity.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (actionsConflict(a.actionType as RecommendationAction, b.actionType as RecommendationAction)) {
          a.conflicted = true;
          b.conflicted = true;
          if (!a.conflictWith.includes(b.recommendationId)) a.conflictWith.push(b.recommendationId);
          if (!b.conflictWith.includes(a.recommendationId)) b.conflictWith.push(a.recommendationId);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Ranking (spec §15) — deterministic ordering with documented tie-breaks.
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
const URGENCY_RANK: Record<string, number> = { IMMEDIATE: 3, HIGH: 2, NORMAL: 1, LOW: 0 };
const CONFIDENCE_RANK: Record<string, number> = { HIGH: 2, MEDIUM: 1, LOW: 0 };

export function compareOpportunities(a: OpportunityScore, b: OpportunityScore): number {
  if (b.score !== a.score) return b.score - a.score; // score DESC
  const sd = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (sd !== 0) return sd;
  const ud = URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency];
  if (ud !== 0) return ud;
  const cd = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
  if (cd !== 0) return cd;
  const td = new Date(b.calculatedAt).getTime() - new Date(a.calculatedAt).getTime();
  if (td !== 0) return td; // newer first among fully-tied scores
  return a.recommendationId < b.recommendationId ? -1 : a.recommendationId > b.recommendationId ? 1 : 0;
}

export interface OpportunityRanking {
  accountId: string;
  items: OpportunityScore[];
  ineligible: Array<{ recommendationId: string; reason: NotEligibleReason }>;
}

/**
 * Rank the eligible recommendations of ONE account for human review.
 *
 * Isolation (spec §16): only records whose accountId matches AND whose owner
 * is the requesting user are considered — all others land in `ineligible`
 * with UNAUTHORIZED / are ignored outright.
 *
 * Duplicates (spec §14): recommendationId is the primary identity; repeated
 * ids beyond the first occurrence are skipped.
 *
 * Conflicts (spec §13): flagged via CONFLICTED before ranking; both sides stay
 * visible — the system never silently picks a winner.
 */
export function rankOpportunities(args: {
  accountId: string;
  records: RecommendationRecord[];
  context: OpportunityContext;
}): OpportunityRanking {
  const now = args.context.now ?? new Date();

  // Account isolation: foreign-account rows can never influence this ranking.
  const scoped = args.records.filter((r) => r.accountId === args.accountId);

  const eligibleScores: OpportunityScore[] = [];
  const ineligible: OpportunityRanking["ineligible"] = [];
  const seenIds = new Set<string>();

  for (const record of scoped) {
    if (seenIds.has(record.recommendationId)) continue; // duplicate identity
    seenIds.add(record.recommendationId);
    const res = scoreOpportunity(record, { ...args.context, now });
    if (res.eligible) eligibleScores.push(res.score);
    else ineligible.push({ recommendationId: res.recommendationId ?? "unknown", reason: res.reason });
  }

  detectConflicts(eligibleScores);
  eligibleScores.sort(compareOpportunities);

  return {
    accountId: args.accountId,
    items: eligibleScores,
    ineligible,
  };
}
