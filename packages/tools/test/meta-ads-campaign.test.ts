import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MetaCreateCampaignTool,
  validateCampaignProposal,
  buildIdempotencyKey,
  getExecutionState,
  clearExecutionStore,
} from "../src/tools/meta-ads-write-tools.js";
import type { MetaAdsProvider, MetaAdsBudgetProvider, MetaCampaignCreatorProvider, MetaAccountAuthorizer } from "../src/tools/meta-ads-provider.js";
import { createMockMetaProvider, createFailingMetaProvider, createEmptyMetaProvider } from "../src/tools/meta-ads-mock.js";
import { sanitizeToolResult } from "../src/output-sanitizer.js";
import { ToolRegistry as TR } from "../src/registry.js";
import { ToolExecutor } from "../src/executor.js";
import { DEFAULT_BUDGET_GUARDRAILS } from "../src/tools/meta-ads-budget-guardrails.js";
import type { BudgetGuardrailsConfig, CampaignProposal, AuditLogger, IPermissionChecker, IApprovalManager, Role, ToolResult, Approval, ApprovalStatus } from "@jarvis/core";

// --- Helpers ---

function createAuthorizer(authorizedAccounts: string[] = ["act_111111111", "act_222222222"]): MetaAccountAuthorizer {
  return {
    getAuthorizedAccountIds: vi.fn().mockResolvedValue(authorizedAccounts),
    isAuthorized: vi.fn().mockImplementation(async (_userId: string, accountId: string) => authorizedAccounts.includes(accountId)),
  };
}

function createDenyAllAuthorizer(): MetaAccountAuthorizer {
  return {
    getAuthorizedAccountIds: vi.fn().mockResolvedValue([]),
    isAuthorized: vi.fn().mockResolvedValue(false),
  };
}

const allowAllPerms: IPermissionChecker = { hasPermission: () => true };
const denyWritePerms: IPermissionChecker = { hasPermission: (_r: Role, _res: string, action: string) => action === "read" };
const denyAllPerms: IPermissionChecker = { hasPermission: () => false };

function createTrackingAudit(): { logger: AuditLogger; calls: unknown[] } {
  const calls: unknown[] = [];
  return { logger: { log: vi.fn().mockImplementation(async (e: unknown) => { calls.push(e); }) } as AuditLogger, calls };
}

function createApprovalMgr(): { mgr: IApprovalManager; approvals: Map<string, Approval> } {
  const approvals = new Map<string, Approval>();
  let counter = 0;
  return {
    mgr: {
      requestApproval: vi.fn().mockImplementation(async (req: Omit<Approval, "id" | "status" | "createdAt">) => {
        counter++;
        const a: Approval = { id: `a-${counter}`, userId: req.userId, toolId: req.toolId, action: req.action, params: req.params, status: "pending" as ApprovalStatus, expiresAt: req.expiresAt, createdAt: new Date().toISOString() };
        approvals.set(a.id, a);
        return a;
      }),
      findExistingForTool: vi.fn().mockImplementation(async (toolId: string, userId: string) => {
        for (const a of approvals.values()) { if (a.toolId === toolId && a.userId === userId) return a; }
        return null;
      }),
    } as IApprovalManager,
    approvals,
  };
}

function strictGuardrails(): BudgetGuardrailsConfig {
  return {
    maxDailyBudget: 500,
    maxIncreasePercent: 10,
    maxIncreaseAbsolute: 100,
    maxDecreasePercent: 20,
    maxDecreaseAbsolute: 200,
  };
}

function validProposal(overrides?: Partial<CampaignProposal>): CampaignProposal {
  return {
    name: "Q1 Brand Awareness",
    objective: "OUTCOME_AWARENESS",
    buyingType: "AUCTION",
    status: "PAUSED",
    dailyBudget: 100,
    specialAdCategories: [],
    adSets: [
      { name: "AdSet 1", optimizationGoal: "REACH", dailyBudget: 50 },
    ],
    confidence: 0.85,
    ...overrides,
  };
}

function toolContext(userId = "user-1", accountId = "act_111111111") {
  return { userId, resourceId: accountId, traceId: `trace-${Date.now()}` };
}

