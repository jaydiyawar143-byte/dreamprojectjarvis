// ---------------------------------------------------------------------------
// The write boundary, and the progressive-permission model.
//
// Two rules are pinned here, and they are the two that stop this system from
// being dangerous:
//
//   1. NOTHING THAT CHANGES THE OUTSIDE WORLD HAPPENS BECAUSE A SENTENCE
//      SOUNDED LIKE A REQUEST. An external write is described, confirmed, and
//      only then executed — and the confirmation is bound to the exact
//      parameters that were described, so it cannot be reused for anything
//      else. A voice session, which cannot show the user what they are
//      agreeing to, cannot confirm at all.
//
//   2. CONNECTING DOES NOT GRANT EVERYTHING. An initial Google connection
//      requests read scopes for the services the user picked and nothing more.
//      There is no argument anywhere in the connect path that can ask for a
//      write scope, and the test below proves that by trying.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  GOOGLE_SERVICES,
  scopesForConnect,
  scopesForWriteUpgrade,
  servicesFromGrantedScopes,
  hasWriteAccess,
  describeScope,
  resolveIntegrationAlias,
  resolveGoogleServiceAlias,
  type IToolExecutor,
} from "@jarvis/core";
import {
  IntegrationCommandService,
  type CredentialPort,
  type IntegrationStatePort,
  type RateLimitPort,
} from "../src/services/integrations/command-service.js";
import {
  __resetConfirmations,
  consumeConfirmation,
  issueConfirmation,
} from "../src/services/integrations/confirmations.js";
import { __resetIntegrationChecks } from "../src/services/integration-registry.js";

// ---------------------------------------------------------------------------

function credentialStore(seed: Record<string, Record<string, string>> = {}): CredentialPort {
  const data = { ...seed };
  return {
    async read(_u, p) {
      return data[p] ? { ...data[p] } : null;
    },
    async write(_u, p, v) {
      data[p] = { ...v };
    },
    async remove(_u, p) {
      delete data[p];
    },
  };
}

function stateStore(): IntegrationStatePort {
  const rows = new Map<string, { enabled: boolean; enabledServices: string[]; lastSuccessfulSyncAt: string | null }>();
  const fresh = () => ({ enabled: true, enabledServices: [], lastSuccessfulSyncAt: null });
  return {
    async get(u, i) {
      return { ...(rows.get(`${u}:${i}`) ?? fresh()) };
    },
    async patch(u, i, c) {
      const next = { ...(rows.get(`${u}:${i}`) ?? fresh()), ...c };
      rows.set(`${u}:${i}`, next);
      return { ...next };
    },
    async clear(u, i) {
      rows.delete(`${u}:${i}`);
    },
  };
}

const allowAll: RateLimitPort = {
  async check(_u, _b, limit) {
    return { allowed: true, currentCount: 0, limit };
  },
};

function auditLogger() {
  const rows: Array<{ action: string; result: string; metadata?: Record<string, unknown> }> = [];
  return { rows, log: vi.fn(async (e: never) => void rows.push(e)), query: vi.fn(async () => []) };
}

/** Records what reached the execution authority. Runs nothing. */
function fakeExecutor() {
  const executed: Array<{ toolId: string; params: Record<string, unknown> }> = [];
  const executor: IToolExecutor = {
    async execute(request) {
      executed.push({ toolId: request.toolId, params: request.params });
      return {
        executionId: "exec-1",
        toolId: request.toolId,
        status: "completed",
        result: { success: true, data: { done: true } },
        startedAt: new Date(),
        completedAt: new Date(),
      };
    },
  };
  return { executor, executed };
}

function serviceWith(executor?: IToolExecutor) {
  const audit = auditLogger();
  const service = new IntegrationCommandService({
    // Meta connected, so executeAction gets past the connection check and the
    // test is actually exercising the write gate rather than a missing setup.
    credentials: credentialStore({ meta: { accessToken: "t", adAccountId: "act_1" } }),
    state: stateStore(),
    audit: audit as never,
    rateLimiter: allowAll,
    googleConnections: null,
    oauthStates: null,
    googleConfig: () => null,
    mapsUsage: async () => null,
    ...(executor ? { executor } : {}),
  });
  return { service, audit };
}

beforeEach(() => {
  __resetConfirmations();
  __resetIntegrationChecks();
});

// ---------------------------------------------------------------------------

