/**
 * ---------------------------------------------------------------------------
 * Phase 11.7A — Outcome Measurement Engine
 * ---------------------------------------------------------------------------
 * Deterministic, non-autonomous engine for measuring whether an approved
 * marketing action produced its intended outcome.
 *
 * HARD RULES:
 * - AI must NEVER override classification.
 * - No real Meta writes.
 * - No autonomous optimization.
 * - No worker or scheduler.
 * - No NaN or Infinity in any returned value.
 * - Baseline is captured ONCE and NEVER recalculated.
 * - Repeated measurement is idempotent.
 * - A FINALIZED outcome cannot be overwritten.
 * ---------------------------------------------------------------------------
 */

import { randomUUID } from "node:crypto";
import { calculateCanonicalKPIs, parseNumericValue } from "./kpi-engine.js";
import { calculateMetricComparison } from "./performance-aggregator.js";
import type { PerformanceSummary } from "./types/performance-aggregation.js";
import type { RecommendationAction } from "./types/recommendation.js";
import type { DiagnosisCategory } from "./types/diagnosis.js";
import {
  AGGREGATION_ENGINE_VERSION,
  ATTRIBUTION_WINDOW_MS,
  type BaselineKPIValues,
  type BaselineSnapshot,
  type ConfounderRecord,
  DEFAULT_MATERIALITY_THRESHOLD_PCT,
  type DataSufficiencyResult,
  KPI_ENGINE_VERSION,
  type KPIComparisonResult,
  MATERIALITY_THRESHOLDS,
  MAX_DATA_AGE_MS,
  MEASUREMENT_WINDOW_MS,
  MINIMUM_CONVERSIONS,
  MINIMUM_DATA_DAYS,
  MINIMUM_SPEND_USD,
  OUTCOME_SCHEMA_VERSION,
  type OutcomeEnum,
  type OutcomeMeasurementResult,
  type OutcomeRecord,
  PRIMARY_METRIC_DIRECTION,
  type PrimaryMetric,
  type MeasurementState,
  type MeasurementWindowConfig,
  STABILIZATION_MS_BUDGET,
  STABILIZATION_MS_PAUSE_RESUME,
} from "./types/outcome.js";

// ---------------------------------------------------------------------------
// 1. Baseline Snapshot Capture
// ---------------------------------------------------------------------------

/**
 * Capture an immutable baseline from a PerformanceSummary at execution time.
 * This snapshot MUST be stored at execution time and NEVER recalculated later.
 * The `fetchedAt` timestamp is frozen to the provided value (or now).
 */
export function captureBaselineSnapshot(
  summary: PerformanceSummary,
  options?: {
    kpiEngineVersion?: string;
    aggregationVersion?: string;
    fetchedAt?: string;
  }
): BaselineSnapshot {
  const kpis = summary.kpis;

  // Guarantee no NaN / Infinity seeps in via defensive re-parse
  const safeKPIs: BaselineKPIValues = {
    spend: safeFinite(kpis.spend, 0),
    impressions: Math.round(safeFinite(kpis.impressions, 0)),
    clicks: Math.round(safeFinite(kpis.clicks, 0)),
    reach: Math.round(safeFinite(kpis.reach, 0)),
    conversions: safeFinite(kpis.conversions, 0),
    revenue: safeFinite(kpis.revenue, 0),
    ctr: kpis.ctr !== null ? safeFiniteOrNull(kpis.ctr) : null,
    cpc: kpis.cpc !== null ? safeFiniteOrNull(kpis.cpc) : null,
    cpm: kpis.cpm !== null ? safeFiniteOrNull(kpis.cpm) : null,
    cpa: kpis.cpa !== null ? safeFiniteOrNull(kpis.cpa) : null,
    roas: kpis.roas !== null ? safeFiniteOrNull(kpis.roas) : null,
    cvr: kpis.cvr !== null ? safeFiniteOrNull(kpis.cvr) : null,
    frequency: kpis.frequency !== null ? safeFiniteOrNull(kpis.frequency) : null,
  };

  return {
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    dateRangeStart: summary.window.startDate,
    dateRangeEnd: summary.window.endDate,
    timezone: summary.timezone,
    currency: summary.currency,
    source: summary.source,
    fetchedAt: options?.fetchedAt ?? new Date().toISOString(),
    kpiEngineVersion: options?.kpiEngineVersion ?? KPI_ENGINE_VERSION,
    aggregationVersion: options?.aggregationVersion ?? AGGREGATION_ENGINE_VERSION,
    kpis: safeKPIs,
  };
}

