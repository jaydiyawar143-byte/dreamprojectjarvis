import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MetaGetAccountsTool,
  MetaGetCampaignsTool,
  MetaGetAdSetsTool,
  MetaGetAdsTool,
  MetaGetInsightsTool,
} from "../src/tools/meta-ads-tools.js";
import type { MetaAdsProvider, MetaAccountAuthorizer } from "../src/tools/meta-ads-provider.js";
import {
  createMockMetaProvider,
  createFailingMetaProvider,
  createEmptyMetaProvider,
} from "../src/tools/meta-ads-mock.js";
import {
  validateAccountId,
  validateEntityId,
  validateDateRange,
  validateLimit,
  validateMetrics,
  validateBreakdown,
  META_ADS_CONSTANTS,
} from "../src/tools/meta-ads-validators.js";
import { sanitizeToolResult, wrapToolResult } from "../src/output-sanitizer.js";
import type { ToolRegistry } from "../src/registry.js";
import { ToolRegistry as TR } from "../src/registry.js";
import { ToolExecutor } from "../src/executor.js";
import type { AuditLogger, IPermissionChecker, IApprovalManager, Role, ToolResult } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Mock authorizer
// ---------------------------------------------------------------------------

function createAuthorizer(authorizedAccounts: string[] = ["act_111111111", "act_222222222"]): MetaAccountAuthorizer {
  return {
    getAuthorizedAccountIds: vi.fn().mockResolvedValue(authorizedAccounts),
    isAuthorized: vi.fn().mockImplementation(async (_userId: string, accountId: string) => {
      return authorizedAccounts.includes(accountId);
    }),
  };
}

function createDenyAllAuthorizer(): MetaAccountAuthorizer {
  return {
    getAuthorizedAccountIds: vi.fn().mockResolvedValue([]),
    isAuthorized: vi.fn().mockResolvedValue(false),
  };
}

const noopAuditLogger: AuditLogger = { log: vi.fn().mockResolvedValue(undefined) };
const allowAllPermissions: IPermissionChecker = { hasPermission: () => true };
const noopApprovalManager: IApprovalManager = {
  requestApproval: vi.fn().mockResolvedValue({
    id: "a1", userId: "u1", toolId: "t", action: "e", params: {},
    status: "pending", expiresAt: new Date().toISOString(), createdAt: new Date().toISOString(),
  }),
  findExistingForTool: vi.fn().mockResolvedValue(null),
};

// ===========================================================================
// VALIDATORS
// ===========================================================================

