import { z } from "zod";
import { RecommendationActionSchema } from "./recommendation.js";
import { AggregationLevelSchema } from "./performance-aggregation.js";
import { DiagnosisCategorySchema } from "./diagnosis.js";

// ---------------------------------------------------------------------------
// Phase 11.7A — Outcome Measurement Foundation Contracts
// ---------------------------------------------------------------------------
// DETERMINISTIC ONLY. AI must never override outcome classification.
// All rules are explicit, enumerated, and version-controlled here.
// ---------------------------------------------------------------------------

export const OUTCOME_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// 1. Outcome enum — the six possible verdict values
// ---------------------------------------------------------------------------

export const OutcomeEnumSchema = z.enum([
  /** Primary metric materially improved + sufficient data. */
  "POSITIVE",
  /** Primary metric materially worsened + sufficient data. */
  "NEGATIVE",
  /** Change is below the practical significance threshold. */
  "NEUTRAL",
  /** Insufficient / partial / stale / conflicting data. AI cannot upgrade this. */
  "INCONCLUSIVE",
  /** The primary metric is undefined (null) on both sides of the comparison. */
  "NOT_MEASURABLE",
  /** The execution definitively failed; no performance change can be attributed. */
  "FAILED_ACTION",
]);
export type OutcomeEnum = z.infer<typeof OutcomeEnumSchema>;

// ---------------------------------------------------------------------------
// 2. Measurement state — lifecycle of the window (separate from verdict)
// ---------------------------------------------------------------------------

export const MeasurementStateSchema = z.enum([
  /** A recommendation has been executed, and an OutcomeRecord has been scheduled for measurement. */
  "SCHEDULED",
  /** The worker is currently collecting metrics for the outcome measurement. */
  "COLLECTING",
  /** Stabilization period has not yet elapsed — do NOT read any metrics yet. */
  "WAITING_FOR_DATA",
  /** Stabilization elapsed but attribution window still open. */
  "WAITING_FOR_ATTRIBUTION",
  /** Window fully open; measurement may proceed. */
  "READY",
  /** Outcome has been permanently classified. No further updates allowed. */
  "FINALIZED",
]);
export type MeasurementState = z.infer<typeof MeasurementStateSchema>;

// ---------------------------------------------------------------------------
// 3. Attribution status
// ---------------------------------------------------------------------------

export const AttributionStatusSchema = z.enum([
  /** Attribution window is fully closed; conversions are reliable. */
  "ATTRIBUTION_READY",
  /** Attribution window is still open — zero conversions must NOT be treated as failure. */
  "ATTRIBUTION_PENDING",
]);
export type AttributionStatus = z.infer<typeof AttributionStatusSchema>;

// ---------------------------------------------------------------------------
// 4. Confounder types — changes during measurement window that pollute signal
// ---------------------------------------------------------------------------

export const ConfounderTypeSchema = z.enum([
  "EXTERNAL_BUDGET_CHANGE",
  "EXTERNAL_STATUS_CHANGE",
  "TARGETING_CHANGE",
  "CREATIVE_CHANGE",
  "OVERLAPPING_RECOMMENDATION",
  "TRACKING_CHANGE",
]);
export type ConfounderType = z.infer<typeof ConfounderTypeSchema>;

export const ConfounderRecordSchema = z
  .object({
    type: ConfounderTypeSchema,
    detectedAt: z.string().datetime(),
    description: z.string().min(1).max(500),
    /** Whether this confounder makes attribution unreliable (forces INCONCLUSIVE). */
    makesAttributionUnreliable: z.boolean(),
  })
  .strict();
export type ConfounderRecord = z.infer<typeof ConfounderRecordSchema>;

// ---------------------------------------------------------------------------
// 5. Primary metric vocabulary — objective-aware direction
// ---------------------------------------------------------------------------

export const PrimaryMetricSchema = z.enum([
  "CPA",
  "CPC",
  "CTR",
  "CVR",
  "ROAS",
  "REVENUE",
  "CONVERSIONS",
  "SPEND",
  "IMPRESSIONS",
  "CLICKS",
  "CPM",
  "FREQUENCY",
]);
export type PrimaryMetric = z.infer<typeof PrimaryMetricSchema>;

export type OutcomeMetricDirection = "LOWER_IS_BETTER" | "HIGHER_IS_BETTER" | "CONTEXT_DEPENDENT";

