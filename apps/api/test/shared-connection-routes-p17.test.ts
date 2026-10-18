// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening — the two routes outside the command
// service that described or tested a shared connection (M3, L11).
//
//   • /integrations without an encryption key: the read paths and the
//     connection test no longer serve the registry directly — they answer as
//     the management verbs always did, 503, and reach no provider.
//   • /credentials: the deployment's Meta credential and the server-managed
//     connections are described only to the Organization that owns them —
//     everyone else is answered as on a deployment without them — and a test
//     of the caller's OWN credentials takes their budget slot first.
//
// Real routers over HTTP; the providers are a `fetch` spy.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EncryptionService, generateKey, parseKey } from "@jarvis/security";
import { createIntegrationsRouter } from "../src/routes/integrations.js";
import { createCredentialsRouter } from "../src/routes/credentials.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "./helpers/shared-access.js";

const ORG = "org-a";
const http = globalThis.fetch.bind(globalThis);
const encryption = new EncryptionService([parseKey(1, generateKey())]);

const tokenService = {
  verifyAccessToken: (token: string) => {
    const userId = token.replace(/^tok-/, "");
    return userId ? { userId, role: "member", email: `${userId}@test.local` } : null;
  },
};

function organization(): MemoryTenancy {
  return memoryTenancy({
    owners: { "meta/ads": ORG, "whatsapp/cloud-api": ORG, "n8n/rest": ORG, "google-maps/server-key": ORG },
    members: [
      { userId: "owner-1", tenantId: ORG, role: "owner" },
      { userId: "member-1", tenantId: ORG, role: "member" },
    ],
  });
}

/** The credential store, in memory, holding envelopes as the real one does. */
function credentialRepo(seed: Record<string, Record<string, string>> = {}) {
  const rows = new Map<string, string>();
  for (const [key, values] of Object.entries(seed)) rows.set(key, encryption.encrypt(JSON.stringify(values)));
  return {
    get: async (userId: string, provider: string) => rows.get(`${userId}:${provider}`) ?? null,
    put: async (userId: string, provider: string, envelope: string) => void rows.set(`${userId}:${provider}`, envelope),
    remove: async (userId: string, provider: string) => void rows.delete(`${userId}:${provider}`),
  };
}

let server: Server;
let base = "";
let tenancy: MemoryTenancy;
let repo: ReturnType<typeof credentialRepo>;
type Reservation = { allowed: boolean; reason?: "UNAVAILABLE" | "LIMIT" };
let budget: { reserveForUser: Mock<(userId: string) => Promise<Reservation>> } | undefined;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(() => {
  const container = new Proxy(
    {},
    {
      get(_t, key: string) {
        if (key === "tokenService") return tokenService;
        if (key === "integrationCommands") return null;
        if (key === "sharedAccess") return accessOver(tenancy);
        if (key === "auditLogger") return { log: async () => {} };
        return undefined;
      },
    }
  ) as never;
  const app = express();
  app.use(express.json());
  app.use("/integrations", createIntegrationsRouter(container, {} as never));
  app.use(
    "/credentials",
    express.Router().use((req, res, next) =>
      createCredentialsRouter(container, {
        repo: repo as never,
        encryption,
        googleAdsMounted: false,
        ...(budget ? { testBudget: budget } : {}),
      })(req, res, next)
    )
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  tenancy = organization();
  repo = credentialRepo();
  budget = { reserveForUser: vi.fn(async (_userId: string): Promise<Reservation> => ({ allowed: true })) };
  vi.stubEnv("META_ACCESS_TOKEN", "META-TOKEN-SECRET");
  vi.stubEnv("META_AD_ACCOUNT_ID", "act_999");
  // Distinct from every placeholder in the product's own text.
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "5550001112223");
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "WA-TOKEN-SECRET");
  vi.stubEnv("WHATSAPP_APP_SECRET", "WA-APP-SECRET");
  vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "WA-VERIFY-SECRET");
  vi.stubEnv("N8N_BASE_URL", "https://n8n.example.test");
  vi.stubEnv("N8N_API_KEY", "N8N-KEY-SECRET");
  vi.stubEnv("N8N_CALLBACK_SECRET", "N8N-CALLBACK-SECRET");
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "act_1", account_id: "1" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function call(userId: string, method: string, path: string) {
  const response = await http(base + path, { method, headers: { authorization: `Bearer tok-${userId}` } });
  return { status: response.status, body: (await response.json()) as { success: boolean; data?: any; error?: { code: string } } };
}

