import { describe, it, expect, vi } from "vitest";
import type { Router } from "express";
import { randomBytes } from "node:crypto";

import { EncryptionService, parseKey, ToolApprovalService, PermissionService } from "@jarvis/security";
import {
  GoogleGetAccountsTool,
  GoogleGetCampaignsTool,
  GoogleGetInsightsTool,
  MockGoogleAdsProvider,
  WhatsAppSendMessageTool,
  MockWhatsAppProvider,
  N8nTriggerWorkflowTool,
  MockN8nProvider,
  mockKeyDeriver,
} from "@jarvis/tools";
import { createGoogleConfig, GOOGLE_ADS_SCOPE } from "@jarvis/google-ads";
import { createWhatsAppConfig, signPayload } from "@jarvis/whatsapp";
import { createN8nConfig, signCallback, validateWebhookPath, buildWebhookUrl } from "@jarvis/n8n";
import type { ITool, ToolContext } from "@jarvis/core";

import { createGoogleAuthRouter } from "../src/routes/google-auth.js";
import { createWhatsAppRouter } from "../src/routes/whatsapp.js";
import { createN8nRouter } from "../src/routes/n8n.js";

// ---------------------------------------------------------------------------
// Sprint 5 Final Integration UAT
// ---------------------------------------------------------------------------
// Exercises Google Ads, WhatsApp Cloud API and n8n as ONE system, with a shared
// two-tenant fixture. The point is not to re-run each sprint's unit tests but
// to check the properties that only appear when the three run together:
// cross-integration tenant isolation, a uniform approval boundary, and the
// absence of secret leakage across every response surface.
//
// No live third-party credentials, no network, no database.
// ---------------------------------------------------------------------------

// Two tenants used consistently across all three integrations.
const ALICE = "user-alice";
const BOB = "user-bob";
const TOKEN_ALICE = "uat-token-alice";
const TOKEN_BOB = "uat-token-bob";

// Synthetic secrets. Every assertion about leakage checks for these values.
const SECRETS = {
  googleClientSecret: "UAT-google-client-secret",
  googleAccessToken: "ya29.UAT-google-access",
  googleRefreshToken: "1//UAT-google-refresh",
  googleDeveloperToken: "UAT-google-developer-token",
  waAccessToken: "EAAUATwhatsappaccesstoken",
  waAppSecret: "UAT-whatsapp-app-secret",
  waVerifyToken: "UAT-whatsapp-verify-token",
  n8nApiKey: "UAT-n8n-api-key",
  n8nCallbackSecret: "UAT-n8n-callback-secret",
};

const ALL_SECRET_VALUES = Object.values(SECRETS);

const encryption = new EncryptionService([parseKey(1, randomBytes(32).toString("base64"))]);

const googleConfig = createGoogleConfig({
  clientId: "uat-client-id",
  clientSecret: SECRETS.googleClientSecret,
  redirectUri: "https://jarvis.uat/api/v1/google/callback",
  developerToken: SECRETS.googleDeveloperToken,
  timeoutMs: 1000,
});

const WA_PHONE = "109876543210";
const waConfig = createWhatsAppConfig({
  phoneNumberId: WA_PHONE,
  accessToken: SECRETS.waAccessToken,
  appSecret: SECRETS.waAppSecret,
  verifyToken: SECRETS.waVerifyToken,
  maxEventAgeMs: 300_000,
});

const n8nConfig = createN8nConfig({
  baseUrl: "https://n8n.internal.uat",
  apiKey: SECRETS.n8nApiKey,
  callbackSecret: SECRETS.n8nCallbackSecret,
  callbackMaxAgeMs: 300_000,
});

const NOW = new Date("2026-09-05T12:00:00Z");
const FRESH_UNIX = String(Math.floor(NOW.getTime() / 1000) - 30);
const STALE_UNIX = String(Math.floor(NOW.getTime() / 1000) - 3600);
const FRESH_ISO = new Date(NOW.getTime() - 30_000).toISOString();

const tokenService = {
  verifyAccessToken: (token: string) => {
    if (token === TOKEN_ALICE) return { userId: ALICE, role: "member", email: "alice@uat.local" };
    if (token === TOKEN_BOB) return { userId: BOB, role: "member", email: "bob@uat.local" };
    return null;
  },
};

// ---------------------------------------------------------------------------
// Router-walking harness (same approach as dashboard-api.test.ts)
// ---------------------------------------------------------------------------

interface TestResponse {
  status: number;
  body: any;
}

async function call(
  router: Router,
  method: string,
  path: string,
  options: { token?: string; rawBody?: Buffer; headers?: Record<string, string> } = {}
): Promise<TestResponse> {
  const parsed = new URL(path, "http://test");
  const pathname = parsed.pathname;

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) { this._status = code; return this; },
    json(body: unknown) { this._body = body; return this; },
    type() { return this; },
    send(body: unknown) { this._body = body; return this; },
  };

  const stack =
    ((router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (...a: any[]) => unknown }>;
        };
      }>;
    }).stack) ?? [];

  for (const layer of stack) {
    if (!layer.route) continue;
    if (!layer.route.methods[method.toLowerCase()]) continue;
    const pattern = "^" + layer.route.path.replace(/:[^/]+/g, "([^/]+)") + "$";
    const match = pathname.match(new RegExp(pattern));
    if (!match) continue;

    const names = (layer.route.path.match(/:[^/]+/g) ?? []).map((n) => n.slice(1));
    const params: Record<string, string> = {};
    names.forEach((n, i) => { params[n] = match[i + 1]; });

    const req = {
      method,
      url: pathname + parsed.search,
      originalUrl: pathname + parsed.search,
      path: pathname,
      params,
      query: Object.fromEntries(parsed.searchParams),
      headers,
      body: options.rawBody,
      get(h: string) { return headers[h.toLowerCase()]; },
    };

    const chain = layer.route.stack;
    const responded = () => (res as unknown as { _body: unknown })._body !== null;
    const runAt = (i: number): unknown => {
      if (responded()) return undefined;
      const entry = chain[i];
      if (!entry) return undefined;
      if (entry.handle.length >= 3) {
        const name = entry.handle.name;
        // Body parsers are skipped: the harness supplies raw bytes directly,
        // preserving the byte-exactness the HMAC checks depend on.
        if (name === "jsonParser" || name === "rawParser") return runAt(i + 1);
        return new Promise<void>((resolveStep) => {
          entry.handle(req, res, () => resolveStep());
          if (responded()) resolveStep();
        }).then(() => runAt(i + 1));
      }
      return entry.handle(req, res);
    };

    await runAt(0);
    return {
      status: (res as unknown as { _status: number })._status,
      body: (res as unknown as { _body: unknown })._body,
    };
  }
  return { status: 404, body: { success: false, error: { code: "NO_ROUTE" } } };
}

