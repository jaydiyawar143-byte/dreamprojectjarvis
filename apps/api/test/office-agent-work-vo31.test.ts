// ---------------------------------------------------------------------------
// VO-3.1 — tasks are assigned to agents, and the office reads it back.
//
// What is pinned here:
//
//   * a run records its agent and its tool in the same write as
//     PENDING -> RUNNING, and the EXECUTOR never sees that agent (the audit row
//     carries none): attribution, not authority;
//   * no assigner, no assignment (behaviour before VO-3.1); an assigner that
//     finds no agent records null (JARVIS system work);
//   * a scheduled task is assigned with its schedule, a cancelled schedule
//     clears it, and schedule, cancel and claim are announced to the office;
//   * the conversation assigns scheduled work, never plan-only work;
//   * the office task event carries agentId and toolId and still no title or
//     error, and the wire reader keeps exactly those;
//   * the per-agent read: RUNNING beats claimed beats queued, the newer of
//     FAILED/UNRESOLVED, approvals by agent with expired and agentless ones
//     ignored, approvals that cannot be read reported as unread;
//   * every read is the CALLER's: another user's work never appears, and the
//     route takes the user from the token, never from the request.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import type { Router, Response } from "express";
import { ToolExecutor, ToolRegistry, BaseTool } from "@jarvis/tools";
import {
  JARVIS_TASK_CREATOR,
  officeTaskEvent,
  parseOfficeStreamEvent,
  type AuditLogger,
  type IApprovalManager,
  type ITokenService,
  type TaskStatus,
  type ToolResult,
} from "@jarvis/core";
import type { AgentWorkRows, TaskRecord } from "@jarvis/db";

import { TaskService } from "../src/services/tasks/task-service.js";
import { TaskExecutionService } from "../src/services/tasks/task-execution-service.js";
import { TaskSchedulerService } from "../src/services/tasks/task-scheduler-service.js";
import { TaskConversationService } from "../src/services/tasks/task-conversation-service.js";
import { OfficeAgentWorkService } from "../src/services/office/agent-work-service.js";
import { createOfficeRouter } from "../src/routes/office.js";
import type { Container } from "../src/services/container.js";
import { countTaskRows } from "./helpers/count-task-rows.js";

const ALICE = "user-alice";
const BOB = "user-bob";
const TOKEN_ALICE = "token-alice";
const TOKEN_BOB = "token-bob";

class ReadTool extends BaseTool {
  constructor() {
    super("knowledge.search", "Search", "Searches.", "research", [], false, ["read"], "READ_ONLY");
  }
  async execute(): Promise<ToolResult> {
    return this.success({ found: 1 });
  }
}

class BrokenTool extends BaseTool {
  constructor() {
    super("maps.route", "Route", "Routes.", "system", [], false, ["read"], "READ_ONLY");
  }
  async execute(): Promise<ToolResult> {
    return this.failure("The provider refused the request.");
  }
}

