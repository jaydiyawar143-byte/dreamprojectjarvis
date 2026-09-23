// ---------------------------------------------------------------------------
// Command Center tasks — VISIBLE to read, PROTECTED from write.
//
// The two halves of the Core V1.1 boundary, which an earlier version conflated.
// Excluding JARVIS work tasks from the LIST as well as from PATCH and DELETE
// protected them by making them invisible: a task JARVIS had scheduled or run
// did not exist as far as the dashboard was concerned. Hiding work from its
// owner is not a safety property.
//
// So the property under test is now two-sided, and both sides matter:
//
//   READ   a work task APPEARS in the list, with status and scheduledAt
//   WRITE  the same task cannot be renamed, completed, reopened or deleted
//          here — 404, the same answer another user's task gets
//
// The store fake mirrors the repository's WHERE clauses, including the
// null-safe creator filter: `created_by IS NULL` is the normal case for a todo
// (the create route never sets it), and a guard that drops those rows would
// empty the todo list instead of protecting anything.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Router, Response } from "express";
import type { ITokenService } from "@jarvis/core";
import { JARVIS_TASK_CREATOR } from "@jarvis/core";
import type { TaskRecord } from "@jarvis/db";
import { createCommandCenterRouter } from "../src/routes/command-center.js";
import type { Container } from "../src/services/container.js";

const ALICE = "user-alice";
const TOKEN = "token-alice";

const tokenService: ITokenService = {
  generateAccessToken: () => TOKEN,
  generateRefreshToken: () => "refresh",
  verifyAccessToken: (token) =>
    token === TOKEN ? { userId: ALICE, role: "owner", email: "alice@test.invalid" } : null,
  hashToken: (t) => t,
  getRefreshTokenExpiry: () => new Date(),
};

// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;

  const creatorAllows = (row: TaskRecord, exclude?: string): boolean =>
    exclude === undefined || row.createdBy === null || row.createdBy !== exclude;

  return {
    rows,
    seed(over: Partial<TaskRecord> = {}): TaskRecord {
      const now = new Date();
      const row: TaskRecord = {
        id: `task-${++seq}`,
        userId: ALICE,
        title: "Untitled",
        description: null,
        dueAt: null,
        priority: "NORMAL",
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        error: null,
        remindedAt: null,
        scheduledAt: null,
        claimedAt: null,
        executionId: null,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
        ...over,
      };
      rows.set(row.id, row);
      return row;
    },

    async list(
      userId: string,
      options: { includeCompleted?: boolean; excludeCreatedBy?: string } = {}
    ) {
      return [...rows.values()]
        .filter((r) => r.userId === userId)
        .filter((r) => (options.includeCompleted ? true : r.completedAt === null))
        .filter((r) => creatorAllows(r, options.excludeCreatedBy));
    },

    async updateOwned(
      userId: string,
      taskId: string,
      input: { title?: string; completed?: boolean },
      options: { excludeCreatedBy?: string } = {}
    ) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) return null;
      if (!creatorAllows(row, options.excludeCreatedBy)) return null;
      if (input.completed !== undefined && row.status === "RUNNING") return null;
      if (input.title !== undefined) row.title = input.title;
      if (input.completed !== undefined) {
        row.completedAt = input.completed ? new Date() : null;
        row.status = input.completed ? "COMPLETED" : "PENDING";
      }
      return row;
    },

    async deleteOwned(userId: string, taskId: string, options: { excludeCreatedBy?: string } = {}) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) return false;
      if (!creatorAllows(row, options.excludeCreatedBy)) return false;
      rows.delete(taskId);
      return true;
    },
  };
}

function harness() {
  const store = makeStore();
  const router = createCommandCenterRouter(
    { tokenService, auditLogger: undefined } as unknown as Container,
    { tasks: store, preferences: {} } as never
  );
  return { store, router };
}

interface TestResponse {
  status: number;
  body: any;
}