/**
 * Deterministic, objective-aware direction table.
 * Context-dependent metrics remain context-dependent — they do NOT collapse to
 * a fixed direction. Outcome engine must treat them as NEUTRAL unless the
 * recommendation explicitly encodes a direction.
 */
export const PRIMARY_METRIC_DIRECTION: Record<PrimaryMetric, OutcomeMetricDirection> = {
  CPA: "LOWER_IS_BETTER",
  CPC: "LOWER_IS_BETTER",
  CTR: "HIGHER_IS_BETTER",
  CVR: "HIGHER_IS_BETTER",
  ROAS: "HIGHER_IS_BETTER",
  REVENUE: "HIGHER_IS_BETTER",
  CONVERSIONS: "HIGHER_IS_BETTER",
  SPEND: "CONTEXT_DEPENDENT",
  IMPRESSIONS: "CONTEXT_DEPENDENT",
  CLICKS: "CONTEXT_DEPENDENT",
  CPM: "CONTEXT_DEPENDENT",
  FREQUENCY: "CONTEXT_DEPENDENT",
} as const;

// ---------------------------------------------------------------------------
// 6. Baseline snapshot — immutable at capture time
// ---------------------------------------------------------------------------

export const BaselineKPIValuesSchema = z
  .object({
    spend: z.number().finite(),
    impressions: z.number().int().finite(),
    clicks: z.number().int().finite(),
    reach: z.number().int().finite(),
    conversions: z.number().finite(),
    revenue: z.number().finite(),
    ctr: z.number().finite().nullable(),
    cpc: z.number().finite().nullable(),
    cpm: z.number().finite().nullable(),
    cpa: z.number().finite().nullable(),
    roas: z.number().finite().nullable(),
    cvr: z.number().finite().nullable(),
    frequency: z.number().finite().nullable(),
  })
  .strict();
export type BaselineKPIValues = z.infer<typeof BaselineKPIValuesSchema>;

export const BaselineSnapshotSchema = z
  .object({
    schemaVersion: z.literal(OUTCOME_SCHEMA_VERSION),
    /** ISO-8601 date range of the data included in the baseline. */
    dateRangeStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateRangeEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().min(1),
    currency: z.string().length(3),
    source: z.string().min(1),
    /** Exact timestamp the baseline was fetched. Never recalculate after this. */
    fetchedAt: z.string().datetime(),
    /** KPI engine version that produced these values (for drift detection). */
    kpiEngineVersion: z.string().min(1),
    /** Aggregation engine version used. */
    aggregationVersion: z.string().min(1),
    kpis: BaselineKPIValuesSchema,
  })
  .strict();
export type BaselineSnapshot = z.infer<typeof BaselineSnapshotSchema>;

// ---------------------------------------------------------------------------
// 7. Measurement window configuration — deterministic, action-type-aware
// ---------------------------------------------------------------------------

export const MeasurementWindowConfigSchema = z
  .object({
    /**
     * How long to wait after execution before reading ANY metrics.
     * During this period the outcome state is WAITING_FOR_DATA.
     * Prevents pre-mature readings in the algo warm-up period.
     */
    stabilizationMs: z.number().int().positive(),
    /** How long the primary measurement window lasts after stabilization. */
    measurementMs: z.number().int().positive(),
    /** Total attribution window from execution (for conversion metrics). */
    attributionWindowMs: z.number().int().positive(),
    /** Minimum number of days of data needed before the window is READY. */
    minimumDataDays: z.number().int().positive(),
    /** Minimum spend in the measurement window before results are credible. */
    minimumSpend: z.number().nonnegative(),
    /** For conversion-tracked objectives: minimum conversions to trust CVR/CPA. */
    minimumConversions: z.number().int().nonnegative(),
    /** Maximum age of the most recent data point before it's considered stale. */
    maxDataAgeMs: z.number().int().positive(),
  })
  .strict();
export type MeasurementWindowConfig = z.infer<typeof MeasurementWindowConfigSchema>;

// ---------------------------------------------------------------------------
// 8. KPI comparison result — before vs after
// ---------------------------------------------------------------------------

