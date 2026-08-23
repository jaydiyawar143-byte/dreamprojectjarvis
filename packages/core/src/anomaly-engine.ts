import { computeParamsHash } from "./utils/params-hash.js";
import type {
  AnomalyConfidence,
  AnomalyDirection,
  AnomalySeverity,
  AnomalyThresholdConfig,
  BaselineMethod,
  BaselineResult,
  MarketingAnomaly,
  MetricDirection,
} from "./types/anomaly-detection.js";
import { DEFAULT_ANOMALY_THRESHOLDS } from "./types/anomaly-detection.js";
import type {
  NormalizedPerformanceRecord,
  PerformanceSummary,
} from "./types/performance-aggregation.js";

// ---------------------------------------------------------------------------
// Deterministic Anomaly Detection Engine — Phase 11.3
// ---------------------------------------------------------------------------

export function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export function calculateMAD(values: number[], median?: number): number {
  if (values.length === 0) return 0;
  const med = median ?? calculateMedian(values);
  const absoluteDeviations = values.map((v) => Math.abs(v - med));
  return calculateMedian(absoluteDeviations);
}

export function calculateBaseline(
  observations: number[],
  method: BaselineMethod = "ROLLING_MEDIAN_MAD"
): BaselineResult {
  const validValues = observations.filter((v) => typeof v === "number" && Number.isFinite(v));
  const sampleCount = validValues.length;

  let confidence: AnomalyConfidence = "HIGH";
  if (sampleCount < 3) {
    confidence = "LOW";
  } else if (sampleCount <= 6) {
    confidence = "MEDIUM";
  }

  const baselineValue = calculateMedian(validValues);
  const dispersion = calculateMAD(validValues, baselineValue);

  return {
    metric: "generic",
    baselineValue: Math.round(baselineValue * 10000) / 10000,
    sampleCount,
    method,
    dispersion: Math.round(dispersion * 10000) / 10000,
    confidence,
    dataQuality: sampleCount >= 3 ? "COMPLETE" : "INSUFFICIENT_DATA",
    calculatedAt: new Date().toISOString(),
  };
}

export function getMetricDirection(metric: string): MetricDirection {
  const normalized = metric.toLowerCase();
  if (
    normalized.includes("cpa") ||
    normalized.includes("cpc") ||
    normalized.includes("cpm") ||
    normalized.includes("costperconversion") ||
    normalized.includes("costperresult") ||
    normalized.includes("frequency")
  ) {
    return "BAD_HIGH";
  }
  if (
    normalized.includes("ctr") ||
    normalized.includes("cvr") ||
    normalized.includes("roas") ||
    normalized.includes("conversions") ||
    normalized.includes("revenue")
  ) {
    return "BAD_LOW";
  }
  return "CONTEXT_DEPENDENT";
}

export function checkEconomicSignificance(
  metric: string,
  absoluteDev: number,
  currentValue: number,
  rawKpis?: { spend?: number; impressions?: number; clicks?: number; conversions?: number; revenue?: number },
  config: AnomalyThresholdConfig = DEFAULT_ANOMALY_THRESHOLDS
): boolean {
  const m = metric.toLowerCase();
  const absDev = Math.abs(absoluteDev);

  if (m === "spend") return absDev >= config.economicSignificance.spend;
  if (m === "impressions") return absDev >= config.economicSignificance.impressions;
  if (m === "clicks") return absDev >= config.economicSignificance.clicks;
  if (m === "conversions") return absDev >= config.economicSignificance.conversions;
  if (m === "revenue") return absDev >= config.economicSignificance.revenue;

  // Rate metrics (ctr, cpc, cpm, cpa, roas, cvr) require minimum economic volume
  if (rawKpis) {
    if (m === "cpa" || m === "cpc" || m === "cpm" || m === "roas") {
      if ((rawKpis.spend ?? 0) < config.economicSignificance.spend) return false;
    }
    if (m === "ctr" || m === "cvr") {
      if ((rawKpis.clicks ?? 0) < config.economicSignificance.clicks) return false;
    }
  }

  return absDev >= 0.0001 && currentValue > 0;
}

export function computeAnomalyId(
  accountId: string,
  entityLevel: string,
  entityId: string,
  metric: string,
  detectedDate: string
): string {
  const rawKey = `${accountId}:${entityLevel}:${entityId}:${metric}:${detectedDate}`;
  const hash = computeParamsHash({ rawKey });
  return `anom_${hash.slice(0, 16)}`;
}

export interface AnomalyDetectionOptions {
  thresholds?: Partial<AnomalyThresholdConfig>;
  freshnessMaxAgeHours?: number;
}

/**
 * Detect marketing anomalies deterministically comparing current performance
 * summary against historical performance records.
 */