/** Drives one route handler chain directly — no server, no socket. */
async function call(
  router: Router,
  method: "get" | "patch" | "delete",
  path: string,
  body?: unknown
): Promise<TestResponse> {
  const url = new URL(path, "http://test");
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
    if (!layer.route || !layer.route.methods[method]) continue;
    const pattern = "^" + layer.route.path.replace(/:[^/]+/g, "([^/]+)") + "$";
    const match = url.pathname.match(new RegExp(pattern));
    if (!match) continue;

    const names = (layer.route.path.match(/:[^/]+/g) ?? []).map((n) => n.slice(1));
    const params: Record<string, string> = {};
    names.forEach((n, i) => { params[n] = match[i + 1]!; });

    const req = {
      method: method.toUpperCase(),
      params,
      query: Object.fromEntries(url.searchParams),
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

const titles = (res: TestResponse): string[] =>
  (res.body.data.tasks as Array<{ title: string }>).map((t) => t.title).sort();

// ---------------------------------------------------------------------------
// READ — work is visible
// ---------------------------------------------------------------------------

describe("GET /command-center/tasks — JARVIS work is visible", () => {
  it("returns a JARVIS work task alongside an ordinary todo", async () => {
    const h = harness();
    h.store.seed({ title: "Buy milk" });
    h.store.seed({ title: "Check my system status", createdBy: JARVIS_TASK_CREATOR });

    const res = await call(h.router, "get", "/tasks");

    expect(res.status).toBe(200);
    expect(titles(res)).toEqual(["Buy milk", "Check my system status"]);
  });

  it("carries status, createdBy and scheduledAt so the client can render them", async () => {
    const h = harness();
    const at = new Date("2026-09-23T04:30:00.000Z");
    h.store.seed({
      title: "Scheduled work",
      createdBy: JARVIS_TASK_CREATOR,
      status: "PENDING",
      scheduledAt: at,
    });

    const res = await call(h.router, "get", "/tasks");
    const task = res.body.data.tasks[0];

    expect(task.createdBy).toBe(JARVIS_TASK_CREATOR);
    expect(task.status).toBe("PENDING");
    expect(new Date(task.scheduledAt).toISOString()).toBe(at.toISOString());
  });

  it("shows every lifecycle state a work task can be in", async () => {
    const h = harness();
    for (const status of ["PENDING", "RUNNING", "FAILED"] as const) {
      h.store.seed({ title: status, createdBy: JARVIS_TASK_CREATOR, status });
    }
    h.store.seed({
      title: "COMPLETED",
      createdBy: JARVIS_TASK_CREATOR,
      status: "COMPLETED",
      completedAt: new Date(),
    });

    const open = await call(h.router, "get", "/tasks");
    expect(titles(open)).toEqual(["FAILED", "PENDING", "RUNNING"]);

    // A finished run is the thing worth seeing, and the client asks for it.
    const all = await call(h.router, "get", "/tasks?includeCompleted=true");
    expect(titles(all)).toEqual(["COMPLETED", "FAILED", "PENDING", "RUNNING"]);
  });

  it("still scopes to the caller — visibility widened, ownership did not", async () => {
    const h = harness();
    h.store.seed({ title: "Mine", createdBy: JARVIS_TASK_CREATOR });
    h.store.seed({ title: "Theirs", userId: "user-bob", createdBy: JARVIS_TASK_CREATOR });

    expect(titles(await call(h.router, "get", "/tasks"))).toEqual(["Mine"]);
  });

  it("refuses an unauthenticated read", async () => {
    const h = harness();
    h.store.seed({ title: "Mine" });

    const stack = (h.router as unknown as { stack: any[] }).stack;
    const layer = stack.find((l) => l.route?.path === "/tasks" && l.route.methods.get);
    const res = { _status: 200, _body: null as unknown,
      status(c: number) { this._status = c; return this; },
      json(b: unknown) { this._body = b; return this; } };
    await new Promise<void>((done) => {
      layer.route.stack[0].handle(
        { headers: {}, get: () => undefined },
        res as unknown as Response,
        () => done()
      );
      done();
    });
    expect(res._status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// WRITE — work is protected
// ---------------------------------------------------------------------------

describe("Command Center mutations — JARVIS work is read-only here", () => {
  it("cannot RENAME a JARVIS work task", async () => {
    const h = harness();
    const work = h.store.seed({ title: "Check my system status", createdBy: JARVIS_TASK_CREATOR });

    const res = await call(h.router, "patch", `/tasks/${work.id}`, { title: "HIJACKED" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    // The title the scheduler re-plans from at run time is untouched.
    expect(h.store.rows.get(work.id)!.title).toBe("Check my system status");
  });

  it("cannot manually COMPLETE a JARVIS work task", async () => {
    const h = harness();
    const work = h.store.seed({ title: "Work", createdBy: JARVIS_TASK_CREATOR });

    const res = await call(h.router, "patch", `/tasks/${work.id}`, { completed: true });

    expect(res.status).toBe(404);
    expect(h.store.rows.get(work.id)!.status).toBe("PENDING");
    expect(h.store.rows.get(work.id)!.completedAt).toBeNull();
  });

  it("cannot REOPEN a completed JARVIS work task", async () => {
    const h = harness();
    const work = h.store.seed({
      title: "Work",
      createdBy: JARVIS_TASK_CREATOR,
      status: "COMPLETED",
      completedAt: new Date(),
    });

    const res = await call(h.router, "patch", `/tasks/${work.id}`, { completed: false });

    expect(res.status).toBe(404);
    expect(h.store.rows.get(work.id)!.status).toBe("COMPLETED");
  });

  it("cannot DELETE a JARVIS work task", async () => {
    const h = harness();
    const work = h.store.seed({ title: "Work", createdBy: JARVIS_TASK_CREATOR });

    const res = await call(h.router, "delete", `/tasks/${work.id}`);

    expect(res.status).toBe(404);
    expect(h.store.rows.has(work.id)).toBe(true);
  });

  it("gives the SAME answer for work and for a task that does not exist", async () => {
    const h = harness();
    const work = h.store.seed({ title: "Work", createdBy: JARVIS_TASK_CREATOR });

    const onWork = await call(h.router, "delete", `/tasks/${work.id}`);
    const onGhost = await call(h.router, "delete", "/tasks/task-does-not-exist");

    // Indistinguishable on purpose: this cannot be used to find out which ids
    // are work tasks.
    expect(onWork.status).toBe(onGhost.status);
    expect(onWork.body.error.code).toBe(onGhost.body.error.code);
  });
});

// ---------------------------------------------------------------------------
// Ordinary todos are untouched
// ---------------------------------------------------------------------------

describe("Command Center mutations — ordinary todos still work", () => {
  it("renames a todo", async () => {
    const h = harness();
    const todo = h.store.seed({ title: "Buy milk" });

    const res = await call(h.router, "patch", `/tasks/${todo.id}`, { title: "Buy oat milk" });

    expect(res.status).toBe(200);
    expect(h.store.rows.get(todo.id)!.title).toBe("Buy oat milk");
  });

  it("completes and reopens a todo", async () => {
    const h = harness();
    const todo = h.store.seed({ title: "Buy milk" });

    expect((await call(h.router, "patch", `/tasks/${todo.id}`, { completed: true })).status).toBe(200);
    expect(h.store.rows.get(todo.id)!.completedAt).not.toBeNull();

    expect((await call(h.router, "patch", `/tasks/${todo.id}`, { completed: false })).status).toBe(200);
    expect(h.store.rows.get(todo.id)!.completedAt).toBeNull();
  });

  it("deletes a todo", async () => {
    const h = harness();
    const todo = h.store.seed({ title: "Buy milk" });

    expect((await call(h.router, "delete", `/tasks/${todo.id}`)).status).toBe(200);
    expect(h.store.rows.has(todo.id)).toBe(false);
  });

  it("deletes a task another agent created — only JARVIS work is protected", async () => {
    const h = harness();
    const other = h.store.seed({ title: "From n8n", createdBy: "n8n" });

    expect((await call(h.router, "delete", `/tasks/${other.id}`)).status).toBe(200);
    expect(h.store.rows.has(other.id)).toBe(false);
  });
});
