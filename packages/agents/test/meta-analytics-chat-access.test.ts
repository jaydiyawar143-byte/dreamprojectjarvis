import { describe, it, expect, beforeEach } from "vitest";
import type {
  IAIProvider,
  IToolExecutor,
  ITool,
  AuditLogger,
  AIToolDefinition,
  AICompletionRequest,
  AICompletionResponse,
  ToolExecutionRequest,
  ToolExecutionResult,
  AuditEntry,
  JarvisRequest,
  SessionContext,
  RiskLevel,
} from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";

// ---------------------------------------------------------------------------
// Mock AI Provider — tracks tool definitions passed to it
// ---------------------------------------------------------------------------

class MockAIProvider implements IAIProvider {
  readonly id = "mock-ai";
  readonly name = "Mock AI";
  readonly defaultModel = "mock-model";
  private responseFn: ((req: AICompletionRequest) => AICompletionResponse) | null = null;
  private shouldFail = false;
  private receivedRequests: AICompletionRequest[] = [];

  setResponse(fn: (req: AICompletionRequest) => AICompletionResponse) {
    this.responseFn = fn;
  }
  setShouldFail(fail: boolean) { this.shouldFail = fail; }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.receivedRequests.push(request);
    if (this.shouldFail) throw new Error("AI provider unavailable");
    if (this.responseFn) return this.responseFn(request);
    return { message: { role: "assistant", content: "Default response" }, finishReason: "stop", model: this.defaultModel };
  }
  async listModels() { return [this.defaultModel]; }
  async isAvailable() { return !this.shouldFail; }

  getReceivedRequests(): AICompletionRequest[] {
    return this.receivedRequests;
  }
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
// Mock Tool Executor — tracks calls
// ---------------------------------------------------------------------------

function createMockToolExecutor(): IToolExecutor & { getRequests: () => ToolExecutionRequest[] } {
  const requests: ToolExecutionRequest[] = [];
  return {
    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      requests.push(request);
      return {
        executionId: request.executionId ?? "exec-1",
        toolId: request.toolId,
        status: "completed",
        result: { success: true, data: `Executed ${request.toolId}` },
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 10,
      };
    },
    getRequests: () => requests,
  };
}

// ---------------------------------------------------------------------------
// Mock Audit Logger
// ---------------------------------------------------------------------------

function createMockAuditLogger(): AuditLogger & { getEntries: () => AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    async log(entry) { entries.push({ ...entry, id: `audit-${entries.length}`, timestamp: new Date() } as AuditEntry); },
    async query() { return entries; },
    getEntries: () => entries,
  };
}

// ---------------------------------------------------------------------------
// Simple Tool Registry
// ---------------------------------------------------------------------------