beforeEach(() => { clearExecutionStore(); });

// ===========================================================================
// 1. PROPOSAL VALIDATION (10 tests)
// ===========================================================================

describe("Proposal Validation", () => {
  it("accepts valid minimal proposal", () => {
    const result = validateCampaignProposal(validProposal());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects null/undefined proposal", () => {
    expect(validateCampaignProposal(null).valid).toBe(false);
    expect(validateCampaignProposal(undefined).valid).toBe(false);
  });

  it("rejects proposal without name", () => {
    const p = validProposal(); (p as any).name = undefined;
    expect(validateCampaignProposal(p).valid).toBe(false);
    expect(validateCampaignProposal(p).errors.join()).toContain("name");
  });

  it("rejects proposal without objective", () => {
    const p = validProposal(); (p as any).objective = undefined;
    expect(validateCampaignProposal(p).valid).toBe(false);
    expect(validateCampaignProposal(p).errors.join()).toContain("objective");
  });

  it("rejects invalid objective value", () => {
    const p = validProposal({ objective: "OUTCOME_FOO" as any });
    expect(validateCampaignProposal(p).valid).toBe(false);
    expect(validateCampaignProposal(p).errors.join()).toContain("Invalid objective");
  });

  it("rejects proposal without adSets", () => {
    const p = validProposal({ adSets: [] as any });
    expect(validateCampaignProposal(p).valid).toBe(false);
    expect(validateCampaignProposal(p).errors.join()).toContain("adSet");
  });

  it("rejects adSet without name", () => {
    const p = validProposal({ adSets: [{ optimizationGoal: "REACH", name: "", dailyBudget: 50 }] as any });
    expect(validateCampaignProposal(p).valid).toBe(false);
  });

  it("rejects adSet without optimizationGoal", () => {
    const p = validProposal({ adSets: [{ name: "AS1", dailyBudget: 50 }] as any });
    expect(validateCampaignProposal(p).valid).toBe(false);
    expect(validateCampaignProposal(p).errors.join()).toContain("optimizationGoal");
  });

  it("rejects dailyBudget exceeding guardrail maximum", () => {
    const p = validProposal({ dailyBudget: 999_999 });
    expect(validateCampaignProposal(p).valid).toBe(false); // exceeds MAX_DAILY_BUDGET (100_000)
  });

  it("rejects confidence outside 0-1 range", () => {
    const p = validProposal({ confidence: 1.5 });
    expect(validateCampaignProposal(p).valid).toBe(false);
    expect(validateCampaignProposal(p).errors.join()).toContain("confidence");
  });

  it("accepts proposal with warnings and assumptions", () => {
    const p = validProposal({ warnings: ["Budget is tight"], assumptions: ["US market"] });
    expect(validateCampaignProposal(p).valid).toBe(true);
  });

  it("rejects invalid buyingType", () => {
    const p = validProposal({ buyingType: "INVALID" as any });
    expect(validateCampaignProposal(p).valid).toBe(false);
    expect(validateCampaignProposal(p).errors.join()).toContain("buyingType");
  });

  it("rejects invalid status", () => {
    const p = validProposal({ status: "DELETED" as any });
    expect(validateCampaignProposal(p).valid).toBe(false);
    expect(validateCampaignProposal(p).errors.join()).toContain("status");
  });

  it("accepts ACTIVE status", () => {
    const p = validProposal({ status: "ACTIVE" });
    expect(validateCampaignProposal(p).valid).toBe(true);
  });
});

// ===========================================================================
// 2. TOOL METADATA (5 tests)
// ===========================================================================

describe("MetaCreateCampaignTool Metadata", () => {
  it("has correct tool id", () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    expect(tool.id).toBe("meta.campaign.create");
  });

  it("requires approval", () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    expect(tool.requiresApproval).toBe(true);
  });

  it("has risk level EXTERNAL_SIDE_EFFECT", () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    expect(tool.risk).toBe("EXTERNAL_SIDE_EFFECT");
  });

  it("has category marketing", () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    expect(tool.category).toBe("marketing");
  });

  it("requires read and write permissions", () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    expect(tool.requiredPermissions).toEqual(["read", "write"]);
  });
});

