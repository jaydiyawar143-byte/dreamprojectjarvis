// ---------------------------------------------------------------------------
// POST /api/v1/tasks/:id/schedule — an offset is REQUIRED, not merely expected.
//
// This route is the unambiguous path: a client states an instant, and no
// interpretation happens anywhere. That only holds if the offset is enforced,
// because `new Date("2026-09-22T23:30:00")` succeeds — and per the ECMAScript
// spec reads the string in the PROCESS's zone, so the same request means a
// different instant on a UTC container than on an IST one, silently.
//
// The route's comment already claimed an offset was expected. These tests are
// what make the claim true.
//
// The scheduler service itself is a recording double here on purpose: what is
// under test is the ROUTE's parsing contract, and the service's own refusals
// (past time, not schedulable) have their own suite in scheduler-v1.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Router, Response } from "express";
import type { ITokenService } from "@jarvis/core";
import { createTasksRouter } from "../src/routes/tasks.js";
import type { Container } from "../src/services/container.js";
import type { TaskSchedulerService } from "../src/services/tasks/task-scheduler-service.js";

const ALICE = "user-alice";
const TOKEN = "token-alice";
const TASK = "task-1";

/** Well past any `now` these tests run at, so only parsing can refuse it. */
const FUTURE_IST = "2099-09-22T23:30:00+05:30";
const FUTURE_Z = "2099-09-22T18:00:00Z";

const tokenService: ITokenService = {
  generateAccessToken: () => TOKEN,
  generateRefreshToken: () => "refresh",
  verifyAccessToken: (token) =>
    token === TOKEN ? { userId: ALICE, role: "owner", email: "alice@test.invalid" } : null,
  hashToken: (t) => t,
  getRefreshTokenExpiry: () => new Date(),
};

function harness() {
  /** Every instant the route actually handed the scheduler. */
  const received: Date[] = [];

  const scheduler = {
    async scheduleTask(_userId: string, _taskId: string, at: Date) {
      received.push(at);
      return {
        ok: true as const,
        task: { id: TASK, userId: ALICE, scheduledAt: at, status: "PENDING" },
      };
    },
  } as unknown as TaskSchedulerService;

  const router = createTasksRouter({ tokenService, taskScheduler: scheduler } as unknown as Container);
  return { router, received };
}

interface TestResponse {
  status: number;
  body: any;
}

/** Drives one route handler chain directly — no server, no socket. */
async function post(router: Router, path: string, body: unknown): Promise<TestResponse> {
  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) { this._status = code; return this; },
    json(payload: unknown) { this._body = payload; return this; },
  };

  const stack = (router as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (...args: any[]) => unknown }>;
      };
    }>;
  }).stack;

  for (const layer of stack) {
    if (!layer.route || !layer.route.methods.post) continue;
    const pattern = "^" + layer.route.path.replace(/:[^/]+/g, "([^/]+)") + "$";
    const match = path.match(new RegExp(pattern));
    if (!match) continue;

    const names = (layer.route.path.match(/:[^/]+/g) ?? []).map((n) => n.slice(1));
    const params: Record<string, string> = {};
    names.forEach((n, i) => { params[n] = match[i + 1]!; });

    const req = {
      method: "POST",
      params,
      query: {},
      body,
      headers: { authorization: `Bearer ${TOKEN}` },
      get(h: string) { return (this.headers as Record<string, string>)[h.toLowerCase()]; },
    };

    const chain = layer.route.stack;
    const responded = () => (res as unknown as { _body: unknown })._body !== null;
    const runAt = async (i: number): Promise<void> => {
      if (responded()) return;
      const entry = chain[i];
      if (!entry) return;
      if (entry.handle.length >= 3) {
        await new Promise<void>((done) => {
          entry.handle(req, res as unknown as Response, () => done());
          if (responded()) done();
        });
        return runAt(i + 1);
      }
      await entry.handle(req, res as unknown as Response);
    };

    await runAt(0);
    return { status: res._status, body: res._body };
  }
  return { status: 404, body: { success: false, error: { code: "NO_ROUTE" } } };
}

const schedule = (h: ReturnType<typeof harness>, scheduledAt: unknown) =>
  post(h.router, `/${TASK}/schedule`, { scheduledAt });

// ---------------------------------------------------------------------------

