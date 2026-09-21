// ---------------------------------------------------------------------------
// Core V1.1 — the boundary between the user's todos and JARVIS's work.
//
// One Task table, two disjoint surfaces, separated by the `createdBy` column
// that already existed. These tests pin the three properties that make that
// safe:
//
//   1. the todo surfaces never show work     (createdBy excluded)
//   2. the work surface never shows todos    (createdBy selected)
//   3. a todo checkbox cannot MOVE running work, in either direction
//
// The store below is a faithful fake of PrismaTaskRepository: it applies the
// userId filter, the createdBy filters and the RUNNING guard exactly as the
// WHERE clauses do. A fake that skipped any of them would let these tests pass
// while the property they exist to protect was broken.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { JARVIS_TASK_CREATOR, type TaskStatus, type ToolContext } from "@jarvis/core";
import { createTaskTools, createAmbientTools, type TaskPort, type TaskView } from "@jarvis/tools";
import { TaskService } from "../src/services/tasks/task-service.js";
import { createTasksPort } from "../src/services/ambient-adapter.js";
import type { TaskRecord } from "@jarvis/db";

const ALICE = "user-alice";
const BOB = "user-bob";
const CONTEXT: ToolContext = { userId: ALICE, traceId: "00000000-0000-0000-0000-000000000001" };

// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;

  return {
    rows,
    seed(userId: string, over: Partial<TaskRecord> = {}): TaskRecord {
      const now = new Date();
      const row: TaskRecord = {
        id: `task-${++seq}`,
        userId,
        title: "Untitled",
        description: null,
        dueAt: null,
        priority: "NORMAL",
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        error: null,
        remindedAt: null,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
        ...over,
      };
      rows.set(row.id, row);
      return row;
    },
    async create(
      userId: string,
      input: { title: string; description?: string | null; createdBy?: string | null }
    ) {
      return this.seed(userId, {
        title: input.title,
        description: input.description ?? null,
        createdBy: input.createdBy ?? null,
      });
    },
    async list(
      userId: string,
      options: {
        includeCompleted?: boolean;
        limit?: number;
        createdBy?: string;
        excludeCreatedBy?: string;
      } = {}
    ) {
      return [...rows.values()]
        .filter((r) => r.userId === userId)
        .filter((r) => (options.includeCompleted ? true : r.completedAt === null))
        .filter((r) => (options.createdBy === undefined ? true : r.createdBy === options.createdBy))
        .filter((r) =>
          options.excludeCreatedBy === undefined ? true : r.createdBy !== options.excludeCreatedBy
        )
        .slice(0, options.limit ?? 50);
    },
    async listByStatus(
      userId: string,
      status: TaskStatus,
      limit = 50,
      options: { createdBy?: string } = {}
    ) {
      return [...rows.values()]
        .filter((r) => r.userId === userId && r.status === status)
        .filter((r) => (options.createdBy === undefined ? true : r.createdBy === options.createdBy))
        .slice(0, limit);
    },
    async findOwned(userId: string, taskId: string) {
      const row = rows.get(taskId);
      return row && row.userId === userId ? row : null;
    },
    /** Mirrors the real WHERE clause, RUNNING guard included. */
    async updateOwned(
      userId: string,
      taskId: string,
      input: { completed?: boolean; title?: string }
    ): Promise<TaskRecord | null> {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) return null;
      // Keys on PRESENCE, not value: both directions are lifecycle moves
      // the rules forbid while a task is running.
      if (input.completed !== undefined && row.status === "RUNNING") return null;

      if (input.title !== undefined) row.title = input.title;
      if (input.completed !== undefined) {
        row.completedAt = input.completed ? new Date() : null;
        row.status = input.completed ? "COMPLETED" : "PENDING";
        if (!input.completed) row.error = null;
      }
      row.updatedAt = new Date();
      return row;
    },
    async transitionOwned(
      userId: string,
      taskId: string,
      expectedFrom: TaskStatus,
      to: TaskStatus,
      options: { error?: string | null } = {}
    ) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) {
        return { ok: false as const, reason: "not_found" as const, current: null };
      }
      if (row.status !== expectedFrom) {
        return { ok: false as const, reason: "state_changed" as const, current: row.status };
      }
      row.status = to;
      if (to === "RUNNING") row.startedAt = new Date();
      if (to === "COMPLETED") {
        row.completedAt = new Date();
        row.error = null;
      }
      if (to === "FAILED") row.error = options.error ?? null;
      return { ok: true as const, task: row };
    },
  };
}