// ---------------------------------------------------------------------------
// Shared two-tenant fixture
// ---------------------------------------------------------------------------

function makeSystem() {
  // --- Google ---------------------------------------------------------------
  const googleRows: any[] = [];
  const googleConnections = {
    async save(input: any) {
      const row = {
        userId: input.userId,
        email: input.googleAccountEmail,
        scopes: input.scopes,
        accessTokenEnc: encryption.encrypt(input.accessToken),
        refreshTokenEnc: encryption.encrypt(input.refreshToken),
        expiresAt: input.expiresAt,
        revokedAt: null as Date | null,
        createdAt: NOW,
      };
      googleRows.push(row);
      return {
        id: "gc-1", userId: row.userId, googleAccountEmail: row.email,
        scopes: row.scopes, connectedAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: null,
      };
    },
    active(userId: string) {
      return googleRows.find((r) => r.userId === userId && r.revokedAt === null) ?? null;
    },
    async findByUser(userId: string) {
      const r = this.active(userId);
      return r ? {
        id: "gc-1", userId: r.userId, googleAccountEmail: r.email, scopes: r.scopes,
        connectedAt: r.createdAt, expiresAt: r.expiresAt, revokedAt: null,
      } : null;
    },
    async getCredentials(userId: string) {
      const r = this.active(userId);
      return r ? {
        accessToken: encryption.decrypt(r.accessTokenEnc),
        refreshToken: encryption.decrypt(r.refreshTokenEnc),
        expiresAt: r.expiresAt, scopes: r.scopes,
      } : null;
    },
    async updateAccessToken() {},
    async revoke(userId: string) {
      const r = this.active(userId);
      if (r) r.revokedAt = new Date();
    },
  };

  const oauthStates = {
    rows: new Map<string, any>(),
    async create(rec: any) { this.rows.set(rec.state, rec); },
    async consume(state: string) {
      const r = this.rows.get(state);
      if (!r) return null;
      this.rows.delete(state);
      return r;
    },
    async deleteExpired() { return 0; },
  };

  let googleFetchQueue: { status: number; body: unknown }[] = [];
  const googleFetch = (async () => {
    const r = googleFetchQueue.shift() ?? { status: 200, body: {} };
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  }) as unknown as typeof fetch;

  const googleRouter = createGoogleAuthRouter({ tokenService } as never, {
    connections: googleConnections as never,
    oauthStates: oauthStates as never,
    config: googleConfig,
    fetchImpl: googleFetch,
    now: () => NOW,
  });

  // --- WhatsApp -------------------------------------------------------------
  const waRows: any[] = [];
  const waRepo = {
    claims: new Map<string, string>([[WA_PHONE, ALICE]]),
    async findUserForPhoneNumber(p: string) { return this.claims.get(p) ?? null; },
    async recordInbound({ userId, message }: any) {
      if (waRows.some((r) => r.providerMessageId === message.providerMessageId)) {
        return { recorded: false, duplicate: true, messageId: null };
      }
      const row = {
        id: `wa-${waRows.length + 1}`, userId,
        providerMessageId: message.providerMessageId, waId: message.from,
        phoneNumberId: message.phoneNumberId, direction: "INBOUND", type: message.type,
        body: message.body, status: null, providerTimestamp: message.timestamp, createdAt: NOW,
      };
      waRows.push(row);
      return { recorded: true, duplicate: false, messageId: row.id };
    },
    async recordOutbound(input: any) {
      const row = { id: `wa-${waRows.length + 1}`, ...input, direction: "OUTBOUND",
        type: "TEXT", status: "sent", providerTimestamp: NOW, createdAt: NOW };
      waRows.push(row);
      return row;
    },
    async applyStatus() { return true; },
    async listForUser(userId: string, o?: any) {
      return waRows.filter((r) => r.userId === userId && (!o?.waId || r.waId === o.waId));
    },
  };

  const waRouter = createWhatsAppRouter({ tokenService } as never, {
    repo: waRepo as never,
    config: waConfig,
    now: () => NOW,
  });

  // --- n8n ------------------------------------------------------------------
  const n8nWorkflows = [
    { id: "wf-alice", userId: ALICE, name: "Alice workflow", webhookPath: "alice-hook", isActive: true, createdAt: NOW },
    { id: "wf-bob", userId: BOB, name: "Bob workflow", webhookPath: "bob-hook", isActive: true, createdAt: NOW },
  ];
  const n8nExecutions: any[] = [];
  let n8nSeq = 0;
  const n8nRepo = {
    async findWorkflowForUser(userId: string, id: string) {
      return n8nWorkflows.find((w) => w.id === id && w.userId === userId && w.isActive) ?? null;
    },
    async listWorkflowsForUser(userId: string) {
      return n8nWorkflows.filter((w) => w.userId === userId);
    },
    async beginExecution(input: any) {
      const existing = n8nExecutions.find((e) => e.idempotencyKey === input.idempotencyKey);
      if (existing) return { record: existing, created: false };
      const record = {
        id: `exec-${++n8nSeq}`, ...input, remoteExecutionId: null, status: "TRIGGERED",
        callbackEventId: null, resultSummary: null, errorCode: null,
        triggeredAt: NOW, completedAt: null,
      };
      n8nExecutions.push(record);
      return { record, created: true };
    },
    async markTriggered(id: string, remote: string | null, summary: string | null) {
      const e = n8nExecutions.find((x) => x.id === id);
      if (e) { e.remoteExecutionId = remote; e.resultSummary = summary; }
    },
    async markFailed(id: string, code: string, msg: string) {
      const e = n8nExecutions.find((x) => x.id === id);
      if (e) { e.status = "FAILED"; e.errorCode = code; e.resultSummary = msg; e.completedAt = new Date(); }
    },
    async applyCallback(event: any) {
      const row = n8nExecutions.find((e) => e.id === event.executionId);
      if (!row) return { applied: false, duplicate: false, notFound: true };
      const owner = { userId: row.userId, traceId: row.traceId };
      if (row.callbackEventId !== null) return { applied: false, duplicate: true, notFound: false, ...owner };
      if (n8nExecutions.some((e) => e.callbackEventId === event.eventId)) {
        return { applied: false, duplicate: true, notFound: false, ...owner };
      }
      row.callbackEventId = event.eventId;
      row.status = event.status === "success" ? "SUCCEEDED" : "FAILED";
      row.resultSummary = event.summary ?? row.resultSummary;
      row.completedAt = new Date();
      return { applied: true, duplicate: false, notFound: false, ...owner };
    },
    async listExecutionsForUser(userId: string, o?: any) {
      return n8nExecutions.filter((e) => e.userId === userId && (!o?.workflowId || e.workflowId === o.workflowId));
    },
    async findExecutionForUser(userId: string, id: string) {
      return n8nExecutions.find((e) => e.id === id && e.userId === userId) ?? null;
    },
  };

  const auditEntries: any[] = [];
  const auditLogger = { log: vi.fn(async (e: any) => { auditEntries.push(e); }) };

  const n8nRouter = createN8nRouter({ tokenService } as never, {
    repo: n8nRepo as never,
    config: n8nConfig,
    auditLogger: auditLogger as never,
    now: () => NOW,
  });

  return {
    googleRouter, googleConnections, oauthStates, googleRows,
    setGoogleFetch: (q: { status: number; body: unknown }[]) => { googleFetchQueue = q; },
    waRouter, waRepo, waRows,
    n8nRouter, n8nRepo, n8nExecutions, n8nWorkflows, auditEntries, auditLogger,
  };
}

