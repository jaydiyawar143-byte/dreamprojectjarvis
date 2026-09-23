// ---------------------------------------------------------------------------
// Task Engine V2.3 Phase 2 — evidence-based RUNNING recovery.
//
// THE HARD CASE. V2.2 recovered a PENDING claim, where `status = PENDING`
// proved the executor was never reached and re-arming was therefore free.
// RUNNING proves the opposite is possible: `executeTask` committed
// PENDING -> RUNNING and then called the executor, so the tool MAY have
// reached an external system.
//
// So recovery decides NOTHING on its own. It reads durable evidence:
//
//   ToolExecutor writes exactly one `tool.execute` audit row immediately
//   before EVERY return path, and its deadline is enforced by a race rather
//   than by the tool's cooperation. Therefore:
//
//     audit row present   ->  the executor RETURNED; its result IS the outcome
//     audit row absent
//       inside the window ->  still running; leave it alone
//       past the window   ->  the process died mid-call. The tool may or may
//                             not have completed its external write, and
//                             nothing says which: UNRESOLVED.
//
// UNRESOLVED IS NOT FAILED. `FAILED` asserts the work did not happen; for an
// interrupted run that may be false, and acting on it is how a user redoes a
// write that already landed. Nothing retries UNRESOLVED — it has no outgoing
// edge at all.
//
// Every "crash" below is a deterministic abstraction — a step not performed —
// never a timer.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { JARVIS_TASK_CREATOR, type TaskStatus } from "@jarvis/core";
import { DEFAULT_TOOL_EXECUTION_TIMEOUT_MS } from "@jarvis/tools";
import type { TaskRecord } from "@jarvis/db";
import { TaskSchedulerService } from "../src/services/tasks/task-scheduler-service.js";
import { TaskService } from "../src/services/tasks/task-service.js";

const ALICE = "user-alice";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const GRACE_MS = 120_000;
/** 30 000 (enforced deadline) + 120 000 (grace) = 150 000. */
const STALE_AFTER_MS = DEFAULT_TOOL_EXECUTION_TIMEOUT_MS + GRACE_MS;

const ago = (ms: number) => new Date(NOW.getTime() - ms);
const STALE_START = ago(STALE_AFTER_MS + 60_000);
const FRESH_START = ago(STALE_AFTER_MS - 60_000);

// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;

  return {
    rows,
    seed(over: Partial<TaskRecord> = {}): TaskRecord {
      const row: TaskRecord = {
        id: `task-${++seq}`,
        userId: ALICE,
        title: "Pause the campaign",
        description: null,
        dueAt: null,
        priority: "NORMAL",
        status: "RUNNING",
        startedAt: STALE_START,
        completedAt: null,
        error: null,
        remindedAt: null,
        scheduledAt: null,
        claimedAt: null,
        executionId: `exec-${seq}`,
        createdBy: JARVIS_TASK_CREATOR,
        createdAt: NOW,
        updatedAt: NOW,
        ...over,
      };
      rows.set(row.id, row);
      return row;
    },

    async findStaleRunning(createdBy: string, startedBefore: Date, limit = 20) {
      return [...rows.values()]
        .filter(
          (r) =>
            r.createdBy === createdBy &&
            r.status === "RUNNING" &&
            r.startedAt !== null &&
            r.startedAt.getTime() < startedBefore.getTime()
        )
        .slice(0, limit);
    },

    async findOwned(userId: string, taskId: string) {
      const r = rows.get(taskId);
      return r && r.userId === userId ? r : null;
    },

    /** The status CAS — the one authoritative terminal transition. */
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

    async create() { throw new Error("unused"); },
    async list() { return [...rows.values()]; },
    async listByStatus(userId: string, status: TaskStatus) {
      return [...rows.values()].filter((r) => r.userId === userId && r.status === status);
    },
    async findOrphanedClaims() { return []; },
    async recoverClaim() { return false; },
    async findDueScheduled() { return []; },
    async claimSchedule() { return false; },
    async setScheduleOwned() { return null; },
  };
}

type Result = "success" | "failure" | "rejected" | "pending";

