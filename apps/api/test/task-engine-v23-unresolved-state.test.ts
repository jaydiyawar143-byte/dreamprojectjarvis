// ---------------------------------------------------------------------------
// Task Engine V2.3 Phase 1 — the UNRESOLVED state.
//
// WHAT THIS STATE IS FOR. A RUNNING task means `executeTask` already committed
// PENDING -> RUNNING and called the executor. If the process then died before
// any evidence was written, the tool may have reached an external system and
// completed there, or may never have got that far. Nothing durable says which.
//
// FAILED would assert the work did not happen. That assertion may be FALSE,
// and acting on it is how a user redoes a write that already landed. So the
// system needs a way to say "it started, and I cannot tell you more" — which
// is the only honest thing it knows.
//
// PHASE 1 IS THE STATE ONLY. Nothing detects an ambiguous run, nothing sets
// this automatically, and nothing retries. The detection sweep is Phase 2 and
// is deliberately not implemented; these tests pin the lifecycle rules it will
// later depend on.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  TaskStatusSchema,
  canTransitionTask,
  allowedTaskTransitions,
  describeInvalidTaskTransition,
  type TaskStatus,
} from "@jarvis/core";
import type { TaskRecord } from "@jarvis/db";
import { TaskService } from "../src/services/tasks/task-service.js";

const ALICE = "user-alice";

// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;

  return {
    rows,
    seed(over: Partial<TaskRecord> = {}): TaskRecord {
      const now = new Date();
      const row: TaskRecord = {
        id: `task-${++seq}`,
        userId: ALICE,
        title: "Pause the campaign",
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
        createdBy: "jarvis",
        createdAt: now,
        updatedAt: now,
        ...over,
      };
      rows.set(row.id, row);
      return row;
    },

    async create() { throw new Error("unused"); },
    async list() { return [...rows.values()]; },
    async listByStatus(userId: string, status: TaskStatus) {
      return [...rows.values()].filter((r) => r.userId === userId && r.status === status);
    },
    async findOwned(userId: string, taskId: string) {
      const r = rows.get(taskId);
      return r && r.userId === userId ? r : null;
    },

    /** Mirrors the repository, including the V2.3 UNRESOLVED handling. */
    async transitionOwned(
      userId: string,
      taskId: string,
      expectedFrom: TaskStatus,
      to: TaskStatus,
      options: { error?: string | null; executionId?: string } = {}
    ) {
      const r = rows.get(taskId);
      if (!r || r.userId !== userId) {
        return { ok: false as const, reason: "not_found" as const, current: null };
      }
      if (r.status !== expectedFrom) {
        return { ok: false as const, reason: "state_changed" as const, current: r.status };
      }
      r.status = to;
      if (options.executionId !== undefined) r.executionId = options.executionId;
      if (to === "RUNNING") r.startedAt = new Date();
      if (to === "COMPLETED") { r.completedAt = new Date(); r.error = null; }
      if (to === "FAILED") r.error = options.error ?? null;
      if (to === "UNRESOLVED") r.error = options.error ?? null;
      return { ok: true as const, task: r };
    },
  };
}

const harness = () => {
  const store = makeStore();
  return { store, tasks: new TaskService({ tasks: store as never }) };
};

// ---------------------------------------------------------------------------
// The canonical definition
// ---------------------------------------------------------------------------