export function detectAnomalies(
  historicalRecords: NormalizedPerformanceRecord[],
  currentSummary: PerformanceSummary,
  options: AnomalyDetectionOptions = {}
): MarketingAnomaly[] {
  const config: AnomalyThresholdConfig = {
    ...DEFAULT_ANOMALY_THRESHOLDS,
    ...options.thresholds,
  };

  const anomalies: MarketingAnomaly[] = [];
  const { kpis, accountId, level, entityId, entityName, window, quality } = currentSummary;

  // Filter historical records relevant to target entity
  const relevantHistory = historicalRecords.filter((r) => {
    if (accountId && r.accountId !== accountId) return false;
    if (level === "CAMPAIGN") return r.campaignId === entityId;
    if (level === "AD_SET") return r.adSetId === entityId;
    if (level === "AD") return r.adId === entityId;
    return true;
  });

  const sampleCount = relevantHistory.length;
  if (sampleCount < config.minSampleCount || quality === "UNAVAILABLE") {
    // Insufficient sample count: return empty array or handle explicit insufficient state
    return [];
  }

  type NumericKPIMetric = keyof Omit<typeof kpis, "isDefined">;
  const evaluatedMetrics: NumericKPIMetric[] = [
    "spend",
    "impressions",
    "clicks",
    "reach",
    "conversions",
    "revenue",
    "ctr",
    "cpc",
    "cpm",
    "cpa",
    "roas",
    "cvr",
    "frequency",
  ];

  for (const metric of evaluatedMetrics) {
    const rawVal = kpis[metric];
    if (rawVal === null || rawVal === undefined) continue;
    const currentValue = rawVal as number;

    // Extract historical observations for this metric
    const observations: number[] = [];
    for (const r of relevantHistory) {
      if (metric === "spend") observations.push(r.spend);
      else if (metric === "impressions") observations.push(r.impressions);
      else if (metric === "clicks") observations.push(r.clicks);
      else if (metric === "reach") observations.push(r.reach);
      else if (metric === "conversions") observations.push(r.conversions);
      else if (metric === "revenue") observations.push(r.revenue);
      else if (metric === "ctr") {
        if (r.impressions > 0) observations.push((r.clicks / r.impressions) * 100);
      } else if (metric === "cpc") {
        if (r.clicks > 0) observations.push(r.spend / r.clicks);
      } else if (metric === "cpm") {
        if (r.impressions > 0) observations.push((r.spend / r.impressions) * 1000);
      } else if (metric === "cpa") {
        if (r.conversions > 0) observations.push(r.spend / r.conversions);
      } else if (metric === "roas") {
        if (r.spend > 0) observations.push(r.revenue / r.spend);
      } else if (metric === "cvr") {
        if (r.clicks > 0) observations.push((r.conversions / r.clicks) * 100);
      } else if (metric === "frequency") {
        if (r.reach > 0) observations.push(r.impressions / r.reach);
      }
    }

    if (observations.length < config.minSampleCount) continue;

    const baselineVal = calculateMedian(observations);
    const mad = calculateMAD(observations, baselineVal);
    const absoluteDeviation = Math.round((currentValue - baselineVal) * 10000) / 10000;

    const percentDeviation =
      baselineVal > 0
        ? Math.round(((currentValue - baselineVal) / baselineVal) * 10000) / 100
        : null;

    let modifiedZScore: number | null = null;
    if (mad > 0) {
      modifiedZScore = Math.round((0.6745 * (currentValue - baselineVal)) / mad * 100) / 100;
    }

    // Check economic significance guard
    const isSignificnat = checkEconomicSignificance(metric, absoluteDeviation, currentValue, kpis, config);
    if (!isSignificnat) continue;

    // Determine severity
    const absZ = modifiedZScore !== null ? Math.abs(modifiedZScore) : 0;
    const absPct = percentDeviation !== null ? Math.abs(percentDeviation) : 0;

    let severity: AnomalySeverity = "NORMAL";
    if (absZ >= config.criticalZScore || absPct >= config.criticalPercentDelta) {
      severity = "CRITICAL";
    } else if (absZ >= config.warningZScore || absPct >= config.warningPercentDelta) {
      severity = "WARNING";
    }

    // Minimum sample guard: if sample count < 7, cap severity at WARNING
    if (observations.length < config.normalSampleCount && severity === "CRITICAL") {
      severity = "WARNING";
    }

    if (severity === "NORMAL") continue;

    // Determine directional semantics
    const metricDir = getMetricDirection(metric);
    let anomalyDir: AnomalyDirection = "NEUTRAL_ANOMALY";

    if (metricDir === "BAD_HIGH") {
      anomalyDir = currentValue > baselineVal ? "NEGATIVE_ANOMALY" : "POSITIVE_ANOMALY";
    } else if (metricDir === "BAD_LOW") {
      anomalyDir = currentValue < baselineVal ? "NEGATIVE_ANOMALY" : "POSITIVE_ANOMALY";
    } else {
      anomalyDir = currentValue > baselineVal ? "POSITIVE_ANOMALY" : "NEGATIVE_ANOMALY";
    }

    // Determine confidence
    let confidence: AnomalyConfidence = "HIGH";
    if (observations.length < config.normalSampleCount || quality === "PARTIAL") {
      confidence = "MEDIUM";
    }
    if (observations.length < config.minSampleCount) {
      confidence = "LOW";
    }

    const targetAccountId = accountId ?? relevantHistory[0]?.accountId ?? "";
    const anomalyId = computeAnomalyId(
      targetAccountId,
      level,
      entityId,
      metric,
      window.endDate || new Date().toISOString().split("T")[0]!
    );

    anomalies.push({
      anomalyId,
      accountId: targetAccountId,
      entityLevel: level,
      entityId,
      entityName,
      metric,
      currentValue: Math.round(currentValue * 10000) / 10000,
      baselineValue: Math.round(baselineVal * 10000) / 10000,
      absoluteDeviation,
      percentDeviation,
      modifiedZScore,
      direction: anomalyDir,
      severity,
      confidence,
      baselineMethod: "ROLLING_MEDIAN_MAD",
      sampleCount: observations.length,
      dataQuality: quality,
      freshness: "FRESH",
      evidence: {
        metric,
        currentValue,
        baselineValue: Math.round(baselineVal * 10000) / 10000,
        absoluteDeviation,
        percentDeviation,
        modifiedZScore,
        sampleCount: observations.length,
        baselineMethod: "ROLLING_MEDIAN_MAD",
        economicSignificanceMet: true,
      },
      detectedAt: new Date().toISOString(),
    });
  }

  return anomalies;
}
