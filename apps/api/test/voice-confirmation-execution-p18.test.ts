// ---------------------------------------------------------------------------
// Phase 18, Stage 18.3A — a spoken turn never spends an approval: ToolExecutor,
// the orchestrator, the integration service and tools, and the task path.
//
// The chat route refuses a spoken "yes" (voice-confirmation-routes-p18). Here
// the layers underneath are proven to hold on their own, so no other path to
// an approval — a cached one for the same parameters, an id carried over, a
// work request — lets speech carry out an approved action:
//   • ToolExecutor refuses to spend an approved approval for a spoken turn,
//     before the tool runs and before the approval is consumed; asking by
//     voice still yields a pending approval; a typed turn runs as before;
//   • the real Orchestrator, for a spoken turn whose tool has a cached
//     approval, ends at that refusal;
//   • the integration tools hand the turn's mode to the service as its `voice`
//     flag, and the service refuses a spoken disconnect before anything is
//     revoked or removed — directly, through the tool, and through the
//     executor; a typed, approved disconnect still runs;
//   • the task path carries the mode to the executor, and tools speech may not
//     start are not task tools at all (a scheduled run outlives the turn).
// Fakes only: no provider, no network, no real write.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_LIBRARY_TOOL_IDS,
  VOICE_CONFIRMATION_REFUSED_MESSAGE,
  VOICE_TOOL_REFUSED_CODE,
  computeParamsHash,
  type AICompletionResponse,
  type Approval,
  type AuditLogger,
  type IAIProvider,
  type IApprovalManager,
  type ITool,
  type InputMode,
  type IToolExecutor,
  type ToolExecutionRequest,
} from "@jarvis/core";
import { PermissionService } from "@jarvis/security";
import { ToolExecutor, createIntegrationTools } from "@jarvis/tools";
import { AgentRegistry, AutomationAgent, ConversationalAssistant, Orchestrator, schedulableToolIds } from "@jarvis/agents";
import {
  IntegrationCommandService,
  type CredentialPort,
  type IntegrationStatePort,
  type RateLimitPort,
} from "../src/services/integrations/command-service.js";
import { TaskConversationService } from "../src/services/tasks/task-conversation-service.js";
import { TaskExecutionService } from "../src/services/tasks/task-execution-service.js";

const USER = "user-1";
const audit = { log: async () => undefined } as unknown as AuditLogger;

// ---------------------------------------------------------------------------
// An approval store, faked as the executor reads it, and a tool that records
// whether it ran.
// ---------------------------------------------------------------------------

function approvals() {
  const rows: Approval[] = [];
  let seq = 0;
  const manager: IApprovalManager & { rows: Approval[] } = {
    rows,
    requestApproval: vi.fn(async (request) => {
      const row = { ...request, id: `apr-new-${++seq}`, status: "pending", createdAt: new Date().toISOString() } as Approval;
      rows.push(row);
      return row;
    }),
    findExistingForTool: vi.fn(async (toolId: string, userId: string) => rows.find((r) => r.toolId === toolId && r.userId === userId) ?? null),
    findApprovalsForTool: vi.fn(async (toolId: string, userId: string) => rows.filter((r) => r.toolId === toolId && r.userId === userId)),
  };
  /** A human approved these exact parameters, on screen. */
  const approve = (toolId: string, params: Record<string, unknown>, id = "apr-1") => {
    rows.push({
      id,
      userId: USER,
      toolId,
      action: "execute",
      params,
      paramsHash: computeParamsHash(params),
      status: "approved",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      createdAt: new Date().toISOString(),
    } as Approval);
    return id;
  };
  return { manager, approve };
}

function gatedTool(id = "whatsapp.send") {
  const ran: Array<{ params: Record<string, unknown>; approvalId?: string }> = [];
  const tool: ITool = {
    id,
    name: id,
    description: id,
    category: "communication",
    risk: "EXTERNAL_SIDE_EFFECT",
    parameters: [],
    requiresApproval: true,
    requiredPermissions: ["read", "write"],
    version: "1",
    enabled: true,
    validate: () => true,
    execute: async (params, context) => {
      ran.push({ params, ...(context.approvalId ? { approvalId: context.approvalId } : {}) });
      return { success: true, data: { sent: true } };
    },
  };
  return { tool, ran };
}

const PARAMS = { to: "+910000000000", body: "Invoice ready" };

function executorWith(tools: ITool[], manager: IApprovalManager) {
  const map = new Map(tools.map((t) => [t.id, t]));
  return new ToolExecutor({ get: (id) => map.get(id) }, new PermissionService(), manager, audit);
}

