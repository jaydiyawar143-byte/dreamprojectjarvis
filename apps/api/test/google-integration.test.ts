import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Router } from "express";
import { randomBytes } from "node:crypto";
import {
  EncryptionService,
  parseKey,
  ToolApprovalService,
  PermissionService,
} from "@jarvis/security";
import {
  GoogleGetAccountsTool,
  GoogleGetCampaignsTool,
  GoogleGetInsightsTool,
  MockGoogleAdsProvider,
} from "@jarvis/tools";
import { createGoogleConfig, GOOGLE_ADS_SCOPE } from "@jarvis/google-ads";
import type {
  IGoogleConnectionRepository,
  IOAuthStateRepository,
  OAuthStateRecord,
  GoogleConnectionSummary,
  GoogleCredentials,
  ITool,
} from "@jarvis/core";
import { createGoogleAuthRouter } from "../src/routes/google-auth.js";

// ---------------------------------------------------------------------------
// Sprint 5.2 — Google integration API tests
//
// No real Google credentials, no network, no database. The OAuth endpoints are
// driven through the same router-walking harness the dashboard tests use, with
// in-memory repositories and an injected fetch double, so this suite runs
// identically on a laptop and in CI.
// ---------------------------------------------------------------------------

const KEY = randomBytes(32).toString("base64");
const encryption = new EncryptionService([parseKey(1, KEY)]);

const config = createGoogleConfig({
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://jarvis.test/api/v1/google/callback",
  developerToken: "test-developer-token",
  timeoutMs: 1000,
});

// ---------------------------------------------------------------------------
// In-memory repositories that encrypt exactly as the Prisma ones do
// ---------------------------------------------------------------------------

class MemoryConnectionRepo implements IGoogleConnectionRepository {
  rows: {
    userId: string;
    email: string;
    scopes: string[];
    accessTokenEnc: string;
    refreshTokenEnc: string;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
  }[] = [];

  async save(input: {
    userId: string;
    googleAccountEmail: string;
    scopes: string[];
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }): Promise<GoogleConnectionSummary> {
    const existing = this.rows.find(
      (r) => r.userId === input.userId && r.email === input.googleAccountEmail
    );
    const row = existing ?? {
      userId: input.userId,
      email: input.googleAccountEmail,
      scopes: input.scopes,
      accessTokenEnc: "",
      refreshTokenEnc: "",
      expiresAt: input.expiresAt,
      revokedAt: null as Date | null,
      createdAt: new Date(),
    };
    row.scopes = input.scopes;
    row.accessTokenEnc = encryption.encrypt(input.accessToken);
    row.refreshTokenEnc = encryption.encrypt(input.refreshToken);
    row.expiresAt = input.expiresAt;
    row.revokedAt = null;
    if (!existing) this.rows.push(row);

    return {
      id: "conn-1",
      userId: row.userId,
      googleAccountEmail: row.email,
      scopes: row.scopes,
      connectedAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: null,
    };
  }

  private active(userId: string) {
    return this.rows.find((r) => r.userId === userId && r.revokedAt === null) ?? null;
  }

  async findByUser(userId: string): Promise<GoogleConnectionSummary | null> {
    const row = this.active(userId);
    if (!row) return null;
    return {
      id: "conn-1",
      userId: row.userId,
      googleAccountEmail: row.email,
      scopes: row.scopes,
      connectedAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: null,
    };
  }

  async getCredentials(userId: string): Promise<GoogleCredentials | null> {
    const row = this.active(userId);
    if (!row) return null;
    return {
      accessToken: encryption.decrypt(row.accessTokenEnc),
      refreshToken: encryption.decrypt(row.refreshTokenEnc),
      expiresAt: row.expiresAt,
      scopes: row.scopes,
    };
  }

  async updateAccessToken(userId: string, accessToken: string, expiresAt: Date): Promise<void> {
    const row = this.active(userId);
    if (!row) return;
    row.accessTokenEnc = encryption.encrypt(accessToken);
    row.expiresAt = expiresAt;
  }

  async revoke(userId: string): Promise<void> {
    const row = this.active(userId);
    if (row) row.revokedAt = new Date();
  }
}

class MemoryStateRepo implements IOAuthStateRepository {
  rows = new Map<string, OAuthStateRecord>();

  async create(record: OAuthStateRecord): Promise<void> {
    this.rows.set(record.state, record);
  }