type System = ReturnType<typeof makeSystem>;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_OK = {
  status: 200,
  body: {
    access_token: SECRETS.googleAccessToken,
    refresh_token: SECRETS.googleRefreshToken,
    expires_in: 3600,
    scope: `${GOOGLE_ADS_SCOPE} openid email`,
  },
};
const GOOGLE_USERINFO_OK = { status: 200, body: { email: "ads-owner@uat.local" } };

/** Drives Google connect -> callback for one tenant. */
async function connectGoogle(sys: System, token: string): Promise<void> {
  sys.setGoogleFetch([GOOGLE_TOKEN_OK, GOOGLE_USERINFO_OK]);
  const start = await call(sys.googleRouter, "POST", "/connect", { token });
  const state = new URL(start.body.data.authUrl).searchParams.get("state")!;
  await call(sys.googleRouter, "GET", `/callback?code=uat-code&state=${state}`);
}

function waInbound(opts: { messageId?: string; timestamp?: string; phoneNumberId?: string; text?: string } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: opts.phoneNumberId ?? WA_PHONE },
          contacts: [{ profile: { name: "Customer" }, wa_id: "15550101234" }],
          messages: [{
            from: "15550101234",
            id: opts.messageId ?? "wamid.UAT1",
            timestamp: opts.timestamp ?? FRESH_UNIX,
            type: "text",
            text: { body: opts.text ?? "hello" },
          }],
        },
      }],
    }],
  };
}

function waSigned(payload: unknown, secret = SECRETS.waAppSecret) {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return { rawBody, headers: { "x-hub-signature-256": signPayload(rawBody, secret) } };
}

function n8nSigned(payload: unknown, secret = SECRETS.n8nCallbackSecret) {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return { rawBody, headers: { "x-jarvis-signature": signCallback(rawBody, secret) } };
}

const ctx = (userId: string): ToolContext =>
  ({ userId, traceId: "uat-trace", role: "member" }) as unknown as ToolContext;

/** Real approval service with in-memory repos. */
function makeApprovalService() {
  const approvalRepo = {
    create: vi.fn(async (d: any) => ({ id: "appr-1", ...d, status: "pending", expiresAt: new Date(Date.now() + 6e5) })),
    findById: vi.fn(async () => null),
    findExistingForTool: vi.fn(async () => null),
    update: vi.fn(async () => undefined),
  };
  const auditRepo = { create: vi.fn(async () => ({ id: "a1" })), query: vi.fn(async () => []) };
  return {
    service: new ToolApprovalService(approvalRepo as never, auditRepo as never, new PermissionService() as never),
    approvalRepo,
  };
}

/** Asserts no synthetic secret appears anywhere in a value. */
function assertNoSecrets(value: unknown, label: string): void {
  const blob = JSON.stringify(value ?? null);
  for (const secret of ALL_SECRET_VALUES) {
    if (blob.includes(secret)) {
      throw new Error(`SECRET LEAK in ${label}: response contained ${secret.slice(0, 12)}...`);
    }
  }
}

// ===========================================================================
// UAT-1 — Google
// ===========================================================================