const request = (toolId: string, over: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest => ({
  toolId,
  params: PARAMS,
  userId: USER,
  role: "owner",
  traceId: "trace-1",
  ...over,
});

describe("ToolExecutor never spends an approval for a spoken turn", () => {
  it("refuses a spoken confirmation that carries the approval's id — the tool never runs", async () => {
    const { manager, approve } = approvals();
    const { tool, ran } = gatedTool();
    const approvalId = approve(tool.id, PARAMS);
    const result = await executorWith([tool], manager).execute(request(tool.id, { approvalId, inputMode: "voice" }));
    expect(result).toMatchObject({
      status: "permission_denied",
      approvalId,
      error: VOICE_CONFIRMATION_REFUSED_MESSAGE,
      result: { success: false, metadata: { code: VOICE_TOOL_REFUSED_CODE, status: 403 } },
    });
    expect(ran).toEqual([]);
    // The approval is left as a human made it, to be carried out on screen.
    expect(manager.rows.find((r) => r.id === approvalId)?.status).toBe("approved");
  });

  it("refuses a cached approval for the same parameters, found without any id", async () => {
    const { manager, approve } = approvals();
    const { tool, ran } = gatedTool();
    approve(tool.id, PARAMS);
    const result = await executorWith([tool], manager).execute(request(tool.id, { inputMode: "voice" }));
    expect(result.status).toBe("permission_denied");
    expect(ran).toEqual([]);
  });

  it("still lets a spoken turn ASK: with nothing approved it gets a pending approval", async () => {
    const { manager } = approvals();
    const { tool, ran } = gatedTool();
    const result = await executorWith([tool], manager).execute(request(tool.id, { inputMode: "voice" }));
    expect(result.status).toBe("approval_pending");
    expect(manager.requestApproval).toHaveBeenCalledTimes(1);
    expect(ran).toEqual([]);
  });

  it("runs a typed turn with the approved approval, as before", async () => {
    const { manager, approve } = approvals();
    const { tool, ran } = gatedTool();
    const approvalId = approve(tool.id, PARAMS);
    for (const inputMode of [undefined, "text"] as const) {
      const result = await executorWith([tool], manager).execute(request(tool.id, { approvalId, ...(inputMode ? { inputMode } : {}) }));
      expect(result.status).toBe("completed");
    }
    expect(ran).toEqual([
      { params: PARAMS, approvalId },
      { params: PARAMS, approvalId },
    ]);
  });

  it("leaves tools that need no approval to the turn as they were", async () => {
    const { manager } = approvals();
    const { tool, ran } = gatedTool("data.read");
    tool.requiresApproval = false;
    tool.risk = "READ_ONLY";
    tool.requiredPermissions = ["read"];
    const result = await executorWith([tool], manager).execute(request(tool.id, { inputMode: "voice" }));
    expect(result.status).toBe("completed");
    expect(ran).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The real orchestrator
// ---------------------------------------------------------------------------

/** A model that asks for one tool, then answers. */
function scriptedProvider(toolName: string, args: Record<string, unknown>): IAIProvider {
  const queue: AICompletionResponse[] = [
    { message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: toolName, arguments: args }] }, finishReason: "tool_calls", model: "m" },
  ];
  return {
    id: "scripted",
    name: "scripted",
    defaultModel: "m",
    complete: async () => queue.shift() ?? { message: { role: "assistant", content: "ok" }, finishReason: "stop", model: "m" },
    listModels: async () => ["m"],
    isAvailable: async () => true,
  };
}

describe("the orchestrator, for a spoken turn whose tool has a cached approval", () => {
  async function turn(inputMode?: InputMode) {
    const { manager, approve } = approvals();
    const { tool, ran } = gatedTool("n8n.trigger");
    const params = { workflowId: "wf-1", payload: {} };
    approve(tool.id, params);
    const executor = executorWith([tool], manager);
    const provider = scriptedProvider("n8n.trigger", params);
    const registry = new AgentRegistry({ requirePolicy: true });
    registry.register(new ConversationalAssistant({ provider }));
    registry.register(new AutomationAgent({ provider }));
    const executed: ToolExecutionRequest[] = [];
    const recording: IToolExecutor = {
      execute: async (r) => {
        executed.push(r);
        return executor.execute(r);
      },
    };
    const orchestrator = new Orchestrator(registry, recording, audit, {
      toolRegistry: { get: (id: string) => (id === tool.id ? tool : undefined), getAll: () => [tool] } as never,
      permissionChecker: new PermissionService(),
      // The real service's answer for a cached approval: allowed, with its id.
      toolApprovalService: {
        checkPreExecution: async () => ({ allowed: true, requiresApproval: false, approvalId: "apr-1", reason: "Using cached approval" }),
      } as never,
    });
    await orchestrator.process(
      { message: "Trigger the invoice workflow", conversationId: "conv-1", agentId: "automation-agent", stream: false },
      {
        auth: { userId: USER, role: "owner", email: `${USER}@test.local` },
        conversationId: "conv-1",
        traceId: "6f1c1b8e-2a4f-4c3a-9d55-6a1f2e3b4c5d",
        ...(inputMode ? { inputMode } : {}),
      }
    );
    return { ran, executed };
  }

  it("ends at the executor's refusal: the tool never runs", async () => {
    const { ran, executed } = await turn("voice");
    expect(executed).toHaveLength(1);
    expect(executed[0]!.inputMode).toBe("voice");
    expect(ran).toEqual([]);
  });

  it("runs the same turn typed, as before", async () => {
    const { ran, executed } = await turn();
    expect(executed[0]!.inputMode).toBeUndefined();
    expect(ran).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The integration service and tools
// ---------------------------------------------------------------------------

function integrationHarness() {
  const removed: string[] = [];
  const credentials: CredentialPort = {
    async read() {
      return null;
    },
    async write() {},
    async remove(_u, provider) {
      removed.push(provider);
    },
  };
  const state: IntegrationStatePort = {
    async get() {
      return { enabled: true, enabledServices: [], lastSuccessfulSyncAt: null };
    },
    async patch() {
      return { enabled: true, enabledServices: [], lastSuccessfulSyncAt: null };
    },
    async clear() {},
  };
  const allowAll: RateLimitPort = { async check(_u, _b, limit) { return { allowed: true, currentCount: 0, limit }; } };
  const revoked: string[] = [];
  const fetched: string[] = [];
  const summary = {
    id: "c1",
    userId: USER,
    googleAccountEmail: "operator@example.com",
    scopes: [],
    connectedAt: new Date("2026-01-01"),
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
  };
  const service = new IntegrationCommandService({
    credentials,
    state,
    audit: { log: async () => undefined, query: async () => [] } as never,
    rateLimiter: allowAll,
    googleConnections: {
      async findByUser() {
        return summary;
      },
      async getCredentials() {
        return { accessToken: "ya29.TEST-ACCESS", refreshToken: "1//TEST-REFRESH", expiresAt: new Date(Date.now() + 3_600_000), scopes: [] };
      },
      async updateAccessToken() {},
      async save() {
        return summary;
      },
      async revoke(userId: string) {
        revoked.push(userId);
      },
    } as never,
    oauthStates: null,
    googleConfig: () => ({
      clientId: "client.apps.googleusercontent.com",
      clientSecret: "secret",
      redirectUri: "http://localhost/cb",
      developerToken: "",
      apiVersion: "v18",
      timeoutMs: 5_000,
    }),
    mapsUsage: async () => null,
    fetchImpl: (async (url: string) => {
      fetched.push(String(url));
      return new Response("{}", { status: 200 });
    }) as never,
  });
  const port = { execute: vi.fn((input: never, ctx: never) => service.execute(input, ctx)) };
  const tools = new Map(createIntegrationTools(port).map((t) => [t.id, t]));
  const nothingRevoked = () => {
    expect(revoked).toEqual([]);
    expect(fetched).toEqual([]);
    expect(removed).toEqual([]);
  };
  return { service, port, tools, revoked, fetched, removed, nothingRevoked };
}

describe("the integration service refuses a spoken disconnect", () => {
  it("directly: before anything is read, revoked or removed", async () => {
    const h = integrationHarness();
    const result = await h.service.execute({ command: "disconnect", integration: "google" }, { userId: USER, source: "jarvis", voice: true });
    expect(result).toMatchObject({ ok: false, code: "CONFIRMATION_REQUIRED" });
    expect((result as { message: string }).message).toMatch(/cannot be confirmed by voice/);
    h.nothingRevoked();
  });

  it("through the tool: the turn's mode reaches the service as its voice flag", async () => {
    const h = integrationHarness();
    const result = await h.tools.get("integration.disconnect")!.execute({ integration: "google" }, { userId: USER, inputMode: "voice" });
    expect(result.success).toBe(false);
    expect(h.port.execute.mock.calls[0]![1]).toMatchObject({ source: "jarvis", voice: true });
    h.nothingRevoked();
    // A typed turn carries no flag at all.
    await h.tools.get("integration.status")!.execute({ integration: "google" }, { userId: USER });
    expect(h.port.execute.mock.calls[1]![1]).not.toHaveProperty("voice");
  });

  it("through the executor: an approved disconnect is not carried out by voice", async () => {
    const h = integrationHarness();
    const { manager, approve } = approvals();
    const disconnect = h.tools.get("integration.disconnect")!;
    const params = { integration: "google" };
    const approvalId = approve(disconnect.id, params);
    const executor = executorWith([disconnect], manager);
    const spoken = await executor.execute(request(disconnect.id, { params, approvalId, inputMode: "voice" }));
    expect(spoken.status).toBe("permission_denied");
    expect(h.port.execute).not.toHaveBeenCalled();
    h.nothingRevoked();

    // The same approval, confirmed on screen: it runs, against fakes only.
    const typed = await executor.execute(request(disconnect.id, { params, approvalId }));
    expect(typed.status).toBe("completed");
    expect(h.revoked).toEqual([USER]);
    expect(h.removed).toEqual(["google"]);
    expect(h.fetched).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The task path
// ---------------------------------------------------------------------------

function taskStore() {
  const task = { id: "task-1", title: "t", status: "PENDING", error: null as string | null };
  return {
    task,
    service: {
      createTask: async () => ({ ok: true, task }),
      getTask: async () => ({ ok: true, task: { ...task } }),
      startTask: async () => ({ ok: true, task: { ...task, status: "RUNNING" } }),
      completeTask: async () => {
        task.status = "COMPLETED";
        return { ok: true, task: { ...task } };
      },
      failTask: async (_u: string, _t: string, error: string) => {
        task.status = "FAILED";
        task.error = error;
        return { ok: true, task: { ...task } };
      },
    },
  };
}

describe("the task path carries the turn's mode", () => {
  it("from a spoken work request to the executor — which then refuses to spend an approval", async () => {
    const { manager, approve } = approvals();
    const { tool, ran } = gatedTool();
    approve(tool.id, PARAMS);
    const executor = executorWith([tool], manager);
    const seen: ToolExecutionRequest[] = [];
    const tasks = taskStore();
    const execution = new TaskExecutionService({
      tasks: tasks.service as never,
      executor: { execute: async (r) => (seen.push(r), executor.execute(r)) },
      allowedToolIds: new Set([tool.id]),
    });
    const conversation = new TaskConversationService({
      tasks: tasks.service as never,
      planner: { planTask: async () => ({ executable: true, toolId: tool.id, params: PARAMS, reason: "fits" }) } as never,
      execution,
    });
    const result = await conversation.handle({ userId: USER, role: "owner", goal: "send the invoice message", planOnly: false, inputMode: "voice" });
    expect(seen[0]!.inputMode).toBe("voice");
    expect(ran).toEqual([]);
    expect(tasks.task.status).toBe("FAILED");
    expect(result?.message).toMatch(/did not complete/);
  });

  it("and runs the same request typed, with no mode", async () => {
    const { manager, approve } = approvals();
    const { tool, ran } = gatedTool();
    approve(tool.id, PARAMS);
    const seen: ToolExecutionRequest[] = [];
    const executor = executorWith([tool], manager);
    const tasks = taskStore();
    const execution = new TaskExecutionService({
      tasks: tasks.service as never,
      executor: { execute: async (r) => (seen.push(r), executor.execute(r)) },
      allowedToolIds: new Set([tool.id]),
    });
    const conversation = new TaskConversationService({
      tasks: tasks.service as never,
      planner: { planTask: async () => ({ executable: true, toolId: tool.id, params: PARAMS, reason: "fits" }) } as never,
      execution,
    });
    await conversation.handle({ userId: USER, role: "owner", goal: "send the invoice message", planOnly: false });
    expect(seen[0]!.inputMode).toBeUndefined();
    expect(ran).toHaveLength(1);
  });

  it("keeps tools speech may not start out of task tools — a scheduled run outlives the turn", () => {
    expect(schedulableToolIds().has(AUTOMATION_LIBRARY_TOOL_IDS.sync)).toBe(false);
    expect(schedulableToolIds().has(AUTOMATION_LIBRARY_TOOL_IDS.search)).toBe(true);
  });
});
