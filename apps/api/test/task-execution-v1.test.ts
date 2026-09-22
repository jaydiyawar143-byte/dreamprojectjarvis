// ---------------------------------------------------------------------------
// Task Execution V1 — PENDING -> RUNNING -> ToolExecutor -> COMPLETED/FAILED.
//
// THE REAL EXECUTOR RUNS IN EVERY TEST HERE. `TaskExecutionService` is given a
// genuine `ToolExecutor` over a genuine `ToolRegistry`, with the real
// permission and approval interfaces attached. The only doubles are at the
// edges the executor itself treats as external: the tool's own side effect,
// the permission table, the approval store, the audit sink and the task rows.
//
// That matters because the property under test is "execution cannot skip the
// safety layer". A fake executor would assert that the service calls something
// named `execute`; the real one asserts that a task cannot reach a tool
// without passing the permission check and the approval gate.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { ToolExecutor, ToolRegistry, BaseTool } from "@jarvis/tools";
import type {
  AuditLogger,
  IApprovalManager,
  IPermissionChecker,
  Role,
  ToolResult,
  TaskStatus,
} from "@jarvis/core";
import { JARVIS_TASK_CREATOR } from "@jarvis/core";
import { TaskService } from "../src/services/tasks/task-service.js";
import { TaskExecutionService } from "../src/services/tasks/task-execution-service.js";
import type { TaskRecord } from "@jarvis/db";

const ALICE = "user-alice";
const BOB = "user-bob";
const ROLE: Role = "owner";

// ---------------------------------------------------------------------------
// Tools — real BaseTool subclasses, so the registry and executor see the same
// shape production registers.
// ---------------------------------------------------------------------------

/** A harmless READ_ONLY tool that records that it ran. */
class EchoTool extends BaseTool {
  public calls = 0;
  constructor() {
    super("system.echo", "Echo", "Echoes back.", "system", [], false, ["read"], "READ_ONLY");
  }
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    this.calls += 1;
    return this.success({ echoed: params.message ?? null });
  }
}

/** A READ_ONLY tool that fails, to drive the FAILED branch. */
class FailingTool extends BaseTool {
  public calls = 0;
  constructor() {
    super("system.fail", "Fail", "Always fails.", "system", [], false, ["read"], "READ_ONLY");
  }
  async execute(): Promise<ToolResult> {
    this.calls += 1;
    return this.failure("The provider refused the request.");
  }
}