describe("UAT-1 Google: authentication, authorization, isolation, API behavior", () => {
  it("1.1 rejects unauthenticated access to every Google route", async () => {
    const sys = makeSystem();
    expect((await call(sys.googleRouter, "GET", "/status")).status).toBe(401);
    expect((await call(sys.googleRouter, "POST", "/connect")).status).toBe(401);
    expect((await call(sys.googleRouter, "POST", "/disconnect")).status).toBe(401);
  });

  it("1.2 rejects a forged bearer token", async () => {
    const sys = makeSystem();
    expect((await call(sys.googleRouter, "GET", "/status", { token: "forged" })).status).toBe(401);
  });

  it("1.3 completes OAuth and stores tokens ENCRYPTED", async () => {
    const sys = makeSystem();
    await connectGoogle(sys, TOKEN_ALICE);

    expect(sys.googleRows).toHaveLength(1);
    const row = sys.googleRows[0];
    expect(row.accessTokenEnc).not.toContain(SECRETS.googleAccessToken);
    expect(row.refreshTokenEnc).not.toContain(SECRETS.googleRefreshToken);
    expect(encryption.decrypt(row.accessTokenEnc)).toBe(SECRETS.googleAccessToken);
  });

  it("1.4 TENANT ISOLATION: Bob cannot see Alice's Google connection", async () => {
    const sys = makeSystem();
    await connectGoogle(sys, TOKEN_ALICE);

    const bob = await call(sys.googleRouter, "GET", "/status", { token: TOKEN_BOB });
    expect(bob.body.data.connected).toBe(false);
    expect(bob.body.data.account).toBeNull();
  });

  it("1.5 TENANT ISOLATION: Bob cannot disconnect Alice's connection", async () => {
    const sys = makeSystem();
    await connectGoogle(sys, TOKEN_ALICE);

    await call(sys.googleRouter, "POST", "/disconnect", { token: TOKEN_BOB });
    expect(await sys.googleConnections.getCredentials(ALICE)).not.toBeNull();
  });

  it("1.6 rejects a replayed OAuth authorization code", async () => {
    const sys = makeSystem();
    sys.setGoogleFetch([GOOGLE_TOKEN_OK, GOOGLE_USERINFO_OK, GOOGLE_TOKEN_OK, GOOGLE_USERINFO_OK]);
    const start = await call(sys.googleRouter, "POST", "/connect", { token: TOKEN_ALICE });
    const state = new URL(start.body.data.authUrl).searchParams.get("state")!;

    const first = await call(sys.googleRouter, "GET", `/callback?code=c&state=${state}`);
    const replay = await call(sys.googleRouter, "GET", `/callback?code=c&state=${state}`);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(400);
  });

  it("1.7 rejects a forged CSRF state", async () => {
    const sys = makeSystem();
    sys.setGoogleFetch([GOOGLE_TOKEN_OK, GOOGLE_USERINFO_OK]);
    const res = await call(sys.googleRouter, "GET", "/callback?code=attacker&state=forged");
    expect(res.status).toBe(400);
    expect(sys.googleRows).toHaveLength(0);
  });

  it("1.8 INVALID CREDENTIALS: invalid_grant surfaces as 401, code not echoed", async () => {
    const sys = makeSystem();
    sys.setGoogleFetch([{ status: 400, body: { error: "invalid_grant" } }]);
    const start = await call(sys.googleRouter, "POST", "/connect", { token: TOKEN_ALICE });
    const state = new URL(start.body.data.authUrl).searchParams.get("state")!;

    const res = await call(sys.googleRouter, "GET", `/callback?code=secret-code&state=${state}`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("secret-code");
  });

  it("1.9 refuses a partial scope grant rather than storing a doomed connection", async () => {
    const sys = makeSystem();
    sys.setGoogleFetch([
      { status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid email" } },
      GOOGLE_USERINFO_OK,
    ]);
    const start = await call(sys.googleRouter, "POST", "/connect", { token: TOKEN_ALICE });
    const state = new URL(start.body.data.authUrl).searchParams.get("state")!;

    const res = await call(sys.googleRouter, "GET", `/callback?code=c&state=${state}`);
    expect(res.status).toBe(403);
    expect(sys.googleRows).toHaveLength(0);
  });

  it("1.10 EXTERNAL API: read tools deny an unauthorized customer id", async () => {
    const provider = new MockGoogleAdsProvider({
      authorizedCustomers: { [ALICE]: ["1111111111"], [BOB]: ["2222222222"] },
    });
    const tool = new GoogleGetCampaignsTool(provider, provider);

    const own = await tool.execute({ customerId: "1111111111" }, ctx(ALICE));
    const foreign = await tool.execute({ customerId: "2222222222" }, ctx(ALICE));

    expect(own.success).toBe(true);
    expect(foreign.success).toBe(false);
    expect(foreign.error).toMatch(/Not authorized/);
  });

  it("1.11 EXTERNAL API: provider errors surface as failures, not throws", async () => {
    const provider = new MockGoogleAdsProvider({
      throwOnCall: "getMetrics",
      error: new Error("Google Ads API unavailable"),
      authorizedCustomers: { [ALICE]: ["1111111111"] },
    });
    const result = await new GoogleGetInsightsTool(provider, provider).execute(
      { customerId: "1111111111", since: "2026-08-01", until: "2026-08-31" },
      ctx(ALICE)
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unavailable/);
  });

  it("1.12 EXPIRED CREDENTIALS surface as a failure result", async () => {
    const provider = new MockGoogleAdsProvider({
      throwOnCall: "getCampaigns",
      error: new Error("No active Google connection for this user"),
      authorizedCustomers: { [ALICE]: ["1111111111"] },
    });
    const result = await new GoogleGetCampaignsTool(provider, provider).execute(
      { customerId: "1111111111" },
      ctx(ALICE)
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No active Google connection/);
  });
});

// ===========================================================================
// UAT-2 — WhatsApp
// ===========================================================================

describe("UAT-2 WhatsApp: webhook validation, replay, isolation, approval-gated send", () => {
  it("2.1 accepts a correctly signed inbound message", async () => {
    const sys = makeSystem();
    const res = await call(sys.waRouter, "POST", "/webhook", waSigned(waInbound()));

    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(1);
    expect(sys.waRows[0].userId).toBe(ALICE);
  });

  it("2.2 REJECTS a wrong-secret signature", async () => {
    const sys = makeSystem();
    const res = await call(sys.waRouter, "POST", "/webhook", waSigned(waInbound(), "attacker-secret"));
    expect(res.status).toBe(401);
    expect(sys.waRows).toHaveLength(0);
  });

  it("2.3 REJECTS an unsigned webhook", async () => {
    const sys = makeSystem();
    const { rawBody } = waSigned(waInbound());
    const res = await call(sys.waRouter, "POST", "/webhook", { rawBody });
    expect(res.status).toBe(401);
  });

  it("2.4 REJECTS a tampered body under a captured signature", async () => {
    const sys = makeSystem();
    const { headers } = waSigned(waInbound({ text: "original" }));
    const tampered = Buffer.from(JSON.stringify(waInbound({ text: "injected" })), "utf8");

    const res = await call(sys.waRouter, "POST", "/webhook", { rawBody: tampered, headers });
    expect(res.status).toBe(401);
    expect(sys.waRows).toHaveLength(0);
  });

  it("2.5 REPLAY: a redelivered message is processed once", async () => {
    const sys = makeSystem();
    const signed = waSigned(waInbound({ messageId: "wamid.DUP" }));

    const first = await call(sys.waRouter, "POST", "/webhook", signed);
    const second = await call(sys.waRouter, "POST", "/webhook", signed);

    expect(first.body.data.processed).toBe(1);
    expect(second.body.data.duplicates).toBe(1);
    expect(sys.waRows).toHaveLength(1);
  });

  it("2.6 REPLAY: a stale event is rejected despite a valid signature", async () => {
    const sys = makeSystem();
    const res = await call(sys.waRouter, "POST", "/webhook", waSigned(waInbound({ timestamp: STALE_UNIX })));
    expect(res.body.data.skipped).toBe(1);
    expect(sys.waRows).toHaveLength(0);
  });

  it("2.7 TENANT ISOLATION: an unclaimed phone number is dropped, not guessed", async () => {
    const sys = makeSystem();
    const res = await call(sys.waRouter, "POST", "/webhook", waSigned(waInbound({ phoneNumberId: "999999999999" })));
    expect(res.body.data.skipped).toBe(1);
    expect(sys.waRows).toHaveLength(0);
  });

  it("2.8 TENANT ISOLATION: Bob cannot read Alice's messages", async () => {
    const sys = makeSystem();
    await call(sys.waRouter, "POST", "/webhook", waSigned(waInbound()));

    const alice = await call(sys.waRouter, "GET", "/messages", { token: TOKEN_ALICE });
    const bob = await call(sys.waRouter, "GET", "/messages", { token: TOKEN_BOB });

    expect(alice.body.data.count).toBe(1);
    expect(bob.body.data.count).toBe(0);
  });

  it("2.9 TENANT ISOLATION: a userId in the query string is ignored", async () => {
    const sys = makeSystem();
    await call(sys.waRouter, "POST", "/webhook", waSigned(waInbound()));
    const res = await call(sys.waRouter, "GET", `/messages?userId=${ALICE}`, { token: TOKEN_BOB });
    expect(res.body.data.count).toBe(0);
  });

  it("2.10 verification handshake rejects a wrong verify token", async () => {
    const sys = makeSystem();
    const good = await call(sys.waRouter, "GET",
      `/webhook?hub.mode=subscribe&hub.verify_token=${SECRETS.waVerifyToken}&hub.challenge=CHAL`);
    const bad = await call(sys.waRouter, "GET",
      "/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHAL");

    expect(good.status).toBe(200);
    expect(good.body).toBe("CHAL");
    expect(bad.status).toBe(403);
    expect(JSON.stringify(bad.body)).not.toContain("CHAL");
  });

  it("2.11 APPROVAL: outbound send is EXTERNAL_SIDE_EFFECT and gated", async () => {
    const { service, approvalRepo } = makeApprovalService();
    const tool = new WhatsAppSendMessageTool(
      new MockWhatsAppProvider(),
      { async isAuthorized() { return true; } },
      WA_PHONE
    ) as unknown as ITool;

    const check = await service.checkPreExecution(
      tool, { to: "15550101234", body: "hi" },
      { userId: ALICE, role: "admin", traceId: "t" }
    );
    expect(check.requiresApproval).toBe(true);
    expect(check.allowed).toBe(false);
    expect(approvalRepo.create).toHaveBeenCalled();
  });

  it("2.12 AUTHORIZATION: a non-owner cannot send, and nothing is transmitted", async () => {
    const provider = new MockWhatsAppProvider();
    const tool = new WhatsAppSendMessageTool(
      provider,
      { async isAuthorized(userId: string) { return userId === ALICE; } },
      WA_PHONE
    );
    const result = await tool.execute({ to: "15550101234", body: "hi" }, ctx(BOB));

    expect(result.success).toBe(false);
    expect(provider.sent).toHaveLength(0);
  });

  it("2.13 PROVIDER FAILURE returns a failure result, no outbound row", async () => {
    const provider = new MockWhatsAppProvider({ throwOnSend: new Error("Rate limit hit") });
    const tool = new WhatsAppSendMessageTool(provider, { async isAuthorized() { return true; } }, WA_PHONE);
    const result = await tool.execute({ to: "15550101234", body: "hi" }, ctx(ALICE));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/rate limit/i);
  });
});

// ===========================================================================
// UAT-3 — n8n
// ===========================================================================

describe("UAT-3 n8n: bidirectional flow, directional secrets, SSRF, idempotency, audit", () => {
  async function triggerFor(sys: System, userId: string, workflowId: string, payload: any = { x: 1 }) {
    const provider = new MockN8nProvider();
    const tool = new N8nTriggerWorkflowTool(provider, sys.n8nRepo as never, mockKeyDeriver);
    const result = await tool.execute({ workflowId, payload }, ctx(userId));
    return { provider, result };
  }

  it("3.1 OUTBOUND: triggers a workflow and records an execution", async () => {
    const sys = makeSystem();
    const { provider, result } = await triggerFor(sys, ALICE, "wf-alice");

    expect(result.success).toBe(true);
    expect(provider.triggered).toHaveLength(1);
    expect(provider.triggered[0].webhookPath).toBe("alice-hook");
    expect(sys.n8nExecutions).toHaveLength(1);
  });

  it("3.2 INBOUND: a signed callback completes the execution", async () => {
    const sys = makeSystem();
    await triggerFor(sys, ALICE, "wf-alice");
    const execId = sys.n8nExecutions[0].id;

    const res = await call(sys.n8nRouter, "POST", "/callback", n8nSigned({
      eventId: "evt-1", executionId: execId, status: "success",
      summary: "done", timestamp: FRESH_ISO,
    }));

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(true);
    expect(sys.n8nExecutions[0].status).toBe("SUCCEEDED");
  });

  it("3.3 DIRECTIONAL SECRETS: the outbound API key is rejected inbound", async () => {
    const sys = makeSystem();
    await triggerFor(sys, ALICE, "wf-alice");
    const execId = sys.n8nExecutions[0].id;

    // Workflow authors can read the API key; it must never authenticate inbound.
    const res = await call(sys.n8nRouter, "POST", "/callback", n8nSigned(
      { eventId: "e", executionId: execId, status: "success", timestamp: FRESH_ISO },
      SECRETS.n8nApiKey
    ));

    expect(res.status).toBe(401);
    expect(sys.n8nExecutions[0].status).toBe("TRIGGERED");
  });

  it("3.4 SSRF: paths that would escape the configured host are refused", async () => {
    for (const bad of ["//evil.test/x", "http://evil.test", "../../admin", "a:b"]) {
      expect(validateWebhookPath(bad)).toBeNull();
      expect(() => buildWebhookUrl(n8nConfig, bad)).toThrow(/Invalid n8n webhook path/);
    }
    expect(buildWebhookUrl(n8nConfig, "alice-hook")).toBe("https://n8n.internal.uat/webhook/alice-hook");
  });

  it("3.5 IDEMPOTENCY: an identical repeated trigger does not re-run the workflow", async () => {
    const sys = makeSystem();
    const provider = new MockN8nProvider();
    const tool = new N8nTriggerWorkflowTool(provider, sys.n8nRepo as never, mockKeyDeriver);

    const first = await tool.execute({ workflowId: "wf-alice", payload: { x: 1 } }, ctx(ALICE));
    const second = await tool.execute({ workflowId: "wf-alice", payload: { x: 1 } }, ctx(ALICE));

    expect(second.success).toBe(true);
    expect((second.data as any).idempotent).toBe(true);
    expect(provider.triggered).toHaveLength(1);
  });

  it("3.6 REPLAY: a redelivered callback is applied once", async () => {
    const sys = makeSystem();
    await triggerFor(sys, ALICE, "wf-alice");
    const execId = sys.n8nExecutions[0].id;
    const signed = n8nSigned({ eventId: "evt-dup", executionId: execId, status: "success", timestamp: FRESH_ISO });

    const first = await call(sys.n8nRouter, "POST", "/callback", signed);
    const second = await call(sys.n8nRouter, "POST", "/callback", signed);

    expect(first.body.data.applied).toBe(true);
    expect(second.body.data.reason).toBe("duplicate");
  });

  it("3.7 TENANT ISOLATION: Alice cannot trigger Bob's workflow", async () => {
    const sys = makeSystem();
    const { provider, result } = await triggerFor(sys, ALICE, "wf-bob");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found or not available/i);
    expect(provider.triggered).toHaveLength(0);
  });

  it("3.8 TENANT ISOLATION: execution reads are scoped, foreign id reads as 404", async () => {
    const sys = makeSystem();
    await triggerFor(sys, ALICE, "wf-alice");
    const execId = sys.n8nExecutions[0].id;

    const alice = await call(sys.n8nRouter, "GET", `/executions/${execId}`, { token: TOKEN_ALICE });
    const bob = await call(sys.n8nRouter, "GET", `/executions/${execId}`, { token: TOKEN_BOB });

    expect(alice.status).toBe(200);
    expect(bob.status).toBe(404);
    expect(bob.body.error.code).toBe("NOT_FOUND");
  });

  it("3.9 APPROVAL: workflow trigger is gated by the real approval service", async () => {
    const sys = makeSystem();
    const { service, approvalRepo } = makeApprovalService();
    const tool = new N8nTriggerWorkflowTool(
      new MockN8nProvider(), sys.n8nRepo as never, mockKeyDeriver
    ) as unknown as ITool;

    const check = await service.checkPreExecution(
      tool, { workflowId: "wf-alice", payload: {} },
      { userId: ALICE, role: "admin", traceId: "t" }
    );
    expect(check.requiresApproval).toBe(true);
    expect(check.allowed).toBe(false);
    expect(approvalRepo.create).toHaveBeenCalled();
  });

  it("3.10 AUDIT: a callback is attributed to the OWNING tenant, not the payload", async () => {
    const sys = makeSystem();
    await triggerFor(sys, ALICE, "wf-alice");
    const execId = sys.n8nExecutions[0].id;

    // The payload claims Bob; the execution row belongs to Alice.
    await call(sys.n8nRouter, "POST", "/callback", n8nSigned({
      eventId: "evt-audit", executionId: execId, status: "success",
      userId: BOB, tenant: BOB, timestamp: FRESH_ISO,
    }));

    expect(sys.auditEntries).toHaveLength(1);
    expect(sys.auditEntries[0]).toMatchObject({
      userId: ALICE, action: "n8n.callback", toolId: "n8n.trigger", result: "success",
    });
  });

  it("3.11 AUDIT: no entry is written for a rejected signature", async () => {
    const sys = makeSystem();
    await triggerFor(sys, ALICE, "wf-alice");
    await call(sys.n8nRouter, "POST", "/callback", n8nSigned(
      { eventId: "e", executionId: sys.n8nExecutions[0].id, status: "success", timestamp: FRESH_ISO },
      "attacker"
    ));
    expect(sys.auditLogger.log).not.toHaveBeenCalled();
  });

  it("3.12 AUDIT: the execution row stores a payload HASH, never the payload", async () => {
    const sys = makeSystem();
    await triggerFor(sys, ALICE, "wf-alice", { apiSecret: "sensitive-value" });

    expect(sys.n8nExecutions[0].payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sys.n8nExecutions[0])).not.toContain("sensitive-value");
  });

  it("3.13 TIMEOUT: an ambiguous failure stays TRIGGERED and warns the caller", async () => {
    const sys = makeSystem();
    const err = Object.assign(new Error("gateway timeout"), {
      classified: { code: "TOOL_TIMEOUT", sideEffectPossible: true },
    });
    const tool = new N8nTriggerWorkflowTool(
      new MockN8nProvider({ throwOnTrigger: err }), sys.n8nRepo as never, mockKeyDeriver
    );
    const result = await tool.execute({ workflowId: "wf-alice" }, ctx(ALICE));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/may have started/i);
    // Never auto-retryable: the workflow may already have run.
    expect(sys.n8nExecutions[0].status).toBe("TRIGGERED");
  });

  it("3.14 NETWORK FAILURE that never transmitted is recorded as FAILED", async () => {
    const sys = makeSystem();
    const err = Object.assign(new Error("connection refused"), {
      classified: { code: "NETWORK_ERROR", sideEffectPossible: false },
    });
    const tool = new N8nTriggerWorkflowTool(
      new MockN8nProvider({ throwOnTrigger: err }), sys.n8nRepo as never, mockKeyDeriver
    );
    await tool.execute({ workflowId: "wf-alice" }, ctx(ALICE));
    expect(sys.n8nExecutions[0].status).toBe("FAILED");
  });

  it("3.15 MALFORMED callbacks are rejected with 400", async () => {
    const sys = makeSystem();
    for (const bad of [
      { executionId: "x", status: "success" },
      { eventId: "e", status: "success" },
      { eventId: "e", executionId: "x", status: "maybe" },
    ]) {
      expect((await call(sys.n8nRouter, "POST", "/callback", n8nSigned(bad))).status).toBe(400);
    }
  });
});