// ---------------------------------------------------------------------------
// 2. Measurement Window Configuration
// ---------------------------------------------------------------------------

/**
 * Build a deterministic measurement window config from the action type.
 * Budget actions require longer stabilization (algo needs time to adapt).
 * These values are CONSTANTS — AI cannot modify them.
 */
export function buildMeasurementWindowConfig(
  actionType: RecommendationAction
): MeasurementWindowConfig {
  const isBudget =
    actionType === "INCREASE_BUDGET" || actionType === "DECREASE_BUDGET";

  return {
    stabilizationMs: isBudget ? STABILIZATION_MS_BUDGET : STABILIZATION_MS_PAUSE_RESUME,
    measurementMs: MEASUREMENT_WINDOW_MS,
    attributionWindowMs: ATTRIBUTION_WINDOW_MS,
    minimumDataDays: MINIMUM_DATA_DAYS,
    minimumSpend: MINIMUM_SPEND_USD,
    minimumConversions: MINIMUM_CONVERSIONS,
    maxDataAgeMs: MAX_DATA_AGE_MS,
  };
}

// ---------------------------------------------------------------------------
// 3. Measurement State Check
// ---------------------------------------------------------------------------

/**
 * Determine the current measurement state based on elapsed time.
 * State progression: WAITING_FOR_DATA → WAITING_FOR_ATTRIBUTION → READY → FINALIZED
 * Only the caller may set FINALIZED after successfully classifying an outcome.
 */
export function checkMeasurementState(
  executedAtIso: string,
  config: MeasurementWindowConfig,
  options?: {
    referenceNow?: Date;
    attributionStatus?: "ATTRIBUTION_READY" | "ATTRIBUTION_PENDING";
    isAlreadyFinalized?: boolean;
  }
): MeasurementState {
  if (options?.isAlreadyFinalized) return "FINALIZED";

  const now = options?.referenceNow ?? new Date();
  const executedAt = new Date(executedAtIso);
  const elapsedMs = now.getTime() - executedAt.getTime();

  // Phase 1: stabilization — do NOT read any metrics yet
  if (elapsedMs < config.stabilizationMs) {
    return "WAITING_FOR_DATA";
  }

  // Phase 2: attribution window — conversions may still arrive
  if (
    options?.attributionStatus === "ATTRIBUTION_PENDING" &&
    elapsedMs < config.attributionWindowMs
  ) {
    return "WAITING_FOR_ATTRIBUTION";
  }

  return "READY";
}

// ---------------------------------------------------------------------------
// 4. Attribution Status
// ---------------------------------------------------------------------------

/**
 * Determine attribution status.
 * Zero conversions immediately after an action are NOT treated as failure
 * when the attribution window is still open.
 */
export function determineAttributionStatus(
  executedAtIso: string,
  config: MeasurementWindowConfig,
  referenceNow: Date = new Date()
): "ATTRIBUTION_READY" | "ATTRIBUTION_PENDING" {
  const elapsed = referenceNow.getTime() - new Date(executedAtIso).getTime();
  return elapsed >= config.attributionWindowMs
    ? "ATTRIBUTION_READY"
    : "ATTRIBUTION_PENDING";
}

// ---------------------------------------------------------------------------
// 5. Objective-Aware Metric Direction
// ---------------------------------------------------------------------------

/**
 * Deterministic direction for primary metric.
 * Returns null for CONTEXT_DEPENDENT metrics (cannot classify without more context).
 */
export function getPrimaryMetricDirection(
  metric: PrimaryMetric
): "LOWER_IS_BETTER" | "HIGHER_IS_BETTER" | null {
  const dir = PRIMARY_METRIC_DIRECTION[metric];
  if (dir === "CONTEXT_DEPENDENT") return null;
  return dir;
}

