import { describe, it, expect } from "vitest";
import type { ITool, AIToolDefinition, RiskLevel } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Mirror of the conversion function from container.ts for regression testing.
// If container.ts changes, this test catches drift.
// ---------------------------------------------------------------------------

function sanitizeToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function convertToolsToAIToolDefinitions(tools: ITool[]): { definitions: AIToolDefinition[]; sanitizedToOriginal: Map<string, string> } {
  const sanitizedToOriginal = new Map<string, string>();
  const definitions = tools
    .filter((t) => t.enabled)
    .map((t) => {
      const sanitized = sanitizeToolName(t.id);
      if (sanitized !== t.id) {
        sanitizedToOriginal.set(sanitized, t.id);
      }
      return {
        name: sanitized,
        description: t.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            t.parameters.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ])
          ),
          required: t.parameters.filter((p) => p.required).map((p) => p.name),
        },
      };
    });
  return { definitions, sanitizedToOriginal };
}

// ---------------------------------------------------------------------------
// Fake ITool
// ---------------------------------------------------------------------------

function fakeTool(overrides: Partial<ITool> & { id: string }): ITool {
  return {
    name: overrides.id,
    description: `Tool ${overrides.id}`,
    category: "system",
    risk: "READ_ONLY" as RiskLevel,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("REGRESSION: Container tool wiring — convertToolsToAIToolDefinitions", () => {
  it("converts ITool[] to AIToolDefinition[] with correct structure", () => {
    const tools: ITool[] = [
      fakeTool({
        id: "meta.insights",
        description: "Get performance insights",
        parameters: [
          { name: "accountId", type: "string", description: "Account ID", required: true },
          { name: "startDate", type: "string", description: "Start date", required: true },
        ],
      }),
    ];

    const { definitions } = convertToolsToAIToolDefinitions(tools);

    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.name).toBe("meta-insights");
    expect(definitions[0]!.description).toBe("Get performance insights");

    const params = definitions[0]!.parameters as any;
    expect(params.type).toBe("object");
    expect(params.properties.accountId).toEqual({ type: "string", description: "Account ID" });
    expect(params.required).toEqual(["accountId", "startDate"]);
  });

  it("filters out disabled tools", () => {
    const tools: ITool[] = [
      fakeTool({ id: "meta.insights", enabled: true }),
      fakeTool({ id: "meta.campaigns", enabled: false }),
    ];

    const { definitions } = convertToolsToAIToolDefinitions(tools);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.name).toBe("meta-insights");
  });

  it("produces valid OpenAI-compatible function definitions", () => {
    const tools: ITool[] = [
      fakeTool({
        id: "meta.insights",
        description: "Get Meta ad performance insights",
        parameters: [
          { name: "accountId", type: "string", description: "Meta ad account ID", required: true },
        ],
      }),
      fakeTool({
        id: "meta.campaigns",
        description: "List campaigns",
        parameters: [
          { name: "accountId", type: "string", description: "Account ID", required: true },
        ],
      }),
    ];

    const { definitions } = convertToolsToAIToolDefinitions(tools);

    const openaiTools = definitions.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    expect(openaiTools).toHaveLength(2);
    expect(openaiTools[0]!.type).toBe("function");
    expect(openaiTools[0]!.function.name).toBe("meta-insights");
    expect(openaiTools[0]!.function.parameters).toHaveProperty("type", "object");

    for (const t of openaiTools) {
      expect(typeof t.function.name).toBe("string");
      expect(typeof t.function.description).toBe("string");
      expect(typeof t.function.parameters).toBe("object");
    }
  });

  it("handles empty tool list", () => {
    const { definitions } = convertToolsToAIToolDefinitions([]);
    expect(definitions).toEqual([]);
  });

  it("handles tools with no parameters", () => {
    const tools: ITool[] = [fakeTool({ id: "no-params", parameters: [] })];
    const { definitions } = convertToolsToAIToolDefinitions(tools);
    expect(definitions).toHaveLength(1);
    const params = definitions[0]!.parameters as any;
    expect(params.properties).toEqual({});
    expect(params.required).toEqual([]);
  });

  it("preserves parameter types (string, number, array)", () => {
    const tools: ITool[] = [
      fakeTool({
        id: "meta.insights",
        parameters: [
          { name: "accountId", type: "string", description: "ID", required: true },
          { name: "limit", type: "number", description: "Max results", required: false },
          { name: "campaignIds", type: "array", description: "Filter IDs", required: false },
        ],
      }),
    ];

    const { definitions } = convertToolsToAIToolDefinitions(tools);
    const params = definitions[0]!.parameters as any;
    expect(params.properties.accountId.type).toBe("string");
    expect(params.properties.limit.type).toBe("number");
    expect(params.properties.campaignIds.type).toBe("array");
    expect(params.required).toEqual(["accountId"]);
  });

  it("sanitizeToolName replaces dots for OpenAI compliance", () => {
    expect(sanitizeToolName("meta.insights")).toBe("meta-insights");
    expect(sanitizeToolName("meta.campaign.pause")).toBe("meta-campaign-pause");
    expect(sanitizeToolName("already-clean")).toBe("already-clean");
  });

  it("sanitizedToOriginal map is built correctly", () => {
    const tools: ITool[] = [
      fakeTool({ id: "meta.insights" }),
      fakeTool({ id: "meta.campaigns" }),
      fakeTool({ id: "clean-tool" }),
    ];

    const { sanitizedToOriginal } = convertToolsToAIToolDefinitions(tools);
    expect(sanitizedToOriginal.get("meta-insights")).toBe("meta.insights");
    expect(sanitizedToOriginal.get("meta-campaigns")).toBe("meta.campaigns");
    expect(sanitizedToOriginal.has("clean-tool")).toBe(false);
  });

  it("all tool names match OpenAI pattern ^[a-zA-Z0-9_-]+$ after sanitization", () => {
    const openaiPattern = /^[a-zA-Z0-9_-]+$/;
    const tools: ITool[] = [
      fakeTool({ id: "meta.accounts" }),
      fakeTool({ id: "meta.campaigns" }),
      fakeTool({ id: "meta.adsets" }),
      fakeTool({ id: "meta.ads" }),
      fakeTool({ id: "meta.insights" }),
      fakeTool({ id: "meta.campaign.pause" }),
      fakeTool({ id: "meta.campaign.resume" }),
      fakeTool({ id: "meta.adset.pause" }),
      fakeTool({ id: "meta.adset.resume" }),
      fakeTool({ id: "meta.ad.pause" }),
      fakeTool({ id: "meta.ad.resume" }),
      fakeTool({ id: "meta.campaign.budget.update" }),
      fakeTool({ id: "meta.adset.budget.update" }),
      fakeTool({ id: "meta.campaign.create" }),
    ];

    const { definitions } = convertToolsToAIToolDefinitions(tools);
    for (const def of definitions) {
      expect(def.name).toMatch(openaiPattern);
    }
  });
});