/** An approval-gated write, to prove the gate still stands in front of tasks. */
class GatedWriteTool extends BaseTool {
  public calls = 0;
  constructor() {
    super(
      "system.gatedWrite",
      "Gated Write",
      "A write that needs approval.",
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

/** A write tool used to prove the permission check is not bypassed. */
class WriteTool extends BaseTool {
  public calls = 0;
  constructor() {
    super("system.write", "Write", "A write.", "system", [], false, ["read", "write"], "LOW_IMPACT");
  }
  async execute(): Promise<ToolResult> {
    this.calls += 1;
    return this.success({ wrote: true });
  }
}

// ---------------------------------------------------------------------------
// Task store — the same faithful fake the Core V1 suites use: userId filter
// and compare-and-set on status, exactly as the WHERE clauses express them.
// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;

  return {
    rows,
    async create(
      userId: string,
      input: { title: string; description?: string | null; createdBy?: string | null }
    ) {
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
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
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
      const row = rows.get(taskId);
      return row && row.userId === userId ? row : null;
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
      // Compare-and-set: the loser of a race matches nothing.
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
      row.updatedAt = new Date();
      return { ok: true as const, task: row };
    },
  };
}

// ---------------------------------------------------------------------------

const allowAll: IPermissionChecker = { hasPermission: () => true };
const readOnlyRole: IPermissionChecker = {
  hasPermission: (_r: Role, _res: string, action: string) => action === "read",
};

/** A real-shaped approval manager: nothing approved, so gates hold. */
function approvals(): IApprovalManager {
  return {
    requestApproval: vi.fn().mockResolvedValue({ id: "approval-1", status: "pending" }),
    findApprovalsForTool: vi.fn().mockResolvedValue([]),
  } as unknown as IApprovalManager;
}

function harness(perms: IPermissionChecker = allowAll) {
  const store = makeStore();
  const taskService = new TaskService({ tasks: store });

  const echo = new EchoTool();
  const failing = new FailingTool();
  const gated = new GatedWriteTool();
  const write = new WriteTool();

  const registry = new ToolRegistry();
  for (const tool of [echo, failing, gated, write]) registry.register(tool);

  const audited: unknown[] = [];
  const auditLogger = {
    log: vi.fn().mockImplementation(async (e: unknown) => {
      audited.push(e);
    }),
  } as unknown as AuditLogger;

  // THE REAL EXECUTOR.
  const executor = new ToolExecutor(registry, perms, approvals(), auditLogger);

  const execution = new TaskExecutionService({
    tasks: taskService,
    executor,
    allowedToolIds: new Set(["system.echo", "system.fail", "system.gatedWrite", "system.write"]),
  });

  async function pendingTask(userId = ALICE) {
    const created = await taskService.createTask(userId, {
      title: "Prepare the Sputnikverse proposal",
      createdBy: JARVIS_TASK_CREATOR,
    });
    if (!created.ok) throw new Error("setup failed");
    return created.task;
  }

  return { store, taskService, execution, executor, echo, failing, gated, write, audited, pendingTask };
}

const run = (h: ReturnType<typeof harness>, taskId: string, toolId = "system.echo", userId = ALICE) =>
  h.execution.executeTask(userId, taskId, { toolId, params: { message: "hi" }, role: ROLE });

// ---------------------------------------------------------------------------
// A + B — the happy path
// ---------------------------------------------------------------------------

describe("Task Execution V1 — a PENDING task runs once and completes", () => {
  it("A. claims a PENDING task and executes it through the real ToolExecutor", async () => {
    const h = harness();
    const task = await h.pendingTask();

    const outcome = await run(h, task.id);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The real tool actually ran.
    expect(h.echo.calls).toBe(1);
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.execution.executionId).toBeTruthy();
  });

  it("B. PENDING -> RUNNING -> COMPLETED, with both timestamps stamped", async () => {
    const h = harness();
    const task = await h.pendingTask();
    expect(task.status).toBe("PENDING");

    const outcome = await run(h, task.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.task.status).toBe("COMPLETED");
    // RUNNING really happened: startTask stamped it on the way through.
    expect(outcome.task.startedAt).not.toBeNull();
    expect(outcome.task.completedAt).not.toBeNull();
    expect(outcome.task.error).toBeNull();
  });

  it("audits the execution — a task run is journalled like any other tool call", async () => {
    const h = harness();
    const task = await h.pendingTask();
    await run(h, task.id);
    expect(h.audited.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C — failure
// ---------------------------------------------------------------------------

describe("Task Execution V1 — a failed run is recorded, not hidden", () => {
  it("C. PENDING -> RUNNING -> FAILED, and the reason is persisted", async () => {
    const h = harness();
    const task = await h.pendingTask();

    const outcome = await run(h, task.id, "system.fail");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(h.failing.calls).toBe(1);
    expect(outcome.task.status).toBe("FAILED");
    expect(outcome.task.error).toContain("The provider refused the request.");
    // A failed task is finished but NOT done — the widget must not tick it.
    expect(outcome.task.completedAt).toBeNull();
    // It still ran, so RUNNING was real.
    expect(outcome.task.startedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D + E + F — terminal and in-flight tasks
// ---------------------------------------------------------------------------

describe("Task Execution V1 — a task runs at most once", () => {
  it("D. a COMPLETED task cannot execute again", async () => {
    const h = harness();
    const task = await h.pendingTask();
    await run(h, task.id);
    expect(h.echo.calls).toBe(1);

    const again = await run(h, task.id);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal).toBe("NOT_EXECUTABLE");
    expect(again.message).toMatch(/completed/i);
    // The executor was never reached a second time.
    expect(h.echo.calls).toBe(1);
  });

  it("E. a FAILED task does not automatically execute again in V1", async () => {
    const h = harness();
    const task = await h.pendingTask();
    await run(h, task.id, "system.fail");
    expect(h.failing.calls).toBe(1);

    const again = await run(h, task.id, "system.fail");

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal).toBe("NOT_EXECUTABLE");
    // No retry system in V1: the tool is not called a second time.
    expect(h.failing.calls).toBe(1);
  });

  it("F. a RUNNING task cannot execute again", async () => {
    const h = harness();
    const task = await h.pendingTask();
    // Claim it the way the service would, through TaskService.
    await h.taskService.startTask(ALICE, task.id);

    const outcome = await run(h, task.id);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe("NOT_EXECUTABLE");
    expect(h.echo.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G — ownership
// ---------------------------------------------------------------------------

describe("Task Execution V1 — a task is not a way into someone else's work", () => {
  it("G. user A cannot execute user B's task", async () => {
    const h = harness();
    const bobTask = await h.pendingTask(BOB);

    const outcome = await run(h, bobTask.id, "system.echo", ALICE);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Indistinguishable from "no such task": a distinct answer would confirm
    // that Bob's task exists.
    expect(outcome.refusal).toBe("NOT_FOUND");
    expect(outcome.message).toBe("No such task.");
    expect(h.echo.calls).toBe(0);
    // And Bob's task is untouched.
    expect(h.store.rows.get(bobTask.id)!.status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// H — concurrency
// ---------------------------------------------------------------------------

describe("Task Execution V1 — two callers cannot both run one task", () => {
  it("H. concurrent executions invoke the ToolExecutor exactly once", async () => {
    const h = harness();
    const task = await h.pendingTask();

    const [first, second] = await Promise.all([run(h, task.id), run(h, task.id)]);

    // Exactly one winner.
    const winners = [first, second].filter((r) => r.ok);
    const losers = [first, second].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // And the tool ran exactly once — the loser never reached the executor.
    expect(h.echo.calls).toBe(1);

    const loser = losers[0]!;
    if (loser.ok) return;
    expect(["ALREADY_CLAIMED", "NOT_EXECUTABLE"]).toContain(loser.refusal);
    expect(h.store.rows.get(task.id)!.status).toBe("COMPLETED");
  });

  it("H2. the loser's refusal is deterministic, not an exception", async () => {
    const h = harness();
    const task = await h.pendingTask();
    await h.taskService.startTask(ALICE, task.id);

    // Claimed already: the second caller gets a structured answer.
    const outcome = await run(h, task.id);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(typeof outcome.message).toBe("string");
    expect(outcome.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// I + J — the safety layer is not bypassed
// ---------------------------------------------------------------------------

describe("Task Execution V1 — a task is not a privilege-escalation path", () => {
  it("I. a permission failure is not bypassed; the task fails instead", async () => {
    // The caller's role may only read. The write tool must not run.
    const h = harness(readOnlyRole);
    const task = await h.pendingTask();

    const outcome = await h.execution.executeTask(ALICE, task.id, {
      toolId: "system.write",
      params: {},
      role: "viewer" as Role,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The REAL executor refused it.
    expect(outcome.execution.status).toBe("permission_denied");
    expect(h.write.calls).toBe(0);
    // And the task records the refusal rather than claiming success.
    expect(outcome.task.status).toBe("FAILED");
  });

  it("J. an approval-required tool stays approval-required when run from a task", async () => {
    const h = harness();
    const task = await h.pendingTask();

    const outcome = await h.execution.executeTask(ALICE, task.id, {
      toolId: "system.gatedWrite",
      params: {},
      role: ROLE,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The gate held: the executor returned approval_pending and the tool's own
    // side effect never happened.
    expect(outcome.execution.status).toBe("approval_pending");
    expect(h.gated.calls).toBe(0);
    // V1 has no PENDING_APPROVAL state, so the task is FAILED — with a message
    // that says what to do rather than just "failed".
    expect(outcome.task.status).toBe("FAILED");
    expect(outcome.task.error).toMatch(/needs your approval/i);
    expect(outcome.task.error).toMatch(/Approvals page/i);
  });

  it("I2. a tool no agent policy grants cannot be reached through a task", async () => {
    const h = harness();
    const task = await h.pendingTask();

    const outcome = await h.execution.executeTask(ALICE, task.id, {
      toolId: "system.echo",
      params: {},
      role: ROLE,
    });
    expect(outcome.ok).toBe(true);

    // A second task, naming a tool outside the allowlist.
    const other = await h.pendingTask();
    const refused = await h.execution.executeTask(ALICE, other.id, {
      toolId: "meta.campaign.create",
      params: {},
      role: ROLE,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal).toBe("TOOL_NOT_ALLOWED");
    // Refused BEFORE the claim, so the task is not stranded in RUNNING.
    expect(h.store.rows.get(other.id)!.status).toBe("PENDING");
  });

  it("I3. an unregistered tool fails through the executor, not around it", async () => {
    const h = harness();
    const task = await h.pendingTask();

    // In the allowlist but not in the registry: the SAME real executor is
    // what refuses, so this proves the refusal comes from the safety layer
    // rather than from a check this service makes for itself.
    const execution = new TaskExecutionService({
      tasks: h.taskService,
      executor: h.executor,
      allowedToolIds: new Set(["system.ghost"]),
    });

    const outcome = await execution.executeTask(ALICE, task.id, {
      toolId: "system.ghost",
      params: {},
      role: ROLE,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.task.status).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// K + L — the lifecycle is still the only way state moves
// ---------------------------------------------------------------------------

describe("Task Execution V1 — lifecycle ownership is unchanged", () => {
  it("K. every state change goes through TaskService, never a direct write", async () => {
    const h = harness();
    const task = await h.pendingTask();

    const start = vi.spyOn(h.taskService, "startTask");
    const complete = vi.spyOn(h.taskService, "completeTask");

    await run(h, task.id);

    expect(start).toHaveBeenCalledWith(ALICE, task.id);
    expect(complete).toHaveBeenCalledWith(ALICE, task.id);
  });

  it("K2. a failed run settles through TaskService.failTask", async () => {
    const h = harness();
    const task = await h.pendingTask();
    const failSpy = vi.spyOn(h.taskService, "failTask");

    await run(h, task.id, "system.fail");

    expect(failSpy).toHaveBeenCalled();
    expect(failSpy.mock.calls[0]![0]).toBe(ALICE);
    expect(failSpy.mock.calls[0]![1]).toBe(task.id);
  });

  it("L. the Core V1.1 RUNNING guard still holds during an execution", async () => {
    const h = harness();
    const task = await h.pendingTask();
    await h.taskService.startTask(ALICE, task.id);

    // The transition rules still refuse an illegal move on a running task,
    // regardless of execution: RUNNING may only become COMPLETED or FAILED.
    const restart = await h.taskService.startTask(ALICE, task.id);
    expect(restart.ok).toBe(false);
    if (restart.ok) return;
    expect(restart.reason).toBe("INVALID_TRANSITION");

    // And the lifecycle path still settles it properly.
    const done = await h.taskService.completeTask(ALICE, task.id);
    expect(done.ok).toBe(true);
  });
});
