// ---------------------------------------------------------------------------
// Integration Control Center — registry, health model and secret containment.
//
// The three claims this page makes, each pinned here:
//
//   1. IT NEVER CLAIMS AN UNVERIFIED CONNECTION. Credentials existing is not a
//      connection. Only a real check that succeeded produces CONNECTED, and a
//      cached success cannot survive the credential being removed.
//
//   2. NO SECRET IS IN THE SHAPE. Not the Meta token, not the WhatsApp access
//      token, not the n8n API key, not either Maps key. The serialised view is
//      searched for each of them.
//
//   3. THE APPROVAL BOUNDARY IS VISIBLE AND INTACT. Every capability that
//      changes something outside JARVIS is marked, so a connected card cannot
//      be read as permission to act.
//
// No test here calls a real provider: `fetch` is stubbed throughout.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  INTEGRATION_IDS,
  __resetIntegrationChecks,
  getIntegration,
  invalidateChecks,
  listIntegrations,
  runCheck,
  type IntegrationDeps,
  type IntegrationView,
} from "../src/services/integration-registry.js";

const USER = "user-a";
const OTHER = "user-b";

/** Every Maps/WhatsApp/n8n/Meta env var this suite manipulates. */
const ENV_KEYS = [
  "GOOGLE_MAPS_BROWSER_KEY",
  "GOOGLE_MAPS_SERVER_KEY",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "N8N_BASE_URL",
  "N8N_API_KEY",
  "N8N_CALLBACK_SECRET",
  "META_ACCESS_TOKEN",
  "META_AD_ACCOUNT_ID",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetIntegrationChecks();
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

function deps(overrides: Partial<IntegrationDeps> = {}): IntegrationDeps {
  return {
    googleOAuthMounted: true,
    googleConnections: { findByUser: async () => null },
    readMetaCredentials: async () => null,
    ...overrides,
  };
}

const find = (list: IntegrationView[], id: string) => list.find((i) => i.id === id)!;

/**
 * A fetch stub both readers accept.
 *
 * The Meta client reads `response.text()` and parses it itself; the WhatsApp
 * and n8n checks read `response.json()`. A stub with only one of them makes a
 * successful call look like a failure, which is exactly the confusing result
 * this helper exists to prevent.
 */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const payload = JSON.stringify(body);
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => JSON.parse(payload),
    text: async () => payload,
  } as Response);
}

// ---------------------------------------------------------------------------

