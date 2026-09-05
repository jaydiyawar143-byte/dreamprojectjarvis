import { describe, it, expect, vi } from "vitest";
import type { IGoogleConnectionRepository, GoogleCredentials } from "@jarvis/core";
import { GoogleAdsGraphProvider } from "../src/provider.js";
import { createGoogleConfig } from "../src/config.js";
import { classifyGoogleError, redactSensitiveInfo } from "../src/error-handler.js";
import { microsToDecimal, parseCampaign, parseMetrics, parseCustomer, extractRows } from "../src/response-validator.js";
import type { GoogleAdsHttpClient } from "../src/client.js";
import type { FetchLike } from "../src/oauth.js";

const config = createGoogleConfig({
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "https://jarvis.test/cb",
  developerToken: "devtoken",
  loginCustomerId: "9999999999",
  timeoutMs: 1000,
});

/** In-memory connection repo — no database, no real tokens. */
function makeConnections(initial?: Partial<GoogleCredentials>): IGoogleConnectionRepository & {
  creds: GoogleCredentials | null;
  updates: { accessToken: string; expiresAt: Date }[];
} {
  const state = {
    creds: initial
      ? {
          accessToken: initial.accessToken ?? "ya29.valid",
          refreshToken: initial.refreshToken ?? "1//refresh",
          expiresAt: initial.expiresAt ?? new Date(Date.now() + 3_600_000),
          scopes: initial.scopes ?? ["https://www.googleapis.com/auth/adwords"],
        }
      : null,
    updates: [] as { accessToken: string; expiresAt: Date }[],
  };
  return {
    ...state,
    async save() {
      throw new Error("not used");
    },
    async findByUser() {
      return null;
    },
    async getCredentials() {
      return this.creds;
    },
    async updateAccessToken(_userId: string, accessToken: string, expiresAt: Date) {
      this.updates.push({ accessToken, expiresAt });
      if (this.creds) this.creds = { ...this.creds, accessToken, expiresAt };
    },
    async revoke() {
      this.creds = null;
    },
  } as any;
}

function makeHttp(status: number, body: unknown): GoogleAdsHttpClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    async search(req) {
      calls.push(req);
      return { status, body };
    },
  } as any;
}

const CAMPAIGN_ROWS = {
  results: [
    {
      campaign: {
        id: "111",
        name: "Search — Brand",
        status: "ENABLED",
        advertisingChannelType: "SEARCH",
        startDate: "2026-08-01",
      },
      campaignBudget: { amountMicros: "50000000" },
    },
  ],
};