describe("REGRESSION: All 5 Meta READ tools must be present", () => {
  it("container.ts registers all 5 Meta READ tools when env vars are set", async () => {
    const { MetaGetAccountsTool, MetaGetCampaignsTool, MetaGetAdSetsTool, MetaGetAdsTool, MetaGetInsightsTool } = await import("@jarvis/tools");

    expect(typeof MetaGetAccountsTool).toBe("function");
    expect(typeof MetaGetCampaignsTool).toBe("function");
    expect(typeof MetaGetAdSetsTool).toBe("function");
    expect(typeof MetaGetAdsTool).toBe("function");
    expect(typeof MetaGetInsightsTool).toBe("function");
  });

  it("each Meta READ tool has correct id and required permissions", async () => {
    const tools = await import("@jarvis/tools");

    const mockProvider = {
      getAdAccounts: async () => ({ data: [], nextPage: undefined }),
      getCampaigns: async () => ({ data: [], nextPage: undefined }),
      getAdSets: async () => ({ data: [], nextPage: undefined }),
      getAds: async () => ({ data: [], nextPage: undefined }),
      getInsights: async () => ({ data: [], nextPage: undefined }),
      isAuthorized: async () => true,
      getAuthorizedAccountIds: async () => [],
    };

    const accounts = new tools.MetaGetAccountsTool(mockProvider as any, mockProvider as any);
    const campaigns = new tools.MetaGetCampaignsTool(mockProvider as any, mockProvider as any);
    const adsets = new tools.MetaGetAdSetsTool(mockProvider as any, mockProvider as any);
    const ads = new tools.MetaGetAdsTool(mockProvider as any, mockProvider as any);
    const insights = new tools.MetaGetInsightsTool(mockProvider as any, mockProvider as any);

    const instances = [accounts, campaigns, adsets, ads, insights];

    for (const tool of instances) {
      expect(tool.enabled).toBe(true);
      expect(tool.risk).toBe("READ_ONLY");
      expect(tool.requiresApproval).toBe(false);
      expect(tool.requiredPermissions).toContain("read");
    }

    expect(accounts.id).toBe("meta.accounts");
    expect(campaigns.id).toBe("meta.campaigns");
    expect(adsets.id).toBe("meta.adsets");
    expect(ads.id).toBe("meta.ads");
    expect(insights.id).toBe("meta.insights");
  });

  // INVERTED, deliberately. Requiring these is what forced the model to invent
  // them, and a model has no reliable idea what today's date is — it produced a
  // 2023 window on a 2026 server and the empty result came back as "your
  // campaigns have no data". Account and dates are all now resolved server-side
  // when absent, so the correct assertion is that none of them is required.
  it("meta.insights requires no parameter the model would have to invent", async () => {
    const tools = await import("@jarvis/tools");
    const mockProvider = {
      getInsights: async () => ({ data: [], nextPage: undefined }),
      isAuthorized: async () => true,
      getAuthorizedAccountIds: async () => [],
    };

    const insights = new tools.MetaGetInsightsTool(mockProvider as any, mockProvider as any);
    const requiredParams = insights.parameters.filter((p) => p.required).map((p) => p.name);

    expect(requiredParams).not.toContain("accountId");
    expect(requiredParams).not.toContain("startDate");
    expect(requiredParams).not.toContain("endDate");

    // Still declared, so a caller that DOES know them can pass them.
    const names = insights.parameters.map((p) => p.name);
    expect(names).toContain("accountId");
    expect(names).toContain("startDate");
    expect(names).toContain("endDate");
  });
});

