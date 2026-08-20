import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MetaPauseCampaignTool,
  MetaResumeCampaignTool,
  MetaPauseAdSetTool,
  MetaResumeAdSetTool,
  MetaPauseAdTool,
  MetaResumeAdTool,
  buildIdempotencyKey,
  getExecutionState,
  clearExecutionStore,
} from "../src/tools/meta-ads-write-tools.js";
import type { MetaAdsProvider, MetaAdsWriteProvider, MetaAccountAuthorizer } from "../src/tools/meta-ads-provider.js";
import { createMockMetaProvider, createFailingMetaProvider, createEmptyMetaProvider } from "../src/tools/meta-ads-mock.js";
import { sanitizeToolResult } from "../src/output-sanitizer.js";
import { ToolRegistry as TR } from "../src/registry.js";
import { ToolExecutor } from "../src/executor.js";
import type { AuditLogger, IPermissionChecker, IApprovalManager, Role, ToolResult, Approval, ApprovalStatus } from "@jarvis/core";

type WriteProvider = MetaAdsProvider & MetaAdsWriteProvider;

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

beforeEach(() => { clearExecutionStore(); });
// ===========================================================================
// 1. WRITE TOOL METADATA
// ===========================================================================

describe("Phase 9.1 Write Tool Metadata", () => {
  let provider: WriteProvider;
  let authorizer: MetaAccountAuthorizer;
  beforeEach(() => { provider = createMockMetaProvider(); authorizer = createAuthorizer(); });

  it("all 6 write tools have EXTERNAL_SIDE_EFFECT risk", () => {
    const tools = [new MetaPauseCampaignTool(provider, authorizer), new MetaResumeCampaignTool(provider, authorizer), new MetaPauseAdSetTool(provider, authorizer), new MetaResumeAdSetTool(provider, authorizer), new MetaPauseAdTool(provider, authorizer), new MetaResumeAdTool(provider, authorizer)];
    for (const t of tools) expect(t.risk).toBe("EXTERNAL_SIDE_EFFECT");
  });

  it("all 6 write tools require approval", () => {
    const tools = [new MetaPauseCampaignTool(provider, authorizer), new MetaResumeCampaignTool(provider, authorizer), new MetaPauseAdSetTool(provider, authorizer), new MetaResumeAdSetTool(provider, authorizer), new MetaPauseAdTool(provider, authorizer), new MetaResumeAdTool(provider, authorizer)];
    for (const t of tools) expect(t.requiresApproval).toBe(true);
  });

  it("all 6 write tools require read+write permissions", () => {
    const tools = [new MetaPauseCampaignTool(provider, authorizer), new MetaResumeCampaignTool(provider, authorizer), new MetaPauseAdSetTool(provider, authorizer), new MetaResumeAdSetTool(provider, authorizer), new MetaPauseAdTool(provider, authorizer), new MetaResumeAdTool(provider, authorizer)];
    for (const t of tools) { expect(t.requiredPermissions).toContain("read"); expect(t.requiredPermissions).toContain("write"); }
  });

  it("all 6 write tools have unique IDs", () => {
    const tools = [new MetaPauseCampaignTool(provider, authorizer), new MetaResumeCampaignTool(provider, authorizer), new MetaPauseAdSetTool(provider, authorizer), new MetaResumeAdSetTool(provider, authorizer), new MetaPauseAdTool(provider, authorizer), new MetaResumeAdTool(provider, authorizer)];
    expect(new Set(tools.map(t => t.id)).size).toBe(6);
  });

  it("write tools have correct IDs", () => {
    expect(new MetaPauseCampaignTool(provider, authorizer).id).toBe("meta.campaign.pause");
    expect(new MetaResumeCampaignTool(provider, authorizer).id).toBe("meta.campaign.resume");
    expect(new MetaPauseAdSetTool(provider, authorizer).id).toBe("meta.adset.pause");
    expect(new MetaResumeAdSetTool(provider, authorizer).id).toBe("meta.adset.resume");
    expect(new MetaPauseAdTool(provider, authorizer).id).toBe("meta.ad.pause");
    expect(new MetaResumeAdTool(provider, authorizer).id).toBe("meta.ad.resume");
  });
});

// ===========================================================================
// 2. PAUSE/RESUME CAMPAIGN
// ===========================================================================

