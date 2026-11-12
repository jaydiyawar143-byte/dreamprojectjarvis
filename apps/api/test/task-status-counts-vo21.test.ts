// ---------------------------------------------------------------------------
// VO-2.1 (M2) — GET /api/v1/tasks reports every state's TOTAL.
//
// The Virtual Office counted RUNNING and PENDING rows in the list this route
// returns. The list is capped (50 by default), so past the cap the office
// undercounted — or said "No work queued" with work queued. The route now
// carries `statusCounts`, counted in the database through
// `TaskService.countTasks`, beside the capped list.
//
// The repository's GROUP BY is pinned against real PostgreSQL in
// `packages/db/test/task-status-counts-vo21-pg.integration.test.ts`. What is
// under test here is the service and the route contract:
//
//   - the service counts the caller's JARVIS work only;
//   - the totals are not bounded by the list's cap;
//   - a `status` filter narrows the list and never the totals;
//   - a refused request counts nothing.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Router, Response } from "express";
import { JARVIS_TASK_CREATOR, type ITokenService, type TaskStatus } from "@jarvis/core";
import type { TaskRecord } from "@jarvis/db";

import { createTasksRouter } from "../src/routes/tasks.js";
import type { Container } from "../src/services/container.js";
import { TaskService } from "../src/services/tasks/task-service.js";
import { countTaskRows } from "./helpers/count-task-rows.js";

const ALICE = "user-alice";
const BOB = "user-bob";
const TOKEN = "token-alice";

const tokenService: ITokenService = {
  generateAccessToken: () => TOKEN,
  generateRefreshToken: () => "refresh",
  verifyAccessToken: (token) =>
    token === TOKEN ? { userId: ALICE, role: "owner", email: "alice@test.invalid" } : null,
  hashToken: (t) => t,
  getRefreshTokenExpiry: () => new Date(),
};

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  const countCalls: Array<{ userId: string; options: { createdBy?: string } }> = [];
  let seq = 0;

  function seed(userId: string, status: TaskStatus, howMany: number, createdBy: string | null): void {
    for (let i = 0; i < howMany; i += 1) {
      const now = new Date(Date.UTC(2026, 10, 12, 9, 0, 0) + seq * 1000);
      const row: TaskRecord = {
        id: `task-${++seq}`,
        userId,
        title: `${status} ${i}`,
        description: null,
        dueAt: null,
        priority: "NORMAL",
        status,
        startedAt: status === "RUNNING" ? now : null,
        completedAt: status === "COMPLETED" ? now : null,
        error: null,
        scheduledAt: null,
        claimedAt: null,
        executionId: null,
        remindedAt: null,
        createdBy,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
    }
  }

  const work = (userId: string, createdBy?: string) =>
    [...rows.values()].filter(
      (r) => r.userId === userId && (createdBy === undefined || r.createdBy === createdBy)
    );

  const store = {
    async create(): Promise<TaskRecord> {
      throw new Error("not used");
    },
    // The real repository's caps: `list` takes at most `limit` (default 50).
    async list(userId: string, options: { limit?: number; createdBy?: string } = {}) {
      return work(userId, options.createdBy).slice(0, options.limit ?? 50);
    },
    async listByStatus(
      userId: string,
      status: TaskStatus,
      limit = 50,
      options: { createdBy?: string } = {}
    ) {
      return work(userId, options.createdBy)
        .filter((r) => r.status === status)
        .slice(0, limit);
    },
    async countByStatus(userId: string, options: { createdBy?: string } = {}) {
      countCalls.push({ userId, options });
      return countTaskRows(rows.values(), userId, options);
    },
    async findOwned() {
      return null;
    },
    async transitionOwned() {
      return { ok: false as const, reason: "not_found" as const, current: null };
    },
  };

  return { store, seed, countCalls };
}

function harness() {
  const { store, seed, countCalls } = makeStore();
  const taskService = new TaskService({ tasks: store });
  const router = createTasksRouter({ tokenService, taskService } as unknown as Container);
  return { router, seed, countCalls, taskService };
}