describe("Sprint 5.2 — GoogleAdsGraphProvider", () => {
  describe("credential handling", () => {
    it("fails with AUTHENTICATION_REQUIRED when the user has no connection", async () => {
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections(),
        httpClient: makeHttp(200, CAMPAIGN_ROWS),
      });
      await expect(provider.getCampaigns("user-1", "1234567890")).rejects.toThrow(
        /No active Google connection/
      );
    });

    it("sends the stored access token as a bearer credential", async () => {
      const http = makeHttp(200, CAMPAIGN_ROWS);
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections({ accessToken: "ya29.stored" }),
        httpClient: http,
      });
      await provider.getCampaigns("user-1", "1234567890");
      expect(http.calls[0].accessToken).toBe("ya29.stored");
    });

    it("refreshes an expired access token and persists the new one", async () => {
      const connections = makeConnections({
        accessToken: "ya29.expired",
        expiresAt: new Date(Date.now() - 1000), // already expired
      });
      const fetchImpl: FetchLike = async () => ({
        status: 200,
        text: async () => JSON.stringify({ access_token: "ya29.refreshed", expires_in: 3600 }),
      });
      const http = makeHttp(200, CAMPAIGN_ROWS);

      const provider = new GoogleAdsGraphProvider({ config, connections, httpClient: http, fetchImpl });
      await provider.getCampaigns("user-1", "1234567890");

      expect(connections.updates).toHaveLength(1);
      expect(connections.updates[0].accessToken).toBe("ya29.refreshed");
      // The refreshed token, not the stale one, reached the API.
      expect(http.calls[0].accessToken).toBe("ya29.refreshed");
    });

    it("refreshes proactively inside the expiry skew window", async () => {
      const connections = makeConnections({
        accessToken: "ya29.nearly",
        expiresAt: new Date(Date.now() + 30_000), // inside the 60s skew
      });
      const fetchImpl: FetchLike = async () => ({
        status: 200,
        text: async () => JSON.stringify({ access_token: "ya29.rotated", expires_in: 3600 }),
      });
      const provider = new GoogleAdsGraphProvider({
        config,
        connections,
        httpClient: makeHttp(200, CAMPAIGN_ROWS),
        fetchImpl,
      });
      await provider.getCampaigns("user-1", "1234567890");
      expect(connections.updates[0].accessToken).toBe("ya29.rotated");
    });

    it("does not refresh a token that is still comfortably valid", async () => {
      const connections = makeConnections({ expiresAt: new Date(Date.now() + 3_600_000) });
      const fetchImpl = vi.fn();
      const provider = new GoogleAdsGraphProvider({
        config,
        connections,
        httpClient: makeHttp(200, CAMPAIGN_ROWS),
        fetchImpl: fetchImpl as unknown as FetchLike,
      });
      await provider.getCampaigns("user-1", "1234567890");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(connections.updates).toHaveLength(0);
    });

    it("surfaces a revoked refresh token as an authentication failure", async () => {
      const connections = makeConnections({ expiresAt: new Date(Date.now() - 1000) });
      const fetchImpl: FetchLike = async () => ({
        status: 400,
        text: async () => JSON.stringify({ error: "invalid_grant" }),
      });
      const provider = new GoogleAdsGraphProvider({
        config,
        connections,
        httpClient: makeHttp(200, CAMPAIGN_ROWS),
        fetchImpl,
      });
      await expect(provider.getCampaigns("user-1", "1234567890")).rejects.toThrow();
    });
  });

  describe("authorization", () => {
    it("authorizes a customer reachable through the connection", async () => {
      const http = makeHttp(200, {
        results: [{ customerClient: { id: "1234567890", descriptiveName: "Acct", currencyCode: "USD" } }],
      });
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections({}),
        httpClient: http,
      });
      expect(await provider.isAuthorized("user-1", "1234567890")).toBe(true);
      expect(await provider.isAuthorized("user-1", "123-456-7890")).toBe(true);
    });

    it("denies a customer the connection cannot reach", async () => {
      const http = makeHttp(200, { results: [{ customerClient: { id: "1234567890" } }] });
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections({}),
        httpClient: http,
      });
      expect(await provider.isAuthorized("user-1", "9876543210")).toBe(false);
    });

    it("denies a malformed customer id without calling the API", async () => {
      const http = makeHttp(200, { results: [] });
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections({}),
        httpClient: http,
      });
      expect(await provider.isAuthorized("user-1", "not-an-id")).toBe(false);
      expect(http.calls).toHaveLength(0);
    });
  });

  describe("API errors", () => {
    it.each([
      [401, { error: { status: "UNAUTHENTICATED", message: "bad token" } }, /bad token/],
      [403, { error: { status: "PERMISSION_DENIED", message: "no access" } }, /no access/],
      [429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }, /quota/],
      [500, { error: { status: "INTERNAL", message: "boom" } }, /boom/],
    ])("maps HTTP %i to a thrown JarvisError", async (status, body, match) => {
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections({}),
        httpClient: makeHttp(status as number, body),
      });
      await expect(provider.getCampaigns("user-1", "1234567890")).rejects.toThrow(match as RegExp);
    });

    it("rejects a malformed customer id before issuing a request", async () => {
      const http = makeHttp(200, CAMPAIGN_ROWS);
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections({}),
        httpClient: http,
      });
      await expect(provider.getCampaigns("user-1", "12345")).rejects.toThrow(/customer ID/i);
      expect(http.calls).toHaveLength(0);
    });

    it("rejects a malformed date range before issuing a request", async () => {
      const http = makeHttp(200, { results: [] });
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections({}),
        httpClient: http,
      });
      await expect(
        provider.getMetrics("user-1", "1234567890", { since: "08/01/2026", until: "2026-08-31" })
      ).rejects.toThrow(/YYYY-MM-DD/);
      expect(http.calls).toHaveLength(0);
    });
  });

  describe("read operations", () => {
    it("parses campaigns and converts budget micros", async () => {
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections({}),
        httpClient: makeHttp(200, CAMPAIGN_ROWS),
      });
      const campaigns = await provider.getCampaigns("user-1", "1234567890");
      expect(campaigns).toHaveLength(1);
      expect(campaigns[0].campaignId).toBe("111");
      expect(campaigns[0].status).toBe("ENABLED");
      expect(campaigns[0].budgetAmount).toBe("50.00");
    });

    it("builds a GAQL query bounded by the requested dates", async () => {
      const http = makeHttp(200, { results: [] });
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections({}),
        httpClient: http,
      });
      await provider.getMetrics("user-1", "1234567890", {
        since: "2026-08-01",
        until: "2026-08-31",
      });
      const query: string = http.calls[0].query;
      expect(query).toContain("BETWEEN '2026-08-01' AND '2026-08-31'");
      expect(query.startsWith("SELECT")).toBe(true);
      // Read-only: no mutation verb can appear in a provider query.
      expect(query).not.toMatch(/\b(INSERT|UPDATE|DELETE|MUTATE)\b/i);
    });

    it("adds date segmentation only when daily is requested", async () => {
      const http = makeHttp(200, { results: [] });
      const provider = new GoogleAdsGraphProvider({
        config,
        connections: makeConnections({}),
        httpClient: http,
      });
      await provider.getMetrics("user-1", "1234567890", { since: "2026-08-01", until: "2026-08-02" });
      expect(http.calls[0].query).not.toContain("segments.date,");

      await provider.getMetrics(
        "user-1",
        "1234567890",
        { since: "2026-08-01", until: "2026-08-02" },
        { daily: true }
      );
      expect(http.calls[1].query).toContain("segments.date");
    });
  });
});