// ---------------------------------------------------------------------------
// 6. KPI Comparison — reuses Phase 11.2 canonical engine
// ---------------------------------------------------------------------------

/**
 * Extract a named KPI value from a BaselineKPIValues snapshot.
 * NEVER returns NaN or Infinity.
 */
function extractKPIValue(kpis: BaselineKPIValues, metric: PrimaryMetric): number | null {
  switch (metric) {
    case "CPA":
      return kpis.cpa;
    case "CPC":
      return kpis.cpc;
    case "CTR":
      return kpis.ctr;
    case "CVR":
      return kpis.cvr;
    case "ROAS":
      return kpis.roas;
    case "REVENUE":
      return safeFiniteOrNull(kpis.revenue);
    case "CONVERSIONS":
      return safeFiniteOrNull(kpis.conversions);
    case "SPEND":
      return safeFiniteOrNull(kpis.spend);
    case "IMPRESSIONS":
      return safeFiniteOrNull(kpis.impressions);
    case "CLICKS":
      return safeFiniteOrNull(kpis.clicks);
    case "CPM":
      return kpis.cpm;
    case "FREQUENCY":
      return kpis.frequency;
  }
}

/**
 * Compare KPI values between baseline and current measurement.
 * Reuses Phase 11.2 calculateMetricComparison — guarantees no NaN/Infinity.
 * Direction is objective-aware (lower/higher is better per METRIC_DIRECTION table).
 */
export function compareKPIValues(
  baseline: BaselineKPIValues,
  current: BaselineKPIValues,
  metric: PrimaryMetric
): KPIComparisonResult {
  const baselineVal = extractKPIValue(baseline, metric);
  const currentVal = extractKPIValue(current, metric);

  // Use Phase 11.2 canonical comparison — no NaN/Infinity
  const comparison = calculateMetricComparison(currentVal, baselineVal);

  const direction = getComparisonDirection(
    comparison.changePercent,
    metric
  );

  const materialityThreshold =
    MATERIALITY_THRESHOLDS[metric] ?? DEFAULT_MATERIALITY_THRESHOLD_PCT;

  const isMaterial =
    comparison.changePercent !== null &&
    Math.abs(comparison.changePercent) >= materialityThreshold;

  return {
    metric,
    baseline: comparison.previous,
    current: comparison.current,
    absoluteChange:
      comparison.changeAbsolute !== null
        ? safeFinite(comparison.changeAbsolute, 0)
        : null,
    percentChange:
      comparison.changePercent !== null
        ? safeFinite(comparison.changePercent, 0)
        : null,
    direction,
    isMaterial,
  };
}

function getComparisonDirection(
  changePercent: number | null,
  metric: PrimaryMetric
): KPIComparisonResult["direction"] {
  if (changePercent === null) return "UNDEFINED";
  if (Math.abs(changePercent) < 0.001) return "UNCHANGED";

  const dir = PRIMARY_METRIC_DIRECTION[metric];
  if (dir === "CONTEXT_DEPENDENT") {
    // Cannot determine good/bad without knowing intent
    return changePercent > 0 ? "IMPROVED" : "WORSENED";
  }

  if (dir === "HIGHER_IS_BETTER") {
    return changePercent > 0 ? "IMPROVED" : "WORSENED";
  }
  // LOWER_IS_BETTER
  return changePercent < 0 ? "IMPROVED" : "WORSENED";
}

// ---------------------------------------------------------------------------
// 7. Data Sufficiency Check
// ---------------------------------------------------------------------------

export interface DataSufficiencyInput {
  executedAtIso: string;
  config: MeasurementWindowConfig;
  currentKPIs: BaselineKPIValues;
  dataQuality: "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "INSUFFICIENT_DATA";
  daysWithData: number;
  /** Timestamp of the most recent data point. Null if no data. */
  mostRecentDataPointAt?: string | null;
  referenceNow?: Date;
}

/**
 * Deterministic data sufficiency check.
 * If insufficient: outcome must be INCONCLUSIVE or WAITING_FOR_DATA.
 * Never guess.
 */