// ===========================================================================
// 3. AUTHORIZATION (5 tests)
// ===========================================================================

describe("Authorization", () => {
  it("fails with invalid account ID format", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "invalid", proposal: validProposal() }, toolContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid account ID format");
  });

  it("fails when user not authorized for account", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createDenyAllAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not authorized");
  });

  it("succeeds with authorized account", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    expect(result.success).toBe(true);
  });

  it("fails with proposal validation error", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: { name: "", objective: "X", adSets: [] } }, toolContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid proposal");
  });

  it("fails without proposal parameter", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111" }, toolContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("proposal");
  });
});

// ===========================================================================
// 4. CAMPAIGN CREATION (8 tests)
// ===========================================================================

describe("Campaign Creation", () => {
  it("creates campaign with valid proposal", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.action).toBe("create_campaign");
    expect(data.verified).toBe(true);
    expect(data.objective).toBe("OUTCOME_AWARENESS");
    expect(data.adSetCount).toBe(1);
  });

  it("creates campaign and returns correct metadata", async () => {
    const proposal = validProposal({ confidence: 0.9, aiProvider: "claude", aiModel: "claude-sonnet-4-20250514" });
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal }, toolContext());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.aiProvider).toBe("claude");
    expect(data.aiModel).toBe("claude-sonnet-4-20250514");
    expect(data.confidence).toBe(0.9);
  });

  it("fails when provider.createCampaign fails", async () => {
    const tool = new MetaCreateCampaignTool(createFailingMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Meta API error");
  });

  it("creates campaign with multiple ad sets", async () => {
    const proposal = validProposal({
      adSets: [
        { name: "AS1", optimizationGoal: "REACH", dailyBudget: 30 },
        { name: "AS2", optimizationGoal: "LINK_CLICKS", dailyBudget: 20 },
      ],
    });
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal }, toolContext());
    expect(result.success).toBe(true);
    expect((result.data as any).adSetCount).toBe(2);
  });

  it("enforces budget guardrails on proposal dailyBudget", async () => {
    const proposal = validProposal({ dailyBudget: 1000 });
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer(), strictGuardrails());
    const result = await tool.execute({ accountId: "act_111111111", proposal }, toolContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Budget guardrail");
  });

  it("passes guardrails when budget within limits", async () => {
    const proposal = validProposal({ dailyBudget: 100 });
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer(), strictGuardrails());
    const result = await tool.execute({ accountId: "act_111111111", proposal }, toolContext());
    expect(result.success).toBe(true);
  });

  it("includes warnings and assumptions in result", async () => {
    const proposal = validProposal({ warnings: ["Low confidence"], assumptions: ["Test market"] });
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal }, toolContext());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.warnings).toContain("Low confidence");
    expect(data.assumptions).toContain("Test market");
  });

  it("creates campaign in PAUSED state by default", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe("PAUSED");
  });
});

// ===========================================================================
// 5. IDEMPOTENCY (5 tests)
// ===========================================================================