// ---------------------------------------------------------------------------
// An in-memory repository with the VO-3.1 columns.
// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;
  let clock = Date.UTC(2026, 10, 13, 9, 0, 0);
  const tick = () => new Date((clock += 1000));

  const store = {
    rows,
    async create(userId: string, input: { title: string; description?: string | null; createdBy?: string | null }) {
      const now = tick();
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
        agentId: null,
        assignedAt: null,
        toolId: null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
    },
    async list(userId: string) {
      return [...rows.values()].filter((r) => r.userId === userId);
    },
    async listByStatus(userId: string, status: TaskStatus) {
      return [...rows.values()].filter((r) => r.userId === userId && r.status === status);
    },
    async countByStatus(userId: string, options: { createdBy?: string } = {}) {
      return countTaskRows(rows.values(), userId, options);
    },
    async findOwned(userId: string, taskId: string) {
      const row = rows.get(taskId);
      return row && row.userId === userId ? { ...row } : null;
    },
    async transitionOwned(
      userId: string,
      taskId: string,
      expectedFrom: TaskStatus,
      to: TaskStatus,
      options: {
        error?: string | null;
        executionId?: string;
        agentId?: string | null;
        toolId?: string;
        assign?: boolean;
      } = {}
    ) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) return { ok: false as const, reason: "not_found" as const, current: null };
      if (row.status !== expectedFrom) {
        return { ok: false as const, reason: "state_changed" as const, current: row.status };
      }
      const now = tick();
      row.status = to;
      if (options.executionId !== undefined) row.executionId = options.executionId;
      if (options.agentId !== undefined) row.agentId = options.agentId;
      if (options.toolId !== undefined) row.toolId = options.toolId;
      if (options.assign && options.agentId) row.assignedAt = now;
      if (to === "RUNNING") row.startedAt = now;
      if (to === "COMPLETED") row.completedAt = now;
      if (to === "FAILED") row.error = options.error ?? null;
      row.updatedAt = now;
      return { ok: true as const, task: { ...row } };
    },
    async setScheduleOwned(
      userId: string,
      taskId: string,
      createdBy: string,
      scheduledAt: Date | null,
      options: { agentId?: string | null } = {}
    ) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId || row.createdBy !== createdBy || row.status !== "PENDING") return null;
      row.scheduledAt = scheduledAt;
      if (scheduledAt === null) {
        row.agentId = null;
        row.assignedAt = null;
      } else if (options.agentId !== undefined) {
        row.agentId = options.agentId;
        row.assignedAt = options.agentId ? tick() : null;
      }
      row.updatedAt = tick();
      return { ...row };
    },
    async findDueScheduled(createdBy: string, now: Date) {
      return [...rows.values()].filter(
        (r) => r.createdBy === createdBy && r.status === "PENDING" && r.scheduledAt && r.scheduledAt <= now && !r.claimedAt
      );
    },
    async claimSchedule(taskId: string, createdBy: string, claimedAt: Date) {
      const row = rows.get(taskId);
      if (!row || row.createdBy !== createdBy || row.status !== "PENDING" || !row.scheduledAt || row.claimedAt) return false;
      row.claimedAt = claimedAt;
      row.updatedAt = tick();
      return true;
    },
    async findOrphanedClaims() {
      return [];
    },
    async recoverClaim() {
      return false;
    },
    async findStaleRunning() {
      return [];
    },
    async agentWork(userId: string, options: { createdBy?: string } = {}): Promise<AgentWorkRows> {
      const mine = [...rows.values()].filter(
        (r) => r.userId === userId && r.agentId && (options.createdBy === undefined || r.createdBy === options.createdBy)
      );
      const active = mine.filter((r) => r.status === "PENDING" || r.status === "RUNNING");
      const latest = new Map<string, TaskRecord>();
      for (const r of mine.filter((r) => ["COMPLETED", "FAILED", "UNRESOLVED"].includes(r.status))) {
        const key = `${r.agentId}:${r.status}`;
        const seen = latest.get(key);
        if (!seen || r.updatedAt > seen.updatedAt) latest.set(key, r);
      }
      return { active, latest: [...latest.values()] };
    },
  };
  return store;
}

function harness(options: { assign?: (toolId: string) => string | null } = {}) {
  const store = makeStore();
  const announced: TaskRecord[] = [];
  const taskService = new TaskService({ tasks: store, onTaskChanged: (task) => void announced.push({ ...task }) });

  const registry = new ToolRegistry();
  registry.register(new ReadTool());
  registry.register(new BrokenTool());

  const audited: Array<Record<string, unknown>> = [];
  const auditLogger = {
    log: vi.fn().mockImplementation(async (entry: Record<string, unknown>) => void audited.push(entry)),
  } as unknown as AuditLogger;
  const approvals = {
    requestApproval: vi.fn().mockResolvedValue({ id: "approval-1", status: "pending" }),
    findApprovalsForTool: vi.fn().mockResolvedValue([]),
  } as unknown as IApprovalManager;
  const executor = new ToolExecutor(registry, { hasPermission: () => true }, approvals, auditLogger);

  const execution = new TaskExecutionService({
    tasks: taskService,
    executor,
    allowedToolIds: new Set(["knowledge.search", "maps.route"]),
    ...(options.assign ? { assignAgent: options.assign } : {}),
  });

  async function work(userId = ALICE, title = "Look this up") {
    const created = await taskService.createTask(userId, { title, createdBy: JARVIS_TASK_CREATOR });
    if (!created.ok) throw new Error("setup failed");
    return created.task;
  }

  return { store, taskService, execution, audited, announced, work };
}

