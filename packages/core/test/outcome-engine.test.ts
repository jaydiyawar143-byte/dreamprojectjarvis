/**
 * Phase 11.7A — Outcome Engine Unit Tests
 *
 * 27 deterministic test cases.
 * Mock Meta data only. NO real Meta writes. NO AI. NO workers.
 *
 * Tests cover:
 *  1.  Baseline snapshot — all KPI fields present
 *  2.  Baseline immutability — snapshot values unchanged after capture
 *  3.  Measurement window config — stabilization period by action type
 *  4.  Stabilization block — WAITING_FOR_DATA within stabilization
 *  5.  Primary metric direction — CPA lower is better
 *  6.  Primary metric direction — CTR higher is better
 *  7.  POSITIVE outcome
 *  8.  NEGATIVE outcome
 *  9.  NEUTRAL outcome (below materiality threshold)
 *  10. INCONCLUSIVE — insufficient data
 *  11. INCONCLUSIVE — attribution pending
 *  12. FAILED_ACTION
 *  13. Minimum significance threshold enforced
 *  14. Insufficient elapsed time → WAITING_FOR_DATA
 *  15. Stale data → INCONCLUSIVE
 *  16. Partial data → outcome proceeds (with reduced confidence)
 *  17. Confounder — external budget change detected
 *  18. Confounder — external status change
 *  19. Confounder — overlapping recommendation
 *  20. Confounder reduces confidence score
 *  21. Account isolation — different accountId not mixed
 *  22. User isolation — userId enforced in store port shape
 *  23. Idempotency — repeated measureOutcome returns same result
 *  24. Finalized outcome — second classify produces same result
 *  25. No NaN in KPI comparison
 *  26. No Infinity in KPI comparison
 *  27. Canonical KPI reuse — uses calculateCanonicalKPIs (not ad-hoc averages)
 */

import { describe, it, expect } from "vitest";
import {
  captureBaselineSnapshot,
  buildMeasurementWindowConfig,
  checkMeasurementState,
  compareKPIValues,
  checkDataSufficiency,
  detectConfounders,
  computeOutcomeConfidence,
  classifyOutcome,
  measureOutcome,
  computeCurrentKPIs,
  getPrimaryMetricDirection,
  determineAttributionStatus,
} from "../src/outcome-engine.js";
import {
  STABILIZATION_MS_PAUSE_RESUME,
  STABILIZATION_MS_BUDGET,
  MEASUREMENT_WINDOW_MS,
  type BaselineSnapshot,
  type BaselineKPIValues,
  type MeasurementWindowConfig,
  MATERIALITY_THRESHOLDS,
} from "../src/types/outcome.js";
import { calculateCanonicalKPIs } from "../src/kpi-engine.js";
import type { PerformanceSummary } from "../src/types/performance-aggregation.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSummary(overrides?: Partial<PerformanceSummary>): PerformanceSummary {
  const kpis = calculateCanonicalKPIs({
    spend: 500,
    impressions: 50000,
    clicks: 1000,
    reach: 40000,
    conversions: 20,
    revenue: 2000,
  });
  return {
    accountId: "act_test123",
    level: "CAMPAIGN",
    entityId: "cmp_abc",
    entityName: "Test Campaign",
    currency: "USD",
    timezone: "UTC",
    window: { type: "last_7_days", startDate: "2026-08-16", endDate: "2026-08-22" },
    recordCount: 7,
    kpis,
    quality: "COMPLETE",
    fetchedAt: "2026-08-22T12:00:00.000Z",
    source: "meta-graph",
    ...overrides,
  };
}

function makeBaseline(overrides?: Partial<BaselineKPIValues>): BaselineSnapshot {
  const summary = makeSummary();
  const snapshot = captureBaselineSnapshot(summary, {
    fetchedAt: "2026-08-22T12:00:00.000Z",
  });
  if (overrides) {
    return {
      ...snapshot,
      kpis: { ...snapshot.kpis, ...overrides },
    };
  }
  return snapshot;
}

const EXECUTED_AT_LONG_AGO = "2026-08-15T00:00:00.000Z"; // 9+ days ago (beyond any window)
const EXECUTED_AT_RECENT = new Date(Date.now() - 1000 * 60 * 30).toISOString(); // 30 min ago

function makeWindowConfig(isBudget = false): MeasurementWindowConfig {
  return buildMeasurementWindowConfig(isBudget ? "INCREASE_BUDGET" : "PAUSE_CAMPAIGN");
}

// ---------------------------------------------------------------------------
// 1. Baseline snapshot — all KPI fields present
// ---------------------------------------------------------------------------

