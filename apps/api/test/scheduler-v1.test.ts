// ---------------------------------------------------------------------------
// Scheduler V1 — WHEN.
//
// The stack already had WHAT (Task), HOW (Planner) and DO (Execution). This
// suite tests the only thing added: a time, and the claim that makes a due
// task run exactly once.
//
// THE REAL SERVICES RUN IN EVERY TEST HERE. A genuine `ToolExecutor` over a
// genuine `ToolRegistry`, the real `TaskService`, `TaskPlannerService`,
// `TaskExecutionService`, `TaskConversationService` and the real scheduler
// loop. The only doubles are the three edges that are external by nature: the
// model, the task rows, and the clock.
//
// That is deliberate. The property under test is "a schedule grants nothing" —
// a scheduled run must reach exactly the checks an immediate run reaches, and
// a faked executor would prove only that something named `execute` was called.
//
// The store fake mirrors the repository's WHERE clauses exactly, including the
// compare-and-set claim, because the race-safety argument lives in those
// clauses and nowhere else.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";
import { detectWorkRequest, parseSchedulePhrase } from "@jarvis/agents";
import { ToolExecutor, ToolRegistry, BaseTool } from "@jarvis/tools";
import {
  JARVIS_TASK_CREATOR,
  ShutdownLifecycle,
  type AICompletionRequest,
  type AICompletionResponse,
  type AuditLogger,
  type IAIProvider,
  type IApprovalManager,
  type IPermissionChecker,
  type Role,
  type TaskStatus,
  type ToolResult,
} from "@jarvis/core";
import type { TaskRecord } from "@jarvis/db";
import { TaskService } from "../src/services/tasks/task-service.js";
import { TaskPlannerService } from "../src/services/tasks/task-planner-service.js";
import { TaskExecutionService } from "../src/services/tasks/task-execution-service.js";
import { TaskConversationService } from "../src/services/tasks/task-conversation-service.js";
import { TaskSchedulerService } from "../src/services/tasks/task-scheduler-service.js";
import { startTaskSchedulerLoop } from "../src/services/task-scheduler-loop.js";

const ALICE = "user-alice";
const BOB = "user-bob";
const ROLE: Role = "owner";

const T0 = new Date("2026-09-22T09:00:00.000Z");
const minutes = (n: number) => n * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Real tools
// ---------------------------------------------------------------------------

class SystemStatusTool extends BaseTool {
  public calls = 0;
  constructor() {
    super(
      "system.status",
      "System status",
      "Report the current health of the system.",
      "system",
      [],
      false,
      ["read"],
      "READ_ONLY"
    );
  }
  async execute(): Promise<ToolResult> {
    this.calls += 1;
    return this.success({ healthy: true });
  }
}

/** Approval-gated, to prove the gate still stands in front of a SCHEDULED run. */
class GatedWriteTool extends BaseTool {
  public calls = 0;
  constructor() {
    super(
      "system.gatedWrite",
      "Gated write",
      "A write that always requires approval.",
      "system",
      [],
      true,
      ["read", "write"],
      "EXTERNAL_SIDE_EFFECT"
    );
  }
  async execute(): Promise<ToolResult> {
    this.calls += 1;
    return this.success({ wrote: true });
  }
}

/** An ungated write, to prove the PERMISSION check still applies. */
class WriteTool extends BaseTool {
  public calls = 0;
  constructor() {
    super(
      "system.write",
      "Write",
      "A write that needs the write permission.",
      "system",
      [],
      false,
      ["read", "write"],
      "LOW_IMPACT"
    );
  }
  async execute(): Promise<ToolResult> {
    this.calls += 1;
    return this.success({ wrote: true });
  }
}

