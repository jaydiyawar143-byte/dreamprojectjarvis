// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening — the Integration Control Center's shared
// connections (review findings M3 and L11), through the ONE command service.
//
// M3 — a connection test spends the deployment's credential, so:
//   • the caller is authorized BEFORE any provider request, server start or
//     budget is touched: an outsider, a member whose role cannot test, a
//     connection nobody owns, a lookup that failed — all refused with zero
//     provider calls;
//   • an authorized test takes the caller's slot and the Organization's slot,
//     in that order, before the provider is called; a full window refuses it
//     before the provider is called;
//   • one Organization's tests never spend another's budget.
//
// L11 — what an integration shows:
//   • an outsider's view of a shared integration is the same whether it is
//     configured or not, and carries none of the operator's identifiers;
//   • a member sees status without diagnostics; an owner or admin sees all;
//   • permissions, the list and capability views follow the same rule.
//
// Parity — a sentence (the JARVIS integration tools) reaches the same answer as
// a button. Nothing here reaches a real provider: `fetch` is a spy, and the
// reviewed-server runtime is a double whose `verify` is counted.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IntegrationCommandContext,
  IntegrationCommandInput,
  IntegrationId,
  IntegrationView,
} from "@jarvis/core";
import { createIntegrationTools } from "@jarvis/tools";
import {
  IntegrationCommandService,
  type BudgetDecision,
  type CredentialPort,
  type IntegrationStatePort,
  type RateLimitPort,
  type TestBudgetPort,
} from "../src/services/integrations/command-service.js";
import { __resetIntegrationChecks } from "../src/services/integration-registry.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "./helpers/shared-access.js";

const ORG = "org-a";
const OTHER = "org-b";
const OWNER = "owner-1";
const ADMIN = "admin-1";
const MEMBER = "member-1";
const VIEWER = "viewer-1";
const OUTSIDER = "outsider-1";

/** The operator's identifiers: none may reach an outsider or a plain member. */
const IDENTIFIERS = ["5550001112223", "n8n.example.test", "omniroute.example.test", "act_999", "docs-reviewed"];
const SECRETS = ["WA-TOKEN-SECRET", "N8N-KEY-SECRET", "OMNI-KEY-SECRET", "META-TOKEN-SECRET", "AIzaSERVERSECRET"];

const SHARED: IntegrationId[] = ["whatsapp", "n8n", "omniroute", "google-maps", "mcp", "meta"];
const SERVER_MANAGED: IntegrationId[] = ["whatsapp", "n8n", "omniroute", "google-maps", "mcp"];

const CONNECTORS: Record<string, string> = {
  meta: "meta/ads",
  n8n: "n8n/rest",
  whatsapp: "whatsapp/cloud-api",
  "google-maps": "google-maps/server-key",
  mcp: "mcp/servers",
  omniroute: "omniroute/gateway",
};

/** ORG owns every shared connection; OUTSIDER owns OTHER, which owns nothing. */
function organization(): MemoryTenancy {
  const tenancy = memoryTenancy({
    owners: Object.fromEntries(Object.values(CONNECTORS).map((key) => [key, ORG])),
    members: [
      { userId: OWNER, tenantId: ORG, role: "owner" },
      { userId: ADMIN, tenantId: ORG, role: "admin" },
      { userId: MEMBER, tenantId: ORG, role: "member" },
      { userId: VIEWER, tenantId: ORG, role: "viewer" },
      { userId: OUTSIDER, tenantId: OTHER, role: "owner" },
    ],
  });
  return tenancy;
}

function configureEverything(): void {
  vi.stubEnv("GOOGLE_MAPS_BROWSER_KEY", "AIzaBROWSERSECRET");
  vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "AIzaSERVERSECRET");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "5550001112223");
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "WA-TOKEN-SECRET");
  vi.stubEnv("WHATSAPP_APP_SECRET", "WA-APP-SECRET");
  vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "WA-VERIFY-SECRET");
  vi.stubEnv("N8N_BASE_URL", "https://n8n.example.test");
  vi.stubEnv("N8N_API_KEY", "N8N-KEY-SECRET");
  vi.stubEnv("N8N_CALLBACK_SECRET", "N8N-CALLBACK-SECRET");
  vi.stubEnv("META_ACCESS_TOKEN", "META-TOKEN-SECRET");
  vi.stubEnv("META_AD_ACCOUNT_ID", "act_999");
  vi.stubEnv("OMNIROUTE_BASE_URL", "http://omniroute.example.test:20128/v1");
  vi.stubEnv("OMNIROUTE_API_KEY", "OMNI-KEY-SECRET");
}

