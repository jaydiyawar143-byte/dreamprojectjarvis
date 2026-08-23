import type { NormalizedPerformanceRecord } from "../src/types/performance-aggregation.js";
import { aggregatePerformanceRecords, comparePerformanceSummaries } from "../src/performance-aggregator.js";
import { detectAnomalies } from "../src/anomaly-engine.js";
import { buildEvidencePackage } from "../src/evidence-builder.js";
import type { EvidencePackage, ModelDiagnosis } from "../src/types/diagnosis.js";
import type { DataQualityStatus } from "../src/types/performance-aggregation.js";

// ---------------------------------------------------------------------------
// Shared Phase 11.4 test fixtures
// ---------------------------------------------------------------------------
// Deterministic "creative fatigue" scenario built through the REAL Phase
// 11.2 + 11.3 pipeline (aggregator -> comparison -> anomaly engine), so all
// evidence numbers are internally consistent.
// ---------------------------------------------------------------------------

export interface FatigueOptions {
  accountId?: string;
  entityId?: string;
  entityName?: string;
  /** Aggregation level for the evidence package (default CAMPAIGN). */
  level?: "ACCOUNT" | "CAMPAIGN" | "AD_SET" | "AD";
  dataQuality?: DataQualityStatus;
  freshness?: "FRESH" | "STALE_DATA" | "WARMUP_PERIOD";
  lifecycle?: string;
  labels?: Array<{ key: string; value: string }>;
}

const STABLE_DAY = {
  spend: 100,
  impressions: 5000,
  clicks: 200,
  reach: 2500,
  conversions: 10,
  revenue: 200,
};

/** 10 stable history days: CTR 4%, CPA $10, frequency 2.0 */
function history(
  accountId: string,
  campaignId: string,
  ids: { adSetId?: string; adId?: string } = {}
): NormalizedPerformanceRecord[] {
  return Array.from({ length: 10 }, (_, i) => ({
    accountId,
    campaignId,
    date: `2026-08-${String(i + 11).padStart(2, "0")}`,
    ...STABLE_DAY,
    ...ids,
    currency: "USD",
    timezone: "UTC",
  }));
}

/** Deterioration day: CTR -45%, CPA +150%, frequency +56%, ROAS -60% */
function deteriorationDay(
  accountId: string,
  campaignId: string,
  ids: { adSetId?: string; adId?: string } = {}
): NormalizedPerformanceRecord[] {
  return [
    {
      accountId,
      campaignId,
      date: "2026-08-21",
      spend: 100,
      impressions: 5000,
      clicks: 110,
      reach: 1600,
      conversions: 4,
      revenue: 80,
      ...ids,
      currency: "USD",
      timezone: "UTC",
    },
  ];
}

export interface FatigueFixture {
  pkg: EvidencePackage;
  anomalyId(metric: string): string | undefined;
}

export function buildFatigueEvidence(opts: FatigueOptions = {}): FatigueFixture {
  const accountId = opts.accountId ?? "act_1";
  const entityId = opts.entityId ?? "cmp_1";
  const level = opts.level ?? "CAMPAIGN";

  // For sub-campaign levels the records must carry the parent campaign plus
  // the level-specific id so aggregator/anomaly filtering resolve correctly.
  const ids: { adSetId?: string; adId?: string } = {};
  if (level === "AD_SET") ids.adSetId = entityId;
  if (level === "AD") {
    ids.adSetId = `${entityId}_set`;
    ids.adId = entityId;
  }

  let currentSummary = aggregatePerformanceRecords(
    deteriorationDay(accountId, entityId, ids),
    {
      level,
      entityId,
      accountId,
      entityName: opts.entityName,
      startDate: "2026-08-21",
      endDate: "2026-08-21",
      windowType: "custom",
      source: "meta-insights-test",
    }
  );
  if (opts.dataQuality) {
    currentSummary = { ...currentSummary, quality: opts.dataQuality };
  }

  const previousSummary = aggregatePerformanceRecords(history(accountId, entityId, ids), {
    level,
    entityId,
    accountId,
    startDate: "2026-08-11",
    endDate: "2026-08-20",
    windowType: "custom",
    source: "meta-insights-test",
  });

  const comparison = comparePerformanceSummaries(currentSummary, previousSummary);
  const anomalies = detectAnomalies(history(accountId, entityId, ids), currentSummary);

  // comparePerformanceSummaries only derives UNAVAILABLE/PARTIAL internally;
  // propagate explicit overrides (e.g. INSUFFICIENT_DATA) deterministically.
  const effectiveComparison = opts.dataQuality
    ? { ...comparison, quality: opts.dataQuality }
    : comparison;

  const pkg = buildEvidencePackage({
    accountId,
    comparison: effectiveComparison,
    anomalies,
    freshnessOverride: opts.freshness,
    campaignLifecycleState: opts.lifecycle,
    untrustedTexts: opts.labels,
  });

  return {
    pkg,
    anomalyId(metric: string) {
      return pkg.anomalies.find((a) => a.metric === metric)?.anomalyId;
    },
  };
}

/**
 * A fully valid model candidate diagnosis for the fatigue fixture.
 * Every number matches verified evidence within tolerance.
 */
export function buildCandidateDiagnosis(
  fx: FatigueFixture,
  overrides: Partial<ModelDiagnosis> = {}
): ModelDiagnosis {
  const ctrId = fx.anomalyId("ctr");
  const freqId = fx.anomalyId("frequency");
  return {
    entityId: fx.pkg.entityId,
    entityLevel: fx.pkg.entityLevel,
    evidenceHash: fx.pkg.evidenceHash,
    anomalyIds: [ctrId, freqId].filter((x): x is string => Boolean(x)),
    category: "CREATIVE_FATIGUE",
    summary:
      "Engagement deteriorated while frequency and acquisition cost rose; creative fatigue is a plausible contributor.",
    facts: [
      { statement: "CTR decreased 45% versus baseline.", evidenceRef: `anomaly:${ctrId}` },
      { statement: "Frequency increased 56% versus baseline.", evidenceRef: `anomaly:${freqId}` },
      { statement: "CPA increased 150%.", evidenceRef: "metric:cpa:change_percent" },
    ],
    inferences: [
      {
        statement: "Lower click-through performance coincides with higher acquisition cost.",
        supportingEvidence: [`anomaly:${ctrId}`, "metric:cpa:change_percent"],
        confidence: "MEDIUM",
      },
    ],
    hypotheses: [
      {
        statement: "Creative fatigue may be contributing to the deterioration.",
        category: "CREATIVE_FATIGUE",
        supportingEvidence: [`anomaly:${ctrId}`, `anomaly:${freqId}`],
        contradictingEvidence: [],
        confidence: "MEDIUM",
      },
    ],
    confidence: "MEDIUM",
    ...overrides,
  };
}
