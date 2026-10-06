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
  CONFIRMATION_TTL_MS,
  createConfirmationService,
  type ConfirmationPort,
} from "../src/services/integrations/confirmations.js";
import { __resetIntegrationChecks } from "../src/services/integration-registry.js";
import type { ErrorMonitor } from "../src/services/observability/error-monitor.js";
import { memoryConfirmationStore } from "./helpers/memory-confirmation-store.js";

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

/** A confirmation service over a fresh in-memory store. Nothing is shared between tests. */
function freshConfirmations(now?: () => Date): ConfirmationPort {
  return createConfirmationService(memoryConfirmationStore().store, now ? { now } : {});
}

/**
 * `confirmations: null` builds the service with NO confirmation store, which is
 * what a mis-wired deployment would look like.
 */
function serviceWith(
  executor?: IToolExecutor,
  options: {
    confirmations?: ConfirmationPort | null;
    monitor?: ErrorMonitor;
    rateLimiter?: RateLimitPort;
    state?: IntegrationStatePort;
  } = {}
) {
  const audit = auditLogger();
  const confirmations =
    options.confirmations === undefined ? freshConfirmations() : options.confirmations;
  const service = new IntegrationCommandService({
    // Meta connected, so executeAction gets past the connection check and the
    // test is actually exercising the write gate rather than a missing setup.
    credentials: credentialStore({ meta: { accessToken: "t", adAccountId: "act_1" } }),
    state: options.state ?? stateStore(),
    audit: audit as never,
    rateLimiter: options.rateLimiter ?? allowAll,
    googleConnections: null,
    oauthStates: null,
    googleConfig: () => null,
    mapsUsage: async () => null,
    ...(confirmations ? { confirmations } : {}),
    ...(options.monitor ? { monitor: options.monitor } : {}),
    ...(executor ? { executor } : {}),
  });
  return { service, audit };
}

/** An error monitor that records what it was told. */
function recordingMonitor() {
  const captured: Array<{ error: unknown; context?: Record<string, unknown> }> = [];
  const monitor: ErrorMonitor = {
    captureException: (error, options) =>
      void captured.push({ error, ...(options?.context ? { context: options.context } : {}) }),
    captureMessage: () => undefined,
  };
  return { monitor, captured };
}