const POLICY_OWNER: Record<string, string> = {
  "knowledge.search": "knowledge-agent",
  "maps.route": "location-agent",
};
const byPolicy = (toolId: string) => POLICY_OWNER[toolId] ?? null;

// ---------------------------------------------------------------------------

describe("VO-3.1 — a run records its agent and tool, and the executor never sees the agent", () => {
  it("writes agentId, toolId and assignedAt with PENDING -> RUNNING, and keeps them when it completes", async () => {
    const h = harness({ assign: byPolicy });
    const task = await h.work();

    const outcome = await h.execution.executeTask(ALICE, task.id, {
      toolId: "knowledge.search",
      params: {},
      role: "owner",
    });

    expect(outcome.ok).toBe(true);
    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("COMPLETED");
    expect(row.agentId).toBe("knowledge-agent");
    expect(row.toolId).toBe("knowledge.search");
    expect(row.assignedAt).toBeInstanceOf(Date);

    // The RUNNING announcement already carried them: the office hears who and what at the start.
    const running = h.announced.find((t) => t.status === "RUNNING")!;
    expect(running.agentId).toBe("knowledge-agent");
    expect(running.toolId).toBe("knowledge.search");
    expect(running.executionId).toBe(row.executionId);

    // ATTRIBUTION, NOT AUTHORITY: the executor's audit row names no agent.
    const toolRow = h.audited.find((e) => e.action === "tool.execute")!;
    expect(toolRow.agentId).toBeUndefined();
    expect((toolRow.metadata as { executionId: string }).executionId).toBe(row.executionId);
  });

  it("keeps the agent on a failed run, so the failure is that agent's", async () => {
    const h = harness({ assign: byPolicy });
    const task = await h.work();
    await h.execution.executeTask(ALICE, task.id, { toolId: "maps.route", params: {}, role: "owner" });
    const row = h.store.rows.get(task.id)!;
    expect(row.status).toBe("FAILED");
    expect(row.agentId).toBe("location-agent");
    expect(row.error).toContain("provider refused");
  });

  it("records no assignment without an assigner, and null when no agent covers the tool", async () => {
    const without = harness();
    const t1 = await without.work();
    await without.execution.executeTask(ALICE, t1.id, { toolId: "knowledge.search", params: {}, role: "owner" });
    expect(without.store.rows.get(t1.id)!.agentId).toBeNull();
    expect(without.store.rows.get(t1.id)!.toolId).toBe("knowledge.search");

    const nobody = harness({ assign: () => null });
    const t2 = await nobody.work();
    await nobody.execution.executeTask(ALICE, t2.id, { toolId: "knowledge.search", params: {}, role: "owner" });
    expect(nobody.store.rows.get(t2.id)!.agentId).toBeNull();
    expect(nobody.store.rows.get(t2.id)!.assignedAt).toBeNull();
  });

  it("keeps the first assignment time when the agent that runs it is the one it was scheduled for", async () => {
    const h = harness({ assign: byPolicy });
    const task = await h.work();
    await h.store.setScheduleOwned(ALICE, task.id, JARVIS_TASK_CREATOR, new Date("2026-11-13T12:00:00Z"), {
      agentId: "knowledge-agent",
    });
    const assignedAt = h.store.rows.get(task.id)!.assignedAt;

    await h.execution.executeTask(ALICE, task.id, { toolId: "knowledge.search", params: {}, role: "owner" });
    expect(h.store.rows.get(task.id)!.assignedAt).toEqual(assignedAt);

    // A different agent is a new assignment, with a new time.
    const other = await h.work();
    await h.store.setScheduleOwned(ALICE, other.id, JARVIS_TASK_CREATOR, new Date("2026-11-13T12:00:00Z"), {
      agentId: "knowledge-agent",
    });
    const before = h.store.rows.get(other.id)!.assignedAt!;
    await h.execution.executeTask(ALICE, other.id, { toolId: "maps.route", params: {}, role: "owner" });
    expect(h.store.rows.get(other.id)!.agentId).toBe("location-agent");
    expect(h.store.rows.get(other.id)!.assignedAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  it("lets two agents work at once without one changing the other", async () => {
    const h = harness({ assign: byPolicy });
    const a = await h.work(ALICE, "Search");
    const b = await h.work(ALICE, "Route");
    await Promise.all([
      h.execution.executeTask(ALICE, a.id, { toolId: "knowledge.search", params: {}, role: "owner" }),
      h.execution.executeTask(ALICE, b.id, { toolId: "maps.route", params: {}, role: "owner" }),
    ]);
    expect(h.store.rows.get(a.id)).toMatchObject({ agentId: "knowledge-agent", status: "COMPLETED" });
    expect(h.store.rows.get(b.id)).toMatchObject({ agentId: "location-agent", status: "FAILED" });
  });
});

// ---------------------------------------------------------------------------

describe("VO-3.1 — scheduled work is assigned with its schedule", () => {
  function scheduler(h: ReturnType<typeof harness>, now = new Date("2026-11-13T09:00:00Z")) {
    const planner = {
      planTask: vi.fn().mockResolvedValue({ executable: true, toolId: "knowledge.search", params: {}, reason: "ok" }),
    };
    return new TaskSchedulerService({
      tasks: h.store,
      taskService: h.taskService,
      planner: planner as never,
      execution: h.execution,
      now: () => now,
    });
  }

  it("assigns on schedule, announces it, and clears both on cancel", async () => {
    const h = harness({ assign: byPolicy });
    const s = scheduler(h);
    const task = await h.work();
    h.announced.length = 0;

    const scheduled = await s.scheduleTask(ALICE, task.id, new Date("2026-11-13T12:00:00Z"), {
      agentId: "knowledge-agent",
    });
    expect(scheduled.ok).toBe(true);
    expect(h.store.rows.get(task.id)).toMatchObject({ agentId: "knowledge-agent" });
    expect(h.announced.at(-1)).toMatchObject({ id: task.id, agentId: "knowledge-agent", status: "PENDING" });

    const cancelled = await s.cancelScheduledTask(ALICE, task.id);
    expect(cancelled.ok).toBe(true);
    expect(h.store.rows.get(task.id)).toMatchObject({ agentId: null, assignedAt: null, scheduledAt: null });
    expect(h.announced.at(-1)).toMatchObject({ id: task.id, agentId: null });
  });

  it("announces the claim before the run, then runs it as that agent's work", async () => {
    const h = harness({ assign: byPolicy });
    const task = await h.work();
    // Scheduled at 09:00 for noon; swept at one second past noon.
    const scheduled = await scheduler(h).scheduleTask(ALICE, task.id, new Date("2026-11-13T12:00:00Z"), {
      agentId: "knowledge-agent",
    });
    expect(scheduled.ok).toBe(true);
    h.announced.length = 0;

    const outcomes = await scheduler(h, new Date("2026-11-13T12:00:01Z")).runDue();
    expect(outcomes[0]?.outcome).toBe("executed");

    const statuses = h.announced.map((t) => `${t.status}${t.claimedAt ? "+claimed" : ""}`);
    expect(statuses).toEqual(["PENDING+claimed", "RUNNING+claimed", "COMPLETED+claimed"]);
    expect(h.announced.every((t) => t.agentId === "knowledge-agent")).toBe(true);
  });
});

describe("VO-3.1 — the conversation assigns committed work only", () => {
  function conversation(h: ReturnType<typeof harness>) {
    const planner = {
      planTask: vi.fn().mockResolvedValue({ executable: true, toolId: "knowledge.search", params: {}, reason: "ok" }),
    };
    const scheduleTask = vi.fn(async (_u: string, _t: string, when: Date, _o: unknown) => ({
      ok: true as const,
      task: { scheduledAt: when } as TaskRecord,
    }));
    const service = new TaskConversationService({
      tasks: h.taskService,
      planner: planner as never,
      execution: h.execution,
      scheduler: { scheduleTask } as never,
      assignAgent: byPolicy,
    });
    return { service, scheduleTask };
  }

  it("assigns scheduled work with its schedule", async () => {
    const h = harness({ assign: byPolicy });
    const { service, scheduleTask } = conversation(h);
    await service.handle({ userId: ALICE, role: "owner", goal: "search later", planOnly: false, scheduledAt: new Date("2026-11-14T10:00:00Z") });
    expect(scheduleTask).toHaveBeenCalledWith(ALICE, expect.any(String), expect.any(Date), { agentId: "knowledge-agent" });
  });

  it("does not assign plan-only work", async () => {
    const h = harness({ assign: byPolicy });
    const { service } = conversation(h);
    const result = await service.handle({ userId: ALICE, role: "owner", goal: "plan a search", planOnly: true });
    expect(h.store.rows.get(result!.taskId)).toMatchObject({ status: "PENDING", agentId: null });
  });

  it("assigns work that runs now at its start", async () => {
    const h = harness({ assign: byPolicy });
    const { service } = conversation(h);
    const result = await service.handle({ userId: ALICE, role: "owner", goal: "search now", planOnly: false });
    expect(h.store.rows.get(result!.taskId)).toMatchObject({ status: "COMPLETED", agentId: "knowledge-agent" });
  });
});

// ---------------------------------------------------------------------------

describe("VO-3.1 — the office task event", () => {
  const row = {
    id: "task-9",
    status: "RUNNING" as const,
    updatedAt: new Date("2026-11-13T10:00:00.000Z"),
    executionId: "exec-9",
    agentId: "knowledge-agent",
    toolId: "knowledge.search",
    title: "Find the contract",
    error: "nope",
  };

  it("carries agentId and toolId, and still no title or error", () => {
    const event = officeTaskEvent(row)!;
    expect(event).toEqual({
      kind: "task",
      id: "task:task-9:RUNNING:2026-11-13T10:00:00.000Z",
      at: "2026-11-13T10:00:00.000Z",
      taskId: "task-9",
      status: "RUNNING",
      executionId: "exec-9",
      agentId: "knowledge-agent",
      toolId: "knowledge.search",
    });
    expect(JSON.stringify(event)).not.toContain("Find the contract");
    expect(JSON.stringify(event)).not.toContain("nope");
  });

  it("omits them when the row has none", () => {
    const event = officeTaskEvent({ ...row, agentId: null, toolId: null })!;
    expect(event).not.toHaveProperty("agentId");
    expect(event).not.toHaveProperty("toolId");
  });

  it("is read back field by field, dropping anything else", () => {
    const parsed = parseOfficeStreamEvent({
      ...officeTaskEvent(row),
      title: "Find the contract",
      userId: "someone-else",
    });
    expect(parsed).toEqual(officeTaskEvent(row));
  });
});

// ---------------------------------------------------------------------------

function view(rows: AgentWorkRows, approvals: Array<{ agentId?: string; toolId: string; createdAt: string; expiresAt: string }> | Error = []) {
  const approvalCalls: string[] = [];
  const service = new OfficeAgentWorkService({
    tasks: { agentWork: async () => rows },
    approvals: {
      listByUser: async (userId) => {
        approvalCalls.push(userId);
        if (approvals instanceof Error) throw approvals;
        return { items: approvals, total: approvals.length };
      },
    },
    toolRisk: (toolId) => (toolId === "knowledge.search" ? "READ_ONLY" : toolId === "meta.campaign.pause" ? "EXTERNAL_SIDE_EFFECT" : undefined),
    now: () => new Date("2026-11-13T10:00:00Z"),
  });
  return { service, approvalCalls };
}

const T = (over: Partial<TaskRecord>): TaskRecord => ({
  id: "t",
  userId: ALICE,
  title: "A task",
  description: null,
  dueAt: null,
  priority: "NORMAL",
  status: "PENDING",
  startedAt: null,
  completedAt: null,
  error: null,
  scheduledAt: null,
  claimedAt: null,
  executionId: null,
  agentId: "knowledge-agent",
  assignedAt: new Date("2026-11-13T09:00:00Z"),
  toolId: null,
  remindedAt: null,
  createdBy: JARVIS_TASK_CREATOR,
  createdAt: new Date("2026-11-13T09:00:00Z"),
  updatedAt: new Date("2026-11-13T09:00:00Z"),
  ...over,
});

describe("VO-3.1 — the per-agent read", () => {
  it("prefers RUNNING over claimed over queued, and the queued task due soonest", async () => {
    const { service } = view({
      active: [
        T({ id: "q-late", scheduledAt: new Date("2026-11-13T18:00:00Z") }),
        T({ id: "q-soon", scheduledAt: new Date("2026-11-13T11:00:00Z") }),
        T({ id: "run", status: "RUNNING", toolId: "knowledge.search", startedAt: new Date("2026-11-13T09:59:00Z") }),
        T({ id: "claimed", agentId: "meta-ads-agent", claimedAt: new Date("2026-11-13T09:58:00Z") }),
        T({ id: "queued", agentId: "meta-ads-agent" }),
      ],
      latest: [],
    });
    const out = await service.forUser(ALICE);
    const knowledge = out.agents.find((a) => a.agentId === "knowledge-agent")!;
    expect(knowledge.active).toMatchObject({ taskId: "run", status: "RUNNING", toolId: "knowledge.search", toolRisk: "READ_ONLY" });
    expect(knowledge.queuedCount).toBe(2);
    const meta = out.agents.find((a) => a.agentId === "meta-ads-agent")!;
    expect(meta.active).toMatchObject({ taskId: "claimed", claimed: true });

    const onlyQueued = await view({ active: [T({ id: "q-late", scheduledAt: new Date("2026-11-13T18:00:00Z") }), T({ id: "q-soon", scheduledAt: new Date("2026-11-13T11:00:00Z") })], latest: [] }).service.forUser(ALICE);
    expect(onlyQueued.agents[0]!.active!.taskId).toBe("q-soon");
  });

  it("reports the last success and the newer of the last failure and unresolved run, with the reason", async () => {
    const { service } = view({
      active: [],
      latest: [
        T({ id: "done", status: "COMPLETED", updatedAt: new Date("2026-11-13T09:30:00Z") }),
        T({ id: "failed", status: "FAILED", error: "Provider refused.", updatedAt: new Date("2026-11-13T09:40:00Z") }),
        T({ id: "unresolved", status: "UNRESOLVED", error: "Outcome unknown.", updatedAt: new Date("2026-11-13T09:20:00Z") }),
      ],
    });
    const agent = (await service.forUser(ALICE)).agents[0]!;
    expect(agent.lastCompleted).toMatchObject({ taskId: "done", finishedAt: "2026-11-13T09:30:00.000Z", error: null });
    expect(agent.lastFailed).toMatchObject({ taskId: "failed", error: "Provider refused." });
  });

  it("groups the caller's pending approvals by agent, ignoring expired and agentless ones", async () => {
    const { service, approvalCalls } = view({ active: [], latest: [] }, [
      { agentId: "meta-ads-agent", toolId: "meta.campaign.pause", createdAt: "2026-11-13T09:55:00Z", expiresAt: "2026-11-13T10:05:00Z" },
      { agentId: "meta-ads-agent", toolId: "meta.adset.pause", createdAt: "2026-11-13T09:57:00Z", expiresAt: "2026-11-13T10:07:00Z" },
      { agentId: "meta-ads-agent", toolId: "meta.ad.pause", createdAt: "2026-11-13T09:00:00Z", expiresAt: "2026-11-13T09:10:00Z" },
      { toolId: "system.thing", createdAt: "2026-11-13T09:59:00Z", expiresAt: "2026-11-13T10:09:00Z" },
    ]);
    const out = await service.forUser(ALICE);
    expect(approvalCalls).toEqual([ALICE]);
    expect(out.approvalsRead).toBe(true);
    expect(out.agents).toHaveLength(1);
    expect(out.agents[0]!.pendingApprovals).toEqual({
      count: 2,
      newestAt: "2026-11-13T09:57:00Z",
      toolId: "meta.adset.pause",
      expiresAt: "2026-11-13T10:07:00Z",
    });
  });

  it("says when approvals could not be read, and claims nobody is waiting", async () => {
    const out = await view({ active: [T({})], latest: [] }, new Error("db down")).service.forUser(ALICE);
    expect(out.approvalsRead).toBe(false);
    expect(out.agents.every((a) => a.pendingApprovals === null)).toBe(true);
  });

  it("reads only the caller's work, whatever agents the users share", async () => {
    const h = harness({ assign: byPolicy });
    const mine = await h.work(ALICE, "Alice's search");
    const theirs = await h.work(BOB, "Bob's search");
    await h.execution.executeTask(ALICE, mine.id, { toolId: "knowledge.search", params: {}, role: "owner" });
    await h.execution.executeTask(BOB, theirs.id, { toolId: "knowledge.search", params: {}, role: "owner" });

    const service = new OfficeAgentWorkService({
      tasks: h.taskService,
      approvals: { listByUser: async () => ({ items: [], total: 0 }) },
      toolRisk: () => undefined,
    });
    const alice = await service.forUser(ALICE);
    const bob = await service.forUser(BOB);
    expect(alice.agents[0]!.lastCompleted!.title).toBe("Alice's search");
    expect(bob.agents[0]!.lastCompleted!.title).toBe("Bob's search");
    expect(JSON.stringify(alice)).not.toContain("Bob's");
    expect(JSON.stringify(bob)).not.toContain("Alice's");
  });
});

// ---------------------------------------------------------------------------

const tokenService: ITokenService = {
  generateAccessToken: () => TOKEN_ALICE,
  generateRefreshToken: () => "refresh",
  verifyAccessToken: (token) =>
    token === TOKEN_ALICE
      ? { userId: ALICE, role: "owner", email: "alice@test.invalid" }
      : token === TOKEN_BOB
        ? { userId: BOB, role: "viewer", email: "bob@test.invalid" }
        : null,
  hashToken: (t) => t,
  getRefreshTokenExpiry: () => new Date(),
};

async function getAgentWork(router: Router, query: Record<string, string>, authorization: string | null) {
  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(payload: unknown) {
      this._body = payload;
      return this;
    },
  };
  const layer = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: any[]) => unknown }> } }>;
  }).stack.find((l) => l.route?.path === "/agent-work" && l.route.methods.get);
  if (!layer?.route) throw new Error("GET /agent-work is not registered");
  const req = { method: "GET", params: {}, query, body: {}, headers: authorization ? { authorization } : {} };
  for (const entry of layer.route.stack) {
    if (res._body !== null) break;
    let advanced = false;
    await entry.handle(req, res as unknown as Response, () => {
      advanced = true;
    });
    for (let i = 0; i < 50 && res._body === null && !advanced; i += 1) await new Promise((r) => setTimeout(r, 0));
    if (!advanced && res._body === null) break;
  }
  return { status: res._status, body: res._body as any };
}

