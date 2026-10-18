// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening (review finding H2) — a chat's pending
// action for a write through a shared connection.
//
//   • The orchestrator asks the access gate BEFORE a pending action exists: a
//     write the caller's Organization role could never allow is refused at
//     once, and nobody is shown a Confirm button for it.
//   • The requester cannot confirm their own Organization write: it waits, and
//     the store's refusal (`self_approval_forbidden`) is told truthfully.
//   • Once another owner or admin approved it, the requester's confirm RUNS it
//     — nothing is decided on their behalf — and they may still withdraw it.
//   • An ordinary write is unchanged.
//
// The approval store here is a double, modelling only what the real one
// decides for these rows (shared-connection-approvals-p17-pg pins the real one).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import type {
  AICompletionRequest,
  AICompletionResponse,
  Approval,
  AuditEntry,
  IAIProvider,
  ITool,
  IToolExecutor,
  RiskLevel,
  ToolAccessGate,
  ToolExecutionRequest,
  ToolExecutionResult,
} from "@jarvis/core";
import { sharedConnectionOfTool } from "@jarvis/core";
import { NEEDS_INDEPENDENT_APPROVAL_MESSAGE, PendingActionService } from "../src/pending-action-service.js";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";

const REQUESTER = "requester-1";
const APPROVER = "approver-1";

/** The decisions the real store makes for an Organization's write, and no more. */
function organizationAwareStore() {
  const rows = new Map<string, Approval>();
  let seq = 0;
  const decide = vi.fn(
    async (id: string, userId: string, decision: "approve" | "reject", options?: { fromPendingOnly?: boolean }) => {
      const row = rows.get(id);
      if (!row) return { outcome: "not_found" };
      if (row.tenantId && row.userId === userId && decision === "approve") return { outcome: "self_approval_forbidden" };
      if (row.status === "consumed") return { outcome: "already_consumed" };
      if (row.status === "rejected") return { outcome: "already_rejected" };
      const guard = decision === "approve" || options?.fromPendingOnly ? ["pending"] : ["pending", "approved"];
      if (!guard.includes(row.status)) return { outcome: "conflict", currentState: row.status.toUpperCase() };
      row.status = decision === "approve" ? "approved" : "rejected";
      return { outcome: row.status };
    }
  );
  return {
    rows,
    decide,
    approvalRepo: {
      async create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval> {
        const shared = sharedConnectionOfTool(data.toolId);
        const row: Approval = {
          ...data,
          id: `apr-${++seq}`,
          status: "pending",
          createdAt: new Date().toISOString(),
          ...(shared?.access === "write" ? { tenantId: "org-a" } : {}),
        };
        rows.set(row.id, row);
        return row;
      },
      async findById(id: string) {
        return rows.get(id) ?? null;
      },
      async updateStatus(id: string, status: Approval["status"]) {
        const row = rows.get(id);
        if (row) row.status = status;
        return row ?? null;
      },
      async findPendingByConversationId(conversationId: string, userId: string) {
        const waiting = [...rows.values()].filter(
          (r) =>
            r.conversationId === conversationId &&
            r.userId === userId &&
            (r.status === "pending" || (r.status === "approved" && r.tenantId && r.decidedById && r.decidedById !== userId))
        );
        return waiting.at(-1) ?? null;
      },
      async updateParams() {
        return null;
      },
      decideApproval: decide,
    },
    /** Another owner or admin of the Organization approves it, as the Approvals page would. */
    approveAsAnother(id: string) {
      const row = rows.get(id)!;
      row.status = "approved";
      row.decidedById = APPROVER;
    },
  };
}

function writeTool(id: string): ITool {
  return {
    id,
    name: id,
    description: "a write",
    category: "marketing",
    risk: "EXTERNAL_SIDE_EFFECT" as RiskLevel,
    parameters: [],
    requiresApproval: true,
    requiredPermissions: ["read", "write"],
    version: "1",
    enabled: true,
    execute: vi.fn(async () => ({ success: true })),
    validate: () => true,
  };
}

function toolRegistry(...tools: ITool[]) {
  const map = new Map(tools.map((t) => [t.id, t]));
  return { get: (id: string) => map.get(id), getAll: () => [...map.values()] };
}

const META_WRITE = "meta.campaign.pause";
const ORDINARY_WRITE = "whatsapp.send";
const CONVERSATION = "conv-1";

function service(store = organizationAwareStore()) {
  return {
    store,
    pending: new PendingActionService({
      approvalRepo: store.approvalRepo,
      toolRegistry: toolRegistry(writeTool(META_WRITE), writeTool(ORDINARY_WRITE)),
    }),
  };
}

const create = (pending: PendingActionService, toolId = META_WRITE) =>
  pending.createPendingAction({
    conversationId: CONVERSATION,
    userId: REQUESTER,
    toolId,
    action: toolId,
    params: { accountId: "act_111111111", campaignId: "100000001" },
    riskLevel: "EXTERNAL_SIDE_EFFECT",
  });