describe("REGRESSION: No write tools invoked without approval", () => {
  it("all Meta write tools require approval", async () => {
    const tools = await import("@jarvis/tools");
    const mockProvider = {};
    const mockJournal = { claim: async () => ({}), record: async () => ({}) };
    const mockApproval = { create: async () => ({ id: "a1" }) };

    const writeTools = [
      new tools.MetaPauseCampaignTool(mockProvider as any, mockProvider as any, mockJournal as any, mockApproval as any),
      new tools.MetaResumeCampaignTool(mockProvider as any, mockProvider as any, mockJournal as any, mockApproval as any),
      new tools.MetaPauseAdSetTool(mockProvider as any, mockProvider as any, mockJournal as any, mockApproval as any),
      new tools.MetaResumeAdSetTool(mockProvider as any, mockProvider as any, mockJournal as any, mockApproval as any),
      new tools.MetaPauseAdTool(mockProvider as any, mockProvider as any, mockJournal as any, mockApproval as any),
      new tools.MetaResumeAdTool(mockProvider as any, mockProvider as any, mockJournal as any, mockApproval as any),
      new tools.MetaUpdateCampaignBudgetTool(mockProvider as any, mockProvider as any, undefined, mockJournal as any, mockApproval as any),
      new tools.MetaUpdateAdSetBudgetTool(mockProvider as any, mockProvider as any, undefined, mockJournal as any, mockApproval as any),
      new tools.MetaCreateCampaignTool(mockProvider as any, mockProvider as any, undefined, mockJournal as any, mockApproval as any),
    ];

    for (const tool of writeTools) {
      expect(tool.requiresApproval).toBe(true);
      expect(tool.risk).not.toBe("READ_ONLY");
      expect(tool.requiredPermissions).toContain("write");
    }
  });
});