  /** Single-use, exactly like the Prisma delete-on-read implementation. */
  async consume(state: string): Promise<OAuthStateRecord | null> {
    const row = this.rows.get(state);
    if (!row) return null;
    this.rows.delete(state);
    return row;
  }

  async deleteExpired(now: Date): Promise<number> {
    let n = 0;
    for (const [k, v] of this.rows) {
      if (v.expiresAt < now) {
        this.rows.delete(k);
        n++;
      }
    }
    return n;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GRANTED = `${GOOGLE_ADS_SCOPE} openid email`;

const TOKEN_A = "token-user-1";
const TOKEN_B = "token-user-2";

interface TestResponse {
  status: number;
  body: any;
}

/**
 * Walks the router stack directly, mirroring the harness in dashboard-api.test.ts.
 * Keeps the suite dependency-free: no HTTP server, no supertest.
 */
async function call(
  router: Router,
  method: string,
  path: string,
  options: { token?: string } = {}
): Promise<TestResponse> {
  const parsed = new URL(path, "http://test");
  const pathname = parsed.pathname;

  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  };

  const stack =
    ((router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (...args: any[]) => unknown }>;
        };
      }>;
    }).stack) ?? [];

  for (const layer of stack) {
    if (!layer.route) continue;
    if (!layer.route.methods[method.toLowerCase()]) continue;

    const regex = new RegExp("^" + layer.route.path.replace(/:[^/]+/g, "([^/]+)") + "$");
    if (!pathname.match(regex)) continue;

    const req = {
      method,
      url: pathname + parsed.search,
      originalUrl: pathname + parsed.search,
      path: pathname,
      params: {},
      query: Object.fromEntries(parsed.searchParams),
      headers,
      body: {},
      get(header: string) {
        return headers[header];
      },
    };

    const chain = layer.route.stack;
    const responded = () => (res as unknown as { _body: unknown })._body !== null;
    const runAt = (i: number): unknown => {
      if (responded()) return undefined;
      const entry = chain[i];
      if (!entry) return undefined;
      if (entry.handle.length >= 3) {
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

interface Harness {
  router: Router;
  connections: MemoryConnectionRepo;
  states: MemoryStateRepo;
  token: string;
  otherToken: string;
  fetchCalls: { url: string; init: any }[];
}

function makeHarness(fetchResponses: { status: number; body: unknown }[] = []): Harness {
  const connections = new MemoryConnectionRepo();
  const states = new MemoryStateRepo();
  const fetchCalls: { url: string; init: any }[] = [];

  // Opaque test tokens rather than real JWTs: this suite exercises the Google
  // routes, not the token implementation, which auth.test.ts already covers.
  const tokenService = {
    verifyAccessToken: (token: string) => {
      if (token === TOKEN_A) return { userId: "user-1", role: "member", email: "a@test.local" };
      if (token === TOKEN_B) return { userId: "user-2", role: "member", email: "b@test.local" };
      return null;
    },
  };

  let callIndex = 0;
  const fetchImpl = (async (url: string, init: any) => {
    fetchCalls.push({ url, init });
    const r = fetchResponses[callIndex++] ?? { status: 200, body: {} };
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  }) as unknown as typeof fetch;

  const router = createGoogleAuthRouter({ tokenService } as never, {
    connections,
    oauthStates: states,
    config,
    fetchImpl,
  });

  return { router, connections, states, token: TOKEN_A, otherToken: TOKEN_B, fetchCalls };
}

/** Drives connect -> callback, leaving the harness connected as user-1. */
async function connect(h: Harness): Promise<string> {
  const start = await call(h.router, "POST", "/connect", { token: h.token });
  const state = new URL(start.body.data.authUrl).searchParams.get("state")!;
  await call(h.router, "GET", `/callback?code=auth-code&state=${state}`);
  return state;
}

const TOKEN_OK = {
  status: 200,
  body: {
    access_token: "ya29.test-access",
    refresh_token: "1//test-refresh",
    expires_in: 3600,
    scope: GRANTED,
  },
};
const USERINFO_OK = { status: 200, body: { email: "ads@example.com" } };

describe("Sprint 5.2 — Google OAuth API", () => {
  describe("authentication", () => {
    it("requires a bearer token on /status", async () => {
      const h = makeHarness();
      const res = await call(h.router, "GET", "/status");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    });

    it("requires a bearer token on /connect", async () => {
      const h = makeHarness();
      expect((await call(h.router, "POST", "/connect")).status).toBe(401);
    });

    it("requires a bearer token on /disconnect", async () => {
      const h = makeHarness();
      expect((await call(h.router, "POST", "/disconnect")).status).toBe(401);
    });

    it("rejects a malformed token", async () => {
      const h = makeHarness();
      const res = await call(h.router, "GET", "/status", { token: "not-a-real-token" });
      expect(res.status).toBe(401);
    });

    it("reports not-connected for an authenticated user with no connection", async () => {
      const h = makeHarness();
      const res = await call(h.router, "GET", "/status", { token: h.token });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ configured: true, connected: false, account: null });
    });
  });

  describe("connect — PKCE and state", () => {
    it("returns a Google consent URL with S256 PKCE", async () => {
      const h = makeHarness();
      const res = await call(h.router, "POST", "/connect", { token: h.token });

      expect(res.status).toBe(200);
      const url = new URL(res.body.data.authUrl);
      expect(url.hostname).toBe("accounts.google.com");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("access_type")).toBe("offline");
    });

    it("persists a single-use state bound to the initiating user", async () => {
      const h = makeHarness();
      const res = await call(h.router, "POST", "/connect", { token: h.token });
      const state = new URL(res.body.data.authUrl).searchParams.get("state")!;
      expect(h.states.rows.get(state)?.userId).toBe("user-1");
    });

    it("NEVER returns the code verifier or client secret to the caller", async () => {
      const h = makeHarness();
      const res = await call(h.router, "POST", "/connect", { token: h.token });
      const blob = JSON.stringify(res.body);
      expect(blob).not.toContain("test-client-secret");
      expect(blob).not.toContain("code_verifier");
      const verifier = h.states.rows.get(
        new URL(res.body.data.authUrl).searchParams.get("state")!
      )!.codeVerifier;
      expect(blob).not.toContain(verifier);
    });

    it("issues a distinct state per request", async () => {
      const h = makeHarness();
      const a = await call(h.router, "POST", "/connect", { token: h.token });
      const b = await call(h.router, "POST", "/connect", { token: h.token });
      expect(new URL(a.body.data.authUrl).searchParams.get("state")).not.toBe(
        new URL(b.body.data.authUrl).searchParams.get("state")
      );
    });
  });

  describe("callback — token handling", () => {
    it("stores the connection and reports the account", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK]);
      const start = await call(h.router, "POST", "/connect", { token: h.token });
      const state = new URL(start.body.data.authUrl).searchParams.get("state")!;

      const res = await call(h.router, "GET", `/callback?code=auth-code&state=${state}`);

      expect(res.status).toBe(200);
      expect(res.body.data.account.email).toBe("ads@example.com");
      expect(h.connections.rows).toHaveLength(1);
    });

    it("stores tokens ENCRYPTED, never as plaintext", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK]);
      await connect(h);

      const row = h.connections.rows[0];
      expect(row.accessTokenEnc).not.toContain("ya29.test-access");
      expect(row.refreshTokenEnc).not.toContain("1//test-refresh");
      expect(row.accessTokenEnc.startsWith("v1:")).toBe(true);
      // ...and they still decrypt to the originals.
      expect(encryption.decrypt(row.accessTokenEnc)).toBe("ya29.test-access");
      expect(encryption.decrypt(row.refreshTokenEnc)).toBe("1//test-refresh");
    });

    it("sends the PKCE verifier to Google during the exchange", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK]);
      const start = await call(h.router, "POST", "/connect", { token: h.token });
      const state = new URL(start.body.data.authUrl).searchParams.get("state")!;
      const verifier = h.states.rows.get(state)!.codeVerifier;

      await call(h.router, "GET", `/callback?code=auth-code&state=${state}`);

      const body = new URLSearchParams(h.fetchCalls[0].init.body);
      expect(body.get("code_verifier")).toBe(verifier);
    });

    it("REJECTS a replayed authorization code (state is single-use)", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK, TOKEN_OK, USERINFO_OK]);
      const start = await call(h.router, "POST", "/connect", { token: h.token });
      const state = new URL(start.body.data.authUrl).searchParams.get("state")!;

      const first = await call(h.router, "GET", `/callback?code=c&state=${state}`);
      expect(first.status).toBe(200);

      const replay = await call(h.router, "GET", `/callback?code=c&state=${state}`);
      expect(replay.status).toBe(400);
      expect(replay.body.error.message).toMatch(/already-used|Invalid/i);
    });

    it("rejects an unknown state — CSRF defence", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK]);
      const res = await call(
        h.router,
        "GET",
        "/callback?code=attacker-code&state=forged-state"
      );
      expect(res.status).toBe(400);
      expect(h.connections.rows).toHaveLength(0);
    });

    it("rejects an expired state", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK]);
      const start = await call(h.router, "POST", "/connect", { token: h.token });
      const state = new URL(start.body.data.authUrl).searchParams.get("state")!;
      h.states.rows.get(state)!.expiresAt = new Date(Date.now() - 1000);

      const res = await call(h.router, "GET", `/callback?code=c&state=${state}`);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/expired/i);
    });

    it("rejects a callback with no code", async () => {
      const h = makeHarness();
      const res = await call(h.router, "GET", "/callback?state=abc");
      expect(res.status).toBe(400);
    });

    it("handles a declined consent screen", async () => {
      const h = makeHarness();
      const res = await call(h.router, "GET", "/callback?error=access_denied&state=abc");
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not granted/i);
    });

    it("REFUSES a partial scope grant rather than storing a doomed connection", async () => {
      const h = makeHarness([
        { status: 200, body: { access_token: "ya29.a", refresh_token: "1//r", expires_in: 3600, scope: "openid email" } },
        USERINFO_OK,
      ]);
      const start = await call(h.router, "POST", "/connect", { token: h.token });
      const state = new URL(start.body.data.authUrl).searchParams.get("state")!;

      const res = await call(h.router, "GET", `/callback?code=c&state=${state}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("AUTHORIZATION_FAILED");
      expect(h.connections.rows).toHaveLength(0);
    });

    it("surfaces invalid_grant as 401 without leaking the code", async () => {
      const h = makeHarness([{ status: 400, body: { error: "invalid_grant" } }]);
      const start = await call(h.router, "POST", "/connect", { token: h.token });
      const state = new URL(start.body.data.authUrl).searchParams.get("state")!;

      const res = await call(h.router, "GET", `/callback?code=secret-code&state=${state}`);
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain("secret-code");
    });
  });

  describe("response hygiene", () => {
    it("never serialises tokens or secrets on /status", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK]);
      await connect(h);

      const res = await call(h.router, "GET", "/status", { token: h.token });

      const blob = JSON.stringify(res.body);
      for (const secret of [
        "ya29.test-access",
        "1//test-refresh",
        "test-client-secret",
        "test-developer-token",
        "accessTokenEnc",
        "refreshTokenEnc",
      ]) {
        expect(blob).not.toContain(secret);
      }
      // The non-secret facts a UI needs are present.
      expect(res.body.data.account.email).toBe("ads@example.com");
      expect(res.body.data.connected).toBe(true);
    });

    it("never serialises tokens on the callback response", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK]);
      const start = await call(h.router, "POST", "/connect", { token: h.token });
      const state = new URL(start.body.data.authUrl).searchParams.get("state")!;
      const res = await call(h.router, "GET", `/callback?code=c&state=${state}`);

      const blob = JSON.stringify(res.body);
      expect(blob).not.toContain("ya29.test-access");
      expect(blob).not.toContain("1//test-refresh");
    });
  });

  describe("authorization — cross-user isolation", () => {
    it("does not show one user the other's connection", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK]);
      await connect(h); // connects user-1

      const other = await call(h.router, "GET", "/status", { token: h.otherToken });

      expect(other.body.data.connected).toBe(false);
      expect(other.body.data.account).toBeNull();
    });

    it("does not let one user disconnect another's connection", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK]);
      await connect(h); // user-1 connected

      const res = await call(h.router, "POST", "/disconnect", { token: h.otherToken });

      expect(res.body.data.disconnected).toBe(false);
      // user-1's connection is untouched.
      expect(await h.connections.getCredentials("user-1")).not.toBeNull();
    });
  });

  describe("disconnect", () => {
    it("revokes locally and reports Google revocation", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK, { status: 200, body: {} }]);
      await connect(h);

      const res = await call(h.router, "POST", "/disconnect", { token: h.token });

      expect(res.body.data).toMatchObject({ disconnected: true, revokedAtGoogle: true });
      expect(await h.connections.getCredentials("user-1")).toBeNull();
    });

    it("revokes locally even when Google revocation fails", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK, { status: 500, body: {} }]);
      await connect(h);

      const res = await call(h.router, "POST", "/disconnect", { token: h.token });

      expect(res.body.data.disconnected).toBe(true);
      expect(res.body.data.revokedAtGoogle).toBe(false);
      // The important half: we no longer hold usable credentials.
      expect(await h.connections.getCredentials("user-1")).toBeNull();
    });

    it("is a no-op when nothing is connected", async () => {
      const h = makeHarness();
      const res = await call(h.router, "POST", "/disconnect", { token: h.token });
      expect(res.body.data.disconnected).toBe(false);
    });

    it("makes a revoked connection invisible to status", async () => {
      const h = makeHarness([TOKEN_OK, USERINFO_OK, { status: 200, body: {} }]);
      await connect(h);
      await call(h.router, "POST", "/disconnect", { token: h.token });

      const res = await call(h.router, "GET", "/status", { token: h.token });
      expect(res.body.data.connected).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Approval boundary — verified against the REAL ToolApprovalService
// ---------------------------------------------------------------------------

describe("Sprint 5.2 — approval boundary", () => {
  const provider = new MockGoogleAdsProvider();

  // Valid params per tool: checkPreExecution runs tool.validate(), so a tool
  // whose required parameters are missing is rejected before the risk check
  // and would not actually prove anything about approval.
  const cases: { tool: ITool; params: Record<string, unknown> }[] = [
    { tool: new GoogleGetAccountsTool(provider, provider), params: {} },
    {
      tool: new GoogleGetCampaignsTool(provider, provider),
      params: { customerId: "1234567890" },
    },
    {
      tool: new GoogleGetInsightsTool(provider, provider),
      params: { customerId: "1234567890", since: "2026-08-01", until: "2026-08-31" },
    },
  ];

  function makeApprovalService() {
    const approvalRepo = {
      create: vi.fn(async (data: any) => ({
        id: "appr-1",
        ...data,
        status: "pending",
        expiresAt: new Date(Date.now() + 600000),
      })),
      findById: vi.fn(async () => null),
      findExistingForTool: vi.fn(async () => null),
      update: vi.fn(async () => undefined),
    };
    const auditRepo = { create: vi.fn(async () => ({ id: "audit-1" })), query: vi.fn(async () => []) };
    return {
      service: new ToolApprovalService(
        approvalRepo as never,
        auditRepo as never,
        new PermissionService() as never
      ),
      approvalRepo,
      auditRepo,
    };
  }

  /** A hypothetical Google WRITE tool, to prove the gate is risk-driven. */
  function writeLikeTool(): ITool {
    const base = cases[1].tool;
    return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      id: "google.campaign.pause",
      risk: "EXTERNAL_SIDE_EFFECT",
      requiredPermissions: ["write"],
      requiresApproval: true,
    }) as ITool;
  }

  it("auto-approves Google read tools through the real service", async () => {
    const { service, approvalRepo } = makeApprovalService();

    for (const { tool, params } of cases) {
      const check = await service.checkPreExecution(tool, params, {
        userId: "user-1",
        role: "member",
        traceId: "t-1",
      });
      expect(check.allowed).toBe(true);
      expect(check.requiresApproval).toBe(false);
    }
    // No approval row is created for a read-only tool.
    expect(approvalRepo.create).not.toHaveBeenCalled();
  });

  it("denies a role lacking the required permission", async () => {
    const { service } = makeApprovalService();
    const check = await service.checkPreExecution(
      writeLikeTool(),
      { customerId: "1234567890" },
      { userId: "user-1", role: "viewer", traceId: "t-2" }
    );
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/permission/i);
  });

  it("requires approval for a would-be Google write tool", async () => {
    const { service, approvalRepo } = makeApprovalService();
    const check = await service.checkPreExecution(
      writeLikeTool(),
      { customerId: "1234567890" },
      { userId: "user-1", role: "admin", traceId: "t-3" }
    );
    // EXTERNAL_SIDE_EFFECT is gated by the existing RISK_REQUIRES_APPROVAL
    // table, with no Google-specific code involved.
    expect(check.requiresApproval).toBe(true);
    expect(check.allowed).toBe(false);
    expect(approvalRepo.create).toHaveBeenCalled();
  });

  it("denies a disabled Google tool outright", async () => {
    const { service } = makeApprovalService();
    const disabled = Object.assign(
      Object.create(Object.getPrototypeOf(cases[0].tool)),
      cases[0].tool,
      { enabled: false }
    ) as ITool;
    const check = await service.checkPreExecution(disabled, {}, {
      userId: "user-1",
      role: "member",
      traceId: "t-4",
    });
    expect(check.allowed).toBe(false);
  });
});