describe("Meta Ads Validators", () => {
  describe("validateAccountId", () => {
    it("accepts valid act_ prefixed IDs", () => {
      expect(validateAccountId("act_123456789")).toBe("act_123456789");
    });

    it("adds act_ prefix to numeric IDs", () => {
      expect(validateAccountId("123456789")).toBe("act_123456789");
    });

    it("rejects empty strings", () => {
      expect(validateAccountId("")).toBeNull();
      expect(validateAccountId("  ")).toBeNull();
    });

    it("rejects IDs that are too short", () => {
      expect(validateAccountId("act_123")).toBeNull();
    });

    it("rejects non-numeric IDs", () => {
      expect(validateAccountId("act_abcdefgh")).toBeNull();
    });

    it("rejects IDs that are too long", () => {
      expect(validateAccountId("act_" + "1".repeat(50))).toBeNull();
    });

    it("rejects non-string input", () => {
      expect(validateAccountId(undefined as unknown as string)).toBeNull();
      expect(validateAccountId(123 as unknown as string)).toBeNull();
    });
  });

  describe("validateEntityId", () => {
    it("accepts valid numeric IDs", () => {
      expect(validateEntityId("123456789")).toBe("123456789");
    });

    it("accepts act_ prefixed IDs", () => {
      expect(validateEntityId("act_123456789")).toBe("act_123456789");
    });

    it("rejects invalid formats", () => {
      expect(validateEntityId("abc")).toBeNull();
      expect(validateEntityId("")).toBeNull();
    });
  });

  describe("validateDateRange", () => {
    it("accepts valid range", () => {
      const result = validateDateRange({ start: "2025-03-01", end: "2025-03-07" });
      expect(result.valid).toBe(true);
    });

    it("rejects missing dates", () => {
      expect(validateDateRange({}).valid).toBe(false);
    });

    it("rejects invalid format", () => {
      expect(validateDateRange({ start: "03/01/2025", end: "03/07/2025" }).valid).toBe(false);
    });

    it("rejects start after end", () => {
      expect(validateDateRange({ start: "2025-03-07", end: "2025-03-01" }).valid).toBe(false);
    });

    it("rejects range exceeding 90 days", () => {
      expect(validateDateRange({ start: "2025-01-01", end: "2025-06-01" }).valid).toBe(false);
    });

    it("accepts 90-day range", () => {
      expect(validateDateRange({ start: "2025-01-01", end: "2025-03-31" }).valid).toBe(true);
    });
  });

  describe("validateLimit", () => {
    it("returns default for non-numeric", () => {
      expect(validateLimit("abc")).toBe(META_ADS_CONSTANTS.DEFAULT_RESULT_LIMIT);
    });

    it("caps at max", () => {
      expect(validateLimit(999)).toBe(META_ADS_CONSTANTS.MAX_RESULT_LIMIT);
    });

    it("accepts valid limits", () => {
      expect(validateLimit(25)).toBe(25);
    });

    it("returns default for 0 or negative", () => {
      expect(validateLimit(0)).toBe(META_ADS_CONSTANTS.DEFAULT_RESULT_LIMIT);
      expect(validateLimit(-5)).toBe(META_ADS_CONSTANTS.DEFAULT_RESULT_LIMIT);
    });
  });

  describe("validateMetrics", () => {
    it("filters valid metrics", () => {
      expect(validateMetrics(["impressions", "spend", "invalid"])).toEqual(["impressions", "spend"]);
    });

    it("returns empty for non-array", () => {
      expect(validateMetrics("not-array")).toEqual([]);
    });

    it("returns empty for empty array", () => {
      expect(validateMetrics([])).toEqual([]);
    });
  });

  describe("validateBreakdown", () => {
    it("accepts valid breakdowns", () => {
      expect(validateBreakdown("age")).toBe("age");
      expect(validateBreakdown("gender")).toBe("gender");
      expect(validateBreakdown("country")).toBe("country");
    });

    it("rejects invalid breakdowns", () => {
      expect(validateBreakdown("invalid")).toBeUndefined();
      expect(validateBreakdown(123)).toBeUndefined();
    });
  });
});

// ===========================================================================
// TOOL METADATA
// ===========================================================================

