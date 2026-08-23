import { z } from "zod";
import { MarketingAnomalySchema } from "./anomaly-detection.js";
import { AggregationLevelSchema, DataQualityStatusSchema } from "./performance-aggregation.js";
import type { AIUsage } from "./ai-provider.js";

// ---------------------------------------------------------------------------
// AI Diagnosis Engine Contracts & Schemas — Phase 11.4
// ---------------------------------------------------------------------------
// STRICT epistemic separation:
//   FACT        — deterministic, verifiable statement bound to evidence
//   INFERENCE   — relationship between verified facts
//   HYPOTHESIS  — plausible explanation (never confirmed cause)
//
// Phase 11.4 may produce FACT / INFERENCE / HYPOTHESIS only.
// This contract intentionally contains NO executable recommendation field.
// Recommendations belong to Phase 11.5 and must never be smuggled through:
// all diagnosis objects use `.strict()` parsing so unknown fields (e.g.
// "actions", "recommendedChanges") cause validation failure, not execution.
// ---------------------------------------------------------------------------

export const DIAGNOSIS_SCHEMA_VERSION = 1;

export const DiagnosisCategorySchema = z.enum([
  "CREATIVE_FATIGUE",
  "AUDIENCE_SATURATION",
  "COST_INFLATION",
  "ENGAGEMENT_DECLINE",
  "CONVERSION_RATE_DECLINE",
  "LANDING_PAGE_ISSUE",
  "TRACKING_ISSUE",
  "DELIVERY_ISSUE",
  "BUDGET_CONSTRAINT",
  "COMPETITIVE_PRESSURE",
  "SEASONALITY",
  "INSUFFICIENT_DATA",
  "NO_CLEAR_DIAGNOSIS",
  "UNKNOWN",
]);
export type DiagnosisCategory = z.infer<typeof DiagnosisCategorySchema>;

export const ConfidenceLevelSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const FreshnessSchema = z.enum(["FRESH", "STALE_DATA", "WARMUP_PERIOD"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

// ---------------------------------------------------------------------------
// Evidence Package — the ONLY input the AI ever sees.
// Built deterministically by the Evidence Builder; never contains tokens,
// credentials, raw provider payloads, or arbitrary privileged instructions.
// ---------------------------------------------------------------------------

export const MetricUnitSchema = z.enum(["CURRENCY", "PERCENT", "RATIO", "COUNT"]);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

/** Provenance for a metric: where it came from and at what aggregation. */
export const MetricProvenanceSchema = z.object({
  source: z.string().min(1), // e.g. "META_INSIGHTS"
  aggregationLevel: AggregationLevelSchema,
}).strict();
export type MetricProvenance = z.infer<typeof MetricProvenanceSchema>;

/**
 * One metric with full provenance:
 *   metric → value → window → aggregation level → source.
 */
export const MetricFactSchema = z.object({
  metric: z.string().min(1),
  current: z.number().nullable(),
  previous: z.number().nullable(),
  changeAbsolute: z.number().nullable(),
  changePercent: z.number().nullable(), // signed percentage points
  unit: MetricUnitSchema,
  window: z.object({ startDate: z.string(), endDate: z.string() }).strict(),
  provenance: MetricProvenanceSchema,
}).strict();
export type MetricFact = z.infer<typeof MetricFactSchema>;

/**
 * UNTRUSTED marketing text (campaign/ad names, creative snippets).
 * Sanitized by the builder and treated strictly as DATA by the model.
 */
export const RelevantContextSchema = z.object({
  labels: z.array(z.object({ key: z.string().max(64), value: z.string().max(500) }).strict()).max(20).default([]),
  notes: z.array(z.string().max(500)).max(20).default([]),
}).strict();
export type RelevantContext = z.infer<typeof RelevantContextSchema>;

export const DateRangeSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
}).strict();
export type DateRange = z.infer<typeof DateRangeSchema>;

export const EvidencePackageSchema = z.object({
  schemaVersion: z.literal(1),
  accountId: z.string().min(1),
  entityLevel: AggregationLevelSchema, // entityType == entityLevel (ACCOUNT|CAMPAIGN|AD_SET|AD)
  entityId: z.string().min(1),
  /** Sanitized display name — attacker-controlled upstream, data-only. */
  entityName: z.string().max(300).optional(),
  objective: z.string().max(64).optional(),
  currency: z.string().length(3),
  timezone: z.string(),
  performanceWindow: DateRangeSchema,
  comparisonWindow: DateRangeSchema.optional(),
  currentMetrics: z.record(z.union([z.number(), z.null()])),
  previousMetrics: z.record(z.union([z.number(), z.null()])).optional(),
  /** Per-metric provenance + comparison detail (see Phase 11.4 spec §3). */
  metricDetails: z.array(MetricFactSchema).max(32),
  anomalies: z.array(MarketingAnomalySchema).max(50),
  dataQuality: DataQualityStatusSchema,
  freshness: FreshnessSchema,
  campaignLifecycleState: z.string().max(32).optional(),
  relevantContext: RelevantContextSchema,
  /** Deterministic SHA-256-derived hash of canonical evidence content. */
  evidenceHash: z.string().min(16),
  builtAt: z.string(),
}).strict();
export type EvidencePackage = z.infer<typeof EvidencePackageSchema>;