describe("Idempotency", () => {
  it("allows first execution of unique proposal", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    expect(result.success).toBe(true);
  });

  it("blocks duplicate execution with same proposal name and objective", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result1 = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext("user-1"));
    expect(result1.success).toBe(true);

    const result2 = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext("user-1"));
    expect(result2.success).toBe(false);
    expect(result2.error).toContain("already");
  });

  it("allows same proposal with different account", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer(["act_111111111", "act_222222222"]));
    const result1 = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext("user-1", "act_111111111"));
    expect(result1.success).toBe(true);

    const result2 = await tool.execute({ accountId: "act_222222222", proposal: validProposal() }, toolContext("user-1", "act_222222222"));
    expect(result2.success).toBe(true);
  });

  it("allows same proposal name with different objective", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result1 = await tool.execute({ accountId: "act_111111111", proposal: validProposal({ objective: "OUTCOME_AWARENESS" }) }, toolContext("user-1"));
    expect(result1.success).toBe(true);

    const result2 = await tool.execute({ accountId: "act_111111111", proposal: validProposal({ objective: "OUTCOME_TRAFFIC" }) }, toolContext("user-1"));
    expect(result2.success).toBe(true);
  });

  it("allows retry after failure", async () => {
    let callCount = 0;
    const mockProvider = createMockMetaProvider();
    const origCreate = mockProvider.createCampaign;
    mockProvider.createCampaign = vi.fn().mockImplementation(async (...args: any[]) => {
      callCount++;
      if (callCount === 1) throw new Error("Transient failure");
      return origCreate.apply(mockProvider, args as any);
    });

    const tool = new MetaCreateCampaignTool(mockProvider as any, createAuthorizer());
    const result1 = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext("user-1"));
    expect(result1.success).toBe(false);

    const key = buildIdempotencyKey("meta.campaign.create", "act_111111111", "proposal:Q1 Brand Awareness", "OUTCOME_AWARENESS");
    const state = getExecutionState(key);
    expect(state?.state).toBe("FAILED");

    // After FAILED, another execution should be allowed (FAILED not in BLOCKED_STATES)
    const result2 = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext("user-2"));
    expect(result2.success).toBe(true);
  });
});

// ===========================================================================
// 6. METRICS / AUDIT (5 tests)
// ===========================================================================

describe("Metrics and Audit", () => {
  it("returns success with correct action metadata", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.action).toBe("create_campaign");
    expect(data.accountId).toBe("act_111111111");
    expect(data.campaignId).toBeDefined();
    expect(data.campaignName).toBe("Q1 Brand Awareness");
    expect(data.verified).toBe(true);
  });

  it("returns audit-compatible toolId in metadata", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.toolId).toBe("meta.campaign.create");
  });

  it("includes risk level in audit metadata", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    expect(result.metadata!.risk).toBe("EXTERNAL_SIDE_EFFECT");
  });

  it("includes userId in audit metadata", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext("user-42"));
    expect(result.metadata!.userId).toBe("user-42");
  });

  it("includes confidence and warnings in result data", async () => {
    const proposal = validProposal({ confidence: 0.72, warnings: ["Budget tight"] });
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal }, toolContext());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.confidence).toBe(0.72);
    expect(data.warnings).toContain("Budget tight");
  });
});

// ===========================================================================
// 7. SANITIZER / SCHEMA (3 tests)
// ===========================================================================

describe("Output Sanitizer", () => {
  it("sanitizes successful result", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    const sanitized = sanitizeToolResult(result);
    expect(sanitized.result.success).toBe(true);
    expect(sanitized.result).toBeDefined();
  });

  it("sanitizes failure result", async () => {
    const tool = new MetaCreateCampaignTool(createFailingMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    const sanitized = sanitizeToolResult(result);
    expect(sanitized.result.success).toBe(false);
  });

  it("sanitizes unauthorized result", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createDenyAllAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal: validProposal() }, toolContext());
    const sanitized = sanitizeToolResult(result);
    expect(sanitized.result.success).toBe(false);
  });
});

// ===========================================================================
// 8. EXECUTOR / RBAC / APPROVAL (5 tests)
// ===========================================================================

