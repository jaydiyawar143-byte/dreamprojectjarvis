// ---------------------------------------------------------------------------
// Who chooses the date range for a Meta insights call.
//
// THE DEFECT. `startDate` and `endDate` were `required: true`, so the model had
// to supply them — and a language model does not know what day it is. Asked
// "mere Meta campaigns ke insights batao" on 2026-09-13, it called the tool
// with 2023-10-01 to 2023-10-21: a window out of its training era. Meta
// returned zero rows, and the assistant reported "no insights available for
// your Meta campaigns" as though that were a finding about the ads.
//
// It is worth being precise about why that is the worst possible failure shape.
// Nothing errored. Every layer did its job. The user was simply told, with
// confidence and supporting reasoning, that their campaigns had no data — when
// what had actually happened is that nobody knew the date.
//
// So the range is resolved on the SERVER now, and these tests pin the three
// things that have to stay true: the default is applied, an explicit range is
// untouched, and the answer can always tell which of the two it got.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { MetaGetInsightsTool } from "../src/tools/meta-ads-tools.js";
import {
  resolveInsightsDateRange,
  DEFAULT_INSIGHTS_RANGE_DAYS,
} from "../src/tools/meta-ads-validators.js";
import { createMockMetaProvider, createEmptyMetaProvider } from "../src/tools/meta-ads-mock.js";
import type { MetaAccountAuthorizer } from "../src/tools/meta-ads-provider.js";

const ACCOUNT = "act_111111111";

function authorizer(accounts: string[] = [ACCOUNT]): MetaAccountAuthorizer {
  return {
    getAuthorizedAccountIds: vi.fn().mockResolvedValue(accounts),
    isAuthorized: vi.fn().mockImplementation(async (_u: string, a: string) => accounts.includes(a)),
  };
}

const ctx = { userId: "user-1", conversationId: "c-1", traceId: "t-1" };

describe("the server resolves the date range, not the model", () => {
  it("defaults to the last seven days when the user named no window", () => {
    const resolved = resolveInsightsDateRange({}, new Date("2026-09-13T10:00:00Z"));

    expect(resolved.source).toBe("default-last-7-days");
    // Inclusive of today: 7 days is today plus the six before it.
    expect(resolved.start).toBe("2026-09-07");
    expect(resolved.end).toBe("2026-09-13");
  });

  it("spans exactly the configured number of days", () => {
    const resolved = resolveInsightsDateRange({}, new Date("2026-01-15T00:00:00Z"));
    const days =
      (Date.parse(resolved.end) - Date.parse(resolved.start)) / 86_400_000 + 1;

    expect(days).toBe(DEFAULT_INSIGHTS_RANGE_DAYS);
  });

  it("crosses a month boundary correctly", () => {
    const resolved = resolveInsightsDateRange({}, new Date("2026-03-03T12:00:00Z"));

    expect(resolved.start).toBe("2026-02-25");
    expect(resolved.end).toBe("2026-03-03");
  });

  it("respects an explicit range exactly, without adjusting it", () => {
    const resolved = resolveInsightsDateRange(
      { startDate: "2026-08-01", endDate: "2026-08-31" },
      new Date("2026-09-13T10:00:00Z")
    );

    expect(resolved.source).toBe("explicit");
    expect(resolved.start).toBe("2026-08-01");
    expect(resolved.end).toBe("2026-08-31");
  });

  it("defaults when only one half of the range was supplied", () => {
    // A half-specified range is a guess in progress. Completing it from the
    // model's other half would reintroduce exactly the invented date.
    const resolved = resolveInsightsDateRange(
      { startDate: "2023-10-01" },
      new Date("2026-09-13T10:00:00Z")
    );

    expect(resolved.source).toBe("default-last-7-days");
    expect(resolved.start).toBe("2026-09-07");
  });

  it("carries a spoken label naming the window", () => {
    const resolved = resolveInsightsDateRange({}, new Date("2026-09-13T10:00:00Z"));

    expect(resolved.label).toMatch(/last 7 days/i);
    expect(resolved.label).toContain("2026-09-07");
  });
});

describe("the insights tool applies the default end to end", () => {
  it("accepts a call with no dates at all", async () => {
    const tool = new MetaGetInsightsTool(createMockMetaProvider(), authorizer());

    expect(tool.validate({ accountId: ACCOUNT })).toBe(true);
  });

  it("executes with no dates and reports the range it chose", async () => {
    const tool = new MetaGetInsightsTool(createMockMetaProvider(), authorizer());

    const result = await tool.execute({ accountId: ACCOUNT }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, any>;
    expect(data.dateRangeSource).toBe("default-last-7-days");
    expect(data.dateRange.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.dateRangeLabel).toMatch(/last 7 days/i);
  });

  it("passes an explicit range through to the provider unchanged", async () => {
    const provider = createMockMetaProvider();
    const spy = vi.spyOn(provider, "getInsights");
    const tool = new MetaGetInsightsTool(provider, authorizer());

    await tool.execute(
      { accountId: ACCOUNT, startDate: "2026-08-01", endDate: "2026-08-15" },
      ctx
    );

    expect(spy.mock.calls[0]![1]).toEqual({ start: "2026-08-01", end: "2026-08-15" });
  });

  it("never asks the provider for a range the caller did not choose", async () => {
    const provider = createMockMetaProvider();
    const spy = vi.spyOn(provider, "getInsights");
    const tool = new MetaGetInsightsTool(provider, authorizer());

    await tool.execute({ accountId: ACCOUNT }, ctx);

    const range = spy.mock.calls[0]![1] as { start: string; end: string };
    // The regression that started all of this.
    expect(range.start.startsWith("2023")).toBe(false);
    expect(Date.parse(range.end)).toBeGreaterThan(Date.parse("2026-01-01"));
  });
});

describe("an empty result is not a failure, and the difference survives", () => {
  it("marks a successful call that returned no rows as EMPTY_RESULT", async () => {
    const tool = new MetaGetInsightsTool(createEmptyMetaProvider(), authorizer());

    const result = await tool.execute({ accountId: ACCOUNT }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, any>;
    expect(data.dataAvailability).toBe("EMPTY_RESULT");
    expect(data.count).toBe(0);
  });

  it("marks a call that returned rows as DATA_RETURNED", async () => {
    const tool = new MetaGetInsightsTool(createMockMetaProvider(), authorizer());

    const result = await tool.execute({ accountId: ACCOUNT }, ctx);
    const data = result.data as Record<string, any>;

    expect(data.dataAvailability).toBe("DATA_RETURNED");
    expect(data.count).toBeGreaterThan(0);
  });

  it("fails loudly when the provider throws, with no fabricated metrics", async () => {
    const provider = createMockMetaProvider();
    vi.spyOn(provider, "getInsights").mockRejectedValue(new Error("Meta API unavailable"));
    const tool = new MetaGetInsightsTool(provider, authorizer());

    const result = await tool.execute({ accountId: ACCOUNT }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Meta API error/i);
    // No numbers invented to fill the gap.
    expect(JSON.stringify(result.data ?? {})).not.toMatch(/spend|impressions|ctr/i);
  });

  it("refuses an account the user is not authorized for", async () => {
    const tool = new MetaGetInsightsTool(createMockMetaProvider(), authorizer([]));

    const result = await tool.execute({ accountId: ACCOUNT }, ctx);

    expect(result.success).toBe(false);
  });
});
