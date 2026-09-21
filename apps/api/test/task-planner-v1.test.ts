// ---------------------------------------------------------------------------
// Task Planner V1 — goal -> ONE proposed tool call.
//
// THE ONLY DOUBLE IS THE MODEL. Everything the planner's safety rests on is
// real here: a real `ToolRegistry` holding real `BaseTool` subclasses, the
// real `ToolPlanValidator` the agent layer uses, and — for the end-to-end
// tests — the real `ToolExecutor` and `TaskExecutionService`.
//
// That is deliberate. The property under test is "the model cannot talk the
// system into running something", and a faked registry or a faked validator
// would test the mock instead of the boundary.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
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
import { TaskExecutionService } from "../src/services/tasks/task-execution-service.js";
import { TaskPlannerService } from "../src/services/tasks/task-planner-service.js";
import type { TaskRecord } from "@jarvis/db";

const ALICE = "user-alice";
const BOB = "user-bob";
const ROLE: Role = "owner";

// ---------------------------------------------------------------------------
// Real tools
// ---------------------------------------------------------------------------

class WebFetchTool extends BaseTool {
  public calls = 0;
  constructor() {
    super(
      "web.fetch",
      "Fetch a page",
      "Fetch the contents of a public web page and report its status.",
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

/** Registered and real, but granted by NO policy — must stay invisible. */
class UngrantedTool extends BaseTool {
  public calls = 0;
  constructor() {
    super("system.secretOps", "Secret ops", "Not granted to any agent.", "system", [], false, ["read"], "READ_ONLY");
  }
  async execute(): Promise<ToolResult> {
    this.calls += 1;
    return this.success({});
  }
}

// ---------------------------------------------------------------------------
// The one double: the model.
// ---------------------------------------------------------------------------

function providerReturning(content: string | (() => string)): IAIProvider & { seen: AICompletionRequest[] } {
  const seen: AICompletionRequest[] = [];
  return {
    seen,
    id: "openai",
    name: "OpenAI",
    defaultModel: "gpt-4o",
    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
      seen.push(request);
      return {
        message: { role: "assistant", content: typeof content === "function" ? content() : content },
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
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

function throwingProvider(): IAIProvider {
  return {
    id: "openai",
    name: "OpenAI",
    defaultModel: "gpt-4o",
    async complete(): Promise<AICompletionResponse> {
      throw new Error("ECONNREFUSED 10.0.0.1:443 api-key=sk-live-SHOULD-NEVER-LEAK");
    },
    async listModels() {
      return [];
    },
    async isAvailable() {
      return false;
    },
  };
}

// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;
  return {
    rows,
    async create(userId: string, input: { title: string; description?: string | null; createdBy?: string | null }) {
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

const allowAll: IPermissionChecker = { hasPermission: () => true };

function harness(modelOutput: string | (() => string), provider?: IAIProvider) {
  const store = makeStore();
  const taskService = new TaskService({ tasks: store });

  const web = new WebFetchTool();
  const gated = new GatedWriteTool();
  const ungranted = new UngrantedTool();

  // REAL registry, holding one tool that policy does NOT grant.
  const registry = new ToolRegistry();
  for (const tool of [web, gated, ungranted]) registry.register(tool);

  // The shared allowlist — `system.secretOps` is deliberately absent.
  const allowedToolIds = new Set(["web.fetch", "system.gatedWrite"]);

  const model = provider ?? providerReturning(modelOutput);

  // REAL validator (default), REAL registry.
  const planner = new TaskPlannerService({ provider: model, registry, allowedToolIds });

  const audited: unknown[] = [];
  const executor = new ToolExecutor(
    registry,
    allowAll,
    {
      requestApproval: vi.fn().mockResolvedValue({ id: "approval-1", status: "pending" }),
      findApprovalsForTool: vi.fn().mockResolvedValue([]),
    } as unknown as IApprovalManager,
    { log: vi.fn().mockImplementation(async (e: unknown) => { audited.push(e); }) } as unknown as AuditLogger
  );
  const executeSpy = vi.spyOn(executor, "execute");

  const execution = new TaskExecutionService({ tasks: taskService, executor, allowedToolIds });

  async function pendingTask(userId = ALICE, title = "Check the current website response") {
    const created = await taskService.createTask(userId, { title, createdBy: JARVIS_TASK_CREATOR });
    if (!created.ok) throw new Error("setup failed");
    return created.task;
  }

  return { store, taskService, planner, execution, executor, executeSpy, web, gated, ungranted, model, pendingTask };
}

const plan = (h: ReturnType<typeof harness>, task: TaskRecord) =>
  h.planner.planTask({ userId: ALICE, taskId: task.id, title: task.title, description: task.description });

const VALID = JSON.stringify({
  executable: true,
  toolId: "web.fetch",
  params: { url: "https://example.com" },
  reason: "Fetching the page reports its current response.",
});

// ---------------------------------------------------------------------------
// A + B — the happy path
// ---------------------------------------------------------------------------

describe("Task Planner V1 — proposes one allowed action", () => {
  it("A. selects an existing, allowed tool", async () => {
    const h = harness(VALID);
    const result = await plan(h, await h.pendingTask());

    expect(result.executable).toBe(true);
    if (!result.executable) return;
    expect(result.toolId).toBe("web.fetch");
    expect(result.params).toEqual({ url: "https://example.com" });
    expect(result.reason).toMatch(/fetching the page/i);
  });

  it("B. returns a structured plan, and the model was asked for JSON only", async () => {
    const h = harness(VALID);
    await plan(h, await h.pendingTask());

    const seen = (h.model as ReturnType<typeof providerReturning>).seen;
    expect(seen).toHaveLength(1);
    const system = seen[0]!.messages[0]!.content;
    expect(system).toContain("single JSON object");
    // Determinism: a planner that reshuffles its answer per call is not one.
    expect(seen[0]!.temperature).toBe(0);
  });

  it("accepts a fenced JSON block, the shape models actually emit", async () => {
    const h = harness("Here you go:\n```json\n" + VALID + "\n```");
    const result = await plan(h, await h.pendingTask());
    expect(result.executable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C + D — the model is not the authority
// ---------------------------------------------------------------------------

describe("Task Planner V1 — a proposed tool is validated server-side", () => {
  it("C. rejects a tool that does not exist", async () => {
    const h = harness(
      JSON.stringify({ executable: true, toolId: "some.tool", params: {}, reason: "Invented." })
    );
    const result = await plan(h, await h.pendingTask());

    expect(result.executable).toBe(false);
    expect(result.reason).toMatch(/no authorized executable capability/i);
  });

  it("D. rejects a REGISTERED tool that no agent policy grants", async () => {
    // `system.secretOps` is real and in the registry — only the allowlist
    // keeps it out. This is the test that would catch a planner given the raw
    // registry instead of the policy-narrowed one.
    const h = harness(
      JSON.stringify({ executable: true, toolId: "system.secretOps", params: {}, reason: "Nope." })
    );
    const result = await plan(h, await h.pendingTask());

    expect(result.executable).toBe(false);
    expect(result.reason).toMatch(/no authorized executable capability/i);
    expect(h.ungranted.calls).toBe(0);
  });

  it("D2. an ungranted tool is never even shown to the model", async () => {
    const h = harness(VALID);
    await plan(h, await h.pendingTask());

    const system = (h.model as ReturnType<typeof providerReturning>).seen[0]!.messages[0]!.content;
    expect(system).toContain("web.fetch");
    expect(system).not.toContain("system.secretOps");
  });

  it("E. rejects invalid parameters using the tool's own validation", async () => {
    // `url` is required; the real ToolPlanValidator + BaseTool.validate refuse.
    const h = harness(
      JSON.stringify({ executable: true, toolId: "web.fetch", params: {}, reason: "Missing url." })
    );
    const result = await plan(h, await h.pendingTask());

    expect(result.executable).toBe(false);
    expect(result.reason).toMatch(/not valid/i);
    expect(result.reason).toMatch(/web\.fetch/);
  });
});

// ---------------------------------------------------------------------------
// F + G — malformed and multi-step
// ---------------------------------------------------------------------------

describe("Task Planner V1 — anything unexpected is a refusal, never a guess", () => {
  it("F. rejects prose instead of JSON", async () => {
    const h = harness("Sure, I think we should use web.fetch for this!");
    const result = await plan(h, await h.pendingTask());

    expect(result.executable).toBe(false);
    expect(result.reason).toBe("Planner produced invalid structured output.");
  });

  it("F2. rejects JSON that does not match the schema", async () => {
    for (const bad of [
      JSON.stringify({ executable: "yes", toolId: "web.fetch", reason: "wrong type" }),
      JSON.stringify({ executable: true, toolId: "web.fetch", reason: "x", extra: "field" }),
      JSON.stringify({ toolId: "web.fetch", reason: "no executable flag" }),
      JSON.stringify({ executable: true, reason: "executable but names nothing" }),
    ]) {
      const h = harness(bad);
      const result = await plan(h, await h.pendingTask());
      expect(result.executable, bad).toBe(false);
      expect(result.reason, bad).toBe("Planner produced invalid structured output.");
    }
  });

  it("G. rejects a goal that needs several actions", async () => {
    const h = harness(
      JSON.stringify({
        executable: false,
        requiresMultipleActions: true,
        reason: "Research, analyse, write and publish are four separate actions.",
      })
    );
    const result = await plan(h, await h.pendingTask(ALICE, "Research competitors, analyse SEO, write a report and publish it"));

    expect(result.executable).toBe(false);
    expect(result.reason).toMatch(/multi-step planning is not supported in V1/i);
  });

  it("G2. a chain is not expressible — the schema holds one toolId", async () => {
    const h = harness(
      JSON.stringify({
        executable: true,
        toolId: "web.fetch",
        params: { url: "https://example.com" },
        reason: "x",
        steps: [{ tool: "web.fetch" }, { tool: "system.gatedWrite" }],
      })
    );
    // `.strict()` refuses the extra key rather than quietly ignoring it.
    const result = await plan(h, await h.pendingTask());
    expect(result.executable).toBe(false);
    expect(result.reason).toBe("Planner produced invalid structured output.");
  });

  it("reports no capability when nothing fits, without approximating", async () => {
    const h = harness(
      JSON.stringify({ executable: false, reason: "No tool here can send money." })
    );
    const result = await plan(h, await h.pendingTask(ALICE, "Send money to my supplier"));
    expect(result.executable).toBe(false);
    expect(result.reason).toMatch(/send money/i);
  });
});

// ---------------------------------------------------------------------------
// H + I + J + K + L — what planning must NOT do
// ---------------------------------------------------------------------------

describe("Task Planner V1 — planning changes nothing", () => {
  it("H. does not change task status", async () => {
    const h = harness(VALID);
    const task = await h.pendingTask();

    await plan(h, task);

    expect(h.store.rows.get(task.id)!.status).toBe("PENDING");
    expect(h.store.rows.get(task.id)!.startedAt).toBeNull();
  });

  it("I. does not invoke the ToolExecutor", async () => {
    const h = harness(VALID);
    await plan(h, await h.pendingTask());

    expect(h.executeSpy).not.toHaveBeenCalled();
    expect(h.web.calls).toBe(0);
  });

  it("J. cannot bypass approval — planning a gated tool runs nothing", async () => {
    const h = harness(
      JSON.stringify({ executable: true, toolId: "system.gatedWrite", params: {}, reason: "Needs approval." })
    );
    const result = await plan(h, await h.pendingTask());

    // The PLAN is legitimate; the gate is enforced at execution, not here.
    expect(result.executable).toBe(true);
    expect(h.gated.calls).toBe(0);
    expect(h.executeSpy).not.toHaveBeenCalled();

    // And executing that plan still stops at the approval gate.
    const task = await h.pendingTask();
    if (!result.executable) return;
    const outcome = await h.execution.executeTask(ALICE, task.id, {
      toolId: result.toolId,
      params: result.params,
      role: ROLE,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.execution.status).toBe("approval_pending");
    expect(h.gated.calls).toBe(0);
  });

  it("K. enforces ownership through the same service the routes use", async () => {
    const h = harness(VALID);
    const bobTask = await h.pendingTask(BOB);

    // The route loads the task as the caller before planning; a stranger
    // cannot get past that.
    const found = await h.taskService.getTask(ALICE, bobTask.id);
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.reason).toBe("NOT_FOUND");
  });

  it("L. exposes no secret or provider detail, even when the provider fails", async () => {
    const h = harness("", throwingProvider());
    const result = await plan(h, await h.pendingTask());

    expect(result.executable).toBe(false);
    const serialised = JSON.stringify(result);
    for (const forbidden of ["sk-live", "ECONNREFUSED", "10.0.0.1", "api-key"]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it("L2. the tool catalogue carries no risk, permission or credential detail", async () => {
    const h = harness(VALID);
    await plan(h, await h.pendingTask());

    const system = (h.model as ReturnType<typeof providerReturning>).seen[0]!.messages[0]!.content;
    // Shape only: id, name, description, parameters.
    expect(system).not.toContain("EXTERNAL_SIDE_EFFECT");
    expect(system).not.toContain("requiredPermissions");
    expect(system).not.toContain("requiresApproval");
    expect(system).not.toMatch(/sk-|password|secret_key/i);
  });
});

// ---------------------------------------------------------------------------
// M + N — planner -> executor, end to end
// ---------------------------------------------------------------------------

describe("Task Planner V1 — a plan feeds the existing executor unchanged", () => {
  it("M. a validated plan executes and completes the task", async () => {
    const h = harness(VALID);
    const task = await h.pendingTask();

    const planned = await plan(h, task);
    expect(planned.executable).toBe(true);
    if (!planned.executable) return;

    const outcome = await h.execution.executeTask(ALICE, task.id, {
      toolId: planned.toolId,
      params: planned.params,
      role: ROLE,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.status).toBe("COMPLETED");
    expect(h.web.calls).toBe(1);
  });

  it("N. plan + execute produces exactly ONE ToolExecutor call", async () => {
    const h = harness(VALID);
    const task = await h.pendingTask();

    const planned = await plan(h, task);
    if (!planned.executable) throw new Error("expected an executable plan");

    await h.execution.executeTask(ALICE, task.id, {
      toolId: planned.toolId,
      params: planned.params,
      role: ROLE,
    });

    expect(h.executeSpy).toHaveBeenCalledTimes(1);
    expect(h.web.calls).toBe(1);
  });

  it("a refused plan has nothing to execute, and the task stays PENDING", async () => {
    const h = harness(JSON.stringify({ executable: false, reason: "Nothing fits." }));
    const task = await h.pendingTask();

    const planned = await plan(h, task);
    expect(planned.executable).toBe(false);
    expect(h.executeSpy).not.toHaveBeenCalled();
    expect(h.store.rows.get(task.id)!.status).toBe("PENDING");
  });
});
