// ---------------------------------------------------------------------------
// Sprint 4.3 — Dashboard data API.
//
// The router is driven with doubles for the repositories and the ToolExecutor,
// so no Postgres, no Meta token and no network are involved. What is NOT faked
// is the router's own behaviour: validation, account resolution, metric
// normalisation and the read-only tool allow-list are all the real code.
//
// The allow-list matters most. Several tests assert on exactly which tool ids
// reached the executor, because "rendering a dashboard can never trigger a
// write" has to be enforced, not assumed.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Router } from "express";
import { createDashboardRouter } from "../src/routes/dashboard.js";
import type { ToolExecutionResult } from "@jarvis/core";

const USER_A = "user-alpha";
const USER_B = "user-beta";
const TOKEN_A = "token-alpha";
const TOKEN_B = "token-beta";
const ACCOUNT = "act_1234567890";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface ExecutorCall {
  toolId: string;
  params: Record<string, unknown>;
  userId: string;
}

class FakeExecutor {
  calls: ExecutorCall[] = [];
  /** Rows returned per tool id; absent means "no rows". */
  rows: Record<string, Record<string, unknown>[]> = {};
  failWith: string | null = null;
  throwWith: Error | null = null;
  /**
   * Executor status to answer with. These are the REAL literals from
   * ToolExecutionStatus — "completed" is success, not "SUCCESS". Getting this
   * wrong is exactly the defect this fake exists to catch.
   */
  status: ToolExecutionResult["status"] = "completed";

  async execute(request: {
    toolId: string;
    params: Record<string, unknown>;
    userId: string;
  }): Promise<ToolExecutionResult> {
    this.calls.push({ toolId: request.toolId, params: request.params, userId: request.userId });

    if (this.throwWith) throw this.throwWith;

    if (this.status !== "completed") {
      return {
        executionId: "exec-1",
        toolId: request.toolId,
        status: this.status,
        startedAt: new Date(),
      } as unknown as ToolExecutionResult;
    }

    if (this.failWith) {
      return {
        executionId: "exec-1",
        toolId: request.toolId,
        status: "failed",
        result: { success: false, error: this.failWith },
        startedAt: new Date(),
      } as unknown as ToolExecutionResult;
    }

    return {
      executionId: "exec-1",
      toolId: request.toolId,
      status: "completed",
      result: { success: true, data: { insights: this.rows[request.toolId] ?? [] } },
      startedAt: new Date(),
    } as unknown as ToolExecutionResult;
  }
}

interface ContainerOptions {
  executor: FakeExecutor;
  approvalsTotal?: number;
  conversations?: number;
  documents?: Array<{ status: string }>;
  opportunitiesTotal?: number;
  knowledge?: boolean;
  retriever?: boolean;
  memory?: boolean;
  embeddings?: boolean;
  throwOnSummary?: boolean;
}

function makeContainer(options: ContainerOptions) {
  const seenUserIds: string[] = [];

  return {
    _seenUserIds: seenUserIds,
    tokenService: {
      verifyAccessToken: (token: string) => {
        if (token === TOKEN_A) return { userId: USER_A, role: "member", email: "a@example.com" };
        if (token === TOKEN_B) return { userId: USER_B, role: "member", email: "b@example.com" };
        return null;
      },
    },
    executor: options.executor,
    approvalRepo: {
      listByUser: async (userId: string) => {
        seenUserIds.push(userId);
        if (options.throwOnSummary) throw new Error("db down");
        return { items: [], total: options.approvalsTotal ?? 0 };
      },
    },
    conversationRepo: {
      listByUserId: async (userId: string) => {
        seenUserIds.push(userId);
        return Array.from({ length: options.conversations ?? 0 }, (_, i) => ({ id: `c${i}` }));
      },
    },
    knowledgeRepo: options.knowledge === false
      ? undefined
      : {
          listDocuments: async (userId: string) => {
            seenUserIds.push(userId);
            return options.documents ?? [];
          },
        },
    knowledgeRetriever: options.retriever === false ? null : {},
    memoryStore: options.memory === false ? null : {},
    embeddingProvider: options.embeddings === false ? null : {},
  } as unknown as Parameters<typeof createDashboardRouter>[0] & { _seenUserIds: string[] };
}