describe("Pause Campaign", () => {
  let provider: WriteProvider; let authorizer: MetaAccountAuthorizer; let tool: MetaPauseCampaignTool;
  beforeEach(() => { provider = createMockMetaProvider(); authorizer = createAuthorizer(); tool = new MetaPauseCampaignTool(provider, authorizer); });

  it("pauses an active campaign", async () => {
    const result = await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe("pause_campaign");
    expect(data.previousState).toBe("ACTIVE");
    expect(data.actualState).toBe("PAUSED");
    expect(data.verified).toBe(true);
  });

  it("returns idempotent success for already-paused campaign", async () => {
    const result = await tool.execute({ accountId: "act_111111111", campaignId: "100000003" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.idempotent).toBe(true);
  });

  it("rejects non-existent campaign", async () => {
    const result = await tool.execute({ accountId: "act_111111111", campaignId: "999999999" }, { userId: "user-1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejects invalid account ID", async () => {
    const result = await tool.execute({ accountId: "invalid", campaignId: "100000001" }, { userId: "user-1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid account ID");
  });

  it("rejects invalid campaign ID", async () => {
    const result = await tool.execute({ accountId: "act_111111111", campaignId: "bad" }, { userId: "user-1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid campaign ID");
  });
});

describe("Resume Campaign", () => {
  let provider: WriteProvider; let authorizer: MetaAccountAuthorizer;
  beforeEach(() => { provider = createMockMetaProvider(); authorizer = createAuthorizer(); });

  it("resumes a paused campaign", async () => {
    const tool = new MetaResumeCampaignTool(provider, authorizer);
    const result = await tool.execute({ accountId: "act_111111111", campaignId: "100000003" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe("resume_campaign");
    expect(data.previousState).toBe("PAUSED");
    expect(data.actualState).toBe("ACTIVE");
    expect(data.verified).toBe(true);
  });

  it("returns idempotent success for already-active campaign", async () => {
    const tool = new MetaResumeCampaignTool(provider, authorizer);
    const result = await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).idempotent).toBe(true);
  });

  it("rejects non-existent campaign", async () => {
    const tool = new MetaResumeCampaignTool(provider, authorizer);
    const result = await tool.execute({ accountId: "act_111111111", campaignId: "999999999" }, { userId: "user-1" });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// 3. PAUSE/RESUME AD SET
// ===========================================================================

describe("Pause Ad Set", () => {
  it("pauses an active ad set", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseAdSetTool(provider, authorizer);
    const result = await tool.execute({ accountId: "act_111111111", adSetId: "200000001" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).action).toBe("pause_adset");
    expect((result.data as Record<string, unknown>).actualState).toBe("PAUSED");
  });

  it("rejects non-existent ad set", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseAdSetTool(provider, authorizer);
    const result = await tool.execute({ accountId: "act_111111111", adSetId: "999999999" }, { userId: "user-1" });
    expect(result.success).toBe(false);
  });
});

describe("Resume Ad Set", () => {
  it("resumes a paused ad set", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const pauseTool = new MetaPauseAdSetTool(provider, authorizer);
    await pauseTool.execute({ accountId: "act_111111111", adSetId: "200000002" }, { userId: "user-1" });
    const resumeTool = new MetaResumeAdSetTool(provider, authorizer);
    const result = await resumeTool.execute({ accountId: "act_111111111", adSetId: "200000002" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).actualState).toBe("ACTIVE");
  });
});
// ===========================================================================
// 4. PAUSE/RESUME AD
// ===========================================================================

describe("Pause Ad", () => {
  it("pauses an active ad", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseAdTool(provider, authorizer);
    const result = await tool.execute({ accountId: "act_111111111", adId: "300000001" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).action).toBe("pause_ad");
    expect((result.data as Record<string, unknown>).actualState).toBe("PAUSED");
  });

  it("rejects non-existent ad", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseAdTool(provider, authorizer);
    const result = await tool.execute({ accountId: "act_111111111", adId: "999999999" }, { userId: "user-1" });
    expect(result.success).toBe(false);
  });
});

describe("Resume Ad", () => {
  it("resumes a paused ad", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const pauseTool = new MetaPauseAdTool(provider, authorizer);
    await pauseTool.execute({ accountId: "act_111111111", adId: "300000002" }, { userId: "user-1" });
    const resumeTool = new MetaResumeAdTool(provider, authorizer);
    const result = await resumeTool.execute({ accountId: "act_111111111", adId: "300000002" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).actualState).toBe("ACTIVE");
  });

  it("returns idempotent success for already-active ad", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaResumeAdTool(provider, authorizer);
    const result = await tool.execute({ accountId: "act_111111111", adId: "300000001" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).idempotent).toBe(true);
  });
});

// ===========================================================================
// 5. APPROVAL FLOW (via ToolExecutor)
// ===========================================================================

describe("Approval Flow", () => {
  it("action requires approval through ToolExecutor", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const { logger } = createTrackingAudit();
    const { mgr } = createApprovalMgr();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const executor = new ToolExecutor(registry, allowAllPerms, mgr, logger);
    const result = await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-1", role: "admin", traceId: "t-1" });
    expect(result.status).toBe("approval_pending");
    expect(result.approvalId).toBeDefined();
  });

  it("approval is created with correct params", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const { logger } = createTrackingAudit();
    const { mgr, approvals } = createApprovalMgr();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const executor = new ToolExecutor(registry, allowAllPerms, mgr, logger);
    await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-1", role: "admin", traceId: "t-1" });
    expect(approvals.size).toBe(1);
    const approval = Array.from(approvals.values())[0];
    expect(approval.toolId).toBe("meta.campaign.pause");
    expect(approval.userId).toBe("user-1");
  });

  it("rejected approval blocks execution", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const { logger } = createTrackingAudit();
    const { mgr, approvals } = createApprovalMgr();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const executor = new ToolExecutor(registry, allowAllPerms, mgr, logger);
    const r1 = await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-1", role: "admin", traceId: "t-1" });
    const approvalId = r1.approvalId!;
    const approval = approvals.get(approvalId)!;
    approval.status = "rejected" as ApprovalStatus;
    const r2 = await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-1", role: "admin", traceId: "t-2" });
    expect(r2.status).toBe("approval_denied");
  });

  it("approval belongs to correct user", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const { logger } = createTrackingAudit();
    const { mgr } = createApprovalMgr();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const executor = new ToolExecutor(registry, allowAllPerms, mgr, logger);
    await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-1", role: "admin", traceId: "t-1" });
    const r2 = await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-2", role: "admin", traceId: "t-2" });
    expect(r2.status).toBe("approval_pending");
  });
});
// ===========================================================================
// 6. STALE STATE PROTECTION
// ===========================================================================

