import { z } from "zod";
import { CalculatedKPIs } from "../kpi-engine.js";

// ---------------------------------------------------------------------------
// Performance Aggregation Types & Schemas — Phase 11.2
// ---------------------------------------------------------------------------

export const AggregationLevelSchema = z.enum(["ACCOUNT", "CAMPAIGN", "AD_SET", "AD"]);
export type AggregationLevel = z.infer<typeof AggregationLevelSchema>;

export const PerformanceWindowTypeSchema = z.enum([
  "today",
  "yesterday",
  "last_7_days",
  "previous_7_days",
  "last_14_days",
  "previous_14_days",
  "last_30_days",
  "previous_30_days",
  "custom",
]);
export type PerformanceWindowType = z.infer<typeof PerformanceWindowTypeSchema>;

export const DataQualityStatusSchema = z.enum([
  "COMPLETE",
  "PARTIAL",
  "UNAVAILABLE",
  "INSUFFICIENT_DATA",
]);
export type DataQualityStatus = z.infer<typeof DataQualityStatusSchema>;

// --- Normalized Performance Record ---

export const NormalizedPerformanceRecordSchema = z.object({
  accountId: z.string(),
  campaignId: z.string().optional(),
  adSetId: z.string().optional(),
  adId: z.string().optional(),
  entityName: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
  spend: z.number().min(0),
  impressions: z.number().int().min(0),
  clicks: z.number().int().min(0),
  reach: z.number().int().min(0),
  linkClicks: z.number().int().min(0).optional(),
  conversions: z.number().min(0),
  revenue: z.number().min(0),
  frequency: z.number().min(0).optional(),
  currency: z.string().length(3),
  timezone: z.string(),
  attributionMetadata: z.record(z.unknown()).optional(),
});

export type NormalizedPerformanceRecord = z.infer<typeof NormalizedPerformanceRecordSchema>;

// --- Metric Comparison ---

export interface MetricComparison<T = number> {
  current: T | null;
  previous: T | null;
  changeAbsolute: T | null;
  changePercent: number | null;
}

// --- Performance Summary ---

export interface PerformanceSummary {
  accountId?: string;
  level: AggregationLevel;
  entityId: string;
  entityName?: string;
  currency: string;
  timezone: string;
  window: {
    type: PerformanceWindowType;
    startDate: string;
    endDate: string;
  };
  recordCount: number;
  kpis: CalculatedKPIs;
  quality: DataQualityStatus;
  fetchedAt: string; // ISO-8601 string
  source: string;
}

// --- Performance Window Comparison ---

export interface PerformanceWindowComparison {
  level: AggregationLevel;
  entityId: string;
  entityName?: string;
  currency: string;
  timezone: string;
  currentWindow: {
    type: PerformanceWindowType;
    startDate: string;
    endDate: string;
  };
  previousWindow: {
    type: PerformanceWindowType;
    startDate: string;
    endDate: string;
  };
  currentSummary: PerformanceSummary;
  previousSummary: PerformanceSummary;
  comparisons: {
    spend: MetricComparison;
    impressions: MetricComparison;
    clicks: MetricComparison;
    reach: MetricComparison;
    conversions: MetricComparison;
    revenue: MetricComparison;
    ctr: MetricComparison;
    cpc: MetricComparison;
    cpm: MetricComparison;
    cpa: MetricComparison;
    roas: MetricComparison;
    cvr: MetricComparison;
    frequency: MetricComparison;
  };
  quality: DataQualityStatus;
  fetchedAt: string;
}