function makeRouter(options: ContainerOptions, opportunitiesTotal = 0) {
  const container = makeContainer(options);
  const router = createDashboardRouter(container, {
    recommendationRepo: {
      listForOpportunityQueue: async (userId: string) => {
        (container as unknown as { _seenUserIds: string[] })._seenUserIds.push(userId);
        return { items: [], total: options.opportunitiesTotal ?? opportunitiesTotal };
      },
    } as never,
  });
  return { router, container };
}

// ---------------------------------------------------------------------------
// Request harness: walks the router the way express does.
// ---------------------------------------------------------------------------

interface TestResponse {
  status: number;
  body: any;
}

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
    const match = pathname.match(regex);
    if (!match) continue;

    const req = {
      method,
      url: pathname + parsed.search,
      originalUrl: pathname + parsed.search,
      path: pathname,
      params: {},
      query: Object.fromEntries(parsed.searchParams),
      headers,
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

// ---------------------------------------------------------------------------

const ORIGINAL_ACCOUNT = process.env.META_AD_ACCOUNT_ID;

beforeEach(() => {
  process.env.META_AD_ACCOUNT_ID = ACCOUNT;
});

afterEach(() => {
  if (ORIGINAL_ACCOUNT === undefined) delete process.env.META_AD_ACCOUNT_ID;
  else process.env.META_AD_ACCOUNT_ID = ORIGINAL_ACCOUNT;
  vi.restoreAllMocks();
});

const RANGE = "startDate=2026-08-01&endDate=2026-08-03";

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("dashboard API — authorization", () => {
  const ROUTES = [
    "/summary",
    "/status",
    `/meta/overview?${RANGE}`,
    `/meta/timeseries?${RANGE}`,
    `/meta/campaigns?${RANGE}`,
  ];

  it("rejects every route without a token", async () => {
    const { router } = makeRouter({ executor: new FakeExecutor() });
    for (const route of ROUTES) {
      const res = await call(router, "GET", route);
      expect(res.status, route).toBe(401);
      expect(res.body.success).toBe(false);
    }
  });

  it("rejects every route with an unknown token", async () => {
    const { router } = makeRouter({ executor: new FakeExecutor() });
    for (const route of ROUTES) {
      const res = await call(router, "GET", route, { token: "forged" });
      expect(res.status, route).toBe(401);
    }
  });

  it("scopes every summary read to the caller, never another user", async () => {
    const { router, container } = makeRouter({ executor: new FakeExecutor() });
    await call(router, "GET", "/summary", { token: TOKEN_B });

    const seen = (container as unknown as { _seenUserIds: string[] })._seenUserIds;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => id === USER_B)).toBe(true);
    expect(seen).not.toContain(USER_A);
  });

  it("passes the caller's own identity to the tool executor", async () => {
    const executor = new FakeExecutor();
    const { router } = makeRouter({ executor });
    await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_B });
    expect(executor.calls.every((c) => c.userId === USER_B)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Read-only boundary
// ---------------------------------------------------------------------------

describe("dashboard API — read-only boundary", () => {
  const READ_ONLY = new Set(["meta.insights", "meta.campaigns", "meta.accounts"]);

  it("executes only read-only tools across every Meta route", async () => {
    const executor = new FakeExecutor();
    const { router } = makeRouter({ executor });

    await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });
    await call(router, "GET", `/meta/timeseries?${RANGE}`, { token: TOKEN_A });
    await call(router, "GET", `/meta/campaigns?${RANGE}`, { token: TOKEN_A });

    expect(executor.calls.length).toBeGreaterThan(0);
    for (const c of executor.calls) {
      expect(READ_ONLY.has(c.toolId), `unexpected tool ${c.toolId}`).toBe(true);
      expect(c.toolId).not.toMatch(/pause|resume|budget|create|update|delete/);
    }
  });

  it("triggers no tool at all for the non-Meta routes", async () => {
    const executor = new FakeExecutor();
    const { router } = makeRouter({ executor });
    await call(router, "GET", "/summary", { token: TOKEN_A });
    await call(router, "GET", "/status", { token: TOKEN_A });
    expect(executor.calls).toHaveLength(0);
  });

  it("takes the account id from server config and ignores any the client sends", async () => {
    const executor = new FakeExecutor();
    const { router } = makeRouter({ executor });

    await call(router, "GET", `/meta/overview?${RANGE}&accountId=act_999999999`, { token: TOKEN_A });

    expect(executor.calls[0]!.params.accountId).toBe(ACCOUNT);
    expect(JSON.stringify(executor.calls)).not.toContain("act_999999999");
  });
});

