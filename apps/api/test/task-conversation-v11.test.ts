// ---------------------------------------------------------------------------
// Task Planner V1.1 — the conversational entry point to work.
//
// Two things are under test and they are different:
//
//   1. the DETECTOR — does an ordinary question stay an ordinary question?
//   2. the SEQUENCE — when work is requested, does it go task -> plan ->
//      execute without skipping a safety layer?
//
// The first matters most. A missed action is a conversation that behaves as it
// did yesterday; a false positive is JARVIS running a tool nobody asked for.
// So the detector tests lean hard on the negative cases.
//
// The only double is the model. Real registry, real BaseTools, real
// ToolPlanValidator, real ToolExecutor, real TaskService / TaskPlannerService /
// TaskExecutionService throughout.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { detectWorkRequest } from "@jarvis/agents";
import { ToolExecutor, ToolRegistry, BaseTool } from "@jarvis/tools";
import type {
  AICompletionRequest,
  AICompletionResponse,
  AuditLogger,
  IAIProvider,
  IApprovalManager,
  IPermissionChecker,
  Role,
  TaskStatus,
  ToolResult,
} from "@jarvis/core";
import { JARVIS_TASK_CREATOR } from "@jarvis/core";
import { TaskService } from "../src/services/tasks/task-service.js";
import { TaskPlannerService } from "../src/services/tasks/task-planner-service.js";
import { TaskExecutionService } from "../src/services/tasks/task-execution-service.js";
import { TaskConversationService } from "../src/services/tasks/task-conversation-service.js";
import type { TaskRecord } from "@jarvis/db";

const ALICE = "user-alice";
const BOB = "user-bob";
const ROLE: Role = "owner";

// ---------------------------------------------------------------------------
// 1 + 5 — the detector. Negative cases first, because they are the safety net.
// ---------------------------------------------------------------------------

describe("Task Planner V1.1 — informational chat is left alone", () => {
  it("1. a question is never a work request", () => {
    for (const message of [
      "What is blockchain?",
      "Explain SEO",
      "How does Meta Ads work?",
      "Tell me about pgvector",
      "Kya hai blockchain?",
      "Meta Ads kaise kaam karta hai?",
      "Why did my campaign spend drop",
    ]) {
      expect(detectWorkRequest(message).type, message).toBe("NONE");
    }
  });

  it("1b. a question ABOUT doing something is still a question", () => {
    // Each of these contains an action verb. None is an instruction.
    for (const message of [
      "How do I check a website's response?",
      "What does it mean to analyze a campaign?",
      "How can I send an email from here?",
      "Kaise check karte hain website ka response?",
    ]) {
      expect(detectWorkRequest(message).type, message).toBe("NONE");
    }
  });

  it("5. an ambiguous request never executes", () => {
    for (const message of [
      "Website ka response?",
      "digitalonebox.com?",
      "the campaign numbers",
      "check?",
    ]) {
      expect(detectWorkRequest(message).type, message).toBe("NONE");
    }
  });

  it("does not infer action from a noun or a tool name alone", () => {
    for (const message of [
      "I was reading about web.fetch today",
      "The analysis was interesting",
      "Our website is slow",
    ]) {
      expect(detectWorkRequest(message).type, message).toBe("NONE");
    }
  });

  it('"create a task" records, it does not perform — the existing tool owns it', () => {
    for (const message of [
      "Create a task to check digitalonebox.com",
      "Task banao: check the website",
      "Remember this as a task: analyze the Meta campaign",
    ]) {
      // NONE, so the turn reaches the orchestrator and `task.create`.
      expect(detectWorkRequest(message).type, message).toBe("NONE");
    }
  });
});

describe("Task Planner V1.1 — an explicit instruction is recognised", () => {
  it("2. an unambiguous imperative is a work request", () => {
    for (const message of [
      "Check digitalonebox.com",
      "DigitalOneBox.com ka current response check karo",
      "Analyze this file",
      "Research our top competitor",
      "Fetch https://example.com and report the status",
    ]) {
      expect(detectWorkRequest(message).type, message).toBe("EXECUTE");
    }
  });

  it("4. an explicit refusal to execute yields PLAN_ONLY", () => {
    for (const message of [
      "Plan how to check digitalonebox.com, don't execute",
      "Mujhe digitalonebox.com ka current response check karna hai. Is task ka plan banao, execute mat karo.",
      "Check the website — just plan it, do not execute",
      "Iska plan banao, mat karo",
    ]) {
      expect(detectWorkRequest(message).type, message).toBe("PLAN_ONLY");
    }
  });

  it("carries the goal through verbatim", () => {
    const result = detectWorkRequest("Check digitalonebox.com");
    expect(result.type).toBe("EXECUTE");
    if (result.type === "NONE") return;
    expect(result.goal).toBe("Check digitalonebox.com");
  });
});

