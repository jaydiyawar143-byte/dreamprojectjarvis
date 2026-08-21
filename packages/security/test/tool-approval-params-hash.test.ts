import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolApprovalService } from "../src/tool-approval.js";
import { computeParamsHash } from "@jarvis/core";
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

function writeTool(id: string): ITool {
  return {
    id,
    name: id,
    description: `Write tool ${id}`,
    category: "meta-ads",
    risk: "FINANCIAL",
    parameters: [],
    requiresApproval: true,
    requiredPermissions: ["execute"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
  };
}

function createMockApprovalRepo(): IApprovalRepository & {
  seed(a: Approval): void;
  all(): Approval[];
} {
  const approvals: Approval[] = [];
  return {
    seed(a: Approval) {
      approvals.push(a);
    },
    all() {
      return approvals;
    },
    create: vi.fn(async (data) => {
      const approval: Approval = {
        id: `approval-${approvals.length + 1}`,
        userId: data.userId,
        agentId: data.agentId,
        toolId: data.toolId,
        action: data.action,
        params: data.params,
        paramsHash: data.paramsHash,
        status: "pending",
        expiresAt: data.expiresAt,
        createdAt: new Date().toISOString(),
      };
      approvals.push(approval);
      return approval;
    }),
    findById: vi.fn(async (id) => approvals.find((a) => a.id === id) ?? null),
    updateStatus: vi.fn(async (id, status) => {
      const a = approvals.find((x) => x.id === id);
      if (!a) return null;
      a.status = status;
      return a;
    }),
    findPending: vi.fn(async () => approvals.filter((a) => a.status === "pending")),
    findExistingForTool: vi.fn(async (toolId, userId) =>
      [...approvals]
        .reverse()
        .find((a) => a.toolId === toolId && a.userId === userId) ?? null
    ),
  };
}

function createMockAuditRepo(): IAuditRepository {
  return {
    create: vi.fn(async (entry) => ({
      ...entry,
      id: "audit-1",
      timestamp: new Date(),
    })),
    query: vi.fn(async () => []),
  };
}

function createMockPermissionChecker(): IPermissionChecker {
  return { hasPermission: vi.fn(() => true) };
}

const REQUEST = {
  userId: "user-1",
  role: "owner" as Role,
  traceId: "trace-1",
};

const BASE_PARAMS = {
  accountId: "act_2478566669291624",
  proposal: {
    name: "JARVIS_REAL_SMOKE_TEST_20260821095123",
    objective: "OUTCOME_AWARENESS",
    dailyBudget: 9576,
  },
};

function approvedApproval(
  params: Record<string, unknown>,
  overrides: Partial<Approval> = {}
): Approval {
  return {
    id: "apr_existing",
    userId: "user-1",
    toolId: "meta.campaign.create",
    action: "create campaign",
    params,
    paramsHash: computeParamsHash(params),
    status: "approved",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PHASE 9.3: approval binding to canonical params hash", () => {
  let repo: ReturnType<typeof createMockApprovalRepo>;
  let service: ToolApprovalService;

  beforeEach(() => {
    repo = createMockApprovalRepo();
    service = new ToolApprovalService(
      repo,
      createMockAuditRepo(),
      createMockPermissionChecker()
    );
  });

  it("identical params → PASS (cached approval used, no new approval)", async () => {
    repo.seed(approvedApproval(BASE_PARAMS));
    const result = await service.checkPreExecution(
      writeTool("meta.campaign.create"),
      BASE_PARAMS,
      REQUEST
    );
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.approvalId).toBe("apr_existing");
    expect(repo.create).not.toHaveBeenCalled();
  });

  it.each([
    ["campaign name changed", { ...BASE_PARAMS, proposal: { ...BASE_PARAMS.proposal, name: "CHANGED" } }],
    ["objective changed", { ...BASE_PARAMS, proposal: { ...BASE_PARAMS.proposal, objective: "OUTCOME_TRAFFIC" } }],
    ["budget changed", { ...BASE_PARAMS, proposal: { ...BASE_PARAMS.proposal, dailyBudget: 999999 } }],
    ["account changed", { ...BASE_PARAMS, accountId: "act_999999999999999" }],
  ])("%s → DENY (fresh approval required)", async (_label, changedParams) => {
    repo.seed(approvedApproval(BASE_PARAMS));
    const result = await service.checkPreExecution(
      writeTool("meta.campaign.create"),
      changedParams as Record<string, unknown>,
      REQUEST
    );
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(repo.create).toHaveBeenCalledTimes(1);
    // the fresh approval is bound to the CHANGED params, not the old ones
    const created = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.paramsHash).toBe(computeParamsHash(changedParams));
    expect(created.paramsHash).not.toBe(computeParamsHash(BASE_PARAMS));
  });

  it("expired approval → DENY even with identical params", async () => {
    repo.seed(
      approvedApproval(BASE_PARAMS, {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
    );
    const result = await service.checkPreExecution(
      writeTool("meta.campaign.create"),
      BASE_PARAMS,
      REQUEST
    );
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("legacy approval without paramsHash → DENY (fail closed)", async () => {
    const legacy = approvedApproval(BASE_PARAMS);
    delete (legacy as Partial<Approval>).paramsHash;
    repo.seed(legacy);
    const result = await service.checkPreExecution(
      writeTool("meta.campaign.create"),
      BASE_PARAMS,
      REQUEST
    );
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("new approvals store a paramsHash bound to their params", async () => {
    await service.checkPreExecution(
      writeTool("meta.campaign.create"),
      BASE_PARAMS,
      REQUEST
    );
    const created = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.paramsHash).toBe(computeParamsHash(BASE_PARAMS));
  });

  it("secret-containing params → hash stored, secret never logged", async () => {
    const SECRET = "TEST-SECRET-do-not-leak";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await service.checkPreExecution(
        writeTool("meta.campaign.create"),
        { ...BASE_PARAMS, accessToken: SECRET },
        REQUEST
      );
      const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain(SECRET);
      const created = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(created.paramsHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      logSpy.mockRestore();
    }
  });
});