describe("registry shape", () => {
  it("lists exactly the documented integrations", async () => {
    const list = await listIntegrations(USER, deps());
    expect(list.map((i) => i.id).sort()).toEqual([...INTEGRATION_IDS].sort());
  });

  it("gives every integration a category, so the page can group them", async () => {
    const list = await listIntegrations(USER, deps());
    for (const integration of list) {
      expect(integration.category).toBeTruthy();
      expect(integration.name.length).toBeGreaterThan(0);
    }
  });

  it("returns 'not found' rather than an empty shell for an unknown id", async () => {
    expect(await getIntegration(USER, "dropbox", deps())).toBeNull();
    expect(await runCheck(USER, "dropbox", deps())).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("health is never assumed", () => {
  it("reports UNVERIFIED, not CONNECTED, when credentials exist but nothing was checked", async () => {
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";

    const meta = find(await listIntegrations(USER, deps()), "meta");
    // The whole point: "credentials are present" and "the provider accepts
    // them" are different facts, and only the second one is a connection.
    expect(meta.health).toBe("UNVERIFIED");
    expect(meta.lastCheckedAt).toBeNull();
  });

  it("reports NOT_CONNECTED when there is nothing configured", async () => {
    const meta = find(await listIntegrations(USER, deps()), "meta");
    expect(meta.health).toBe("NOT_CONNECTED");
  });

  it("promotes to CONNECTED only after a successful check", async () => {
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
    stubFetch({ data: [{ id: "act_1" }] });

    const result = await runCheck(USER, "meta", deps());
    expect(result?.health).toBe("CONNECTED");

    const meta = find(await listIntegrations(USER, deps()), "meta");
    expect(meta.health).toBe("CONNECTED");
    expect(meta.lastCheckedAt).not.toBeNull();
  });

  it("records a failed check as ERROR with the reason attached", async () => {
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Invalid OAuth access token"));

    await runCheck(USER, "meta", deps());
    const meta = find(await listIntegrations(USER, deps()), "meta");

    // Credentials exist AND the API rejected them — that is ERROR, not
    // CONNECTED. This is the case the brief calls out explicitly.
    expect(meta.health).toBe("ERROR");
    expect(meta.lastError).toMatch(/Invalid OAuth access token/);
  });

  it("does NOT let a cached success survive the credentials being removed", async () => {
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
    stubFetch({ data: [] });

    await runCheck(USER, "meta", deps());
    expect(find(await listIntegrations(USER, deps()), "meta").health).toBe("CONNECTED");

    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_AD_ACCOUNT_ID;

    // The configuration state wins. A stale green dot over a deleted credential
    // is the worst possible lie this page could tell.
    const after = find(await listIntegrations(USER, deps()), "meta");
    expect(after.health).toBe("NOT_CONNECTED");
    expect(after.lastCheckedAt).toBeNull();
  });

  it("forgets a verdict on demand, so an action can reset the card", async () => {
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
    stubFetch({ data: [] });

    await runCheck(USER, "meta", deps());
    invalidateChecks(USER, "meta");
    expect(find(await listIntegrations(USER, deps()), "meta").health).toBe("UNVERIFIED");
  });
});

// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("keeps one user's verdict out of another user's view", async () => {
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
    stubFetch({ data: [] });

    await runCheck(USER, "meta", deps());

    expect(find(await listIntegrations(USER, deps()), "meta").health).toBe("CONNECTED");
    // Same server-level credentials, but the CHECK belongs to whoever ran it.
    expect(find(await listIntegrations(OTHER, deps()), "meta").health).toBe("UNVERIFIED");
  });

  it("reads each user's own Google connection, never another's", async () => {
    const seen: string[] = [];
    const d = deps({
      googleConnections: {
        findByUser: async (userId: string) => {
          seen.push(userId);
          return userId === USER
            ? {
                googleAccountEmail: "a@example.com",
                scopes: ["adwords"],
                connectedAt: new Date(),
                expiresAt: new Date(Date.now() + 3600_000),
              }
            : null;
        },
      },
    });

    expect(find(await listIntegrations(USER, d), "google").account?.label).toBe("a@example.com");
    expect(find(await listIntegrations(OTHER, d), "google").account).toBeNull();
    expect(seen).toContain(OTHER);
  });

  it("invalidating one user's checks leaves another user's alone", async () => {
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
    stubFetch({ data: [] });

    await runCheck(USER, "meta", deps());
    await runCheck(OTHER, "meta", deps());
    invalidateChecks(USER);

    expect(find(await listIntegrations(USER, deps()), "meta").health).toBe("UNVERIFIED");
    expect(find(await listIntegrations(OTHER, deps()), "meta").health).toBe("CONNECTED");
  });
});

// ---------------------------------------------------------------------------