// ---------------------------------------------------------------------------
// The sequence — real services end to end.
// ---------------------------------------------------------------------------

class WebFetchTool extends BaseTool {
  public calls = 0;
  constructor() {
    super(
      "web.fetch",
      "Fetch a page",
      "Fetch a public web page and report its status.",
      "research",
      [{ name: "url", type: "string", description: "The page to fetch.", required: true }],
      false,
      ["read"],
      "READ_ONLY"
    );
  }
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    this.calls += 1;
    return this.success({ url: params.url, status: 200 });
  }
}

class GatedWriteTool extends BaseTool {
  public calls = 0;
  constructor() {
    super("system.gatedWrite", "Gated write", "Needs approval.", "system", [], true, ["read", "write"], "EXTERNAL_SIDE_EFFECT");
  }
  async execute(): Promise<ToolResult> {
    this.calls += 1;
    return this.success({ wrote: true });
  }
}

/** Registered and real, granted by no policy. */
class UngrantedTool extends BaseTool {
  constructor() {
    super("system.secretOps", "Secret ops", "Ungranted.", "system", [], false, ["read"], "READ_ONLY");
  }
  async execute(): Promise<ToolResult> {
    return this.success({});
  }
}

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;
  return {
    rows,
    async create(userId: string, input: { title: string; description?: string | null; createdBy?: string | null }) {
      const now = new Date();
      const row: TaskRecord = {
        id: `task-${++seq}`, userId, title: input.title,
        description: input.description ?? null, dueAt: null, priority: "NORMAL",
        status: "PENDING", startedAt: null, completedAt: null, error: null,
        remindedAt: null, createdBy: input.createdBy ?? null, createdAt: now, updatedAt: now,
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
    async findOwned(userId: string, taskId: string) {
      const row = rows.get(taskId);
      return row && row.userId === userId ? row : null;
    },
    async transitionOwned(
      userId: string, taskId: string, expectedFrom: TaskStatus, to: TaskStatus,
      options: { error?: string | null } = {}
    ) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) return { ok: false as const, reason: "not_found" as const, current: null };
      if (row.status !== expectedFrom) return { ok: false as const, reason: "state_changed" as const, current: row.status };
      row.status = to;
      if (to === "RUNNING") row.startedAt = new Date();
      if (to === "COMPLETED") { row.completedAt = new Date(); row.error = null; }
      if (to === "FAILED") row.error = options.error ?? null;
      return { ok: true as const, task: row };
    },
  };
}

function providerReturning(content: string): IAIProvider & { seen: AICompletionRequest[] } {
  const seen: AICompletionRequest[] = [];
  return {
    seen,
    id: "openai", name: "OpenAI", defaultModel: "gpt-4o",
    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
      seen.push(request);
      return {
        message: { role: "assistant", content },
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "gpt-4o",
      };
    },
    async listModels() { return ["gpt-4o"]; },
    async isAvailable() { return true; },
  };
}

const PLAN_WEB_FETCH = JSON.stringify({
  executable: true,
  toolId: "web.fetch",
  params: { url: "https://digitalonebox.com" },
  reason: "Fetching the page reports its current response.",
});

function harness(modelOutput: string, perms: IPermissionChecker = { hasPermission: () => true }) {
  const store = makeStore();
  const tasks = new TaskService({ tasks: store });

  const web = new WebFetchTool();
  const gated = new GatedWriteTool();
  const registry = new ToolRegistry();
  for (const tool of [web, gated, new UngrantedTool()]) registry.register(tool);

  const allowedToolIds = new Set(["web.fetch", "system.gatedWrite"]);
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
  const execution = new TaskExecutionService({ tasks, executor, allowedToolIds });
  const conversation = new TaskConversationService({ tasks, planner, execution });

  return { store, tasks, planner, execution, conversation, executeSpy, web, gated, provider };
}

const turn = (h: ReturnType<typeof harness>, goal: string, planOnly = false, userId = ALICE) =>
  h.conversation.handle({ userId, role: ROLE, goal, planOnly });

// ---------------------------------------------------------------------------