describe("VO-3.1 — GET /office/agent-work", () => {
  function router() {
    const h = harness({ assign: byPolicy });
    const approvalUsers: string[] = [];
    const container = {
      tokenService,
      taskService: h.taskService,
      approvalRepo: {
        listByUser: async (userId: string) => {
          approvalUsers.push(userId);
          return { items: [], total: 0 };
        },
      },
      toolRegistry: { get: () => ({ risk: "READ_ONLY" }) },
    } as unknown as Container;
    return { router: createOfficeRouter(container), h, approvalUsers };
  }

  it("refuses a request without a valid token", async () => {
    const { router: r } = router();
    expect((await getAgentWork(r, {}, null)).status).toBe(401);
    expect((await getAgentWork(r, {}, "Bearer nonsense")).status).toBe(401);
  });

  it("answers for the token's user, and ignores any user named in the request", async () => {
    const { router: r, h, approvalUsers } = router();
    const task = await h.work(ALICE, "Alice's only");
    await h.execution.executeTask(ALICE, task.id, { toolId: "knowledge.search", params: {}, role: "owner" });

    const asBob = await getAgentWork(r, { userId: ALICE, agentId: "knowledge-agent" }, `Bearer ${TOKEN_BOB}`);
    expect(asBob.status).toBe(200);
    expect(asBob.body.data.agents).toEqual([]);
    expect(approvalUsers).toEqual([BOB]);

    const asAlice = await getAgentWork(r, {}, `Bearer ${TOKEN_ALICE}`);
    expect(asAlice.body.data.agents[0].lastCompleted.title).toBe("Alice's only");
    expect(asAlice.body.data.agents[0].lastCompleted.toolRisk).toBe("READ_ONLY");
  });
});
