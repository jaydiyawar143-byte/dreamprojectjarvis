import type { ConfidenceLevel, EvidencePackage, DiagnosisResult } from "./types/diagnosis.js";
import type {
  ConfidenceAssessment,
  RecommendationAction,
  RecommendationRisk,
  SampleQuality,
} from "./types/recommendation.js";
import type { HistoricalEvidence } from "./types/outcome.js";
import { computeParamsHash } from "./utils/params-hash.js";

// ---------------------------------------------------------------------------
// Phase 11.8B — Deterministic Recommendation Confidence & Priority Models
// ---------------------------------------------------------------------------
// Combines CURRENT evidence + CURRENT diagnosis + HISTORICAL evidence into a
// deterministic confidence level and priority. Pure functions only:
//   - No LLM calls. No randomness. No network.
//   - Historical outcomes are SUPPORTING EVIDENCE ONLY — never causal proof,
//     never a guarantee of future performance.
//   - Confidence is expressed ONLY as LOW / MEDIUM / HIGH. Numeric
//     probabilities are never exposed (spec §2).
//   - Every historical contribution is traceable via outcomeId (spec §12).
//
// CONFIDENCE COMBINATION TABLE (documented, deterministic):
//
//   current \ history | NONE | WEAK | MODERATE(pos) | STRONG(pos)
//   ------------------+------+------+---------------+------------
//   LOW               | LOW  | LOW  | LOW           | LOW
//   MEDIUM            | MED  | MED  | MED           | HIGH
//   HIGH              | HIGH | HIGH | HIGH          | HIGH
//
//   CONSISTENT_NEGATIVE history: downgrade one step from the current-evidence
//   level (HIGH→MEDIUM→LOW). MIXED history: also downgrade one step.
//   Weak/insufficient history NEVER penalizes a valid recommendation
//   excessively and NEVER lifts it (spec §3 "Insufficient history").
// ---------------------------------------------------------------------------

/** Configurable sample-quality thresholds (spec §4). Defaults match spec. */
export interface SampleSizeThresholds {
  /** n < veryLowMax ⇒ VERY_LOW_SAMPLE (default 3 → 1–2). */
  veryLowMax?: number;
  /** n < lowMax ⇒ LOW_SAMPLE (default 10 → 3–9); n ≥ lowMax ⇒ STRONGER_HISTORY. */
  lowMax?: number;
}

export const DEFAULT_SAMPLE_THRESHOLDS: Required<SampleSizeThresholds> = {
  veryLowMax: 3,
  lowMax: 10,
};

export function classifySampleSize(
  n: number,
  thresholds: SampleSizeThresholds = {}
): SampleQuality {
  const t = { ...DEFAULT_SAMPLE_THRESHOLDS, ...thresholds };
  if (n <= 0) return "NO_HISTORY";
  if (n < t.veryLowMax) return "VERY_LOW_SAMPLE";
  if (n < t.lowMax) return "LOW_SAMPLE";
  return "STRONGER_HISTORY";
}

export type HistoricalConsistency =
  | "NONE"
  | "CONSISTENT_POSITIVE"
  | "CONSISTENT_NEGATIVE"
  | "MIXED";

/**
 * Consistency over DECISIVE outcomes (POSITIVE vs NEGATIVE; NEUTRAL counts as
 * non-supporting either way):
 *   posRate ≥ 0.7            ⇒ CONSISTENT_POSITIVE  (8/9 decisive positive)
 *   negRate ≥ 0.7            ⇒ CONSISTENT_NEGATIVE
 *   both decisive & balanced ⇒ MIXED (5/5 splits reduce confidence)
 * The middle zone (0.35–0.7) is conservatively treated as MIXED so that
 * contradictory outcomes are never hidden.
 */
export function assessHistoricalConsistency(
  positiveRate: number,
  negativeRate: number,
  sampleSize: number
): HistoricalConsistency {
  if (sampleSize <= 0) return "NONE";
  if (positiveRate >= 0.7) return "CONSISTENT_POSITIVE";
  if (negativeRate >= 0.7) return "CONSISTENT_NEGATIVE";
  if (positiveRate > 0 && negativeRate > 0) return "MIXED";
  // Only POSITIVE-only or NEGATIVE-only small sets that missed the 0.7 cut
  // cannot occur mathematically; fall back to the dominant direction.
  return positiveRate >= negativeRate ? "CONSISTENT_POSITIVE" : "CONSISTENT_NEGATIVE";
}

export type HistoricalStrength = "NONE" | "WEAK" | "MODERATE" | "STRONG";

/**
 * Strength label for the historical side:
 *   NO_HISTORY                                  ⇒ NONE
 *   VERY_LOW_SAMPLE                             ⇒ WEAK (never boosts confidence)
 *   LOW_SAMPLE + consistent + good quality      ⇒ MODERATE
 *   STRONGER_HISTORY + consistent + good quality⇒ STRONG
 *   MIXED or CONSISTENT_NEGATIVE                ⇒ capped at WEAK
 *   MIXED_QUALITY data                          ⇒ capped at MODERATE
 */