// ---------------------------------------------------------------------------
// The task store — the repository's WHERE clauses, expressed in a Map.
// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;

  const row = (userId: string, over: Partial<TaskRecord> = {}): TaskRecord => {
    const now = new Date();
    return {
      id: `task-${++seq}`,
      userId,
      title: "Check my system status",
      description: null,
      dueAt: null,
      priority: "NORMAL",
      status: "PENDING",
      startedAt: null,
      completedAt: null,
      error: null,
      remindedAt: null,
      scheduledAt: null,
      createdBy: JARVIS_TASK_CREATOR,
      createdAt: now,
      updatedAt: now,
      ...over,
    };
  };

  return {
    rows,

    /** Direct seeding, for states `createTask` cannot produce (RUNNING, todo). */
    seed(userId: string, over: Partial<TaskRecord> = {}): TaskRecord {
      const r = row(userId, over);
      rows.set(r.id, r);
      return r;
    },

    async create(
      userId: string,
      input: { title: string; description?: string | null; createdBy?: string | null }
    ) {
      const r = row(userId, {
        title: input.title,
        description: input.description ?? null,
        createdBy: input.createdBy ?? null,
      });
      rows.set(r.id, r);
      return r;
    },

    async list(userId: string, options: { createdBy?: string } = {}) {
      return [...rows.values()]
        .filter((r) => r.userId === userId)
        .filter((r) => (options.createdBy === undefined ? true : r.createdBy === options.createdBy));
    },

    async listByStatus(userId: string, status: TaskStatus) {
      return [...rows.values()].filter((r) => r.userId === userId && r.status === status);
    },

    async findOwned(userId: string, taskId: string) {
      const r = rows.get(taskId);
      return r && r.userId === userId ? r : null;
    },

    async transitionOwned(
      userId: string,
      taskId: string,
      expectedFrom: TaskStatus,
      to: TaskStatus,
      options: { error?: string | null } = {}
    ) {
      const r = rows.get(taskId);
      if (!r || r.userId !== userId) {
        return { ok: false as const, reason: "not_found" as const, current: null };
      }
      if (r.status !== expectedFrom) {
        return { ok: false as const, reason: "state_changed" as const, current: r.status };
      }
      r.status = to;
      if (to === "RUNNING") r.startedAt = new Date();
      if (to === "COMPLETED") {
        r.completedAt = new Date();
        r.error = null;
      }
      if (to === "FAILED") r.error = options.error ?? null;
      return { ok: true as const, task: r };
    },

    // -- Scheduler V1 -------------------------------------------------------
    // Every eligibility rule is here, in the equivalent of the WHERE clause,
    // so "not yours", "a todo" and "already running" are refused atomically
    // rather than read and then trusted.

    async setScheduleOwned(
      userId: string,
      taskId: string,
      createdBy: string,
      scheduledAt: Date | null
    ) {
      const r = rows.get(taskId);
      if (!r) return null;
      if (r.userId !== userId) return null;
      if (r.createdBy !== createdBy) return null;
      if (r.status !== "PENDING") return null;
      r.scheduledAt = scheduledAt;
      r.updatedAt = new Date();
      return r;
    },

    async findDueScheduled(createdBy: string, now: Date, limit = 20) {
      return [...rows.values()]
        .filter(
          (r) =>
            r.createdBy === createdBy &&
            r.status === "PENDING" &&
            r.scheduledAt !== null &&
            r.scheduledAt.getTime() <= now.getTime()
        )
        .slice(0, limit);
    },

    /**
     * The compare-and-set claim, modelled faithfully.
     *
     * Clearing `scheduledAt` IS the consumption marker — there is no second
     * "consumed" column — and the read-and-write pair is synchronous inside
     * one async body, which is exactly the atomicity a single `updateMany`
     * gives in the database.
     */
    async claimSchedule(taskId: string, createdBy: string) {
      const r = rows.get(taskId);
      if (!r) return false;
      if (r.createdBy !== createdBy) return false;
      if (r.status !== "PENDING") return false;
      if (r.scheduledAt === null) return false;
      r.scheduledAt = null;
      r.updatedAt = new Date();
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// The one other double: the model.
// ---------------------------------------------------------------------------

function providerReturning(content: string): IAIProvider & { seen: AICompletionRequest[] } {
  const seen: AICompletionRequest[] = [];
  return {
    seen,
    id: "openai",
    name: "OpenAI",
    defaultModel: "gpt-4o",
    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
      seen.push(request);
      return {
        message: { role: "assistant", content },
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "gpt-4o",
      };
    },
    async listModels() {
      return ["gpt-4o"];
    },
    async isAvailable() {
      return true;
    },
  };
}

const PLAN_STATUS = JSON.stringify({
  executable: true,
  toolId: "system.status",
  params: {},
  reason: "Reporting system health answers the request directly.",
});

const PLAN_GATED = JSON.stringify({
  executable: true,
  toolId: "system.gatedWrite",
  params: {},
  reason: "The request asks for a write.",
});

const PLAN_WRITE = JSON.stringify({
  executable: true,
  toolId: "system.write",
  params: {},
  reason: "The request asks for a write.",
});

const PLAN_NONE = JSON.stringify({
  executable: false,
  reason: "No available capability covers this request.",
});

const allowAll: IPermissionChecker = { hasPermission: () => true };

// ---------------------------------------------------------------------------

function harness(modelOutput: string = PLAN_STATUS, perms: IPermissionChecker = allowAll) {
  const store = makeStore();
  const tasks = new TaskService({ tasks: store });

  const status = new SystemStatusTool();
  const gated = new GatedWriteTool();
  const write = new WriteTool();

  const registry = new ToolRegistry();
  for (const tool of [status, gated, write]) registry.register(tool);

  const allowedToolIds = new Set(["system.status", "system.gatedWrite", "system.write"]);
  const provider = providerReturning(modelOutput);

  const executor = new ToolExecutor(
    registry,
    perms,
    {
      requestApproval: vi.fn().mockResolvedValue({ id: "approval-1", status: "pending" }),
      findApprovalsForTool: vi.fn().mockResolvedValue([]),
    } as unknown as IApprovalManager,
    { log: vi.fn() } as unknown as AuditLogger
  );
  const executeSpy = vi.spyOn(executor, "execute");

  const planner = new TaskPlannerService({ provider, registry, allowedToolIds });
  const planSpy = vi.spyOn(planner, "planTask");
  const execution = new TaskExecutionService({ tasks, executor, allowedToolIds });
  const executeTaskSpy = vi.spyOn(execution, "executeTask");

  // The clock is a mutable box, so a test moves time rather than sleeping.
  const clock = { now: new Date(T0) };
  const scheduler = new TaskSchedulerService({
    tasks: store,
    taskService: tasks,
    planner,
    execution,
    now: () => clock.now,
  });

  const conversation = new TaskConversationService({ tasks, planner, execution, scheduler });

  /** A second process over the SAME rows — the restart scenario. */
  const restart = () =>
    new TaskSchedulerService({
      tasks: store,
      taskService: tasks,
      planner,
      execution,
      now: () => clock.now,
    });

  async function workTask(userId = ALICE, title = "Check my system status") {
    const created = await tasks.createTask(userId, { title, createdBy: JARVIS_TASK_CREATOR });
    if (!created.ok) throw new Error("setup failed");
    return created.task;
  }

  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };

  return {
    store,
    tasks,
    planner,
    execution,
    executor,
    scheduler,
    conversation,
    restart,
    clock,
    advance,
    workTask,
    status,
    gated,
    write,
    executeSpy,
    planSpy,
    executeTaskSpy,
    provider,
  };
}

