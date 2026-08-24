import type { OutcomeRecord, HistoricalEvidence, HistoricalSummary } from "./types/outcome.js";
import type { RecommendationRecord } from "./types/recommendation.js";
import { familyOf } from "./types/recommendation.js";
import type { AggregationLevel } from "./types/performance-aggregation.js";
import type { DiagnosisCategory } from "./types/diagnosis.js";

export interface HistoricalEngineOptions {
  similarityThreshold?: number;
  halfLifeDays?: number;
  minStrongSample?: number;
  minLowSample?: number;
}

/**
 * Phase 11.8B — minimal candidate context required to evaluate historical
 * evidence. Lets the recommendation engine evaluate history BEFORE assembling
 * the full RecommendationRecord while reusing the exact Phase 11.8A matching,
 * recency, quality and consistency logic (single implementation).
 */
export interface HistoricalEvaluationContext {
  accountId: string;
  userId: string;
  entityLevel: AggregationLevel;
  entityId: string;
  actionType: RecommendationRecord["actionType"];
  diagnosisCategory: string | null;
  objective: string | null;
  /** Primary metric the candidate decision would be measured against. */
  primaryMetric: string;
}

/**
 * Deterministically evaluates a recommendation candidate against past finalized outcomes.
 * Zero LLM calls. Fully auditable and traceable.
 */
export function evaluateHistoricalEvidence(
  candidate: RecommendationRecord,
  pastOutcomes: OutcomeRecord[],
  options: HistoricalEngineOptions = {},
  referenceNow: Date = new Date()
): HistoricalEvidence {
  return evaluateHistoricalEvidenceForContext(
    {
      accountId: candidate.accountId,
      userId: candidate.userId,
      entityLevel: candidate.entityLevel,
      entityId: candidate.entityId,
      actionType: candidate.actionType,
      diagnosisCategory: candidate.diagnosisCategory ?? null,
      objective: candidate.evidence.objective ?? null,
      primaryMetric: candidate.expectedImpact.metric,
    },
    pastOutcomes,
    options,
    referenceNow,
    candidate.recommendationId
  );
}

/**
 * Context-based variant — identical deterministic logic to
 * {@link evaluateHistoricalEvidence}, operating on a lightweight candidate
 * description instead of a fully assembled record.
 */