type ProviderView = { id: string; status: string; detail: string; effectiveSource: string };
const providersOf = async (userId: string) => {
  const providers = (await call(userId, "GET", "/credentials")).body.data.providers as ProviderView[];
  return Object.fromEntries(providers.map((p) => [p.id, p]));
};

describe("/integrations without an encryption key — nothing served around the command service", () => {
  it.each([
    ["GET", "/integrations"],
    ["GET", "/integrations/whatsapp"],
    ["POST", "/integrations/whatsapp/test"],
    ["POST", "/integrations/meta/test"],
    ["POST", "/integrations/whatsapp/refresh"],
  ])("%s %s answers 503 NOT_CONFIGURED and reaches no provider", async (method, path) => {
    const res = await call("owner-1", method, path);
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe("NOT_CONFIGURED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("/credentials — the deployment's connections are its Organization's to see", () => {
  it("describes them to an outsider exactly as a deployment without them", async () => {
    const outsider = await providersOf("outsider-1");
    for (const name of ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID", "WHATSAPP_PHONE_NUMBER_ID", "N8N_BASE_URL"]) vi.stubEnv(name, undefined);
    const unconfigured = await providersOf("outsider-1");
    expect(outsider.meta).toEqual(unconfigured.meta);
    expect(outsider.meta).toMatchObject({ status: "NOT_CONNECTED", detail: "No credentials stored.", effectiveSource: "none" });
    for (const id of ["whatsapp", "n8n"]) {
      expect(outsider[id]).toEqual(unconfigured[id]);
      expect(outsider[id]).toMatchObject({ status: "NOT_CONNECTED", detail: "Not available to your account." });
    }
  });

  it("tells a member it is set up for their Organization — and nothing of the operator's", async () => {
    const member = await providersOf("member-1");
    expect(member.meta).toMatchObject({ status: "CONFIGURED", effectiveSource: "your organization" });
    expect(member.whatsapp).toMatchObject({ status: "CONFIGURED", effectiveSource: "your organization" });
    expect(member.n8n).toMatchObject({ status: "CONFIGURED", effectiveSource: "your organization" });
    // The operator's identifiers — the product's own descriptions may say
    // "server environment"; no answer here may carry what this server holds.
    expect(JSON.stringify(member)).not.toMatch(/act_999|5550001112223|n8n\.example|SECRET/);
    expect(member.meta!.detail).not.toMatch(/server environment/);
  });

  it("keeps the details for an owner — without claiming an unchecked credential is connected", async () => {
    const owner = await providersOf("owner-1");
    expect(owner.meta).toMatchObject({ status: "CONFIGURED", effectiveSource: "server environment" });
    expect(owner.whatsapp).toMatchObject({ effectiveSource: "server environment" });
  });

  it("refuses an outsider's view of everything when the lookups fail", async () => {
    tenancy.setFailing(true);
    const owner = await providersOf("owner-1");
    expect(owner.meta).toMatchObject({ status: "NOT_CONNECTED" });
    expect(owner.whatsapp).toMatchObject({ detail: "Not available to your account." });
  });
});

describe("/credentials/meta/test — the caller's own credentials, still on their budget", () => {
  beforeEach(() => {
    repo = credentialRepo({ "owner-1:meta": { accessToken: "MY-OWN-TOKEN", adAccountId: "act_424242424" } });
  });

  it("takes the caller's slot before the provider is called", async () => {
    const order: string[] = [];
    budget!.reserveForUser.mockImplementation(async () => {
      order.push("slot");
      return { allowed: true };
    });
    fetchSpy.mockImplementation(async () => {
      order.push("provider");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const res = await call("owner-1", "POST", "/credentials/meta/test");
    expect(res.status).toBe(200);
    expect(budget!.reserveForUser).toHaveBeenCalledWith("owner-1");
    expect(order[0]).toBe("slot");
    expect(order).toContain("provider");
  });

  it("refuses over the limit — and when no budget can be checked — before the provider", async () => {
    budget!.reserveForUser.mockResolvedValue({ allowed: false, reason: "LIMIT" });
    expect((await call("owner-1", "POST", "/credentials/meta/test")).status).toBe(429);
    budget = undefined;
    expect((await call("owner-1", "POST", "/credentials/meta/test")).status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