export function checkDataSufficiency(input: DataSufficiencyInput): DataSufficiencyResult {
  const now = input.referenceNow ?? new Date();
  const executedAt = new Date(input.executedAtIso);
  const elapsedMs = Math.max(0, now.getTime() - executedAt.getTime());
  const reasons: string[] = [];

  // Check elapsed time
  if (elapsedMs < input.config.stabilizationMs) {
    reasons.push(
      `Stabilization period not elapsed (${Math.round(elapsedMs / 3600000)}h < ${Math.round(input.config.stabilizationMs / 3600000)}h)`
    );
  }

  // Check data days
  if (input.daysWithData < input.config.minimumDataDays) {
    reasons.push(
      `Insufficient data days (${input.daysWithData} < ${input.config.minimumDataDays} required)`
    );
  }

  // Check spend
  if (input.currentKPIs.spend < input.config.minimumSpend) {
    reasons.push(
      `Insufficient spend ($${input.currentKPIs.spend} < $${input.config.minimumSpend} required)`
    );
  }

  // Check data quality
  if (input.dataQuality === "UNAVAILABLE") {
    reasons.push("Data quality: UNAVAILABLE");
  } else if (input.dataQuality === "INSUFFICIENT_DATA") {
    reasons.push("Data quality: INSUFFICIENT_DATA");
  }

  // Check staleness
  let dataAgeDays: number | null = null;
  let isStale = false;
  if (input.mostRecentDataPointAt) {
    const dataAge = now.getTime() - new Date(input.mostRecentDataPointAt).getTime();
    dataAgeDays = dataAge / (1000 * 60 * 60 * 24);
    isStale = dataAge > input.config.maxDataAgeMs;
    if (isStale) {
      reasons.push(
        `Data is stale (most recent: ${Math.round(dataAgeDays * 10) / 10} days ago)`
      );
    }
  }

  const isPartial =
    input.dataQuality === "PARTIAL" ||
    (input.daysWithData > 0 && input.daysWithData < input.config.minimumDataDays);

  if (isPartial && !reasons.includes("Data quality: PARTIAL")) {
    reasons.push("Data is partial");
  }

  return {
    sufficient: reasons.length === 0,
    elapsedMs,
    dataAgeDays,
    daysWithData: input.daysWithData,
    totalSpend: input.currentKPIs.spend,
    totalConversions: input.currentKPIs.conversions,
    isStale,
    isPartial,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 8. Confounder Detection
// ---------------------------------------------------------------------------

export interface ConfounderDetectionInput {
  /** ISO timestamps + descriptions of external events during measurement window. */
  externalEvents?: Array<{
    type: ConfounderRecord["type"];
    detectedAt: string;
    description: string;
  }>;
  /** Whether another recommendation was executed on the same entity in this window. */
  overlappingRecommendations?: Array<{
    recommendationId: string;
    executedAt: string;
  }>;
}

/**
 * Detect and record confounders during the measurement window.
 * Confounders that make attribution unreliable will force INCONCLUSIVE.
 */
export function detectConfounders(
  input: ConfounderDetectionInput
): ConfounderRecord[] {
  const confounders: ConfounderRecord[] = [];

  // External events (budget changes, status changes, targeting, creative, tracking)
  for (const event of input.externalEvents ?? []) {
    const makesUnreliable =
      event.type === "EXTERNAL_BUDGET_CHANGE" ||
      event.type === "EXTERNAL_STATUS_CHANGE" ||
      event.type === "TARGETING_CHANGE" ||
      event.type === "TRACKING_CHANGE";

    confounders.push({
      type: event.type,
      detectedAt: event.detectedAt,
      description: event.description,
      makesAttributionUnreliable: makesUnreliable,
    });
  }

  // Overlapping recommendations
  for (const overlap of input.overlappingRecommendations ?? []) {
    confounders.push({
      type: "OVERLAPPING_RECOMMENDATION",
      detectedAt: overlap.executedAt,
      description: `Overlapping recommendation ${overlap.recommendationId} was executed during measurement window`,
      makesAttributionUnreliable: true,
    });
  }

  return confounders;
}

// ---------------------------------------------------------------------------
// 9. Confidence Computation
// ---------------------------------------------------------------------------

/**
 * Compute outcome confidence 0–1.
 * Reduces confidence for confounders, stale/partial data, low spend,
 * and attribution-pending state. AI cannot adjust this.
 */
export function computeOutcomeConfidence(
  sufficiency: DataSufficiencyResult,
  confounders: ConfounderRecord[],
  attributionStatus: "ATTRIBUTION_READY" | "ATTRIBUTION_PENDING"
): number {
  let confidence = 1.0;

  // Stale data: large penalty
  if (sufficiency.isStale) confidence -= 0.4;

  // Partial data: moderate penalty
  if (sufficiency.isPartial) confidence -= 0.2;

  // Each unreliable confounder: steep penalty
  const unreliableCount = confounders.filter((c) => c.makesAttributionUnreliable).length;
  confidence -= unreliableCount * 0.25;

  // Each reliable (non-unreliable) confounder: small penalty
  const reliableConfounderCount = confounders.filter(
    (c) => !c.makesAttributionUnreliable
  ).length;
  confidence -= reliableConfounderCount * 0.05;

  // Attribution still pending: moderate penalty
  if (attributionStatus === "ATTRIBUTION_PENDING") confidence -= 0.15;

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, Math.round(confidence * 1000) / 1000));
}