export const KPIComparisonResultSchema = z
  .object({
    metric: PrimaryMetricSchema,
    baseline: z.number().finite().nullable(),
    current: z.number().finite().nullable(),
    absoluteChange: z.number().finite().nullable(),
    percentChange: z.number().finite().nullable(),
    direction: z.enum(["IMPROVED", "WORSENED", "UNCHANGED", "UNDEFINED"]),
    /** Whether the change exceeds the materiality threshold for this metric. */
    isMaterial: z.boolean(),
  })
  .strict();
export type KPIComparisonResult = z.infer<typeof KPIComparisonResultSchema>;

// ---------------------------------------------------------------------------
// 9. Data sufficiency result
// ---------------------------------------------------------------------------

export const DataSufficiencyResultSchema = z
  .object({
    sufficient: z.boolean(),
    elapsedMs: z.number().int().nonnegative(),
    dataAgeDays: z.number().nonnegative().nullable(),
    daysWithData: z.number().int().nonnegative(),
    totalSpend: z.number().nonnegative(),
    totalConversions: z.number().nonnegative(),
    isStale: z.boolean(),
    isPartial: z.boolean(),
    reasons: z.array(z.string()).max(20),
  })
  .strict();
export type DataSufficiencyResult = z.infer<typeof DataSufficiencyResultSchema>;

// ---------------------------------------------------------------------------
// 10. Full Outcome record — 19 required fields per spec
// ---------------------------------------------------------------------------

export const OutcomeRecordSchema = z
  .object({
    /** Unique outcome identifier. */
    outcomeId: z.string().min(1),
    /** The recommendation this outcome measures. */
    recommendationId: z.string().min(1),
    /** The execution that applied the recommendation. */
    executionId: z.string().min(1),
    /** Account this outcome belongs to (isolation boundary). */
    accountId: z.string().min(1),
    /** The diagnosis category associated with the recommendation. */
    diagnosisCategory: DiagnosisCategorySchema.nullable().optional(),
    /** Entity level (CAMPAIGN / AD_SET / AD / ACCOUNT). */
    entityType: AggregationLevelSchema,
    /** Entity identifier. */
    entityId: z.string().min(1),
    /** The action that was executed. */
    actionType: RecommendationActionSchema,
    /** The optimization objective (e.g. OUTCOME_SALES). Nullable when unknown. */
    objective: z.string().max(128).nullable(),
    /** Which KPI we measure success against. */
    primaryMetric: PrimaryMetricSchema,
    /** Immutable KPI baseline snapshot captured at execution time. */
    baseline: BaselineSnapshotSchema,
    /** Raw measurement data (post-action KPI values + context). Null until READY. */
    measurement: BaselineKPIValuesSchema.nullable(),
    /** Before/after comparison. Null until READY. */
    comparison: KPIComparisonResultSchema.nullable(),
    /** The outcome verdict. Null until FINALIZED. */
    outcome: OutcomeEnumSchema.nullable(),
    /** Confidence 0–1. Reduced by confounders, stale/partial data. */
    confidence: z.number().min(0).max(1).nullable(),
    /** Data quality at measurement time. */
    dataQuality: z
      .enum(["COMPLETE", "PARTIAL", "UNAVAILABLE", "INSUFFICIENT_DATA"])
      .nullable(),
    /** Attribution window status. */
    attributionStatus: AttributionStatusSchema,
    /** Detected confounders during the measurement period. */
    confounders: z.array(ConfounderRecordSchema).max(50),
    /** Deterministic measurement window configuration. */
    measurementWindow: MeasurementWindowConfigSchema,
    /** When the outcome was last measured (ISO-8601). */
    measuredAt: z.string().datetime().nullable(),
    /** When this outcome record was created (ISO-8601). */
    createdAt: z.string().datetime(),
    /** User that owns this outcome. */
    userId: z.string().min(1),
    /** Current measurement state. */
    measurementState: MeasurementStateSchema,
  })
  .strict();
export type OutcomeRecord = z.infer<typeof OutcomeRecordSchema>;

// ---------------------------------------------------------------------------
// 11. Measurement result — what the engine returns
// ---------------------------------------------------------------------------

export const OutcomeMeasurementResultSchema = z
  .object({
    outcomeRecord: OutcomeRecordSchema,
    measurementState: MeasurementStateSchema,
    sufficiency: DataSufficiencyResultSchema,
    classifiedAt: z.string().datetime().nullable(),
  })
  .strict();
