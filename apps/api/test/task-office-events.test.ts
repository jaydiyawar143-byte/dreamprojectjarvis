// ---------------------------------------------------------------------------
// VO-2 — the task service's post-write notification.
//
// The Virtual Office learns about task lifecycle changes from this callback.
// The properties that matter:
//
//   * It fires ONLY after a durable write succeeded, with the written row.
//   * A refused move (invalid transition, not found, lost race) fires nothing.
//   * A callback that throws or rejects cannot turn a successful move into a
//     failed one.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import type { TaskStatus } from "@jarvis/core";
import type { TaskRecord } from "@jarvis/db";

import { TaskService } from "../src/services/tasks/task-service.js";
import { countTaskRows } from "./helpers/count-task-rows.js";

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;

  return {
    async create(
      userId: string,
      input: { title: string; description?: string | null; createdBy?: string | null }
    ): Promise<TaskRecord> {
      const now = new Date();
      const row: TaskRecord = {
        id: `task-${++seq}`,
        userId,
        title: input.title,
        description: input.description ?? null,
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
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
    },
    async list(userId: string, options: { limit?: number } = {}): Promise<TaskRecord[]> {
      return [...rows.values()].filter((r) => r.userId === userId).slice(0, options.limit ?? 50);
    },
    async listByStatus(userId: string, status: TaskStatus, limit = 50): Promise<TaskRecord[]> {
      return [...rows.values()]
        .filter((r) => r.userId === userId && r.status === status)
        .slice(0, limit);
    },
    async countByStatus(userId: string, options: { createdBy?: string } = {}) {
      return countTaskRows(rows.values(), userId, options);
    },
    async findOwned(userId: string, taskId: string): Promise<TaskRecord | null> {
      const row = rows.get(taskId);
      return row && row.userId === userId ? row : null;
    },
    async transitionOwned(
      userId: string,
      taskId: string,
      expectedFrom: TaskStatus,
      to: TaskStatus,
      options: { error?: string | null; executionId?: string } = {}
    ) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) {
        return { ok: false as const, reason: "not_found" as const, current: null };
      }
      if (row.status !== expectedFrom) {
        return { ok: false as const, reason: "state_changed" as const, current: row.status };
      }
      row.status = to;
      if (to === "RUNNING") {
        row.startedAt = new Date();
        if (options.executionId) row.executionId = options.executionId;
      }
      if (to === "COMPLETED") row.completedAt = new Date();
      row.updatedAt = new Date();
      return { ok: true as const, task: row };
    },
  };
}

const ALICE = "user-alice";

function makeService(onTaskChanged?: (task: TaskRecord) => void | Promise<void>) {
  const store = makeStore();
  return {
    store,
    service: new TaskService({
      tasks: store,
      ...(onTaskChanged ? { onTaskChanged } : {}),
    }),
  };
}

describe("VO-2 — task lifecycle notification", () => {
  it("announces a created task once, with the written row", async () => {
    const seen: TaskRecord[] = [];
    const { service } = makeService((task) => {
      seen.push(task);
    });

    const created = await service.createTask(ALICE, { title: "Prepare the proposal" });

    expect(created.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userId: ALICE, status: "PENDING" });
  });

  it("announces a successful move with its execution id", async () => {
    const seen: TaskRecord[] = [];
    const { service } = makeService((task) => {
      seen.push(task);
    });
    const created = await service.createTask(ALICE, { title: "Pause the campaign" });
    if (!created.ok) throw new Error("setup failed");

    const started = await service.startTask(ALICE, created.task.id, { executionId: "exec-1" });

    expect(started.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      id: created.task.id,
      status: "RUNNING",
      executionId: "exec-1",
    });
  });

  it("says nothing when a move is refused", async () => {
    const seen: TaskRecord[] = [];
    const { service } = makeService((task) => {
      seen.push(task);
    });
    const created = await service.createTask(ALICE, { title: "Not started" });
    if (!created.ok) throw new Error("setup failed");

    // PENDING -> COMPLETED is not a legal edge.
    const refused = await service.completeTask(ALICE, created.task.id);
    expect(refused.ok).toBe(false);

    // Only the create was announced.
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe("PENDING");
  });

  it("says nothing when the task does not exist or is not owned", async () => {
    const seen: TaskRecord[] = [];
    const { service } = makeService((task) => {
      seen.push(task);
    });

    await service.startTask(ALICE, "task-missing");

    expect(seen).toHaveLength(0);
  });

  it("does not announce reads", async () => {
    const seen: TaskRecord[] = [];
    const { service } = makeService((task) => {
      seen.push(task);
    });
    const created = await service.createTask(ALICE, { title: "Read only" });
    if (!created.ok) throw new Error("setup failed");
    seen.length = 0;

    await service.getTask(ALICE, created.task.id);
    await service.listTasks(ALICE);

    expect(seen).toHaveLength(0);
  });

  it("cannot fail a successful move by throwing", async () => {
    const { service } = makeService(() => {
      throw new Error("observer failed");
    });

    const created = await service.createTask(ALICE, { title: "Still created" });
    expect(created.ok).toBe(true);
  });

  it("cannot fail a successful move by rejecting", async () => {
    const onTaskChanged = vi.fn(async () => {
      throw new Error("observer rejected");
    });
    const { service } = makeService(onTaskChanged);

    const created = await service.createTask(ALICE, { title: "Still created" });
    expect(created.ok).toBe(true);
    expect(onTaskChanged).toHaveBeenCalledTimes(1);
  });
});