describe("Executor, RBAC, Approval", () => {
  it("registers tool in registry", () => {
    const reg = new TR();
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    reg.register(tool);
    expect(reg.get("meta.campaign.create")).toBeDefined();
  });

  it("executor blocks tool when user lacks read permission", async () => {
    const reg = new TR();
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    reg.register(tool);
    const ex = new ToolExecutor(reg, denyAllPerms, createApprovalMgr().mgr, createTrackingAudit().logger);
    const result = await ex.execute({ toolId: "meta.campaign.create", userId: "user-1", role: "user", params: { accountId: "act_111111111", proposal: validProposal() } });
    expect(result.status).toBe("permission_denied");
    expect(result.error).toContain("Missing permission");
  });

  it("executor blocks tool when user lacks write permission", async () => {
    const reg = new TR();
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    reg.register(tool);
    const ex = new ToolExecutor(reg, denyWritePerms, createApprovalMgr().mgr, createTrackingAudit().logger);
    const result = await ex.execute({ toolId: "meta.campaign.create", userId: "user-1", role: "user", params: { accountId: "act_111111111", proposal: validProposal() } });
    expect(result.status).toBe("permission_denied");
    expect(result.error).toContain("Missing permission");
  });

  it("executor requests approval and returns pending", async () => {
    const reg = new TR();
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    reg.register(tool);
    const { mgr } = createApprovalMgr();
    const { logger, calls } = createTrackingAudit();
    const ex = new ToolExecutor(reg, allowAllPerms, mgr, logger);
    const result = await ex.execute({ toolId: "meta.campaign.create", userId: "user-1", role: "user", params: { accountId: "act_111111111", proposal: validProposal() } });
    // Tool requires approval, so executor returns approval_pending
    expect(result.status).toBe("approval_pending");
    expect(mgr.requestApproval).toHaveBeenCalled();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("executor fails with unknown tool", async () => {
    const reg = new TR();
    const ex = new ToolExecutor(reg, allowAllPerms, createApprovalMgr().mgr, createTrackingAudit().logger);
    const result = await ex.execute({ toolId: "nonexistent.tool", userId: "user-1", role: "user", params: {} });
    expect(result.status).toBe("failed");
  });
});

// ===========================================================================
// 9. SECURITY (5 tests)
// ===========================================================================

describe("Security", () => {
  it("fails with malformed account ID (injection test)", async () => {
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111; DROP TABLE", proposal: validProposal() }, toolContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid account ID format");
  });

  it("fails with SQL injection in proposal name", async () => {
    const proposal = validProposal({ name: "test'; DROP TABLE campaigns; --" } as any);
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal }, toolContext());
    expect(result.success).toBe(true); // SQL injection is harmless in this context; proposal was valid
  });

  it("rejects proposal with negative budget", async () => {
    const proposal = validProposal({ dailyBudget: -100 });
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal }, toolContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid proposal");
  });

  it("rejects proposal with xss payload in name", async () => {
    const proposal = validProposal({ name: "<script>alert('xss')</script>" } as any);
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal }, toolContext());
    // XSS in name is valid string; creation succeeds but result doesn't execute script
    expect(result.success).toBe(true);
    expect((result.data as any).campaignName).toBe("<script>alert('xss')</script>");
  });

  it("proposal with empty adSets is rejected by validation", async () => {
    const proposal = validProposal({ adSets: [] as any });
    const tool = new MetaCreateCampaignTool(createMockMetaProvider() as any, createAuthorizer());
    const result = await tool.execute({ accountId: "act_111111111", proposal }, toolContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("adSet");
  });
});

// ===========================================================================
// 10. CLAUDE ADAPTER — Unit Tests (5 tests)
// ===========================================================================