export function assessHistoricalStrength(
  sampleQuality: SampleQuality,
  consistency: HistoricalConsistency,
  overallDataQuality: string
): HistoricalStrength {
  if (sampleQuality === "NO_HISTORY") return "NONE";
  if (sampleQuality === "VERY_LOW_SAMPLE") return "WEAK";

  let strength: HistoricalStrength =
    sampleQuality === "STRONGER_HISTORY" ? "STRONG" : "MODERATE";

  if (consistency === "MIXED" || consistency === "CONSISTENT_NEGATIVE") {
    strength = "WEAK"; // contradictory history is not strong support for acting
  }
  if (overallDataQuality === "MIXED_QUALITY" && strength === "STRONG") {
    strength = "MODERATE";
  }
  return strength;
}

const CONF_RANK: Record<ConfidenceLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
function rankToConfidence(rank: number): ConfidenceLevel {
  if (rank >= 3) return "HIGH";
  if (rank <= 1) return "LOW";
  return "MEDIUM";
}

/**
 * Pre-history current-evidence strength (spec §2 input).
 * Deterministic rules:
 *   HIGH   : diagnosis HIGH + COMPLETE data quality + ≥1 CRITICAL anomaly
 *   MEDIUM : everything else that is not weak
 *   LOW    : diagnosis LOW, INSUFFICIENT_DATA quality, or thin anomaly signal
 */
export function computeCurrentEvidenceStrength(
  diagnosis: DiagnosisResult,
  evidence: EvidencePackage
): ConfidenceLevel {
  const sigNeg = evidence.anomalies.filter(
    (a) => a.direction === "NEGATIVE_ANOMALY" && a.severity !== "NORMAL"
  );
  const criticals = sigNeg.filter((a) => a.severity === "CRITICAL").length;
  const warnings = sigNeg.filter((a) => a.severity === "WARNING").length;

  if (
    diagnosis.confidence === "HIGH" &&
    evidence.dataQuality === "COMPLETE" &&
    criticals >= 1
  ) {
    return "HIGH";
  }
  if (
    diagnosis.confidence === "LOW" ||
    evidence.dataQuality === "INSUFFICIENT_DATA" ||
    (criticals === 0 && warnings < 2)
  ) {
    return "LOW";
  }
  return "MEDIUM";
}

export interface ConfidenceAssessmentResult {
  /** Combined final confidence (= assessment.level). */
  level: ConfidenceLevel;
  /** Pre-history current-evidence strength ("confidence before history"). */
  beforeHistory: ConfidenceLevel;
  assessment: ConfidenceAssessment;
}

/**
 * Deterministic combination of current + historical evidence (spec §2–§9).
 * `historical` may be null when no history lookup happened (backward compat /
 * port absent): the assessment then reflects current evidence only.
 */
export function computeConfidenceAssessment(args: {
  diagnosis: DiagnosisResult;
  evidence: EvidencePackage;
  historical: HistoricalEvidence | null;
  thresholds?: SampleSizeThresholds;
}): ConfidenceAssessmentResult {
  const { diagnosis, evidence, historical } = args;
  const thresholds = args.thresholds ?? {};

  const beforeHistory = computeCurrentEvidenceStrength(diagnosis, evidence);

  if (!historical) {
    return {
      level: beforeHistory,
      beforeHistory,
      assessment: {
        level: beforeHistory,
        currentEvidence: beforeHistory,
        historicalEvidence: "NONE",
        sampleQuality: "NO_HISTORY",
        historicalSampleSize: 0,
        historicalConsistency: "NONE",
        contradictoryEvidence: [],
        limitations: ["HISTORY_NOT_EVALUATED"],
      },
    };
  }

  const stats = historical.summaryStatistics;
  const sampleQuality = classifySampleSize(stats.sampleSize, thresholds);
  const consistency = assessHistoricalConsistency(
    stats.positiveRate,
    stats.negativeRate,
    stats.sampleSize
  );
  const strength = assessHistoricalStrength(sampleQuality, consistency, stats.dataQuality);

  // Traceable contradictory outcomes (never hidden — spec §5, §12).
  // Capped at 500 (contract limit); the count remains visible via
  // historicalSampleSize and the NEGATIVE counters.
  const contradictoryEvidence = stats.relevantOutcomes
    .filter((o) => o.outcome === "NEGATIVE")
    .slice(0, 500)
    .map((o) => o.outcomeId);

  const limitations: string[] = [...historical.limitations];
  // Standing epistemic limitation — supporting evidence only (spec §13).
  limitations.push("HISTORY_IS_SUPPORTING_EVIDENCE_ONLY");
  if (sampleQuality === "VERY_LOW_SAMPLE") {
    limitations.push("INSUFFICIENT_SAMPLE_NO_CONFIDENCE_BOOST");
  }
  // Sample count NEVER implies statistical significance (spec §4).
  limitations.push("NO_STATISTICAL_SIGNIFICANCE_CLAIMED");

  // --- Combination table -------------------------------------------------
  let rank = CONF_RANK[beforeHistory];

  if (strength !== "NONE") {
    if (consistency === "CONSISTENT_POSITIVE") {
      // Positive history can only lift MEDIUM→HIGH, and only on a STRONG,
      // consistent, decently-sized history. Weak current stays weak.
      if (beforeHistory === "MEDIUM" && strength === "STRONG") rank += 1;
    } else if (consistency === "MIXED" || consistency === "CONSISTENT_NEGATIVE") {
      // Contradictory history always costs one step (never more — insufficient
      // history must not punish a valid recommendation excessively).
      rank -= 1;
    }
    // WEAK/MODERATE positive history never changes the pre-history level.
  }
  const level = rankToConfidence(rank);

  return {
    level,
    beforeHistory,
    assessment: {
      level,
      currentEvidence: beforeHistory,
      historicalEvidence: strength,
      sampleQuality,
      historicalSampleSize: stats.sampleSize,
      historicalConsistency: consistency,
      contradictoryEvidence,
      limitations,
    },
  };
}