describe("Sprint 5.2 — response parsing", () => {
  it("converts micros to a decimal string", () => {
    expect(microsToDecimal("12340000")).toBe("12.34");
    expect(microsToDecimal(1_000_000)).toBe("1.00");
    expect(microsToDecimal(undefined)).toBe("0.00");
    expect(microsToDecimal("not-a-number")).toBe("0.00");
  });

  it("does not treat micros as whole currency units", () => {
    // The bug this guards: 240000000 micros is 240.00, not 240000000.
    const metrics = parseMetrics({ metrics: { costMicros: "240000000" } });
    expect(metrics.cost).toBe("240.00");
  });

  it("parses int64-as-string metrics without precision loss", () => {
    const m = parseMetrics({ metrics: { impressions: "12000", clicks: "480" } });
    expect(m.impressions).toBe(12000);
    expect(m.clicks).toBe(480);
  });

  it("derives ctr when Google omits it, without dividing by zero", () => {
    expect(parseMetrics({ metrics: { impressions: "0", clicks: "0" } }).ctr).toBe(0);
    expect(parseMetrics({ metrics: { impressions: "100", clicks: "5" } }).ctr).toBeCloseTo(0.05);
  });

  it("maps an unrecognised campaign status to UNKNOWN rather than trusting it", () => {
    expect(parseCampaign({ campaign: { status: "SOMETHING_NEW" } }).status).toBe("UNKNOWN");
  });

  it("falls back to the resourceName tail for a customer id", () => {
    expect(parseCustomer({ resourceName: "customers/1234567890" }).customerId).toBe("1234567890");
  });

  it("extracts rows from both search and searchStream shapes", () => {
    expect(extractRows({ results: [1, 2] })).toHaveLength(2);
    expect(extractRows([{ results: [1] }, { results: [2, 3] }])).toHaveLength(3);
    expect(extractRows({})).toHaveLength(0);
  });
});

describe("Sprint 5.2 — error redaction", () => {
  it("redacts access tokens from messages", () => {
    const out = redactSensitiveInfo("failed for ya29.a0AfH6SMBxxxxxxxxxxxx here");
    expect(out).not.toContain("ya29.a0AfH6SMBxxxxxxxxxxxx");
    expect(out).toContain("[REDACTED_TOKEN]");
  });

  it("redacts refresh tokens", () => {
    const out = redactSensitiveInfo("refresh 1//04abcdEFGHijkl-_ failed");
    expect(out).not.toContain("1//04abcdEFGHijkl");
  });

  it("redacts bearer headers and named secrets", () => {
    expect(redactSensitiveInfo("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redactSensitiveInfo('client_secret="hunter2"')).not.toContain("hunter2");
  });

  it("classification passes messages through the redactor", () => {
    const classified = classifyGoogleError(401, {
      error: { message: "token ya29.SECRETVALUE123456 rejected", status: "UNAUTHENTICATED" },
    });
    expect(classified.message).not.toContain("ya29.SECRETVALUE123456");
    expect(classified.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("marks quota and outage as retryable but auth as not", () => {
    expect(classifyGoogleError(429, {}).retryable).toBe(true);
    expect(classifyGoogleError(503, {}).retryable).toBe(true);
    expect(classifyGoogleError(401, {}).retryable).toBe(false);
    expect(classifyGoogleError(403, {}).retryable).toBe(false);
  });
});