// ---------------------------------------------------------------------------
// Summary + status
// ---------------------------------------------------------------------------

describe("dashboard API — summary", () => {
  it("returns counts drawn from the existing repositories", async () => {
    const { router } = makeRouter({
      executor: new FakeExecutor(),
      approvalsTotal: 3,
      conversations: 5,
      documents: [{ status: "PROCESSED" }, { status: "PROCESSED" }, { status: "FAILED" }],
      opportunitiesTotal: 9,
    });

    const res = await call(router, "GET", "/summary", { token: TOKEN_A });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      pendingApprovals: 3,
      conversations: 5,
      knowledgeDocuments: 3,
      knowledgeProcessed: 2,
      openOpportunities: 9,
      metaConfigured: true,
    });
  });

  it("reports zeros, not failure, when the account has nothing yet", async () => {
    const { router } = makeRouter({ executor: new FakeExecutor() });
    const res = await call(router, "GET", "/summary", { token: TOKEN_A });
    expect(res.status).toBe(200);
    expect(res.body.data.pendingApprovals).toBe(0);
    expect(res.body.data.knowledgeDocuments).toBe(0);
  });

  it("says Meta is not configured rather than reporting zero opportunities", async () => {
    delete process.env.META_AD_ACCOUNT_ID;
    const { router } = makeRouter({ executor: new FakeExecutor(), opportunitiesTotal: 4 });
    const res = await call(router, "GET", "/summary", { token: TOKEN_A });
    expect(res.status).toBe(200);
    expect(res.body.data.metaConfigured).toBe(false);
    expect(res.body.data.openOpportunities).toBe(0);
  });

  it("survives a knowledge base that is not wired", async () => {
    const { router } = makeRouter({ executor: new FakeExecutor(), knowledge: false });
    const res = await call(router, "GET", "/summary", { token: TOKEN_A });
    expect(res.status).toBe(200);
    expect(res.body.data.knowledgeDocuments).toBe(0);
  });

  it("answers 500 without leaking the underlying failure", async () => {
    const { router } = makeRouter({ executor: new FakeExecutor(), throwOnSummary: true });
    const res = await call(router, "GET", "/summary", { token: TOKEN_A });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("db down");
  });
});

