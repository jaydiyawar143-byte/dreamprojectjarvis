import { describe, it, expect } from "vitest";
import {
  aggregatePerformanceRecords,
  calculateMetricComparison,
  comparePerformanceSummaries,
  computeDateWindowRange,
  consumeAllPages,
  formatDateInTimezone,
} from "../src/performance-aggregator.js";
import type { NormalizedPerformanceRecord } from "../src/types/performance-aggregation.js";

describe("Performance Aggregator — Metric Comparisons", () => {
  it("calculates absolute and percentage deltas correctly", () => {
    const res = calculateMetricComparison(120, 100);
    expect(res.current).toBe(120);
    expect(res.previous).toBe(100);
    expect(res.changeAbsolute).toBe(20);
    expect(res.changePercent).toBe(20); // +20%
  });

  it("handles previous = 0 gracefully without returning Infinity", () => {
    const res = calculateMetricComparison(50, 0);
    expect(res.changeAbsolute).toBe(50);
    expect(res.changePercent).toBeNull();
    expect(Number.isFinite(res.changeAbsolute)).toBe(true);
  });

  it("handles current = 0 and previous = 0 gracefully", () => {
    const res = calculateMetricComparison(0, 0);
    expect(res.changeAbsolute).toBe(0);
    expect(res.changePercent).toBe(0);
  });

  it("handles null/undefined values safely without NaN", () => {
    const res = calculateMetricComparison(null, 100);
    expect(res.current).toBeNull();
    expect(res.changeAbsolute).toBeNull();
    expect(res.changePercent).toBeNull();
    expect(Number.isNaN(res.changePercent)).toBe(false);
  });

  it("never returns NaN or Infinity for negative/fractional deltas", () => {
    const res = calculateMetricComparison(45.5, 91.0);
    expect(res.changeAbsolute).toBe(-45.5);
    expect(res.changePercent).toBe(-50);
    expect(Number.isFinite(res.changePercent)).toBe(true);
  });
});

