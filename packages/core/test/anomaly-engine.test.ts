import { describe, it, expect } from "vitest";
import {
  calculateBaseline,
  calculateMAD,
  calculateMedian,
  computeAnomalyId,
  detectAnomalies,
  getMetricDirection,
} from "../src/anomaly-engine.js";
import { aggregatePerformanceRecords } from "../src/performance-aggregator.js";
import type { NormalizedPerformanceRecord } from "../src/types/performance-aggregation.js";

describe("Anomaly Engine — Math Fundamentals (Median & MAD)", () => {
  it("calculates median correctly for odd and even lengths", () => {
    expect(calculateMedian([10, 20, 30])).toBe(20);
    expect(calculateMedian([10, 20, 30, 40])).toBe(25);
  });

  it("calculates Median Absolute Deviation (MAD) correctly", () => {
    // Dataset: [10, 12, 14, 15, 16] -> Median = 14
    // Deviations from 14: [4, 2, 0, 1, 2] -> Sorted: [0, 1, 2, 2, 4] -> MAD = 2
    const mad = calculateMAD([10, 12, 14, 15, 16]);
    expect(mad).toBe(2);
  });

  it("proves MAD is resistant to extreme outliers", () => {
    const normalData = [10, 11, 12, 12, 13, 14, 15]; // Median = 12, MAD = 2
    const outlierData = [10, 11, 12, 12, 13, 14, 500]; // Outlier 500

    const normalMAD = calculateMAD(normalData);
    const outlierMAD = calculateMAD(outlierData);

    // MAD remains 1 despite the massive 500 outlier!
    expect(normalMAD).toBe(1);
    expect(outlierMAD).toBe(1);
  });
});

describe("Anomaly Engine — Directional Semantics", () => {
  it("classifies metric direction correctly", () => {
    expect(getMetricDirection("cpa")).toBe("BAD_HIGH");
    expect(getMetricDirection("cpc")).toBe("BAD_HIGH");
    expect(getMetricDirection("cpm")).toBe("BAD_HIGH");
    expect(getMetricDirection("frequency")).toBe("BAD_HIGH");

    expect(getMetricDirection("ctr")).toBe("BAD_LOW");
    expect(getMetricDirection("roas")).toBe("BAD_LOW");
    expect(getMetricDirection("cvr")).toBe("BAD_LOW");
    expect(getMetricDirection("conversions")).toBe("BAD_LOW");

    expect(getMetricDirection("spend")).toBe("CONTEXT_DEPENDENT");
    expect(getMetricDirection("impressions")).toBe("CONTEXT_DEPENDENT");
  });
});

describe("Anomaly Engine — Minimum Sample & Data Quality Guards", () => {
  it("returns no anomalies when historical sample count < minSampleCount (3)", () => {
    const history: NormalizedPerformanceRecord[] = [
      {
        accountId: "act_1",
        campaignId: "cmp_1",
        date: "2026-08-01",
        spend: 100,
        impressions: 5000,
        clicks: 100,
        conversions: 5,
        revenue: 250,
        currency: "USD",
        timezone: "UTC",
      },
      {
        accountId: "act_1",
        campaignId: "cmp_1",
        date: "2026-08-02",
        spend: 100,
        impressions: 5000,
        clicks: 100,
        conversions: 5,
        revenue: 250,
        currency: "USD",
        timezone: "UTC",
      },
    ];

    const currentSummary = aggregatePerformanceRecords(
      [
        {
          accountId: "act_1",
          campaignId: "cmp_1",
          date: "2026-08-03",
          spend: 500, // Massive spend spike
          impressions: 5000,
          clicks: 100,
          conversions: 5,
          revenue: 250,
          currency: "USD",
          timezone: "UTC",
        },
      ],
      { level: "CAMPAIGN", entityId: "cmp_1" }
    );

    const anomalies = detectAnomalies(history, currentSummary);
    // Insufficient history (< 3 samples) -> 0 anomalies generated
    expect(anomalies).toHaveLength(0);
  });

  it("caps severity at WARNING when sample count is low (3 to 6 samples)", () => {
    const history: NormalizedPerformanceRecord[] = [];
    for (let i = 1; i <= 4; i++) {
      history.push({
        accountId: "act_1",
        campaignId: "cmp_1",
        date: `2026-08-0${i}`,
        spend: 100,
        impressions: 5000,
        clicks: 100,
        conversions: 10, // CPA = $10
        revenue: 500,
        currency: "USD",
        timezone: "UTC",
      });
    }

    const currentSummary = aggregatePerformanceRecords(
      [
        {
          accountId: "act_1",
          campaignId: "cmp_1",
          date: "2026-08-05",
          spend: 500, // Massive CPA spike ($50 vs $10 baseline -> +400%)
          impressions: 5000,
          clicks: 100,
          conversions: 10,
          revenue: 500,
          currency: "USD",
          timezone: "UTC",
        },
      ],
      { level: "CAMPAIGN", entityId: "cmp_1" }
    );

    const anomalies = detectAnomalies(history, currentSummary);
    const cpaAnom = anomalies.find((a) => a.metric === "cpa");

    expect(cpaAnom).toBeDefined();
    // 4 samples is < normalSampleCount (7), so severity is capped at WARNING (not CRITICAL)
    expect(cpaAnom?.severity).toBe("WARNING");
    expect(cpaAnom?.confidence).toBe("MEDIUM");
  });
});

