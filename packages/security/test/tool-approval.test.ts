import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolApprovalService } from "../src/tool-approval.js";
import type {
  ITool,
  IApprovalRepository,
  IAuditRepository,
  IPermissionChecker,
  Approval,
  Role,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// Fake implementations
// ---------------------------------------------------------------------------

function fakeTool(overrides: Partial<ITool> & { id: string }): ITool {
  return {
    name: overrides.id,
    description: `Tool ${overrides.id}`,
    category: "system",
    risk: "READ_ONLY",
    parameters: [],
    requiresApproval: false,
    requiredPermissions: ["read"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
    ...overrides,
  };
}

function createMockApprovalRepo(): IApprovalRepository {
  const approvals: Map<string, Approval> = new Map();
  let idCounter = 0;

  return {
    create: vi.fn(async (data) => {
      idCounter++;
      const approval: Approval = {
        id: `approval-${idCounter}`,
        userId: data.userId,
        agentId: data.agentId,
        toolId: data.toolId,
        action: data.action,
        params: data.params,
        status: "pending",
        expiresAt: data.expiresAt,
        createdAt: new Date().toISOString(),
      };
      approvals.set(approval.id, approval);
      return approval;
    }),
    findById: vi.fn(async (id) => approvals.get(id) ?? null),
    updateStatus: vi.fn(async (id, status) => {
      const a = approvals.get(id);
      if (!a) return null;
      a.status = status;
      return a;
    }),
    findPending: vi.fn(async () =>
      [...approvals.values()].filter((a) => a.status === "pending")
    ),
    findExistingForTool: vi.fn(async (toolId, userId) =>
      [...approvals.values()].find(
        (a) => a.toolId === toolId && a.userId === userId
      ) ?? null
    ),
  };
}

function createMockAuditRepo(): IAuditRepository {
  const entries: unknown[] = [];
  return {
    create: vi.fn(async (entry) => {
      entries.push(entry);
      return { ...entry, id: `audit-${entries.length}`, timestamp: new Date() };
    }),
    query: vi.fn(async () => []),
  };
}

function createMockPermissionChecker(
  allowed: boolean = true
): IPermissionChecker {
  return {
    hasPermission: vi.fn(() => allowed),
    checkToolPermissions: vi.fn(() => allowed),
  };
}

const DEFAULT_REQUEST = {
  userId: "user-1",
  role: "member" as Role,
  executionId: "exec-1",
  stepIndex: 0,
  traceId: "trace-1",
  conversationId: "conv-1",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 6.4: ToolApprovalService", () => {
  let approvalRepo: ReturnType<typeof createMockApprovalRepo>;
  let auditRepo: ReturnType<typeof createMockAuditRepo>;
  let checker: ReturnType<typeof createMockPermissionChecker>;
  let service: ToolApprovalService;

  beforeEach(() => {
    approvalRepo = createMockApprovalRepo();
    auditRepo = createMockAuditRepo();
    checker = createMockPermissionChecker(true);
    service = new ToolApprovalService(approvalRepo, auditRepo, checker);
  });

  // -----------------------------------------------------------------------
  // checkPreExecution — permission & enabled checks
  // -----------------------------------------------------------------------

  describe("checkPreExecution", () => {
    it("rejects disabled tool", async () => {
      const tool = fakeTool({ id: "disabled", enabled: false });
      const result = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    it("rejects when permissions missing", async () => {
      checker = createMockPermissionChecker(false);
      service = new ToolApprovalService(approvalRepo, auditRepo, checker);
      const tool = fakeTool({ id: "write-tool", requiredPermissions: ["write"] });
      const result = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Missing permissions");
      expect(auditRepo.create).toHaveBeenCalled();
    });

    it("rejects invalid parameters", async () => {
      const tool = fakeTool({
        id: "strict",
        validate: () => false,
      });
      const result = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid parameters");
    });

    // -----------------------------------------------------------------------
    // checkPreExecution — risk levels
    // -----------------------------------------------------------------------

    it("allows READ_ONLY without approval", async () => {
      const tool = fakeTool({ id: "reader", risk: "READ_ONLY" });
      const result = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it("allows LOW_IMPACT without approval", async () => {
      const tool = fakeTool({ id: "low", risk: "LOW_IMPACT" });
      const result = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it("blocks EXTERNAL_SIDE_EFFECT until approved", async () => {
      const tool = fakeTool({ id: "external", risk: "EXTERNAL_SIDE_EFFECT" });
      const result = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
      expect(result.approvalId).toBeDefined();
    });

    it("blocks HIGH_IMPACT until approved", async () => {
      const tool = fakeTool({ id: "high", risk: "HIGH_IMPACT" });
      const result = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });

    it("blocks FINANCIAL until approved", async () => {
      const tool = fakeTool({ id: "money", risk: "FINANCIAL" });
      const result = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });

    it("allows after approval is granted", async () => {
      const tool = fakeTool({ id: "approved", risk: "HIGH_IMPACT" });

      const first = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(first.allowed).toBe(false);
      expect(first.approvalId).toBeDefined();

      await approvalRepo.updateStatus(first.approvalId!, "approved");

      const second = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(second.allowed).toBe(true);
      expect(second.requiresApproval).toBe(false);
      expect(second.approvalId).toBe(first.approvalId);
    });

    it("re-blocks after approval expires", async () => {
      const service2 = new ToolApprovalService(approvalRepo, auditRepo, checker, {
        approvalTtlMs: 1,
      });
      const tool = fakeTool({ id: "expire-test", risk: "FINANCIAL" });

      const first = await service2.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(first.allowed).toBe(false);
      await approvalRepo.updateStatus(first.approvalId!, "approved");

      await new Promise((r) => setTimeout(r, 5));

      const second = await service2.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(second.allowed).toBe(false);
      expect(second.requiresApproval).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // validateApproval
  // -----------------------------------------------------------------------

  describe("validateApproval", () => {
    it("returns valid for active approval", async () => {
      const tool = fakeTool({ id: "val-test", risk: "HIGH_IMPACT" });
      const first = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      await approvalRepo.updateStatus(first.approvalId!, "approved");

      const result = await service.validateApproval(first.approvalId!);
      expect(result.valid).toBe(true);
    });

    it("returns invalid for pending approval", async () => {
      const tool = fakeTool({ id: "pending-test", risk: "FINANCIAL" });
      const first = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);

      const result = await service.validateApproval(first.approvalId!);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("pending");
    });

    it("returns invalid for rejected approval", async () => {
      const tool = fakeTool({ id: "reject-test", risk: "FINANCIAL" });
      const first = await service.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      await approvalRepo.updateStatus(first.approvalId!, "rejected");

      const result = await service.validateApproval(first.approvalId!);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("rejected");
    });

    it("returns invalid for non-existent approval", async () => {
      const result = await service.validateApproval("non-existent");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not found");
    });
  });

  // -----------------------------------------------------------------------
  // highRiskTools config override
  // -----------------------------------------------------------------------

  describe("highRiskTools config", () => {
    it("forces approval for LOW_IMPACT when in highRiskTools", async () => {
      const svc = new ToolApprovalService(approvalRepo, auditRepo, checker, {
        highRiskTools: ["custom-low"],
      });
      const tool = fakeTool({ id: "custom-low", risk: "LOW_IMPACT" });
      const result = await svc.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // autoApproveReadOnly config
  // -----------------------------------------------------------------------

  describe("autoApproveReadOnly config", () => {
    it("does not auto-approve READ_ONLY when disabled", async () => {
      const svc = new ToolApprovalService(approvalRepo, auditRepo, checker, {
        autoApproveReadOnly: false,
      });
      const tool = fakeTool({ id: "no-auto", risk: "READ_ONLY" });
      const result = await svc.checkPreExecution(tool, {}, DEFAULT_REQUEST);
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // recordExecution
  // -----------------------------------------------------------------------

  describe("recordExecution", () => {
    it("records success audit entry", async () => {
      await service.recordExecution({
        executionId: "exec-1",
        stepIndex: 0,
        userId: "user-1",
        tool: "web_research",
        action: "Search the web",
        risk: "READ_ONLY",
        arguments: { query: "test" },
        status: "success",
        durationMs: 150,
        traceId: "trace-1",
        timestamp: new Date(),
      });

      expect(auditRepo.create).toHaveBeenCalled();
      const call = (auditRepo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.result).toBe("success");
      expect(call.toolId).toBe("web_research");
      expect(call.metadata.stepIndex).toBe(0);
      expect(call.metadata.durationMs).toBe(150);
    });

    it("records failure audit entry", async () => {
      await service.recordExecution({
        executionId: "exec-2",
        stepIndex: 1,
        userId: "user-1",
        tool: "meta_create",
        action: "Create campaign",
        risk: "FINANCIAL",
        arguments: { name: "test" },
        status: "failed",
        durationMs: 300,
        traceId: "trace-2",
        timestamp: new Date(),
        error: { code: "TOOL_EXECUTION_FAILED", message: "API error" },
      });

      const call = (auditRepo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.result).toBe("failure");
      expect(call.metadata.error.code).toBe("TOOL_EXECUTION_FAILED");
    });
  });
});