function createToolRegistry(tools: ITool[]) {
  const map = new Map(tools.map((t) => [t.id, t]));
  return {
    get: (toolId: string) => map.get(toolId),
    getAll: () => [...tools],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(userId = "user-1", conversationId?: string): SessionContext {
  return {
    auth: { userId, role: "member", email: `${userId}@test.com` },
    conversationId,
    traceId: "00000000-0000-0000-0000-000000000001",
  };
}

function req(message: string, conversationId?: string): JarvisRequest {
  return { message, conversationId, stream: false };
}

// ---------------------------------------------------------------------------
// ITool → AIToolDefinition conversion (mirrors container.ts logic)
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
// Tests
// ---------------------------------------------------------------------------

describe("REGRESSION: Meta Analytics Chat Access", () => {
  let mockAI: MockAIProvider;
  let toolExecutor: ReturnType<typeof createMockToolExecutor>;
  let auditLogger: ReturnType<typeof createMockAuditLogger>;
  let registry: AgentRegistry;

  beforeEach(() => {
    mockAI = new MockAIProvider();
    toolExecutor = createMockToolExecutor();
    auditLogger = createMockAuditLogger();
    registry = new AgentRegistry();
  });

  // -----------------------------------------------------------------------
  // 1. Agent receives tool definitions and passes them to AI provider
  // -----------------------------------------------------------------------

  describe("1. Agent receives tool definitions from registry", () => {
    it("passes AIToolDefinition[] to AI provider when tools are configured", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get Meta ad performance insights",
          category: "marketing",
          parameters: [
            { name: "accountId", type: "string", description: "Meta ad account ID", required: true },
            { name: "startDate", type: "string", description: "Start date", required: true },
            { name: "endDate", type: "string", description: "End date", required: true },
          ],
        }),
        fakeTool({
          id: "meta.campaigns",
          description: "List Meta campaigns",
          category: "marketing",
          parameters: [
            { name: "accountId", type: "string", description: "Meta ad account ID", required: true },
          ],
        }),
      ];

      const { definitions: agentTools } = convertToolsToAIToolDefinitions(metaTools);

      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
        tools: agentTools,
      });
      registry.register(agent);

      mockAI.setResponse(() => ({
        message: { role: "assistant", content: "Done" },
        finishReason: "stop",
        model: "mock",
      }));

      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      await orch.process(req("Summarize my Meta ads performance"), ctx());

      const receivedRequests = mockAI.getReceivedRequests();
      expect(receivedRequests).toHaveLength(1);

      const tools = receivedRequests[0]!.tools;
      expect(tools).toBeDefined();
      expect(tools).toHaveLength(2);

      const insightsTool = tools!.find((t) => t.name === "meta-insights");
      expect(insightsTool).toBeDefined();
      expect(insightsTool!.description).toContain("Meta");
      expect(insightsTool!.parameters).toHaveProperty("type", "object");
      expect(insightsTool!.parameters).toHaveProperty("properties");
      expect(insightsTool!.parameters).toHaveProperty("required");
      expect((insightsTool!.parameters as any).required).toContain("accountId");
      expect((insightsTool!.parameters as any).required).toContain("startDate");
      expect((insightsTool!.parameters as any).required).toContain("endDate");
    });

    it("does NOT pass tools to AI provider when none configured", async () => {
      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
      });
      registry.register(agent);

      mockAI.setResponse(() => ({
        message: { role: "assistant", content: "Done" },
        finishReason: "stop",
        model: "mock",
      }));

      const orch = new Orchestrator(registry, toolExecutor, auditLogger);
      await orch.process(req("Hello"), ctx());

      const receivedRequests = mockAI.getReceivedRequests();
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]!.tools).toBeUndefined();
    });

    it("excludes disabled tools from AIToolDefinition list", async () => {
      const metaTools: ITool[] = [
        fakeTool({ id: "meta.insights", enabled: true }),
        fakeTool({ id: "meta.campaigns", enabled: false }),
      ];

      const { definitions } = convertToolsToAIToolDefinitions(metaTools);
      expect(definitions).toHaveLength(1);
      expect(definitions[0]!.name).toBe("meta-insights");
    });
  });

  // -----------------------------------------------------------------------
  // 2. Orchestrator passes toolRegistry to agent context
  // -----------------------------------------------------------------------

  describe("2. Orchestrator wires toolRegistry to agent context", () => {
    it("agent receives real toolRegistry via context when orchestrator has toolRegistry", async () => {
      const tools = [
        fakeTool({
          id: "meta.insights",
          description: "Get Meta insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
          ],
        }),
      ];
      const { definitions: agentTools } = convertToolsToAIToolDefinitions(tools);

      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
        tools: agentTools,
      });
      registry.register(agent);

      mockAI.setResponse(() => ({
        message: { role: "assistant", content: "Done" },
        finishReason: "stop",
        model: "mock",
      }));

      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
      });

      const res = await orch.process(req("Hello"), ctx());
      expect(res.success).toBe(true);
    });

    it("agent gets noop fallback when orchestrator has no toolRegistry", async () => {
      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
      });
      registry.register(agent);

      mockAI.setResponse(() => ({
        message: { role: "assistant", content: "Done" },
        finishReason: "stop",
        model: "mock",
      }));

      const orch = new Orchestrator(registry, toolExecutor, auditLogger);

      const res = await orch.process(req("Hello"), ctx());
      expect(res.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Full tool call flow: agent → orchestrator → executor
  // -----------------------------------------------------------------------

  describe("3. Full Meta analytics tool call flow", () => {
    it("agent makes tool call → orchestrator executes → results fed back", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get Meta ad performance insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start date", required: true },
            { name: "endDate", type: "string", description: "End date", required: true },
          ],
          execute: async (params) => ({
            success: true,
            data: {
              accountId: params.accountId,
              insights: [{ spend: 1500, impressions: 50000, clicks: 1200, ctr: 2.4 }],
            },
          }),
        }),
      ];

      const { definitions: agentTools, sanitizedToOriginal } = convertToolsToAIToolDefinitions(metaTools);
      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
        tools: agentTools,
      });
      registry.register(agent);

      // LLM returns sanitized name (as OpenAI requires) — orchestrator resolves it
      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Let me fetch your Meta ads performance.",
              toolCalls: [{
                id: "call-1",
                name: "meta-insights",
                arguments: { accountId: "act_123456", startDate: "2026-08-01", endDate: "2026-08-25" },
              }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return {
          message: { role: "assistant", content: "Your Meta ads account spent $1,500 with 2.4% CTR." },
          finishReason: "stop",
          model: "mock",
        };
      });

      const resolvingRegistry = {
        get(toolId: string) {
          const original = sanitizedToOriginal.get(toolId) ?? toolId;
          return createToolRegistry(metaTools).get(original);
        },
        getAll: () => metaTools,
      };

      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: resolvingRegistry,
      });

      const res = await orch.process(req("Mere Meta ads account ki current performance summarize karo"), ctx());

      expect(res.success).toBe(true);
      expect(res.data!.message).toContain("Meta ads");
      expect(toolExecutor.getRequests()).toHaveLength(1);
      expect(toolExecutor.getRequests()[0]!.toolId).toBe("meta-insights");
      expect(toolExecutor.getRequests()[0]!.params).toEqual({
        accountId: "act_123456",
        startDate: "2026-08-01",
        endDate: "2026-08-25",
      });
    });

    it("agent can select meta.campaigns tool when appropriate", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.campaigns",
          description: "List campaigns for a Meta ad account",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
          ],
          execute: async (params) => ({
            success: true,
            data: { campaigns: [{ name: "Summer Sale", status: "ACTIVE" }] },
          }),
        }),
      ];

      const { definitions: agentTools, sanitizedToOriginal } = convertToolsToAIToolDefinitions(metaTools);
      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
        tools: agentTools,
      });
      registry.register(agent);

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Fetching campaigns.",
              toolCalls: [{
                id: "call-1",
                name: "meta-campaigns",
                arguments: { accountId: "act_123456" },
              }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return {
          message: { role: "assistant", content: "You have 1 active campaign: Summer Sale." },
          finishReason: "stop",
          model: "mock",
        };
      });

      const resolvingRegistry = {
        get(toolId: string) {
          const original = sanitizedToOriginal.get(toolId) ?? toolId;
          return createToolRegistry(metaTools).get(original);
        },
        getAll: () => metaTools,
      };

      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: resolvingRegistry,
      });

      const res = await orch.process(req("List my Meta campaigns"), ctx());

      expect(res.success).toBe(true);
      expect(toolExecutor.getRequests()).toHaveLength(1);
      expect(toolExecutor.getRequests()[0]!.toolId).toBe("meta-campaigns");
    });
  });

  // -----------------------------------------------------------------------
  // 4. Write tool gating: no writes without approval
  // -----------------------------------------------------------------------

  describe("4. Write tools are gated by approval", () => {
    it("write tool blocked when no approval", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.campaign.pause",
          description: "Pause a campaign",
          risk: "EXTERNAL_SIDE_EFFECT" as RiskLevel,
          requiresApproval: true,
          requiredPermissions: ["read", "write"],
        }),
      ];

      const { definitions: agentTools } = convertToolsToAIToolDefinitions(metaTools);
      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
        tools: agentTools,
      });
      registry.register(agent);

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Pausing campaign.",
              toolCalls: [{
                id: "call-1",
                name: "meta.campaign.pause",
                arguments: { campaignId: "123" },
              }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return {
          message: { role: "assistant", content: "Done" },
          finishReason: "stop",
          model: "mock",
        };
      });

      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
        toolApprovalService: {
          async checkPreExecution(_tool, _params, _req) {
            return {
              allowed: false,
              requiresApproval: true,
              approvalId: "pending-approval-1",
              reason: "Write tool requires human approval",
            };
          },
        },
      });

      const res = await orch.process(req("Pause my campaign"), ctx());

      expect(res.success).toBe(true);
      expect(toolExecutor.getRequests()).toHaveLength(0);
    });

    it("read-only tool executes without approval even with approval service", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          risk: "READ_ONLY",
          requiresApproval: false,
        }),
      ];

      const { definitions: agentTools } = convertToolsToAIToolDefinitions(metaTools);
      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
        tools: agentTools,
      });
      registry.register(agent);

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Fetching.",
              toolCalls: [{
                id: "call-1",
                name: "meta-insights",
                arguments: { accountId: "act_123" },
              }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return {
          message: { role: "assistant", content: "Done" },
          finishReason: "stop",
          model: "mock",
        };
      });

      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
        toolApprovalService: {
          async checkPreExecution(_tool, _params, _req) {
            return { allowed: true, requiresApproval: false };
          },
        },
      });

      const res = await orch.process(req("Get insights"), ctx());

      expect(res.success).toBe(true);
      expect(toolExecutor.getRequests()).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // 5. ITool → AIToolDefinition conversion correctness
  // -----------------------------------------------------------------------

  describe("5. ITool → AIToolDefinition conversion", () => {
    it("produces valid JSON Schema parameters from tool parameters", () => {
      const tools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get Meta ad performance insights",
          parameters: [
            { name: "accountId", type: "string", description: "Meta ad account ID", required: true },
            { name: "startDate", type: "string", description: "Start date (YYYY-MM-DD)", required: true },
            { name: "endDate", type: "string", description: "End date (YYYY-MM-DD)", required: true },
            { name: "level", type: "string", description: "Insight level", required: false },
          ],
        }),
      ];

      const { definitions } = convertToolsToAIToolDefinitions(tools);
      expect(definitions).toHaveLength(1);

      const def = definitions[0]!;
      expect(def.name).toBe("meta-insights");
      expect(def.description).toBe("Get Meta ad performance insights");

      const params = def.parameters as any;
      expect(params.type).toBe("object");
      expect(params.properties.accountId).toEqual({ type: "string", description: "Meta ad account ID" });
      expect(params.properties.startDate).toEqual({ type: "string", description: "Start date (YYYY-MM-DD)" });
      expect(params.properties.endDate).toEqual({ type: "string", description: "End date (YYYY-MM-DD)" });
      expect(params.properties.level).toEqual({ type: "string", description: "Insight level" });
      expect(params.required).toEqual(["accountId", "startDate", "endDate"]);
    });

    it("produces empty properties for tools with no parameters", () => {
      const tools: ITool[] = [fakeTool({ id: "no-params", parameters: [] })];
      const { definitions } = convertToolsToAIToolDefinitions(tools);
      const params = definitions[0]!.parameters as any;
      expect(params.properties).toEqual({});
      expect(params.required).toEqual([]);
    });

    it("converts multiple Meta tools with sanitized names", () => {
      const tools: ITool[] = [
        fakeTool({ id: "meta.accounts", description: "List accounts", parameters: [] }),
        fakeTool({ id: "meta.campaigns", description: "List campaigns", parameters: [{ name: "accountId", type: "string", description: "ID", required: true }] }),
        fakeTool({ id: "meta.adsets", description: "List ad sets", parameters: [{ name: "accountId", type: "string", description: "ID", required: true }] }),
        fakeTool({ id: "meta.ads", description: "List ads", parameters: [{ name: "accountId", type: "string", description: "ID", required: true }] }),
        fakeTool({ id: "meta.insights", description: "Get insights", parameters: [{ name: "accountId", type: "string", description: "ID", required: true }, { name: "startDate", type: "string", description: "Start", required: true }, { name: "endDate", type: "string", description: "End", required: true }] }),
      ];

      const { definitions, sanitizedToOriginal } = convertToolsToAIToolDefinitions(tools);
      expect(definitions).toHaveLength(5);
      expect(definitions.map((d) => d.name)).toEqual([
        "meta-accounts", "meta-campaigns", "meta-adsets", "meta-ads", "meta-insights",
      ]);
      expect(sanitizedToOriginal.get("meta-insights")).toBe("meta.insights");
      expect(sanitizedToOriginal.get("meta-campaigns")).toBe("meta.campaigns");
    });

    it("sanitizeToolName replaces dots with hyphens for OpenAI compliance", () => {
      expect(sanitizeToolName("meta.insights")).toBe("meta-insights");
      expect(sanitizeToolName("meta.campaign.pause")).toBe("meta-campaign-pause");
      expect(sanitizeToolName("already-clean")).toBe("already-clean");
      expect(sanitizeToolName("under_score")).toBe("under_score");
    });

    it("all tool names match OpenAI pattern ^[a-zA-Z0-9_-]+$", () => {
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

      const openaiPattern = /^[a-zA-Z0-9_-]+$/;
      const { definitions } = convertToolsToAIToolDefinitions(tools);

      for (const def of definitions) {
        expect(def.name).toMatch(openaiPattern);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 6. Permission checks during tool execution
  // -----------------------------------------------------------------------

  describe("6. Permission checks during execution", () => {
    it("ToolExecutor checks permissions before executing", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          requiredPermissions: ["read"],
        }),
      ];

      const { definitions: agentTools } = convertToolsToAIToolDefinitions(metaTools);
      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
        tools: agentTools,
      });
      registry.register(agent);

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Fetching.",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return {
          message: { role: "assistant", content: "Done" },
          finishReason: "stop",
          model: "mock",
        };
      });

      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      const res = await orch.process(req("Get insights"), ctx("user-1"));
      expect(res.success).toBe(true);
      expect(toolExecutor.getRequests()).toHaveLength(1);

      const execReq = toolExecutor.getRequests()[0]!;
      expect(execReq.userId).toBe("user-1");
      expect(execReq.role).toBe("member");
    });
  });
});