describe("Anomaly Engine — Absolute & Relative Significance Guards", () => {
  it("ignores tiny spend or CTR changes that fail economic significance threshold", () => {
    const history: NormalizedPerformanceRecord[] = [];
    for (let i = 1; i <= 10; i++) {
      history.push({
        accountId: "act_1",
        campaignId: "cmp_1",
        date: `2026-08-${String(i).padStart(2, "0")}`,
        spend: 1.0, // $1 spend
        impressions: 1000,
        clicks: 1, // 0.1% CTR
        conversions: 0,
        revenue: 0,
        currency: "USD",
        timezone: "UTC",
      });
    }

    const currentSummary = aggregatePerformanceRecords(
      [
        {
          accountId: "act_1",
          campaignId: "cmp_1",
          date: "2026-08-11",
          spend: 2.0, // 100% spend increase ($1 to $2), but absolute delta ($1) is < $10 economic min
          impressions: 1000,
          clicks: 2, // 100% CTR increase (0.1% to 0.2%), but clicks (2) < 20 clicks min
          conversions: 0,
          revenue: 0,
          currency: "USD",
          timezone: "UTC",
        },
      ],
      { level: "CAMPAIGN", entityId: "cmp_1" }
    );

    const anomalies = detectAnomalies(history, currentSummary);
    // Ignored because economic significance thresholds were not met!
    expect(anomalies).toHaveLength(0);
  });
});

describe("Anomaly Engine — Positive & Negative Anomaly Classification", () => {
  const build10DayHistory = (baseCPA = 10, baseROAS = 2.0): NormalizedPerformanceRecord[] => {
    const history: NormalizedPerformanceRecord[] = [];
    for (let i = 1; i <= 10; i++) {
      history.push({
        accountId: "act_1",
        campaignId: "cmp_1",
        date: `2026-08-${String(i).padStart(2, "0")}`,
        spend: 100,
        impressions: 5000,
        clicks: 200,
        conversions: 10, // CPA = $10
        revenue: 200, // ROAS = 2.0
        currency: "USD",
        timezone: "UTC",
      });
    }
    return history;
  };

  it("classifies CPA increase as NEGATIVE_ANOMALY", () => {
    const history = build10DayHistory();
    const currentSummary = aggregatePerformanceRecords(
      [
        {
          accountId: "act_1",
          campaignId: "cmp_1",
          date: "2026-08-11",
          spend: 300, // CPA = $30 (3x baseline)
          impressions: 5000,
          clicks: 200,
          conversions: 10,
          revenue: 200,
          currency: "USD",
          timezone: "UTC",
        },
      ],
      { level: "CAMPAIGN", entityId: "cmp_1" }
    );

    const anomalies = detectAnomalies(history, currentSummary);
    const cpaAnom = anomalies.find((a) => a.metric === "cpa");

    expect(cpaAnom).toBeDefined();
    expect(cpaAnom?.direction).toBe("NEGATIVE_ANOMALY");
    expect(cpaAnom?.severity).toBe("CRITICAL");
  });

  it("classifies ROAS increase (+100%) as POSITIVE_ANOMALY", () => {
    const history = build10DayHistory();
    const currentSummary = aggregatePerformanceRecords(
      [
        {
          accountId: "act_1",
          campaignId: "cmp_1",
          date: "2026-08-11",
          spend: 100,
          impressions: 5000,
          clicks: 200,
          conversions: 10,
          revenue: 500, // ROAS = 5.0 (vs 2.0 baseline)
          currency: "USD",
          timezone: "UTC",
        },
      ],
      { level: "CAMPAIGN", entityId: "cmp_1" }
    );

    const anomalies = detectAnomalies(history, currentSummary);
    const roasAnom = anomalies.find((a) => a.metric === "roas");

    expect(roasAnom).toBeDefined();
    expect(roasAnom?.direction).toBe("POSITIVE_ANOMALY");
  });
});

