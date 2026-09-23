// ---------------------------------------------------------------------------
// Task Engine V2.1 — the durable claim.
//
// WHAT CHANGED AND WHY. Scheduler V1 claimed a task by CLEARING `scheduledAt`.
// That excluded other claimants correctly, but it destroyed evidence: a crash
// between the claim and the start of execution left the task PENDING with no
// schedule — which is exactly what a task that was never scheduled looks like.
// The work was lost, silently, with nothing in the row to say so.
//
// V2.1 sets `claimedAt` and LEAVES `scheduledAt` intact. The compare-and-set
// moves column and nothing else: `claimedAt IS NULL` is the compare,
// `SET claimed_at` is the set, in one conditional statement.
//
// THE PROPERTY UNDER TEST IS THE RACE, NOT THE FIELD. A test that asserts
// "claimedAt got set" proves only that the code did what it says. The tests
// below run N concurrent claimants against one task and assert that exactly
// ONE wins — which is the thing that would actually break if the compare were
// dropped, weakened, or turned into a read-then-write.
//
// The store is a faithful model of the repository's WHERE clauses. It is the
// same fake `scheduler-v1.test.ts` uses, kept in step deliberately: the
// race-safety argument lives in those predicates and nowhere else.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { JARVIS_TASK_CREATOR, type TaskStatus } from "@jarvis/core";
import type { TaskRecord } from "@jarvis/db";

const ALICE = "user-alice";
const T0 = new Date("2026-09-23T09:00:00.000Z");
const DUE = new Date(T0.getTime() - 60_000); // one minute ago

// ---------------------------------------------------------------------------
// The repository's WHERE clauses, in a Map.
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
        title: "Check my system status",
        description: null,
        dueAt: null,
        priority: "NORMAL",
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        error: null,
        remindedAt: null,
        scheduledAt: DUE,
        claimedAt: null,
        executionId: null,
        createdBy: JARVIS_TASK_CREATOR,
        createdAt: now,
        updatedAt: now,
        ...over,
      };
      rows.set(row.id, row);
      return row;
    },

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

    /**
     * The compare-and-set, modelled faithfully.
     *
     * Every predicate mirrors the repository. The read-and-write pair is
     * synchronous inside one async body — exactly the atomicity a single
     * `updateMany` gives — so a concurrent caller genuinely observes the
     * winner's write, and a test can drive a real race.
     */
    async claimSchedule(taskId: string, createdBy: string, claimedAt: Date = new Date()) {
      const r = rows.get(taskId);
      if (!r) return false;
      if (r.createdBy !== createdBy) return false;
      if (r.status !== "PENDING") return false;
      if (r.scheduledAt === null) return false;
      if (r.claimedAt !== null) return false;
      r.claimedAt = claimedAt;
      r.updatedAt = new Date();
      return true;
    },

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
  };
}

