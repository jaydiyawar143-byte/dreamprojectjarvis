import { describe, it, expect } from "vitest";
import { parseInsights } from "../src/response-validator.js";

describe("parseInsights", () => {
  it("parses basic metric fields correctly", () => {
    const raw = {
      impressions: "1000",
      clicks: "50",
      spend: "100.50",
      reach: "800",
      cpc: "2.01",
      cpm: "100.50",
      ctr: "5.0",
      date_start: "2026-08-01",
      date_stop: "2026-08-07",
    };

    const parsed = parseInsights(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.impressions).toBe("1000");
    expect(parsed?.clicks).toBe("50");
    expect(parsed?.spend).toBe("100.50");
    expect(parsed?.reach).toBe("800");
    expect(parsed?.cpc).toBe("2.01");
    expect(parsed?.cpm).toBe("100.50");
    expect(parsed?.ctr).toBe("5.0");
    expect(parsed?.dateStart).toBe("2026-08-01");
    expect(parsed?.dateStop).toBe("2026-08-07");
  });

  it("parses conversions, roas, frequency, actions, and actionValues", () => {
    const raw = {
      impressions: "5000",
      clicks: "250",
      spend: "500.00",
      reach: "3000",
      frequency: "1.67",
      cost_per_conversion: "25.00",
      conversions: "20",
      purchase_roas: [{ action_type: "purchase", value: "3.5" }],
      actions: [
        { action_type: "purchase", value: "20" },
        { action_type: "link_click", value: "220" },
      ],
      action_values: [
        { action_type: "purchase", value: "1750.00" },
      ],
      account_id: "act_12345",
      campaignId: "cmp_999",
    };

    const parsed = parseInsights(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.frequency).toBe("1.67");
    expect(parsed?.conversions).toBe("20");
    expect(parsed?.costPerConversion).toBe("25.00");
    expect(parsed?.roas).toBe("3.5");
    expect(parsed?.actions).toHaveLength(2);
    expect(parsed?.actionValues).toHaveLength(1);
    expect(parsed?.accountId).toBe("act_12345");
  });

  it("extracts conversions from purchase actions if explicit conversions field is missing", () => {
    const raw = {
      impressions: "2000",
      clicks: "100",
      spend: "200.00",
      actions: [
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "8" },
      ],
    };

    const parsed = parseInsights(raw);
    expect(parsed?.conversions).toBe("8");
  });

  it("returns null for non-object data", () => {
    expect(parseInsights(null)).toBeNull();
    expect(parseInsights(undefined)).toBeNull();
    expect(parseInsights("string")).toBeNull();
  });
});