describe("no secret reaches the response", () => {
  it("carries no credential for any integration, however configured", async () => {
    process.env.GOOGLE_MAPS_BROWSER_KEY = "AIzaBROWSERSECRET";
    process.env.GOOGLE_MAPS_SERVER_KEY = "AIzaSERVERSECRET";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
    process.env.WHATSAPP_ACCESS_TOKEN = "WA-TOKEN-SECRET";
    process.env.WHATSAPP_APP_SECRET = "WA-APP-SECRET";
    process.env.WHATSAPP_VERIFY_TOKEN = "WA-VERIFY-SECRET";
    process.env.N8N_BASE_URL = "https://n8n.example.test";
    process.env.N8N_API_KEY = "N8N-KEY-SECRET";
    process.env.N8N_CALLBACK_SECRET = "N8N-CALLBACK-SECRET";
    process.env.META_ACCESS_TOKEN = "META-TOKEN-SECRET";
    process.env.META_AD_ACCOUNT_ID = "act_999";

    const serialised = JSON.stringify(
      await listIntegrations(
        USER,
        deps({ readMetaCredentials: async () => ({ accessToken: "STORED-META-SECRET", adAccountId: "act_999" }) })
      )
    );

    for (const secret of [
      "AIzaBROWSERSECRET",
      "AIzaSERVERSECRET",
      "WA-TOKEN-SECRET",
      "WA-APP-SECRET",
      "WA-VERIFY-SECRET",
      "N8N-KEY-SECRET",
      "N8N-CALLBACK-SECRET",
      "META-TOKEN-SECRET",
      "STORED-META-SECRET",
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("still shows the safe identifiers an operator needs", async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
    process.env.WHATSAPP_ACCESS_TOKEN = "t";
    process.env.WHATSAPP_APP_SECRET = "s";
    process.env.WHATSAPP_VERIFY_TOKEN = "v";
    process.env.N8N_BASE_URL = "https://n8n.example.test";
    process.env.N8N_API_KEY = "k";
    process.env.N8N_CALLBACK_SECRET = "c";

    const list = await listIntegrations(USER, deps());
    // A phone number id and a base URL are operator configuration, not secrets,
    // and without them the cards cannot say WHICH account is connected.
    expect(find(list, "whatsapp").account?.label).toContain("1234567890");
    expect(find(list, "n8n").account?.label).toContain("n8n.example.test");
  });

  it("never puts a provider's raw failure into a field that could hold a URL with a token", async () => {
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("x".repeat(5000))
    );

    const result = await runCheck(USER, "meta", deps());
    // Bounded, so a provider cannot push an essay — or a long URL — into the UI
    // and the audit log.
    expect(result!.detail.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------

describe("approval boundary is visible", () => {
  it("marks every action that changes something outside JARVIS", async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
    process.env.WHATSAPP_ACCESS_TOKEN = "t";
    process.env.WHATSAPP_APP_SECRET = "s";
    process.env.WHATSAPP_VERIFY_TOKEN = "v";
    process.env.N8N_BASE_URL = "https://n8n.example.test";
    process.env.N8N_API_KEY = "k";
    process.env.N8N_CALLBACK_SECRET = "c";
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";

    const list = await listIntegrations(USER, deps());
    const gated = (id: string, capability: string) =>
      find(list, id).capabilities.find((c) => c.id === capability)?.requiresApproval;

    expect(gated("whatsapp", "whatsapp.send")).toBe(true);
    expect(gated("n8n", "n8n.trigger")).toBe(true);
    expect(gated("meta", "meta.writes")).toBe(true);
  });

  it("does NOT mark reads as approval-gated", async () => {
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
    const list = await listIntegrations(USER, deps());
    const insights = find(list, "meta").capabilities.find((c) => c.id === "meta.insights");
    expect(insights?.requiresApproval).toBeUndefined();
  });

  it("exposes no action that could execute anything", async () => {
    process.env.META_ACCESS_TOKEN = "token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
    const list = await listIntegrations(USER, deps());

    for (const integration of list) {
      // Configuration verbs only. There is deliberately no "send", "trigger" or
      // "run" — those are tools, reached through ToolExecutor and approval.
      expect(Object.keys(integration.actions).sort()).toEqual(
        expect.arrayContaining(["testable"])
      );
      const serialised = JSON.stringify(integration.actions);
      expect(serialised).not.toMatch(/send|trigger|execute|run/i);
    }
  });
});

// ---------------------------------------------------------------------------

describe("capabilities are real", () => {
  it("describes the Google connection as Ads, not Gmail or Drive", async () => {
    // This repository's Google OAuth is READ-ONLY GOOGLE ADS. Listing Gmail,
    // Calendar or Drive would be a fabricated capability.
    const google = find(await listIntegrations(USER, deps()), "google");
    const labels = google.capabilities.map((c) => c.label.toLowerCase()).join(" ");
    expect(labels).toContain("ads");
    expect(labels).not.toContain("gmail");
    expect(labels).not.toContain("calendar");
    expect(labels).not.toContain("drive");
  });

  it("marks Maps capabilities against the key that actually enables each one", async () => {
    process.env.GOOGLE_MAPS_BROWSER_KEY = "b";
    const maps = find(await listIntegrations(USER, deps()), "google-maps");
    const byId = Object.fromEntries(maps.capabilities.map((c) => [c.id, c.available]));

    // Browser key renders the map; the server key is what Places, Routes and
    // Geocoding need. Reporting all four as available would hide that every
    // distance is coming from OpenStreetMap.
    expect(byId["maps.js"]).toBe(true);
    expect(byId["maps.places"]).toBe(false);
    expect(byId["maps.routes"]).toBe(false);
    expect(maps.health).toBe("CONFIG_REQUIRED");
  });

  it("reports Google as DISABLED when no OAuth client is configured", async () => {
    const google = find(
      await listIntegrations(USER, deps({ googleOAuthMounted: false, googleConnections: null })),
      "google"
    );
    expect(google.health).toBe("DISABLED");
    expect(google.actions.testable).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("connection tests are reads, and are contained", () => {
  it("reports an expired Google token as DEGRADED, not CONNECTED", async () => {
    const d = deps({
      googleConnections: {
        findByUser: async () => ({
          googleAccountEmail: "a@example.com",
          scopes: ["adwords"],
          connectedAt: new Date(Date.now() - 86_400_000),
          expiresAt: new Date(Date.now() - 60_000),
        }),
      },
    });

    const result = await runCheck(USER, "google", d);
    expect(result?.health).toBe("DEGRADED");
    expect(result?.detail).toMatch(/expired/i);
  });

  it("verifies WhatsApp with a READ of the phone number, sending nothing", async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
    process.env.WHATSAPP_ACCESS_TOKEN = "t";
    process.env.WHATSAPP_APP_SECRET = "s";
    process.env.WHATSAPP_VERIFY_TOKEN = "v";

    const spy = stubFetch({ id: "1234567890", verified_name: "JARVIS" });

    const result = await runCheck(USER, "whatsapp", deps());
    expect(result?.health).toBe("CONNECTED");

    const [url, init] = spy.mock.calls[0]!;
    // A GET against the phone number's own metadata. Sending a message from a
    // connection test would route straight around the approval boundary.
    expect(String(url)).toContain("/1234567890");
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    expect(String(url)).not.toContain("/messages");
  });

  it("reports a rejected WhatsApp token as ERROR", async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
    process.env.WHATSAPP_ACCESS_TOKEN = "t";
    process.env.WHATSAPP_APP_SECRET = "s";
    process.env.WHATSAPP_VERIFY_TOKEN = "v";

    stubFetch({ error: { message: "Error validating access token" } }, { ok: false, status: 401 });

    const result = await runCheck(USER, "whatsapp", deps());
    expect(result?.health).toBe("ERROR");
    expect(result?.detail).toMatch(/access token/i);
  });

  it("tests n8n only against the SERVER-CONFIGURED origin", async () => {
    process.env.N8N_BASE_URL = "https://n8n.example.test";
    process.env.N8N_API_KEY = "k";
    process.env.N8N_CALLBACK_SECRET = "c";

    const spy = stubFetch({ data: [] });

    await runCheck(USER, "n8n", deps());

    const url = new URL(String(spy.mock.calls[0]![0]));
    // SSRF containment: nothing in the request influences this URL, so there is
    // no caller-supplied component to redirect it.
    expect(url.origin).toBe("https://n8n.example.test");
    expect(url.pathname).toBe("/api/v1/workflows");
  });

  it("reports a rejected n8n key as ERROR rather than as unreachable", async () => {
    process.env.N8N_BASE_URL = "https://n8n.example.test";
    process.env.N8N_API_KEY = "k";
    process.env.N8N_CALLBACK_SECRET = "c";

    stubFetch({}, { ok: false, status: 401 });
    const result = await runCheck(USER, "n8n", deps());
    expect(result?.health).toBe("ERROR");
    expect(result?.detail).toMatch(/api key/i);
  });

  it("refuses to test an unconfigured integration instead of reporting failure", async () => {
    // "Not configured" and "broken" are different problems with different
    // fixes, and an operator should not have to guess which one they have.
    expect((await runCheck(USER, "whatsapp", deps()))?.health).toBe("CONFIG_REQUIRED");
    expect((await runCheck(USER, "n8n", deps()))?.health).toBe("CONFIG_REQUIRED");
    expect((await runCheck(USER, "google-maps", deps()))?.health).toBe("CONFIG_REQUIRED");
  });
});

// ---------------------------------------------------------------------------

describe("a card offers no action it cannot perform (caught on screen)", () => {
  it("does NOT offer Disconnect on a Google card that is not connected", async () => {
    const google = find(await listIntegrations(USER, deps()), "google");
    expect(google.health).toBe("NOT_CONNECTED");
    // A Disconnect button with nothing to disconnect. Spotted in the rendered
    // page, not in a unit test — hence this one.
    expect(google.actions.disconnectUrl).toBeUndefined();
    expect(google.actions.connectUrl).toBe("/google/connect");
  });

  it("offers Disconnect once an account IS connected", async () => {
    const d = deps({
      googleConnections: {
        findByUser: async () => ({
          googleAccountEmail: "a@example.com",
          scopes: ["adwords"],
          connectedAt: new Date(),
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      },
    });
    const google = find(await listIntegrations(USER, d), "google");
    expect(google.actions.disconnectUrl).toBe("/google/disconnect");
  });

  it("does not tick Google capabilities before anything is connected", async () => {
    // Ticks on a NOT CONNECTED card read as "you already have these". Unticked,
    // the same list correctly reads as what connecting would enable.
    const google = find(await listIntegrations(USER, deps()), "google");
    expect(google.capabilities.every((c) => c.available === false)).toBe(true);
  });

  it("ticks them once connected", async () => {
    const d = deps({
      googleConnections: {
        findByUser: async () => ({
          googleAccountEmail: "a@example.com",
          scopes: ["adwords"],
          connectedAt: new Date(),
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      },
    });
    const google = find(await listIntegrations(USER, d), "google");
    expect(google.capabilities.every((c) => c.available === true)).toBe(true);
  });
});