// ===========================================================================
// UAT-4 — Cross-integration isolation
// ===========================================================================

describe("UAT-4 Cross-integration isolation", () => {
  it("4.1 a Google connection grants NO WhatsApp or n8n capability", async () => {
    const sys = makeSystem();
    await connectGoogle(sys, TOKEN_BOB); // Bob authenticates to Google

    // ...which must not let Bob read WhatsApp data or trigger Alice's workflow.
    await call(sys.waRouter, "POST", "/webhook", waSigned(waInbound()));
    const waRead = await call(sys.waRouter, "GET", "/messages", { token: TOKEN_BOB });
    expect(waRead.body.data.count).toBe(0);

    const provider = new MockN8nProvider();
    const tool = new N8nTriggerWorkflowTool(provider, sys.n8nRepo as never, mockKeyDeriver);
    const trigger = await tool.execute({ workflowId: "wf-alice" }, ctx(BOB));
    expect(trigger.success).toBe(false);
    expect(provider.triggered).toHaveLength(0);
  });

  it("4.2 a WhatsApp phone-number claim grants NO Google or n8n capability", async () => {
    const sys = makeSystem();
    // Alice owns the WhatsApp number...
    await call(sys.waRouter, "POST", "/webhook", waSigned(waInbound()));
    expect(sys.waRows[0].userId).toBe(ALICE);

    // ...but that is not a Google connection.
    const g = await call(sys.googleRouter, "GET", "/status", { token: TOKEN_ALICE });
    expect(g.body.data.connected).toBe(false);

    // ...and does not reach Bob's n8n workflow.
    const provider = new MockN8nProvider();
    const tool = new N8nTriggerWorkflowTool(provider, sys.n8nRepo as never, mockKeyDeriver);
    expect((await tool.execute({ workflowId: "wf-bob" }, ctx(ALICE))).success).toBe(false);
  });

  it("4.3 an n8n workflow owner gains NO Google or WhatsApp access", async () => {
    const sys = makeSystem();
    const provider = new MockN8nProvider();
    const tool = new N8nTriggerWorkflowTool(provider, sys.n8nRepo as never, mockKeyDeriver);
    expect((await tool.execute({ workflowId: "wf-bob" }, ctx(BOB))).success).toBe(true);

    // Bob owns an n8n workflow but no Google connection and no WhatsApp number.
    expect((await call(sys.googleRouter, "GET", "/status", { token: TOKEN_BOB })).body.data.connected).toBe(false);
    await call(sys.waRouter, "POST", "/webhook", waSigned(waInbound()));
    expect((await call(sys.waRouter, "GET", "/messages", { token: TOKEN_BOB })).body.data.count).toBe(0);
  });

  it("4.4 each integration's signing secret is rejected by the others", async () => {
    const sys = makeSystem();
    await triggerAlice(sys);
    const execId = sys.n8nExecutions[0].id;

    // WhatsApp app secret must not authenticate an n8n callback.
    const wrongForN8n = await call(sys.n8nRouter, "POST", "/callback", n8nSigned(
      { eventId: "x", executionId: execId, status: "success", timestamp: FRESH_ISO },
      SECRETS.waAppSecret
    ));
    expect(wrongForN8n.status).toBe(401);

    // n8n callback secret must not authenticate a WhatsApp webhook.
    const wrongForWa = await call(sys.waRouter, "POST", "/webhook",
      waSigned(waInbound({ messageId: "wamid.CROSS" }), SECRETS.n8nCallbackSecret));
    expect(wrongForWa.status).toBe(401);
    expect(sys.waRows).toHaveLength(0);
  });

  async function triggerAlice(sys: System) {
    const tool = new N8nTriggerWorkflowTool(new MockN8nProvider(), sys.n8nRepo as never, mockKeyDeriver);
    await tool.execute({ workflowId: "wf-alice" }, ctx(ALICE));
  }

  it("4.5 an unauthenticated caller is rejected by ALL three integrations", async () => {
    const sys = makeSystem();
    expect((await call(sys.googleRouter, "GET", "/status")).status).toBe(401);
    expect((await call(sys.waRouter, "GET", "/messages")).status).toBe(401);
    expect((await call(sys.n8nRouter, "GET", "/executions")).status).toBe(401);
    expect((await call(sys.n8nRouter, "GET", "/workflows")).status).toBe(401);
  });
});