describe("Meta Ads Tool Metadata", () => {
  let provider: MetaAdsProvider;
  let authorizer: MetaAccountAuthorizer;

  beforeEach(() => {
    provider = createMockMetaProvider();
    authorizer = createAuthorizer();
  });

  it("all tools have correct risk level", () => {
    const tools = [
      new MetaGetAccountsTool(provider, authorizer),
      new MetaGetCampaignsTool(provider, authorizer),
      new MetaGetAdSetsTool(provider, authorizer),
      new MetaGetAdsTool(provider, authorizer),
      new MetaGetInsightsTool(provider, authorizer),
    ];
    for (const tool of tools) {
      expect(tool.risk).toBe("READ_ONLY");
      expect(tool.requiresApproval).toBe(false);
      expect(tool.requiredPermissions).toEqual(["read"]);
      expect(tool.category).toBe("marketing");
      expect(tool.enabled).toBe(true);
    }
  });

  it("all tools have unique IDs", () => {
    const tools = [
      new MetaGetAccountsTool(provider, authorizer),
      new MetaGetCampaignsTool(provider, authorizer),
      new MetaGetAdSetsTool(provider, authorizer),
      new MetaGetAdsTool(provider, authorizer),
      new MetaGetInsightsTool(provider, authorizer),
    ];
    const ids = tools.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("accounts tool has correct ID", () => {
    expect(new MetaGetAccountsTool(provider, authorizer).id).toBe("meta.accounts");
  });

  it("campaigns tool has correct ID", () => {
    expect(new MetaGetCampaignsTool(provider, authorizer).id).toBe("meta.campaigns");
  });

  it("adsets tool has correct ID", () => {
    expect(new MetaGetAdSetsTool(provider, authorizer).id).toBe("meta.adsets");
  });

  it("ads tool has correct ID", () => {
    expect(new MetaGetAdsTool(provider, authorizer).id).toBe("meta.ads");
  });

  it("insights tool has correct ID", () => {
    expect(new MetaGetInsightsTool(provider, authorizer).id).toBe("meta.insights");
  });
});

// ===========================================================================
// TOOL EXECUTION — ACCOUNTS
// ===========================================================================

describe("MetaGetAccountsTool", () => {
  let provider: MetaAdsProvider;
  let authorizer: MetaAccountAuthorizer;
  let tool: MetaGetAccountsTool;

  beforeEach(() => {
    provider = createMockMetaProvider();
    authorizer = createAuthorizer();
    tool = new MetaGetAccountsTool(provider, authorizer);
  });

  it("returns authorized ad accounts", async () => {
    const result = await tool.execute({}, { userId: "user-1" });
    expect(result.success).toBe(true);
    const data = result.data as { accounts: unknown[]; count: number; totalAuthorized: number };
    expect(data.count).toBe(2);
    expect(data.accounts).toHaveLength(2);
  });

  it("respects limit parameter", async () => {
    const result = await tool.execute({ limit: 1 }, { userId: "user-1" });
    expect(result.success).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(1);
  });

  it("handles provider errors gracefully", async () => {
    const failProvider = createFailingMetaProvider();
    const failTool = new MetaGetAccountsTool(failProvider, authorizer);
    const result = await failTool.execute({}, { userId: "user-1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Meta API error");
  });

  it("returns empty for empty provider", async () => {
    const emptyProvider = createEmptyMetaProvider();
    const emptyTool = new MetaGetAccountsTool(emptyProvider, authorizer);
    const result = await emptyTool.execute({}, { userId: "user-1" });
    expect(result.success).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(0);
  });

  it("returns empty when no accounts authorized", async () => {
    const emptyAuth = createAuthorizer([]);
    const emptyTool = new MetaGetAccountsTool(provider, emptyAuth);
    const result = await emptyTool.execute({}, { userId: "user-1" });
    expect(result.success).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(0);
  });
});

// ===========================================================================
// TOOL EXECUTION — CAMPAIGNS
// ===========================================================================

describe("MetaGetCampaignsTool", () => {
  let provider: MetaAdsProvider;
  let authorizer: MetaAccountAuthorizer;
  let tool: MetaGetCampaignsTool;

  beforeEach(() => {
    provider = createMockMetaProvider();
    authorizer = createAuthorizer();
    tool = new MetaGetCampaignsTool(provider, authorizer);
  });

  it("returns campaigns for authorized account", async () => {
    const result = await tool.execute({ accountId: "act_111111111" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    const data = result.data as { campaigns: unknown[]; count: number };
    expect(data.count).toBe(3);
  });

  it("rejects invalid account ID format", async () => {
    const result = await tool.execute({ accountId: "invalid" }, { userId: "user-1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid account ID");
  });

  it("rejects unauthorized account", async () => {
    const denyAuth = createDenyAllAuthorizer();
    const denyTool = new MetaGetCampaignsTool(provider, denyAuth);
    const result = await denyTool.execute({ accountId: "act_999999999" }, { userId: "user-1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not authorized");
  });

  it("requires accountId parameter", async () => {
    const result = await tool.execute({}, { userId: "user-1" });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// TOOL EXECUTION — AD SETS
// ===========================================================================

describe("MetaGetAdSetsTool", () => {
  let provider: MetaAdsProvider;
  let authorizer: MetaAccountAuthorizer;
  let tool: MetaGetAdSetsTool;

  beforeEach(() => {
    provider = createMockMetaProvider();
    authorizer = createAuthorizer();
    tool = new MetaGetAdSetsTool(provider, authorizer);
  });

  it("returns ad sets for account", async () => {
    const result = await tool.execute({ accountId: "act_111111111" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    const data = result.data as { adSets: unknown[]; count: number };
    expect(data.count).toBe(3);
  });

  it("filters by campaign ID", async () => {
    const result = await tool.execute(
      { accountId: "act_111111111", campaignId: "100000001" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(true);
    const data = result.data as { adSets: Array<{ campaignId: string }>; count: number };
    expect(data.count).toBe(2);
    for (const adSet of data.adSets) {
      expect(adSet.campaignId).toBe("100000001");
    }
  });

  it("rejects unauthorized account", async () => {
    const denyAuth = createDenyAllAuthorizer();
    const denyTool = new MetaGetAdSetsTool(provider, denyAuth);
    const result = await denyTool.execute({ accountId: "act_999999999" }, { userId: "user-1" });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// TOOL EXECUTION — ADS
// ===========================================================================

describe("MetaGetAdsTool", () => {
  let provider: MetaAdsProvider;
  let authorizer: MetaAccountAuthorizer;
  let tool: MetaGetAdsTool;

  beforeEach(() => {
    provider = createMockMetaProvider();
    authorizer = createAuthorizer();
    tool = new MetaGetAdsTool(provider, authorizer);
  });

  it("returns ads for account", async () => {
    const result = await tool.execute({ accountId: "act_111111111" }, { userId: "user-1" });
    expect(result.success).toBe(true);
    const data = result.data as { ads: unknown[]; count: number };
    expect(data.count).toBe(3);
  });

  it("filters by campaign ID", async () => {
    const result = await tool.execute(
      { accountId: "act_111111111", campaignId: "100000001" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(true);
    const data = result.data as { ads: Array<{ campaignId: string }>; count: number };
    for (const ad of data.ads) {
      expect(ad.campaignId).toBe("100000001");
    }
  });

  it("filters by ad set ID", async () => {
    const result = await tool.execute(
      { accountId: "act_111111111", adSetId: "200000001" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(true);
    const data = result.data as { ads: Array<{ adSetId: string }>; count: number };
    for (const ad of data.ads) {
      expect(ad.adSetId).toBe("200000001");
    }
  });

  it("rejects invalid entity IDs", async () => {
    const result = await tool.execute(
      { accountId: "act_111111111", campaignId: "bad-id" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(true);
    const data = result.data as { campaignId: null };
    expect(data.campaignId).toBeNull();
  });
});

// ===========================================================================
// TOOL EXECUTION — INSIGHTS
// ===========================================================================

describe("MetaGetInsightsTool", () => {
  let provider: MetaAdsProvider;
  let authorizer: MetaAccountAuthorizer;
  let tool: MetaGetInsightsTool;

  beforeEach(() => {
    provider = createMockMetaProvider();
    authorizer = createAuthorizer();
    tool = new MetaGetInsightsTool(provider, authorizer);
  });

  it("returns insights with valid date range", async () => {
    const result = await tool.execute(
      { accountId: "act_111111111", startDate: "2025-03-01", endDate: "2025-03-07" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(true);
    const data = result.data as { insights: unknown[]; count: number };
    expect(data.count).toBe(2);
  });

  it("rejects invalid date range", async () => {
    const result = await tool.execute(
      { accountId: "act_111111111", startDate: "2025-06-01", endDate: "2025-01-01" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("start date must be before end date");
  });

  it("rejects date range exceeding 90 days", async () => {
    const result = await tool.execute(
      { accountId: "act_111111111", startDate: "2025-01-01", endDate: "2025-06-01" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("90 days");
  });

  it("rejects invalid date format", async () => {
    const result = await tool.execute(
      { accountId: "act_111111111", startDate: "03/01/2025", endDate: "03/07/2025" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(false);
  });

  it("requires startDate and endDate", async () => {
    const result = await tool.execute(
      { accountId: "act_111111111" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(false);
  });

  it("rejects unauthorized account", async () => {
    const denyAuth = createDenyAllAuthorizer();
    const denyTool = new MetaGetInsightsTool(provider, denyAuth);
    const result = await denyTool.execute(
      { accountId: "act_999999999", startDate: "2025-03-01", endDate: "2025-03-07" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not authorized");
  });

  it("handles provider errors gracefully", async () => {
    const failProvider = createFailingMetaProvider("Rate limited");
    const failTool = new MetaGetInsightsTool(failProvider, authorizer);
    const result = await failTool.execute(
      { accountId: "act_111111111", startDate: "2025-03-01", endDate: "2025-03-07" },
      { userId: "user-1" }
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limited");
  });

  it("accepts valid breakdown", async () => {
    const result = await tool.execute(
      {
        accountId: "act_111111111",
        startDate: "2025-03-01",
        endDate: "2025-03-07",
        breakdown: "age",
      },
      { userId: "user-1" }
    );
    expect(result.success).toBe(true);
    const data = result.data as { breakdown: string };
    expect(data.breakdown).toBe("age");
  });

  it("rejects invalid breakdown", async () => {
    const result = await tool.execute(
      {
        accountId: "act_111111111",
        startDate: "2025-03-01",
        endDate: "2025-03-07",
        breakdown: "invalid_dimension",
      },
      { userId: "user-1" }
    );
    expect(result.success).toBe(true);
    const data = result.data as { breakdown: null };
    expect(data.breakdown).toBeNull();
  });

  it("filters metrics to allowed set", async () => {
    const result = await tool.execute(
      {
        accountId: "act_111111111",
        startDate: "2025-03-01",
        endDate: "2025-03-07",
        fields: ["impressions", "spend", "fake_metric"],
      },
      { userId: "user-1" }
    );
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// USER ISOLATION
// ===========================================================================

describe("User Isolation", () => {
  it("user cannot access another user's account", async () => {
    const provider = createMockMetaProvider();
    const auth1 = createAuthorizer(["act_111111111"]);

    const tool = new MetaGetCampaignsTool(provider, auth1);
    const result = await tool.execute({ accountId: "act_222222222" }, { userId: "user-1" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Not authorized");
  });
});

// ===========================================================================
// FORBIDDEN WRITE ACTIONS
// ===========================================================================

describe("Forbidden Write Actions", () => {
  it("no create campaign tool exists", () => {
    const registry = new TR();
    const provider = createMockMetaProvider();
    const authorizer = createAuthorizer();

    registry.register(new MetaGetAccountsTool(provider, authorizer));
    registry.register(new MetaGetCampaignsTool(provider, authorizer));
    registry.register(new MetaGetAdSetsTool(provider, authorizer));
    registry.register(new MetaGetAdsTool(provider, authorizer));
    registry.register(new MetaGetInsightsTool(provider, authorizer));

    const allTools = registry.getAll();
    const toolIds = allTools.map((t) => t.id);

    const forbidden = [
      "meta.create_campaign",
      "meta.update_campaign",
      "meta.delete_campaign",
      "meta.pause_campaign",
      "meta.create_ad",
      "meta.update_ad",
      "meta.update_budget",
      "meta.publish",
    ];

    for (const f of forbidden) {
      expect(toolIds).not.toContain(f);
    }
  });

  it("all Meta tools have READ_ONLY risk", () => {
    const provider = createMockMetaProvider();
    const authorizer = createAuthorizer();
    const tools = [
      new MetaGetAccountsTool(provider, authorizer),
      new MetaGetCampaignsTool(provider, authorizer),
      new MetaGetAdSetsTool(provider, authorizer),
      new MetaGetAdsTool(provider, authorizer),
      new MetaGetInsightsTool(provider, authorizer),
    ];
    for (const tool of tools) {
      expect(tool.risk).toBe("READ_ONLY");
      expect(tool.requiredPermissions).not.toContain("write");
      expect(tool.requiredPermissions).not.toContain("execute");
    }
  });
});

// ===========================================================================
// TOOL REGISTRY INTEGRATION
// ===========================================================================

describe("Tool Registry Integration", () => {
  it("registers all 5 Meta tools", () => {
    const registry = new TR();
    const provider = createMockMetaProvider();
    const authorizer = createAuthorizer();

    registry.register(new MetaGetAccountsTool(provider, authorizer));
    registry.register(new MetaGetCampaignsTool(provider, authorizer));
    registry.register(new MetaGetAdSetsTool(provider, authorizer));
    registry.register(new MetaGetAdsTool(provider, authorizer));
    registry.register(new MetaGetInsightsTool(provider, authorizer));

    expect(registry.count()).toBe(5);
    expect(registry.get("meta.accounts")).toBeDefined();
    expect(registry.get("meta.campaigns")).toBeDefined();
    expect(registry.get("meta.adsets")).toBeDefined();
    expect(registry.get("meta.ads")).toBeDefined();
    expect(registry.get("meta.insights")).toBeDefined();
  });

  it("filters by marketing category", () => {
    const registry = new TR();
    const provider = createMockMetaProvider();
    const authorizer = createAuthorizer();

    registry.register(new MetaGetAccountsTool(provider, authorizer));
    registry.register(new MetaGetCampaignsTool(provider, authorizer));

    const marketing = registry.getByCategory("marketing");
    expect(marketing.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by READ_ONLY risk", () => {
    const registry = new TR();
    const provider = createMockMetaProvider();
    const authorizer = createAuthorizer();

    registry.register(new MetaGetAccountsTool(provider, authorizer));
    registry.register(new MetaGetInsightsTool(provider, authorizer));

    const readOnly = registry.getByRisk("READ_ONLY");
    expect(readOnly.length).toBeGreaterThanOrEqual(2);
  });

  it("generates tool descriptions for model", () => {
    const registry = new TR();
    const provider = createMockMetaProvider();
    const authorizer = createAuthorizer();

    registry.register(new MetaGetAccountsTool(provider, authorizer));
    registry.register(new MetaGetCampaignsTool(provider, authorizer));
    registry.register(new MetaGetInsightsTool(provider, authorizer));

    const descs = registry.getToolDescriptions("user-1", "admin");
    expect(descs.length).toBeGreaterThanOrEqual(3);

    const accountsDesc = descs.find((d) => d.name === "meta.accounts");
    expect(accountsDesc).toBeDefined();
    expect(accountsDesc!.risk).toBe("READ_ONLY");
    expect(accountsDesc!.approvalRequired).toBe(false);
  });
});

// ===========================================================================
// FULL EXECUTOR PIPELINE
// ===========================================================================

describe("Full Executor Pipeline", () => {
  let registry: TR;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new TR();
    const provider = createMockMetaProvider();
    const authorizer = createAuthorizer();

    registry.register(new MetaGetAccountsTool(provider, authorizer));
    registry.register(new MetaGetCampaignsTool(provider, authorizer));
    registry.register(new MetaGetAdSetsTool(provider, authorizer));
    registry.register(new MetaGetAdsTool(provider, authorizer));
    registry.register(new MetaGetInsightsTool(provider, authorizer));

    executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger);
  });

  it("executes accounts tool through full pipeline", async () => {
    const result = await executor.execute({
      toolId: "meta.accounts",
      params: {},
      userId: "user-1",
      role: "admin",
      traceId: "trace-1",
    });
    expect(result.status).toBe("completed");
    expect(result.result!.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("executes campaigns through full pipeline", async () => {
    const result = await executor.execute({
      toolId: "meta.campaigns",
      params: { accountId: "act_111111111" },
      userId: "user-1",
      role: "admin",
      traceId: "trace-1",
    });
    expect(result.status).toBe("completed");
    expect(result.result!.success).toBe(true);
  });

  it("executes insights through full pipeline", async () => {
    const result = await executor.execute({
      toolId: "meta.insights",
      params: { accountId: "act_111111111", startDate: "2025-03-01", endDate: "2025-03-07" },
      userId: "user-1",
      role: "admin",
      traceId: "trace-1",
    });
    expect(result.status).toBe("completed");
    expect(result.result!.success).toBe(true);
  });

  it("audit is logged for every execution", async () => {
    await executor.execute({
      toolId: "meta.accounts",
      params: {},
      userId: "user-1",
      role: "admin",
      traceId: "trace-1",
    });
    expect(noopAuditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        toolId: "meta.accounts",
        action: "tool.execute",
        traceId: "trace-1",
      })
    );
  });

  it("denies viewer permission for tools", async () => {
    const denyPerms: IPermissionChecker = { hasPermission: () => false };
    const denyExecutor = new ToolExecutor(registry, denyPerms, noopApprovalManager, noopAuditLogger);
    const result = await denyExecutor.execute({
      toolId: "meta.accounts",
      params: {},
      userId: "viewer-1",
      role: "viewer",
      traceId: "trace-1",
    });
    expect(result.status).toBe("permission_denied");
  });

  it("handles timeout", async () => {
    const slowProvider = createMockMetaProvider({ delayMs: 5000 });
    const slowAuth = createAuthorizer();
    const slowRegistry = new TR();
    slowRegistry.register(new MetaGetAccountsTool(slowProvider, slowAuth));
    const slowExecutor = new ToolExecutor(slowRegistry, allowAllPermissions, noopApprovalManager, noopAuditLogger, {
      defaultTimeoutMs: 100,
    });

    const result = await slowExecutor.execute({
      toolId: "meta.accounts",
      params: {},
      userId: "user-1",
      role: "admin",
      traceId: "trace-1",
    });
    expect(result.status).toBe("timed_out");
  });

  it("handles tool not found", async () => {
    const result = await executor.execute({
      toolId: "meta.nonexistent",
      params: {},
      userId: "user-1",
      role: "admin",
      traceId: "trace-1",
    });
    expect(result.status).toBe("failed");
  });
});

// ===========================================================================
// OUTPUT SANITIZATION
// ===========================================================================

describe("Output Sanitization", () => {
  it("sanitizes Meta output through pipeline", () => {
    const result: ToolResult = {
      success: true,
      data: {
        accounts: [{ accountId: "act_111111111", name: "Test", token: "secret123" }],
      },
    };
    const sanitized = sanitizeToolResult(result);
    const json = JSON.stringify(sanitized.result);
    expect(json).not.toContain("secret123");
  });

  it("wraps output in tool_result tags", () => {
    const result: ToolResult = {
      success: true,
      data: { campaigns: [{ name: "Test Campaign" }] },
    };
    const wrapped = wrapToolResult(result);
    expect(wrapped).toContain("<tool_result>");
    expect(wrapped).toContain("Test Campaign");
  });

  it("truncates large insight results", () => {
    const result: ToolResult = {
      success: true,
      data: { insights: "x".repeat(200_000) },
    };
    const sanitized = sanitizeToolResult(result, { maxResultSizeBytes: 1000 });
    expect(sanitized.result.success).toBe(false);
    expect(sanitized.result.error).toContain("too large");
  });
});

// ===========================================================================
// ARBITRARY API PATH REJECTED
// ===========================================================================

describe("Arbitrary API Path Prevention", () => {
  it("account IDs are validated, not passed through raw", async () => {
    const provider = createMockMetaProvider();
    const authorizer = createAuthorizer();
    const tool = new MetaGetCampaignsTool(provider, authorizer);

    const malicious = await tool.execute(
      { accountId: "../../etc/passwd" },
      { userId: "user-1" }
    );
    expect(malicious.success).toBe(false);

    const injection = await tool.execute(
      { accountId: "act_123/../../admin" },
      { userId: "user-1" }
    );
    expect(injection.success).toBe(false);
  });

  it("no raw Graph API paths accepted", async () => {
    const provider = createMockMetaProvider();
    const authorizer = createAuthorizer();
    const tool = new MetaGetInsightsTool(provider, authorizer);

    const result = await tool.execute(
      {
        accountId: "act_111111111",
        startDate: "2025-03-01",
        endDate: "2025-03-07",
        breakdown: "age; DROP TABLE users;",
      },
      { userId: "user-1" }
    );
    expect(result.success).toBe(true);
    const data = result.data as { breakdown: null };
    expect(data.breakdown).toBeNull();
  });
});

// ===========================================================================
// NO REAL META API CALLS
// ===========================================================================

describe("No Real API Calls", () => {
  it("mock provider never makes HTTP requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createMockMetaProvider();
    const authorizer = createAuthorizer();
    const tool = new MetaGetAccountsTool(provider, authorizer);

    await tool.execute({}, { userId: "user-1" });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
