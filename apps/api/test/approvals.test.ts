// PHASE 10.7 — Production approval API.
// Covers spec items 1–15, 23–30 plus §18 real-write safety:
// authentication, user isolation, IDOR, atomic decisions, paramsHash
// integrity, account authorization, budget guardrails, draining safety,
// expiry, idempotent reject, audit trail, secret redaction, pagination,
// rate limiting (DB-window semantics), malformed ids, summary determinism,
// and an endpoint→executor→MOCK-provider chain that provably never touches
// a real Meta endpoint.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Router } from "express";
import {
  createApprovalsRouter,
} from "../src/routes/approvals.js";
import { computeParamsHash, APPROVAL_TTL_MS } from "@jarvis/core";
import type {
  Approval,
  ApprovalStatus,
  AuditEntry,
  AuditLogger,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

class FakeApprovalStore {
  rows = new Map<string, Approval>();
  seq = 0;

  create(
    data: Omit<Approval, "id" | "status" | "createdAt">
  ): Approval {
    const id = `appr${String(++this.seq).padStart(8, "0")}abcdef`;
    const row: Approval = {
      ...data,
      id,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.rows.set(id, row);
    return row;
  }

  private effective(row: Approval): Approval {
    if (
      (row.status === "pending" || row.status === "approved") &&
      new Date(row.expiresAt).getTime() <= Date.now()
    ) {
      return { ...row, status: "expired" };
    }
    return row;
  }

  findByIdForUser(id: string, userId: string): Approval | null {
    const row = this.rows.get(id);
    return row && row.userId === userId ? this.effective(row) : null;
  }

  /**
   * Mirrors PrismaApprovalRepository.decideApproval: the conditional
   * transition happens as ONE synchronous check-and-set over the map, so
   * interleaved async handlers can never double-transition.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  decideApproval(
    id: string,
    userId: string,
    decision: "approve" | "reject"
  ):
    | { outcome: "approved" | "rejected" }
    | { outcome: "not_found" }
    | { outcome: "forbidden" }
    | { outcome: "already_consumed" }
    | { outcome: "already_rejected"; idempotent: boolean }
    | { outcome: "expired" }
    | { outcome: "conflict"; currentState: string } {
    const row = this.rows.get(id);
    if (!row) return { outcome: "not_found" };
    if (row.userId !== userId) return { outcome: "forbidden" };
    if (row.status === "consumed") return { outcome: "already_consumed" };
    if (row.status === "rejected") {
      return { outcome: "already_rejected", idempotent: decision === "reject" };
    }

    const expired =
      new Date(row.expiresAt).getTime() <= Date.now();

    if (decision === "reject") {
      // Reject guards [PENDING, APPROVED]; anything else expired/denied.
      if (expired && row.status !== "approved") {
        return { outcome: "expired" };
      }
    } else {
      // Approve guards [PENDING] with expiry strictly in the future.
      if (expired) return { outcome: "expired" };
    }

    const guard =
      decision === "approve"
        ? row.status === "pending"
        : row.status === "pending" || row.status === "approved";
    if (!guard) {
      return { outcome: "conflict", currentState: row.status.toUpperCase() };
    }
    row.status = decision === "approve" ? "approved" : "rejected";
    row.resolvedAt = new Date().toISOString();
    return { outcome: decision === "approve" ? "approved" : "rejected" };
  }

  listByUser(
    userId: string,
    options?: { status?: ApprovalStatus; page?: number; limit?: number }
  ): { items: Approval[]; total: number } {
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
    const page = Math.max(options?.page ?? 1, 1);
    let mine = [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .map((r) => this.effective(r));
    if (options?.status) mine = mine.filter((r) => r.status === options.status);
    mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = mine.length;
    return {
      items: mine.slice((page - 1) * limit, page * limit),
      total,
    };
  }
}

class FakeAuditLog {
  entries: AuditEntry[] = [];
  logger: AuditLogger = {
    log: async (entry) => {
      this.entries.push({
        ...entry,
        id: `aud-${this.entries.length}`,
        timestamp: new Date(),
      } as AuditEntry);
    },
    query: async (filters) =>
      this.entries.filter(
        (e) =>
          (!filters.userId || e.userId === filters.userId) &&
          (!filters.startDate || e.timestamp >= filters.startDate) &&
          (!filters.endDate || e.timestamp <= filters.endDate)
      ),
  } as unknown as AuditLogger;
}

function makeTokenService() {
  const tokens = new Map<
    string,
    { userId: string; role: string; email: string }
  >();
  return {
    generateAccessToken(payload: {
      userId: string;
      role: string;
      email: string;
    }): string {
      const t = `tok-${payload.userId}-${Math.random().toString(36).slice(2)}`;
      tokens.set(t, payload);
      return t;
    },
    verifyAccessToken: (t: string) => tokens.get(t) ?? null,
    generateRefreshToken: () => "refresh",
    hashToken: (t: string) => `h-${t}`,
    getRefreshTokenExpiry: () => new Date(Date.now() + 86_400_000),
  };
}

const journalLinks = new Map<string, { executionId: string; status: string }>();

function makeContainer(opts?: {
  shuttingDown?: boolean;
  configuredAccount?: string;
}) {
  process.env.META_AD_ACCOUNT_ID =
    opts?.configuredAccount ?? "act_111111111";
  const store = new FakeApprovalStore();
  const audit = new FakeAuditLog();
  const tokens = makeTokenService();

  const toolRegistry = {
    get: (toolId: string) =>
      toolId.startsWith("meta.")
        ? {
            id: toolId,
            risk: toolId.endsWith("_read") ? "READ_ONLY" : "EXTERNAL_SIDE_EFFECT",
            validate: () => true,
            requiredPermissions: [],
            requiresApproval: true,
          }
        : undefined,
  };

  const container = {
    tokenService: tokens,
    auditLogger: audit.logger,
    approvalRepo: store,
    toolRegistry,
    executionJournal: {
      findLatestByApprovalId: (id: string) => journalLinks.get(id) ?? null,
    },
    lifecycle: { isShuttingDown: () => opts?.shuttingDown ?? false },
  };

  const router = createApprovalsRouter(
    container as unknown as ConstructorParameters<typeof createApprovalsRouter>[0]
  );
  return { router, store, audit, tokens, toolRegistry };
}

type Ctx = ReturnType<typeof makeContainer>;
let ctx: Ctx;
let tokenA: string;
let tokenB: string;

// ---------------------------------------------------------------------------
// request harness: walks the router like express, awaiting the async handler.
// Paths are ROUTER-RELATIVE ("/", "/:id", "/:id/approve"); a leading
// "/approvals" is tolerated for readability.
// ---------------------------------------------------------------------------
interface TestResponse {
  status: number;
  body: any;
}

async function call(
  router: Router,
  method: string,
  path: string,
  token?: string
): Promise<TestResponse> {
  const parsed = new URL(path, "http://test");
  let pathname = parsed.pathname;
  pathname = pathname.replace(/^\/approvals(?=\/|$)/, "") || "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;

  const params: Record<string, string> = {};
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (typeof parsed.searchParams.get("x-trace-id") === "string") {
    headers["x-trace-id"] = parsed.searchParams.get("x-trace-id")!;
  }

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

  const stack = ((router as unknown as {
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
    const methodMatch = layer.route.methods[method.toLowerCase()];
    if (!methodMatch) continue;
    const regex = new RegExp(
      "^" + layer.route.path.replace(/:[^/]+/g, "([^/]+)") + "$"
    );
    const match = pathname.match(regex);
    if (!match) continue;

    // Fill req.params from the captured groups in declaration order.
    const names = [...layer.route.path.matchAll(/:([^/]+)/g)].map((m) => m[1]);
    names.forEach((n, i) => {
      params[n] = decodeURIComponent(match[i + 1]);
    });

    const req = {
      method,
      url: pathname + parsed.search,
      originalUrl: pathname + parsed.search,
      path: pathname,
      params,
      query: Object.fromEntries(parsed.searchParams),
      headers,
      get(h: string) {
        return headers[h];
      },
    };

    let idx = 0;
    const chain = layer.route.stack;
    const responded = () =>
      (res as unknown as { _body: unknown })._body !== null;
    // Sequentially run the route chain. Sync middleware receives a next()
    // that advances the chain once called; the terminal async handler's
    // promise is returned so the caller can await completion. Middleware
    // that terminates the response WITHOUT calling next (e.g. 401 auth
    // failures) must settle immediately and halt further chain advancement.
    const runAt = (i: number): unknown => {
      if (responded()) return undefined;
      const entry = chain[i];
      if (!entry) return undefined;
      if (entry.handle.length >= 3) {
        return new Promise<void>((resolveStep) => {
          entry.handle(req, res, () => resolveStep());
          // Response may have been sent synchronously without next().
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
  return {
    status: 404,
    body: { success: false, error: { code: "NO_ROUTE" } },
  };
}

// ---------------------------------------------------------------------------
// seeding helpers
// ---------------------------------------------------------------------------

let seqCounter = 0;

function seedPending(
  store: FakeApprovalStore,
  overrides?: Partial<Pick<Approval, "userId" | "toolId">> & {
    params?: Record<string, unknown>;
    ttlMs?: number;
  }
): Approval {
  const params =
    overrides?.params ??
    ({
      accountId: "act_111111111",
      name: "Summer Launch",
      objective: "OUTCOME_TRAFFIC",
      dailyBudget: 25,
      currency: "USD",
    } satisfies Record<string, unknown>);
  void ++seqCounter;
  return store.create({
    userId: overrides?.userId ?? "user-a",
    toolId: overrides?.toolId ?? "meta.campaign.create",
    action: "execute",
    params,
    paramsHash: computeParamsHash(params),
    expiresAt: new Date(
      Date.now() + (overrides?.ttlMs ?? APPROVAL_TTL_MS)
    ).toISOString(),
  });
}

beforeEach(() => {
  delete process.env.META_ACCESS_TOKEN;
  journalLinks.clear();
  ctx = makeContainer();
  tokenA = ctx.tokens.generateAccessToken({
    userId: "user-a",
    role: "owner",
    email: "a@test.local",
  });
  tokenB = ctx.tokens.generateAccessToken({
    userId: "user-b",
    role: "member",
    email: "b@test.local",
  });
});

// ---------------------------------------------------------------------------
describe("PHASE 10.7 — authentication required", () => {
  it("29. rejects unauthenticated listing", async () => {
    const r = await call(ctx.router, "GET", "/");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("29. rejects unauthenticated approve", async () => {
    const r = await call(
      ctx.router,
      "POST",
      `/appr00000001abcdef/approve`
    );
    expect(r.status).toBe(401);
  });
});

describe("PHASE 10.7 — listing + isolation", () => {
  it("1. lists own approvals with server-generated summaries", async () => {
    seedPending(ctx.store);
    const r = await call(ctx.router, "GET", "/", tokenA);
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(1);
    expect(r.body.data[0].actionSummary).toContain("Create Meta campaign");
    expect(r.body.pagination.total).toBe(1);
  });

  it("2. cannot list another user's approvals", async () => {
    seedPending(ctx.store, { userId: "user-a" });
    const r = await call(ctx.router, "GET", "/", tokenB);
    expect(r.body.data.length).toBe(0);
  });

  it("26. pagination is server-enforced", async () => {
    for (let i = 0; i < 5; i++) seedPending(ctx.store);
    const p1 = await call(ctx.router, "GET", "/?page=1&limit=2", tokenA);
    const p2 = await call(ctx.router, "GET", "/?page=2&limit=2", tokenA);
    expect(p1.body.data.length).toBe(2);
    expect(p2.body.data.length).toBe(2);
    expect(p1.body.pagination.totalPages).toBe(3);
  });

  it("30. expired approvals appear under expired filter and not pending", async () => {
    seedPending(ctx.store, { ttlMs: -1000 });
    const pending = await call(ctx.router, "GET", "/?status=pending", tokenA);
    const expired = await call(ctx.router, "GET", "/?status=expired", tokenA);
    expect(pending.body.data.length).toBe(0);
    expect(expired.body.data.length).toBe(1);
    expect(expired.body.data[0].status).toBe("expired");
  });
});

describe("PHASE 10.7 — get detail + IDOR", () => {
  it("3. gets own approval with full human-readable context", async () => {
    const a = seedPending(ctx.store);
    journalLinks.set(a.id, { executionId: "exec-9", status: "PENDING" });
    const r = await call(ctx.router, "GET", `/${a.id}`, tokenA);
    expect(r.status).toBe(200);
    expect(r.body.data.approvalId).toBe(a.id);
    expect(r.body.data.actionSummary).toContain("Summer Launch");
    expect(r.body.data.accountRedacted).toMatch(/^act_111••••1111$/);
    expect(r.body.data.budget).toContain("$25.00");
    expect(r.body.data.executionId).toBe("exec-9");
    expect(r.body.data.paramsHash).toBeDefined();
    expect(r.body.data.proposedByAi).toBe(false);
  });

  it("4. IDOR get denied — foreign approval looks like not-found", async () => {
    const a = seedPending(ctx.store, { userId: "user-b" });
    const r = await call(ctx.router, "GET", `/${a.id}`, tokenA);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("APPROVAL_NOT_FOUND");
  });

  it("28. malformed approval id handled deterministically", async () => {
    const r = await call(ctx.router, "GET", "/short!", tokenA);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("APPROVAL_NOT_FOUND");
  });
});

describe("PHASE 10.7 — approve", () => {
  it("5. approves own pending approval", async () => {
    const a = seedPending(ctx.store);
    const r = await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("approved");
  });

  it("6. IDOR approve denied — existence hidden behind not-found", async () => {
    const a = seedPending(ctx.store, { userId: "user-b" });
    const r = await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    // Anti-enumeration: a foreign approval is indistinguishable from a
    // nonexistent one at the API edge; decideApproval's forbidden outcome
    // remains purely as a read/transition race backstop.
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("APPROVAL_NOT_FOUND");
    expect(ctx.store.rows.get(a.id)!.status).toBe("pending");
  });

  it("9. expired approval denied", async () => {
    const a = seedPending(ctx.store, { ttlMs: -1000 });
    const r = await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("APPROVAL_EXPIRED");
  });

  it("10. already consumed denied", async () => {
    const a = seedPending(ctx.store);
    ctx.store.rows.get(a.id)!.status = "consumed";
    const r = await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("APPROVAL_ALREADY_CONSUMED");
  });

  it("20. approve after reject denied", async () => {
    const a = seedPending(ctx.store);
    await call(ctx.router, "POST", `/${a.id}/reject`, tokenA);
    const r = await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("APPROVAL_ALREADY_REJECTED");
  });

  it("12/13/14. concurrent approves — exactly one winner, others conflict", async () => {
    for (const n of [2, 5, 10]) {
      const fresh = makeContainer();
      const tokA = fresh.tokens.generateAccessToken({
        userId: "user-a",
        role: "owner",
        email: "a@t",
      });
      const a = seedPending(fresh.store);
      const results = await Promise.all(
        Array.from({ length: n }, () =>
          call(fresh.router, "POST", `/${a.id}/approve`, tokA)
        )
      );
      const approved = results.filter((r) => r.status === 200).length;
      const conflicts = results.filter(
        (r) => r.body.error?.code === "APPROVAL_CONFLICT"
      ).length;
      expect(approved).toBe(1);
      expect(conflicts).toBe(n - 1);
    }
  });

  it("16. budget guardrail violation denied", async () => {
    const a = seedPending(ctx.store, {
      toolId: "meta.campaign.update_budget",
      params: {
        accountId: "act_111111111",
        campaignId: "cmp_1",
        dailyBudget: 999999,
      },
    });
    const r = await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("APPROVAL_BUDGET_EXCEEDED");
  });

  it("17. account authorization changed denied", async () => {
    const a = seedPending(ctx.store, {
      params: { accountId: "act_999999999", name: "X", dailyBudget: 10 },
    });
    const r = await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("APPROVAL_ACCOUNT_UNAUTHORIZED");
  });

  it("18. approval during draining denied safely WITHOUT consuming", async () => {
    const draining = makeContainer({ shuttingDown: true });
    const tok = draining.tokens.generateAccessToken({
      userId: "user-a",
      role: "owner",
      email: "a@t",
    });
    const a = seedPending(draining.store);
    const r = await call(draining.router, "POST", `/${a.id}/approve`, tok);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("EXECUTION_DRAINING");
    // Not consumed, not lost — still pending durably for post-restart retry.
    expect(draining.store.rows.get(a.id)!.status).toBe("pending");
  });

  it("15. tampered paramsHash integrity failure denied", async () => {
    const a = seedPending(ctx.store);
    ctx.store.rows.get(a.id)!.paramsHash = "deadbeef";
    const r = await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("APPROVAL_PARAMS_MISMATCH");
  });
});

describe("PHASE 10.7 — reject", () => {
  it("7. rejects own pending approval", async () => {
    const a = seedPending(ctx.store);
    const r = await call(ctx.router, "POST", `/${a.id}/reject`, tokenA);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("rejected");
  });

  it("8. IDOR reject denied — existence hidden behind not-found", async () => {
    const a = seedPending(ctx.store, { userId: "user-b" });
    const r = await call(ctx.router, "POST", `/${a.id}/reject`, tokenA);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("APPROVAL_NOT_FOUND");
    expect(ctx.store.rows.get(a.id)!.status).toBe("pending");
  });

  it("19. reject after consume denied retroactively", async () => {
    const a = seedPending(ctx.store);
    ctx.store.rows.get(a.id)!.status = "consumed";
    const r = await call(ctx.router, "POST", `/${a.id}/reject`, tokenA);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("APPROVAL_ALREADY_CONSUMED");
  });

  it("reject is idempotent for already-rejected approvals", async () => {
    const a = seedPending(ctx.store);
    await call(ctx.router, "POST", `/${a.id}/reject`, tokenA);
    const second = await call(ctx.router, "POST", `/${a.id}/reject`, tokenA);
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe("rejected");
  });
});

describe("PHASE 10.7 — audit + secrets", () => {
  it("23. approve attempts audited with ids, hash and duration", async () => {
    const a = seedPending(ctx.store);
    await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    const entries = ctx.audit.entries.filter(
      (e) =>
        e.action === "approval.approve" &&
        !((e.metadata ?? {}) as Record<string, unknown>).rateLimited
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const last = entries.at(-1)!;
    expect(last.parameters).toMatchObject({ approvalId: a.id });
    expect(last.result).toBe("success");
    expect(last.metadata).toHaveProperty("durationMs");
    expect(JSON.stringify(last)).not.toMatch(/token|secret|password/i);
  });

  it("24. responses never contain secrets", async () => {
    process.env.META_ACCESS_TOKEN = "EAASuperSecretTestToken123";
    const a = seedPending(ctx.store);
    const detail = await call(ctx.router, "GET", `/${a.id}`, tokenA);
    const list = await call(ctx.router, "GET", "/", tokenA);
    const blob = JSON.stringify([detail.body, list.body]);
    expect(blob).not.toContain("EAASuperSecretTestToken123");
    expect(blob.toLowerCase()).not.toContain("access_token");
    delete process.env.META_ACCESS_TOKEN;
  });

  it("25. audit records contain no secrets", async () => {
    const a = seedPending(ctx.store);
    await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    const blob = JSON.stringify(ctx.audit.entries);
    expect(blob).not.toMatch(/EAA[A-Za-z0-9]{10,}/);
    expect(blob).not.toContain("DATABASE_URL");
  });
});

describe("PHASE 10.7 — rate limiting (window semantics)", () => {
  it("27. throttles mutation attempts after window limit", async () => {
    const a = seedPending(ctx.store);
    // Pre-fill the shared window with 20 approve attempts.
    for (let i = 0; i < 20; i++) {
      await ctx.audit.logger.log({
        userId: "user-a",
        action: "approval.approve",
        result: "rejected",
        metadata: { seeded: i },
      });
    }
    const r = await call(ctx.router, "POST", `/${a.id}/approve`, tokenA);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("RATE_LIMITED");
    // Throttled attempt itself audited (abuse trail).
    expect(
      ctx.audit.entries.some(
        (e) =>
          e.action === "approval.approve" &&
          (e.metadata as Record<string, unknown>)?.rateLimited
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §18 — Real-write safety: endpoint → ToolExecutor → MOCK provider.
// Proves the full approval chain performs NO real Meta HTTP call.
// ---------------------------------------------------------------------------
describe("PHASE 10.7 — real-write safety (mock provider injection)", () => {
  it("21/22. approval→executor→provider executes EXACTLY once against the mock, zero external fetches", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 599,
      json: async () => ({}),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchSpy);

    try {
      // A tiny in-memory consumption port mirroring Phase 10.3 semantics.
      const consumed = new Set<string>();
      const consumptionPort = {
        async consumeForExecution(input: {
          approvalId: string;
          paramsHash: string;
        }) {
          const row = ctx.store.rows.get(input.approvalId);
          if (
            !row ||
            row.status !== "approved" ||
            row.paramsHash !== input.paramsHash ||
            consumed.has(input.approvalId)
          ) {
            return { ok: false as const, reason: "denied" };
          }
          consumed.add(input.approvalId);
          // Mirror the durable repository: the row itself transitions to
          // CONSUMED so future lookups can never authorize again.
          row.status = "consumed";
          row.resolvedAt = new Date().toISOString();
          return { ok: true as const };
        },
      };

      // Mock Meta write provider — NO network anywhere.
      const providerCalls: unknown[] = [];
      const mockProvider = {
        async createCampaign(_accountId: string, params: unknown) {
          providerCalls.push(params);
          return { id: "cmp_mock_1" };
        },
      };

      const writeLikeTool = {
        id: "meta.campaign.create",
        name: "Create Campaign",
        description: "",
        category: "marketing",
        risk: "EXTERNAL_SIDE_EFFECT",
        parameters: [],
        requiresApproval: true,
        requiredPermissions: [],
        version: "1",
        enabled: true,
        validate: () => true,
        async execute(
          params: Record<string, unknown>,
          context: { approvalId?: string }
        ) {
          // Phase 10.3 protocol: atomic one-time consume before side effect.
          const res = await consumptionPort.consumeForExecution({
            approvalId: context.approvalId!,
            paramsHash: computeParamsHash(params),
          });
          if (!res.ok) throw new Error("approval denied");
          const out = await mockProvider.createCampaign("act_111111111", params);
          return { success: true as const, data: out };
        },
      };

      const { ToolExecutor, ToolRegistry } = await import("@jarvis/tools");
      const registry = new ToolRegistry();
      registry.register(writeLikeTool as never);
      const executor = new ToolExecutor(
        registry,
        { hasPermission: () => true },
        // IApprovalManager backed by the SAME durable store the API uses.
        {
          requestApproval: async (req) =>
            ctx.store.create({
              ...(req as unknown as Omit<
                Approval,
                "id" | "status" | "createdAt"
              >),
              paramsHash: computeParamsHash(req.params),
            }),
          findExistingForTool: async (toolId: string, userId: string) =>
            [...ctx.store.rows.values()].find(
              (r) => r.toolId === toolId && r.userId === userId
            ) ?? null,
        },
        ctx.audit.logger,
        {}
      );

      const params = {
        accountId: "act_111111111",
        name: "Safety Probe",
        objective: "OUTCOME_ENGAGEMENT",
        dailyBudget: 11,
        currency: "USD",
      };

      // Step 1: no valid approval yet → creates a PENDING approval, no execution.
      const first = await executor.execute({
        toolId: writeLikeTool.id,
        params,
        userId: "user-a",
        role: "owner" as const,
        traceId: "trace-safety",
      });
      expect(first.status).toBe("approval_pending");
      const pendingId = first.approvalId!;

      // Step 2: human approves through the PRODUCTION ENDPOINT.
      const approveRes = await call(
        ctx.router,
        "POST",
        `/${pendingId}/approve`,
        tokenA
      );
      expect(approveRes.status).toBe(200);

      // Step 3: re-execution consumes the approval and hits ONLY the mock.
      const second = await executor.execute({
        toolId: writeLikeTool.id,
        params,
        userId: "user-a",
        role: "owner" as const,
        traceId: "trace-safety",
      });
      expect(second.status).toBe("completed");
      expect(providerCalls.length).toBe(1); // exactly one provider call

      // Step 4: replay cannot re-execute (consumption is one-time).
      const third = await executor.execute({
        toolId: writeLikeTool.id,
        params,
        userId: "user-a",
        role: "owner" as const,
        traceId: "trace-safety",
      });
      expect(third.status).toBe("approval_pending"); // needs NEW approval
      expect(providerCalls.length).toBe(1);

      // THE core safety assertion: nothing ever reached a real endpoint.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);
});
