import { z } from "zod";
import { AggregationLevelSchema, DataQualityStatusSchema } from "./performance-aggregation.js";

// ---------------------------------------------------------------------------
// Anomaly Detection Contracts & Schemas — Phase 11.3
// ---------------------------------------------------------------------------

export const MetricDirectionSchema = z.enum(["BAD_HIGH", "BAD_LOW", "CONTEXT_DEPENDENT"]);
export type MetricDirection = z.infer<typeof MetricDirectionSchema>;

export const AnomalyDirectionSchema = z.enum([
  "POSITIVE_ANOMALY",
  "NEGATIVE_ANOMALY",
  "NEUTRAL_ANOMALY",
]);
export type AnomalyDirection = z.infer<typeof AnomalyDirectionSchema>;

export const AnomalySeveritySchema = z.enum(["NORMAL", "WARNING", "CRITICAL"]);
export type AnomalySeverity = z.infer<typeof AnomalySeveritySchema>;

export const AnomalyConfidenceSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type AnomalyConfidence = z.infer<typeof AnomalyConfidenceSchema>;

export const BaselineMethodSchema = z.enum(["ROLLING_MEDIAN_MAD", "ROLLING_MEAN_STD"]);
export type BaselineMethod = z.infer<typeof BaselineMethodSchema>;

// --- Baseline Result ---

export interface BaselineResult {
  metric: string;
  baselineValue: number;
  sampleCount: number;
  method: BaselineMethod;
  dispersion: number; // MAD or Standard Deviation
  confidence: AnomalyConfidence;
  dataQuality: z.infer<typeof DataQualityStatusSchema>;
  calculatedAt: string;
}

// --- Anomaly Evidence Item ---

export interface AnomalyEvidence {
  metric: string;
  currentValue: number;
  baselineValue: number;
  absoluteDeviation: number;
  percentDeviation: number | null;
  modifiedZScore: number | null;
  sampleCount: number;
  baselineMethod: BaselineMethod;
  economicSignificanceMet: boolean;
}

// --- Structured Marketing Anomaly Contract ---

export const MarketingAnomalySchema = z.object({
  anomalyId: z.string(),
  accountId: z.string(),
  entityLevel: AggregationLevelSchema,
  entityId: z.string(),
  entityName: z.string().optional(),
  metric: z.string(),
  currentValue: z.number(),
  baselineValue: z.number(),
  absoluteDeviation: z.number(),
  percentDeviation: z.number().nullable(),
  modifiedZScore: z.number().nullable(),
  direction: AnomalyDirectionSchema,
  severity: AnomalySeveritySchema,
  confidence: AnomalyConfidenceSchema,
  baselineMethod: BaselineMethodSchema,
  sampleCount: z.number().int(),
  dataQuality: DataQualityStatusSchema,
  freshness: z.enum(["FRESH", "STALE_DATA", "WARMUP_PERIOD"]),
  evidence: z.object({
    metric: z.string(),
    currentValue: z.number(),
    baselineValue: z.number(),
    absoluteDeviation: z.number(),
    percentDeviation: z.number().nullable(),
    modifiedZScore: z.number().nullable(),
    sampleCount: z.number().int(),
    baselineMethod: BaselineMethodSchema,
    economicSignificanceMet: z.boolean(),
  }),
  detectedAt: z.string(),
});

export type MarketingAnomaly = z.infer<typeof MarketingAnomalySchema>;

// --- Configurable Anomaly Thresholds ---

export interface AnomalyThresholdConfig {
  warningZScore: number; // Default: 2.0
  criticalZScore: number; // Default: 3.5
  warningPercentDelta: number; // Default: 20%
  criticalPercentDelta: number; // Default: 40%
  minSampleCount: number; // Default: 3
  normalSampleCount: number; // Default: 7
  economicSignificance: {
    spend: number; // Min $10.00 spend change
    impressions: number; // Min 500 impressions
    clicks: number; // Min 20 clicks
    conversions: number; // Min 3 conversions
    revenue: number; // Min $20 revenue
    general: number; // Fallback min 1.0
  };
}

export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholdConfig = {
  warningZScore: 2.0,
  criticalZScore: 3.5,
  warningPercentDelta: 20.0,
  criticalPercentDelta: 40.0,
  minSampleCount: 3,
  normalSampleCount: 7,
  economicSignificance: {
    spend: 10.0,
    impressions: 500,
    clicks: 20,
    conversions: 3,
    revenue: 20.0,
    general: 1.0,
  },
};