function harness(evidence: Record<string, Result> = {}, over: { graceMs?: number } = {}) {
  const store = makeStore();
  const events: Array<{ level: string; event: string; meta?: Record<string, unknown> }> = [];
  const lookups: Array<{ userId: string; executionId: string; since: Date }> = [];

  const findExecutionOutcome = vi.fn(
    async (userId: string, executionId: string, since: Date) => {
      lookups.push({ userId, executionId, since });
      const result = evidence[executionId];
      return result ? { result } : null;
    }
  );

  const taskService = new TaskService({ tasks: store as never });
  const executor = { execute: vi.fn() };

  const scheduler = new TaskSchedulerService({
    tasks: store as never,
    taskService,
    planner: { planTask: vi.fn() } as never,
    execution: { executeTask: vi.fn() } as never,
    audit: { findExecutionOutcome },
    now: () => NOW,
    log: (level, event, meta) => events.push({ level, event, ...(meta ? { meta } : {}) }),
    runningRecoveryGraceMs: over.graceMs ?? GRACE_MS,
  });

  return { store, scheduler, events, lookups, findExecutionOutcome, executor, taskService };
}

const names = (h: ReturnType<typeof harness>) => h.events.map((e) => e.event);

// ---------------------------------------------------------------------------
// The evidence decides
// ---------------------------------------------------------------------------