// ---------------------------------------------------------------------------
// Statement types (FACT / INFERENCE / HYPOTHESIS)
// ---------------------------------------------------------------------------

export const MarketingFactSchema = z.object({
  statement: z.string().min(1),
  /** Resolvable reference into the EvidencePackage, e.g.
   *  "metric:cpa:change_percent" | "anomaly:<id>" | "meta:data_quality". */
  evidenceRef: z.string().min(1),
}).strict();
export type MarketingFact = z.infer<typeof MarketingFactSchema>;

export const MarketingInferenceSchema = z.object({
  statement: z.string().min(1),
  supportingEvidence: z.array(z.string().min(1)).min(1),
  confidence: ConfidenceLevelSchema,
}).strict();
export type MarketingInference = z.infer<typeof MarketingInferenceSchema>;

export const MarketingHypothesisSchema = z.object({
  statement: z.string().min(1),
  category: DiagnosisCategorySchema,
  supportingEvidence: z.array(z.string().min(1)).min(1),
  contradictingEvidence: z.array(z.string().min(1)).default([]),
  confidence: ConfidenceLevelSchema,
}).strict();
export type MarketingHypothesis = z.infer<typeof MarketingHypothesisSchema>;

// ---------------------------------------------------------------------------
// Model-facing contracts (what the LLM is asked to emit) vs system-facing
// result (enriched deterministically by the engine). Model output is parsed
// with .strict() so smuggled fields fail closed.
// ---------------------------------------------------------------------------

export const ModelDiagnosisSchema = z.object({
  entityId: z.string().min(1),
  entityLevel: AggregationLevelSchema,
  evidenceHash: z.string().min(16),
  anomalyIds: z.array(z.string()).max(50),
  category: DiagnosisCategorySchema,
  summary: z.string().min(1).max(2000),
  facts: z.array(MarketingFactSchema).max(30),
  inferences: z.array(MarketingInferenceSchema).max(15),
  hypotheses: z.array(MarketingHypothesisSchema).max(10),
  confidence: ConfidenceLevelSchema,
}).strict();
export type ModelDiagnosis = z.infer<typeof ModelDiagnosisSchema>;

export const ModelBatchDiagnosisSchema = z.object({
  diagnoses: z.array(ModelDiagnosisSchema).min(1).max(20),
}).strict();

// ---------------------------------------------------------------------------
// System-facing DiagnosisResult
// ---------------------------------------------------------------------------

export const DiagnosisResultSchema = z.object({
  diagnosisId: z.string(),
  accountId: z.string(),
  entityLevel: AggregationLevelSchema,
  entityId: z.string(),
  anomalyIds: z.array(z.string()),
  category: DiagnosisCategorySchema,
  summary: z.string(),
  facts: z.array(MarketingFactSchema),
  inferences: z.array(MarketingInferenceSchema),
  hypotheses: z.array(MarketingHypothesisSchema),
  confidence: ConfidenceLevelSchema,
  dataQuality: DataQualityStatusSchema,
  evidenceHash: z.string(),
  generatedAt: z.string(),
}).strict();
export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;

// ---------------------------------------------------------------------------
// Outcomes & audit
// ---------------------------------------------------------------------------

export type NoDiagnosisReason =
  | "NO_ANOMALIES"
  | "INSUFFICIENT_DATA"
  | "VALIDATION_FAILED"
  | "MALFORMED_OUTPUT"
  | "MISSING_FROM_BATCH_RESPONSE";

export type DiagnosisFailureReason =
  | "INVALID_EVIDENCE_PACKAGE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_UNSAFE_CONTENT"
  | "INTERNAL_ERROR";

export type DiagnosisOutcome =
  | { status: "SUCCESS"; diagnosis: DiagnosisResult; audit: DiagnosisAuditRecord }
  | { status: "NO_DIAGNOSIS"; reason: NoDiagnosisReason; detail?: string; audit: DiagnosisAuditRecord }
  | { status: "FAILED"; reason: DiagnosisFailureReason; detail?: string; audit: DiagnosisAuditRecord };

/** Observability record. Never stores chain-of-thought — concise rationale
 *  counts and references only. */
export interface DiagnosisAuditRecord {
  diagnosisId: string | null;
  accountId: string;
  entityId: string;
  entityLevel: string;
  anomalyIds: string[];
  evidenceHash: string;
  providerId: string;
  model: string;
  latencyMs: number;
  tokenUsage?: AIUsage;
  validationResult:
    | "ACCEPTED"
    | "NO_DIAGNOSIS"
    | "REJECTED"
    | "SKIPPED"
    | "FAILED"
    | "CACHE_HIT";
  validationReason?: string;
  fromCache: boolean;
  generatedAt: string;
  traceId?: string;
  requestedByUserId?: string;
}

// ---------------------------------------------------------------------------
// Deterministic confidence caps
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

export function minConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

export function rankConfidence(c: ConfidenceLevel): number {
  return CONFIDENCE_RANK[c];
}