const IN_AN_HOUR = () => new Date(T0.getTime() + minutes(60));

// ---------------------------------------------------------------------------
// A–G — what may be scheduled, and what may not
// ---------------------------------------------------------------------------

describe("Scheduler V1 — schedule creation", () => {
  it("A. accepts a future time on a pending JARVIS work task", async () => {
    const h = harness();
    const task = await h.workTask();

    const result = await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.scheduledAt?.toISOString()).toBe(IN_AN_HOUR().toISOString());
    // Scheduling is metadata around a PENDING task, never a new state.
    expect(result.task.status).toBe("PENDING");
  });

  it("B. rejects a time in the past, and leaves the task unscheduled", async () => {
    const h = harness();
    const task = await h.workTask();

    const past = await h.scheduler.scheduleTask(ALICE, task.id, new Date(T0.getTime() - 1000));

    expect(past.ok).toBe(false);
    if (past.ok) return;
    expect(past.refusal).toBe("INVALID_TIME");
    expect(h.store.rows.get(task.id)!.scheduledAt).toBeNull();
  });

  it("B2. rejects an unusable timestamp rather than storing NaN", async () => {
    const h = harness();
    const task = await h.workTask();

    const result = await h.scheduler.scheduleTask(ALICE, task.id, new Date("not a date"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("INVALID_TIME");
    expect(h.store.rows.get(task.id)!.scheduledAt).toBeNull();
  });

  it("B3. rejects the exact current instant — 'future' means strictly future", async () => {
    const h = harness();
    const task = await h.workTask();

    const result = await h.scheduler.scheduleTask(ALICE, task.id, new Date(T0));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("INVALID_TIME");
  });

  it("C. refuses another user's task, and says nothing about it existing", async () => {
    const h = harness();
    const bobs = await h.workTask(BOB);

    const result = await h.scheduler.scheduleTask(ALICE, bobs.id, IN_AN_HOUR());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The same refusal a missing task gets: existence is not leaked.
    expect(result.refusal).toBe("NOT_SCHEDULABLE");
    expect(h.store.rows.get(bobs.id)!.scheduledAt).toBeNull();
  });

  it("D. refuses an ordinary todo task — the execution scheduler is not the reminder system", async () => {
    const h = harness();
    const todo = h.store.seed(ALICE, { createdBy: null, title: "Buy milk" });

    const result = await h.scheduler.scheduleTask(ALICE, todo.id, IN_AN_HOUR());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("NOT_SCHEDULABLE");
    expect(h.store.rows.get(todo.id)!.scheduledAt).toBeNull();
  });

  it("E. refuses a RUNNING task", async () => {
    const h = harness();
    const running = h.store.seed(ALICE, { status: "RUNNING", startedAt: new Date() });

    const result = await h.scheduler.scheduleTask(ALICE, running.id, IN_AN_HOUR());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("NOT_SCHEDULABLE");
  });

  it("F. refuses a COMPLETED task", async () => {
    const h = harness();
    const done = h.store.seed(ALICE, { status: "COMPLETED", completedAt: new Date() });

    const result = await h.scheduler.scheduleTask(ALICE, done.id, IN_AN_HOUR());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("NOT_SCHEDULABLE");
  });

  it("G. refuses a FAILED task", async () => {
    const h = harness();
    const failed = h.store.seed(ALICE, { status: "FAILED", error: "nope" });

    const result = await h.scheduler.scheduleTask(ALICE, failed.id, IN_AN_HOUR());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("NOT_SCHEDULABLE");
  });

  it("G2. refuses a second schedule rather than silently moving the first", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    const later = new Date(T0.getTime() + minutes(180));
    const second = await h.scheduler.scheduleTask(ALICE, task.id, later);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal).toBe("ALREADY_SCHEDULED");
    // The original time is untouched — a duplicate request never moves work.
    expect(h.store.rows.get(task.id)!.scheduledAt?.toISOString()).toBe(IN_AN_HOUR().toISOString());

    // ...unless replacement is asked for explicitly.
    const replaced = await h.scheduler.scheduleTask(ALICE, task.id, later, { replace: true });
    expect(replaced.ok).toBe(true);
    expect(h.store.rows.get(task.id)!.scheduledAt?.toISOString()).toBe(later.toISOString());
  });

  it("reads back a schedule only for its owner", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    const mine = await h.scheduler.getScheduledTask(ALICE, task.id);
    expect(mine.ok).toBe(true);

    const theirs = await h.scheduler.getScheduledTask(BOB, task.id);
    expect(theirs.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H–L — the sweep
// ---------------------------------------------------------------------------

describe("Scheduler V1 — due execution", () => {
  it("H. does not execute before the scheduled time", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    h.advance(minutes(59));
    const outcomes = await h.scheduler.runDue();

    expect(outcomes).toEqual([]);
    expect(h.status.calls).toBe(0);
    expect(h.executeSpy).not.toHaveBeenCalled();
    // Still scheduled, still pending — the sweep did not consume anything.
    expect(h.store.rows.get(task.id)!.scheduledAt?.toISOString()).toBe(IN_AN_HOUR().toISOString());
    expect(h.store.rows.get(task.id)!.status).toBe("PENDING");
  });

  it("I. executes a task whose time has arrived", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    h.advance(minutes(60));
    const outcomes = await h.scheduler.runDue();

    expect(outcomes).toEqual([{ taskId: task.id, outcome: "executed", detail: "completed" }]);
    expect(h.status.calls).toBe(1);

    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("COMPLETED");
    // The schedule was consumed by the claim.
    expect(row.scheduledAt).toBeNull();
  });

  it("J. executes a due task exactly once, however often the sweep runs", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    h.advance(minutes(60));
    await h.scheduler.runDue();
    const second = await h.scheduler.runDue();
    const third = await h.scheduler.runDue();

    expect(second).toEqual([]);
    expect(third).toEqual([]);
    expect(h.status.calls).toBe(1);
    expect(h.executeSpy).toHaveBeenCalledTimes(1);
  });

  it("J2. an overdue task runs once, not once per hour it is late", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    // Discovered five hours late — the process was down.
    h.advance(minutes(60 + 300));
    await h.scheduler.runDue();
    await h.scheduler.runDue();

    expect(h.status.calls).toBe(1);
    expect(h.store.rows.get(task.id)!.status).toBe("COMPLETED");
  });

  it("K. two concurrent sweeps cannot both execute the same task", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());
    h.advance(minutes(60));

    const [a, b] = await Promise.all([h.scheduler.runDue(), h.scheduler.runDue()]);

    const all = [...a, ...b];
    expect(all.filter((o) => o.outcome === "executed")).toHaveLength(1);
    // The loser did no work at all: it never planned and never executed.
    expect(h.status.calls).toBe(1);
    expect(h.executeSpy).toHaveBeenCalledTimes(1);
    expect(h.planSpy).toHaveBeenCalledTimes(1);
  });

  it("K2. a second scheduler PROCESS over the same rows also loses the race", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());
    h.advance(minutes(60));

    const replica = h.restart();
    const [a, b] = await Promise.all([h.scheduler.runDue(), replica.runDue()]);

    expect([...a, ...b].filter((o) => o.outcome === "executed")).toHaveLength(1);
    expect(h.status.calls).toBe(1);
  });

  it("L. a restarted process discovers a schedule that fell due while it was down", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    // Nothing swept while the time passed — the process was not running.
    h.advance(minutes(65));
    expect(h.status.calls).toBe(0);

    // A fresh service over the same persisted rows, with no in-process state.
    const rebooted = h.restart();
    const outcomes = await rebooted.runDue();

    expect(outcomes.map((o) => o.outcome)).toEqual(["executed"]);
    expect(h.status.calls).toBe(1);
    expect(h.store.rows.get(task.id)!.status).toBe("COMPLETED");
  });

  it("never sweeps another user's todo, whatever its dueAt says", async () => {
    const h = harness();
    // A todo with a due date in the past — the reminder surface's shape.
    h.store.seed(ALICE, {
      createdBy: null,
      dueAt: new Date(T0.getTime() - minutes(120)),
      scheduledAt: new Date(T0.getTime() - minutes(120)),
    });

    const outcomes = await h.scheduler.runDue();

    expect(outcomes).toEqual([]);
    expect(h.status.calls).toBe(0);
  });

  it("marks a due task FAILED when it can no longer be planned", async () => {
    const h = harness(PLAN_NONE);
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    h.advance(minutes(60));
    const outcomes = await h.scheduler.runDue();

    expect(outcomes[0]!.outcome).toBe("not_planned");
    const row = h.store.rows.get(task.id)!;
    // FAILED with a reason, not left PENDING with a consumed schedule.
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/could not be planned/i);
    expect(h.status.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M–O — cancellation
// ---------------------------------------------------------------------------

describe("Scheduler V1 — cancellation", () => {
  it("M. a cancelled schedule never executes", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    const cancelled = await h.scheduler.cancelScheduledTask(ALICE, task.id);
    expect(cancelled.ok).toBe(true);

    h.advance(minutes(120));
    const outcomes = await h.scheduler.runDue();

    expect(outcomes).toEqual([]);
    expect(h.status.calls).toBe(0);
  });

  it("N. cancelling clears the time and leaves the task itself alone", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    await h.scheduler.cancelScheduledTask(ALICE, task.id);

    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("PENDING");
    expect(row.scheduledAt).toBeNull();
    expect(row.error).toBeNull();
    expect(h.store.rows.size).toBe(1);
  });

  it("O. a cancelled task can be scheduled again", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());
    await h.scheduler.cancelScheduledTask(ALICE, task.id);

    const again = new Date(T0.getTime() + minutes(180));
    const result = await h.scheduler.scheduleTask(ALICE, task.id, again);

    expect(result.ok).toBe(true);
    h.advance(minutes(180));
    await h.scheduler.runDue();
    expect(h.status.calls).toBe(1);
  });

  it("cannot cancel a RUNNING execution", async () => {
    const h = harness();
    const running = h.store.seed(ALICE, {
      status: "RUNNING",
      startedAt: new Date(),
      scheduledAt: null,
    });

    const result = await h.scheduler.cancelScheduledTask(ALICE, running.id);

    expect(result.ok).toBe(false);
    expect(h.store.rows.get(running.id)!.status).toBe("RUNNING");
  });

  it("cannot cancel another user's schedule", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    const result = await h.scheduler.cancelScheduledTask(BOB, task.id);

    expect(result.ok).toBe(false);
    expect(h.store.rows.get(task.id)!.scheduledAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P–S — the boundaries a schedule must not cross
// ---------------------------------------------------------------------------

describe("Scheduler V1 — scheduling is not executing", () => {
  it("P. creating a schedule runs nothing", async () => {
    const h = harness();
    const task = await h.workTask();

    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    expect(h.status.calls).toBe(0);
    expect(h.executeSpy).not.toHaveBeenCalled();
    expect(h.executeTaskSpy).not.toHaveBeenCalled();
    expect(h.store.rows.get(task.id)!.status).toBe("PENDING");
  });

  it("P2. a scheduling conversation turn runs nothing either", async () => {
    const h = harness();

    const result = await h.conversation.handle({
      userId: ALICE,
      role: ROLE,
      goal: "Tomorrow at 10 AM check my system status",
      planOnly: false,
      scheduledAt: IN_AN_HOUR(),
    });

    expect(h.status.calls).toBe(0);
    expect(h.executeTaskSpy).not.toHaveBeenCalled();
    expect(result.scheduledAt).toBe(IN_AN_HOUR().toISOString());
    // The answer states the resolved instant, so a timezone mismatch is
    // visible now rather than at 10 AM.
    expect(result.message).toMatch(/nothing has run yet/i);
    expect(h.store.rows.get(result.taskId)!.status).toBe("PENDING");
  });

  it("Q. a due run goes through TaskPlannerService and TaskExecutionService", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());
    h.advance(minutes(60));

    await h.scheduler.runDue();

    expect(h.planSpy).toHaveBeenCalledTimes(1);
    expect(h.executeTaskSpy).toHaveBeenCalledTimes(1);
    // Planned from the task as it reads NOW, with the OWNING user's id.
    expect(h.planSpy.mock.calls[0]![0]).toMatchObject({ userId: ALICE, taskId: task.id });
    expect(h.executeTaskSpy.mock.calls[0]![0]).toBe(ALICE);
    expect(h.executeTaskSpy.mock.calls[0]![1]).toBe(task.id);
  });

  it("Q2. re-plans from the CURRENT wording, not the wording at scheduling time", async () => {
    const h = harness();
    const task = await h.workTask(ALICE, "Original wording");
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());

    // The user edits the task after scheduling it.
    h.store.rows.get(task.id)!.title = "Edited wording";
    h.advance(minutes(60));
    await h.scheduler.runDue();

    expect(h.planSpy.mock.calls[0]![0]).toMatchObject({ title: "Edited wording" });
  });

  it("R. the scheduler reaches the ToolExecutor only through TaskExecutionService", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());
    h.advance(minutes(60));

    // A scheduler built over a RECORDING execution service. If the scheduler
    // had any path of its own to the executor, the tool would still run.
    const seen: unknown[] = [];
    const isolated = new TaskSchedulerService({
      tasks: h.store,
      taskService: h.tasks,
      planner: h.planner,
      execution: {
        executeTask: async (userId: string, taskId: string, request: unknown) => {
          seen.push({ userId, taskId, request });
          return { ok: false as const, refusal: "NOT_FOUND" as const, message: "recorded" };
        },
      } as unknown as TaskExecutionService,
      now: () => h.clock.now,
    });

    await isolated.runDue();

    expect(seen).toHaveLength(1);
    expect(h.executeSpy).not.toHaveBeenCalled();
    expect(h.status.calls).toBe(0);
  });

  it("S. an approval-gated action is still gated when it runs on a schedule", async () => {
    const h = harness(PLAN_GATED);
    const task = await h.workTask(ALICE, "Publish the thing");
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());
    h.advance(minutes(60));

    await h.scheduler.runDue();

    // The gate held: the tool never ran, and the task says why.
    expect(h.gated.calls).toBe(0);
    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("FAILED");
    expect(row.error).toBeTruthy();
  });

  it("S2. a permission the user does not have is still refused on a schedule", async () => {
    const readOnly: IPermissionChecker = {
      hasPermission: (_role, _resource, action) => action === "read",
    };
    const h = harness(PLAN_WRITE, readOnly);
    const task = await h.workTask(ALICE, "Write something");
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());
    h.advance(minutes(60));

    await h.scheduler.runDue();

    expect(h.write.calls).toBe(0);
    expect(h.store.rows.get(task.id)!.status).toBe("FAILED");
  });

  it("S3. a schedule executes as the OWNING user, never as the sweep", async () => {
    const h = harness();
    const task = await h.workTask(BOB);
    await h.scheduler.scheduleTask(BOB, task.id, IN_AN_HOUR());
    h.advance(minutes(60));

    await h.scheduler.runDue();

    expect(h.executeTaskSpy.mock.calls[0]![0]).toBe(BOB);
    // The lowest role that can reach read-only work: a schedule is never a way
    // to run something later with more authority than it was created with.
    expect(h.executeTaskSpy.mock.calls[0]![2]).toMatchObject({ role: "member" });
  });
});