describe("dashboard API — status", () => {
  it("reports capabilities as booleans only", async () => {
    const { router } = makeRouter({ executor: new FakeExecutor() });
    const res = await call(router, "GET", "/status", { token: TOKEN_A });

    expect(res.status).toBe(200);
    expect(res.body.data.capabilities).toEqual({
      knowledgeBase: true,
      retrieval: true,
      memory: true,
      embeddings: true,
      metaAds: true,
    });
    for (const v of Object.values(res.body.data.capabilities)) {
      expect(typeof v).toBe("boolean");
    }
  });

  it("reflects a deployment with nothing optional wired", async () => {
    delete process.env.META_AD_ACCOUNT_ID;
    const { router } = makeRouter({
      executor: new FakeExecutor(),
      knowledge: false,
      retriever: false,
      memory: false,
      embeddings: false,
    });
    const res = await call(router, "GET", "/status", { token: TOKEN_A });
    expect(res.body.data.capabilities).toEqual({
      knowledgeBase: false,
      retrieval: false,
      memory: false,
      embeddings: false,
      metaAds: false,
    });
  });

  it("exposes no secret, token or connection string", async () => {
    const { router } = makeRouter({ executor: new FakeExecutor() });
    const res = await call(router, "GET", "/status", { token: TOKEN_A });
    const body = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ["token", "secret", "key", "password", "postgres", "act_"]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Meta metrics
// ---------------------------------------------------------------------------

const DAY = (date: string, spend: string, impressions: string, clicks: string) => ({
  date_start: date,
  date_stop: date,
  spend,
  impressions,
  clicks,
  ctr: "1.5",
  cpc: "0.50",
});

describe("dashboard API — Meta overview", () => {
  it("totals a range and recomputes rates rather than averaging them", async () => {
    const executor = new FakeExecutor();
    executor.rows["meta.insights"] = [
      { spend: "100.00", impressions: "10000", clicks: "200", conversions: "10", revenue: "400" },
    ];
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });

    expect(res.status).toBe(200);
    expect(res.body.data.totals.spend).toBe(100);
    expect(res.body.data.totals.clicks).toBe(200);
    expect(res.body.data.totals.ctr).toBeCloseTo(2, 5); // 200/10000 * 100
    expect(res.body.data.totals.cpc).toBeCloseTo(0.5, 5);
    expect(res.body.data.totals.cpa).toBeCloseTo(10, 5);
    expect(res.body.data.totals.roas).toBeCloseTo(4, 5);
    expect(res.body.data.dateRange).toEqual({ start: "2026-08-01", end: "2026-08-03" });
  });

  it("returns nulls, never invented zeros, when Meta reports no rows", async () => {
    const executor = new FakeExecutor();
    executor.rows["meta.insights"] = [];
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });

    expect(res.status).toBe(200);
    expect(res.body.data.rowCount).toBe(0);
    expect(res.body.data.totals.spend).toBeNull();
    expect(res.body.data.totals.roas).toBeNull();
  });

  it("leaves a metric null when its divisor is zero", async () => {
    const executor = new FakeExecutor();
    executor.rows["meta.insights"] = [{ spend: "50.00", impressions: "0", clicks: "0", conversions: "0" }];
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });
    expect(res.body.data.totals.cpc).toBeNull();
    expect(res.body.data.totals.cpa).toBeNull();
    expect(res.body.data.totals.ctr).toBeNull();
  });

  it("defaults to a 30-day window ending yesterday when no dates are given", async () => {
    const executor = new FakeExecutor();
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", "/meta/overview", { token: TOKEN_A });

    expect(res.status).toBe(200);
    const { start, end } = res.body.data.dateRange;
    const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
    expect(days).toBe(30);
    expect(Date.parse(end)).toBeLessThan(Date.now());
  });

  it("answers 503 when no ad account is configured", async () => {
    delete process.env.META_AD_ACCOUNT_ID;
    const { router } = makeRouter({ executor: new FakeExecutor() });
    const res = await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ACCOUNT_NOT_CONFIGURED");
  });

  it("answers 502 when the upstream tool fails", async () => {
    const executor = new FakeExecutor();
    executor.failWith = "Meta rate limit reached";
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  // Regression for a defect found by driving the live API: the router
  // originally tested `status !== "SUCCESS"`, but the executor's success
  // literal is "completed". Every real request therefore came back 502 while
  // the unit tests passed, because the fake mirrored the same wrong constant.
  it("treats the executor's real success literal as success", async () => {
    const executor = new FakeExecutor();
    executor.status = "completed";
    executor.rows["meta.insights"] = [{ spend: "12.00", impressions: "100", clicks: "4" }];
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });
    expect(res.status).toBe(200);
    expect(res.body.data.totals.spend).toBe(12);
  });

  it("reports a permission denial as 403, not as an outage", async () => {
    const executor = new FakeExecutor();
    executor.status = "permission_denied";
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses to render data that would require an approval", async () => {
    for (const status of ["approval_required", "approval_pending", "approval_denied"] as const) {
      const executor = new FakeExecutor();
      executor.status = status;
      const { router } = makeRouter({ executor });

      const res = await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });
      expect(res.status, status).toBe(403);
      expect(res.body.error.code, status).toBe("APPROVAL_REQUIRED");
    }
  });

  it("treats a timeout as an upstream failure", async () => {
    const executor = new FakeExecutor();
    executor.status = "timed_out";
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("answers 500 when the executor throws outright", async () => {
    const executor = new FakeExecutor();
    executor.throwWith = new Error("socket hang up");
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/overview?${RANGE}`, { token: TOKEN_A });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("socket hang up");
  });
});

describe("dashboard API — Meta account context (Sprint 4.6)", () => {
  function withAccounts(accounts: Record<string, unknown>[]) {
    const executor = new FakeExecutor();
    // meta.accounts answers under an `accounts` key.
    executor.execute = async function (request: never) {
      const r = request as unknown as { toolId: string; params: Record<string, unknown>; userId: string };
      this.calls.push({ toolId: r.toolId, params: r.params, userId: r.userId });
      return {
        executionId: "e", toolId: r.toolId, status: "completed",
        result: { success: true, data: { accounts } }, startedAt: new Date(),
      } as never;
    }.bind(executor) as never;
    return executor;
  }

  it("returns curated context for the configured account", async () => {
    const executor = withAccounts([
      { accountId: ACCOUNT, name: "Zephyrine Ads", currency: "INR", timezoneName: "Asia/Kolkata", accountStatus: 1 },
      { accountId: "act_other", name: "Someone else", currency: "USD" },
    ]);
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", "/meta/account", { token: TOKEN_A });

    expect(res.status).toBe(200);
    expect(res.body.data.account).toEqual({
      accountId: ACCOUNT,
      name: "Zephyrine Ads",
      currency: "INR",
      timezone: "Asia/Kolkata",
      status: "1",
    });
  });

  it("refuses when the caller is not authorized for the configured account", async () => {
    // meta.accounts filters to the caller's authorized accounts, so the
    // configured one simply is not in the list.
    const executor = withAccounts([{ accountId: "act_other", name: "Someone else" }]);
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", "/meta/account", { token: TOKEN_A });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_NOT_AUTHORIZED");
    // And it leaks nothing about the account it did not return.
    expect(JSON.stringify(res.body)).not.toContain("Someone else");
    expect(JSON.stringify(res.body)).not.toContain("act_other");
  });

  it("refuses when the caller is authorized for nothing at all", async () => {
    const { router } = makeRouter({ executor: withAccounts([]) });
    const res = await call(router, "GET", "/meta/account", { token: TOKEN_A });
    expect(res.status).toBe(403);
  });

  it("requires a token", async () => {
    const { router } = makeRouter({ executor: withAccounts([]) });
    expect((await call(router, "GET", "/meta/account")).status).toBe(401);
  });

  it("answers 503 when no account is configured", async () => {
    delete process.env.META_AD_ACCOUNT_ID;
    const { router } = makeRouter({ executor: withAccounts([]) });
    const res = await call(router, "GET", "/meta/account", { token: TOKEN_A });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ACCOUNT_NOT_CONFIGURED");
  });

  it("never returns a token or raw payload from the accounts tool", async () => {
    const executor = withAccounts([
      { accountId: ACCOUNT, name: "Zephyrine Ads", access_token: "LEAK", raw: { secret: "LEAK" } },
    ]);
    const { router } = makeRouter({ executor });
    const res = await call(router, "GET", "/meta/account", { token: TOKEN_A });
    expect(JSON.stringify(res.body)).not.toContain("LEAK");
  });

  it("uses the read-only accounts tool and nothing else", async () => {
    const executor = withAccounts([{ accountId: ACCOUNT }]);
    const { router } = makeRouter({ executor });
    await call(router, "GET", "/meta/account", { token: TOKEN_A });
    expect(executor.calls.map((c) => c.toolId)).toEqual(["meta.accounts"]);
  });
});

describe("dashboard API — invalid parameters", () => {
  const CASES: Array<[string, string]> = [
    ["malformed start date", "startDate=01-08-2026&endDate=2026-08-03"],
    ["malformed end date", "startDate=2026-08-01&endDate=not-a-date"],
    ["only one date supplied", "startDate=2026-08-01"],
    ["reversed range", "startDate=2026-08-10&endDate=2026-08-01"],
    ["impossible calendar date", "startDate=2026-13-45&endDate=2026-13-46"],
    ["range longer than a year", "startDate=2020-01-01&endDate=2026-01-01"],
  ];

  for (const [name, qs] of CASES) {
    it(`rejects ${name} with 400`, async () => {
      const { router } = makeRouter({ executor: new FakeExecutor() });
      const res = await call(router, "GET", `/meta/overview?${qs}`, { token: TOKEN_A });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_REQUEST");
    });
  }

  it("never reaches the executor when validation fails", async () => {
    const executor = new FakeExecutor();
    const { router } = makeRouter({ executor });
    await call(router, "GET", "/meta/overview?startDate=bad&endDate=worse", { token: TOKEN_A });
    expect(executor.calls).toHaveLength(0);
  });

  it("rejects an out-of-range limit on the campaign comparison", async () => {
    const { router } = makeRouter({ executor: new FakeExecutor() });
    for (const limit of ["0", "51", "2.5", "abc"]) {
      const res = await call(router, "GET", `/meta/campaigns?${RANGE}&limit=${limit}`, { token: TOKEN_A });
      expect(res.status, limit).toBe(400);
    }
  });
});

describe("dashboard API — time series", () => {
  it("returns one point per day, in date order", async () => {
    const executor = new FakeExecutor();
    executor.rows["meta.insights"] = [
      DAY("2026-08-03", "30.00", "3000", "60"),
      DAY("2026-08-01", "10.00", "1000", "20"),
      DAY("2026-08-02", "20.00", "2000", "40"),
    ];
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/timeseries?${RANGE}`, { token: TOKEN_A });

    expect(res.status).toBe(200);
    expect(res.body.data.pointCount).toBe(3);
    expect(res.body.data.series.map((p: any) => p.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(res.body.data.series[0].spend).toBe(10);
  });

  it("asks Meta for daily granularity", async () => {
    const executor = new FakeExecutor();
    const { router } = makeRouter({ executor });
    await call(router, "GET", `/meta/timeseries?${RANGE}`, { token: TOKEN_A });
    expect(executor.calls[0]!.params.timeIncrement).toBe(1);
  });

  it("returns an empty series rather than an error when there is no data", async () => {
    const executor = new FakeExecutor();
    executor.rows["meta.insights"] = [];
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/timeseries?${RANGE}`, { token: TOKEN_A });
    expect(res.status).toBe(200);
    expect(res.body.data.series).toEqual([]);
    expect(res.body.data.pointCount).toBe(0);
  });

  it("drops rows Meta returned without a date", async () => {
    const executor = new FakeExecutor();
    executor.rows["meta.insights"] = [DAY("2026-08-01", "10.00", "1000", "20"), { spend: "5.00" }];
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/timeseries?${RANGE}`, { token: TOKEN_A });
    expect(res.body.data.pointCount).toBe(1);
  });
});