function harness() {
  const store = makeStore();
  const service = new TaskService({ tasks: store });

  const view = (t: TaskRecord): TaskView => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    startedAt: t.startedAt ? t.startedAt.toISOString() : null,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    error: t.error,
  });

  const port: TaskPort = {
    create: async (userId, input) => {
      const r = await service.createTask(userId, input);
      return r.ok ? { ok: true as const, task: view(r.task) } : { ok: false as const, message: r.message };
    },
    list: async (userId, options) => (await service.listTasks(userId, options)).map(view),
    get: async (userId, id) => {
      const r = await service.getTask(userId, id);
      return r.ok ? { ok: true as const, task: view(r.task) } : { ok: false as const, message: r.message };
    },
    updateStatus: async (userId, id, status, error) => {
      const r =
        status === "RUNNING"
          ? await service.startTask(userId, id)
          : status === "COMPLETED"
            ? await service.completeTask(userId, id)
            : await service.failTask(userId, id, error);
      return r.ok ? { ok: true as const, task: view(r.task) } : { ok: false as const, message: r.message };
    },
  };

  const taskTools = createTaskTools(port);
  // The REAL ambient adapter, so the exclusion under test is the shipped one.
  const ambient = createAmbientTools(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    createTasksPort(store)
  );

  return {
    store,
    service,
    taskList: taskTools.find((t) => t.id === "task.list")!,
    taskCreate: taskTools.find((t) => t.id === "task.create")!,
    todoList: ambient.find((t) => t.id === "tasks.list")!,
  };
}

// ---------------------------------------------------------------------------
// A + B + G + H — the two surfaces read disjoint sets
// ---------------------------------------------------------------------------