// ---------------------------------------------------------------------------
// Priority model (spec §10) — deliberately NOT equal to confidence.
// ---------------------------------------------------------------------------
// Documented additive score:
//   base              : LOW=2, MEDIUM=3, HIGH=4               (final confidence)
//   critical severity : +2 if any CRITICAL negative anomaly
//   warning pressure  : +1 if ≥2 WARNING anomalies
//   blast radius      : CAMPAIGN-level entity +1, AD-level −1 (AD_SET 0)
//   risk brake        : −2 if recommendation risk is HIGH
//   history adj       : +1 STRONG consistent-positive history,
//                       −1 MIXED or CONSISTENT_NEGATIVE history
// Total clamped to [0..8]; mapped ≥5 HIGH, 3–4 MEDIUM, ≤2 LOW.
//
// Spec examples verified by unit tests:
//   HIGH confidence + low impact                    ⇒ MEDIUM priority
//   MEDIUM confidence + severe CPA deterioration
//     (+ optionally strong supporting history)      ⇒ HIGH priority
// ---------------------------------------------------------------------------
export function computePriority(args: {
  actionType: RecommendationAction;
  entityLevel: EvidencePackage["entityLevel"];
  risk: RecommendationRisk;
  confidence: ConfidenceLevel;
  anomalies: EvidencePackage["anomalies"];
  historicalStrength: HistoricalStrength;
  historicalConsistency: HistoricalConsistency;
}): "LOW" | "MEDIUM" | "HIGH" {
  const base: Record<ConfidenceLevel, number> = { LOW: 2, MEDIUM: 3, HIGH: 4 };
  let score: number = base[args.confidence];

  const sigNeg = args.anomalies.filter(
    (a) => a.direction === "NEGATIVE_ANOMALY" && a.severity !== "NORMAL"
  );
  if (sigNeg.some((a) => a.severity === "CRITICAL")) score += 2;
  if (sigNeg.filter((a) => a.severity === "WARNING").length >= 2) score += 1;

  if (args.entityLevel === "CAMPAIGN") score += 1;
  else if (args.entityLevel === "AD") score -= 1;

  if (args.risk === "HIGH") score -= 2;

  if (args.historicalConsistency === "CONSISTENT_POSITIVE" && args.historicalStrength === "STRONG") {
    score += 1;
  } else if (
    args.historicalConsistency === "MIXED" ||
    args.historicalConsistency === "CONSISTENT_NEGATIVE"
  ) {
    score -= 1;
  }

  if (score < 0) score = 0;
  if (score > 8) score = 8;

  if (score >= 5) return "HIGH";
  if (score >= 3) return "MEDIUM";
  return "LOW";
}

/**
 * Deterministic hash over the historical contribution for audit trails
 * (spec §17). Same inputs ⇒ same hash ⇒ tamper-evident audit records.
 */
export function computeHistoricalEvidenceHash(historical: HistoricalEvidence | null): string {
  if (!historical) return "no_history";
  const s = historical.summaryStatistics;
  return computeParamsHash({
    historyId: historical.historyId,
    matchingOutcomeIds: [...historical.matchingOutcomeIds].sort(),
    sampleSize: s.sampleSize,
    positiveCount: s.positiveCount,
    negativeCount: s.negativeCount,
    neutralCount: s.neutralCount,
    inconclusiveCount: s.inconclusiveCount,
    dataQuality: s.dataQuality,
  });
}