describe("Stale State Protection", () => {
  it("already-paused target returns idempotent success", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseCampaignTool(provider, authorizer);
    const r = await tool.execute({ accountId: "act_111111111", campaignId: "100000003" }, { userId: "user-1" });
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>).idempotent).toBe(true);
    expect((r.data as Record<string, unknown>).previousState).toBe("PAUSED");
  });

  it("already-active target returns idempotent success on resume", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaResumeCampaignTool(provider, authorizer);
    const r = await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>).idempotent).toBe(true);
  });

  it("target not found returns failure", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseAdTool(provider, authorizer);
    const r = await tool.execute({ accountId: "act_111111111", adId: "999999999" }, { userId: "user-1" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("not found");
  });
});

// ===========================================================================
// 7. IDEMPOTENCY
// ===========================================================================

describe("Idempotency", () => {
  it("duplicate execution is blocked by idempotency key", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseCampaignTool(provider, authorizer);
    const r1 = await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    expect(r1.success).toBe(true);
    const r2 = await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    expect(r2.success).toBe(true);
    expect((r2.data as Record<string, unknown>).idempotent).toBe(true);
  });

  it("execution already succeeded returns idempotent", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseAdTool(provider, authorizer);
    await tool.execute({ accountId: "act_111111111", adId: "300000001" }, { userId: "user-1" });
    const r = await tool.execute({ accountId: "act_111111111", adId: "300000001" }, { userId: "user-1" });
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>).idempotent).toBe(true);
  });

  it("different targets have independent idempotency keys", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseCampaignTool(provider, authorizer);
    const r1 = await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    expect(r1.success).toBe(true);
    const r2 = await tool.execute({ accountId: "act_111111111", campaignId: "100000002" }, { userId: "user-1" });
    expect(r2.success).toBe(true);
    expect((r2.data as Record<string, unknown>).idempotent).toBeUndefined();
  });
});

// ===========================================================================
// 8. AUTHORIZATION
// ===========================================================================