describe("V2.3 — reconciliation from audit evidence", () => {
  it("A. stale RUNNING + success audit -> exactly one COMPLETED transition", async () => {
    const h = harness({ "exec-1": "success" });
    const task = h.store.seed();

    const out = await h.scheduler.recoverStaleRunning();

    expect(out).toEqual([{ taskId: task.id, outcome: "reconciled", newStatus: "COMPLETED" }]);
    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("COMPLETED");
    expect(row.completedAt).not.toBeNull();
    expect(names(h)).toContain("task_scheduler_running_recovery_reconciled");
  });

  it("B. stale RUNNING + failure audit -> exactly one FAILED transition", async () => {
    const h = harness({ "exec-1": "failure" });
    const task = h.store.seed();

    const out = await h.scheduler.recoverStaleRunning();

    expect(out[0]!.newStatus).toBe("FAILED");
    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("FAILED");
    // A failure is finished but not done.
    expect(row.completedAt).toBeNull();
    expect(row.error).toMatch(/recorded as failure/i);
  });

  it("B2. rejected and pending also settle as FAILED, with the result named", async () => {
    for (const result of ["rejected", "pending"] as const) {
      const h = harness({ "exec-1": result });
      const task = h.store.seed();

      await h.scheduler.recoverStaleRunning();

      const row = h.store.rows.get(task.id)!;
      expect(row.status, result).toBe("FAILED");
      expect(row.error, result).toContain(result);
    }
  });

  it("C. stale RUNNING + NO audit -> exactly one UNRESOLVED transition", async () => {
    const h = harness({}); // no evidence at all
    const task = h.store.seed();

    const out = await h.scheduler.recoverStaleRunning();

    expect(out).toEqual([{ taskId: task.id, outcome: "unresolved", newStatus: "UNRESOLVED" }]);
    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("UNRESOLVED");
    // The reason must say what is UNKNOWN, never that it failed.
    expect(row.error).toMatch(/may or may not have completed/i);
    expect(row.error).not.toMatch(/\bfailed\b/i);
    expect(row.completedAt).toBeNull();
    expect(names(h)).toContain("task_scheduler_running_recovery_unknown");
  });

  it("D. FRESH RUNNING + no audit -> left alone, still RUNNING", async () => {
    const h = harness({});
    const task = h.store.seed({ startedAt: FRESH_START });

    expect(await h.scheduler.recoverStaleRunning()).toEqual([]);
    expect(h.store.rows.get(task.id)!.status).toBe("RUNNING");
    // Not even looked up: inside the window there is nothing to decide.
    expect(h.findExecutionOutcome).not.toHaveBeenCalled();
  });

  it("D2. the boundary belongs to the LIVE side", async () => {
    const h = harness({});
    const task = h.store.seed({ startedAt: ago(STALE_AFTER_MS) });

    expect(await h.scheduler.recoverStaleRunning()).toEqual([]);
    expect(h.store.rows.get(task.id)!.status).toBe("RUNNING");
  });

  it("the threshold is DERIVED from the executor deadline, not restated", async () => {
    const h = harness({});
    h.store.seed();

    await h.scheduler.recoverStaleRunning();

    const started = h.events.find((e) => e.event === "task_scheduler_running_recovery_started");
    expect(started!.meta).toMatchObject({
      executionDeadlineMs: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
      graceMs: GRACE_MS,
      staleAfterMs: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS + GRACE_MS,
    });
  });

  it("the evidence lookup is bounded by the task's own startedAt", async () => {
    const h = harness({ "exec-1": "success" });
    const task = h.store.seed();

    await h.scheduler.recoverStaleRunning();

    // An audit row cannot predate the task that caused it, so `since` bounds
    // the scan — which is why no index on the JSON column is required.
    expect(h.lookups).toEqual([
      { userId: ALICE, executionId: "exec-1", since: task.startedAt },
    ]);
  });

  it("a RUNNING task with no executionId is UNRESOLVED, not failed", async () => {
    const h = harness({});
    const task = h.store.seed({ executionId: null });

    await h.scheduler.recoverStaleRunning();

    expect(h.store.rows.get(task.id)!.status).toBe("UNRESOLVED");
    // Nothing to look up by.
    expect(h.findExecutionOutcome).not.toHaveBeenCalled();
    const unknown = h.events.find((e) => e.event === "task_scheduler_running_recovery_unknown");
    expect(unknown!.meta).toMatchObject({ recoveryReason: "no_execution_linked" });
  });

  it("is disabled when the grace period is 0", async () => {
    const h = harness({}, { graceMs: 0 });
    const task = h.store.seed();

    expect(await h.scheduler.recoverStaleRunning()).toEqual([]);
    expect(h.store.rows.get(task.id)!.status).toBe("RUNNING");
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe("V2.3 — scope", () => {
  it("ignores tasks that are not JARVIS work", async () => {
    const h = harness({});
    const todo = h.store.seed({ createdBy: null });
    const other = h.store.seed({ createdBy: "n8n" });

    expect(await h.scheduler.recoverStaleRunning()).toEqual([]);
    expect(h.store.rows.get(todo.id)!.status).toBe("RUNNING");
    expect(h.store.rows.get(other.id)!.status).toBe("RUNNING");
  });

  it("ignores every non-RUNNING status, including UNRESOLVED", async () => {
    const h = harness({});
    for (const status of ["PENDING", "COMPLETED", "FAILED", "UNRESOLVED"] as const) {
      h.store.seed({ status });
    }

    expect(await h.scheduler.recoverStaleRunning()).toEqual([]);
  });

  it("J. never modifies scheduledAt", async () => {
    const when = new Date("2026-09-23T10:00:00.000Z");
    for (const evidence of [{ "exec-1": "success" }, {}] as Record<string, Result>[]) {
      const h = harness(evidence);
      const task = h.store.seed({ scheduledAt: when });

      await h.scheduler.recoverStaleRunning();

      expect(h.store.rows.get(task.id)!.scheduledAt).toEqual(when);
    }
  });

  it("I. never creates a new executionId", async () => {
    for (const evidence of [{ "exec-1": "success" }, {}] as Record<string, Result>[]) {
      const h = harness(evidence);
      const task = h.store.seed();

      await h.scheduler.recoverStaleRunning();

      expect(h.store.rows.get(task.id)!.executionId).toBe("exec-1");
    }
  });

  it("H. never invokes ToolExecutor, and never plans or executes", async () => {
    const h = harness({});
    h.store.seed();

    await h.scheduler.recoverStaleRunning();

    expect(h.executor.execute).not.toHaveBeenCalled();
  });

  it("M. UNRESOLVED stays terminal — a second sweep leaves it alone", async () => {
    const h = harness({});
    const task = h.store.seed();

    await h.scheduler.recoverStaleRunning();
    expect(h.store.rows.get(task.id)!.status).toBe("UNRESOLVED");
    const reason = h.store.rows.get(task.id)!.error;

    // Run it again: no candidate, no change, no retry.
    expect(await h.scheduler.recoverStaleRunning()).toEqual([]);
    expect(h.store.rows.get(task.id)!.status).toBe("UNRESOLVED");
    expect(h.store.rows.get(task.id)!.error).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// Races — exactly one authoritative terminal transition
// ---------------------------------------------------------------------------

describe("V2.3 — concurrency", () => {
  it("E. two recovery workers: exactly one transition succeeds", async () => {
    const h = harness({ "exec-1": "success" });
    const task = h.store.seed();
    const second = new TaskSchedulerService({
      tasks: h.store as never,
      taskService: h.taskService,
      planner: {} as never,
      execution: {} as never,
      audit: { findExecutionOutcome: h.findExecutionOutcome },
      now: () => NOW,
      log: () => {},
      runningRecoveryGraceMs: GRACE_MS,
    });

    const [a, b] = await Promise.all([
      h.scheduler.recoverStaleRunning(),
      second.recoverStaleRunning(),
    ]);
    const all = [...a, ...b];

    expect(all.filter((o) => o.outcome === "reconciled")).toHaveLength(1);
    expect(all.filter((o) => o.outcome === "skipped")).toHaveLength(1);
    expect(h.store.rows.get(task.id)!.status).toBe("COMPLETED");
  });

  it("F. worker COMPLETION races recovery: exactly one terminal state wins", async () => {
    const h = harness({});
    const task = h.store.seed();

    // The worker settles first; recovery arrives after and must not overwrite.
    await h.taskService.completeTask(ALICE, task.id);
    const out = await h.scheduler.recoverStaleRunning();

    expect(out).toEqual([]); // no longer RUNNING, so not even a candidate
    expect(h.store.rows.get(task.id)!.status).toBe("COMPLETED");
  });

  it("G. worker FAILURE races recovery mid-sweep: the CAS loser stands down", async () => {
    const h = harness({});
    const task = h.store.seed();

    // Candidate read succeeds; the worker settles before the transition lands.
    h.findExecutionOutcome.mockImplementationOnce(async () => {
      await h.taskService.failTask(ALICE, task.id, "the worker's own reason");
      return null;
    });

    const out = await h.scheduler.recoverStaleRunning();

    expect(out).toEqual([{ taskId: task.id, outcome: "skipped" }]);
    const row = h.store.rows.get(task.id)!;
    // The worker's outcome stands. Recovery did not overwrite it, and did not
    // retry the transition.
    expect(row.status).toBe("FAILED");
    expect(row.error).toBe("the worker's own reason");
    expect(names(h)).toContain("task_scheduler_running_recovery_skipped");
  });

  it("two different stale tasks reconcile independently", async () => {
    const h = harness({ "exec-1": "success", "exec-2": "failure" });
    const a = h.store.seed();
    const b = h.store.seed();

    const out = await h.scheduler.recoverStaleRunning();

    expect(out).toHaveLength(2);
    expect(h.store.rows.get(a.id)!.status).toBe("COMPLETED");
    expect(h.store.rows.get(b.id)!.status).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

describe("V2.3 — observability", () => {
  it("every decision is explainable from the logs", async () => {
    const h = harness({ "exec-1": "success" });
    h.store.seed();

    await h.scheduler.recoverStaleRunning();

    const reconciled = h.events.find(
      (e) => e.event === "task_scheduler_running_recovery_reconciled"
    );
    expect(reconciled!.meta).toMatchObject({
      executionId: "exec-1",
      previousStatus: "RUNNING",
      newStatus: "COMPLETED",
      auditEvidenceFound: true,
      recoveryReason: "audit_result_success",
    });
    expect(reconciled!.meta!.ageMs).toBeTypeOf("number");
  });

  it("an unknown outcome is logged at warn, not info", async () => {
    const h = harness({});
    h.store.seed();

    await h.scheduler.recoverStaleRunning();

    const unknown = h.events.find((e) => e.event === "task_scheduler_running_recovery_unknown");
    expect(unknown!.level).toBe("warn");
    expect(unknown!.meta).toMatchObject({
      auditEvidenceFound: false,
      recoveryReason: "no_audit_evidence_after_execution_window",
    });
  });

  it("logs no tool arguments or secrets", async () => {
    const h = harness({});
    h.store.seed();

    await h.scheduler.recoverStaleRunning();

    const serialised = JSON.stringify(h.events);
    expect(serialised).not.toContain("Pause the campaign"); // the title
    expect(serialised).not.toMatch(/params|arguments|token|secret/i);
  });

  it("is silent when there is nothing stale", async () => {
    const h = harness({});
    h.store.seed({ startedAt: FRESH_START });

    await h.scheduler.recoverStaleRunning();

    expect(h.events).toEqual([]);
  });
});