// ---------------------------------------------------------------------------
// 10. Outcome Classification — DETERMINISTIC RULES ONLY
// ---------------------------------------------------------------------------

export interface ClassificationInput {
  comparison: KPIComparisonResult | null;
  sufficiency: DataSufficiencyResult;
  confounders: ConfounderRecord[];
  attributionStatus: "ATTRIBUTION_READY" | "ATTRIBUTION_PENDING";
  executionDefinitelyFailed: boolean;
  measurementState: MeasurementState;
}

/**
 * DETERMINISTIC outcome classification.
 * AI must NEVER override or influence this function's output.
 *
 * Rules (in priority order):
 * 1. FAILED_ACTION — execution definitively failed
 * 2. WAITING_FOR_DATA — stabilization not elapsed
 * 3. INCONCLUSIVE — attribution-unreliable confounder present
 * 4. INCONCLUSIVE — insufficient / stale / partial data
 * 5. NOT_MEASURABLE — primary metric null on both sides
 * 6. POSITIVE — metric materially improves + direction = IMPROVED
 * 7. NEGATIVE — metric materially worsens + direction = WORSENED
 * 8. NEUTRAL — change below materiality threshold
 * 9. INCONCLUSIVE — fallback
 */
export function classifyOutcome(input: ClassificationInput): OutcomeEnum {
  // Rule 1: execution failure
  if (input.executionDefinitelyFailed) return "FAILED_ACTION";

  // Rule 2: still waiting for data
  if (
    input.measurementState === "WAITING_FOR_DATA" ||
    input.measurementState === "WAITING_FOR_ATTRIBUTION"
  ) {
    return "INCONCLUSIVE";
  }

  // Rule 3: unreliable confounder — attribution poisoned
  const hasUnreliableConfounder = input.confounders.some(
    (c) => c.makesAttributionUnreliable
  );
  if (hasUnreliableConfounder) return "INCONCLUSIVE";

  // Rule 4: insufficient data
  if (!input.sufficiency.sufficient) return "INCONCLUSIVE";
  if (input.sufficiency.isStale) return "INCONCLUSIVE";
  // Partial data alone doesn't force INCONCLUSIVE if all other criteria are met
  // and confidence will be reduced instead

  // Rule 5: unmeasurable — both sides null
  if (input.comparison === null) return "INCONCLUSIVE";
  if (input.comparison.baseline === null && input.comparison.current === null) {
    return "NOT_MEASURABLE";
  }

  // Rules 6-8: apply direction + materiality
  const { direction, isMaterial } = input.comparison;

  if (direction === "IMPROVED" && isMaterial) return "POSITIVE";
  if (direction === "WORSENED" && isMaterial) return "NEGATIVE";

  // Rule 8: NEUTRAL — change exists but below materiality threshold
  if (direction === "UNCHANGED" || (direction !== "UNDEFINED" && !isMaterial)) {
    return "NEUTRAL";
  }

  // Rule 9: fallback
  return "INCONCLUSIVE";
}

