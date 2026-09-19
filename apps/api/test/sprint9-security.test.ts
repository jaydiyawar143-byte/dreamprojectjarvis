// ---------------------------------------------------------------------------
// Sprint 9.13 — production hardening, as executable checks.
//
// Grouped by the sub-section each property comes from. Nothing here touches a
// real database, a real credential or the network.
//
// The last block is the one that matters most on every future change: Sprint 8
// Voice shares the rate-limiter namespaces, the error envelope and the tool
// result envelope with everything hardened here, and it must come through
// untouched.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JarvisError } from "@jarvis/core";

import {
  asyncHandler,
  errorHandler,
  notFoundHandler,
} from "../src/middleware/error-handler.js";
import { requestId, sanitizeInboundRequestId } from "../src/middleware/request-id.js";
import { IpRateLimiter, IP_RATE_LIMITS, clientKey } from "../src/services/ip-rate-limiter.js";
import {
  RATE_LIMIT_NAMESPACES,
  VOICE_RATE_LIMITS,
  APPROVAL_RATE_LIMITS,
  CHAT_RATE_LIMITS,
  KNOWLEDGE_RATE_LIMITS,
  BROWSER_RATE_LIMITS,
} from "../src/services/rate-limiter.js";
import { createHealthRouter } from "../src/routes/health.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const INDEX_SOURCE = readFileSync(resolve(here, "../src/index.ts"), "utf-8");
const AUTH_SOURCE = readFileSync(resolve(here, "../src/routes/auth.ts"), "utf-8");

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
  };
  return res;
}

const fakeReq = (overrides: Record<string, unknown> = {}) => ({
  method: "GET",
  path: "/api/v1/thing",
  headers: {} as Record<string, unknown>,
  traceId: "trace-1",
  ...overrides,
});

/** Runs a route through a handler the way Express would. */
async function invoke(handler: unknown, req: unknown, res: unknown) {
  const next = vi.fn();
  await (handler as (...args: unknown[]) => unknown)(req, res, next);
  return next;
}

// ---------------------------------------------------------------------------
// 9.2 — a request can no longer kill the process
// ---------------------------------------------------------------------------