function configureNothing(): void {
  for (const name of [
    "GOOGLE_MAPS_BROWSER_KEY", "GOOGLE_MAPS_SERVER_KEY", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "N8N_BASE_URL", "N8N_API_KEY", "N8N_CALLBACK_SECRET",
    "META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID", "OMNIROUTE_BASE_URL", "OMNIROUTE_API_KEY",
  ]) {
    vi.stubEnv(name, undefined);
  }
}

function stateStore(): IntegrationStatePort {
  const rows = new Map<string, { enabled: boolean; enabledServices: string[]; lastSuccessfulSyncAt: string | null }>();
  const fresh = () => ({ enabled: true, enabledServices: [] as string[], lastSuccessfulSyncAt: null as string | null });
  return {
    async get(userId, integration) {
      return { ...(rows.get(`${userId}:${integration}`) ?? fresh()) };
    },
    async patch(userId, integration, changes) {
      const next = { ...(rows.get(`${userId}:${integration}`) ?? fresh()), ...changes };
      rows.set(`${userId}:${integration}`, next);
      return { ...next };
    },
    async clear(userId, integration) {
      rows.delete(`${userId}:${integration}`);
    },
  };
}

const noCredentials: CredentialPort = { read: async () => null, write: async () => {}, remove: async () => {} };
const allowAll: RateLimitPort = { check: async (_u, _b, limit) => ({ allowed: true, currentCount: 0, limit }) };

/** A budget that records every reservation, with an optional ceiling per window key. */
function recordingBudget(ceiling: { user?: number; organization?: number } = {}) {
  const taken: string[] = [];
  const counts = new Map<string, number>();
  const take = (key: string, limit: number | undefined): BudgetDecision => {
    const used = counts.get(key) ?? 0;
    if (limit !== undefined && used >= limit) return { allowed: false, reason: "LIMIT" };
    counts.set(key, used + 1);
    taken.push(key);
    return { allowed: true };
  };
  const port: TestBudgetPort = {
    reserveForUser: vi.fn(async (userId: string) => take(`user:${userId}`, ceiling.user)),
    reserveForOrganization: vi.fn(async (tenantId: string, integration: IntegrationId) =>
      take(`org:${tenantId}:${integration}`, ceiling.organization)
    ),
  };
  return { port, taken };
}

function reviewedServers() {
  const verify = vi.fn(async () => ({ ok: true }) as never);
  return { verify, runtime: { enabled: () => true, servers: () => [{ serverId: "docs-reviewed", verify }] } };
}

function serviceWith(options: {
  tenancy?: MemoryTenancy | null;
  budget?: TestBudgetPort | null;
  credentials?: CredentialPort;
  executor?: never;
  confirmations?: never;
} = {}) {
  const servers = reviewedServers();
  const service = new IntegrationCommandService({
    credentials: options.credentials ?? noCredentials,
    state: stateStore(),
    audit: { log: async () => {}, query: async () => [] } as never,
    rateLimiter: allowAll,
    googleConnections: null,
    oauthStates: null,
    googleConfig: () => null,
    mapsUsage: async () => ({ used: 4100, limit: 10000, percentUsed: 41, level: "ok", blocked: false }),
    mcp: servers.runtime,
    ...(options.tenancy === null ? {} : { sharedAccess: accessOver(options.tenancy ?? organization()) }),
    ...(options.budget === null ? {} : { testBudget: options.budget ?? recordingBudget().port }),
    ...(options.executor ? { executor: options.executor } : {}),
    ...(options.confirmations ? { confirmations: options.confirmations } : {}),
  });
  return { service, servers };
}

const as = (userId: string, role: IntegrationCommandContext["role"] = "owner"): IntegrationCommandContext => ({
  userId,
  role,
  source: "frontend",
});

const run = (service: IntegrationCommandService, command: IntegrationCommandInput["command"], integration: IntegrationId, userId: string) =>
  service.execute({ command, integration }, as(userId));

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetIntegrationChecks();
  configureEverything();
  fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ id: "5550001112223", verified_name: "Org Business", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// M3 — connection tests