// ---------------------------------------------------------------------------
// 11. Current KPI computation — reuses Phase 11.2 canonical engine
// ---------------------------------------------------------------------------

/**
 * Compute current KPI values from raw metric inputs.
 * Reuses calculateCanonicalKPIs — NEVER uses ad-hoc averages of child KPIs.
 */
export function computeCurrentKPIs(rawInputs: {
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  conversions: number;
  revenue: number;
}): BaselineKPIValues {
  const calculated = calculateCanonicalKPIs({
    spend: rawInputs.spend,
    impressions: rawInputs.impressions,
    clicks: rawInputs.clicks,
    reach: rawInputs.reach,
    conversions: rawInputs.conversions,
    revenue: rawInputs.revenue,
  });

  return {
    spend: safeFinite(calculated.spend, 0),
    impressions: Math.round(safeFinite(calculated.impressions, 0)),
    clicks: Math.round(safeFinite(calculated.clicks, 0)),
    reach: Math.round(safeFinite(calculated.reach, 0)),
    conversions: safeFinite(calculated.conversions, 0),
    revenue: safeFinite(calculated.revenue, 0),
    ctr: calculated.ctr !== null ? safeFiniteOrNull(calculated.ctr) : null,
    cpc: calculated.cpc !== null ? safeFiniteOrNull(calculated.cpc) : null,
    cpm: calculated.cpm !== null ? safeFiniteOrNull(calculated.cpm) : null,
    cpa: calculated.cpa !== null ? safeFiniteOrNull(calculated.cpa) : null,
    roas: calculated.roas !== null ? safeFiniteOrNull(calculated.roas) : null,
    cvr: calculated.cvr !== null ? safeFiniteOrNull(calculated.cvr) : null,
    frequency: calculated.frequency !== null ? safeFiniteOrNull(calculated.frequency) : null,
  };
}

// ---------------------------------------------------------------------------
// 12. Full Measurement Pipeline
// ---------------------------------------------------------------------------

export interface MeasureOutcomeInput {
  /** Stable identifiers */
  outcomeId?: string;
  recommendationId: string;
  executionId: string;
  accountId: string;
  /**
   * R-32 — the diagnosis category the recommendation answered.
   *
   * `OutcomeRecordSchema` has always declared this field, the repository
   * persists it and `findFinalizedOutcomes` filters on that column, but the
   * engine never carried it, so every stored row held null and category-based
   * historical matching could not match. Optional, so every existing caller
   * keeps compiling, and null when unknown.
   */
  diagnosisCategory?: DiagnosisCategory | null;
  entityType: OutcomeRecord["entityType"];
  entityId: string;
  actionType: RecommendationAction;
  objective?: string | null;
  primaryMetric: PrimaryMetric;
  /** Immutable baseline captured at execution time */
  baseline: BaselineSnapshot;
  /** Whether the execution definitively failed (status = FAILED/UNKNOWN with no partial) */
  executionDefinitelyFailed?: boolean;
  /** Current raw metric inputs (post-action). Null → cannot measure yet. */
  currentRawInputs?: {
    spend: number;
    impressions: number;
    clicks: number;
    reach: number;
    conversions: number;
    revenue: number;
  } | null;
  /** Data quality of current measurement window. */
  dataQuality?: "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "INSUFFICIENT_DATA";
  /** How many calendar days of data are present in measurement window. */
  daysWithData?: number;
  /** Timestamp of most recent data point available. */
  mostRecentDataPointAt?: string | null;
  /** ISO-8601 timestamp when the execution was confirmed. */
  executedAtIso: string;
  /** Optional confounder detection inputs */
  confounderInput?: ConfounderDetectionInput;
  /** Override reference time (for testing). */
  referenceNow?: Date;
  /** Whether outcome is already FINALIZED. */
  isAlreadyFinalized?: boolean;
  createdAt?: string;
  /** Owner of this outcome. */
  userId?: string;
  /** Current measurement state override. */
  measurementState?: MeasurementState;
}