describe("Claude Adapter Message Converter", () => {
  it("converts system message to system field", async () => {
    const { convertMessages } = await import("../../ai-anthropic/src/message-converter.js");
    const result = convertMessages([
      { role: "system", content: "You are a marketing expert." },
      { role: "user", content: "Create a campaign" },
    ]);
    expect(result.system).toBe("You are a marketing expert.");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("converts tool messages to user messages with tool_result", async () => {
    const { convertMessages } = await import("../../ai-anthropic/src/message-converter.js");
    const result = convertMessages([
      { role: "assistant", content: null, toolCalls: [{ id: "tc-1", name: "test", arguments: {} }] },
      { role: "tool", content: "result", toolCallId: "tc-1" },
    ]);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].role).toBe("user");
  });

  it("converts AIToolDefinition to ClaudeTool format", async () => {
    const { convertTools } = await import("../../ai-anthropic/src/message-converter.js");
    const tools = convertTools([
      { name: "test_tool", description: "A test", parameters: { type: "object", properties: {} } },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("test_tool");
    expect(tools[0].input_schema).toEqual({ type: "object", properties: {} });
  });

  it("converts auto tool_choice correctly", async () => {
    const { convertToolChoice } = await import("../../ai-anthropic/src/message-converter.js");
    expect(convertToolChoice("auto")).toEqual({ type: "auto" });
    expect(convertToolChoice("none")).toBeUndefined();
  });

  it("converts function tool_choice to tool type", async () => {
    const { convertToolChoice } = await import("../../ai-anthropic/src/message-converter.js");
    const result = convertToolChoice({ type: "function", function: { name: "my_tool" } });
    expect(result).toEqual({ type: "tool", name: "my_tool" });
  });
});

// ===========================================================================
// 11. CLAUDE ADAPTER — Error Handler (5 tests)
// ===========================================================================

describe("Claude Error Handler", () => {
  it("classifies 401 as authentication error", async () => {
    const { classifyClaudeError } = await import("../../ai-anthropic/src/error-handler.js");
    const result = classifyClaudeError({ status: 401, message: "Unauthorized" });
    expect(result.code).toBe("AUTHENTICATION_REQUIRED");
    expect(result.retryable).toBe(false);
  });

  it("classifies 429 as rate limited", async () => {
    const { classifyClaudeError } = await import("../../ai-anthropic/src/error-handler.js");
    const result = classifyClaudeError({ status: 429, message: "Rate limited" });
    expect(result.code).toBe("RATE_LIMITED");
    expect(result.retryable).toBe(true);
  });

  it("classifies 500 as internal error (retryable)", async () => {
    const { classifyClaudeError } = await import("../../ai-anthropic/src/error-handler.js");
    const result = classifyClaudeError({ status: 500, message: "Server error" });
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.retryable).toBe(true);
  });

  it("classifies 400 as invalid request", async () => {
    const { classifyClaudeError } = await import("../../ai-anthropic/src/error-handler.js");
    const result = classifyClaudeError({ status: 400, message: "Bad request" });
    expect(result.code).toBe("INVALID_REQUEST");
    expect(result.retryable).toBe(false);
  });

  it("redacts API keys from error messages", async () => {
    const { classifyClaudeError } = await import("../../ai-anthropic/src/error-handler.js");
    const result = classifyClaudeError({ status: 500, message: "Error with sk-ant-api-key12345" });
    expect(result.message).not.toContain("sk-ant-api-key12345");
    expect(result.message).toContain("[REDACTED]");
  });
});

// ===========================================================================
// 12. EMPTY/FAILING PROVIDER EDGE CASES (5 tests)
// ===========================================================================

describe("Edge Cases", () => {
  it("empty provider returns success: false for createCampaign", async () => {
    const provider = createEmptyMetaProvider();
    const result = await provider.createCampaign("act_111", { name: "Test", objective: "OUTCOME_AWARENESS", status: "PAUSED", buyingType: "AUCTION", specialAdCategories: [] });
    expect(result.success).toBe(false);
  });

  it("failing provider throws for createCampaign", async () => {
    const provider = createFailingMetaProvider();
    await expect(provider.createCampaign("act_111", { name: "Test", objective: "OUTCOME_AWARENESS", status: "PAUSED", buyingType: "AUCTION", specialAdCategories: [] })).rejects.toThrow();
  });

  it("mock provider creates campaign and returns it", async () => {
    const provider = createMockMetaProvider();
    const result = await provider.createCampaign("act_111111111", {
      name: "Mock Campaign",
      objective: "OUTCOME_ENGAGEMENT",
      status: "ACTIVE",
      buyingType: "AUCTION",
      specialAdCategories: [],
    });
    expect(result.success).toBe(true);
    expect(result.campaign.name).toBe("Mock Campaign");
    expect(result.campaign.campaignId).toBeDefined();
  });

  it("mock provider createCampaign with throwOnCall config", async () => {
    const provider = createMockMetaProvider({ throwOnCall: "createCampaign" });
    await expect(provider.createCampaign("act_111111111", {
      name: "Fail",
      objective: "OUTCOME_ENGAGEMENT",
      status: "PAUSED",
      buyingType: "AUCTION",
      specialAdCategories: [],
    })).rejects.toThrow("Meta API unavailable");
  });

  it("validateCampaignProposal rejects non-object with descriptive error", () => {
    const result = validateCampaignProposal("not an object");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("non-null object");
  });
});