describe("Core V1.1 — todos and JARVIS work are separate surfaces", () => {
  it("A. tasks.list excludes JARVIS work, showing only the user's todos", async () => {
    const h = harness();
    h.store.seed(ALICE, { title: "Buy milk", createdBy: null });
    h.store.seed(ALICE, { title: "Prepare proposal", createdBy: JARVIS_TASK_CREATOR });

    const result = await h.todoList.execute({}, CONTEXT);
    expect(result.success).toBe(true);

    const titles = (result.data as { tasks: Array<{ title: string }> }).tasks.map((t) => t.title);
    expect(titles).toEqual(["Buy milk"]);
    expect(titles).not.toContain("Prepare proposal");
  });

  it("B. task.list returns JARVIS work and not the user's todos", async () => {
    const h = harness();
    h.store.seed(ALICE, { title: "Buy milk", createdBy: null });
    h.store.seed(ALICE, { title: "Prepare proposal", createdBy: JARVIS_TASK_CREATOR });

    const result = await h.taskList.execute({}, CONTEXT);
    const titles = (result.data as { tasks: TaskView[] }).tasks.map((t) => t.title);
    expect(titles).toEqual(["Prepare proposal"]);
    expect(titles).not.toContain("Buy milk");
  });

  it("B2. selects by createdBy, not by completedAt — a done todo is still not work", async () => {
    const h = harness();
    // Completed todo: excluded from work because of WHO made it, not its state.
    h.store.seed(ALICE, { title: "Done todo", createdBy: null, completedAt: new Date(), status: "COMPLETED" });

    expect(await h.service.listTasks(ALICE)).toHaveLength(0);
  });

  it("G. a PENDING JARVIS task stays visible through task.list", async () => {
    const h = harness();
    await h.taskCreate.execute({ title: "Prepare the Sputnikverse proposal" }, CONTEXT);

    const all = await h.service.listTasks(ALICE);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("PENDING");
    expect(all[0]!.createdBy).toBe(JARVIS_TASK_CREATOR);

    const filtered = await h.service.listTasks(ALICE, { status: "PENDING" });
    expect(filtered).toHaveLength(1);
  });

  it("H. a COMPLETED JARVIS task remains retrievable through task.list", async () => {
    const h = harness();
    const created = await h.service.createTask(ALICE, {
      title: "Finished work",
      createdBy: JARVIS_TASK_CREATOR,
    });
    if (!created.ok) throw new Error("setup failed");
    await h.service.startTask(ALICE, created.task.id);
    await h.service.completeTask(ALICE, created.task.id);

    // "What did you finish?" has to be answerable.
    const all = await h.service.listTasks(ALICE);
    expect(all.map((t) => t.status)).toEqual(["COMPLETED"]);
    expect(await h.service.listTasks(ALICE, { status: "COMPLETED" })).toHaveLength(1);
  });

  it("C. both surfaces stay user-scoped — a creator filter never widens ownership", async () => {
    const h = harness();
    h.store.seed(BOB, { title: "Bob todo", createdBy: null });
    h.store.seed(BOB, { title: "Bob work", createdBy: JARVIS_TASK_CREATOR });
    h.store.seed(ALICE, { title: "Alice todo", createdBy: null });

    const todos = await h.todoList.execute({}, CONTEXT);
    expect((todos.data as { tasks: Array<{ title: string }> }).tasks.map((t) => t.title)).toEqual([
      "Alice todo",
    ]);

    const work = await h.taskList.execute({}, CONTEXT);
    expect((work.data as { tasks: TaskView[] }).tasks).toHaveLength(0);
    expect(await h.service.listTasks(BOB)).toHaveLength(1);
  });

  it("both Core V1 entry points stamp the marker, so neither leaks into the todo list", async () => {
    const h = harness();
    // The tool path.
    await h.taskCreate.execute({ title: "From the model" }, CONTEXT);
    // The REST path calls the same service with the same stamp.
    await h.service.createTask(ALICE, { title: "From the API", createdBy: JARVIS_TASK_CREATOR });

    expect([...h.store.rows.values()].every((r) => r.createdBy === JARVIS_TASK_CREATOR)).toBe(true);

    const todos = await h.todoList.execute({}, CONTEXT);
    expect((todos.data as { count: number }).count).toBe(0);
    expect(await h.service.listTasks(ALICE)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// D — the descriptions a model actually chooses from
// ---------------------------------------------------------------------------

describe("Core V1.1 — the two tools are distinguishable by description alone", () => {
  it("D. each names its own subject and points at the other for the other question", () => {
    const h = harness();
    const todo = h.todoList.description.toLowerCase();
    const work = h.taskList.description.toLowerCase();

    // `tasks.list` — dated todos and reminders.
    expect(todo).toContain("todos and reminders");
    expect(todo).toContain("what is due");
    // And it hands the other question over explicitly.
    expect(todo).toContain("task.list");

    // `task.list` — work JARVIS was asked to carry out.
    expect(work).toContain("work you asked jarvis to carry out");
    expect(work).toContain("what are you working on");
    expect(work).toContain("tasks.list");

    // The ids themselves are unchanged.
    expect(h.todoList.id).toBe("tasks.list");
    expect(h.taskList.id).toBe("task.list");
  });

  it("neither description claims the other's subject", () => {
    const h = harness();
    expect(h.todoList.description.toLowerCase()).toContain("not the work jarvis");
    expect(h.taskList.description.toLowerCase()).toContain("not the user's to-do list");
  });
});

// ---------------------------------------------------------------------------
// E + F — the checkbox guard
// ---------------------------------------------------------------------------

describe("Core V1.1 — a todo checkbox cannot move running work", () => {
  it("E. refuses to COMPLETE a RUNNING task through the command-center path", async () => {
    const h = harness();
    const created = await h.service.createTask(ALICE, {
      title: "Work in flight",
      createdBy: JARVIS_TASK_CREATOR,
    });
    if (!created.ok) throw new Error("setup failed");
    await h.service.startTask(ALICE, created.task.id);

    // The dashboard checkbox path.
    const patched = await h.store.updateOwned(ALICE, created.task.id, { completed: true });

    // Null is what the route renders as 404 — the same answer as "no such
    // task", so this cannot be used to probe state either.
    expect(patched).toBeNull();

    const row = h.store.rows.get(created.task.id)!;
    expect(row.status).toBe("RUNNING");
    expect(row.completedAt).toBeNull();
  });

  it("E1b. refuses to REOPEN a RUNNING task — RUNNING -> PENDING is a move too", async () => {
    const h = harness();
    const created = await h.service.createTask(ALICE, {
      title: "Work in flight",
      createdBy: JARVIS_TASK_CREATOR,
    });
    if (!created.ok) throw new Error("setup failed");
    await h.service.startTask(ALICE, created.task.id);

    // Unticking the box would reset running work to "not started".
    const patched = await h.store.updateOwned(ALICE, created.task.id, { completed: false });

    expect(patched).toBeNull();
    const row = h.store.rows.get(created.task.id)!;
    expect(row.status).toBe("RUNNING");
    expect(row.startedAt).not.toBeNull();
  });

  it("F. a normal user todo can still be completed, exactly as before", async () => {
    const h = harness();
    const todo = h.store.seed(ALICE, { title: "Buy milk", createdBy: null });

    const patched = await h.store.updateOwned(ALICE, todo.id, { completed: true });

    expect(patched).not.toBeNull();
    expect(patched!.completedAt).not.toBeNull();
    // The two-way sync still holds: status follows the checkbox.
    expect(patched!.status).toBe("COMPLETED");
  });

  it("F2. a PENDING JARVIS task can still be completed by checkbox — only RUNNING is guarded", async () => {
    const h = harness();
    const created = await h.service.createTask(ALICE, {
      title: "Not started",
      createdBy: JARVIS_TASK_CREATOR,
    });
    if (!created.ok) throw new Error("setup failed");

    const patched = await h.store.updateOwned(ALICE, created.task.id, { completed: true });
    expect(patched).not.toBeNull();
    expect(patched!.status).toBe("COMPLETED");
  });

  it("F3. PENDING + completed=false is still allowed — it is not a running task", async () => {
    const h = harness();
    const todo = h.store.seed(ALICE, { title: "Never started", createdBy: null });

    const patched = await h.store.updateOwned(ALICE, todo.id, { completed: false });

    expect(patched).not.toBeNull();
    expect(patched!.status).toBe("PENDING");
    expect(patched!.completedAt).toBeNull();
  });

  it("E2. the guard does not block other edits to a RUNNING task", async () => {
    const h = harness();
    const created = await h.service.createTask(ALICE, {
      title: "Work",
      createdBy: JARVIS_TASK_CREATOR,
    });
    if (!created.ok) throw new Error("setup failed");
    await h.service.startTask(ALICE, created.task.id);

    // Renaming is not a lifecycle move and stays allowed.
    const renamed = await h.store.updateOwned(ALICE, created.task.id, { title: "Renamed" });
    expect(renamed).not.toBeNull();
    expect(renamed!.status).toBe("RUNNING");
  });

  it("E3. the lifecycle path still completes a RUNNING task properly", async () => {
    const h = harness();
    const created = await h.service.createTask(ALICE, {
      title: "Work",
      createdBy: JARVIS_TASK_CREATOR,
    });
    if (!created.ok) throw new Error("setup failed");
    await h.service.startTask(ALICE, created.task.id);

    // The guard blocks the CHECKBOX, not completion itself.
    const done = await h.service.completeTask(ALICE, created.task.id);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.task.status).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// I — nothing else moved
// ---------------------------------------------------------------------------

describe("Core V1.1 — existing surface behaviour is unchanged", () => {
  it("I. tasks.list still honours includeCompleted for real todos", async () => {
    const h = harness();
    h.store.seed(ALICE, { title: "Open todo", createdBy: null });
    h.store.seed(ALICE, {
      title: "Done todo",
      createdBy: null,
      completedAt: new Date(),
      status: "COMPLETED",
    });

    const open = await h.todoList.execute({}, CONTEXT);
    expect((open.data as { count: number }).count).toBe(1);

    const all = await h.todoList.execute({ includeCompleted: true }, CONTEXT);
    expect((all.data as { count: number }).count).toBe(2);
  });

  it("I2. tasks.list still projects dueAt, priority and done", async () => {
    const h = harness();
    const due = new Date("2026-10-01T09:00:00.000Z");
    h.store.seed(ALICE, { title: "Dated todo", createdBy: null, dueAt: due, priority: "HIGH" });

    const result = await h.todoList.execute({}, CONTEXT);
    const row = (result.data as { tasks: Array<Record<string, unknown>> }).tasks[0]!;

    expect(row.dueAt).toBe(due.toISOString());
    expect(row.priority).toBe("HIGH");
    expect(row.done).toBe(false);
    // Still the shape surface-decision reads. No lifecycle field leaked in.
    expect(Object.keys(row).sort()).toEqual(["done", "dueAt", "id", "priority", "title"]);
  });

  it("I3. the command-center CRUD path is otherwise untouched", async () => {
    const h = harness();
    const todo = h.store.seed(ALICE, { title: "Todo", createdBy: null });

    // Reopening still works and still returns the row.
    await h.store.updateOwned(ALICE, todo.id, { completed: true });
    const reopened = await h.store.updateOwned(ALICE, todo.id, { completed: false });
    expect(reopened).not.toBeNull();
    expect(reopened!.completedAt).toBeNull();
    expect(reopened!.status).toBe("PENDING");

    // And another user's task is still invisible.
    expect(await h.store.updateOwned(BOB, todo.id, { completed: true })).toBeNull();
  });
});