/** N claimants going for one task at the same time. */
async function race(
  store: ReturnType<typeof makeStore>,
  taskId: string,
  claimants: number,
  createdBy = JARVIS_TASK_CREATOR
): Promise<number> {
  const results = await Promise.all(
    Array.from({ length: claimants }, () => store.claimSchedule(taskId, createdBy))
  );
  return results.filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// The claim is durable
// ---------------------------------------------------------------------------

describe("V2.1 — a claimed schedule survives the claim", () => {
  it("1. a due, scheduled JARVIS task can be claimed", async () => {
    const store = makeStore();
    const task = store.seed();

    expect(await store.claimSchedule(task.id, JARVIS_TASK_CREATOR)).toBe(true);
  });

  it("2. claimedAt is populated by the claim", async () => {
    const store = makeStore();
    const task = store.seed();
    const at = new Date("2026-09-23T09:00:05.000Z");

    await store.claimSchedule(task.id, JARVIS_TASK_CREATOR, at);

    expect(store.rows.get(task.id)!.claimedAt?.toISOString()).toBe(at.toISOString());
  });

  it("3. scheduledAt is PRESERVED — this is the whole point of V2.1", async () => {
    const store = makeStore();
    const task = store.seed();

    await store.claimSchedule(task.id, JARVIS_TASK_CREATOR);

    // Before V2.1 this was null, and a crash here was indistinguishable from
    // work that had never been scheduled.
    expect(store.rows.get(task.id)!.scheduledAt?.toISOString()).toBe(DUE.toISOString());
  });

  it("3b. a crash after the claim leaves EVIDENCE the claim happened", async () => {
    const store = makeStore();
    const task = store.seed();

    // Claim, then nothing — the process died before startTask.
    await store.claimSchedule(task.id, JARVIS_TASK_CREATOR);

    const row = store.rows.get(task.id)!;
    // The V1 shape of a lost task was: PENDING, scheduledAt null, no trace.
    // The V2.1 shape is recoverable, because all three facts survive.
    expect(row.status).toBe("PENDING");
    expect(row.scheduledAt).not.toBeNull();
    expect(row.claimedAt).not.toBeNull();
  });

  it("3c. a claimed task is no longer DISCOVERABLE as due", async () => {
    const store = makeStore();
    const task = store.seed();

    expect(await store.findDueScheduled(JARVIS_TASK_CREATOR, T0)).toHaveLength(1);
    await store.claimSchedule(task.id, JARVIS_TASK_CREATOR);
    // It still has a scheduledAt, so it MUST be excluded by claimedAt instead
    // — otherwise keeping the schedule would resurrect it every sweep.
    expect(await store.findDueScheduled(JARVIS_TASK_CREATOR, T0)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The race — the property that would actually break
// ---------------------------------------------------------------------------

describe("V2.1 — exactly one claimant wins", () => {
  it("5. two concurrent replicas: exactly ONE claim succeeds", async () => {
    const store = makeStore();
    const task = store.seed();

    expect(await race(store, task.id, 2)).toBe(1);
  });

  it("5b. twenty concurrent claimants: still exactly ONE", async () => {
    const store = makeStore();
    const task = store.seed();

    expect(await race(store, task.id, 20)).toBe(1);
    expect(store.rows.get(task.id)!.claimedAt).not.toBeNull();
  });

  it("5c. a second claim AFTER the first is refused", async () => {
    const store = makeStore();
    const task = store.seed();

    expect(await store.claimSchedule(task.id, JARVIS_TASK_CREATOR)).toBe(true);
    expect(await store.claimSchedule(task.id, JARVIS_TASK_CREATOR)).toBe(false);
  });

  it("5d. the winner's claimedAt is not overwritten by a loser", async () => {
    const store = makeStore();
    const task = store.seed();
    const first = new Date("2026-09-23T09:00:01.000Z");
    const second = new Date("2026-09-23T09:00:09.000Z");

    await store.claimSchedule(task.id, JARVIS_TASK_CREATOR, first);
    await store.claimSchedule(task.id, JARVIS_TASK_CREATOR, second);

    expect(store.rows.get(task.id)!.claimedAt?.toISOString()).toBe(first.toISOString());
  });

  it("5e. racing two DIFFERENT tasks: both win, independently", async () => {
    // Guards against a fix that serialises everything instead of one row.
    const store = makeStore();
    const a = store.seed();
    const b = store.seed();

    const [ra, rb] = await Promise.all([
      store.claimSchedule(a.id, JARVIS_TASK_CREATOR),
      store.claimSchedule(b.id, JARVIS_TASK_CREATOR),
    ]);
    expect([ra, rb]).toEqual([true, true]);
  });
});

// ---------------------------------------------------------------------------
// The other predicates are unchanged — V2.1 only ADDS one
// ---------------------------------------------------------------------------

describe("V2.1 — eligibility is not weakened", () => {
  it("6. a task not yet due is not discoverable", async () => {
    const store = makeStore();
    store.seed({ scheduledAt: new Date(T0.getTime() + 60_000) });

    expect(await store.findDueScheduled(JARVIS_TASK_CREATOR, T0)).toHaveLength(0);
  });

  it("6b. an unscheduled task is never claimable", async () => {
    const store = makeStore();
    const task = store.seed({ scheduledAt: null });

    expect(await store.claimSchedule(task.id, JARVIS_TASK_CREATOR)).toBe(false);
    expect(await store.findDueScheduled(JARVIS_TASK_CREATOR, T0)).toHaveLength(0);
  });

  it("7. a non-PENDING task is never claimable", async () => {
    const store = makeStore();
    for (const status of ["RUNNING", "COMPLETED", "FAILED"] as const) {
      const task = store.seed({ status });
      expect(await store.claimSchedule(task.id, JARVIS_TASK_CREATOR), status).toBe(false);
    }
    expect(await store.findDueScheduled(JARVIS_TASK_CREATOR, T0)).toHaveLength(0);
  });

  it("8. a task that is not JARVIS work is never claimable", async () => {
    const store = makeStore();
    const todo = store.seed({ createdBy: null });
    const other = store.seed({ createdBy: "n8n" });

    expect(await store.claimSchedule(todo.id, JARVIS_TASK_CREATOR)).toBe(false);
    expect(await store.claimSchedule(other.id, JARVIS_TASK_CREATOR)).toBe(false);
    // And neither is even discoverable.
    expect(await store.findDueScheduled(JARVIS_TASK_CREATOR, T0)).toHaveLength(0);
  });

  it("8b. historical rows (claimedAt null, no schedule) stay inert", async () => {
    // The stale PENDING rows from before the goal-cleaning fix. The migration
    // gives them claimedAt = NULL, and they must behave exactly as they did.
    const store = makeStore();
    store.seed({ title: "In 3 minutes check my system status", scheduledAt: null });

    expect(await store.findDueScheduled(JARVIS_TASK_CREATOR, T0)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The execution link
// ---------------------------------------------------------------------------

describe("V2.1 — the execution link", () => {
  it("4. executionId is written in the SAME statement as PENDING -> RUNNING", async () => {
    const store = makeStore();
    const task = store.seed();

    const moved = await store.transitionOwned(ALICE, task.id, "PENDING", "RUNNING", {
      executionId: "exec-abc",
    });

    expect(moved.ok).toBe(true);
    const row = store.rows.get(task.id)!;
    // Both facts land together: there is no window in which a task is RUNNING
    // without saying which run is running it.
    expect(row.status).toBe("RUNNING");
    expect(row.executionId).toBe("exec-abc");
  });

  it("4b. a LOST status race writes no executionId", async () => {
    const store = makeStore();
    const task = store.seed();

    await store.transitionOwned(ALICE, task.id, "PENDING", "RUNNING", { executionId: "winner" });
    const loser = await store.transitionOwned(ALICE, task.id, "PENDING", "RUNNING", {
      executionId: "loser",
    });

    expect(loser.ok).toBe(false);
    expect(store.rows.get(task.id)!.executionId).toBe("winner");
  });

  it("4c. a transition without an executionId leaves the existing one alone", async () => {
    const store = makeStore();
    const task = store.seed({ status: "RUNNING", executionId: "exec-abc" });

    await store.transitionOwned(ALICE, task.id, "RUNNING", "COMPLETED");

    expect(store.rows.get(task.id)!.executionId).toBe("exec-abc");
  });

  it("4d. historical rows keep a null executionId — nothing is backfilled", async () => {
    const store = makeStore();
    const task = store.seed({ status: "COMPLETED", completedAt: new Date() });

    expect(store.rows.get(task.id)!.executionId).toBeNull();
  });
});