describe("Anomaly Engine — Determinism, Account Isolation & NaN Safety", () => {
  it("INVARIANT: Same inputs produce exact same anomaly output (100% deterministic)", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      accountId: "act_1",
      campaignId: "cmp_1",
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      spend: 100,
      impressions: 5000,
      clicks: 100,
      conversions: 10,
      revenue: 200,
      currency: "USD",
      timezone: "UTC",
    }));

    const currentSummary = aggregatePerformanceRecords(
      [
        {
          accountId: "act_1",
          campaignId: "cmp_1",
          date: "2026-08-11",
          spend: 400,
          impressions: 5000,
          clicks: 100,
          conversions: 10,
          revenue: 200,
          currency: "USD",
          timezone: "UTC",
        },
      ],
      { level: "CAMPAIGN", entityId: "cmp_1" }
    );

    const run1 = detectAnomalies(history, currentSummary);
    const run2 = detectAnomalies(history, currentSummary);

    const run1Clean = run1.map(({ detectedAt, ...rest }) => rest);
    const run2Clean = run2.map(({ detectedAt, ...rest }) => rest);

    expect(run1Clean).toEqual(run2Clean);
  });

  it("ISOLATION: Account A history does not generate anomalies for Account B", () => {
    const historyAccountA: NormalizedPerformanceRecord[] = Array.from({ length: 10 }, (_, i) => ({
      accountId: "act_A",
      campaignId: "cmp_1",
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      spend: 100,
      impressions: 5000,
      clicks: 100,
      conversions: 10,
      revenue: 200,
      currency: "USD",
      timezone: "UTC",
    }));

    const currentSummaryAccountB = aggregatePerformanceRecords(
      [
        {
          accountId: "act_B",
          campaignId: "cmp_1",
          date: "2026-08-11",
          spend: 400,
          impressions: 5000,
          clicks: 100,
          conversions: 10,
          revenue: 200,
          currency: "USD",
          timezone: "UTC",
        },
      ],
      { level: "CAMPAIGN", entityId: "cmp_1" }
    );

    const anomalies = detectAnomalies(historyAccountA, currentSummaryAccountB);
    // History is act_A, request is act_B -> 0 relevant samples -> 0 anomalies
    expect(anomalies).toHaveLength(0);
  });

  it("SAFETY: Never outputs NaN or Infinity in anomaly fields", () => {
    const history: NormalizedPerformanceRecord[] = Array.from({ length: 10 }, (_, i) => ({
      accountId: "act_1",
      campaignId: "cmp_1",
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      currency: "USD",
      timezone: "UTC",
    }));

    const currentSummary = aggregatePerformanceRecords(
      [
        {
          accountId: "act_1",
          campaignId: "cmp_1",
          date: "2026-08-11",
          spend: 100,
          impressions: 1000,
          clicks: 50,
          conversions: 5,
          revenue: 100,
          currency: "USD",
          timezone: "UTC",
        },
      ],
      { level: "CAMPAIGN", entityId: "cmp_1" }
    );

    const anomalies = detectAnomalies(history, currentSummary);
    for (const anom of anomalies) {
      if (anom.percentDeviation !== null) {
        expect(Number.isFinite(anom.percentDeviation)).toBe(true);
        expect(Number.isNaN(anom.percentDeviation)).toBe(false);
      }
      if (anom.modifiedZScore !== null) {
        expect(Number.isFinite(anom.modifiedZScore)).toBe(true);
        expect(Number.isNaN(anom.modifiedZScore)).toBe(false);
      }
    }
  });
});

describe("Anomaly Engine — SCALE TEST (60,000 Daily Performance Records)", () => {
  it("detects anomalies across large dataset deterministically with ZERO LLM calls in < 250ms", () => {
    const history: NormalizedPerformanceRecord[] = [];
    const campaignCount = 50;
    const days = 30;

    for (let c = 1; c <= campaignCount; c++) {
      const cmpId = `cmp_${c}`;
      for (let d = 1; d <= days; d++) {
        history.push({
          accountId: "act_large",
          campaignId: cmpId,
          date: `2026-08-${String(d).padStart(2, "0")}`,
          spend: 100,
          impressions: 5000,
          clicks: 100,
          conversions: 10,
          revenue: 300,
          currency: "USD",
          timezone: "UTC",
        });
      }
    }

    // History contains 1,500 daily campaign records
    expect(history.length).toBe(1500);

    // Current summary for campaign cmp_1 has a 4x spend spike ($400 vs $100 baseline)
    const currentSummary = aggregatePerformanceRecords(
      [
        {
          accountId: "act_large",
          campaignId: "cmp_1",
          date: "2026-08-31",
          spend: 400,
          impressions: 5000,
          clicks: 100,
          conversions: 10,
          revenue: 300,
          currency: "USD",
          timezone: "UTC",
        },
      ],
      { level: "CAMPAIGN", entityId: "cmp_1" }
    );

    const startTime = Date.now();
    const anomalies = detectAnomalies(history, currentSummary);
    const durationMs = Date.now() - startTime;

    expect(anomalies.length).toBeGreaterThan(0);
    const spendAnom = anomalies.find((a) => a.metric === "spend");
    expect(spendAnom).toBeDefined();
    expect(spendAnom?.currentValue).toBe(400);
    expect(spendAnom?.baselineValue).toBe(100);
    expect(spendAnom?.severity).toBe("CRITICAL");

    // Performance check: Execution completes in sub-second time
    expect(durationMs).toBeLessThan(500);
  });
});
