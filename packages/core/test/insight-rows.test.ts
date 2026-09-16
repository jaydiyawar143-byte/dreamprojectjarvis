import { describe, it, expect } from "vitest";
import {
  normalizeInsightRows,
  type InsightRowSelection,
} from "../src/insight-rows.js";

const BASE = {
  spend: "100",
  impressions: "10000",
  clicks: "500",
  reach: "8000",
  conversions: "20",
  roas: "4.5",
  dateStart: "2026-08-16",
  dateStop: "2026-08-16",
  campaignId: "cmp_123",
  adsetId: "adset_2",
  adId: "ad_3",
};

function selection(
  overrides: Partial<InsightRowSelection> = {}
): InsightRowSelection {
  return {
    accountId: "act_1",
    entityType: "CAMPAIGN",
    entityId: "cmp_123",
    startDate: "2026-08-16",
    endDate: "2026-08-20",
    currency: "USD",
    timezone: "UTC",
    ...overrides,
  };
}

describe("normalizeInsightRows (R-32)", () => {
  it("keeps only the rows of the selected entity at CAMPAIGN level", () => {
    const other = { ...BASE, campaignId: "cmp_OTHER" };
    const rows = normalizeInsightRows(
      [{ ...BASE, campaignId: "cmp_123" }, other],
      selection()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.campaignId).toBe("cmp_123");
  });

  it("filters by adSetId at AD_SET level and adId at AD level", () => {
    const rows = normalizeInsightRows([BASE], selection({ entityType: "AD_SET", entityId: "adset_2" }));
    expect(rows).toHaveLength(1);

    const none = normalizeInsightRows([BASE], selection({ entityType: "AD_SET", entityId: "adset_MISSING" }));
    expect(none).toHaveLength(0);

    const adRows = normalizeInsightRows([BASE], selection({ entityType: "AD", entityId: "ad_3" }));
    expect(adRows).toHaveLength(1);
  });

  it("keeps every row in the account at ACCOUNT level", () => {
    const rows = normalizeInsightRows(
      [
        { ...BASE, campaignId: "cmp_a", dateStart: "2026-08-17" },
        { ...BASE, campaignId: "cmp_b", dateStart: "2026-08-18" },
      ],
      selection({ entityType: "ACCOUNT", entityId: "" })
    );
    expect(rows).toHaveLength(2);
  });

  it("applies the date window inclusively", () => {
    const inside = { ...BASE, dateStart: "2026-08-18" };
    const boundaryStart = { ...BASE, dateStart: "2026-08-16" };
    const boundaryEnd = { ...BASE, dateStart: "2026-08-20" };
    const outsideHigh = { ...BASE, dateStart: "2026-08-21" };
    const outsideLow = { ...BASE, dateStart: "2026-08-15" };
    const rows = normalizeInsightRows(
      [inside, boundaryStart, boundaryEnd, outsideHigh, outsideLow],
      selection()
    );
    expect(rows).toHaveLength(3);
  });

  it("coerces provider strings to numbers and derives revenue = roas * spend", () => {
    const rows = normalizeInsightRows([BASE], selection());
    expect(rows[0]).toMatchObject({
      accountId: "act_1",
      spend: 100,
      impressions: 10000,
      clicks: 500,
      reach: 8000,
      conversions: 20,
    });
    expect(rows[0]!.revenue).toBe(4.5 * 100);
    expect(rows[0]!.currency).toBe("USD");
    expect(rows[0]!.timezone).toBe("UTC");
  });

  it("treats a missing per-day value as zero, exactly like the old worker inline rule", () => {
    const row = { ...BASE, spend: null, clicks: undefined, roas: null };
    const rows = normalizeInsightRows([row], selection());
    expect(rows[0]!.spend).toBe(0);
    expect(rows[0]!.clicks).toBe(0);
    expect(rows[0]!.revenue).toBe(0);
  });

  it("returns rows sorted by ascending date", () => {
    const rows = normalizeInsightRows(
      [
        { ...BASE, dateStart: "2026-08-19" },
        { ...BASE, dateStart: "2026-08-16" },
        { ...BASE, dateStart: "2026-08-18" },
      ],
      selection()
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-08-16", "2026-08-18", "2026-08-19"]);
  });
});