// ===========================================================================
// UAT-5 — Approval boundary, uniformly
// ===========================================================================

describe("UAT-5 Approval boundary across all integrations", () => {
  const sys = makeSystem();

  const writeTools: { name: string; tool: ITool; params: Record<string, unknown> }[] = [
    {
      name: "whatsapp.send",
      tool: new WhatsAppSendMessageTool(
        new MockWhatsAppProvider(), { async isAuthorized() { return true; } }, WA_PHONE
      ) as unknown as ITool,
      params: { to: "15550101234", body: "hi" },
    },
    {
      name: "n8n.trigger",
      tool: new N8nTriggerWorkflowTool(
        new MockN8nProvider(), sys.n8nRepo as never, mockKeyDeriver
      ) as unknown as ITool,
      params: { workflowId: "wf-alice", payload: {} },
    },
  ];

  const readTools: { name: string; tool: ITool; params: Record<string, unknown> }[] = (() => {
    const p = new MockGoogleAdsProvider();
    return [
      { name: "google.accounts", tool: new GoogleGetAccountsTool(p, p) as unknown as ITool, params: {} },
      {
        name: "google.campaigns",
        tool: new GoogleGetCampaignsTool(p, p) as unknown as ITool,
        params: { customerId: "1234567890" },
      },
      {
        name: "google.insights",
        tool: new GoogleGetInsightsTool(p, p) as unknown as ITool,
        params: { customerId: "1234567890", since: "2026-08-01", until: "2026-08-31" },
      },
    ];
  })();

  it("5.1 NO external state-changing action executes without approval", async () => {
    for (const { name, tool, params } of writeTools) {
      const { service, approvalRepo } = makeApprovalService();
      const check = await service.checkPreExecution(tool, params, {
        userId: ALICE, role: "admin", traceId: "t",
      });
      expect(check.requiresApproval, `${name} must require approval`).toBe(true);
      expect(check.allowed, `${name} must not be allowed without approval`).toBe(false);
      expect(approvalRepo.create, `${name} must raise an approval`).toHaveBeenCalled();
    }
  });

  it("5.2 every write tool is EXTERNAL_SIDE_EFFECT with write permission", () => {
    for (const { name, tool } of writeTools) {
      expect(tool.risk, name).toBe("EXTERNAL_SIDE_EFFECT");
      expect(tool.requiresApproval, name).toBe(true);
      expect(tool.requiredPermissions, name).toContain("write");
    }
  });

  it("5.3 read-only Google tools are auto-approved and raise no approval", async () => {
    for (const { name, tool, params } of readTools) {
      const { service, approvalRepo } = makeApprovalService();
      const check = await service.checkPreExecution(tool, params, {
        userId: ALICE, role: "member", traceId: "t",
      });
      expect(check.allowed, name).toBe(true);
      expect(check.requiresApproval, name).toBe(false);
      expect(approvalRepo.create, name).not.toHaveBeenCalled();
    }
  });

  it("5.4 a viewer role is denied every write tool", async () => {
    for (const { name, tool, params } of writeTools) {
      const { service } = makeApprovalService();
      const check = await service.checkPreExecution(tool, params, {
        userId: ALICE, role: "viewer", traceId: "t",
      });
      expect(check.allowed, name).toBe(false);
    }
  });

  it("5.5 a disabled tool is refused outright", async () => {
    const { service } = makeApprovalService();
    const base = writeTools[0].tool;
    const disabled = Object.assign(Object.create(Object.getPrototypeOf(base)), base, { enabled: false }) as ITool;
    const check = await service.checkPreExecution(disabled, writeTools[0].params, {
      userId: ALICE, role: "admin", traceId: "t",
    });
    expect(check.allowed).toBe(false);
  });
});