// ---------------------------------------------------------------------------
// T — time
// ---------------------------------------------------------------------------

describe("Scheduler V1 — time handling", () => {
  it("T. an ISO-8601 instant with an offset is stored as that exact instant", async () => {
    const h = harness();
    const task = await h.workTask();

    // 15:30 in +05:30 is 10:00Z. The offset is authoritative; nothing shifts.
    const iso = "2026-09-22T15:30:00.000+05:30";
    const result = await h.scheduler.scheduleTask(ALICE, task.id, new Date(iso));

    expect(result.ok).toBe(true);
    expect(h.store.rows.get(task.id)!.scheduledAt?.toISOString()).toBe(
      "2026-09-22T10:00:00.000Z"
    );
  });

  it("T2. a bare clock phrase resolves in the SCHEDULING zone, whatever the process runs in", () => {
    // Asserted as an ABSOLUTE INSTANT, not as local fields.
    //
    // An earlier version of this test read `getHours()`, which is the
    // process's zone — so it passed on an IST laptop and failed on a UTC
    // container, and it could not have caught the live defect where exactly
    // that difference sent a real task 5h30m astray. 10:00 IST is 04:30Z, and
    // that is the same fact on every machine.
    const now = new Date("2026-09-22T03:30:00.000Z"); // 09:00 IST
    const parsed = parseSchedulePhrase("tomorrow at 10 am check my system status", now);

    expect(parsed).not.toBeNull();
    expect(parsed!.at.toISOString()).toBe("2026-09-23T04:30:00.000Z");
  });

  it("T3. a relative phrase is measured from the caller's clock", () => {
    const now = new Date("2026-09-22T09:00:00.000Z");
    const parsed = parseSchedulePhrase("in 30 minutes check my system status", now);

    expect(parsed!.at.toISOString()).toBe("2026-09-22T09:30:00.000Z");
  });

  it("T4. a named day that has already passed is refused, not rolled forward", () => {
    const now = new Date("2026-09-22T14:30:00.000Z"); // 20:00 IST — 6 PM is gone
    expect(parseSchedulePhrase("today at 6 pm check my system status", now)).toBeNull();
  });

  it("T5. a bare clock time that has passed means tomorrow, as a person means it", () => {
    const now = new Date("2026-09-22T14:30:00.000Z"); // 20:00 IST
    const parsed = parseSchedulePhrase("at 6 pm check my system status", now);

    // 18:00 IST the next day = 12:30Z on the 23rd.
    expect(parsed!.at.toISOString()).toBe("2026-09-23T12:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Chat integration — SCHEDULE without disturbing EXECUTE or PLAN_ONLY
// ---------------------------------------------------------------------------

describe("Scheduler V1 — conversational scheduling", () => {
  it("recognises an explicit future time as SCHEDULE", () => {
    const now = new Date("2026-09-22T03:30:00.000Z"); // 09:00 IST
    for (const message of [
      "Tomorrow at 10 AM check my system status",
      "At 5 PM check the weather in Balaghat",
      "In 30 minutes check my system status",
      "Kal 5 baje system status check karo",
    ]) {
      const detected = detectWorkRequest(message, now);
      expect(detected.type, message).toBe("SCHEDULE");
      if (detected.type !== "SCHEDULE") continue;
      expect(detected.at.getTime(), message).toBeGreaterThan(now.getTime());
    }
  });

  it("refuses to turn a vague word into a time", () => {
    const now = new Date("2026-09-22T03:30:00.000Z"); // 09:00 IST
    for (const message of [
      "Check my system status later",
      "Check my system status sometime",
      "Check my system status soon",
      "Baad mein system status check karo",
    ]) {
      expect(detectWorkRequest(message, now).type, message).toBe("NEEDS_TIME");
    }
  });

  it("U. an imperative with no time still executes immediately", async () => {
    const now = new Date("2026-09-22T03:30:00.000Z"); // 09:00 IST
    expect(detectWorkRequest("Check my system status.", now).type).toBe("EXECUTE");

    const h = harness();
    const result = await h.conversation.handle({
      userId: ALICE,
      role: ROLE,
      goal: "Check my system status.",
      planOnly: false,
    });

    expect(h.status.calls).toBe(1);
    expect(h.store.rows.get(result.taskId)!.status).toBe("COMPLETED");
    expect(h.store.rows.get(result.taskId)!.scheduledAt).toBeNull();
  });

  it("V. plan-only still plans and runs nothing", async () => {
    const now = new Date("2026-09-22T03:30:00.000Z"); // 09:00 IST
    expect(detectWorkRequest("Check my system status, plan banao execute mat karo", now).type).toBe(
      "PLAN_ONLY"
    );

    const h = harness();
    const result = await h.conversation.handle({
      userId: ALICE,
      role: ROLE,
      goal: "Check my system status, plan banao execute mat karo",
      planOnly: true,
    });

    expect(h.status.calls).toBe(0);
    expect(h.executeTaskSpy).not.toHaveBeenCalled();
    expect(h.store.rows.get(result.taskId)!.status).toBe("PENDING");
  });

  it("a question is still never a work request, with or without a clock in it", () => {
    const now = new Date("2026-09-22T03:30:00.000Z"); // 09:00 IST
    for (const message of [
      "What is blockchain?",
      "How do I check a website at 10 am?",
      "Kya 5 baje report ready hoti hai?",
      "I was reading about web.fetch today",
    ]) {
      expect(detectWorkRequest(message, now).type, message).toBe("NONE");
    }
  });

  it("says so, and schedules nothing, when the planner cannot carry the work out", async () => {
    const h = harness(PLAN_NONE);

    const result = await h.conversation.handle({
      userId: ALICE,
      role: ROLE,
      goal: "Tomorrow at 10 AM do something impossible",
      planOnly: false,
      scheduledAt: IN_AN_HOUR(),
    });

    // Found out NOW, while the user can still rephrase.
    expect(result.scheduledAt).toBeUndefined();
    expect(h.store.rows.get(result.taskId)!.scheduledAt).toBeNull();
    expect(result.message).toMatch(/cannot carry it out/i);
  });
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

describe("Scheduler V1 — the interval loop", () => {
  it("sweeps immediately at start and then on each interval", async () => {
    vi.useFakeTimers();
    const lifecycle = new ShutdownLifecycle();
    const runDue = vi.fn().mockResolvedValue([]);

    const loop = startTaskSchedulerLoop({
      scheduler: { runDue },
      lifecycle,
      intervalMs: 60_000,
      log: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    // The immediate first sweep is the restart story.
    expect(runDue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDue).toHaveBeenCalledTimes(2);

    await loop.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(runDue).toHaveBeenCalledTimes(2);
  });

  it("never starts a second sweep while one is in flight", async () => {
    vi.useFakeTimers();
    const lifecycle = new ShutdownLifecycle();
    const gate: { release?: () => void } = {};
    const runDue = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.release = () => resolve([]);
        })
    );

    const loop = startTaskSchedulerLoop({
      scheduler: { runDue },
      lifecycle,
      intervalMs: 1_000,
      log: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runDue).toHaveBeenCalledTimes(1);

    gate.release!();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runDue).toHaveBeenCalledTimes(2);

    gate.release!();
    await loop.stop();
  });

  it("keeps ticking after a sweep throws", async () => {
    vi.useFakeTimers();
    const lifecycle = new ShutdownLifecycle();
    const runDue = vi
      .fn()
      .mockRejectedValueOnce(new Error("database went away"))
      .mockResolvedValue([]);
    const logged: string[] = [];

    const loop = startTaskSchedulerLoop({
      scheduler: { runDue },
      lifecycle,
      intervalMs: 1_000,
      log: (_level, event) => logged.push(event),
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(runDue).toHaveBeenCalledTimes(2);
    expect(logged).toContain("task_scheduler_sweep_error");
    await loop.stop();
  });

  it("does nothing at all when the interval is zero", async () => {
    vi.useFakeTimers();
    const lifecycle = new ShutdownLifecycle();
    const runDue = vi.fn().mockResolvedValue([]);
    const logged: string[] = [];

    const loop = startTaskSchedulerLoop({
      scheduler: { runDue },
      lifecycle,
      intervalMs: 0,
      log: (_level, event) => logged.push(event),
    });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(runDue).not.toHaveBeenCalled();
    expect(logged).toContain("task_scheduler_disabled");
    await loop.stop();
  });

  it("stops starting sweeps once shutdown begins", async () => {
    vi.useFakeTimers();
    const lifecycle = new ShutdownLifecycle();
    const runDue = vi.fn().mockResolvedValue([]);

    const loop = startTaskSchedulerLoop({
      scheduler: { runDue },
      lifecycle,
      intervalMs: 1_000,
      log: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runDue).toHaveBeenCalledTimes(1);

    lifecycle.beginDraining("test");
    await vi.advanceTimersByTimeAsync(10_000);

    // A scheduled run reaches real tools, so draining must not start one.
    expect(runDue).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it("drives real due work end to end", async () => {
    const h = harness();
    const task = await h.workTask();
    await h.scheduler.scheduleTask(ALICE, task.id, IN_AN_HOUR());
    h.advance(minutes(60));

    const lifecycle = new ShutdownLifecycle();
    const loop = startTaskSchedulerLoop({
      scheduler: h.scheduler,
      lifecycle,
      intervalMs: 60_000,
      log: () => {},
    });

    await loop.sweep();
    await loop.stop();

    expect(h.status.calls).toBe(1);
    expect(h.store.rows.get(task.id)!.status).toBe("COMPLETED");
  });
});
