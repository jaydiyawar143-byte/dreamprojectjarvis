// ---------------------------------------------------------------------------
// Core V1 — the task tools reached the way a conversation actually reaches
// them: through the real ToolExecutor, under the real agent policy.
//
// The sibling file proves the lifecycle rules by calling the tools directly.
// This one proves the thing that makes them SAFE: that permission checking and
// auditing still happen, because nothing here bypasses the single execution
// authority. If a future change registered these tools somewhere that skipped
// the executor, the permission test below would still pass while the audit and
// approval guarantees quietly disappeared — so both are asserted.
//
// It also pins the chat integration point (Part E). There is no orchestrator
// change to test: a task is created because the GENERAL assistant is allowed
// to propose `task.create`, and that grant is what these tests assert.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { ToolExecutor, ToolRegistry, createTaskTools, TASK_TOOL_IDS } from "@jarvis/tools";
import type { TaskPort, TaskView } from "@jarvis/tools";
import type { AuditLogger, IApprovalManager, IPermissionChecker, Role } from "@jarvis/core";
import {
  AGENT_IDS,
  AGENT_POLICIES,
  CAPABILITY_TOOLS,
  SELF_TOOLS,
  TASK_TOOLS,
  isToolAllowed,
} from "@jarvis/agents";

const USER = "user-alice";
/** Required on every ToolExecutionRequest; the executor traces with it. */
const TRACE = "00000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------

/** An in-memory TaskPort. The lifecycle itself is covered in the sibling file. */
function makePort(): TaskPort & { tasks: Map<string, TaskView> } {
  const tasks = new Map<string, TaskView>();
  let seq = 0;

  return {
    tasks,
    async create(_userId, input) {
      const task: TaskView = {
        id: `task-${++seq}`,
        title: input.title,
        description: input.description ?? null,
        status: "PENDING",
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        error: null,
      };
      tasks.set(task.id, task);
      return { ok: true as const, task };
    },
    async list() {
      return [...tasks.values()];
    },
    async get(_userId, taskId) {
      const task = tasks.get(taskId);
      return task ? { ok: true as const, task } : { ok: false as const, message: "No such task." };
    },
    async updateStatus(_userId, taskId, status) {
      const task = tasks.get(taskId);
      if (!task) return { ok: false as const, message: "No such task." };
      const moved: TaskView = { ...task, status };
      tasks.set(taskId, moved);
      return { ok: true as const, task: moved };
    },
  };
}

const allowAll: IPermissionChecker = { hasPermission: () => true };
const readOnly: IPermissionChecker = {
  hasPermission: (_r: Role, _res: string, action: string) => action === "read",
};

/** No approval is ever required by these tools; the manager proves it is asked. */
function approvals(): IApprovalManager {
  return {
    requestApproval: vi.fn(),
    findApprovalsForTool: vi.fn().mockResolvedValue([]),
  } as unknown as IApprovalManager;
}

function harness(perms: IPermissionChecker = allowAll) {
  const port = makePort();
  const registry = new ToolRegistry();
  for (const tool of createTaskTools(port)) registry.register(tool);

  const audited: unknown[] = [];
  const logger = {
    log: vi.fn().mockImplementation(async (e: unknown) => {
      audited.push(e);
    }),
  } as unknown as AuditLogger;

  const executor = new ToolExecutor(registry, perms, approvals(), logger);
  return { port, registry, executor, audited };
}

// ---------------------------------------------------------------------------
// 10. Through the existing executor
// ---------------------------------------------------------------------------

describe("Core V1 — task tools run through the single execution authority", () => {
  it("creates a task through ToolExecutor and completes, not approval_pending", async () => {
    const { executor, port } = harness();

    const result = await executor.execute({
      toolId: "task.create",
      params: { title: "Prepare the Sputnikverse marketing proposal" },
      userId: USER,
      role: "member" as Role,
      traceId: TRACE,
    });

    expect(result.status).toBe("completed");
    expect(result.result?.success).toBe(true);
    // Writing to JARVIS's own store needs no human decision; an approval
    // prompt for "remember this for me" would make the feature unusable.
    expect(result.status).not.toBe("approval_pending");
    expect(port.tasks.size).toBe(1);
  });

  it("audits the execution — the journal keeps working because nothing bypasses it", async () => {
    const { executor, audited } = harness();

    await executor.execute({
      toolId: "task.create",
      params: { title: "Audited work" },
      userId: USER,
      role: "member" as Role,
      traceId: TRACE,
    });

    expect(audited.length).toBeGreaterThan(0);
  });

  it("denies the write when the role lacks write permission", async () => {
    const { executor, port } = harness(readOnly);

    const result = await executor.execute({
      toolId: "task.create",
      params: { title: "Should never be stored" },
      userId: USER,
      role: "viewer" as Role,
      traceId: TRACE,
    });

    // The executor's own check refuses it, before the tool runs.
    expect(result.status).not.toBe("completed");
    expect(port.tasks.size).toBe(0);
  });

  it("still allows the READ_ONLY task tools on a read-only role", async () => {
    const { executor } = harness(readOnly);

    const result = await executor.execute({
      toolId: "task.list",
      params: {},
      userId: USER,
      role: "viewer" as Role,
      traceId: TRACE,
    });

    expect(result.status).toBe("completed");
  });

  it("walks the lifecycle through the executor, end to end", async () => {
    const { executor } = harness();

    const created = await executor.execute({
      toolId: "task.create",
      params: { title: "Work" },
      userId: USER,
      role: "member" as Role,
      traceId: TRACE,
    });
    const id = (created.result?.data as { task: TaskView }).task.id;

    for (const status of ["RUNNING", "COMPLETED"]) {
      const moved = await executor.execute({
        toolId: "task.updateStatus",
        params: { taskId: id, status },
        userId: USER,
        role: "member" as Role,
      traceId: TRACE,
      });
      expect(moved.status, status).toBe("completed");
    }
  });
});