interface TestResponse {
  status: number;
  body: any;
}

/** Drives the GET / handler chain directly — no server, no socket. */
async function getTasks(
  router: Router,
  query: Record<string, string> = {},
  /** `null` sends no Authorization header (an explicit `undefined` would take the default). */
  authorization: string | null = `Bearer ${TOKEN}`
): Promise<TestResponse> {
  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(payload: unknown) {
      this._body = payload;
      return this;
    },
  };

  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (...args: any[]) => unknown }>;
      };
    }>;
  }).stack.find((l) => l.route?.path === "/" && l.route.methods.get);
  if (!layer?.route) throw new Error("GET / is not registered");

  const req = {
    method: "GET",
    params: {},
    query,
    body: {},
    headers: authorization ? { authorization } : {},
  };

  const responded = () => res._body !== null;
  for (const entry of layer.route.stack) {
    if (responded()) break;
    if (entry.handle.length >= 3) {
      let advanced = false;
      entry.handle(req, res as unknown as Response, () => {
        advanced = true;
      });
      if (!advanced) break;
      continue;
    }
    await entry.handle(req, res as unknown as Response);
  }
  return { status: res._status, body: res._body };
}

// ---------------------------------------------------------------------------

describe("VO-2.1 — TaskService.countTasks", () => {
  it("counts the caller's JARVIS work, and asks the repository for exactly that", async () => {
    const h = harness();
    h.seed(ALICE, "RUNNING", 3, JARVIS_TASK_CREATOR);
    h.seed(ALICE, "PENDING", 2, null);

    const counts = await h.taskService.countTasks(ALICE);

    expect(h.countCalls).toEqual([{ userId: ALICE, options: { createdBy: JARVIS_TASK_CREATOR } }]);
    expect(counts).toEqual({ PENDING: 0, RUNNING: 3, COMPLETED: 0, FAILED: 0, UNRESOLVED: 0 });
  });
});

describe("VO-2.1 — GET /api/v1/tasks statusCounts", () => {
  it("reports every state's total beside a list the cap has cut short", async () => {
    const h = harness();
    h.seed(ALICE, "RUNNING", 60, JARVIS_TASK_CREATOR);
    h.seed(ALICE, "PENDING", 3, JARVIS_TASK_CREATOR);
    h.seed(ALICE, "PENDING", 4, null); // dashboard todos are not work
    h.seed(BOB, "RUNNING", 9, JARVIS_TASK_CREATOR); // nor are Bob's rows Alice's

    const res = await getTasks(h.router);

    expect(res.status).toBe(200);
    expect(res.body.data.tasks).toHaveLength(50);
    // `count` still means "rows in this response", which the cap bounds.
    expect(res.body.data.count).toBe(50);
    expect(res.body.data.statusCounts).toEqual({
      PENDING: 3,
      RUNNING: 60,
      COMPLETED: 0,
      FAILED: 0,
      UNRESOLVED: 0,
    });
  });

  it("narrows the list with a status filter, never the totals", async () => {
    const h = harness();
    h.seed(ALICE, "RUNNING", 5, JARVIS_TASK_CREATOR);
    h.seed(ALICE, "PENDING", 2, JARVIS_TASK_CREATOR);

    const res = await getTasks(h.router, { status: "pending" });

    expect(res.status).toBe(200);
    expect(res.body.data.tasks).toHaveLength(2);
    expect(res.body.data.statusCounts).toEqual({
      PENDING: 2,
      RUNNING: 5,
      COMPLETED: 0,
      FAILED: 0,
      UNRESOLVED: 0,
    });
  });

  it("refuses an unknown status before anything is counted", async () => {
    const h = harness();

    const res = await getTasks(h.router, { status: "urgent" });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeUndefined();
    expect(h.countCalls).toHaveLength(0);
  });

  it("refuses an unauthenticated request before anything is counted", async () => {
    const h = harness();

    const res = await getTasks(h.router, {}, null);

    expect(res.status).toBe(401);
    expect(h.countCalls).toHaveLength(0);
  });
});
