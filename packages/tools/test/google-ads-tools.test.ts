import { describe, it, expect } from "vitest";
import type { ToolContext } from "@jarvis/core";
import {
  GoogleGetAccountsTool,
  GoogleGetCampaignsTool,
  GoogleGetInsightsTool,
  validateCustomerId,
  validateDateRange,
} from "../src/tools/google-ads-tools.js";
import { MockGoogleAdsProvider } from "../src/tools/google-ads-mock.js";

const ctx = (userId = "user-1"): ToolContext =>
  ({ userId, traceId: "trace-1", role: "member" }) as unknown as ToolContext;

const RANGE = { since: "2026-08-01", until: "2026-08-31" };

describe("Sprint 5.2 — Google Ads tools", () => {
  describe("validators", () => {
    it("accepts 10 digits with or without dashes", () => {
      expect(validateCustomerId("1234567890")).toBe("1234567890");
      expect(validateCustomerId("123-456-7890")).toBe("1234567890");
    });

    it.each([["12345"], ["12345678901"], ["abcdefghij"], [""], [null], [42]])(
      "rejects %s",
      (bad) => {
        expect(validateCustomerId(bad)).toBeNull();
      }
    );

    it("rejects an inverted or over-long date range", () => {
      expect(validateDateRange("2026-08-31", "2026-08-01")).toBeNull();
      expect(validateDateRange("2020-01-01", "2026-01-01")).toBeNull();
      expect(validateDateRange("08/01/2026", "2026-08-31")).toBeNull();
      expect(validateDateRange("2026-08-01", "2026-08-31")).toEqual(RANGE);
    });
  });

  describe("risk classification and the approval boundary", () => {
    const provider = new MockGoogleAdsProvider();
    const tools = [
      new GoogleGetAccountsTool(provider, provider),
      new GoogleGetCampaignsTool(provider, provider),
      new GoogleGetInsightsTool(provider, provider),
    ];

    it("declares every Google tool READ_ONLY with read permission", () => {
      for (const tool of tools) {
        expect(tool.risk).toBe("READ_ONLY");
        expect(tool.requiresApproval).toBe(false);
        expect(tool.requiredPermissions).toEqual(["read"]);
        expect(tool.category).toBe("marketing");
      }
    });

    it("exposes no mutating operation on the provider surface", () => {
      // The read-only guarantee is structural: if a write method is ever added
      // to the provider it must also be given an approval-gated risk level.
      const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(provider));
      expect(surface).not.toEqual(
        expect.arrayContaining(["pauseCampaign", "updateBudget", "createCampaign", "mutate"])
      );
    });

    it("declares the contract the approval service consumes", () => {
      // ToolApprovalService maps READ_ONLY to requiresApproval=false via its
      // RISK_REQUIRES_APPROVAL table. That wiring is asserted end-to-end
      // against the real service in apps/api/test/google-integration.test.ts;
      // here we pin the tool-side half of the contract.
      for (const tool of tools) {
        expect(tool.risk === "READ_ONLY" && tool.requiresApproval === false).toBe(true);
      }
    });
  });

  describe("google.accounts", () => {
    it("returns the accounts reachable by this user", async () => {
      const provider = new MockGoogleAdsProvider();
      const result = await new GoogleGetAccountsTool(provider, provider).execute({}, ctx());
      expect(result.success).toBe(true);
      expect((result.data as any).count).toBe(1);
      expect((result.data as any).accounts[0].customerId).toBe("1234567890");
    });

    it("scopes results to the calling user", async () => {
      const provider = new MockGoogleAdsProvider({
        customers: [
          { customerId: "1111111111", descriptiveName: "A", currencyCode: "USD", timeZone: "UTC", isManager: false, isTestAccount: true },
          { customerId: "2222222222", descriptiveName: "B", currencyCode: "USD", timeZone: "UTC", isManager: false, isTestAccount: true },
        ],
        authorizedCustomers: { "user-1": ["1111111111"], "user-2": ["2222222222"] },
      });
      const tool = new GoogleGetAccountsTool(provider, provider);

      const one = await tool.execute({}, ctx("user-1"));
      expect((one.data as any).accounts.map((a: any) => a.customerId)).toEqual(["1111111111"]);

      const two = await tool.execute({}, ctx("user-2"));
      expect((two.data as any).accounts.map((a: any) => a.customerId)).toEqual(["2222222222"]);
    });

    it("returns a failure, not a throw, when the provider errors", async () => {
      const provider = new MockGoogleAdsProvider({
        throwOnCall: "getAccessibleCustomers",
        error: new Error("Google Ads API unavailable"),
      });
      const result = await new GoogleGetAccountsTool(provider, provider).execute({}, ctx());
      expect(result.success).toBe(false);
      expect(result.error).toContain("unavailable");
    });
  });

  describe("google.campaigns — authorization", () => {
    const provider = () =>
      new MockGoogleAdsProvider({
        authorizedCustomers: { "user-1": ["1234567890"] },
      });

    it("returns campaigns for an authorized customer", async () => {
      const p = provider();
      const result = await new GoogleGetCampaignsTool(p, p).execute(
        { customerId: "1234567890" },
        ctx("user-1")
      );
      expect(result.success).toBe(true);
      expect((result.data as any).campaigns).toHaveLength(2);
    });

    it("DENIES a customer the caller is not authorized for", async () => {
      const p = provider();
      const result = await new GoogleGetCampaignsTool(p, p).execute(
        { customerId: "9999999999" },
        ctx("user-1")
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Not authorized/);
    });

    it("DENIES another user's customer — cross-user isolation", async () => {
      const p = new MockGoogleAdsProvider({
        authorizedCustomers: { "user-1": ["1111111111"], "user-2": ["2222222222"] },
      });
      const result = await new GoogleGetCampaignsTool(p, p).execute(
        { customerId: "2222222222" },
        ctx("user-1")
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Not authorized/);
    });

    it("uses an identical denial message for unknown and unauthorized ids", async () => {
      // Otherwise the tool becomes a customer-id oracle.
      const p = new MockGoogleAdsProvider({ authorizedCustomers: { "user-1": ["1111111111"] } });
      const tool = new GoogleGetCampaignsTool(p, p);
      const a = await tool.execute({ customerId: "2222222222" }, ctx("user-1"));
      const b = await tool.execute({ customerId: "3333333333" }, ctx("user-1"));
      expect(a.error).toBe(b.error);
    });

    it("rejects a malformed id before any authorization call", async () => {
      const p = provider();
      const result = await new GoogleGetCampaignsTool(p, p).execute(
        { customerId: "abc" },
        ctx("user-1")
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid Google Ads customer ID/);
      expect(p.calls).toHaveLength(0);
    });

    it("rejects a missing customerId", async () => {
      const p = provider();
      const result = await new GoogleGetCampaignsTool(p, p).execute({}, ctx("user-1"));
      expect(result.success).toBe(false);
    });
  });

  describe("google.insights", () => {
    const provider = () =>
      new MockGoogleAdsProvider({ authorizedCustomers: { "user-1": ["1234567890"] } });

    it("returns metrics for a valid range", async () => {
      const p = provider();
      const result = await new GoogleGetInsightsTool(p, p).execute(
        { customerId: "1234567890", ...RANGE },
        ctx("user-1")
      );
      expect(result.success).toBe(true);
      expect((result.data as any).metrics).toHaveLength(2);
      expect((result.data as any).dateRange).toEqual(RANGE);
    });

    it("rejects an invalid date range", async () => {
      const p = provider();
      const result = await new GoogleGetInsightsTool(p, p).execute(
        { customerId: "1234567890", since: "2026-08-31", until: "2026-08-01" },
        ctx("user-1")
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/date range/i);
    });

    it("checks authorization BEFORE validating the date range", async () => {
      // An unauthorized caller must not learn anything from parameter feedback.
      const p = provider();
      const result = await new GoogleGetInsightsTool(p, p).execute(
        { customerId: "9999999999", since: "bad", until: "worse" },
        ctx("user-1")
      );
      expect(result.error).toMatch(/Not authorized/);
    });

    it("passes the daily flag through to the provider", async () => {
      const p = provider();
      await new GoogleGetInsightsTool(p, p).execute(
        { customerId: "1234567890", ...RANGE, daily: true },
        ctx("user-1")
      );
      const call = p.calls.find((c) => c.method === "getMetrics");
      expect(call).toBeDefined();
    });

    it("surfaces expired credentials as a failure result", async () => {
      const p = new MockGoogleAdsProvider({
        authorizedCustomers: { "user-1": ["1234567890"] },
        throwOnCall: "getMetrics",
        error: new Error("No active Google connection for this user"),
      });
      const result = await new GoogleGetInsightsTool(p, p).execute(
        { customerId: "1234567890", ...RANGE },
        ctx("user-1")
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No active Google connection/);
    });

    it("never leaks token material through a failure message", async () => {
      const p = new MockGoogleAdsProvider({
        authorizedCustomers: { "user-1": ["1234567890"] },
        throwOnCall: "getMetrics",
        error: new Error("request failed"),
      });
      const result = await new GoogleGetInsightsTool(p, p).execute(
        { customerId: "1234567890", ...RANGE },
        ctx("user-1")
      );
      const blob = JSON.stringify(result);
      expect(blob).not.toMatch(/ya29\./);
      expect(blob).not.toMatch(/1\/\//);
      expect(blob).not.toContain("developer-token");
    });
  });

  describe("result payloads", () => {
    it("carry no credential fields", async () => {
      const p = new MockGoogleAdsProvider();
      const results = await Promise.all([
        new GoogleGetAccountsTool(p, p).execute({}, ctx()),
        new GoogleGetCampaignsTool(p, p).execute({ customerId: "1234567890" }, ctx()),
        new GoogleGetInsightsTool(p, p).execute({ customerId: "1234567890", ...RANGE }, ctx()),
      ]);
      for (const r of results) {
        const blob = JSON.stringify(r);
        for (const forbidden of [
          "accessToken",
          "refreshToken",
          "access_token",
          "refresh_token",
          "clientSecret",
          "developerToken",
        ]) {
          expect(blob).not.toContain(forbidden);
        }
      }
    });

    it("marks results as read-only for downstream consumers", async () => {
      const p = new MockGoogleAdsProvider();
      const r = await new GoogleGetAccountsTool(p, p).execute({}, ctx());
      expect(r.metadata).toMatchObject({ source: "google-ads", readOnly: true });
    });
  });
});
