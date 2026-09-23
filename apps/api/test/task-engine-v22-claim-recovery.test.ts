// ---------------------------------------------------------------------------
// Task Engine V2.2 — claim recovery.
//
// V2.1 made an abandoned claim DETECTABLE. This recovers it.
//
// THE SAFETY ARGUMENT THIS SUITE EXISTS TO HOLD. Recovery re-arms a task for
// another attempt, so the question that decides whether it is safe is: can the
// tool already have run? For this window the answer is provably no, and the
// proof is the task's own status rather than any log:
//
//   executeTask step 4   startTask  PENDING -> RUNNING   (committed)
//   executeTask step 5   executor.execute                (the ONLY side effect)
//
// `status = PENDING` therefore means step 4 never committed, so step 5 was
// never called. A task that crashed AFTER step 4 is RUNNING, not PENDING, and
// is deliberately out of scope — its evidence IS ambiguous, and that is V2.3.
//
// The second property, tested just as hard: recovery cannot cause a double
// execution even when it is WRONG. A premature re-arm leaves two processes
// racing the same compare-and-set on `status = PENDING`, and that CAS admits
// exactly one. Being early costs a wasted plan, never a duplicate run.
//
// The store models the repository's WHERE clauses. Every "crash" below is a
// deterministic abstraction — a step simply not performed — never a timer.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { JARVIS_TASK_CREATOR, type TaskStatus } from "@jarvis/core";
import type { TaskRecord } from "@jarvis/db";
import { TaskSchedulerService } from "../src/services/tasks/task-scheduler-service.js";

const ALICE = "user-alice";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const RECOVERY_AFTER_MS = 300_000; // 5 minutes
const minutes = (n: number) => n * 60_000;

/** A claim old enough to be abandoned, and one that is not. */
const DEAD_CLAIM = new Date(NOW.getTime() - minutes(10));
const LIVE_CLAIM = new Date(NOW.getTime() - minutes(1));

// ---------------------------------------------------------------------------
// The repository's WHERE clauses, in a Map.
// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;

  const isOrphan = (r: TaskRecord, createdBy: string, before: Date): boolean =>
    r.createdBy === createdBy &&
    r.status === "PENDING" &&
    r.scheduledAt !== null &&
    r.claimedAt !== null &&
    r.claimedAt.getTime() < before.getTime() &&
    r.executionId === null;

  return {
    rows,
    seed(over: Partial<TaskRecord> = {}): TaskRecord {
      const row: TaskRecord = {
        id: `task-${++seq}`,
        userId: ALICE,
        title: "Check my system status",
        description: null,
        dueAt: null,
        priority: "NORMAL",
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        error: null,
        remindedAt: null,
        scheduledAt: new Date(NOW.getTime() - minutes(30)),
        claimedAt: null,
        executionId: null,
        createdBy: JARVIS_TASK_CREATOR,
        createdAt: NOW,
        updatedAt: NOW,
        ...over,
      };
      rows.set(row.id, row);
      return row;
    },

    async findOrphanedClaims(createdBy: string, claimedBefore: Date, limit = 20) {
      return [...rows.values()]
        .filter((r) => isOrphan(r, createdBy, claimedBefore))
        .slice(0, limit);
    },

    /**
     * The recovery compare-and-set, modelled faithfully. The read-and-write
     * pair is synchronous inside one async body — the atomicity a single
     * `updateMany` gives — so a test can drive a genuine race.
     */
    async recoverClaim(taskId: string, createdBy: string, claimedBefore: Date) {
      const r = rows.get(taskId);
      if (!r || !isOrphan(r, createdBy, claimedBefore)) return false;
      r.claimedAt = null;
      r.updatedAt = new Date();
      return true;
    },

    // -- V2.1 claim, unchanged ---------------------------------------------
    async findDueScheduled(createdBy: string, now: Date, limit = 20) {
      return [...rows.values()]
        .filter(
          (r) =>
            r.createdBy === createdBy &&
            r.status === "PENDING" &&
            r.scheduledAt !== null &&
            r.scheduledAt.getTime() <= now.getTime() &&
            r.claimedAt === null
        )
        .slice(0, limit);
    },

    async claimSchedule(taskId: string, createdBy: string, claimedAt: Date = new Date()) {
      const r = rows.get(taskId);
      if (!r) return false;
      if (r.createdBy !== createdBy) return false;
      if (r.status !== "PENDING") return false;
      if (r.scheduledAt === null) return false;
      if (r.claimedAt !== null) return false;
      r.claimedAt = claimedAt;
      return true;
    },

    /** The status CAS — the final gate in front of every tool call. */
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
      return { ok: true as const, task: r };
    },

    async setScheduleOwned() { return null; },
  };
}