describe("POST /tasks/:id/schedule — offset accepted", () => {
  it("accepts an explicit +05:30 offset and passes that exact instant through", async () => {
    const h = harness();
    const res = await schedule(h, FUTURE_IST);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(h.received).toHaveLength(1);
    // 23:30+05:30 is 18:00Z. The offset is authoritative; nothing shifts it.
    expect(h.received[0]!.toISOString()).toBe("2099-09-22T18:00:00.000Z");
  });

  it("accepts Z", async () => {
    const h = harness();
    const res = await schedule(h, FUTURE_Z);

    expect(res.status).toBe(200);
    expect(h.received[0]!.toISOString()).toBe("2099-09-22T18:00:00.000Z");
  });

  it("treats +05:30 and its Z equivalent as the same instant", async () => {
    const a = harness();
    const b = harness();
    await schedule(a, FUTURE_IST);
    await schedule(b, FUTURE_Z);

    expect(a.received[0]!.getTime()).toBe(b.received[0]!.getTime());
  });

  it("accepts seconds and milliseconds with an offset", async () => {
    const h = harness();
    expect((await schedule(h, "2099-09-22T23:30:15.250+05:30")).status).toBe(200);
    expect(h.received[0]!.toISOString()).toBe("2099-09-22T18:00:15.250Z");
  });
});

describe("POST /tasks/:id/schedule — offset required", () => {
  it("REJECTS an offset-less date-time, and schedules nothing", async () => {
    const h = harness();
    const res = await schedule(h, "2099-09-22T23:30:00");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    expect(res.body.error.message).toMatch(/explicit offset/i);
    // The refusal is the whole point: nothing reached the scheduler.
    expect(h.received).toHaveLength(0);
  });

  it("rejects a date with no time at all", async () => {
    const h = harness();
    const res = await schedule(h, "2099-09-22");

    expect(res.status).toBe(400);
    expect(h.received).toHaveLength(0);
  });

  it("rejects an offset without a colon, which Date parses inconsistently", async () => {
    const h = harness();
    expect((await schedule(h, "2099-09-22T23:30:00+0530")).status).toBe(400);
    expect(h.received).toHaveLength(0);
  });

  it("rejects a string that is not a timestamp", async () => {
    const h = harness();
    const res = await schedule(h, "tomorrow at 10am");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    expect(h.received).toHaveLength(0);
  });

  it("rejects a well-formed string that is not a parsable timestamp", async () => {
    const h = harness();
    // Month 13 — matches the shape, and `Date` genuinely refuses it.
    const res = await schedule(h, "2099-13-01T23:30:00+05:30");

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not a valid ISO-8601/i);
    expect(h.received).toHaveLength(0);
  });

  it("KNOWN GAP: an impossible day-of-month rolls over instead of refusing", async () => {
    const h = harness();
    // 30 February is well-formed and non-existent, and V8 silently rolls it
    // to 2 March rather than returning NaN. So this is ACCEPTED, and the
    // schedule lands on a day the client did not name.
    //
    // Pinned as a test rather than left undiscovered: it is a silent
    // reinterpretation, which is the same family as the offset bug this suite
    // exists for — but it is out of the scope this change was given, so the
    // behaviour is documented here instead of being quietly altered. Closing
    // it means validating the calendar fields after parsing.
    const res = await schedule(h, "2099-02-30T23:30:00+05:30");

    expect(res.status).toBe(200);
    expect(h.received[0]!.toISOString()).toBe("2099-03-02T18:00:00.000Z");
  });

  it("rejects a missing or non-string scheduledAt", async () => {
    const h = harness();
    expect((await post(h.router, `/${TASK}/schedule`, {})).status).toBe(400);
    expect((await schedule(h, 1790097300000)).status).toBe(400);
    expect((await schedule(h, "   ")).status).toBe(400);
    expect(h.received).toHaveLength(0);
  });
});

describe("POST /tasks/:id/schedule — a past instant is still refused", () => {
  it("passes a well-formed past time to the service, which refuses it", async () => {
    // Parsing and policy are different jobs. The route's job is to hand over
    // an unambiguous instant; refusing the past belongs to the scheduler, and
    // this proves the route does not swallow that refusal.
    const received: Date[] = [];
    const scheduler = {
      async scheduleTask(_u: string, _t: string, at: Date) {
        received.push(at);
        return {
          ok: false as const,
          refusal: "INVALID_TIME" as const,
          message: "A task can only be scheduled for a time in the future.",
        };
      },
    } as unknown as TaskSchedulerService;

    const router = createTasksRouter({ tokenService, taskScheduler: scheduler } as unknown as Container);
    const res = await post(router, `/${TASK}/schedule`, { scheduledAt: "2020-01-01T10:00:00+05:30" });

    expect(received).toHaveLength(1);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/future/i);
  });
});
