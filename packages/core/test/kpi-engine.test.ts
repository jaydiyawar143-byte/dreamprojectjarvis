import { describe, it, expect } from "vitest";
import { calculateCanonicalKPIs, parseNumericValue } from "../src/kpi-engine.js";

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
