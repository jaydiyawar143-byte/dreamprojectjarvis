import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToolExecutor } from "../src/executor.js";
import { computeParamsHash } from "@jarvis/core";
import type {
  ITool,
  IPermissionChecker,
  IApprovalManager,
  AuditLogger,
  Approval,
  Role,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const BASE_PARAMS = {
  accountId: "act_2478566669291624",
  proposal: {
    name: "JARVIS_REAL_SMOKE_TEST_20260821095123",
    objective: "OUTCOME_AWARENESS",
    dailyBudget: 9576,
  },
};

function writeTool(id: string): ITool {
  return {
    name: id,
    description: `Write tool ${id}`,
    category: "meta-ads",
    risk: "FINANCIAL",
    parameters: [],
    requiresApproval: true,
    requiredPermissions: ["execute"],
    version: "1.0.0",
    enabled: true,
    execute: vi.fn(async () => ({ success: true, data: { ok: true } })),
    validate: () => true,
  };
}

function approval(
  overrides: Partial<Approval> & { params?: Record<string, unknown> }
): Approval {
  const params = overrides.params ?? BASE_PARAMS;
  return {
    id: "apr_1",
    userId: "user-1",
    toolId: "meta.campaign.create",
    action: "execute",
    params,
    paramsHash: computeParamsHash(params),
    status: "approved",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildExecutor(existing: Approval | null) {
  const registry = new Map<string, ITool>([
    ["meta.campaign.create", writeTool("meta.campaign.create")],
    ["meta.campaign.pause", writeTool("meta.campaign.pause")],
  ]);
  const perms: IPermissionChecker = { hasPermission: vi.fn(() => true) };
  const approvals: IApprovalManager = {
    requestApproval: vi.fn(async (req) => ({
      id: "apr_new",
      userId: req.userId,
      toolId: req.toolId,
      action: req.action,
      params: req.params,
      paramsHash: computeParamsHash(req.params),
      status: "pending" as const,
      expiresAt: req.expiresAt,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
    })),
    findExistingForTool: vi.fn(async () => existing),
  };
  const audit: AuditLogger = { log: vi.fn(async () => {}) } as unknown as AuditLogger;
  const executor = new ToolExecutor(
    { get: (id) => registry.get(id) },
    perms,
    approvals,
    audit
  );
  return { executor, approvals };
}

function request(overrides: {
  toolId?: string;
  userId?: string;
  params?: Record<string, unknown>;
}) {
  return {
    toolId: overrides.toolId ?? "meta.campaign.create",
    params: overrides.params ?? BASE_PARAMS,
    userId: overrides.userId ?? "user-1",
    role: "owner" as Role,
    agentId: "agent-1",
    conversationId: "conv-1",
    traceId: "trace-1",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PHASE 9.3: ToolExecutor approval bound to canonical params hash", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("identical params → PASS (approval reused, tool executes)", async () => {
    const { executor, approvals } = buildExecutor(approval({}));
    const result = await executor.execute(request({}));
    expect(result.status).toBe("completed");
    expect(approvals.requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["campaign name changed", { ...BASE_PARAMS, proposal: { ...BASE_PARAMS.proposal, name: "CHANGED" } }],
    ["objective changed", { ...BASE_PARAMS, proposal: { ...BASE_PARAMS.proposal, objective: "OUTCOME_TRAFFIC" } }],
    ["budget changed", { ...BASE_PARAMS, proposal: { ...BASE_PARAMS.proposal, dailyBudget: 999999 } }],
    ["account changed", { ...BASE_PARAMS, accountId: "act_999999999999999" }],
  ])("%s → DENY (fresh approval required, tool NOT executed)", async (_label, changed) => {
    const { executor, approvals } = buildExecutor(approval({}));
    const result = await executor.execute(request({ params: changed }));
    expect(result.status).toBe("approval_pending");
    expect(result.approvalId).toBe("apr_new");
    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    // fresh approval is requested for exactly the CHANGED params
    // (hash binding on creation is asserted in security/core suites)
    const reqArg = (approvals.requestApproval as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(reqArg.params).toEqual(changed);
  });

  it("tool changed → DENY (approval for one tool never authorizes another)", async () => {
    // simulate a broken/compromised repo returning a mismatched-tool approval
    const wrongTool = approval({ toolId: "meta.campaign.pause" });
    const { executor } = buildExecutor(wrongTool);
    const result = await executor.execute(request({ toolId: "meta.campaign.create" }));
    expect(result.status).toBe("approval_pending");
  });

  it("user changed → DENY (approval for one user never authorizes another)", async () => {
    const otherUser = approval({ userId: "user-2" });
    const { executor } = buildExecutor(otherUser);
    const result = await executor.execute(request({ userId: "user-1" }));
    expect(result.status).toBe("approval_pending");
  });

  it("expired approval → DENY even with identical params", async () => {
    const expired = approval({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const { executor } = buildExecutor(expired);
    const result = await executor.execute(request({}));
    expect(result.status).toBe("approval_pending");
  });

  it("missing paramsHash (legacy approval) → DENY (fail closed)", async () => {
    const legacy = approval({});
    delete (legacy as Partial<Approval>).paramsHash;
    const { executor } = buildExecutor(legacy);
    const result = await executor.execute(request({}));
    expect(result.status).toBe("approval_pending");
  });

  it("secret-containing params → no secret leakage in results or logs", async () => {
    const SECRET = "TEST-SECRET-do-not-leak-123-not-a-real-token";
    const { executor } = buildExecutor(null);
    const result = await executor.execute(
      request({ params: { ...BASE_PARAMS, accessToken: SECRET } })
    );
    expect(result.status).toBe("approval_pending");
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