describe("Task Planner V1.1 — an explicit instruction runs exactly one action", () => {
  it("3. creates a task, plans it, and executes one validated action", async () => {
    const h = harness(PLAN_WEB_FETCH);

    const result = await turn(h, "DigitalOneBox.com ka current response check karo");

    // One task, stamped as JARVIS work so it stays out of the todo surfaces.
    expect(h.store.rows.size).toBe(1);
    const task = h.store.rows.get(result.taskId)!;
    expect(task.createdBy).toBe(JARVIS_TASK_CREATOR);
    expect(task.userId).toBe(ALICE);

    // Planned, executed, completed.
    expect(result.plan).toMatchObject({ executable: true, toolId: "web.fetch" });
    expect(result.execution).toMatchObject({ toolId: "web.fetch", status: "completed" });
    expect(task.status).toBe("COMPLETED");
    expect(result.message).toMatch(/done/i);
  });

  it("13. exactly one ToolExecutor call, and the tool ran once", async () => {
    const h = harness(PLAN_WEB_FETCH);
    await turn(h, "Check digitalonebox.com");

    expect(h.executeSpy).toHaveBeenCalledTimes(1);
    expect(h.web.calls).toBe(1);
  });

  it("4b. a planning-only turn plans but never executes", async () => {
    const h = harness(PLAN_WEB_FETCH);

    const result = await turn(h, "Is task ka plan banao, execute mat karo", true);

    expect(result.plan).toMatchObject({ executable: true, toolId: "web.fetch" });
    expect(result.execution).toBeUndefined();
    expect(h.executeSpy).not.toHaveBeenCalled();
    expect(h.web.calls).toBe(0);
    // The task survives, PENDING, so it can be run later.
    expect(h.store.rows.get(result.taskId)!.status).toBe("PENDING");
    expect(result.message).toMatch(/not executed it/i);
  });
});

describe("Task Planner V1.1 — every safety layer still applies", () => {
  it("6. a tool no policy grants is refused, and nothing runs", async () => {
    const h = harness(
      JSON.stringify({ executable: true, toolId: "system.secretOps", params: {}, reason: "nope" })
    );

    const result = await turn(h, "Check the secret ops");

    expect(result.plan).toMatchObject({ executable: false });
    expect(h.executeSpy).not.toHaveBeenCalled();
    expect(h.store.rows.get(result.taskId)!.status).toBe("PENDING");
    expect(result.message).toMatch(/cannot carry it out/i);
  });

  it("7. invalid parameters are refused by the tool's own validation", async () => {
    const h = harness(
      JSON.stringify({ executable: true, toolId: "web.fetch", params: {}, reason: "no url" })
    );

    const result = await turn(h, "Check the website");

    expect(result.plan).toMatchObject({ executable: false });
    expect(h.executeSpy).not.toHaveBeenCalled();
    expect(h.web.calls).toBe(0);
  });

  it("8. an approval-gated tool still stops at the approval gate", async () => {
    const h = harness(
      JSON.stringify({ executable: true, toolId: "system.gatedWrite", params: {}, reason: "needs approval" })
    );

    const result = await turn(h, "Send the supplier update");

    // It reached the executor — and the executor refused to run it.
    expect(h.executeSpy).toHaveBeenCalledTimes(1);
    expect(result.execution).toMatchObject({ status: "approval_pending" });
    expect(h.gated.calls).toBe(0);
    expect(h.store.rows.get(result.taskId)!.status).toBe("FAILED");
    expect(h.store.rows.get(result.taskId)!.error).toMatch(/approval/i);
  });

  it("a permission failure is not bypassed", async () => {
    const readOnly: IPermissionChecker = {
      hasPermission: (_r: Role, _res: string, action: string) => action === "read",
    };
    const h = harness(
      JSON.stringify({ executable: true, toolId: "system.gatedWrite", params: {}, reason: "x" }),
      readOnly
    );

    const result = await turn(h, "Send the supplier update");

    expect(h.gated.calls).toBe(0);
    expect(h.store.rows.get(result.taskId)!.status).toBe("FAILED");
  });

  it("9. work is scoped to the caller — one user's turn cannot touch another's", async () => {
    const h = harness(PLAN_WEB_FETCH);

    const alice = await turn(h, "Check digitalonebox.com", false, ALICE);
    const bob = await turn(h, "Check digitalonebox.com", false, BOB);

    expect(h.store.rows.get(alice.taskId)!.userId).toBe(ALICE);
    expect(h.store.rows.get(bob.taskId)!.userId).toBe(BOB);
    expect(alice.taskId).not.toBe(bob.taskId);

    // And neither can read the other's task through the service.
    const crossRead = await h.tasks.getTask(BOB, alice.taskId);
    expect(crossRead.ok).toBe(false);
  });

  it("a refused plan leaves a durable record of what was asked for", async () => {
    const h = harness(JSON.stringify({ executable: false, reason: "Nothing here can do that." }));

    const result = await turn(h, "Check the moon landing telemetry");

    // The task exists and is PENDING: asked for, not done.
    const task = h.store.rows.get(result.taskId)!;
    expect(task.status).toBe("PENDING");
    expect(task.title).toMatch(/moon landing/i);
    expect(result.message).toMatch(/Nothing here can do that/);
  });

  it("the model never sees an ungranted tool", async () => {
    const h = harness(PLAN_WEB_FETCH);
    await turn(h, "Check digitalonebox.com");

    const system = h.provider.seen[0]!.messages[0]!.content;
    expect(system).toContain("web.fetch");
    expect(system).not.toContain("system.secretOps");
  });
});