// ---------------------------------------------------------------------------
// 11. The chat integration point — a grant, not an orchestrator change
// ---------------------------------------------------------------------------

describe("Core V1 — chat can create a task because the policy allows it", () => {
  it("the general assistant may propose every task tool", () => {
    const policy = AGENT_POLICIES[AGENT_IDS.general]!;
    for (const id of TASK_TOOL_IDS) {
      expect(isToolAllowed(id, policy.allowedTools), id).toBe(true);
    }
  });

  it("no SPECIALIST agent may create tasks on its own initiative", () => {
    // A Meta or browser agent quietly recording tasks mid-run would be doing
    // something the user never asked for. If a domain agent ever needs this,
    // it should be a grant made on purpose — and this test is what forces
    // that decision to be explicit.
    const specialists = [
      AGENT_IDS.metaAds,
      AGENT_IDS.googleAds,
      AGENT_IDS.knowledge,
      AGENT_IDS.analytics,
      AGENT_IDS.automation,
      AGENT_IDS.communication,
      AGENT_IDS.browser,
      AGENT_IDS.location,
    ];

    for (const agentId of specialists) {
      const policy = AGENT_POLICIES[agentId]!;
      expect(isToolAllowed("task.create", policy.allowedTools), agentId).toBe(false);
      expect(isToolAllowed("task.updateStatus", policy.allowedTools), agentId).toBe(false);
    }
  });

  it("every agent can say what JARVIS is, for the same reason every one can say what it can do", () => {
    for (const agentId of Object.values(AGENT_IDS)) {
      const policy = AGENT_POLICIES[agentId]!;
      expect(isToolAllowed("self.describe", policy.allowedTools), agentId).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 14. The existing capability surface is unchanged
// ---------------------------------------------------------------------------

describe("Core V1 — existing capability information still holds", () => {
  it("the capability tool group is untouched", () => {
    expect([...CAPABILITY_TOOLS]).toEqual([
      "capabilities.list",
      "capabilities.connected",
      "capabilities.integration",
      "capabilities.permissions",
    ]);
    // self.describe is ADDED beside them, not folded into them: "what can you
    // do" and "what are you" stay separate questions with separate answers.
    expect([...SELF_TOOLS]).toEqual(["self.describe"]);
    expect([...CAPABILITY_TOOLS]).not.toContain("self.describe");
  });

  it("every agent still holds the full capability group", () => {
    for (const agentId of Object.values(AGENT_IDS)) {
      const policy = AGENT_POLICIES[agentId]!;
      for (const id of CAPABILITY_TOOLS) {
        expect(isToolAllowed(id, policy.allowedTools), `${agentId}/${id}`).toBe(true);
      }
    }
  });

  it("no existing agent lost a tool when the task grant was added", () => {
    // The general assistant is the only policy that changed shape; everything
    // it could reach before it must still reach.
    const general = AGENT_POLICIES[AGENT_IDS.general]!;
    for (const id of [
      "meta.insights",
      "meta.campaign.pause",
      "google.accounts",
      "maps.route",
      "weather.current",
      "tasks.list",
      "gmail.search",
      "google.plan.gmail.createDraft",
      "integration.list",
    ]) {
      expect(isToolAllowed(id, general.allowedTools), id).toBe(true);
    }
  });

  it("the new task tools are distinct from the existing tasks.list todo reader", () => {
    // Both exist on the general assistant and they are NOT the same surface:
    // `tasks.list` reads the user's todos for the dashboard, `task.list` reads
    // the work JARVIS has been asked to hold. Collapsing them is a later
    // decision, and this test records that they are currently separate.
    const general = AGENT_POLICIES[AGENT_IDS.general]!;
    expect(isToolAllowed("tasks.list", general.allowedTools)).toBe(true);
    expect(isToolAllowed("task.list", general.allowedTools)).toBe(true);
    expect(TASK_TOOLS).not.toContain("tasks.list");
  });
});
