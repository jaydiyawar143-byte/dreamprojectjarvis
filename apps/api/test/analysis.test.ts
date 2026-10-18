// ---------------------------------------------------------------------------
// Phase 11.10 — Analysis API route tests
//
// The route is a thin translation layer: HTTP -> AnalysisInput/caller ->
// container.analysisService. It holds NO provider, NO Meta client and NO
// account id of its own. These tests pin the parts unique to the route:
//   - authentication and the 503 config gates
//   - the deterministic NO_ANALYSIS -> HTTP status/code mapping
//   - the COMPLETED / DRY_RUN_OK success shapes
//   - accountId is NEVER read from the client
//   - the caller is built from the verified token, not the body
//   - unexpected throws become a static 500 with no internals
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Router } from "express";
import { createAnalysisRouter } from "../src/routes/analysis.js";
import type { Container } from "../src/services/container.js";
import type { AnalysisCaller, AnalysisInput, AnalysisOutcome } from "@jarvis/tools";
import { accessOver, memoryTenancy, organizationOwningEverything, type MemoryTenancy } from "./helpers/shared-access.js";

// ---------------------------------------------------------------------------
// Token service fake (matches the opportunities.test.ts shape)
// ---------------------------------------------------------------------------

class FakeTokenService {
  private tokens = new Map<string, { userId: string; role: string; email: string }>();

  issue(userId: string, role = "member"): string {
    const t = `tok-${userId}-${Math.random().toString(36).slice(2)}`;
    this.tokens.set(t, { userId, role, email: `${userId}@test.com` });
    return t;
  }

  verifyAccessToken(token: string) {
    return this.tokens.get(token) ?? null;
  }
  generateAccessToken(p: { userId: string; role: string; email: string }) {
    return this.issue(p.userId, p.role);
  }
  generateRefreshToken() {
    return "refresh";
  }
  hashToken(t: string) {
    return `h-${t}`;
  }
  getRefreshTokenExpiry() {
    return new Date(Date.now() + 86_400_000);
  }
}