export type OutcomeMeasurementResult = z.infer<typeof OutcomeMeasurementResultSchema>;

// ---------------------------------------------------------------------------
// 12. Store port — implemented by the DB layer (outcome-repository.ts)
// ---------------------------------------------------------------------------

export interface OutcomeStorePort {
  /** Create a new outcome record. Idempotent by recommendationId. */
  create(record: OutcomeRecord): Promise<void>;
  /** User-scoped read (IDOR-safe). */
  get(outcomeId: string, userId: string): Promise<OutcomeRecord | null>;
  /** Find by recommendation. User-scoped. */
  getByRecommendation(
    recommendationId: string,
    userId: string
  ): Promise<OutcomeRecord | null>;
  /** Update measurement state. No-op if already FINALIZED. */
  updateMeasurementState(
    outcomeId: string,
    userId: string,
    state: MeasurementState,
    patch?: Partial<
      Pick<
        OutcomeRecord,
        "measurement" | "comparison" | "outcome" | "confidence" | "dataQuality" | "measuredAt" | "confounders" | "attributionStatus"
      >
    >
  ): Promise<boolean>;
  /** Permanently finalize an outcome. Idempotent; no-op if already FINALIZED. */
  finalize(
    outcomeId: string,
    userId: string,
    outcome: OutcomeEnum,
    confidence: number,
    measuredAt: string
  ): Promise<boolean>;
  /** Account-scoped list (isolation). */
  listByAccount(
    accountId: string,
    userId: string,
    opts?: { limit?: number; state?: MeasurementState }
  ): Promise<{ items: OutcomeRecord[]; total: number }>;
  /** Add a historical revision for an outcome (if the verdict changes post-finalization). */
  createRevision(revision: OutcomeRevision): Promise<void>;
  /** Get revisions for a specific outcome, user-scoped. */
  getRevisions(
    outcomeId: string,
    userId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<{ items: OutcomeRevision[]; total: number }>;
  /** Fetch structured historical outcomes for future recommendation logic. */
  getLearningHistory(
    accountId: string,
    userId: string,
    opts?: { limit?: number }
  ): Promise<LearningHistoryRecord[]>;
  /** Fetch finalized outcomes matching given criteria for similarity analysis. */
  findFinalizedOutcomes(
    userId: string,
    filters: {
      accountId: string;
      entityType?: string;
      actionType?: string;
      diagnosisCategory?: string;
      primaryMetric?: string;
      objective?: string;
      outcome?: OutcomeEnum;
      confidence?: number;
      measurementWindowMs?: number;
    }
  ): Promise<OutcomeRecord[]>;
  /** Find all outcome records due for processing (non-finalized, expired leases). */
  findDueOutcomes(limit: number, leaseExpiredAt: string): Promise<OutcomeRecord[]>;
  /** Try to atomically lock/lease a due outcome record by setting its state to COLLECTING. */
  claimOutcome(outcomeId: string, leaseExpiredAt: string): Promise<boolean>;
  /** Safely transition an outcome record back to a state (e.g. if collection fails). */
  releaseOutcome(outcomeId: string, state: MeasurementState): Promise<boolean>;
  /** Find recently finalized outcomes to re-evaluate for late-arriving conversions. */
  findRecentlyFinalized(limit: number): Promise<OutcomeRecord[]>;
}

// ---------------------------------------------------------------------------
// 13. Materiality thresholds — deterministic constants (AI cannot override)
// ---------------------------------------------------------------------------

/**
 * Minimum percent change (absolute value) for a result to be classified as
 * POSITIVE or NEGATIVE rather than NEUTRAL.
 * Applied to the primary metric's percentChange.
 */
export const MATERIALITY_THRESHOLDS: Partial<Record<PrimaryMetric, number>> = {
  CPA: 5,
  CPC: 5,
  CTR: 5,
  CVR: 5,
  ROAS: 5,
  REVENUE: 5,
  CONVERSIONS: 5,
  SPEND: 10,
  IMPRESSIONS: 10,
  CLICKS: 5,
  CPM: 5,
  FREQUENCY: 10,
} as const;

/** Default materiality threshold when metric is not in the table above. */
export const DEFAULT_MATERIALITY_THRESHOLD_PCT = 5;

// ---------------------------------------------------------------------------
// 14. Measurement window defaults — per action family
// ---------------------------------------------------------------------------

/** 24-hour stabilization for pause/resume actions. */
export const STABILIZATION_MS_PAUSE_RESUME = 24 * 60 * 60 * 1000;
/** 48-hour stabilization for budget change actions. */
export const STABILIZATION_MS_BUDGET = 48 * 60 * 60 * 1000;
/** 7-day measurement window. */
export const MEASUREMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 7-day attribution window (standard last-click). */
export const ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Minimum spend before KPI results are credible (USD). */
export const MINIMUM_SPEND_USD = 10;
/** Minimum conversions before CVR/CPA measurements are credible. */
export const MINIMUM_CONVERSIONS = 3;
/** Minimum data age: most-recent data point must be within 48h. */
export const MAX_DATA_AGE_MS = 48 * 60 * 60 * 1000;
/** Minimum days of data present in measurement window. */
export const MINIMUM_DATA_DAYS = 3;

/** Current KPI engine version for baseline version-stamping. */
export const KPI_ENGINE_VERSION = "11.1.0";
/** Current aggregation engine version. */
export const AGGREGATION_ENGINE_VERSION = "11.2.0";

// ---------------------------------------------------------------------------
// 15. Outcome revision & Learning History schemas
// ---------------------------------------------------------------------------

export const OutcomeRevisionSchema = z
  .object({
    id: z.string().min(1),
    outcomeId: z.string().min(1),
    revisionNumber: z.number().int().positive(),
    outcomeEnum: OutcomeEnumSchema,
    confidence: z.number().min(0).max(1),
    dataQuality: z.string().min(1),
    attributionStatus: AttributionStatusSchema,
    confounders: z.array(ConfounderRecordSchema).max(50),
    measurementKpis: BaselineKPIValuesSchema,
    comparison: KPIComparisonResultSchema,
    measuredAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type OutcomeRevision = z.infer<typeof OutcomeRevisionSchema>;

export const LearningHistoryRecordSchema = z
  .object({
    actionType: RecommendationActionSchema,
    outcome: OutcomeEnumSchema,
    confidence: z.number().min(0).max(1),
    measuredAt: z.string().datetime(),
    primaryMetric: PrimaryMetricSchema,
  })
  .strict();
export type LearningHistoryRecord = z.infer<typeof LearningHistoryRecordSchema>;

// ---------------------------------------------------------------------------
// 16. Historical Outcome Summary & Evidence contracts (Phase 11.8A)
// ---------------------------------------------------------------------------

export const HistoricalSummarySchema = z
  .object({
    sampleSize: z.number().int().nonnegative(),
    positiveCount: z.number().int().nonnegative(),
    negativeCount: z.number().int().nonnegative(),
    neutralCount: z.number().int().nonnegative(),
    inconclusiveCount: z.number().int().nonnegative(),
    positiveRate: z.number().min(0).max(1),
    negativeRate: z.number().min(0).max(1),
    averageConfidence: z.number().min(0).max(1),
    relevantOutcomes: z.array(
      z.object({
        outcomeId: z.string(),
        similarity: z.number().min(0).max(1),
        weight: z.number().min(0),
        outcome: OutcomeEnumSchema,
        measuredAt: z.string().datetime().nullable(),
      }).strict()
    ).max(500),
    dataQuality: z.string().min(1).max(256),
  })
  .strict();
export type HistoricalSummary = z.infer<typeof HistoricalSummarySchema>;

export const HistoricalEvidenceSchema = z
  .object({
    historyId: z.string().min(1),
    recommendationContext: z
      .object({
        accountId: z.string(),
        actionType: RecommendationActionSchema,
        entityType: AggregationLevelSchema,
        entityId: z.string(),
        primaryMetric: PrimaryMetricSchema,
        diagnosisCategory: DiagnosisCategorySchema.nullable().optional(),
      })
      .strict(),
    matchingOutcomeIds: z.array(z.string()).max(500),
    matchingCriteria: z.array(z.string()).max(50),
    sampleSize: z.number().int().nonnegative(),
    summaryStatistics: HistoricalSummarySchema,
    weighting: z
      .object({
        formula: z.string(),
        parameters: z.record(z.unknown()),
      })
      .strict(),
    limitations: z.array(z.string()).max(20),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type HistoricalEvidence = z.infer<typeof HistoricalEvidenceSchema>;