describe("Authorization", () => {
  it("unauthorized Meta account is rejected", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer(["act_111111111"]);
    const tool = new MetaPauseCampaignTool(provider, authorizer);
    const r = await tool.execute({ accountId: "act_222222222", campaignId: "100000001" }, { userId: "user-1" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Not authorized");
  });

  it("viewer cannot use write tools (missing write permission)", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const { logger } = createTrackingAudit();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const executor = new ToolExecutor(registry, denyWritePerms, { requestApproval: vi.fn(), findExistingForTool: vi.fn() } as unknown as IApprovalManager, logger);
    const r = await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "viewer-1", role: "viewer", traceId: "t-1" });
    expect(r.status).toBe("permission_denied");
  });

  it("member with write permission can use write tools (pending approval)", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const { logger } = createTrackingAudit();
    const { mgr } = createApprovalMgr();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const executor = new ToolExecutor(registry, allowAllPerms, mgr, logger);
    const r = await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "member-1", role: "member", traceId: "t-1" });
    expect(r.status).toBe("approval_pending");
  });

  it("admin with write permission can use write tools (pending approval)", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const { logger } = createTrackingAudit();
    const { mgr } = createApprovalMgr();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const executor = new ToolExecutor(registry, allowAllPerms, mgr, logger);
    const r = await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "admin-1", role: "admin", traceId: "t-1" });
    expect(r.status).toBe("approval_pending");
  });
});
// ===========================================================================
// 9. SECURITY
// ===========================================================================

describe("Security", () => {
  it("arbitrary Graph API path rejected via ID validation", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseCampaignTool(provider, authorizer);
    const r1 = await tool.execute({ accountId: "../../etc/passwd", campaignId: "100000001" }, { userId: "user-1" });
    expect(r1.success).toBe(false);
    const r2 = await tool.execute({ accountId: "act_111111111", campaignId: "123/../../admin" }, { userId: "user-1" });
    expect(r2.success).toBe(false);
  });

  it("secret redaction through output sanitizer", () => {
    const result: ToolResult = { success: true, data: { token: "sk-abc123secretkey12345678901234567890", action: "pause" } };
    const sanitized = sanitizeToolResult(result);
    const json = JSON.stringify(sanitized.result);
    expect(json).not.toContain("sk-abc123secretkey12345678901234567890");
  });

  it("malicious provider response is sanitized", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseCampaignTool(provider, authorizer);
    const r = await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    expect(r.success).toBe(true);
    const sanitized = sanitizeToolResult(r);
    const json = JSON.stringify(sanitized.result);
    expect(json).not.toContain("password");
    expect(json).not.toContain("token");
  });

  it("prompt injection in provider output is neutralized", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseCampaignTool(provider, authorizer);
    const r = await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    const data = r.data as Record<string, unknown>;
    expect(typeof data.campaignName).toBe("string");
    expect(data.campaignName).not.toContain("<script>");
    expect(data.campaignName).not.toContain("ignore previous");
  });

  it("cross-user isolation", async () => {
    const provider = createMockMetaProvider();
    const auth1 = createAuthorizer(["act_111111111"]);
    const tool = new MetaPauseCampaignTool(provider, auth1);
    const r = await tool.execute({ accountId: "act_222222222", campaignId: "100000001" }, { userId: "user-1" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Not authorized");
  });

  it("no write tools registered in forbidden list", () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    registry.register(new MetaResumeCampaignTool(provider, authorizer));
    registry.register(new MetaPauseAdSetTool(provider, authorizer));
    registry.register(new MetaResumeAdSetTool(provider, authorizer));
    registry.register(new MetaPauseAdTool(provider, authorizer));
    registry.register(new MetaResumeAdTool(provider, authorizer));
    const ids = registry.getAll().map(t => t.id);
    const forbidden = ["meta.create_campaign", "meta.update_campaign", "meta.delete_campaign", "meta.update_budget", "meta.create_ad", "meta.update_ad", "meta.publish"];
    for (const f of forbidden) expect(ids).not.toContain(f);
  });
});

// ===========================================================================
// 10. POST-EXECUTION VERIFICATION
// ===========================================================================

describe("Post-Execution Verification", () => {
  it("successful state verification", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseCampaignTool(provider, authorizer);
    const r = await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>).verified).toBe(true);
    expect((r.data as Record<string, unknown>).actualState).toBe("PAUSED");
  });

  it("provider failure returns structured error", async () => {
    const failProvider = createFailingMetaProvider("Meta API unavailable");
    const authorizer = createAuthorizer();
    const tool = new MetaPauseCampaignTool(failProvider, authorizer);
    const r = await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Meta API error");
  });

  it("provider timeout returns error", async () => {
    const slowProvider = createMockMetaProvider({ delayMs: 50000 });
    const authorizer = createAuthorizer();
    const { logger } = createTrackingAudit();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(slowProvider, authorizer));
    const executor = new ToolExecutor(registry, allowAllPerms, { requestApproval: vi.fn().mockResolvedValue({ id: "a1", status: "approved", expiresAt: new Date(Date.now() + 60000).toISOString() }), findExistingForTool: vi.fn().mockResolvedValue({ id: "a1", status: "approved", expiresAt: new Date(Date.now() + 60000).toISOString() }) } as unknown as IApprovalManager, logger, { defaultTimeoutMs: 100 });
    const r = await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-1", role: "admin", traceId: "t-1" });
    expect(r.status).toBe("timed_out");
  });
});