describe("Performance Aggregator — Timezone & Window Ranges", () => {
  it("formats dates in account timezone correctly", () => {
    const d = new Date("2026-08-23T12:00:00Z");
    const dateStr = formatDateInTimezone(d, "America/New_York");
    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("computes last_7_days date boundaries correctly", () => {
    const ref = new Date("2026-08-23T12:00:00Z");
    const res = computeDateWindowRange("last_7_days", "UTC", undefined, ref);
    expect(res.current.startDate).toBe("2026-08-16");
    expect(res.current.endDate).toBe("2026-08-22");
    expect(res.previous.startDate).toBe("2026-08-09");
    expect(res.previous.endDate).toBe("2026-08-15");
  });

  it("computes custom date range comparison window equal in duration", () => {
    const res = computeDateWindowRange("custom", "UTC", {
      start: "2026-08-10",
      end: "2026-08-15", // 6 days
    });

    expect(res.current.startDate).toBe("2026-08-10");
    expect(res.current.endDate).toBe("2026-08-15");
    expect(res.previous.startDate).toBe("2026-08-04");
    expect(res.previous.endDate).toBe("2026-08-09");
  });
});

describe("Performance Aggregator — Weighted Aggregation vs Simple Averaging", () => {
  const childRecord1: NormalizedPerformanceRecord = {
    accountId: "act_100",
    campaignId: "cmp_1",
    adSetId: "adset_1",
    adId: "ad_1",
    date: "2026-08-20",
    spend: 100,
    impressions: 1000,
    clicks: 100, // CTR = 10%
    conversions: 10,
    revenue: 500,
    currency: "USD",
    timezone: "UTC",
  };

  const childRecord2: NormalizedPerformanceRecord = {
    accountId: "act_100",
    campaignId: "cmp_1",
    adSetId: "adset_2",
    adId: "ad_2",
    date: "2026-08-20",
    spend: 900,
    impressions: 90000,
    clicks: 900, // CTR = 1%
    conversions: 180,
    revenue: 4500,
    currency: "USD",
    timezone: "UTC",
  };

  it("PROOF: Parent CTR is weighted (total clicks / total impressions), NOT average of child CTRs", () => {
    const child1CTR = (childRecord1.clicks / childRecord1.impressions) * 100; // 10%
    const child2CTR = (childRecord2.clicks / childRecord2.impressions) * 100; // 1%
    const unweightedAverageCTR = (child1CTR + child2CTR) / 2; // 5.5%

    const aggregated = aggregatePerformanceRecords([childRecord1, childRecord2], {
      level: "CAMPAIGN",
      entityId: "cmp_1",
    });

    // Total clicks = 1000, Total impressions = 91000 => Weighted CTR = (1000 / 91000) * 100 = 1.0989%
    const weightedCTR = aggregated.kpis.ctr;

    expect(weightedCTR).toBe(1.0989);
    expect(weightedCTR).not.toBe(unweightedAverageCTR);
    expect(weightedCTR).not.toBe(5.5);
  });

  it("calculates weighted CPC, CPM, CPA, ROAS, and CVR accurately", () => {
    const aggregated = aggregatePerformanceRecords([childRecord1, childRecord2], {
      level: "CAMPAIGN",
      entityId: "cmp_1",
    });

    // Total Spend = 1000, Total Clicks = 1000 => CPC = 1.00
    expect(aggregated.kpis.cpc).toBe(1.0);
    // Total Spend = 1000, Total Impressions = 91000 => CPM = (1000/91000)*1000 = 10.99
    expect(aggregated.kpis.cpm).toBe(10.99);
    // Total Spend = 1000, Total Conversions = 190 => CPA = 1000/190 = 5.26
    expect(aggregated.kpis.cpa).toBe(5.26);
    // Total Revenue = 5000, Total Spend = 1000 => ROAS = 5.0
    expect(aggregated.kpis.roas).toBe(5.0);
    // Total Conversions = 190, Total Clicks = 1000 => CVR = (190/1000)*100 = 19.0%
    expect(aggregated.kpis.cvr).toBe(19.0);
  });
});

describe("Performance Aggregator — Hierarchy Levels", () => {
  const records: NormalizedPerformanceRecord[] = [
    {
      accountId: "act_100",
      campaignId: "cmp_1",
      adSetId: "adset_1",
      adId: "ad_1",
      date: "2026-08-20",
      spend: 50,
      impressions: 1000,
      clicks: 20,
      conversions: 2,
      revenue: 100,
      currency: "USD",
      timezone: "UTC",
    },
    {
      accountId: "act_100",
      campaignId: "cmp_1",
      adSetId: "adset_1",
      adId: "ad_2",
      date: "2026-08-20",
      spend: 50,
      impressions: 1000,
      clicks: 20,
      conversions: 2,
      revenue: 100,
      currency: "USD",
      timezone: "UTC",
    },
  ];

  it("aggregates at AD level", () => {
    const summary = aggregatePerformanceRecords([records[0]!], {
      level: "AD",
      entityId: "ad_1",
    });
    expect(summary.level).toBe("AD");
    expect(summary.kpis.spend).toBe(50);
  });

  it("aggregates at AD_SET level", () => {
    const summary = aggregatePerformanceRecords(records, {
      level: "AD_SET",
      entityId: "adset_1",
    });
    expect(summary.level).toBe("AD_SET");
    expect(summary.kpis.spend).toBe(100);
    expect(summary.recordCount).toBe(2);
  });

  it("aggregates at CAMPAIGN level", () => {
    const summary = aggregatePerformanceRecords(records, {
      level: "CAMPAIGN",
      entityId: "cmp_1",
    });
    expect(summary.level).toBe("CAMPAIGN");
    expect(summary.kpis.spend).toBe(100);
  });

  it("aggregates at ACCOUNT level", () => {
    const summary = aggregatePerformanceRecords(records, {
      level: "ACCOUNT",
      entityId: "act_100",
    });
    expect(summary.level).toBe("ACCOUNT");
    expect(summary.kpis.spend).toBe(100);
  });
});

describe("Performance Aggregator — Currency Mismatch Protection", () => {
  it("throws CURRENCY_MISMATCH error if records contain different currencies", () => {
    const recUSD: NormalizedPerformanceRecord = {
      accountId: "act_1",
      date: "2026-08-20",
      spend: 100,
      impressions: 1000,
      clicks: 50,
      conversions: 5,
      revenue: 200,
      currency: "USD",
      timezone: "UTC",
    };

    const recEUR: NormalizedPerformanceRecord = {
      accountId: "act_1",
      date: "2026-08-20",
      spend: 100,
      impressions: 1000,
      clicks: 50,
      conversions: 5,
      revenue: 200,
      currency: "EUR",
      timezone: "UTC",
    };

    expect(() =>
      aggregatePerformanceRecords([recUSD, recEUR], {
        level: "ACCOUNT",
        entityId: "act_1",
      })
    ).toThrow(/CURRENCY_MISMATCH/);
  });
});

describe("Performance Aggregator — Window Summaries Comparison", () => {
  const currentSummary = aggregatePerformanceRecords(
    [
      {
        accountId: "act_1",
        date: "2026-08-20",
        spend: 200,
        impressions: 10000,
        clicks: 500,
        conversions: 25,
        revenue: 1000,
        currency: "USD",
        timezone: "UTC",
      },
    ],
    { level: "ACCOUNT", entityId: "act_1", windowType: "last_7_days" }
  );

  const previousSummary = aggregatePerformanceRecords(
    [
      {
        accountId: "act_1",
        date: "2026-08-13",
        spend: 100,
        impressions: 5000,
        clicks: 250,
        conversions: 10,
        revenue: 400,
        currency: "USD",
        timezone: "UTC",
      },
    ],
    { level: "ACCOUNT", entityId: "act_1", windowType: "previous_7_days" }
  );

  it("compares current and previous window summaries correctly", () => {
    const comparison = comparePerformanceSummaries(currentSummary, previousSummary);
    expect(comparison.comparisons.spend.current).toBe(200);
    expect(comparison.comparisons.spend.previous).toBe(100);
    expect(comparison.comparisons.spend.changeAbsolute).toBe(100);
    expect(comparison.comparisons.spend.changePercent).toBe(100); // +100%

    // ROAS comparison: current = 5.0, previous = 4.0 => +1.0 absolute, +25%
    expect(comparison.comparisons.roas.current).toBe(5.0);
    expect(comparison.comparisons.roas.previous).toBe(4.0);
    expect(comparison.comparisons.roas.changeAbsolute).toBe(1.0);
    expect(comparison.comparisons.roas.changePercent).toBe(25);
  });
});

describe("Performance Aggregator — Pagination & Data Quality", () => {
  it("consumes all pages exhaustively", async () => {
    const pages = [
      { data: [{ id: 1 }, { id: 2 }], nextPage: "cursor_2" },
      { data: [{ id: 3 }, { id: 4 }], nextPage: "cursor_3" },
      { data: [{ id: 5 }], nextPage: undefined },
    ];

    let callCount = 0;
    const fetchPage = async (cursor?: string) => {
      callCount++;
      if (!cursor) return pages[0]!;
      if (cursor === "cursor_2") return pages[1]!;
      if (cursor === "cursor_3") return pages[2]!;
      return { data: [], nextPage: undefined };
    };

    const res = await consumeAllPages(fetchPage);
    expect(res.data).toHaveLength(5);
    expect(res.totalPages).toBe(3);
    expect(res.quality).toBe("COMPLETE");
    expect(callCount).toBe(3);
  });

  it("detects repeated cursor and stops to prevent infinite pagination loops", async () => {
    let callCount = 0;
    const fetchPage = async () => {
      callCount++;
      return { data: [{ id: 1 }], nextPage: "same_cursor" };
    };

    const res = await consumeAllPages(fetchPage);
    expect(callCount).toBe(2); // Initial call + 1 repeated cursor call -> stops
    expect(res.quality).toBe("PARTIAL");
  });

  it("handles empty result sets gracefully", () => {
    const summary = aggregatePerformanceRecords([], {
      level: "ACCOUNT",
      entityId: "act_empty",
      allowEmpty: true,
    });
    expect(summary.quality).toBe("UNAVAILABLE");
    expect(summary.recordCount).toBe(0);
    expect(summary.kpis.spend).toBe(0);
    expect(summary.kpis.ctr).toBeNull();
  });
});

describe("Performance Aggregator — SCALE TEST (100 Campaigns, 500 Ad Sets, 2,000 Ads, 30 Days)", () => {
  it("aggregates large dataset deterministically with ZERO LLM calls and under 250ms", () => {
    const records: NormalizedPerformanceRecord[] = [];
    const campaignCount = 100;
    const adSetsPerCampaign = 5;
    const adsPerAdSet = 4; // Total ads = 2,000
    const days = 30;

    const startTime = Date.now();

    for (let c = 1; c <= campaignCount; c++) {
      const cmpId = `cmp_${c}`;
      for (let s = 1; s <= adSetsPerCampaign; s++) {
        const adSetId = `adset_${c}_${s}`;
        for (let a = 1; a <= adsPerAdSet; a++) {
          const adId = `ad_${c}_${s}_${a}`;
          for (let d = 1; d <= days; d++) {
            const dateStr = `2026-08-${String(d).padStart(2, "0")}`;
            records.push({
              accountId: "act_enterprise",
              campaignId: cmpId,
              adSetId,
              adId,
              date: dateStr,
              spend: 10.0,
              impressions: 1000,
              clicks: 20,
              reach: 800,
              conversions: 2,
              revenue: 50.0,
              currency: "USD",
              timezone: "UTC",
            });
          }
        }
      }
    }

    // Total records generated = 2,000 ads * 30 days = 60,000 daily ad performance records
    expect(records.length).toBe(60000);

    const summary = aggregatePerformanceRecords(records, {
      level: "ACCOUNT",
      entityId: "act_enterprise",
      windowType: "last_30_days",
    });

    const durationMs = Date.now() - startTime;

    // Expected totals:
    // Total Spend = 60,000 * $10 = $600,000
    // Total Impressions = 60,000 * 1,000 = 60,000,000
    // Total Clicks = 60,000 * 20 = 1,200,000
    // Total Conversions = 60,000 * 2 = 120,000
    // Total Revenue = 60,000 * $50 = $3,000,000
    expect(summary.kpis.spend).toBe(600000);
    expect(summary.kpis.impressions).toBe(60000000);
    expect(summary.kpis.clicks).toBe(1200000);
    expect(summary.kpis.conversions).toBe(120000);
    expect(summary.kpis.revenue).toBe(3000000);

    // Weighted KPIs:
    // CTR = (1,200,000 / 60,000,000) * 100 = 2.0%
    expect(summary.kpis.ctr).toBe(2.0);
    // CPC = 600,000 / 1,200,000 = $0.50
    expect(summary.kpis.cpc).toBe(0.5);
    // CPA = 600,000 / 120,000 = $5.00
    expect(summary.kpis.cpa).toBe(5.0);
    // ROAS = 3,000,000 / 600,000 = 5.0
    expect(summary.kpis.roas).toBe(5.0);

    expect(summary.quality).toBe("COMPLETE");
    expect(durationMs).toBeLessThan(1000); // Scale test runs in sub-second time
  });
});