export function evaluateHistoricalEvidenceForContext(
  ctx: HistoricalEvaluationContext,
  pastOutcomes: OutcomeRecord[],
  options: HistoricalEngineOptions = {},
  referenceNow: Date = new Date(),
  historyIdSeed: string = "ctx"
): HistoricalEvidence {
  const threshold = options.similarityThreshold ?? 0.5;
  const halfLifeDays = options.halfLifeDays ?? 90;
  const minStrongSample = options.minStrongSample ?? 10;
  const minLowSample = options.minLowSample ?? 3;

  const matchingOutcomeIds: string[] = [];
  const matchingCriteriaSet = new Set<string>();

  let sampleSize = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let neutralCount = 0;
  let inconclusiveCount = 0;

  let totalWeightedConfidence = 0;
  let totalWeight = 0;
  let hasPartial = false;

  const relevantOutcomes: HistoricalSummary["relevantOutcomes"] = [];

  for (const past of pastOutcomes) {
    // 1. Account Isolation & User Verification (Double Gate)
    if (past.accountId !== ctx.accountId || past.userId !== ctx.userId) {
      continue;
    }

    // 2. Exclude non-finalized records
    if (past.measurementState !== "FINALIZED") {
      continue;
    }

    // 3. Exclude unresolved attribution
    if (past.attributionStatus === "ATTRIBUTION_PENDING") {
      continue;
    }

    // 4. Exclude records with unreliable confounders
    const hasUnreliableConfounder = past.confounders.some(
      (c) => c.makesAttributionUnreliable === true
    );
    if (hasUnreliableConfounder) {
      continue;
    }

    // 5. Exclude poor data quality records
    if (past.dataQuality === "UNAVAILABLE" || past.dataQuality === "INSUFFICIENT_DATA") {
      continue;
    }

    // Calculate similarity score deterministically
    let score = 0;
    const currentCriteria: string[] = [];

    // Action Match
    if (past.actionType === ctx.actionType) {
      score += 0.3;
      currentCriteria.push("action_exact");
    } else if (familyOf(past.actionType) === familyOf(ctx.actionType)) {
      score += 0.1;
      currentCriteria.push("action_family");
    }

    // Diagnosis Category Match
    if (past.diagnosisCategory && ctx.diagnosisCategory && past.diagnosisCategory === ctx.diagnosisCategory) {
      score += 0.3;
      currentCriteria.push("diagnosis_category");
    }

    // Objective Match
    if (past.objective && ctx.objective && past.objective === ctx.objective) {
      score += 0.15;
      currentCriteria.push("objective");
    }

    // EntityType Match
    if (past.entityType === ctx.entityLevel) {
      score += 0.15;
      currentCriteria.push("entity_type");
    }

    // Primary Metric Match
    if (past.primaryMetric === ctx.primaryMetric) {
      // expectedImpact metric is usually SPEND but if we map, we check primaryMetric
      score += 0.1;
      currentCriteria.push("primary_metric");
    }

    if (score < threshold) {
      continue;
    }

    // Calculate Recency Weighting
    // W_recency = 0.5 ^ (daysSinceMeasured / halfLifeDays)
    const measuredDate = past.measuredAt ? new Date(past.measuredAt) : new Date(past.createdAt);
    const diffMs = referenceNow.getTime() - measuredDate.getTime();
    const diffDays = Math.max(0, diffMs / (1000 * 60 * 60 * 24));
    let recencyWeight = Math.pow(0.5, diffDays / halfLifeDays);
    recencyWeight = Math.max(0.1, recencyWeight); // Keep floor so it is not completely erased

    // Data Quality Weighting
    let qualityMultiplier = 1.0;
    if (past.dataQuality === "PARTIAL") {
      qualityMultiplier = 0.5;
      hasPartial = true;
    }

    // Final Deterministic Weight
    const weight = score * recencyWeight * qualityMultiplier;

    // Track matching outcome ID
    matchingOutcomeIds.push(past.outcomeId);
    currentCriteria.forEach((crit) => matchingCriteriaSet.add(crit));

    // Stats accumulation
    const outcomeVal = past.outcome;
    if (outcomeVal === "POSITIVE") {
      positiveCount++;
      sampleSize++;
    } else if (outcomeVal === "NEGATIVE") {
      negativeCount++;
      sampleSize++;
    } else if (outcomeVal === "NEUTRAL") {
      neutralCount++;
      sampleSize++;
    } else {
      inconclusiveCount++;
      // Inconclusive results do not count toward finalized sampleSize statistics
    }

    const conf = past.confidence ?? 0;
    totalWeightedConfidence += conf * weight;
    totalWeight += weight;

    relevantOutcomes.push({
      outcomeId: past.outcomeId,
      similarity: score,
      weight,
      outcome: past.outcome ?? "INCONCLUSIVE",
      measuredAt: past.measuredAt,
    });
  }

  // Calculate Rates
  const rateDenom = positiveCount + negativeCount + neutralCount;
  const positiveRate = rateDenom > 0 ? positiveCount / rateDenom : 0;
  const negativeRate = rateDenom > 0 ? negativeCount / rateDenom : 0;

  const averageConfidence = totalWeight > 0 ? totalWeightedConfidence / totalWeight : 0;

  // Determine overall data quality label
  let overallQuality = "HIGH_QUALITY";
  if (sampleSize === 0) {
    overallQuality = "NO_DATA";
  } else if (hasPartial) {
    overallQuality = "MIXED_QUALITY";
  }

  const summaryStatistics: HistoricalSummary = {
    sampleSize,
    positiveCount,
    negativeCount,
    neutralCount,
    inconclusiveCount,
    positiveRate,
    negativeRate,
    averageConfidence,
    relevantOutcomes,
    dataQuality: overallQuality,
  };

  // Evaluate limitations and status trend
  const limitations: string[] = [];
  let limitationsLabel = "";

  if (sampleSize === 0) {
    limitations.push("NO_RELEVANT_HISTORY");
    limitationsLabel = "NO_RELEVANT_HISTORY";
  } else if (sampleSize < minLowSample) {
    limitations.push("LIMITED_HISTORY");
    limitationsLabel = "LIMITED_HISTORY";
  } else if (sampleSize < minStrongSample) {
    limitations.push("LOW_SAMPLE");
    limitationsLabel = "LOW_SAMPLE";
  }

  // Conflicting / Mixed History
  // e.g. Positive vs Negative counts are close
  const hasConflict =
    sampleSize >= minLowSample &&
    positiveCount > 0 &&
    negativeCount > 0 &&
    Math.abs(positiveRate - negativeRate) < 0.3;
  if (hasConflict) {
    limitations.push("MIXED_HISTORY");
    limitationsLabel = limitationsLabel ? `${limitationsLabel}, MIXED_HISTORY` : "MIXED_HISTORY";
  }

  // Formulate description phrase enforcing NO CAUSAL CLAIMS guarantee
  const criteriaPhrase =
    positiveCount === sampleSize && sampleSize > 0
      ? "had positive measured outcomes"
      : positiveCount === 0 && sampleSize > 0
      ? "had negative measured outcomes"
      : "had mixed measured outcomes";

  const traceableDescription = sampleSize > 0
    ? `${positiveCount} of ${sampleSize} similar historical recommendations ${criteriaPhrase}.`
    : "No relevant historical outcomes found.";

  return {
    historyId: `hist_${historyIdSeed}_${referenceNow.getTime()}`,
    recommendationContext: {
      accountId: ctx.accountId,
      actionType: ctx.actionType,
      entityType: ctx.entityLevel,
      entityId: ctx.entityId,
      primaryMetric: ctx.primaryMetric as HistoricalEvidence["recommendationContext"]["primaryMetric"],
      diagnosisCategory: (ctx.diagnosisCategory as DiagnosisCategory) ?? null,
    },
    matchingOutcomeIds,
    matchingCriteria: Array.from(matchingCriteriaSet),
    sampleSize,
    summaryStatistics,
    weighting: {
      formula: "score * recencyWeight * qualityMultiplier",
      parameters: {
        similarityThreshold: threshold,
        halfLifeDays,
        minStrongSample,
        minLowSample,
        traceableDescription,
        verdict: limitationsLabel || "SUFFICIENT_HISTORY",
      },
    },
    limitations,
    generatedAt: referenceNow.toISOString(),
  };
}