/**
 * Full deterministic outcome measurement pipeline.
 * Idempotent: repeated calls with the same inputs produce the same result.
 * FINALIZED outcomes are returned as-is without reclassification.
 */
export function measureOutcome(input: MeasureOutcomeInput): OutcomeMeasurementResult {
  const now = input.referenceNow ?? new Date();
  const outcomeId = input.outcomeId ?? randomUUID();
  const createdAt = input.createdAt ?? now.toISOString();

  // Build deterministic measurement window config
  const config = buildMeasurementWindowConfig(input.actionType);

  // Determine attribution status
  const attributionStatus = determineAttributionStatus(input.executedAtIso, config, now);

  // Check measurement state
  const measurementState = checkMeasurementState(input.executedAtIso, config, {
    referenceNow: now,
    attributionStatus,
    isAlreadyFinalized: input.isAlreadyFinalized,
  });

  // Detect confounders
  const confounders = detectConfounders(input.confounderInput ?? {});

  // Build current KPIs (if data is available)
  let currentKPIs: BaselineKPIValues | null = null;
  if (input.currentRawInputs !== null && input.currentRawInputs !== undefined) {
    currentKPIs = computeCurrentKPIs(input.currentRawInputs);
  }

  // Data sufficiency
  const dq = input.dataQuality ?? (currentKPIs ? "COMPLETE" : "UNAVAILABLE");
  const sufficiency = checkDataSufficiency({
    executedAtIso: input.executedAtIso,
    config,
    currentKPIs: currentKPIs ?? zeroKPIs(),
    dataQuality: dq,
    daysWithData: input.daysWithData ?? 0,
    mostRecentDataPointAt: input.mostRecentDataPointAt,
    referenceNow: now,
  });

  // KPI comparison
  let comparison: KPIComparisonResult | null = null;
  if (currentKPIs !== null) {
    comparison = compareKPIValues(input.baseline.kpis, currentKPIs, input.primaryMetric);
  }

  // Classification
  const outcomeEnum = classifyOutcome({
    comparison,
    sufficiency,
    confounders,
    attributionStatus,
    executionDefinitelyFailed: input.executionDefinitelyFailed ?? false,
    measurementState,
  });

  // Confidence
  const confidence = computeOutcomeConfidence(sufficiency, confounders, attributionStatus);

  const measuredAt =
    measurementState === "READY" || measurementState === "FINALIZED"
      ? now.toISOString()
      : null;

  const outcomeRecord: OutcomeRecord = {
    outcomeId,
    recommendationId: input.recommendationId,
    executionId: input.executionId,
    accountId: input.accountId,
    // R-32 — null, never undefined: the column is nullable and a category
    // filter can reason about null.
    diagnosisCategory: input.diagnosisCategory ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    actionType: input.actionType,
    objective: input.objective ?? null,
    primaryMetric: input.primaryMetric,
    baseline: input.baseline,
    measurement: currentKPIs,
    comparison,
    outcome: outcomeEnum,
    confidence,
    dataQuality: dq,
    attributionStatus,
    confounders,
    measurementWindow: config,
    measuredAt,
    createdAt,
    userId: input.userId ?? "unknown_user",
    measurementState: input.measurementState ?? measurementState,
  };

  return {
    outcomeRecord,
    measurementState,
    sufficiency,
    classifiedAt: measuredAt,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers — no NaN / Infinity guarantees
// ---------------------------------------------------------------------------

function safeFinite(val: number, fallback: number): number {
  return Number.isFinite(val) ? val : fallback;
}

function safeFiniteOrNull(val: number | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  return Number.isFinite(val) ? val : null;
}

function zeroKPIs(): BaselineKPIValues {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    reach: 0,
    conversions: 0,
    revenue: 0,
    ctr: null,
    cpc: null,
    cpm: null,
    cpa: null,
    roas: null,
    cvr: null,
    frequency: null,
  };
}

// Re-export helpers for consumers
export type { MeasurementState };
export { parseNumericValue };