describe("an Organization's write waits for someone else", () => {
  it("is created as needing another owner or admin, and says so — not 'reply yes'", async () => {
    const { pending } = service();
    const { pendingAction, message } = await create(pending);
    expect(pendingAction.needsIndependentApproval).toBe(true);
    expect(message).toMatch(/needs approval from another owner or admin of your organization/);
    expect(message).not.toMatch(/Reply 'yes' to confirm/);
  });

  it("refuses its requester's confirm, truthfully, and keeps it waiting", async () => {
    const { pending, store } = service();
    const { pendingAction } = await create(pending);
    const result = await pending.confirmPendingAction(CONVERSATION, REQUESTER, pendingAction.id);
    expect(result).toMatchObject({ success: false, reason: "NEEDS_INDEPENDENT_APPROVAL", message: NEEDS_INDEPENDENT_APPROVAL_MESSAGE });
    expect(store.rows.get(pendingAction.id)!.status).toBe("pending");
  });

  it("runs on its requester's confirm once another owner or admin approved it — deciding nothing itself", async () => {
    const { pending, store } = service();
    const { pendingAction } = await create(pending);
    store.approveAsAnother(pendingAction.id);
    store.decide.mockClear();

    const active = await pending.getActivePendingAction(CONVERSATION, REQUESTER);
    expect(active).toMatchObject({ id: pendingAction.id, state: "APPROVED", needsIndependentApproval: true });

    const result = await pending.confirmPendingAction(CONVERSATION, REQUESTER, pendingAction.id);
    expect(result).toMatchObject({ success: true, pendingAction: { state: "APPROVED", approvalId: pendingAction.id } });
    expect(store.decide).not.toHaveBeenCalled();
  });

  it("can still be withdrawn by its requester after the approval, before it runs", async () => {
    const { pending, store } = service();
    const { pendingAction } = await create(pending);
    store.approveAsAnother(pendingAction.id);
    const result = await pending.rejectPendingAction(CONVERSATION, REQUESTER, pendingAction.id);
    expect(result.success).toBe(true);
    expect(store.rows.get(pendingAction.id)!.status).toBe("rejected");
  });
});

describe("an ordinary write is unchanged", () => {
  it("is confirmed by its requester", async () => {
    const { pending, store } = service();
    const { pendingAction, message } = await create(pending, ORDINARY_WRITE);
    expect(pendingAction.needsIndependentApproval).toBeUndefined();
    expect(message).toMatch(/requires your confirmation/);
    const result = await pending.confirmPendingAction(CONVERSATION, REQUESTER, pendingAction.id);
    expect(result.success).toBe(true);
    expect(store.rows.get(pendingAction.id)!.status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// The orchestrator's gate, before a pending action exists
// ---------------------------------------------------------------------------

function scriptedProvider(toolName: string): IAIProvider {
  let calls = 0;
  return {
    async complete(_request: AICompletionRequest): Promise<AICompletionResponse> {
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc-1", name: toolName, arguments: { accountId: "act_111111111", campaignId: "100000001" } }],
          },
          finishReason: "tool_calls",
          model: "mock",
        };
      }
      return { message: { role: "assistant", content: "done" }, finishReason: "stop", model: "mock" };
    },
    async listModels() {
      return ["mock"];
    },
    async isAvailable() {
      return true;
    },
  } as unknown as IAIProvider;
}

function orchestratorWith(gate: ToolAccessGate | undefined) {
  const { pending, store } = service();
  const create = vi.spyOn(store.approvalRepo, "create");
  const registry = new AgentRegistry();
  registry.register(new ConversationalAssistant({ provider: scriptedProvider(META_WRITE), systemPrompt: "Call tools.", temperature: 0, maxTokens: 512 }));
  const audit: AuditEntry[] = [];
  const executor: IToolExecutor = {
    execute: vi.fn(async (request: ToolExecutionRequest): Promise<ToolExecutionResult> => ({
      executionId: "x",
      toolId: request.toolId,
      status: "approval_pending",
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 1,
    })),
  };
  const orchestrator = new Orchestrator(registry, executor, { log: async (e: AuditEntry) => void audit.push(e) } as never, {
    toolRegistry: toolRegistry(writeTool(META_WRITE)),
    toolApprovalService: null as never,
    pendingActionService: pending as unknown,
    ...(gate ? { accessGate: gate } : {}),
  });
  const run = () =>
    orchestrator.process(
      { message: "pause campaign 100000001", conversationId: CONVERSATION, stream: false },
      { auth: { userId: REQUESTER, role: "member", email: "r@test.local" }, conversationId: CONVERSATION, traceId: "t-1" }
    );
  return { run, create, executor, audit, pending };
}

describe("the orchestrator refuses before a pending action exists", () => {
  it("creates no pending action, and runs nothing, for a write the caller's role could never make", async () => {
    const check = vi.fn(async () => ({
      allowed: false as const,
      reason: "Your organization role does not allow changes through Meta Ads. Ask an owner or admin of your organization.",
    }));
    const { run, create, executor, audit, pending } = orchestratorWith({ check });

    await run();

    expect(check).toHaveBeenCalledWith({ toolId: META_WRITE, userId: REQUESTER });
    expect(create).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(await pending.getActivePendingAction(CONVERSATION, REQUESTER)).toBeNull();
    expect(audit.some((e) => e.action === "agent.tool_access_denied" && e.result === "rejected")).toBe(true);
  });

  it("refuses when the gate cannot answer", async () => {
    const { run, create } = orchestratorWith({ check: vi.fn(async () => { throw new Error("tenant store down"); }) });
    await run();
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the pending action — needing someone else's approval — when the gate allows", async () => {
    const { run, create, pending } = orchestratorWith({ check: vi.fn(async () => ({ allowed: true as const })) });
    const response = await run();
    expect(create).toHaveBeenCalledTimes(1);
    expect(await pending.getActivePendingAction(CONVERSATION, REQUESTER)).toMatchObject({ needsIndependentApproval: true });
    // The chat card is told the same, from the response the chat route reads.
    const metadata = response.data?.metadata as { pendingAction?: Record<string, unknown> } | undefined;
    expect(metadata?.pendingAction).toMatchObject({ needsIndependentApproval: true });
  });
});