beforeEach(() => {
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
    const confirmations = freshConfirmations();
    const params = { campaignId: "c-1" };
    const confirmation = await confirmations.issue({
      userId: "u1",
      integration: "meta",
      actionId: "meta.campaign.pause",
      params,
      summary: "Pause campaign c-1",
      irreversible: true,
    });

    const first = await confirmations.consume({
      token: confirmation.token,
      userId: "u1",
      integration: "meta",
      actionId: "meta.campaign.pause",
      params,
    });
    const second = await confirmations.consume({
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
    const confirmations = freshConfirmations();
    const params = { campaignId: "c-1" };
    const confirmation = await confirmations.issue({
      userId: "owner",
      integration: "meta",
      actionId: "meta.campaign.pause",
      params,
      summary: "Pause campaign c-1",
      irreversible: true,
    });

    const stolen = await confirmations.consume({
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
    const confirmations = freshConfirmations();
    const confirmation = await confirmations.issue({
      userId: "u1",
      integration: "meta",
      actionId: "meta.campaign.budget.update",
      params: { campaignId: "c-1", dailyBudget: 100 },
      summary: "x",
      irreversible: true,
    });

    const consumed = await confirmations.consume({
      token: confirmation.token,
      userId: "u1",
      integration: "meta",
      actionId: "meta.campaign.budget.update",
      params: { dailyBudget: 100, campaignId: "c-1" },
    });

    expect(consumed.ok).toBe(true);
  });

  it("rejects an unknown token", async () => {
    expect(
      await freshConfirmations().consume({
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
// Phase 13 — the confirmation is durable state now, and the gate has to stay
// shut whenever that state cannot vouch for a write.
// ---------------------------------------------------------------------------

describe("the write gate fails closed", () => {
  const pause = {
    command: "executeAction" as const,
    integration: "meta" as const,
    actionId: "meta.campaign.pause",
    actionParams: { campaignId: "c-77" },
  };
  const frontend = { userId: "u1", source: "frontend" as const };

  it("refuses an external write when no confirmation store is wired", async () => {
    const { executor, executed } = fakeExecutor();
    const { service } = serviceWith(executor, { confirmations: null });

    const result = await service.execute(pause, frontend);

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("UNSUPPORTED_COMMAND");
    // No token is handed out for a confirmation that could never be honoured.
    expect((result as { confirmationRequired?: unknown }).confirmationRequired).toBeUndefined();
    expect(executed).toHaveLength(0);
  });

  it("refuses it even when a token is supplied, with no store to check it against", async () => {
    const { executor, executed } = fakeExecutor();
    const { service } = serviceWith(executor, { confirmations: null });

    const result = await service.execute({ ...pause, confirmationToken: "anything" }, frontend);

    expect(result.ok).toBe(false);
    expect(executed).toHaveLength(0);
  });

  it("still runs a read action without a confirmation store", async () => {
    const { executor, executed } = fakeExecutor();
    const { service } = serviceWith(executor, { confirmations: null });

    const result = await service.execute(
      { command: "executeAction", integration: "meta", actionId: "meta.campaigns", actionParams: {} },
      frontend
    );

    expect(result.ok).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it("does not ask for confirmation when the store cannot record one", async () => {
    const { executor, executed } = fakeExecutor();
    const { service, audit } = serviceWith(executor, {
      confirmations: {
        issue: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
        },
        consume: async () => ({ ok: true }),
      },
    });

    const result = await service.execute(pause, frontend);

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("INTERNAL_ERROR");
    // The driver's text names a host and a port; none of it reaches the caller.
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
    expect(executed).toHaveLength(0);
    expect(audit.rows.at(-1)).toMatchObject({ action: "integration.executeAction", result: "failure" });
  });

  it("does not run the write when the store cannot verify the token", async () => {
    const { executor, executed } = fakeExecutor();
    const { service } = serviceWith(executor, {
      confirmations: {
        issue: freshConfirmations().issue,
        consume: async () => {
          throw new Error("connection reset");
        },
      },
    });

    const result = await service.execute({ ...pause, confirmationToken: "anything" }, frontend);

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("INTERNAL_ERROR");
    expect(executed).toHaveLength(0);
  });

  it("reports a failure nobody expected to the error monitor — once, by identifier only", async () => {
    const { executor, executed } = fakeExecutor();
    const { monitor, captured } = recordingMonitor();
    const { service, audit } = serviceWith(executor, {
      monitor,
      confirmations: {
        issue: freshConfirmations().issue,
        consume: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
        },
      },
    });
    // The audit trail is unreachable too: the monitor is then the ONLY record.
    audit.log.mockRejectedValue(new Error("audit store is down"));

    const result = await service.execute(
      { ...pause, actionParams: { campaignId: "c-PRIVATE-77" }, confirmationToken: "tok-PRIVATE-88" },
      { ...frontend, traceId: "trace-9" }
    );

    expect((result as { code: string }).code).toBe("INTERNAL_ERROR");
    expect(executed).toHaveLength(0);
    expect(captured).toHaveLength(1);
    expect((captured[0]!.error as Error).message).toBe("connect ECONNREFUSED 10.0.0.5:5432");
    expect(captured[0]!.context).toEqual({
      component: "integrations",
      command: "executeAction",
      integration: "meta",
      traceId: "trace-9",
    });
    // Identifiers only: nothing the user sent rides along.
    expect(JSON.stringify(captured[0]!.context)).not.toMatch(/PRIVATE/);
  });

  // With the database down, the FIRST thing that fails is the rate limiter: it
  // counts audit rows. A command that rejected there left the HTTP request with
  // no answer at all. The entry point always answers.
  it("answers — and runs nothing — when the rate limiter cannot be asked", async () => {
    const { executor, executed } = fakeExecutor();
    const { monitor, captured } = recordingMonitor();
    const { service } = serviceWith(executor, {
      monitor,
      rateLimiter: {
        check: async () => {
          throw new Error("Server has closed the connection.");
        },
      },
    });

    const result = await service.execute(pause, frontend);

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("INTERNAL_ERROR");
    expect((result as { confirmationRequired?: unknown }).confirmationRequired).toBeUndefined();
    expect(executed).toHaveLength(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.context).toMatchObject({ command: "executeAction", integration: "meta" });
  });

  it("answers when the list of integrations cannot be read", async () => {
    const { monitor, captured } = recordingMonitor();
    const broken: IntegrationStatePort = {
      get: async () => {
        throw new Error("Server has closed the connection.");
      },
      patch: async () => {
        throw new Error("Server has closed the connection.");
      },
      clear: async () => undefined,
    };
    const { service } = serviceWith(undefined, { monitor, state: broken });

    const result = await service.execute({ command: "list", integration: null }, frontend);

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(result)).not.toContain("closed the connection");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.context).toEqual({ component: "integrations", command: "list" });
  });

  it("does not report an ordinary refusal to the error monitor", async () => {
    const { executor } = fakeExecutor();
    const { monitor, captured } = recordingMonitor();
    const { service } = serviceWith(executor, { monitor });

    // Asked without a confirmation, then confirmed with a made-up token, then by voice.
    await service.execute(pause, frontend);
    await service.execute({ ...pause, confirmationToken: "made-up" }, frontend);
    const spoken = await service.execute(pause, { userId: "u1", source: "jarvis", voice: true });

    expect((spoken as { message: string }).message).toMatch(/voice/i);
    expect(captured).toHaveLength(0);
  });

  it("runs a double-submitted confirmation exactly once", async () => {
    const { executor, executed } = fakeExecutor();
    const { service } = serviceWith(executor);

    const first = await service.execute(pause, frontend);
    const token = (first as { confirmationRequired: { token: string } }).confirmationRequired.token;

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => service.execute({ ...pause, confirmationToken: token }, frontend))
    );

    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
    expect(executed).toHaveLength(1);
    for (const refused of attempts.filter((attempt) => !attempt.ok)) {
      expect((refused as { code: string }).code).toBe("CONFIRMATION_REQUIRED");
    }
  });

  it("says a confirmation has expired, and does not run it", async () => {
    const { executor, executed } = fakeExecutor();
    let current = new Date("2026-10-06T08:00:00.000Z");
    const { service } = serviceWith(executor, { confirmations: freshConfirmations(() => current) });

    const first = await service.execute(pause, frontend);
    const token = (first as { confirmationRequired: { token: string } }).confirmationRequired.token;

    current = new Date(current.getTime() + CONFIRMATION_TTL_MS);
    const late = await service.execute({ ...pause, confirmationToken: token }, frontend);

    expect(late.ok).toBe(false);
    expect((late as { message: string }).message).toMatch(/has expired/i);
    expect(executed).toHaveLength(0);
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