describe("dashboard API — campaign comparison", () => {
  it("returns campaigns ranked by spend", async () => {
    const executor = new FakeExecutor();
    executor.rows["meta.insights"] = [
      { campaign_id: "1", campaign_name: "Low", spend: "10.00", impressions: "100", clicks: "5" },
      { campaign_id: "2", campaign_name: "High", spend: "90.00", impressions: "900", clicks: "45" },
    ];
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/campaigns?${RANGE}`, { token: TOKEN_A });

    expect(res.status).toBe(200);
    expect(res.body.data.campaigns.map((c: any) => c.campaignName)).toEqual(["High", "Low"]);
    expect(res.body.data.campaignCount).toBe(2);
  });

  it("requests campaign-level insights", async () => {
    const executor = new FakeExecutor();
    const { router } = makeRouter({ executor });
    await call(router, "GET", `/meta/campaigns?${RANGE}`, { token: TOKEN_A });
    expect(executor.calls[0]!.params.level).toBe("campaign");
  });

  it("returns an empty list when the account has no campaigns", async () => {
    const executor = new FakeExecutor();
    executor.rows["meta.insights"] = [];
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/campaigns?${RANGE}`, { token: TOKEN_A });
    expect(res.status).toBe(200);
    expect(res.body.data.campaigns).toEqual([]);
  });

  it("never returns the raw provider payload", async () => {
    const executor = new FakeExecutor();
    executor.rows["meta.insights"] = [
      {
        campaign_id: "1",
        campaign_name: "One",
        spend: "10.00",
        access_token: "SHOULD_NEVER_APPEAR",
        raw_payload: { secret: "SHOULD_NEVER_APPEAR" },
      },
    ];
    const { router } = makeRouter({ executor });

    const res = await call(router, "GET", `/meta/campaigns?${RANGE}`, { token: TOKEN_A });
    expect(JSON.stringify(res.body)).not.toContain("SHOULD_NEVER_APPEAR");
  });
});
