import { describe, it, expect, vi } from "vitest";
import { createMetaGraphProvider } from "../src/provider.js";
import type { MetaHttpClient, MetaHttpRequest, MetaHttpResponse } from "../src/client.js";
import { JarvisError } from "@jarvis/core";

// ===========================================================================
// Authorization layer tests (Phase 9.3-R fix)
//
// Scenario under test: Business Manager-owned ad accounts are accessible
// directly by ID but do NOT appear in /me/adaccounts. The provider must
// recognize them as authorized WITHOUT weakening security:
//   - /me/adaccounts remains the first discovery mechanism
//   - the direct-GET fallback applies ONLY to the server-configured account
//   - the direct response must be schema-valid and ID-exact
//   - 401/403/404/malformed responses are treated as unauthorized
// ===========================================================================

const TOKEN = "EAAfaketoken1234567890abcdef";
const CONFIGURED = "act_100";

type RouteTable = Record<string, { status: number; body: unknown }>;

function createMockClient(routes: RouteTable) {
  const calls: Array<{ method: string; path: string }> = [];
  const client = {
    async request(req: MetaHttpRequest): Promise<MetaHttpResponse> {
      calls.push({ method: req.method, path: req.path });
      const key = `${req.method} ${req.path}`;
      const route = routes[key];
      if (!route) {
        return { status: 404, body: { error: { message: `No mock for ${key}`, type: "GraphMethodException", code: 803 } } };
      }
      return { status: route.status, body: route.body };
    },
  };
  return { calls, client: client as unknown as MetaHttpClient & typeof client };
}

function makeProvider(routes: RouteTable) {
  const { calls, client } = createMockClient(routes);
  const provider = createMetaGraphProvider({
    accessToken: TOKEN,
    adAccountId: CONFIGURED,
    httpClient: client,
  });
  return { provider, calls };
}

const VALID_ACCOUNT_BODY = {
  id: CONFIGURED,
  name: "BM Account",
  currency: "USD",
  account_status: 1,
};

const VALID_CAMPAIGN_BODY = {
  id: "c1",
  name: "Camp",
  status: "PAUSED",
  objective: "OUTCOME_SALES",
};

// ---------------------------------------------------------------------------
// A. Account found via /me/adaccounts -> authorized
// ---------------------------------------------------------------------------
describe("A. discovery via /me/adaccounts", () => {
  it("authorizes an account listed in /me/adaccounts without fallback", async () => {
    const { provider, calls } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [{ id: CONFIGURED }, { id: "act_200" }] } },
    });

    await expect(provider.isAuthorized("user-1", CONFIGURED)).resolves.toBe(true);
    await expect(provider.getAuthorizedAccountIds("user-1")).resolves.toEqual([
      CONFIGURED,
      "act_200",
    ]);
    // No direct-account fallback request may have been made
    expect(calls.filter((c) => c.path === CONFIGURED && !c.path.includes("/"))).toHaveLength(0);
    expect(calls).toHaveLength(2); // 1x list per authorization call (isAuthorized + getAuthorizedAccountIds), 0x fallback
  });

  it("keeps write gate open for listed accounts (existing behavior)", async () => {
    const { provider, calls } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [{ id: CONFIGURED }] } },
      "POST c1": { status: 200, body: { id: "c1" } },
      "GET c1": { status: 200, body: VALID_CAMPAIGN_BODY },
    });

    const result = await provider.updateCampaignStatus(CONFIGURED, "c1", "PAUSED");
    expect(result.success).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. Missing from /me/adaccounts but direct GET succeeds -> authorized