// ===========================================================================
// UAT-6 — Secret containment across every response surface
// ===========================================================================

describe("UAT-6 Secrets never reach a client response", () => {
  it("6.1 Google responses carry no token, client secret or developer token", async () => {
    const sys = makeSystem();
    sys.setGoogleFetch([GOOGLE_TOKEN_OK, GOOGLE_USERINFO_OK]);
    const start = await call(sys.googleRouter, "POST", "/connect", { token: TOKEN_ALICE });
    assertNoSecrets(start.body, "google /connect");

    const state = new URL(start.body.data.authUrl).searchParams.get("state")!;
    const cb = await call(sys.googleRouter, "GET", `/callback?code=c&state=${state}`);
    assertNoSecrets(cb.body, "google /callback");

    const status = await call(sys.googleRouter, "GET", "/status", { token: TOKEN_ALICE });
    assertNoSecrets(status.body, "google /status");

    const disconnect = await call(sys.googleRouter, "POST", "/disconnect", { token: TOKEN_ALICE });
    assertNoSecrets(disconnect.body, "google /disconnect");
  });

  it("6.2 the OAuth consent URL exposes no secret or PKCE verifier", async () => {
    const sys = makeSystem();
    const start = await call(sys.googleRouter, "POST", "/connect", { token: TOKEN_ALICE });
    const authUrl: string = start.body.data.authUrl;

    for (const secret of ALL_SECRET_VALUES) expect(authUrl).not.toContain(secret);
    const verifier = sys.oauthStates.rows.get(new URL(authUrl).searchParams.get("state")!)!.codeVerifier;
    expect(authUrl).not.toContain(verifier);
  });

  it("6.3 WhatsApp responses carry no secret and no message content", async () => {
    const sys = makeSystem();
    const inbound = await call(sys.waRouter, "POST", "/webhook",
      waSigned(waInbound({ text: "SENSITIVE MESSAGE" })));
    assertNoSecrets(inbound.body, "whatsapp /webhook");
    expect(JSON.stringify(inbound.body)).not.toContain("SENSITIVE MESSAGE");

    const read = await call(sys.waRouter, "GET", "/messages", { token: TOKEN_ALICE });
    assertNoSecrets(read.body, "whatsapp /messages");
  });

  it("6.4 n8n responses carry no secret and no webhook path", async () => {
    const sys = makeSystem();
    const tool = new N8nTriggerWorkflowTool(new MockN8nProvider(), sys.n8nRepo as never, mockKeyDeriver);
    await tool.execute({ workflowId: "wf-alice" }, ctx(ALICE));

    for (const path of ["/workflows", "/executions", `/executions/${sys.n8nExecutions[0].id}`]) {
      const res = await call(sys.n8nRouter, "GET", path, { token: TOKEN_ALICE });
      assertNoSecrets(res.body, `n8n ${path}`);
      // The webhook path is the address of a live automation endpoint.
      expect(JSON.stringify(res.body)).not.toContain("alice-hook");
    }
  });

  it("6.5 error responses across all three carry no secret", async () => {
    const sys = makeSystem();
    const responses = [
      await call(sys.googleRouter, "GET", "/status"),
      await call(sys.googleRouter, "GET", "/callback?code=x&state=forged"),
      await call(sys.waRouter, "POST", "/webhook", waSigned(waInbound(), "wrong")),
      await call(sys.waRouter, "GET", "/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y"),
      await call(sys.n8nRouter, "POST", "/callback", n8nSigned({ eventId: "e" }, "wrong")),
      await call(sys.n8nRouter, "GET", "/executions"),
    ];
    responses.forEach((r, i) => assertNoSecrets(r.body, `error response ${i}`));
  });

  it("6.6 tool results across all three carry no credential material", async () => {
    const sys = makeSystem();
    const gp = new MockGoogleAdsProvider();
    const results = [
      await new GoogleGetAccountsTool(gp, gp).execute({}, ctx(ALICE)),
      await new WhatsAppSendMessageTool(
        new MockWhatsAppProvider(), { async isAuthorized() { return true; } }, WA_PHONE
      ).execute({ to: "15550101234", body: "hi" }, ctx(ALICE)),
      await new N8nTriggerWorkflowTool(
        new MockN8nProvider(), sys.n8nRepo as never, mockKeyDeriver
      ).execute({ workflowId: "wf-alice" }, ctx(ALICE)),
    ];
    results.forEach((r, i) => assertNoSecrets(r, `tool result ${i}`));
  });
});