describe("external writes stop for confirmation", () => {
  it("refuses a budget change on the first ask and explains what it would do", async () => {
    const { executor, executed } = fakeExecutor();
    const { service } = serviceWith(executor);

    const result = await service.execute(
      {
        command: "executeAction",
        integration: "meta",
        actionId: "meta.campaign.budget.update",
        actionParams: { campaignId: "c-123", dailyBudget: 5000 },
      },
      { userId: "u1", source: "frontend" }
    );

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("CONFIRMATION_REQUIRED");

    // Nothing reached the executor. A "confirm first" that had already run the
    // action would be theatre.
    expect(executed).toHaveLength(0);

    // The summary names the SPECIFIC target: "confirm this action?" is not a
    // question anyone can answer correctly.
    const confirmation = (result as { confirmationRequired?: { summary: string; token: string } })
      .confirmationRequired;
    expect(confirmation).toBeDefined();
    expect(confirmation!.summary).toContain("c-123");
    expect(confirmation!.summary).toContain("5000");
  });

  it("runs it once the confirmation is echoed back", async () => {
    const { executor, executed } = fakeExecutor();
    const { service } = serviceWith(executor);

    const params = { campaignId: "c-123", dailyBudget: 5000 };
    const first = await service.execute(
      { command: "executeAction", integration: "meta", actionId: "meta.campaign.budget.update", actionParams: params },
      { userId: "u1", source: "frontend" }
    );
    const token = (first as { confirmationRequired: { token: string } }).confirmationRequired.token;

    const second = await service.execute(
      {
        command: "executeAction",
        integration: "meta",
        actionId: "meta.campaign.budget.update",
        actionParams: params,
        confirmationToken: token,
      },
      { userId: "u1", source: "frontend" }
    );

    expect(second.ok).toBe(true);
    expect(executed).toHaveLength(1);
    // It went through the ONE execution authority, not around it.
    expect(executed[0]!.toolId).toBe("meta.campaign.budget.update");
  });

  it("does NOT gate a read action", async () => {
    const { executor, executed } = fakeExecutor();
    const { service } = serviceWith(executor);

    const result = await service.execute(
      { command: "executeAction", integration: "meta", actionId: "meta.campaigns", actionParams: {} },
      { userId: "u1", source: "frontend" }
    );

    expect(result.ok).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it("refuses a voice session outright rather than confirming by speech", async () => {
    const { executor, executed } = fakeExecutor();
    const { service } = serviceWith(executor);

    const result = await service.execute(
      {
        command: "executeAction",
        integration: "meta",
        actionId: "meta.campaign.pause",
        actionParams: { campaignId: "c-9" },
      },
      { userId: "u1", source: "jarvis", voice: true }
    );

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("CONFIRMATION_REQUIRED");
    // No token is issued at all — speech is a fine way to ASK for a write and
    // not a fine way to authorize one.
    expect((result as { confirmationRequired?: unknown }).confirmationRequired).toBeUndefined();
    expect((result as { message: string }).message).toMatch(/voice/i);
    expect(executed).toHaveLength(0);
  });

  it("reports when there is no executor wired instead of pretending to act", async () => {
    const { service } = serviceWith();

    const result = await service.execute(
      { command: "executeAction", integration: "meta", actionId: "meta.campaigns", actionParams: {} },
      { userId: "u1", source: "frontend" }
    );

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("UNSUPPORTED_COMMAND");
  });
});

// ---------------------------------------------------------------------------

describe("a confirmation is bound to what was described", () => {
  it("cannot be replayed against different parameters", async () => {
    const { executor, executed } = fakeExecutor();
    const { service } = serviceWith(executor);

    const first = await service.execute(
      {
        command: "executeAction",
        integration: "meta",
        actionId: "meta.campaign.pause",
        actionParams: { campaignId: "campaign-A" },
      },
      { userId: "u1", source: "frontend" }
    );
    const token = (first as { confirmationRequired: { token: string } }).confirmationRequired.token;

    // Same token, DIFFERENT campaign. This is the attack the binding exists for.
    const replay = await service.execute(
      {
        command: "executeAction",
        integration: "meta",
        actionId: "meta.campaign.pause",
        actionParams: { campaignId: "campaign-B" },
        confirmationToken: token,
      },
      { userId: "u1", source: "frontend" }
    );

    expect(replay.ok).toBe(false);
    expect((replay as { message: string }).message).toMatch(/different action or different parameters/i);
    expect(executed).toHaveLength(0);
  });

  it("is single use", async () => {
    const params = { campaignId: "c-1" };
    const confirmation = issueConfirmation({
      userId: "u1",
      integration: "meta",
      actionId: "meta.campaign.pause",
      params,
      summary: "Pause campaign c-1",
      irreversible: true,
    });

    const first = consumeConfirmation({
      token: confirmation.token,
      userId: "u1",
      integration: "meta",
      actionId: "meta.campaign.pause",
      params,
    });
    const second = consumeConfirmation({
      token: confirmation.token,
      userId: "u1",
      integration: "meta",
      actionId: "meta.campaign.pause",
      params,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("cannot be used by a different user", async () => {
    const params = { campaignId: "c-1" };
    const confirmation = issueConfirmation({
      userId: "owner",
      integration: "meta",
      actionId: "meta.campaign.pause",
      params,
      summary: "Pause campaign c-1",
      irreversible: true,
    });

    const stolen = consumeConfirmation({
      token: confirmation.token,
      userId: "attacker",
      integration: "meta",
      actionId: "meta.campaign.pause",
      params,
    });

    expect(stolen.ok).toBe(false);
    expect(stolen).toMatchObject({ reason: "mismatch" });
  });

  it("matches regardless of the order the parameters were serialised in", async () => {
    // The UI and the model will not serialise an object identically. If key
    // order changed the hash, a confirmation issued on one path would never
    // validate on the other — and the two-path parity would break on exactly
    // the actions that matter most.
    const confirmation = issueConfirmation({
      userId: "u1",
      integration: "meta",
      actionId: "meta.campaign.budget.update",
      params: { campaignId: "c-1", dailyBudget: 100 },
      summary: "x",
      irreversible: true,
    });

    const consumed = consumeConfirmation({
      token: confirmation.token,
      userId: "u1",
      integration: "meta",
      actionId: "meta.campaign.budget.update",
      params: { dailyBudget: 100, campaignId: "c-1" },
    });

    expect(consumed.ok).toBe(true);
  });

  it("rejects an unknown token", () => {
    expect(
      consumeConfirmation({
        token: "made-up",
        userId: "u1",
        integration: "meta",
        actionId: "meta.campaign.pause",
        params: {},
      })
    ).toMatchObject({ ok: false, reason: "unknown" });
  });
});

// ---------------------------------------------------------------------------

describe("progressive Google permissions", () => {
  it("requests READ scopes only when connecting", () => {
    const scopes = scopesForConnect(["gmail", "drive", "youtube"]);

    for (const service of GOOGLE_SERVICES) {
      for (const writeScope of service.writeScopes) {
        expect(scopes, `${writeScope} must not be requested at connect`).not.toContain(writeScope);
      }
    }

    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(scopes).toContain("https://www.googleapis.com/auth/drive.readonly");
  });

  it("does not request every Google scope for a single-service connection", () => {
    const adsOnly = scopesForConnect(["ads"]);

    expect(adsOnly).toContain("https://www.googleapis.com/auth/adwords");
    expect(adsOnly).not.toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(adsOnly).not.toContain("https://www.googleapis.com/auth/drive.readonly");
    // Identity is always present — it is what names the account so it can be
    // shown and revoked — and grants no data access.
    expect(adsOnly).toContain("openid");
  });

  it("silently drops an unknown service rather than sending it to Google", () => {
    const scopes = scopesForConnect(["ads", "nonsense-service"]);
    expect(scopes).toContain("https://www.googleapis.com/auth/adwords");
    expect(scopes.some((s) => s.includes("nonsense"))).toBe(false);
  });

  it("adds a write scope only through the explicit upgrade path", () => {
    const upgraded = scopesForWriteUpgrade(["gmail"]);
    // `gmail.compose`, not `gmail.send`: Phase 13 corrected this because
    // `gmail.send` cannot create or update a draft, so the draft actions would
    // have failed on it with a 403 that looks like a bug. `compose` is the
    // narrowest scope covering create + update + send.
    expect(upgraded).toContain("https://www.googleapis.com/auth/gmail.compose");
    // And the upgrade keeps the read scope, so an upgrade is not a downgrade.
    expect(upgraded).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("uses the narrow Drive scope for reading, not the one that permits deletion", () => {
    const drive = GOOGLE_SERVICES.find((s) => s.id === "drive")!;
    expect(drive.readScopes).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
    expect(drive.readScopes).not.toContain("https://www.googleapis.com/auth/drive");
  });

  it("derives enabled services from GRANTED scopes, never from what was asked for", () => {
    // Google may grant fewer scopes than requested. Trusting the request is how
    // a system claims access it does not have and then 403s inexplicably.
    const granted = ["openid", "email", "https://www.googleapis.com/auth/adwords"];
    expect(servicesFromGrantedScopes(granted)).toEqual(["ads"]);
    expect(servicesFromGrantedScopes(granted)).not.toContain("gmail");
  });

  it("reports write access only when every write scope is present", () => {
    expect(hasWriteAccess("gmail", ["https://www.googleapis.com/auth/gmail.readonly"])).toBe(false);
    expect(
      hasWriteAccess("gmail", [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ])
    ).toBe(true);
  });

  it("describes each scope in plain English with its access level", () => {
    expect(describeScope("https://www.googleapis.com/auth/gmail.readonly")).toMatchObject({
      access: "read",
      service: "gmail",
    });
    expect(describeScope("https://www.googleapis.com/auth/gmail.compose")).toMatchObject({
      access: "write",
      service: "gmail",
    });
  });

  it("shows an unrecognised scope rather than hiding it", () => {
    // A token carrying a permission this build does not know about is exactly
    // what an operator needs to see.
    const described = describeScope("https://www.googleapis.com/auth/some-future-api");
    expect(described.label).toContain("some-future-api");
  });

  it("says which Google services actually have tools in this repository", () => {
    // The honesty rule cuts both ways, and Phase 12 moved three services
    // across it: Gmail, Drive and Calendar now HAVE clients, so claiming they
    // are unimplemented would under-claim exactly as badly as the old build
    // over-claimed. Sheets, Docs and YouTube still have none.
    const implemented = (id: string) => GOOGLE_SERVICES.find((s) => s.id === id)!.implemented;

    expect(implemented("ads")).toBe(true);
    // Phase 12.
    expect(implemented("gmail")).toBe(true);
    expect(implemented("drive")).toBe(true);
    expect(implemented("calendar")).toBe(true);

    // Not built. Still reported as planned.
    expect(implemented("sheets")).toBe(false);
    expect(implemented("docs")).toBe(false);
    expect(implemented("youtube")).toBe(false);
  });

  it("keeps every implemented service READ-ONLY in this phase", () => {
    // Phase 12 requested no write scopes. The write scopes are declared in the
    // catalogue for a future phase, but nothing requests them — asserted in
    // the progressive-permission tests above.
    for (const id of ["gmail", "drive", "calendar"]) {
      const service = GOOGLE_SERVICES.find((s) => s.id === id)!;
      expect(service.readScopes.length, id).toBeGreaterThan(0);
      expect(service.readScopes.every((s) => s.includes("readonly")), id).toBe(true);
    }
  });

  it("records that Google Ads needs more than OAuth consent", () => {
    // Gmail OAuth alone is not enough for Ads: it needs a developer token and a
    // customer id, and pretending otherwise produces a connection that 401s on
    // first use.
    const ads = GOOGLE_SERVICES.find((s) => s.id === "ads")!;
    expect(ads.extraConfig).toContain("adsDeveloperToken");
    expect(ads.extraConfig).toContain("adsCustomerId");
  });
});

// ---------------------------------------------------------------------------

describe("natural-language resolution", () => {
  it("maps the spec's phrasings onto integrations", () => {
    expect(resolveIntegrationAlias("Google account")).toBe("google");
    expect(resolveIntegrationAlias("Gmail connection")).toBe("google");
    expect(resolveIntegrationAlias("Drive")).toBe("google");
    expect(resolveIntegrationAlias("Google Ads accounts")).toBe("google");
    expect(resolveIntegrationAlias("YouTube integration")).toBe("google");
    expect(resolveIntegrationAlias("Google Maps API configuration")).toBe("google-maps");
  });

  it("prefers Maps over Google for a maps phrase", () => {
    expect(resolveIntegrationAlias("google maps")).toBe("google-maps");
    expect(resolveIntegrationAlias("naksha")).toBe("google-maps");
  });

  it("returns null for something this system does not manage", () => {
    expect(resolveIntegrationAlias("dropbox")).toBeNull();
    expect(resolveIntegrationAlias("")).toBeNull();
  });

  it("identifies the Google sub-service when one is named", () => {
    expect(resolveGoogleServiceAlias("gmail test karo")).toBe("gmail");
    expect(resolveGoogleServiceAlias("drive ka status")).toBe("drive");
    expect(resolveGoogleServiceAlias("youtube reconnect")).toBe("youtube");
    // A bare "google" names no service, and guessing one would be wrong.
    expect(resolveGoogleServiceAlias("google")).toBeNull();
  });
});