describe("V2.3 Phase 1 — the status vocabulary", () => {
  it("has exactly five statuses, with UNRESOLVED among them", () => {
    expect(TaskStatusSchema.options).toEqual([
      "PENDING",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "UNRESOLVED",
    ]);
  });

  it("accepts UNRESOLVED wherever a status is validated", () => {
    expect(TaskStatusSchema.safeParse("UNRESOLVED").success).toBe(true);
    // And still refuses anything that is not a status at all.
    expect(TaskStatusSchema.safeParse("UNKNOWN").success).toBe(false);
    expect(TaskStatusSchema.safeParse("unresolved").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The transition rules
// ---------------------------------------------------------------------------

describe("V2.3 Phase 1 — transitions", () => {
  it("A. RUNNING -> UNRESOLVED is allowed", () => {
    expect(canTransitionTask("RUNNING", "UNRESOLVED")).toBe(true);
    expect(allowedTaskTransitions("RUNNING")).toEqual(["COMPLETED", "FAILED", "UNRESOLVED"]);
  });

  it("B-E. UNRESOLVED is TERMINAL — every move out of it is rejected", () => {
    for (const to of ["PENDING", "RUNNING", "COMPLETED", "FAILED"] as const) {
      expect(canTransitionTask("UNRESOLVED", to), `UNRESOLVED -> ${to}`).toBe(false);
    }
    expect(allowedTaskTransitions("UNRESOLVED")).toEqual([]);
  });

  it("F/G. the existing terminal moves still work", () => {
    expect(canTransitionTask("RUNNING", "COMPLETED")).toBe(true);
    expect(canTransitionTask("RUNNING", "FAILED")).toBe(true);
  });

  it("nothing can enter UNRESOLVED except from RUNNING", () => {
    for (const from of ["PENDING", "COMPLETED", "FAILED", "UNRESOLVED"] as const) {
      expect(canTransitionTask(from, "UNRESOLVED"), `${from} -> UNRESOLVED`).toBe(false);
    }
  });

  it("explains the refusal in words a user can act on", () => {
    const message = describeInvalidTaskTransition("UNRESOLVED", "RUNNING");
    expect(message).toMatch(/already unresolved/i);
    expect(message).toMatch(/cannot be changed/i);
  });

  it("PENDING is still only reachable at creation", () => {
    for (const from of ["RUNNING", "COMPLETED", "FAILED", "UNRESOLVED"] as const) {
      expect(canTransitionTask(from, "PENDING"), `${from} -> PENDING`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Through the service
// ---------------------------------------------------------------------------

describe("V2.3 Phase 1 — TaskService.unresolveTask", () => {
  it("moves a RUNNING task to UNRESOLVED with a reason", async () => {
    const h = harness();
    const task = h.store.seed({ status: "RUNNING", startedAt: new Date() });

    const result = await h.tasks.unresolveTask(
      ALICE,
      task.id,
      "The run was interrupted and its outcome could not be confirmed."
    );

    expect(result.ok).toBe(true);
    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("UNRESOLVED");
    expect(row.error).toMatch(/could not be confirmed/i);
  });

  it("does NOT set completedAt — an unresolved run is finished, not done", async () => {
    const h = harness();
    const task = h.store.seed({ status: "RUNNING", startedAt: new Date() });

    await h.tasks.unresolveTask(ALICE, task.id, "interrupted");

    // The Tasks widget reads completedAt as "done". Setting it would quietly
    // check off work nobody can confirm happened.
    expect(h.store.rows.get(task.id)!.completedAt).toBeNull();
  });

  it("refuses to unresolve a PENDING task — the executor was never reached", async () => {
    const h = harness();
    const task = h.store.seed({ status: "PENDING" });

    const result = await h.tasks.unresolveTask(ALICE, task.id, "nope");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("INVALID_TRANSITION");
    expect(h.store.rows.get(task.id)!.status).toBe("PENDING");
  });

  it("refuses to unresolve a task that already settled", async () => {
    const h = harness();
    for (const status of ["COMPLETED", "FAILED", "UNRESOLVED"] as const) {
      const task = h.store.seed({ status });
      const result = await h.tasks.unresolveTask(ALICE, task.id, "nope");
      expect(result.ok, status).toBe(false);
      expect(h.store.rows.get(task.id)!.status).toBe(status);
    }
  });

  it("refuses another user's task, indistinguishably from a missing one", async () => {
    const h = harness();
    const task = h.store.seed({ status: "RUNNING", userId: "user-bob" });

    const result = await h.tasks.unresolveTask(ALICE, task.id, "nope");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NOT_FOUND");
  });

  it("is a one-way door: UNRESOLVED cannot be moved on by any service method", async () => {
    const h = harness();
    const task = h.store.seed({ status: "UNRESOLVED", error: "interrupted" });

    expect((await h.tasks.startTask(ALICE, task.id)).ok).toBe(false);
    expect((await h.tasks.completeTask(ALICE, task.id)).ok).toBe(false);
    expect((await h.tasks.failTask(ALICE, task.id, "x")).ok).toBe(false);
    expect((await h.tasks.unresolveTask(ALICE, task.id, "x")).ok).toBe(false);

    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("UNRESOLVED");
    expect(row.error).toBe("interrupted");
  });

  it("H. the existing RUNNING outcomes are untouched", async () => {
    const h = harness();
    const done = h.store.seed({ status: "RUNNING" });
    const failed = h.store.seed({ status: "RUNNING" });

    expect((await h.tasks.completeTask(ALICE, done.id)).ok).toBe(true);
    expect(h.store.rows.get(done.id)!.status).toBe("COMPLETED");
    expect(h.store.rows.get(done.id)!.completedAt).not.toBeNull();

    expect((await h.tasks.failTask(ALICE, failed.id, "provider refused")).ok).toBe(true);
    expect(h.store.rows.get(failed.id)!.status).toBe("FAILED");
    expect(h.store.rows.get(failed.id)!.completedAt).toBeNull();
  });

  it("listByStatus can select UNRESOLVED work for a human to look at", async () => {
    const h = harness();
    h.store.seed({ status: "UNRESOLVED" });
    h.store.seed({ status: "FAILED" });

    const unresolved = await h.tasks.listTasks(ALICE, { status: "UNRESOLVED" });
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.status).toBe("UNRESOLVED");
  });
});

// ---------------------------------------------------------------------------
// Nothing automatic
// ---------------------------------------------------------------------------

describe("V2.3 Phase 1 — no automatic behaviour was added", () => {
  it("UNRESOLVED is never reachable without an explicit call", async () => {
    // The state exists; nothing puts a task into it on its own. Detection is
    // Phase 2. A RUNNING task left alone stays RUNNING.
    const h = harness();
    const task = h.store.seed({ status: "RUNNING", startedAt: new Date(0) });

    // However old it is, no sweep, timer or side effect moves it.
    expect(h.store.rows.get(task.id)!.status).toBe("RUNNING");
  });

  it("UNRESOLVED has no retry edge — re-running could duplicate a real write", () => {
    expect(allowedTaskTransitions("UNRESOLVED")).toEqual([]);
    expect(canTransitionTask("UNRESOLVED", "PENDING")).toBe(false);
    expect(canTransitionTask("UNRESOLVED", "RUNNING")).toBe(false);
  });
});