describe("Sprint 9.2 — asyncHandler", () => {
  it("routes a rejection into next() instead of leaving it unhandled", async () => {
    const boom = new Error("database unavailable");
    const handler = asyncHandler(async () => {
      throw boom;
    });

    const next = await invoke(handler, fakeReq(), fakeRes());
    expect(next).toHaveBeenCalledWith(boom);
  });

  it("passes a successful handler straight through", async () => {
    const res = fakeRes();
    const handler = asyncHandler(async (_req: never, response) => {
      response.status(200).json({ ok: true });
    });

    const next = await invoke(handler, fakeReq(), res);
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true });
  });

  it("returns a promise, so a caller awaiting it sees the response", async () => {
    // This repo's API tests drive routes by invoking handlers directly. A
    // wrapper that swallowed the promise would leave them awaiting a response
    // that had not been produced.
    const res = fakeRes();
    const handler = asyncHandler(async (_req: never, response) => {
      await new Promise((r) => setTimeout(r, 5));
      response.status(201).json({ done: true });
    });

    await (handler as unknown as (...a: unknown[]) => Promise<void>)(
      fakeReq(),
      res,
      vi.fn()
    );
    expect(res.statusCode).toBe(201);
  });

  it("declares two parameters, because the test harness branches on arity", () => {
    // A three-parameter wrapper is treated as middleware by the harness, which
    // then waits for a next() a responding handler never calls — every wrapped
    // route hangs. This is load-bearing, not cosmetic.
    expect(asyncHandler(async () => undefined).length).toBe(2);
  });

  it("rethrows when there is no next to hand the error to", async () => {
    const handler = asyncHandler(async () => {
      throw new Error("boom");
    });
    await expect(
      (handler as unknown as (...a: unknown[]) => Promise<void>)(fakeReq(), fakeRes())
    ).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// 9.11 — safe production errors
// ---------------------------------------------------------------------------

describe("Sprint 9.11 — the error handler never leaks internals", () => {
  const silent = () => undefined;

  it("NEVER returns a stack trace", async () => {
    const res = fakeRes();
    const error = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    errorHandler({ log: silent })(error, fakeReq() as never, res as never, vi.fn());

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("at ");
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("10.0.0.5");
  });

  it("collapses an unknown throw to INTERNAL_ERROR", () => {
    const res = fakeRes();
    errorHandler({ log: silent })(
      new Error("postgresql://user:hunter2@db/jarvis"),
      fakeReq() as never,
      res as never,
      vi.fn()
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });

  it("trusts a JarvisError to describe itself", () => {
    const res = fakeRes();
    errorHandler({ log: silent })(
      new JarvisError("APPROVAL_EXPIRED", "That approval has expired"),
      fakeReq() as never,
      res as never,
      vi.fn()
    );

    expect(res.statusCode).toBe(408);
    expect(res.body).toMatchObject({
      error: { code: "APPROVAL_EXPIRED", message: "That approval has expired" },
    });
  });

  it("includes the traceId so a report can be tied to a log line", () => {
    const res = fakeRes();
    errorHandler({ log: silent })(
      new Error("x"),
      fakeReq({ traceId: "trace-abc" }) as never,
      res as never,
      vi.fn()
    );
    expect((res.body as { traceId?: string }).traceId).toBe("trace-abc");
  });

  it("logs the detail it refuses to return", () => {
    const lines: Record<string, unknown>[] = [];
    const res = fakeRes();
    errorHandler({ log: (line) => lines.push(line) })(
      new Error("ECONNREFUSED"),
      fakeReq() as never,
      res as never,
      vi.fn()
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toContain("ECONNREFUSED");
    expect(lines[0]!.stack).toBeTruthy();
  });

  it("delegates when the response has already started", () => {
    const res = fakeRes();
    res.headersSent = true;
    const next = vi.fn();
    errorHandler({ log: silent })(new Error("x"), fakeReq() as never, res as never, next);
    expect(next).toHaveBeenCalled();
  });

  it("answers an unknown route in the same envelope", () => {
    const res = fakeRes();
    notFoundHandler()(fakeReq() as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("is mounted last, after every route", () => {
    const errorAt = INDEX_SOURCE.indexOf("app.use(errorHandler())");
    const notFoundAt = INDEX_SOURCE.indexOf("app.use(notFoundHandler())");
    const lastRouteAt = INDEX_SOURCE.lastIndexOf('app.use("/api/v1');

    expect(notFoundAt).toBeGreaterThan(lastRouteAt);
    expect(errorAt).toBeGreaterThan(notFoundAt);
  });
});

// ---------------------------------------------------------------------------
// 9.2 / 9.9 — request correlation
// ---------------------------------------------------------------------------

describe("Sprint 9.9 — request ids", () => {
  it("mints one and echoes it", () => {
    const req = fakeReq();
    const res = fakeRes();
    requestId()(req as never, res as never, vi.fn());

    expect((req as { traceId?: string }).traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers["x-request-id"]).toBe((req as { traceId?: string }).traceId);
  });

  it("reuses a safe inbound id", () => {
    const req = fakeReq({ headers: { "x-request-id": "abc-123" } });
    requestId()(req as never, fakeRes() as never, vi.fn());
    expect((req as { traceId?: string }).traceId).toBe("abc-123");
  });

  it.each([
    ["a newline, which would forge a log line", "abc\ndef"],
    ["a CRLF, which would split a header", "abc\r\nX-Evil: 1"],
    ["an over-long value", "a".repeat(500)],
    ["markup", "<script>alert(1)</script>"],
    ["an empty value", "   "],
  ])("REFUSES %s and mints its own instead", (_label, value) => {
    expect(sanitizeInboundRequestId(value)).toBeNull();

    const req = fakeReq({ headers: { "x-request-id": value } });
    requestId()(req as never, fakeRes() as never, vi.fn());
    expect((req as { traceId?: string }).traceId).not.toBe(value);
  });
});

// ---------------------------------------------------------------------------
// 9.7 — abuse control
// ---------------------------------------------------------------------------

describe("Sprint 9.7 — the pre-auth rate limiter", () => {
  let clock: number;
  let limiter: IpRateLimiter;

  beforeEach(() => {
    clock = 1_000_000;
    limiter = new IpRateLimiter(() => clock);
  });

  const rule = { limit: 3, windowMs: 60_000 };

  it("allows up to the limit and refuses beyond it", () => {
    for (let i = 1; i <= 3; i++) {
      expect(limiter.check("login:1.2.3.4", rule).allowed, `attempt ${i}`).toBe(true);
    }
    expect(limiter.check("login:1.2.3.4", rule).allowed).toBe(false);
  });

  it("counts attempts, not failures, so a valid request cannot reset the budget", () => {
    // A limiter that only counted failures would let an attacker interleave
    // one good request to buy another burst of guesses.
    limiter.check("login:1.2.3.4", rule);
    limiter.check("login:1.2.3.4", rule);
    limiter.check("login:1.2.3.4", rule);
    expect(limiter.check("login:1.2.3.4", rule).allowed).toBe(false);
  });

  it("keeps separate budgets per address", () => {
    for (let i = 0; i < 3; i++) limiter.check("login:1.1.1.1", rule);
    expect(limiter.check("login:1.1.1.1", rule).allowed).toBe(false);
    expect(limiter.check("login:2.2.2.2", rule).allowed).toBe(true);
  });

  it("keeps separate budgets per bucket", () => {
    for (let i = 0; i < 3; i++) limiter.check("login:1.1.1.1", rule);
    expect(limiter.check("register:1.1.1.1", rule).allowed).toBe(true);
  });

  it("recovers after the window passes", () => {
    for (let i = 0; i < 3; i++) limiter.check("login:1.1.1.1", rule);
    expect(limiter.check("login:1.1.1.1", rule).allowed).toBe(false);

    clock += 60_001;
    expect(limiter.check("login:1.1.1.1", rule).allowed).toBe(true);
  });

  it("reports a Retry-After that is never zero", () => {
    for (let i = 0; i < 4; i++) limiter.check("login:1.1.1.1", rule);
    expect(limiter.check("login:1.1.1.1", rule).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("sizes login and register for a person, not a script", () => {
    expect(IP_RATE_LIMITS.login.limit).toBeLessThanOrEqual(10);
    expect(IP_RATE_LIMITS.register.limit).toBeLessThanOrEqual(10);
    expect(IP_RATE_LIMITS.login.windowMs).toBe(60_000);
  });

  it("falls back to a stable key when no address is available", () => {
    expect(clientKey({})).toBe("unknown");
    expect(clientKey({ socket: { remoteAddress: "9.9.9.9" } })).toBe("9.9.9.9");
    expect(clientKey({ ip: "1.1.1.1", socket: { remoteAddress: "9.9.9.9" } })).toBe("1.1.1.1");
  });
});

describe("Sprint 9.7 — auth endpoints are actually gated", () => {
  it.each([["login"], ["register"], ["refresh"]])(
    "throttles /%s before doing any work",
    (bucket) => {
      expect(AUTH_SOURCE).toContain(`throttled(req, res, "${bucket}"`);
    }
  );

  it("returns 429 without saying whether the account exists", () => {
    // A throttle response must not become an account-enumeration oracle.
    expect(AUTH_SOURCE).toContain("Too many attempts. Try again shortly.");
    expect(AUTH_SOURCE).toContain('"Retry-After"');
  });

  it("only trusts a proxy when an operator has said so", () => {
    expect(INDEX_SOURCE).toContain("TRUST_PROXY");
    expect(INDEX_SOURCE).toContain('app.set("trust proxy"');
  });
});

// ---------------------------------------------------------------------------
// 9.10 — health and readiness
// ---------------------------------------------------------------------------

describe("Sprint 9.10 — health probes", () => {
  async function hit(router: unknown, path: string, settleMs = 30) {
    const stack = (router as { stack: Array<{ route?: { path: string; stack: Array<{ handle: (...a: unknown[]) => unknown }> } }> }).stack;
    const layer = stack.find((l) => l.route?.path === path);
    if (!layer?.route) throw new Error(`no route ${path}`);
    const res = fakeRes();
    await layer.route.stack[0]!.handle(fakeReq(), res);
    // The readiness handler resolves asynchronously inside a void IIFE, so the
    // response is written after `handle` returns. Callers that exercise the
    // dependency timeout must wait longer than that timeout.
    await new Promise((r) => setTimeout(r, settleMs));
    return res;
  }

  it("/live never touches a dependency", async () => {
    const pingDatabase = vi.fn(async () => {
      throw new Error("database down");
    });
    const res = await hit(createHealthRouter(undefined, { pingDatabase }), "/live");

    expect(res.statusCode).toBe(200);
    expect(pingDatabase).not.toHaveBeenCalled();
  });

  it("/ready is 200 when the database answers", async () => {
    const res = await hit(
      createHealthRouter(undefined, { pingDatabase: async () => [{ "?column?": 1 }] }),
      "/ready"
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "ready", checks: { database: "ok" } });
  });

  it("/ready is 503 when the database does not", async () => {
    const res = await hit(
      createHealthRouter(undefined, {
        pingDatabase: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
        },
      }),
      "/ready"
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ status: "not_ready", checks: { database: "failed" } });
    // The name of the check, never the driver's error text.
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
  });

  it("/ready is 503 while draining, before any dependency is consulted", async () => {
    const pingDatabase = vi.fn(async () => true);
    const res = await hit(
      createHealthRouter({ getState: () => "DRAINING" }, { pingDatabase }),
      "/ready"
    );

    expect(res.statusCode).toBe(503);
    expect(pingDatabase).not.toHaveBeenCalled();
  });

  it("/ready gives up on a hung database rather than hanging with it", async () => {
    const res = await hit(
      createHealthRouter(undefined, {
        pingDatabase: () => new Promise(() => undefined),
        timeoutMs: 20,
      }),
      "/ready",
      120
    );
    expect(res.statusCode).toBe(503);
  });

  it("leaves the original probe exactly as it was", async () => {
    // shutdown.test.ts pins this contract: 200 with a draining body, not a 503.
    const res = await hit(createHealthRouter({ getState: () => "DRAINING" }), "/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "draining", state: "DRAINING" });
  });

  it("exposes no configuration or secrets", async () => {
    const res = await hit(createHealthRouter(), "/");
    expect(Object.keys(res.body as object).sort()).toEqual([
      "service",
      "status",
      "timestamp",
      "uptime",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Sprint 8 regression — Voice shares all of this infrastructure
// ---------------------------------------------------------------------------

describe("Sprint 8 regression — Voice is unchanged by Sprint 9", () => {
  it("keeps the voice rate limits and their namespace prefix", () => {
    expect(RATE_LIMIT_NAMESPACES.voice).toBe("voice");
    expect(VOICE_RATE_LIMITS).toEqual({
      transcribe: { limit: 30, windowMs: 60_000 },
      speak: { limit: 60, windowMs: 60_000 },
    });
  });

  it("keeps the approval rate limits from Phase 10.7", () => {
    expect(RATE_LIMIT_NAMESPACES.approval).toBe("approval");
    expect(APPROVAL_RATE_LIMITS.approve).toEqual({ limit: 20, windowMs: 60_000 });
    expect(APPROVAL_RATE_LIMITS.reject).toEqual({ limit: 20, windowMs: 60_000 });
    expect(APPROVAL_RATE_LIMITS.list).toEqual({ limit: 120, windowMs: 60_000 });
  });

  it("gives the new namespaces distinct prefixes, so no window bleeds into another", () => {
    const values = Object.values(RATE_LIMIT_NAMESPACES);
    expect(new Set(values).size).toBe(values.length);

    // A prefix that is a prefix of another would double-count: the limiter
    // matches on `${namespace}.${bucket}`.
    for (const a of values) {
      for (const b of values) {
        if (a === b) continue;
        expect(`${a}.`.startsWith(`${b}.`), `${a} vs ${b}`).toBe(false);
      }
    }
  });

  it("adds limits for the expensive paths without touching voice", () => {
    expect(CHAT_RATE_LIMITS.message.limit).toBeGreaterThan(0);
    expect(KNOWLEDGE_RATE_LIMITS.ingest.limit).toBeGreaterThan(0);
    expect(BROWSER_RATE_LIMITS.navigate.limit).toBeGreaterThan(0);
  });

  it("still mounts the voice routes behind their own feature gate", () => {
    expect(INDEX_SOURCE).toContain("isVoiceConfigured()");
    expect(INDEX_SOURCE).toContain('"/api/v1/voice"');
    expect(INDEX_SOURCE).toContain("createVoiceRouter(container");
  });

  it("still authenticates Socket.IO with the same TokenService", () => {
    expect(INDEX_SOURCE).toContain("secureSocketServer(io, container.tokenService)");
  });
});