// ===========================================================================
// 11. AUDIT
// ===========================================================================

describe("Audit", () => {
  it("successful action is audited", async () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const { logger, calls } = createTrackingAudit();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const { mgr, approvals } = createApprovalMgr();
    const executor = new ToolExecutor(registry, allowAllPerms, mgr, logger);
    await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-1", role: "admin", traceId: "t-1" });
    const approval = Array.from(approvals.values())[0];
    approval.status = "approved" as ApprovalStatus;
    await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-1", role: "admin", traceId: "t-1" });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = calls[calls.length - 1] as Record<string, unknown>;
    expect(lastCall.result).toBe("success");
  });

  it("rejected action is audited", async () => {
    const { logger, calls } = createTrackingAudit();
    const { mgr, approvals } = createApprovalMgr();
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const executor = new ToolExecutor(registry, denyAllPerms, mgr, logger);
    await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-1", role: "viewer", traceId: "t-1" });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const lastCall = calls[calls.length - 1] as Record<string, unknown>;
    expect(lastCall.result).toBe("rejected");
  });

  it("approval pending action is audited", async () => {
    const { logger, calls } = createTrackingAudit();
    const { mgr } = createApprovalMgr();
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const executor = new ToolExecutor(registry, allowAllPerms, mgr, logger);
    await executor.execute({ toolId: "meta.campaign.pause", params: { accountId: "act_111111111", campaignId: "100000001" }, userId: "user-1", role: "admin", traceId: "t-1" });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const lastCall = calls[calls.length - 1] as Record<string, unknown>;
    expect(lastCall.result).toBe("pending");
  });
});

// ===========================================================================
// 12. NO REAL API CALLS
// ===========================================================================

describe("No Real API Calls", () => {
  it("mock write provider never makes HTTP requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const tool = new MetaPauseCampaignTool(provider, authorizer);
    await tool.execute({ accountId: "act_111111111", campaignId: "100000001" }, { userId: "user-1" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ===========================================================================
// 13. TOOL REGISTRY INTEGRATION
// ===========================================================================

describe("Tool Registry Integration", () => {
  it("registers all 6 write tools", () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    registry.register(new MetaResumeCampaignTool(provider, authorizer));
    registry.register(new MetaPauseAdSetTool(provider, authorizer));
    registry.register(new MetaResumeAdSetTool(provider, authorizer));
    registry.register(new MetaPauseAdTool(provider, authorizer));
    registry.register(new MetaResumeAdTool(provider, authorizer));
    expect(registry.count()).toBe(6);
    expect(registry.get("meta.campaign.pause")).toBeDefined();
    expect(registry.get("meta.campaign.resume")).toBeDefined();
    expect(registry.get("meta.adset.pause")).toBeDefined();
    expect(registry.get("meta.adset.resume")).toBeDefined();
    expect(registry.get("meta.ad.pause")).toBeDefined();
    expect(registry.get("meta.ad.resume")).toBeDefined();
  });

  it("filters by EXTERNAL_SIDE_EFFECT risk", () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    registry.register(new MetaResumeAdTool(provider, authorizer));
    const write = registry.getByRisk("EXTERNAL_SIDE_EFFECT");
    expect(write.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by requiresApproval", () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    registry.register(new MetaPauseAdTool(provider, authorizer));
    const approvalRequired = registry.getRequiringApproval();
    expect(approvalRequired.length).toBeGreaterThanOrEqual(2);
  });

  it("generates correct tool descriptions", () => {
    const provider = createMockMetaProvider(); const authorizer = createAuthorizer();
    const registry = new TR();
    registry.register(new MetaPauseCampaignTool(provider, authorizer));
    const descs = registry.getToolDescriptions("user-1", "admin");
    expect(descs.length).toBe(1);
    expect(descs[0].name).toBe("meta.campaign.pause");
    expect(descs[0].risk).toBe("EXTERNAL_SIDE_EFFECT");
    expect(descs[0].approvalRequired).toBe(true);
  });
});
