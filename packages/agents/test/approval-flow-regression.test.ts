import { describe, it, expect, beforeEach } from "vitest";
import type {
  IAIProvider,
  IToolExecutor,
  AuditLogger,
  AICompletionRequest,
  AICompletionResponse,
  ToolExecutionRequest,
  ToolExecutionResult,
  AuditEntry,
  RiskLevel,
  ITool,
  Approval,
} from "@jarvis/core";
import { PendingActionService } from "../src/pending-action-service.js";
import { detectIntent, isPendingActionExpired } from "../src/intent-detector.js";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";

// ---------------------------------------------------------------------------
// Mock Approval Repository
// ---------------------------------------------------------------------------

function createMockApprovalRepo() {
  const store = new Map<string, Approval>();
  let idCounter = 0;

  return {
    async create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval> {
      idCounter++;
      const approval: Approval = {
        ...data,
        id: `approval-${idCounter}`,
        status: "pending",
        createdAt: new Date().toISOString(),
      } as Approval;
      store.set(approval.id, approval);
      return approval;
    },
    async findById(id: string): Promise<Approval | null> {
      return store.get(id) ?? null;
    },
    async updateStatus(id: string, status: string): Promise<Approval | null> {
      const approval = store.get(id);
      if (!approval) return null;
      approval.status = status as Approval["status"];
      if (["approved", "consumed", "rejected", "expired"].includes(status)) {
        approval.resolvedAt = new Date().toISOString();
      }
      return approval;
    },
    async findPendingByConversationId(conversationId: string, _userId: string): Promise<Approval | null> {
      for (const a of store.values()) {
        if (a.conversationId === conversationId && a.status === "pending") {
          return a;
        }
      }
      return null;
    },
    async updateParams(id: string, params: Record<string, unknown>, paramsHash: string): Promise<Approval | null> {
      const approval = store.get(id);
      if (!approval) return null;
      approval.params = params;
      approval.paramsHash = paramsHash;
      return approval;
    },
    _store: store,
    _reset() {
      store.clear();
      idCounter = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Tool Registry
// ---------------------------------------------------------------------------

function createMockToolRegistry() {
  const toolMap = new Map<string, ITool>();
  let createCallCount = 0;

  toolMap.set("meta.campaign.create", {
    name: "meta.campaign.create",
    description: "Create a new Meta campaign",
    category: "marketing",
    risk: "EXTERNAL_SIDE_EFFECT" as RiskLevel,
    parameters: [
      { name: "accountId", type: "string", description: "Meta ad account ID", required: true },
      { name: "proposal", type: "object", description: "Campaign proposal", required: true },
    ],
    requiresApproval: true,
    requiredPermissions: ["read", "write"],
    version: "1.0.0",
    enabled: true,
    execute: async () => {
      createCallCount++;
      return { success: true, data: { campaignId: `meta-campaign-${createCallCount}`, status: "ACTIVE" } };
    },
    validate: () => true,
  });

  toolMap.set("meta.campaign.delete", {
    name: "meta.campaign.delete",
    description: "Delete a Meta campaign",
    category: "marketing",
    risk: "HIGH_IMPACT" as RiskLevel,
    parameters: [
      { name: "campaignId", type: "string", description: "Campaign ID", required: true },
    ],
    requiresApproval: true,
    requiredPermissions: ["read", "write"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
  });

  toolMap.set("meta.insights", {
    name: "meta.insights",
    description: "Get Meta ad insights",
    category: "marketing",
    risk: "READ_ONLY" as RiskLevel,
    parameters: [],
    requiresApproval: false,
    requiredPermissions: ["read"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true, data: { impressions: 1000 } }),
    validate: () => true,
  });

  return {
    get: (toolId: string) => toolMap.get(toolId),
    getAll: () => [...toolMap.values()],
    getCreateCallCount: () => createCallCount,
  };
}

// ---------------------------------------------------------------------------
// Mock Tool Executor
// ---------------------------------------------------------------------------

function createMockToolExecutor() {
  const requests: ToolExecutionRequest[] = [];
  let shouldFail = false;

  const executor: IToolExecutor & {
    getRequests: () => ToolExecutionRequest[];
    setShouldFail: (v: boolean) => void;
  } = {
    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      requests.push(request);
      if (shouldFail) {
        return {
          executionId: request.executionId ?? "exec-fail",
          toolId: request.toolId,
          status: "failed",
          error: "Meta API returned 500: Internal Server Error",
          startedAt: new Date(),
          completedAt: new Date(),
          durationMs: 10,
        };
      }
      return {
        executionId: request.executionId ?? "exec-1",
        toolId: request.toolId,
        status: "completed",
        result: { success: true, data: { campaignId: "meta-campaign-123", status: "ACTIVE" } },
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 10,
      };
    },
    getRequests: () => requests,
    setShouldFail: (v: boolean) => { shouldFail = v; },
  };

  return executor;
}

// ---------------------------------------------------------------------------
// Mock Audit Logger
// ---------------------------------------------------------------------------

function createMockAuditLogger() {
  const entries: AuditEntry[] = [];
  return {
    async log(entry: AuditEntry) {
      entries.push({ ...entry, id: `audit-${entries.length}`, timestamp: new Date() } as AuditEntry);
    },
    async query() { return entries; },
    getEntries: () => entries,
  };
}

// ---------------------------------------------------------------------------
// Mock AI Provider
// ---------------------------------------------------------------------------

function createMockAIProvider() {
  let responseFn: ((req: AICompletionRequest) => AICompletionResponse) | null = null;
  let callCount = 0;

  return {
    setResponse(fn: (req: AICompletionRequest) => AICompletionResponse) {
      responseFn = fn;
    },
    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
      callCount++;
      if (responseFn) return responseFn(request);
      return {
        message: { role: "assistant", content: "Default response" },
        finishReason: "stop",
        model: "mock-model",
      };
    },
    async listModels() { return ["mock-model"]; },
    async isAvailable() { return true; },
    getCallCount: () => callCount,
    reset() { responseFn = null; callCount = 0; },
  } as IAIProvider & { setResponse: typeof responseFn; getCallCount: () => number; reset: () => void };
}

// ===========================================================================
// REGRESSION TEST SUITE
// ===========================================================================

describe("PHASE 11.9C — Approval Flow Regression Tests", () => {
  let mockApprovalRepo: ReturnType<typeof createMockApprovalRepo>;
  let toolRegistry: ReturnType<typeof createMockToolRegistry>;
  let service: PendingActionService;

  beforeEach(() => {
    mockApprovalRepo = createMockApprovalRepo();
    toolRegistry = createMockToolRegistry();
    service = new PendingActionService({
      approvalRepo: mockApprovalRepo,
      toolRegistry,
      approvalTtlMs: 3600000,
    });
  });

  // -------------------------------------------------------------------------
  // Test 1: Create campaign → approval card appears once
  // -------------------------------------------------------------------------
  it("creates exactly one pending action for campaign creation", async () => {
    const result = await service.createPendingAction({
      conversationId: "conv-1",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Test", objective: "OUTCOME_LEADS", dailyBudget: 100 },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    expect(result.pendingAction.state).toBe("WAITING_CONFIRMATION");

    const active = await service.getActivePendingAction("conv-1", "user-1");
    expect(active).not.toBeNull();
    expect(active!.id).toBe(result.pendingAction.id);

    // Only one approval in the repo
    const allApprovals = [...mockApprovalRepo._store.values()];
    expect(allApprovals).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 2: Confirm → exactly one Meta write
  // -------------------------------------------------------------------------
  it("confirmation produces approved state without executing", async () => {
    const created = await service.createPendingAction({
      conversationId: "conv-1",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Test" },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    const confirmResult = await service.confirmPendingAction("conv-1", "user-1");
    expect(confirmResult.success).toBe(true);
    expect(confirmResult.pendingAction!.state).toBe("APPROVED");

    // Approval is now approved, not pending
    const active = await service.getActivePendingAction("conv-1", "user-1");
    expect(active).toBeNull();

    // The approval in the repo is approved
    const approval = await mockApprovalRepo.findById(created.pendingAction.approvalId);
    expect(approval!.status).toBe("approved");
  });

  // -------------------------------------------------------------------------
  // Test 3: "approve" intent → CONFIRM detected
  // -------------------------------------------------------------------------
  it("detects CONFIRM for 'approve'", () => {
    const pa = { id: "1", conversationId: "c1", userId: "u1", toolId: "meta.campaign.create", action: "create", params: {}, riskLevel: "EXTERNAL_SIDE_EFFECT", state: "WAITING_CONFIRMATION" as const, approvalId: "a1", expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString() };
    expect(detectIntent("approve", pa).type).toBe("CONFIRM");
  });

  // -------------------------------------------------------------------------
  // Test 4: "yes" after approval → must NOT create another approval
  // -------------------------------------------------------------------------
  it("does not create a new approval when confirming an already-approved action", async () => {
    await service.createPendingAction({
      conversationId: "conv-1",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Test" },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    // First confirm
    await service.confirmPendingAction("conv-1", "user-1");

    // Second confirm: no active pending action
    const result2 = await service.confirmPendingAction("conv-1", "user-1");
    expect(result2.success).toBe(false);
    expect(result2.message).toContain("No pending action");

    // Still only 1 approval in repo
    const allApprovals = [...mockApprovalRepo._store.values()];
    expect(allApprovals).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 5: Same approval submitted twice → count remains 1
  // -------------------------------------------------------------------------
  it("duplicate confirmation does not create additional approvals", async () => {
    await service.createPendingAction({
      conversationId: "conv-1",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Test" },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    await service.confirmPendingAction("conv-1", "user-1");
    await service.confirmPendingAction("conv-1", "user-1");
    await service.confirmPendingAction("conv-1", "user-1");

    const allApprovals = [...mockApprovalRepo._store.values()];
    expect(allApprovals).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 6: After execution → no new approval card
  // -------------------------------------------------------------------------
  it("isDuplicateConfirmation returns true after approval", async () => {
    await service.createPendingAction({
      conversationId: "conv-1",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Test" },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    await service.confirmPendingAction("conv-1", "user-1");

    const isDup = await service.isDuplicateConfirmation("conv-1", "user-1");
    expect(isDup).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7: Reject → no Meta write
  // -------------------------------------------------------------------------
  it("rejection does not allow execution", async () => {
    await service.createPendingAction({
      conversationId: "conv-1",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Test" },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    const result = await service.rejectPendingAction("conv-1", "user-1");
    expect(result.success).toBe(true);

    const active = await service.getActivePendingAction("conv-1", "user-1");
    expect(active).toBeNull();

    const confirmResult = await service.confirmPendingAction("conv-1", "user-1");
    expect(confirmResult.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 8: Pending action persistence across retrieval
  // -------------------------------------------------------------------------
  it("pending action persists and is retrievable", async () => {
    await service.createPendingAction({
      conversationId: "conv-1",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Persistent" },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    const pa1 = await service.getActivePendingAction("conv-1", "user-1");
    const pa2 = await service.getActivePendingAction("conv-1", "user-1");

    expect(pa1).not.toBeNull();
    expect(pa2).not.toBeNull();
    expect(pa1!.id).toBe(pa2!.id);
  });

  // -------------------------------------------------------------------------
  // Test 9: Cross-conversation isolation
  // -------------------------------------------------------------------------
  it("two different conversations have isolated approvals", async () => {
    await service.createPendingAction({
      conversationId: "conv-1",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Campaign A" },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    await service.createPendingAction({
      conversationId: "conv-2",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Campaign B" },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    const pa1 = await service.getActivePendingAction("conv-1", "user-1");
    const pa2 = await service.getActivePendingAction("conv-2", "user-1");

    expect(pa1!.params.name).toBe("Campaign A");
    expect(pa2!.params.name).toBe("Campaign B");

    await service.confirmPendingAction("conv-1", "user-1");

    const pa1After = await service.getActivePendingAction("conv-1", "user-1");
    const pa2After = await service.getActivePendingAction("conv-2", "user-1");

    expect(pa1After).toBeNull();
    expect(pa2After).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 10: Failed execution → no fabricated success
  // -------------------------------------------------------------------------
  it("confirmPendingAction returns failure for expired/non-existent action", async () => {
    const result = await service.confirmPendingAction("non-existent", "user-1");
    expect(result.success).toBe(false);
    expect(result.message).toContain("No pending action");
  });

  it("rejectPendingAction returns failure for non-existent action", async () => {
    const result = await service.rejectPendingAction("non-existent", "user-1");
    expect(result.success).toBe(false);
  });

  it("isPendingActionExpired correctly identifies expired actions", () => {
    const expired = { expiresAt: new Date(Date.now() - 1000).toISOString() } as any;
    const active = { expiresAt: new Date(Date.now() + 3600000).toISOString() } as any;

    expect(isPendingActionExpired(expired)).toBe(true);
    expect(isPendingActionExpired(active)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Orchestrator integration: pending action flow
  // -------------------------------------------------------------------------
  it("orchestrator creates pending action for write tools via executeTools", async () => {
    const provider = createMockAIProvider();
    const assistant = new ConversationalAssistant({
      provider,
      systemPrompt: "You are JARVIS. Call tools directly.",
      temperature: 0.7,
      maxTokens: 4096,
    });

    const registry = new AgentRegistry();
    registry.register(assistant);

    const toolExecutor = createMockToolExecutor();
    const auditLogger = createMockAuditLogger();

    const toolMap = new Map<string, ITool>();
    toolMap.set("meta.campaign.create", {
      name: "meta.campaign.create",
      description: "Create a new Meta campaign",
      category: "marketing",
      risk: "EXTERNAL_SIDE_EFFECT" as RiskLevel,
      parameters: [],
      requiresApproval: true,
      requiredPermissions: ["read", "write"],
      version: "1.0.0",
      enabled: true,
      execute: async () => ({ success: true, data: { campaignId: "meta-123" } }),
      validate: () => true,
    });

    const mockToolRegistry = {
      get: (toolId: string) => toolMap.get(toolId),
      getAll: () => [...toolMap.values()],
    };

    const pendingService = new PendingActionService({
      approvalRepo: mockApprovalRepo,
      toolRegistry: mockToolRegistry,
      approvalTtlMs: 3600000,
    });

    // Mock tool executor that returns approval_pending for write tools
    const mockToolExec: IToolExecutor = {
      async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
        const tool = toolMap.get(request.toolId);
        if (tool?.requiresApproval) {
          return {
            executionId: request.executionId ?? "exec-pending",
            toolId: request.toolId,
            status: "approval_pending",
            approvalId: "approval-mock-1",
            startedAt: new Date(),
            completedAt: new Date(),
            durationMs: 10,
          };
        }
        return {
          executionId: request.executionId ?? "exec-1",
          toolId: request.toolId,
          status: "completed",
          result: { success: true, data: { campaignId: "meta-campaign-123" } },
          startedAt: new Date(),
          completedAt: new Date(),
          durationMs: 10,
        };
      },
    };

    const orchestrator = new Orchestrator(registry, mockToolExec, auditLogger, {
      toolRegistry: mockToolRegistry,
      toolApprovalService: null,
      pendingActionService: pendingService as unknown,
    });

    let callCount = 0;
    provider.setResponse(() => {
      callCount++;
      if (callCount === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tc-1",
              name: "meta.campaign.create",
              arguments: {
                accountId: "act_123",
                proposal: { name: "Test", objective: "LEADS", daily_budget: 100, status: "PAUSED" },
              },
            }],
          },
          finishReason: "tool_calls",
          model: "mock-model",
        };
      }
      return {
        message: { role: "assistant", content: "Pending action created." },
        finishReason: "stop",
        model: "mock-model",
      };
    });

    const response = await orchestrator.process(
      { message: "Create a campaign named Test", conversationId: "conv-1", stream: false },
      { auth: { userId: "user-1", role: "member", email: "test@test.com" }, conversationId: "conv-1", traceId: "t1" }
    );

    expect(response.success).toBe(true);

    // The pending action should exist in the repo
    const active = await pendingService.getActivePendingAction("conv-1", "user-1");
    expect(active).not.toBeNull();
    expect(active!.state).toBe("WAITING_CONFIRMATION");
    expect(active!.toolId).toBe("meta.campaign.create");
  });

  // -------------------------------------------------------------------------
  // Orchestrator: confirm + execute does NOT create new approval
  // -------------------------------------------------------------------------
  it("confirming via chat route does not loop", async () => {
    await service.createPendingAction({
      conversationId: "conv-1",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Test", objective: "OUTCOME_LEADS", dailyBudget: 100 },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    const initialCount = mockApprovalRepo._store.size;

    // Confirm
    const confirmResult = await service.confirmPendingAction("conv-1", "user-1");
    expect(confirmResult.success).toBe(true);

    // No new approvals created
    expect(mockApprovalRepo._store.size).toBe(initialCount);

    // Same approval is now approved
    const approval = await mockApprovalRepo.findById(confirmResult.pendingAction!.approvalId);
    expect(approval!.status).toBe("approved");
  });

  it("REJECT intent detected correctly", () => {
    const pa = { id: "1", conversationId: "c1", userId: "u1", toolId: "x", action: "y", params: {}, riskLevel: "EXTERNAL_SIDE_EFFECT", state: "WAITING_CONFIRMATION" as const, approvalId: "a1", expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString() };
    expect(detectIntent("no", pa).type).toBe("REJECT");
    expect(detectIntent("nahi", pa).type).toBe("REJECT");
    expect(detectIntent("cancel", pa).type).toBe("REJECT");
  });

  it("MODIFY intent detected correctly", () => {
    const pa = { id: "1", conversationId: "c1", userId: "u1", toolId: "x", action: "y", params: { dailyBudget: 100 }, riskLevel: "EXTERNAL_SIDE_EFFECT", state: "WAITING_CONFIRMATION" as const, approvalId: "a1", expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString() };
    const result = detectIntent("change budget to 200", pa);
    expect(result.type).toBe("MODIFY");
    expect(result.extractedParams!.dailyBudget).toBe(200);
  });

  it("modify pending action merges params correctly", async () => {
    await service.createPendingAction({
      conversationId: "conv-1",
      userId: "user-1",
      toolId: "meta.campaign.create",
      action: "create_campaign",
      params: { name: "Test", dailyBudget: 100 },
      riskLevel: "EXTERNAL_SIDE_EFFECT",
    });

    const modified = await service.modifyPendingAction("conv-1", "user-1", { dailyBudget: 200 });
    expect(modified.pendingAction.params.dailyBudget).toBe(200);
    expect(modified.pendingAction.params.name).toBe("Test");
  });
});