function harness(over: { claimRecoveryAfterMs?: number } = {}) {
  const store = makeStore();
  const events: Array<{ event: string; meta?: Record<string, unknown> }> = [];
  const scheduler = new TaskSchedulerService({
    tasks: store as never,
    taskService: {} as never,
    planner: {} as never,
    execution: {} as never,
    now: () => NOW,
    log: (_l, event, meta) => events.push({ event, ...(meta ? { meta } : {}) }),
    claimRecoveryAfterMs: over.claimRecoveryAfterMs ?? RECOVERY_AFTER_MS,
  });
  return { store, scheduler, events };
}

const eventNames = (h: ReturnType<typeof harness>) => h.events.map((e) => e.event);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("V2.2 — detection", () => {
  it("1. an orphaned claim is detected and re-armed", async () => {
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });

    const out = await h.scheduler.recoverOrphanedClaims();

    expect(out).toEqual([{ taskId: task.id, outcome: "re_armed" }]);
    expect(h.store.rows.get(task.id)!.claimedAt).toBeNull();
  });

  it("2. a LIVE claim is never touched", async () => {
    const h = harness();
    const task = h.store.seed({ claimedAt: LIVE_CLAIM });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
    expect(h.store.rows.get(task.id)!.claimedAt).toEqual(LIVE_CLAIM);
  });

  it("2b. a claim exactly AT the threshold is not yet abandoned", async () => {
    const h = harness();
    const boundary = new Date(NOW.getTime() - RECOVERY_AFTER_MS);
    const task = h.store.seed({ claimedAt: boundary });

    // Strictly older, not "older or equal": the boundary belongs to the live side.
    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
    expect(h.store.rows.get(task.id)!.claimedAt).toEqual(boundary);
  });

  it("3. a claim in the FUTURE is never recovered", async () => {
    const h = harness();
    const future = new Date(NOW.getTime() + minutes(10));
    h.store.seed({ claimedAt: future });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
  });

  it("4. a task that is not JARVIS work is ignored", async () => {
    const h = harness();
    const todo = h.store.seed({ createdBy: null, claimedAt: DEAD_CLAIM });
    const other = h.store.seed({ createdBy: "n8n", claimedAt: DEAD_CLAIM });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
    expect(h.store.rows.get(todo.id)!.claimedAt).toEqual(DEAD_CLAIM);
    expect(h.store.rows.get(other.id)!.claimedAt).toEqual(DEAD_CLAIM);
  });

  it("5. a non-PENDING task is ignored — RUNNING recovery is NOT this phase", async () => {
    const h = harness();
    for (const status of ["RUNNING", "COMPLETED", "FAILED"] as const) {
      h.store.seed({ status, claimedAt: DEAD_CLAIM });
    }

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
  });

  it("6. an already-unclaimed task is ignored", async () => {
    const h = harness();
    h.store.seed({ claimedAt: null });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
  });

  it("6b. a task with no schedule is ignored — recovery restores, never creates", async () => {
    const h = harness();
    h.store.seed({ scheduledAt: null, claimedAt: DEAD_CLAIM });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
  });

  it("6c. recovery is disabled when the threshold is 0", async () => {
    const h = harness({ claimRecoveryAfterMs: 0 });
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
    expect(h.store.rows.get(task.id)!.claimedAt).toEqual(DEAD_CLAIM);
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe("V2.2 — execution evidence", () => {
  it("7/8/9/10. an executionId on a PENDING task blocks recovery", async () => {
    // This shape should be unreachable — `executionId` is written in the same
    // statement as PENDING -> RUNNING, so a PENDING task cannot have one. It
    // is excluded anyway: if the two facts ever disagreed, the safe reading is
    // "something may have run", and recovery must decline rather than reason
    // about which field to believe.
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM, executionId: "exec-1" });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
    expect(h.store.rows.get(task.id)!.claimedAt).toEqual(DEAD_CLAIM);
  });

  it("recovery NEVER settles a task — no COMPLETED, no FAILED, no fabricated result", async () => {
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });

    await h.scheduler.recoverOrphanedClaims();

    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("PENDING");
    expect(row.completedAt).toBeNull();
    expect(row.error).toBeNull();
    expect(row.startedAt).toBeNull();
    expect(row.executionId).toBeNull();
  });

  it("recovery PRESERVES scheduledAt — it restores eligibility, nothing more", async () => {
    const h = harness();
    const when = new Date(NOW.getTime() - minutes(30));
    const task = h.store.seed({ claimedAt: DEAD_CLAIM, scheduledAt: when });

    await h.scheduler.recoverOrphanedClaims();

    expect(h.store.rows.get(task.id)!.scheduledAt).toEqual(when);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("V2.2 — concurrency", () => {
  it("11. two recovery workers cannot both recover the same task", async () => {
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.store.recoverClaim(task.id, JARVIS_TASK_CREATOR, new Date(NOW.getTime() - RECOVERY_AFTER_MS))
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("11b. the losing worker reports `lost`, not a failure", async () => {
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });
    const other = harness();
    other.store.rows.set(task.id, h.store.rows.get(task.id)!);

    const [a, b] = await Promise.all([
      h.scheduler.recoverOrphanedClaims(),
      other.scheduler.recoverOrphanedClaims(),
    ]);
    const all = [...a, ...b];

    expect(all.filter((o) => o.outcome === "re_armed")).toHaveLength(1);
  });

  it("12. recovery racing a live claim cannot create duplicate ownership", async () => {
    // The task is re-armed, then immediately claimed again. Only one claim
    // can be held at a time — `claimedAt IS NULL` is the compare.
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });

    await h.scheduler.recoverOrphanedClaims();

    const claims = await Promise.all([
      h.store.claimSchedule(task.id, JARVIS_TASK_CREATOR, NOW),
      h.store.claimSchedule(task.id, JARVIS_TASK_CREATOR, NOW),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("13. two different orphans recover concurrently — no global serialisation", async () => {
    const h = harness();
    const a = h.store.seed({ claimedAt: DEAD_CLAIM });
    const b = h.store.seed({ claimedAt: DEAD_CLAIM });
    const before = new Date(NOW.getTime() - RECOVERY_AFTER_MS);

    const [ra, rb] = await Promise.all([
      h.store.recoverClaim(a.id, JARVIS_TASK_CREATOR, before),
      h.store.recoverClaim(b.id, JARVIS_TASK_CREATOR, before),
    ]);
    expect([ra, rb]).toEqual([true, true]);
  });
});

// ---------------------------------------------------------------------------
// Crash windows — deterministic, never timing-based
// ---------------------------------------------------------------------------

describe("V2.2 — crash windows", () => {
  it("W1. crash BEFORE the claim commits: nothing to recover, still due", async () => {
    const h = harness();
    const task = h.store.seed({ claimedAt: null });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
    // Untouched and still discoverable by the ordinary scheduler.
    expect(await h.store.findDueScheduled(JARVIS_TASK_CREATOR, NOW)).toHaveLength(1);
    expect(h.store.rows.get(task.id)!.scheduledAt).not.toBeNull();
  });

  it("W2. crash AFTER the claim, BEFORE startTask: recovered, and runnable again", async () => {
    // THE window V2.2 exists for. Claim committed, status still PENDING, so
    // the executor was never reached and no tool ran.
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });

    // Invisible to the scheduler while claimed...
    expect(await h.store.findDueScheduled(JARVIS_TASK_CREATOR, NOW)).toHaveLength(0);

    await h.scheduler.recoverOrphanedClaims();

    // ...and eligible again afterwards.
    expect(await h.store.findDueScheduled(JARVIS_TASK_CREATOR, NOW)).toHaveLength(1);
    expect(await h.store.claimSchedule(task.id, JARVIS_TASK_CREATOR, NOW)).toBe(true);
  });

  it("W3. crash during executor STARTUP: status is RUNNING, so V2.2 declines", async () => {
    // startTask committed, so the executor may have been entered. Evidence is
    // ambiguous and this phase must not touch it.
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });
    await h.store.transitionOwned(ALICE, task.id, "PENDING", "RUNNING", { executionId: "exec-1" });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
    expect(h.store.rows.get(task.id)!.status).toBe("RUNNING");
  });

  it("W4. crash DURING the external call: RUNNING, untouched — the tool may have run", async () => {
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });
    await h.store.transitionOwned(ALICE, task.id, "PENDING", "RUNNING", { executionId: "exec-2" });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
    // Emphatically: V2.2 never re-arms this. Re-arming could duplicate a
    // real side effect, which is the one thing recovery must never do.
    expect(h.store.rows.get(task.id)!.claimedAt).toEqual(DEAD_CLAIM);
  });

  it("W5. crash after the tool succeeded but before the audit write: RUNNING, untouched", async () => {
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });
    await h.store.transitionOwned(ALICE, task.id, "PENDING", "RUNNING", { executionId: "exec-3" });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
  });

  it("W6. crash after the audit write but before COMPLETED: RUNNING, untouched", async () => {
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });
    await h.store.transitionOwned(ALICE, task.id, "PENDING", "RUNNING", { executionId: "exec-4" });

    expect(await h.scheduler.recoverOrphanedClaims()).toEqual([]);
    expect(h.store.rows.get(task.id)!.status).toBe("RUNNING");
  });

  it("a premature re-arm STILL cannot double-execute — the status CAS decides", async () => {
    // The worst case for recovery: it re-arms a claim whose process is alive.
    // Both processes then race the same compare-and-set in front of the tool
    // call, and exactly one wins. This is why being early is cheap.
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });
    await h.scheduler.recoverOrphanedClaims();

    const starts = await Promise.all([
      h.store.transitionOwned(ALICE, task.id, "PENDING", "RUNNING", { executionId: "original" }),
      h.store.transitionOwned(ALICE, task.id, "PENDING", "RUNNING", { executionId: "recovered" }),
    ]);

    expect(starts.filter((s) => s.ok)).toHaveLength(1);
    expect(h.store.rows.get(task.id)!.status).toBe("RUNNING");
  });
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