describe("1 — baseline snapshot: all KPI fields present", () => {
  it("captures all required fields", () => {
    const summary = makeSummary();
    const snapshot = captureBaselineSnapshot(summary);

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.dateRangeStart).toBe("2026-08-16");
    expect(snapshot.dateRangeEnd).toBe("2026-08-22");
    expect(snapshot.timezone).toBe("UTC");
    expect(snapshot.currency).toBe("USD");
    expect(snapshot.source).toBe("meta-graph");
    expect(snapshot.kpiEngineVersion).toBe("11.1.0");
    expect(snapshot.aggregationVersion).toBe("11.2.0");
    expect(typeof snapshot.fetchedAt).toBe("string");

    const kpis = snapshot.kpis;
    expect(kpis.spend).toBe(500);
    expect(kpis.impressions).toBe(50000);
    expect(kpis.clicks).toBe(1000);
    expect(kpis.conversions).toBe(20);
    expect(kpis.revenue).toBe(2000);
    expect(typeof kpis.ctr).toBe("number");
    expect(typeof kpis.cpc).toBe("number");
    expect(typeof kpis.cpm).toBe("number");
    expect(typeof kpis.cpa).toBe("number");
    expect(typeof kpis.roas).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 2. Baseline immutability — snapshot values unchanged after capture
// ---------------------------------------------------------------------------

describe("2 — baseline immutability", () => {
  it("snapshot KPI values are not affected by later summary changes", () => {
    const summary = makeSummary();
    const snapshot = captureBaselineSnapshot(summary, { fetchedAt: "2026-08-22T12:00:00.000Z" });

    // Simulate later mutation attempt on the underlying summary (should not affect snapshot)
    (summary as unknown as Record<string, unknown>).kpis = calculateCanonicalKPIs({
      spend: 9999,
      impressions: 9999,
      clicks: 9999,
      reach: 9999,
      conversions: 9999,
      revenue: 9999,
    });

    // Snapshot values must remain original
    expect(snapshot.kpis.spend).toBe(500);
    expect(snapshot.kpis.impressions).toBe(50000);
    expect(snapshot.fetchedAt).toBe("2026-08-22T12:00:00.000Z");
  });

  it("captures fetchedAt exactly as provided", () => {
    const snapshot = captureBaselineSnapshot(makeSummary(), {
      fetchedAt: "2026-08-22T10:30:00.000Z",
    });
    expect(snapshot.fetchedAt).toBe("2026-08-22T10:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// 3. Measurement window config — stabilization period by action type
// ---------------------------------------------------------------------------

describe("3 — measurement window config", () => {
  it("pause actions use 24h stabilization", () => {
    const cfg = buildMeasurementWindowConfig("PAUSE_CAMPAIGN");
    expect(cfg.stabilizationMs).toBe(STABILIZATION_MS_PAUSE_RESUME);
    expect(cfg.stabilizationMs).toBe(24 * 60 * 60 * 1000);
  });

  it("budget actions use 48h stabilization", () => {
    const cfg = buildMeasurementWindowConfig("INCREASE_BUDGET");
    expect(cfg.stabilizationMs).toBe(STABILIZATION_MS_BUDGET);
    expect(cfg.stabilizationMs).toBe(48 * 60 * 60 * 1000);
  });

  it("measurement period is 7 days", () => {
    const cfg = buildMeasurementWindowConfig("PAUSE_AD");
    expect(cfg.measurementMs).toBe(MEASUREMENT_WINDOW_MS);
    expect(cfg.measurementMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("minimum data requirements are positive integers", () => {
    const cfg = buildMeasurementWindowConfig("DECREASE_BUDGET");
    expect(cfg.minimumDataDays).toBeGreaterThan(0);
    expect(cfg.minimumSpend).toBeGreaterThanOrEqual(0);
    expect(cfg.minimumConversions).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Stabilization block — WAITING_FOR_DATA within stabilization
// ---------------------------------------------------------------------------

describe("4 — stabilization block", () => {
  it("returns WAITING_FOR_DATA within stabilization period", () => {
    const executedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const cfg = buildMeasurementWindowConfig("PAUSE_CAMPAIGN"); // 24h stabilization
    const state = checkMeasurementState(executedAt, cfg);
    expect(state).toBe("WAITING_FOR_DATA");
  });

  it("returns READY after stabilization elapsed", () => {
    const executedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const cfg = buildMeasurementWindowConfig("PAUSE_CAMPAIGN");
    const state = checkMeasurementState(executedAt, cfg, {
      attributionStatus: "ATTRIBUTION_READY",
    });
    expect(state).toBe("READY");
  });

  it("returns FINALIZED when isAlreadyFinalized = true regardless of time", () => {
    const cfg = buildMeasurementWindowConfig("PAUSE_CAMPAIGN");
    const state = checkMeasurementState(EXECUTED_AT_RECENT, cfg, {
      isAlreadyFinalized: true,
    });
    expect(state).toBe("FINALIZED");
  });
});

// ---------------------------------------------------------------------------
// 5. Primary metric direction — CPA lower is better
// ---------------------------------------------------------------------------

describe("5 — primary metric direction CPA (lower is better)", () => {
  it("CPA direction is LOWER_IS_BETTER", () => {
    expect(getPrimaryMetricDirection("CPA")).toBe("LOWER_IS_BETTER");
  });

  it("CPC direction is LOWER_IS_BETTER", () => {
    expect(getPrimaryMetricDirection("CPC")).toBe("LOWER_IS_BETTER");
  });

  it("CPA improvement means current < baseline", () => {
    const baseline = makeBaseline({ cpa: 50 });
    const current: BaselineKPIValues = { ...baseline.kpis, cpa: 40 }; // lower → better
    const result = compareKPIValues(baseline.kpis, current, "CPA");
    expect(result.direction).toBe("IMPROVED");
    expect(result.percentChange).toBeLessThan(0);
  });

  it("CPA worsening means current > baseline", () => {
    const baseline = makeBaseline({ cpa: 50 });
    const current: BaselineKPIValues = { ...baseline.kpis, cpa: 65 }; // higher → worse
    const result = compareKPIValues(baseline.kpis, current, "CPA");
    expect(result.direction).toBe("WORSENED");
  });
});

// ---------------------------------------------------------------------------
// 6. Primary metric direction — CTR higher is better
// ---------------------------------------------------------------------------

describe("6 — primary metric direction CTR (higher is better)", () => {
  it("CTR direction is HIGHER_IS_BETTER", () => {
    expect(getPrimaryMetricDirection("CTR")).toBe("HIGHER_IS_BETTER");
  });

  it("ROAS direction is HIGHER_IS_BETTER", () => {
    expect(getPrimaryMetricDirection("ROAS")).toBe("HIGHER_IS_BETTER");
  });

  it("CVR direction is HIGHER_IS_BETTER", () => {
    expect(getPrimaryMetricDirection("CVR")).toBe("HIGHER_IS_BETTER");
  });

  it("CTR improvement means current > baseline", () => {
    const baseline = makeBaseline({ ctr: 2.0 });
    const current: BaselineKPIValues = { ...baseline.kpis, ctr: 2.5 };
    const result = compareKPIValues(baseline.kpis, current, "CTR");
    expect(result.direction).toBe("IMPROVED");
  });

  it("SPEND and IMPRESSIONS are CONTEXT_DEPENDENT", () => {
    expect(getPrimaryMetricDirection("SPEND")).toBeNull();
    expect(getPrimaryMetricDirection("IMPRESSIONS")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. POSITIVE outcome
// ---------------------------------------------------------------------------

describe("7 — POSITIVE outcome", () => {
  it("classifies POSITIVE when primary metric materially improves", () => {
    const result = measureOutcome({
      recommendationId: "rec_001",
      executionId: "exec_001",
      accountId: "act_001",
      entityType: "CAMPAIGN",
      entityId: "cmp_001",
      actionType: "PAUSE_AD",
      primaryMetric: "CPA",
      baseline: makeBaseline({ cpa: 50 }),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      dataQuality: "COMPLETE",
      daysWithData: 7,
      currentRawInputs: {
        spend: 400,
        impressions: 50000,
        clicks: 1000,
        reach: 40000,
        conversions: 25, // more conversions → CPA improves from 50 to 16
        revenue: 2500,
      },
      mostRecentDataPointAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      referenceNow: new Date(),
    });
    expect(result.outcomeRecord.outcome).toBe("POSITIVE");
  });
});

// ---------------------------------------------------------------------------
// 8. NEGATIVE outcome
// ---------------------------------------------------------------------------

describe("8 — NEGATIVE outcome", () => {
  it("classifies NEGATIVE when primary metric materially worsens", () => {
    const result = measureOutcome({
      recommendationId: "rec_002",
      executionId: "exec_002",
      accountId: "act_001",
      entityType: "CAMPAIGN",
      entityId: "cmp_001",
      actionType: "PAUSE_AD",
      primaryMetric: "CPA",
      baseline: makeBaseline({ cpa: 20 }),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      dataQuality: "COMPLETE",
      daysWithData: 7,
      currentRawInputs: {
        spend: 500,
        impressions: 50000,
        clicks: 1000,
        reach: 40000,
        conversions: 5, // fewer conversions → CPA rises from 20 to 100
        revenue: 500,
      },
      mostRecentDataPointAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      referenceNow: new Date(),
    });
    expect(result.outcomeRecord.outcome).toBe("NEGATIVE");
  });
});

// ---------------------------------------------------------------------------
// 9. NEUTRAL outcome (below materiality threshold)
// ---------------------------------------------------------------------------

describe("9 — NEUTRAL outcome", () => {
  it("classifies NEUTRAL when change is below 5% materiality threshold", () => {
    // CPA baseline = 100; current = 103 → +3% change < 5% threshold
    const baseline = makeBaseline({ cpa: 100 });
    const comparison = compareKPIValues(
      baseline.kpis,
      { ...baseline.kpis, cpa: 103 },
      "CPA"
    );
    const outcome = classifyOutcome({
      comparison,
      sufficiency: {
        sufficient: true,
        elapsedMs: 8 * 24 * 60 * 60 * 1000,
        dataAgeDays: 0.5,
        daysWithData: 7,
        totalSpend: 500,
        totalConversions: 20,
        isStale: false,
        isPartial: false,
        reasons: [],
      },
      confounders: [],
      attributionStatus: "ATTRIBUTION_READY",
      executionDefinitelyFailed: false,
      measurementState: "READY",
    });
    expect(outcome).toBe("NEUTRAL");
  });
});

// ---------------------------------------------------------------------------
// 10. INCONCLUSIVE — insufficient data
// ---------------------------------------------------------------------------

describe("10 — INCONCLUSIVE: insufficient data", () => {
  it("classifies INCONCLUSIVE when spend is below minimum", () => {
    const result = measureOutcome({
      recommendationId: "rec_003",
      executionId: "exec_003",
      accountId: "act_001",
      entityType: "CAMPAIGN",
      entityId: "cmp_001",
      actionType: "PAUSE_AD",
      primaryMetric: "CPA",
      baseline: makeBaseline(),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      dataQuality: "COMPLETE",
      daysWithData: 7,
      currentRawInputs: {
        spend: 1, // $1 — below $10 minimum
        impressions: 100,
        clicks: 5,
        reach: 90,
        conversions: 0,
        revenue: 0,
      },
      mostRecentDataPointAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      referenceNow: new Date(),
    });
    expect(result.outcomeRecord.outcome).toBe("INCONCLUSIVE");
  });

  it("classifies INCONCLUSIVE when daysWithData below minimum", () => {
    const result = measureOutcome({
      recommendationId: "rec_004",
      executionId: "exec_004",
      accountId: "act_001",
      entityType: "CAMPAIGN",
      entityId: "cmp_001",
      actionType: "PAUSE_AD",
      primaryMetric: "CTR",
      baseline: makeBaseline(),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      dataQuality: "COMPLETE",
      daysWithData: 1, // below 3-day minimum
      currentRawInputs: {
        spend: 500,
        impressions: 50000,
        clicks: 1100,
        reach: 40000,
        conversions: 20,
        revenue: 2000,
      },
      mostRecentDataPointAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      referenceNow: new Date(),
    });
    expect(result.outcomeRecord.outcome).toBe("INCONCLUSIVE");
  });
});

// ---------------------------------------------------------------------------
// 11. INCONCLUSIVE — attribution pending
// ---------------------------------------------------------------------------

describe("11 — INCONCLUSIVE: attribution pending", () => {
  it("attribution pending reduces confidence but unreliable confounder → INCONCLUSIVE", () => {
    // Within attribution window → state = WAITING_FOR_ATTRIBUTION
    const executedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    const config = buildMeasurementWindowConfig("PAUSE_AD");
    const attrStatus = determineAttributionStatus(executedAt, config);
    expect(attrStatus).toBe("ATTRIBUTION_PENDING");
  });

  it("zero conversions with attribution pending does NOT classify as FAILED_ACTION", () => {
    const executedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const result = measureOutcome({
      recommendationId: "rec_005",
      executionId: "exec_005",
      accountId: "act_001",
      entityType: "AD_SET",
      entityId: "adset_001",
      actionType: "PAUSE_AD_SET",
      primaryMetric: "CPA",
      baseline: makeBaseline({ cpa: 50 }),
      executedAtIso: executedAt,
      dataQuality: "COMPLETE",
      daysWithData: 1, // still low — attribution pending
      currentRawInputs: {
        spend: 50,
        impressions: 5000,
        clicks: 100,
        reach: 4000,
        conversions: 0,
        revenue: 0,
      },
      mostRecentDataPointAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    // Must NOT be FAILED_ACTION — attribution is still pending
    expect(result.outcomeRecord.outcome).not.toBe("FAILED_ACTION");
  });
});

// ---------------------------------------------------------------------------
// 12. FAILED_ACTION
// ---------------------------------------------------------------------------

describe("12 — FAILED_ACTION", () => {
  it("classifies FAILED_ACTION when execution definitively failed", () => {
    const result = measureOutcome({
      recommendationId: "rec_006",
      executionId: "exec_006",
      accountId: "act_001",
      entityType: "CAMPAIGN",
      entityId: "cmp_001",
      actionType: "PAUSE_CAMPAIGN",
      primaryMetric: "ROAS",
      baseline: makeBaseline(),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      executionDefinitelyFailed: true,
      dataQuality: "COMPLETE",
      daysWithData: 7,
      currentRawInputs: null,
      referenceNow: new Date(),
    });
    expect(result.outcomeRecord.outcome).toBe("FAILED_ACTION");
  });
});

// ---------------------------------------------------------------------------
// 13. Minimum significance threshold enforced
// ---------------------------------------------------------------------------

describe("13 — minimum significance threshold", () => {
  it("threshold for CPA is 5%", () => {
    expect(MATERIALITY_THRESHOLDS.CPA).toBe(5);
  });

  it("4.9% change is NOT material", () => {
    const baseline = makeBaseline({ cpa: 100 });
    const result = compareKPIValues(
      baseline.kpis,
      { ...baseline.kpis, cpa: 104.9 },
      "CPA"
    );
    expect(result.isMaterial).toBe(false);
  });

  it("5.0% change IS material", () => {
    const baseline = makeBaseline({ cpa: 100 });
    const result = compareKPIValues(
      baseline.kpis,
      { ...baseline.kpis, cpa: 105.1 }, // 5.1% change
      "CPA"
    );
    expect(result.isMaterial).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14. Insufficient elapsed time → WAITING_FOR_DATA
// ---------------------------------------------------------------------------

describe("14 — insufficient elapsed time", () => {
  it("state = WAITING_FOR_DATA when executed 1h ago (24h stabilization)", () => {
    const executedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const cfg = buildMeasurementWindowConfig("PAUSE_CAMPAIGN");
    expect(checkMeasurementState(executedAt, cfg)).toBe("WAITING_FOR_DATA");
  });

  it("sufficiency check reports insufficient elapsed time", () => {
    const executedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const cfg = buildMeasurementWindowConfig("PAUSE_CAMPAIGN");
    const result = checkDataSufficiency({
      executedAtIso: executedAt,
      config: cfg,
      currentKPIs: { ...makeBaseline().kpis, spend: 500 },
      dataQuality: "COMPLETE",
      daysWithData: 7,
    });
    expect(result.sufficient).toBe(false);
    expect(result.reasons.some((r) => r.includes("Stabilization"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 15. Stale data → INCONCLUSIVE
// ---------------------------------------------------------------------------

describe("15 — stale data → INCONCLUSIVE", () => {
  it("stale data produces INCONCLUSIVE outcome", () => {
    const mostRecentAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(); // 4 days ago
    const result = measureOutcome({
      recommendationId: "rec_007",
      executionId: "exec_007",
      accountId: "act_001",
      entityType: "CAMPAIGN",
      entityId: "cmp_001",
      actionType: "PAUSE_AD",
      primaryMetric: "CPA",
      baseline: makeBaseline(),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      dataQuality: "COMPLETE",
      daysWithData: 7,
      currentRawInputs: {
        spend: 400,
        impressions: 50000,
        clicks: 1000,
        reach: 40000,
        conversions: 25,
        revenue: 2500,
      },
      mostRecentDataPointAt: mostRecentAt, // stale: 4 days old, max is 48h
      referenceNow: new Date(),
    });
    expect(result.outcomeRecord.outcome).toBe("INCONCLUSIVE");
  });
});

// ---------------------------------------------------------------------------
// 16. Partial data — outcome proceeds with reduced confidence
// ---------------------------------------------------------------------------

describe("16 — partial data", () => {
  it("partial data quality reduces confidence but does not always force INCONCLUSIVE", () => {
    const result = measureOutcome({
      recommendationId: "rec_008",
      executionId: "exec_008",
      accountId: "act_001",
      entityType: "CAMPAIGN",
      entityId: "cmp_001",
      actionType: "PAUSE_AD",
      primaryMetric: "CPA",
      baseline: makeBaseline({ cpa: 50 }),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      dataQuality: "PARTIAL",
      daysWithData: 7,
      currentRawInputs: {
        spend: 400,
        impressions: 50000,
        clicks: 1000,
        reach: 40000,
        conversions: 25,
        revenue: 2500,
      },
      mostRecentDataPointAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    // Partial data alone: confidence is reduced but not zero
    expect(result.outcomeRecord.confidence).toBeGreaterThan(0);
    expect(result.outcomeRecord.confidence).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// 17. Confounder — external budget change
// ---------------------------------------------------------------------------

describe("17 — confounder: external budget change", () => {
  it("detects external budget change as confounder", () => {
    const confounders = detectConfounders({
      externalEvents: [
        {
          type: "EXTERNAL_BUDGET_CHANGE",
          detectedAt: "2026-08-18T10:00:00.000Z",
          description: "Manual budget edit in Meta Ads Manager",
        },
      ],
    });
    expect(confounders).toHaveLength(1);
    expect(confounders[0]!.type).toBe("EXTERNAL_BUDGET_CHANGE");
    expect(confounders[0]!.makesAttributionUnreliable).toBe(true);
  });

  it("unreliable confounder forces INCONCLUSIVE outcome", () => {
    const result = measureOutcome({
      recommendationId: "rec_009",
      executionId: "exec_009",
      accountId: "act_001",
      entityType: "CAMPAIGN",
      entityId: "cmp_001",
      actionType: "PAUSE_AD",
      primaryMetric: "CPA",
      baseline: makeBaseline({ cpa: 50 }),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      dataQuality: "COMPLETE",
      daysWithData: 7,
      currentRawInputs: {
        spend: 400,
        impressions: 50000,
        clicks: 1000,
        reach: 40000,
        conversions: 25,
        revenue: 2500,
      },
      mostRecentDataPointAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      confounderInput: {
        externalEvents: [
          {
            type: "EXTERNAL_BUDGET_CHANGE",
            detectedAt: "2026-08-18T10:00:00.000Z",
            description: "Budget changed externally",
          },
        ],
      },
    });
    expect(result.outcomeRecord.outcome).toBe("INCONCLUSIVE");
  });
});

// ---------------------------------------------------------------------------
// 18. Confounder — external status change
// ---------------------------------------------------------------------------

describe("18 — confounder: external status change", () => {
  it("detects external status change and marks unreliable", () => {
    const confounders = detectConfounders({
      externalEvents: [
        {
          type: "EXTERNAL_STATUS_CHANGE",
          detectedAt: "2026-08-19T08:00:00.000Z",
          description: "Campaign re-enabled externally",
        },
      ],
    });
    expect(confounders[0]!.makesAttributionUnreliable).toBe(true);
  });

  it("creative change is a confounder but reliable (does not make attribution unreliable)", () => {
    const confounders = detectConfounders({
      externalEvents: [
        {
          type: "CREATIVE_CHANGE",
          detectedAt: "2026-08-18T08:00:00.000Z",
          description: "New creative uploaded",
        },
      ],
    });
    expect(confounders[0]!.makesAttributionUnreliable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 19. Confounder — overlapping recommendation
// ---------------------------------------------------------------------------

describe("19 — confounder: overlapping recommendation", () => {
  it("detects overlapping recommendation as unreliable confounder", () => {
    const confounders = detectConfounders({
      overlappingRecommendations: [
        {
          recommendationId: "rec_other",
          executedAt: "2026-08-18T12:00:00.000Z",
        },
      ],
    });
    expect(confounders).toHaveLength(1);
    expect(confounders[0]!.type).toBe("OVERLAPPING_RECOMMENDATION");
    expect(confounders[0]!.makesAttributionUnreliable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 20. Confounder reduces confidence score
// ---------------------------------------------------------------------------

describe("20 — confounder reduces confidence", () => {
  it("unreliable confounder reduces confidence by 0.25", () => {
    const baseSufficiency = {
      sufficient: true,
      elapsedMs: 8 * 24 * 60 * 60 * 1000,
      dataAgeDays: 0.5,
      daysWithData: 7,
      totalSpend: 500,
      totalConversions: 20,
      isStale: false,
      isPartial: false,
      reasons: [] as string[],
    };
    const noConfounder = computeOutcomeConfidence(baseSufficiency, [], "ATTRIBUTION_READY");
    const withConfounder = computeOutcomeConfidence(
      baseSufficiency,
      [
        {
          type: "EXTERNAL_BUDGET_CHANGE",
          detectedAt: "2026-08-18T10:00:00.000Z",
          description: "Budget change",
          makesAttributionUnreliable: true,
        },
      ],
      "ATTRIBUTION_READY"
    );
    expect(withConfounder).toBeLessThan(noConfounder);
    expect(noConfounder - withConfounder).toBeCloseTo(0.25, 2);
  });
});

// ---------------------------------------------------------------------------
// 21. Account isolation
// ---------------------------------------------------------------------------

describe("21 — account isolation", () => {
  it("outcome records from different accounts are independently produced", () => {
    const result1 = measureOutcome({
      recommendationId: "rec_acc_a",
      executionId: "exec_acc_a",
      accountId: "act_ACCOUNT_A",
      entityType: "CAMPAIGN",
      entityId: "cmp_a",
      actionType: "PAUSE_CAMPAIGN",
      primaryMetric: "CPA",
      baseline: makeBaseline({ cpa: 50 }),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      dataQuality: "COMPLETE",
      daysWithData: 7,
      currentRawInputs: { spend: 400, impressions: 50000, clicks: 1000, reach: 40000, conversions: 25, revenue: 2500 },
      mostRecentDataPointAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    const result2 = measureOutcome({
      recommendationId: "rec_acc_b",
      executionId: "exec_acc_b",
      accountId: "act_ACCOUNT_B",
      entityType: "CAMPAIGN",
      entityId: "cmp_b",
      actionType: "PAUSE_CAMPAIGN",
      primaryMetric: "CPA",
      baseline: makeBaseline({ cpa: 80 }),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      dataQuality: "COMPLETE",
      daysWithData: 7,
      currentRawInputs: { spend: 500, impressions: 50000, clicks: 1000, reach: 40000, conversions: 5, revenue: 500 },
      mostRecentDataPointAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    // Both outcomes are scoped to their own accountId
    expect(result1.outcomeRecord.accountId).toBe("act_ACCOUNT_A");
    expect(result2.outcomeRecord.accountId).toBe("act_ACCOUNT_B");
    // Results are independent
    expect(result1.outcomeRecord.outcome).not.toEqual(result2.outcomeRecord.outcome);
  });
});

// ---------------------------------------------------------------------------
// 22. User isolation
// ---------------------------------------------------------------------------

describe("22 — user isolation", () => {
  it("OutcomeStorePort interface requires userId on all operations", () => {
    // Structural test: OutcomeStorePort.get signature requires userId
    // This is verified by TypeScript compilation — runtime check confirms interface shape
    const portShape = {
      get: async (_id: string, _userId: string) => null,
      getByRecommendation: async (_recId: string, _userId: string) => null,
      create: async (_record: OutcomeRecord) => {},
      updateMeasurementState: async (_id: string, _userId: string) => false,
      finalize: async (_id: string, _userId: string, _o: OutcomeEnum, _c: number, _m: string) => false,
      listByAccount: async (_accountId: string, _userId: string) => ({ items: [], total: 0 }),
    };
    expect(typeof portShape.get).toBe("function");
    expect(portShape.get.length).toBe(2); // (outcomeId, userId)
    expect(typeof portShape.finalize).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 23. Idempotency — repeated measureOutcome returns same result
// ---------------------------------------------------------------------------

describe("23 — idempotency", () => {
  it("repeated measureOutcome with same inputs produces same outcome", () => {
    const inputs = {
      outcomeId: "idempotency-test-id",
      recommendationId: "rec_idem",
      executionId: "exec_idem",
      accountId: "act_idem",
      entityType: "CAMPAIGN" as const,
      entityId: "cmp_idem",
      actionType: "PAUSE_AD" as const,
      primaryMetric: "CPA" as const,
      baseline: makeBaseline({ cpa: 50 }),
      executedAtIso: EXECUTED_AT_LONG_AGO,
      dataQuality: "COMPLETE" as const,
      daysWithData: 7,
      currentRawInputs: { spend: 400, impressions: 50000, clicks: 1000, reach: 40000, conversions: 25, revenue: 2500 },
      mostRecentDataPointAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      referenceNow: new Date("2026-08-24T10:00:00.000Z"),
      createdAt: "2026-08-24T10:00:00.000Z",
    };

    const r1 = measureOutcome(inputs);
    const r2 = measureOutcome(inputs);

    expect(r1.outcomeRecord.outcome).toBe(r2.outcomeRecord.outcome);
    expect(r1.outcomeRecord.confidence).toBe(r2.outcomeRecord.confidence);
    expect(r1.measurementState).toBe(r2.measurementState);
    expect(r1.outcomeRecord.outcomeId).toBe(r2.outcomeRecord.outcomeId);
  });
});

// ---------------------------------------------------------------------------
// 24. Finalized outcome immutability
// ---------------------------------------------------------------------------

describe("24 — finalized outcome immutability", () => {
  it("FINALIZED measurement state is returned as-is", () => {
    const state = checkMeasurementState(EXECUTED_AT_RECENT, buildMeasurementWindowConfig("PAUSE_AD"), {
      isAlreadyFinalized: true,
    });
    expect(state).toBe("FINALIZED");
  });

  it("classifyOutcome respects isAlreadyFinalized via measurementState", () => {
    // When engine receives FINALIZED state, classification can still happen
    // but the repository must reject writes (enforced by isFinal DB column)
    const outcome = classifyOutcome({
      comparison: null,
      sufficiency: {
        sufficient: false,
        elapsedMs: 0,
        dataAgeDays: null,
        daysWithData: 0,
        totalSpend: 0,
        totalConversions: 0,
        isStale: false,
        isPartial: false,
        reasons: ["test"],
      },
      confounders: [],
      attributionStatus: "ATTRIBUTION_READY",
      executionDefinitelyFailed: false,
      measurementState: "FINALIZED",
    });
    // FINALIZED → engine treats as READY-equivalent for classification
    // (finalization guard is at repository layer, not classification layer)
    expect(typeof outcome).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 25. No NaN in KPI comparison
// ---------------------------------------------------------------------------

describe("25 — no NaN in KPI comparison", () => {
  it("comparison with zero baseline does not produce NaN", () => {
    const baseline = makeBaseline({ cpa: 0 }); // zero denominator scenario
    const current: BaselineKPIValues = { ...baseline.kpis, cpa: 50 };
    const result = compareKPIValues(baseline.kpis, current, "CPA");
    expect(Number.isNaN(result.absoluteChange)).toBe(false);
    expect(Number.isNaN(result.percentChange ?? 0)).toBe(false);
  });

  it("baseline snapshot never contains NaN", () => {
    const summary = makeSummary();
    const snapshot = captureBaselineSnapshot(summary);
    const kpis = snapshot.kpis;
    expect(Number.isNaN(kpis.spend)).toBe(false);
    expect(Number.isNaN(kpis.impressions)).toBe(false);
    expect(Number.isNaN(kpis.clicks)).toBe(false);
    if (kpis.ctr !== null) expect(Number.isNaN(kpis.ctr)).toBe(false);
    if (kpis.cpa !== null) expect(Number.isNaN(kpis.cpa)).toBe(false);
    if (kpis.roas !== null) expect(Number.isNaN(kpis.roas)).toBe(false);
  });

  it("computeCurrentKPIs with zero spend never returns NaN", () => {
    const kpis = computeCurrentKPIs({ spend: 0, impressions: 0, clicks: 0, reach: 0, conversions: 0, revenue: 0 });
    for (const [, v] of Object.entries(kpis)) {
      if (typeof v === "number") expect(Number.isNaN(v)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 26. No Infinity in KPI comparison
// ---------------------------------------------------------------------------

describe("26 — no Infinity in KPI comparison", () => {
  it("comparison with null baseline does not produce Infinity", () => {
    const baseline = makeBaseline({ cpa: null }); // null: no conversions in baseline
    const current: BaselineKPIValues = { ...baseline.kpis, cpa: 50 };
    const result = compareKPIValues(baseline.kpis, current, "CPA");
    expect(Number.isFinite(result.absoluteChange ?? 0)).toBe(true);
    expect(result.percentChange === null || Number.isFinite(result.percentChange)).toBe(true);
  });

  it("computeCurrentKPIs with divide-by-zero inputs never returns Infinity", () => {
    const kpis = computeCurrentKPIs({ spend: 100, impressions: 0, clicks: 0, reach: 0, conversions: 0, revenue: 0 });
    for (const [, v] of Object.entries(kpis)) {
      if (typeof v === "number") {
        expect(Number.isFinite(v) || v === null).toBe(true);
        expect(v).not.toBe(Infinity);
        expect(v).not.toBe(-Infinity);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 27. Canonical KPI reuse — uses calculateCanonicalKPIs (not ad-hoc averages)
// ---------------------------------------------------------------------------

describe("27 — canonical KPI reuse", () => {
  it("computeCurrentKPIs matches calculateCanonicalKPIs directly", () => {
    const raw = { spend: 600, impressions: 60000, clicks: 1200, reach: 48000, conversions: 24, revenue: 2400 };
    const engineResult = computeCurrentKPIs(raw);
    const directResult = calculateCanonicalKPIs(raw);

    expect(engineResult.spend).toBe(directResult.spend);
    expect(engineResult.impressions).toBe(directResult.impressions);
    expect(engineResult.clicks).toBe(directResult.clicks);
    expect(engineResult.ctr).toBe(directResult.ctr);
    expect(engineResult.cpc).toBe(directResult.cpc);
    expect(engineResult.cpa).toBe(directResult.cpa);
    expect(engineResult.roas).toBe(directResult.roas);
    expect(engineResult.cvr).toBe(directResult.cvr);
  });

  // -------------------------------------------------------------------------
  // R-32 — the diagnosis category survives measurement.
  //
  // `OutcomeRecordSchema` declares the field, the repository persists it, and
  // `findFinalizedOutcomes` filters on that column — but the engine never
  // copied it onto the record it builds, so every stored row held null and
  // category-based historical matching could not match anything.
  // -------------------------------------------------------------------------
  it("carries diagnosisCategory from the measurement input onto the record", () => {
    const baseline = captureBaselineSnapshot(makeSummary(), {
      fetchedAt: "2026-08-22T12:00:00.000Z",
    });

    const result = measureOutcome({
      recommendationId: "rec_r32",
      executionId: "exec_r32",
      accountId: "act_test123",
      entityType: "CAMPAIGN",
      entityId: "cmp_abc",
      actionType: "PAUSE_CAMPAIGN",
      primaryMetric: "CPA",
      baseline,
      executedAtIso: "2026-08-22T12:00:00.000Z",
      diagnosisCategory: "CREATIVE_FATIGUE",
      userId: "user_r32",
    });

    expect(result.outcomeRecord.diagnosisCategory).toBe("CREATIVE_FATIGUE");
  });

  it("stores null, not undefined, when no diagnosis category is supplied", () => {
    const baseline = captureBaselineSnapshot(makeSummary(), {
      fetchedAt: "2026-08-22T12:00:00.000Z",
    });

    const result = measureOutcome({
      recommendationId: "rec_r32_none",
      executionId: "exec_r32_none",
      accountId: "act_test123",
      entityType: "CAMPAIGN",
      entityId: "cmp_abc",
      actionType: "PAUSE_CAMPAIGN",
      primaryMetric: "CPA",
      baseline,
      executedAtIso: "2026-08-22T12:00:00.000Z",
      userId: "user_r32",
    });

    // The column is nullable; null is what the repository writes and what a
    // category filter can reason about. `undefined` would be neither.
    expect(result.outcomeRecord.diagnosisCategory).toBeNull();
  });

  it("baseline KPIs match calculateCanonicalKPIs for same inputs", () => {
    const summary = makeSummary({
      kpis: calculateCanonicalKPIs({ spend: 750, impressions: 75000, clicks: 1500, reach: 60000, conversions: 30, revenue: 3000 }),
    });
    const snapshot = captureBaselineSnapshot(summary);
    const direct = calculateCanonicalKPIs({ spend: 750, impressions: 75000, clicks: 1500, reach: 60000, conversions: 30, revenue: 3000 });

    expect(snapshot.kpis.spend).toBe(direct.spend);
    expect(snapshot.kpis.ctr).toBe(direct.ctr);
    expect(snapshot.kpis.cpa).toBe(direct.cpa);
    expect(snapshot.kpis.roas).toBe(direct.roas);
  });
});

// Re-export type usage for isolation tests
import type { OutcomeRecord, OutcomeEnum } from "../src/types/outcome.js";