// ---------------------------------------------------------------------------
// Router harness (same walker as opportunities.test.ts)
// ---------------------------------------------------------------------------

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  router: Router,
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<TestResponse> {
  const parsed = new URL(path, "http://test");
  let pathname = parsed.pathname.replace(/^\/analysis(?=\/|$)/, "") || "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(b: unknown) {
      this._body = b;
      return this;
    },
  };

  const stack =
    (router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (...args: unknown[]) => unknown }>;
        };
      }>;
    }).stack ?? [];

  for (const layer of stack) {
    if (!layer.route) continue;
    if (!layer.route.methods[method.toLowerCase()]) continue;
    const regex = new RegExp("^" + layer.route.path.replace(/:[^/]+/g, "([^/]+)") + "$");
    const match = pathname.match(regex);
    if (!match) continue;

    const params: Record<string, string> = {};
    const names = [...layer.route.path.matchAll(/:([^/]+)/g)].map((m) => m[1]);
    names.forEach((n, i) => {
      params[n] = decodeURIComponent(match[i + 1]!);
    });

    const req = {
      method,
      url: pathname + parsed.search,
      originalUrl: pathname + parsed.search,
      path: pathname,
      params,
      query: Object.fromEntries(parsed.searchParams),
      headers,
      body: body ?? {},
      ip: "127.0.0.1",
      get(h: string) {
        return headers[h.toLowerCase()] ?? "";
      },
    };

    let idx = 0;
    const chain = layer.route.stack;
    const responded = () => (res as unknown as { _body: unknown })._body !== null;

    const runAt = (i: number): unknown => {
      if (responded()) return undefined;
      const entry = chain[i];
      if (!entry) return undefined;
      return entry.handle(req, res, () => {
        idx++;
        return runAt(idx);
      });
    };

    await Promise.resolve(runAt(idx));
    // The handler runs inside the auth middleware's `next()`, whose promise
    // the middleware does not return: wait — bounded — until it has answered.
    for (let i = 0; i < 200 && !responded(); i++) await new Promise((r) => setImmediate(r));
    break;
  }

  const answered = (res as unknown as { _body: unknown })._body !== null;
  return {
    status: answered ? (res as unknown as { _status: number })._status : 404,
    body: ((res as unknown as { _body: unknown })._body ?? {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Service double — one instrumented analyze()
// ---------------------------------------------------------------------------

function serviceReturning(outcome: AnalysisOutcome) {
  const calls: Array<{ input: AnalysisInput; caller: AnalysisCaller }> = [];
  const service = {
    analyze: vi.fn(async (input: AnalysisInput, caller: AnalysisCaller) => {
      calls.push({ input, caller });
      return outcome;
    }),
  };
  return { service, calls };
}

const COMPLETED: AnalysisOutcome = {
  status: "COMPLETED",
  accountId: "act_1",
  traceId: "t-1",
  target: { id: "ad_x1", entityLevel: "AD" },
  scanSummary: { insightRowCount: 8, candidateCount: 1, criticalCount: 1 },
  recommendation: { status: "CREATED" },
  recommendationId: "rec_1",
} as unknown as AnalysisOutcome;

const DRY_RUN_OK: AnalysisOutcome = {
  status: "DRY_RUN_OK",
  accountId: "act_1",
  traceId: "t-1",
  target: { id: "ad_x1", entityLevel: "AD" },
  scanSummary: { insightRowCount: 8, candidateCount: 1, criticalCount: 1 },
} as unknown as AnalysisOutcome;

function noAnalysis(reason: string): AnalysisOutcome {
  return {
    status: "NO_ANALYSIS",
    reason,
    detail: "detail",
    message: `could not run: ${reason}`,
    traceId: "t-1",
    accountId: "act_1",
  } as unknown as AnalysisOutcome;
}

const USER = "user-alice";
let token: string;
let tokenSvc: FakeTokenService;

/**
 * Phase 17 — USER is a member of the Organization that owns the deployment's
 * Meta connection unless a test says otherwise: the setting this suite was
 * written for.
 */
const memberOfMetaOrg = () => organizationOwningEverything({ [USER]: "member" });

function buildRouter(
  outcomeOrService: AnalysisOutcome | null,
  tenancy: MemoryTenancy = memberOfMetaOrg()
): { router: Router; calls: Array<{ input: AnalysisInput; caller: AnalysisCaller }> } {
  const double = outcomeOrService ? serviceReturning(outcomeOrService) : null;
  const fakeContainer = {
    tokenService: tokenSvc,
    analysisService: double ? double.service : null,
    sharedAccess: accessOver(tenancy),
  } as unknown as Container;
  return {
    router: createAnalysisRouter(fakeContainer),
    calls: double ? double.calls : [],
  };
}

describe("Phase 11.10 — Analysis API", () => {
  beforeEach(() => {
    tokenSvc = new FakeTokenService();
    token = tokenSvc.issue(USER);
    process.env.META_ACCESS_TOKEN = "EAA-test-token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
  });

  // ── Authentication ────────────────────────────────────────────────────────
  it("401 without an auth token and never reaches the service", async () => {
    const { router, calls } = buildRouter(COMPLETED);
    const res = await call(router, "POST", "/", undefined, {});
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  // ── Config gates ──────────────────────────────────────────────────────────
  it("503 ACCOUNT_NOT_CONFIGURED when the service is null and env is absent", async () => {
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_AD_ACCOUNT_ID;
    const { router } = buildRouter(null);
    const res = await call(router, "POST", "/", token, {});
    expect(res.status).toBe(503);
    expect((res.body.error as Record<string, string>).code).toBe("ACCOUNT_NOT_CONFIGURED");
  });

  it("503 AI_PROVIDER_NOT_CONFIGURED when env is present but the service is null", async () => {
    const { router } = buildRouter(null);
    const res = await call(router, "POST", "/", token, {});
    expect(res.status).toBe(503);
    expect((res.body.error as Record<string, string>).code).toBe("AI_PROVIDER_NOT_CONFIGURED");
  });

  // ── Success shapes ────────────────────────────────────────────────────────
  it("returns 200 and the COMPLETED outcome", async () => {
    const { router } = buildRouter(COMPLETED);
    const res = await call(router, "POST", "/", token, {});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect((res.body.analysis as Record<string, unknown>).status).toBe("COMPLETED");
  });

  it("returns 200 and the DRY_RUN_OK outcome", async () => {
    const { router } = buildRouter(DRY_RUN_OK);
    const res = await call(router, "POST", "/", token, { dryRun: true });
    expect(res.status).toBe(200);
    expect((res.body.analysis as Record<string, unknown>).status).toBe("DRY_RUN_OK");
  });

  it("returns 200 for the legit negative answers NO_SAFE_TARGET and INSUFFICIENT_DATA", async () => {
    for (const reason of ["NO_SAFE_TARGET", "INSUFFICIENT_DATA"]) {
      const { router } = buildRouter(noAnalysis(reason));
      const res = await call(router, "POST", "/", token, {});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect((res.body.analysis as Record<string, unknown>).reason).toBe(reason);
    }
  });

  // ── NO_ANALYSIS -> HTTP mapping ───────────────────────────────────────────
  it.each([
    ["INVALID_INPUT", 400, "INVALID_INPUT"],
    ["ACCOUNT_UNAUTHORIZED", 403, "ACCOUNT_UNAUTHORIZED"],
    ["ALREADY_RUNNING", 409, "ANALYSIS_ALREADY_RUNNING"],
    ["READ_FAILED", 502, "META_READ_FAILED"],
    ["DIAGNOSIS_UNAVAILABLE", 503, "AI_PROVIDER_UNAVAILABLE"],
    ["PERSIST_FAILED", 500, "RECOMMENDATION_PERSIST_FAILED"],
  ])("maps %s to HTTP %i / %s", async (reason, status, code) => {
    const { router } = buildRouter(noAnalysis(reason));
    const res = await call(router, "POST", "/", token, {});
    expect(res.status).toBe(status);
    expect(res.body.success).toBe(false);
    expect((res.body.error as Record<string, string>).code).toBe(code);
  });

  // ── accountId can never come from the client ──────────────────────────────
  it("ignores a client-supplied accountId entirely", async () => {
    const { router, calls } = buildRouter(COMPLETED);
    await call(router, "POST", "/", token, { accountId: "act_hacker", dryRun: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.accountId).toBeUndefined();
    expect(calls[0]!.input.dryRun).toBe(false);
  });

  it("forwards dryRun:true and nothing else from the body", async () => {
    const { router, calls } = buildRouter(COMPLETED);
    await call(router, "POST", "/", token, {
      dryRun: true,
      secretKey: "EAA-body-secret",
      accountId: "act_hacker",
    });
    const input = calls[0]!.input;
    expect(input.dryRun).toBe(true);
    expect(JSON.stringify(input)).not.toMatch(/EAA|secretKey|hacker/);
  });

  // ── caller comes from the verified token ──────────────────────────────────
  it("builds the caller from the token, not the body", async () => {
    const { router, calls } = buildRouter(COMPLETED);
    await call(router, "POST", "/", token, { userId: "user-evil", role: "admin" });
    const caller = calls[0]!.caller;
    expect(caller.userId).toBe(USER);
    expect(caller.role).toBe("member");
    expect(caller.traceId).toBeTruthy();
    expect(caller.ipAddress).toBe("127.0.0.1");
  });

  // ── unexpected throw ──────────────────────────────────────────────────────
  it("turns an unexpected service throw into a static 500 with no internals", async () => {
    const service = {
      analyze: vi.fn(async () => {
        throw new Error("PG_URI=postgres://user:pass@host/db");
      }),
    };
    const fakeContainer = {
      tokenService: tokenSvc,
      analysisService: service,
      sharedAccess: accessOver(memberOfMetaOrg()),
    } as unknown as Container;
    const router = createAnalysisRouter(fakeContainer);

    const res = await call(router, "POST", "/", token, {});
    expect(res.status).toBe(500);
    expect((res.body.error as Record<string, string>).code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("PG_URI");
    expect(JSON.stringify(res.body)).not.toContain("postgres://");
  });

  // ── no secrets ────────────────────────────────────────────────────────────
  it("never echoes the Meta token from env into a response", async () => {
    const { router } = buildRouter(COMPLETED);
    const res = await call(router, "POST", "/", token, {});
    expect(JSON.stringify(res.body)).not.toMatch(/EAA-test-token/);
  });
});

// ---------------------------------------------------------------------------
// Phase 17 (review finding L11) — the deployment's Meta account is analysed
// only for a member of the Organization that owns the connection. Anyone else
// is answered EXACTLY as a deployment without Meta is answered — before
// anything about this deployment's setup is said — and nothing runs.
// ---------------------------------------------------------------------------

describe("Phase 17 — analysis belongs to the Meta connection's Organization", () => {
  beforeEach(() => {
    tokenSvc = new FakeTokenService();
    token = tokenSvc.issue(USER);
    process.env.META_ACCESS_TOKEN = "EAA-test-token";
    process.env.META_AD_ACCOUNT_ID = "act_1";
  });

  const outsider = () =>
    memoryTenancy({
      owners: { "meta/ads": "org-other" },
      members: [{ userId: "someone-else", tenantId: "org-other", role: "owner" }],
    });

  it("answers an outsider as a deployment without Meta, and never runs the analysis", async () => {
    const { router, calls } = buildRouter(COMPLETED, outsider());
    const res = await call(router, "POST", "/", token, {});

    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_AD_ACCOUNT_ID;
    const { router: unconfigured } = buildRouter(null);
    const baseline = await call(unconfigured, "POST", "/", token, {});

    expect(res.status).toBe(503);
    expect(res.body.error).toEqual(baseline.body.error);
    expect((res.body.error as Record<string, string>).code).toBe("ACCOUNT_NOT_CONFIGURED");
    expect(calls).toEqual([]);
  });

  it("does not tell an outsider that Meta is set up and only the AI provider is missing", async () => {
    // Meta configured, no AI: a member is told AI_PROVIDER_NOT_CONFIGURED,
    // which would tell an outsider the Meta account exists.
    const member = await call(buildRouter(null).router, "POST", "/", token, {});
    expect((member.body.error as Record<string, string>).code).toBe("AI_PROVIDER_NOT_CONFIGURED");
    const res = await call(buildRouter(null, outsider()).router, "POST", "/", token, {});
    expect((res.body.error as Record<string, string>).code).toBe("ACCOUNT_NOT_CONFIGURED");
  });

  it("refuses everyone while nobody owns the Meta connection", async () => {
    const { router, calls } = buildRouter(COMPLETED, memoryTenancy({}));
    const res = await call(router, "POST", "/", token, {});
    expect((res.body.error as Record<string, string>).code).toBe("ACCOUNT_NOT_CONFIGURED");
    expect(calls).toEqual([]);
  });

  it("fails closed when Organization access cannot be read", async () => {
    const tenancy = memberOfMetaOrg();
    tenancy.setFailing(true);
    const { router, calls } = buildRouter(COMPLETED, tenancy);
    const res = await call(router, "POST", "/", token, {});
    expect(res.status).toBe(503);
    expect((res.body.error as Record<string, string>).code).toBe("AUTHORIZATION_UNAVAILABLE");
    expect(calls).toEqual([]);
  });
});