describe("V2.2 — observability", () => {
  it("reports the orphan and the re-arm", async () => {
    const h = harness();
    h.store.seed({ claimedAt: DEAD_CLAIM });

    await h.scheduler.recoverOrphanedClaims();

    expect(eventNames(h)).toEqual(["task_scheduler_claim_orphaned", "task_scheduler_claim_recovered"]);
  });

  it("says when it declined because another worker got there", async () => {
    const h = harness();
    const task = h.store.seed({ claimedAt: DEAD_CLAIM });
    // Candidate read succeeds, then the row changes before the CAS.
    const original = h.store.recoverClaim.bind(h.store);
    vi.spyOn(h.store, "recoverClaim").mockImplementationOnce(async () => {
      h.store.rows.get(task.id)!.status = "RUNNING";
      return false;
    });

    const out = await h.scheduler.recoverOrphanedClaims();

    expect(out).toEqual([{ taskId: task.id, outcome: "lost" }]);
    expect(eventNames(h)).toContain("task_scheduler_claim_recovery_skipped");
    void original;
  });

  it("is silent when there is nothing to recover", async () => {
    const h = harness();
    h.store.seed({ claimedAt: null });

    await h.scheduler.recoverOrphanedClaims();

    expect(h.events).toEqual([]);
  });
});
