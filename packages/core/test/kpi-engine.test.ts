import { describe, it, expect } from "vitest";
import {
  baselineKpisFromEvidence,
  calculateCanonicalKPIs,
  parseNumericValue,
} from "../src/kpi-engine.js";

describe("KPI Engine — parseNumericValue", () => {
  it("parses numbers, numeric strings, and edge cases", () => {
    expect(parseNumericValue(100)).toBe(100);
    expect(parseNumericValue("250.50")).toBe(250.5);
    expect(parseNumericValue(" 40.2 ")).toBe(40.2);
    expect(parseNumericValue(null)).toBe(0);
    expect(parseNumericValue(undefined)).toBe(0);
    expect(parseNumericValue(-50)).toBe(0);
    expect(parseNumericValue("invalid")).toBe(0);
  });
});

describe("KPI Engine — calculateCanonicalKPIs", () => {
  it("calculates all KPIs accurately for valid positive metrics", () => {
    const res = calculateCanonicalKPIs({
      spend: "500.00",
      impressions: "50000",
      clicks: "1000",
      reach: "25000",
      conversions: "50",
      revenue: "2500.00",
    });

    expect(res.spend).toBe(500);
    expect(res.impressions).toBe(50000);
    expect(res.clicks).toBe(1000);
    expect(res.reach).toBe(25000);
    expect(res.conversions).toBe(50);
    expect(res.revenue).toBe(2500);

    // CTR = (1000 / 50000) * 100 = 2.0%
    expect(res.ctr).toBe(2.0);
    // CPC = 500 / 1000 = $0.50
    expect(res.cpc).toBe(0.5);
    // CPM = (500 / 50000) * 1000 = $10.00
    expect(res.cpm).toBe(10);
    // CPA = 500 / 50 = $10.00
    expect(res.cpa).toBe(10);
    // ROAS = 2500 / 500 = 5.0
    expect(res.roas).toBe(5.0);
    // CVR = (50 / 1000) * 100 = 5.0%
    expect(res.cvr).toBe(5.0);
    // Frequency = 50000 / 25000 = 2.0
    expect(res.frequency).toBe(2.0);

    expect(res.isDefined.ctr).toBe(true);
    expect(res.isDefined.cpc).toBe(true);
    expect(res.isDefined.cpm).toBe(true);
    expect(res.isDefined.cpa).toBe(true);
    expect(res.isDefined.roas).toBe(true);
    expect(res.isDefined.cvr).toBe(true);
    expect(res.isDefined.frequency).toBe(true);
  });

  it("handles zero denominators gracefully by returning null", () => {
    const res = calculateCanonicalKPIs({
      spend: 0,
      impressions: 0,
      clicks: 0,
      reach: 0,
      conversions: 0,
      revenue: 0,
    });

    expect(res.ctr).toBeNull();
    expect(res.cpc).toBeNull();
    expect(res.cpm).toBeNull();
    expect(res.cpa).toBeNull();
    expect(res.roas).toBeNull();
    expect(res.cvr).toBeNull();
    expect(res.frequency).toBeNull();

    expect(res.isDefined.ctr).toBe(false);
    expect(res.isDefined.cpc).toBe(false);
    expect(res.isDefined.cpm).toBe(false);
    expect(res.isDefined.cpa).toBe(false);
    expect(res.isDefined.roas).toBe(false);
    expect(res.isDefined.cvr).toBe(false);
    expect(res.isDefined.frequency).toBe(false);
  });

  it("handles missing inputs (null/undefined) safely", () => {
    const res = calculateCanonicalKPIs({});
    expect(res.spend).toBe(0);
    expect(res.impressions).toBe(0);
    expect(res.clicks).toBe(0);
    expect(res.reach).toBe(0);
    expect(res.conversions).toBe(0);
    expect(res.revenue).toBe(0);
    expect(res.ctr).toBeNull();
  });
});

describe("KPI Engine — baselineKpisFromEvidence (R-32)", () => {
  const complete: Record<string, number | null> = {
    spend: 500,
    impressions: 50000,
    clicks: 1000,
    reach: 25000,
    conversions: 50,
    revenue: 2500,
    ctr: 2,
    cpc: 0.5,
    cpm: 10,
    cpa: 10,
    roas: 5,
    cvr: 5,
    frequency: 2,
  };

  it("accepts a complete evidence snapshot and passes values through untouched", () => {
    const res = baselineKpisFromEvidence(complete);
    expect(res).not.toBeNull();
    expect(res?.spend).toBe(500);
    expect(res?.impressions).toBe(50000);
    expect(res?.clicks).toBe(1000);
    expect(res?.reach).toBe(25000);
    expect(res?.conversions).toBe(50);
    expect(res?.revenue).toBe(2500);
    expect(res?.ctr).toBe(2);
    expect(res?.cpc).toBe(0.5);
    expect(res?.isDefined.ctr).toBe(true);
    expect(res?.isDefined.cpa).toBe(true);
  });

  it("refuses a missing required counter instead of zero-filling it", () => {
    const { spend: _dropped, ...missingSpend } = complete;
    expect(baselineKpisFromEvidence(missingSpend)).toBeNull();
  });

  it("refuses a null required counter instead of treating it as zero", () => {
    expect(baselineKpisFromEvidence({ ...complete, conversions: null })).toBeNull();
  });

  it("refuses a negative or non-finite required counter", () => {
    expect(baselineKpisFromEvidence({ ...complete, spend: -1 })).toBeNull();
    expect(baselineKpisFromEvidence({ ...complete, revenue: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("refuses an undefined/empty metrics map", () => {
    expect(baselineKpisFromEvidence(undefined)).toBeNull();
    expect(baselineKpisFromEvidence({})).toBeNull();
  });

  it("accepts null derived KPIs without inventing them from the counters", () => {
    // conversions present but cpa/cvr null in evidence: the record is created
    // with nulls — it is NOT recomputed out of spend/conversions.
    const res = baselineKpisFromEvidence({ ...complete, cpa: null, cvr: null });
    expect(res).not.toBeNull();
    expect(res?.cpa).toBeNull();
    expect(res?.cvr).toBeNull();
    expect(res?.isDefined.cpa).toBe(false);
    expect(res?.isDefined.cvr).toBe(false);
  });

  it("does not overwrite derived values the evidence actually reported", () => {
    // ctr is reported as 9.9 even though clicks/impressions would return 2.0.
    const res = baselineKpisFromEvidence({ ...complete, ctr: 9.9 });
    expect(res?.ctr).toBe(9.9);
  });

  it("uses only known derived keys; unknown metrics never leak onto the record", () => {
    const res = baselineKpisFromEvidence({ ...complete, brandLift: 99 });
    expect(res).toMatchObject({
      spend: 500,
      impressions: 50000,
      clicks: 1000,
      reach: 25000,
      conversions: 50,
      revenue: 2500,
    });
    expect(Object.keys(res ?? {}).sort()).toEqual(
      [
        "spend", "impressions", "clicks", "reach", "conversions", "revenue",
        "ctr", "cpc", "cpm", "cpa", "roas", "cvr", "frequency", "isDefined",
      ].sort()
    );
  });
});