// ---------------------------------------------------------------------------
describe("B. direct-account fallback for the configured account", () => {
  it("authorizes the configured BM account absent from /me/adaccounts", async () => {
    const { provider, calls } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      [`GET ${CONFIGURED}`]: { status: 200, body: VALID_ACCOUNT_BODY },
    });

    await expect(provider.isAuthorized("user-1", CONFIGURED)).resolves.toBe(true);
    expect(calls.some((c) => c.path === CONFIGURED)).toBe(true);
  });

  it("includes the verified configured account in getAuthorizedAccountIds", async () => {
    const { provider } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      [`GET ${CONFIGURED}`]: { status: 200, body: VALID_ACCOUNT_BODY },
    });

    await expect(provider.getAuthorizedAccountIds("user-1")).resolves.toEqual([CONFIGURED]);
  });

  it("opens the write gate for the configured BM account (pause flow reaches provider)", async () => {
    const { provider, calls } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      [`GET ${CONFIGURED}`]: { status: 200, body: VALID_ACCOUNT_BODY },
      "POST c1": { status: 200, body: { id: "c1" } },
      "GET c1": { status: 200, body: VALID_CAMPAIGN_BODY },
    });

    const result = await provider.updateCampaignStatus(CONFIGURED, "c1", "PAUSED");
    expect(result.success).toBe(true);
    expect(result.campaign.campaignId).toBe("c1");
    expect(calls.some((c) => c.method === "POST" && c.path === "c1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. Direct GET returns wrong account ID -> unauthorized
// ---------------------------------------------------------------------------
describe("C. direct GET ID mismatch", () => {
  it("rejects when the returned account ID does not match the configured ID", async () => {
    const { provider, calls } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      [`GET ${CONFIGURED}`]: { status: 200, body: { ...VALID_ACCOUNT_BODY, id: "act_999" } },
    });

    await expect(provider.isAuthorized("user-1", CONFIGURED)).resolves.toBe(false);
    await expect(provider.getAuthorizedAccountIds("user-1")).resolves.toEqual([]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("blocks writes when the direct response ID mismatches", async () => {
    const { provider, calls } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      [`GET ${CONFIGURED}`]: { status: 200, body: { ...VALID_ACCOUNT_BODY, id: "act_999" } },
      "POST c1": { status: 200, body: { id: "c1" } },
    });

    await expect(provider.updateCampaignStatus(CONFIGURED, "c1", "PAUSED")).rejects.toBeInstanceOf(
      JarvisError
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D/E/F. Direct GET 401 / 403 / 404 -> unauthorized
// ---------------------------------------------------------------------------
describe.each([
  [401, { error: { message: "Invalid token", type: "OAuthException", code: 190 } }],
  [403, { error: { message: "Forbidden", type: "OAuthException", code: 200 } }],
  [404, { error: { message: "No account", type: "GraphMethodException", code: 803 } }],
])("D/E/F. direct GET HTTP %i", (status, body) => {
  it(`treats HTTP ${status} as unauthorized`, async () => {
    const { provider } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      [`GET ${CONFIGURED}`]: { status, body },
    });

    await expect(provider.isAuthorized("user-1", CONFIGURED)).resolves.toBe(false);
    await expect(provider.getAuthorizedAccountIds("user-1")).resolves.toEqual([]);
  });

  it(`blocks writes on HTTP ${status}`, async () => {
    const { provider, calls } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      [`GET ${CONFIGURED}`]: { status, body },
      "POST c1": { status: 200, body: { id: "c1" } },
    });

    await expect(provider.updateCampaignStatus(CONFIGURED, "c1", "PAUSED")).rejects.toBeInstanceOf(
      JarvisError
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G. Arbitrary account IDs cannot bypass the configured account
// ---------------------------------------------------------------------------
describe("G. arbitrary account isolation", () => {
  it("denies a non-configured account that is absent from /me/adaccounts", async () => {
    const { provider, calls } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      // Even if a direct GET for the other account WOULD succeed, the
      // fallback must never be attempted for it.
      "GET act_200": { status: 200, body: { id: "act_200", name: "Other", currency: "USD" } },
    });

    await expect(provider.isAuthorized("user-1", "act_200")).resolves.toBe(false);
    expect(calls.some((c) => c.path === "act_200")).toBe(false);
  });

  it("never performs the direct fallback request for non-configured accounts on writes", async () => {
    const { provider, calls } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      "GET act_200": { status: 200, body: { id: "act_200", name: "Other", currency: "USD" } },
      "POST c9": { status: 200, body: { id: "c9" } },
    });

    await expect(provider.updateCampaignStatus("act_200", "c9", "PAUSED")).rejects.toBeInstanceOf(
      JarvisError
    );
    expect(calls.some((c) => c.path === "act_200")).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("denies malformed account IDs outright", async () => {
    const { provider } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
    });

    await expect(provider.isAuthorized("user-1", "not-an-id")).resolves.toBe(false);
    await expect(provider.isAuthorized("user-1", "")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H. Malformed direct account response -> unauthorized/error
// ---------------------------------------------------------------------------
describe("H. malformed direct responses", () => {
  it.each([
    ["non-object body", "unexpected-string-body"],
    ["missing id", { name: "No ID", currency: "USD" }],
    ["null body", null],
  ])("treats %s as unauthorized", async (_label, body) => {
    const { provider } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      [`GET ${CONFIGURED}`]: { status: 200, body },
    });

    await expect(provider.isAuthorized("user-1", CONFIGURED)).resolves.toBe(false);
  });

  it("treats a 2xx response carrying an error body as unauthorized", async () => {
    const { provider } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [] } },
      [`GET ${CONFIGURED}`]: {
        status: 200,
        body: { error: { message: "soft failure", type: "x", code: 1 } },
      },
    });

    await expect(provider.isAuthorized("user-1", CONFIGURED)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I. Token redaction
// ---------------------------------------------------------------------------
describe("I. secret safety", () => {
  it("propagated auth errors never contain the raw access token", async () => {
    const { provider } = makeProvider({
      "GET me/adaccounts": {
        status: 500,
        body: { error: { message: `Token ${TOKEN} is invalid`, type: "x", code: 1 } },
      },
    });

    await expect(provider.updateCampaignStatus(CONFIGURED, "c1", "PAUSED")).rejects.toSatisfy(
      (err: unknown) => err instanceof Error && !err.message.includes(TOKEN)
    );
  });

  it("isAuthorized stays boolean (false) and leaks nothing when discovery fails", async () => {
    const { provider } = makeProvider({
      "GET me/adaccounts": {
        status: 500,
        body: { error: { message: `access_token=${TOKEN} rejected`, type: "x", code: 1 } },
      },
    });

    await expect(provider.isAuthorized("user-1", CONFIGURED)).resolves.toBe(false);
    await expect(provider.getAuthorizedAccountIds("user-1")).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// J. Existing authorization behavior remains intact
// ---------------------------------------------------------------------------
describe("J. regression of existing behavior", () => {
  it("propagates authentication failures from the discovery call on writes", async () => {
    const { provider, calls } = makeProvider({
      "GET me/adaccounts": {
        status: 401,
        body: { error: { message: "Session expired", type: "OAuthException", code: 190 } },
      },
    });

    await expect(provider.updateCampaignStatus(CONFIGURED, "c1", "PAUSED")).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("returns multiple listed accounts unchanged", async () => {
    const { provider } = makeProvider({
      "GET me/adaccounts": {
        status: 200,
        body: { data: [{ id: "act_111111111" }, { id: "act_222222222" }] },
      },
    });

    await expect(provider.getAuthorizedAccountIds("user-1")).resolves.toEqual([
      "act_111111111",
      "act_222222222",
    ]);
    await expect(provider.isAuthorized("user-1", "act_111111111")).resolves.toBe(true);
    await expect(provider.isAuthorized("user-1", "act_222222222")).resolves.toBe(true);
  });

  it("accepts numeric account IDs normalized to act_ form", async () => {
    const { provider } = makeProvider({
      "GET me/adaccounts": { status: 200, body: { data: [{ id: CONFIGURED }] } },
    });

    await expect(provider.isAuthorized("user-1", "100")).resolves.toBe(true);
  });

  it("returns [] when every mechanism fails (previous contract preserved)", async () => {
    const { provider } = makeProvider({
      "GET me/adaccounts": { status: 500, body: { error: { message: "boom", type: "x", code: 2 } } },
      [`GET ${CONFIGURED}`]: { status: 403, body: { error: { message: "no", type: "x", code: 200 } } },
    });

    await expect(provider.getAuthorizedAccountIds("user-1")).resolves.toEqual([]);
  });
});

// Silence unused-import warnings if vitest config differs
void vi;