// ---------------------------------------------------------------------------

describe("M3 — nobody spends a shared connection's test without the right", () => {
  it.each(SERVER_MANAGED)("an outsider's %s test reaches no provider, starts no server and takes no budget", async (id) => {
    const budget = recordingBudget();
    const { service, servers } = serviceWith({ budget: budget.port });
    const result = await run(service, "testConnection", id, OUTSIDER);
    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(!result.ok && result.message).toMatch(/is not available to your account\.$/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(servers.verify).not.toHaveBeenCalled();
    expect(budget.taken).toEqual([]);
  });

  it("answers an outsider's Meta test as a deployment without the shared credential would — and never uses the deployment's token", async () => {
    const outsider = await run(serviceWith().service, "testConnection", "meta", OUTSIDER);
    configureNothing();
    const unconfigured = await run(serviceWith().service, "testConnection", "meta", OWNER);
    expect(outsider).toMatchObject({ ok: false, code: "NOT_CONNECTED" });
    expect(!outsider.ok && outsider.message).toBe(!unconfigured.ok && unconfigured.message);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["member", MEMBER],
    ["viewer", VIEWER],
  ])("a %s of the owning Organization may not test — refused before any provider", async (_role, userId) => {
    const budget = recordingBudget();
    const { service, servers } = serviceWith({ budget: budget.port });
    for (const id of SHARED) {
      const result = await run(service, "testConnection", id, userId);
      expect(result, id).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
      expect(!result.ok && result.message, id).toMatch(/Only an owner or admin of your organization can test/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(servers.verify).not.toHaveBeenCalled();
    expect(budget.taken).toEqual([]);
  });

  it("refuses everyone — an account-wide owner included — while nobody owns the connection", async () => {
    const tenancy = organization();
    tenancy.setOwner("whatsapp", "cloud-api", null);
    const { service } = serviceWith({ tenancy });
    for (const userId of [OWNER, ADMIN]) {
      const result = await service.execute({ command: "testConnection", integration: "whatsapp" }, as(userId, "owner"));
      expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when ownership or membership cannot be read — with nothing spent", async () => {
    const tenancy = organization();
    tenancy.setFailing(true);
    const budget = recordingBudget();
    const { service, servers } = serviceWith({ tenancy, budget: budget.port });
    for (const id of SHARED) {
      const result = await run(service, "testConnection", id, OWNER);
      expect(result, id).toMatchObject({ ok: false, code: "AUTHORIZATION_UNAVAILABLE" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(servers.verify).not.toHaveBeenCalled();
    expect(budget.taken).toEqual([]);
  });

  it("refuses every shared test when no access reader is wired", async () => {
    const { service } = serviceWith({ tenancy: null });
    const result = await run(service, "testConnection", "whatsapp", OWNER);
    expect(result).toMatchObject({ ok: false, code: "AUTHORIZATION_UNAVAILABLE" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs an owner's test once, after taking the caller's slot and then the Organization's", async () => {
    const budget = recordingBudget();
    const order: string[] = [];
    (budget.port.reserveForUser as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("user-slot");
      return { allowed: true };
    });
    (budget.port.reserveForOrganization as ReturnType<typeof vi.fn>).mockImplementation(async (tenantId: string, integration: string) => {
      order.push(`org-slot:${tenantId}:${integration}`);
      return { allowed: true };
    });
    fetchSpy.mockImplementation(async () => {
      order.push("provider");
      return new Response(JSON.stringify({ id: "5550001112223", verified_name: "Org Business" }), { status: 200 });
    });
    const { service } = serviceWith({ budget: budget.port });

    const result = await run(service, "testConnection", "whatsapp", ADMIN);

    expect(result.ok).toBe(true);
    expect(order).toEqual(["user-slot", `org-slot:${ORG}:whatsapp`, "provider"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses over the caller's limit before the provider is called", async () => {
    const { service } = serviceWith({ budget: recordingBudget({ user: 1 }).port });
    expect((await run(service, "testConnection", "whatsapp", OWNER)).ok).toBe(true);
    const second = await run(service, "testConnection", "whatsapp", OWNER);
    expect(second).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses over the Organization's limit before the provider is called — for every member alike", async () => {
    const { service } = serviceWith({ budget: recordingBudget({ organization: 2 }).port });
    expect((await run(service, "testConnection", "whatsapp", OWNER)).ok).toBe(true);
    expect((await run(service, "testConnection", "whatsapp", ADMIN)).ok).toBe(true);
    const third = await run(service, "testConnection", "whatsapp", OWNER);
    expect(third).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(!third.ok && third.message).toMatch(/Your organization has tested WhatsApp Business/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("never lets one Organization spend another's budget", async () => {
    // ORG owns WhatsApp; OTHER owns n8n. Each is the other's outsider.
    const tenancy = organization();
    tenancy.setOwner("n8n", "rest", OTHER);
    const budget = recordingBudget({ organization: 1 });
    const { service } = serviceWith({ tenancy, budget: budget.port });

    expect((await run(service, "testConnection", "whatsapp", OWNER)).ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // ORG's window for WhatsApp is now full. OTHER's owner cannot touch it…
    expect(await run(service, "testConnection", "whatsapp", OUTSIDER)).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // …and OTHER's own n8n window is untouched by ORG's use: its test reaches
    // the provider, spending OTHER's slot and nobody else's.
    await run(service, "testConnection", "n8n", OUTSIDER);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    expect(budget.taken.filter((k) => k.startsWith("org:"))).toEqual([`org:${ORG}:whatsapp`, `org:${OTHER}:n8n`]);
    // And ORG cannot test OTHER's n8n at all.
    const before = fetchSpy.mock.calls.length;
    expect(await run(service, "testConnection", "n8n", OWNER)).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fetchSpy.mock.calls.length).toBe(before);
  });

  it("runs no test that reaches a provider when no budget is wired", async () => {
    const { service } = serviceWith({ budget: null });
    const result = await run(service, "testConnection", "whatsapp", OWNER);
    expect(result).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers a sentence exactly as it answers a button: the same refusal, the same zero calls", async () => {
    const { service, servers } = serviceWith();
    const tool = createIntegrationTools({ execute: (input, context) => service.execute(input, context) }).find(
      (t) => t.id === "integration.test"
    );
    expect(tool).toBeDefined();
    const button = await run(service, "testConnection", "mcp", OUTSIDER);
    const sentence = await tool!.execute({ integration: "mcp" }, { userId: OUTSIDER });
    expect(button.ok).toBe(false);
    expect(JSON.stringify(sentence)).toContain(!button.ok ? button.message : "");
    expect(servers.verify).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L11 — what a view shows
// ---------------------------------------------------------------------------

const viewOf = async (service: IntegrationCommandService, id: IntegrationId, userId: string): Promise<IntegrationView> => {
  const result = await run(service, "status", id, userId);
  if (!result.ok) throw new Error(`status refused: ${result.code}`);
  return result.data as IntegrationView;
};

describe("L11 — a shared integration shows its Organization what it may see, and nobody else anything", () => {
  it.each(SHARED)("an outsider's view of %s is the same whether it is configured or not", async (id) => {
    const configured = await viewOf(serviceWith().service, id, OUTSIDER);
    configureNothing();
    const unconfigured = await viewOf(serviceWith().service, id, OUTSIDER);
    expect(configured).toEqual(unconfigured);
    expect(configured.account).toBeNull();
    expect(configured.lastError).toBeNull();
    expect(configured.usage).toBeNull();
  });

  it("puts no operator identifier and no secret in front of an outsider — in the list or in any view", async () => {
    const { service } = serviceWith();
    const list = await service.execute({ command: "list", integration: null }, as(OUTSIDER));
    const views = await Promise.all(SHARED.map((id) => viewOf(service, id, OUTSIDER)));
    const text = JSON.stringify([list, views]);
    for (const value of [...IDENTIFIERS, ...SECRETS]) expect(text, value).not.toContain(value);
  });

  it.each([
    ["member", MEMBER],
    ["viewer", VIEWER],
  ])("shows a %s status without diagnostics, and no Test it cannot run", async (_role, userId) => {
    const { service } = serviceWith();
    for (const id of SERVER_MANAGED) {
      const view = await viewOf(service, id, userId);
      expect(view.account, id).toBeNull();
      expect(view.lastError, id).toBeNull();
      expect(view.usage, id).toBeNull();
      expect(view.config, id).toEqual([]);
      expect(view.supportedCommands, id).not.toContain("testConnection");
      expect(view.effectiveSource, id).toBe("your organization");
      const text = JSON.stringify(view);
      for (const value of [...IDENTIFIERS, ...SECRETS]) expect(text, `${id} ${value}`).not.toContain(value);
    }
  });

  it.each([
    ["owner", OWNER],
    ["admin", ADMIN],
  ])("keeps every diagnostic for an %s of the owning Organization", async (_role, userId) => {
    const { service } = serviceWith();
    expect((await viewOf(service, "whatsapp", userId)).account?.label).toContain("5550001112223");
    expect((await viewOf(service, "n8n", userId)).account?.label).toContain("n8n.example.test");
    expect((await viewOf(service, "meta", userId)).account?.label).toBe("act_999");
    expect((await viewOf(service, "google-maps", userId)).usage).toMatchObject({ used: 4100 });
    expect((await viewOf(service, "mcp", userId)).detail).toContain("docs-reviewed");
    expect((await viewOf(service, "whatsapp", userId)).supportedCommands).toContain("testConnection");
    // Never a secret, whoever reads it.
    const text = JSON.stringify(await Promise.all(SHARED.map((id) => viewOf(service, id, userId))));
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
  });

  it("fails closed to the outsider's view when ownership or membership cannot be read", async () => {
    const tenancy = organization();
    tenancy.setFailing(true);
    const { service } = serviceWith({ tenancy });
    const failing = await viewOf(service, "n8n", OWNER);
    const outsider = await viewOf(serviceWith().service, "n8n", OUTSIDER);
    expect(failing).toEqual(outsider);
  });

  it("tells an outsider nothing is granted — exactly as on a deployment with none of it", async () => {
    const { service } = serviceWith();
    const outsider = await service.execute({ command: "getPermissions", integration: "whatsapp" }, as(OUTSIDER));
    expect(outsider).toMatchObject({ ok: true, data: { permissions: [], grantedCount: 0 } });
    const meta = await service.execute({ command: "getPermissions", integration: "meta" }, as(OUTSIDER));
    configureNothing();
    const metaUnconfigured = await serviceWith().service.execute({ command: "getPermissions", integration: "meta" }, as(OWNER));
    expect(meta.ok && meta.data).toEqual(metaUnconfigured.ok && metaUnconfigured.data);
  });

  it("keeps a user's OWN Meta credentials theirs: their stored account, their own test", async () => {
    const own: CredentialPort = {
      read: async (_u, provider) => (provider === "meta" ? { accessToken: "MY-OWN-TOKEN", adAccountId: "act_424242424" } : null),
      write: async () => {},
      remove: async () => {},
    };
    const { service } = serviceWith({ credentials: own });
    const view = await viewOf(service, "meta", OUTSIDER);
    expect(view.account?.label).toBe("act_424242424");
    expect(JSON.stringify(view)).not.toContain("act_999");
  });
});

describe("H2 at the Integration Control Center — a write is refused before it is confirmed", () => {
  it("refuses a member's Meta action before any confirmation is issued", async () => {
    const issue = vi.fn();
    const { service } = serviceWith({ confirmations: { issue, consume: vi.fn() } as never, executor: { execute: vi.fn() } as never });
    const action = (await viewOf(service, "meta", OWNER)).actions.find((a) => a.id === "meta.campaign.pause");
    expect(action, "the catalogue's Meta pause action").toMatchObject({ writesExternally: true });
    const result = await service.execute(
      { command: "executeAction", integration: "meta", actionId: action!.id, actionParams: {} },
      as(MEMBER, "member")
    );
    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(!result.ok && result.message).toMatch(/does not allow changes through Meta Ads/);
    expect(issue).not.toHaveBeenCalled();
  });

  it("refuses an outsider's Meta action as on a deployment without Meta — before any confirmation", async () => {
    const issue = vi.fn();
    const { service } = serviceWith({ confirmations: { issue, consume: vi.fn() } as never, executor: { execute: vi.fn() } as never });
    const result = await service.execute(
      { command: "executeAction", integration: "meta", actionId: "meta.campaign.pause", actionParams: {} },
      as(OUTSIDER)
    );
    expect(result).toMatchObject({ ok: false, code: "NOT_CONNECTED" });
    expect(issue).not.toHaveBeenCalled();
  });
});
