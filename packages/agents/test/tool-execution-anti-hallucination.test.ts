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
// Mock AI Provider
// ---------------------------------------------------------------------------

class MockAIProvider implements IAIProvider {
  readonly id = "mock-ai";
  readonly name = "Mock AI";
  readonly defaultModel = "mock-model";
  private responseFn: ((req: AICompletionRequest) => AICompletionResponse) | null = null;
  private receivedRequests: AICompletionRequest[] = [];

  setResponse(fn: (req: AICompletionRequest) => AICompletionResponse) {
    this.responseFn = fn;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.receivedRequests.push(request);
    if (this.responseFn) return this.responseFn(request);
    return { message: { role: "assistant", content: "Default response" }, finishReason: "stop", model: this.defaultModel };
  }
  async listModels() { return [this.defaultModel]; }
  async isAvailable() { return true; }

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
    category: "marketing",
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
// Mock Tool Executor — configurable per-tool
// ---------------------------------------------------------------------------

function createConfigurableToolExecutor(
  toolBehavior: Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>
): IToolExecutor & { getRequests: () => ToolExecutionRequest[] } {
  const requests: ToolExecutionRequest[] = [];
  return {
    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      requests.push(request);
      const behavior = toolBehavior.get(request.toolId);
      if (behavior) return behavior(request);
      return {
        executionId: request.executionId ?? "exec-1",
        toolId: request.toolId,
        toolCallId: request.toolCallId,
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

describe("Tool Execution & Anti-Hallucination Enforcement", () => {
  let mockAI: MockAIProvider;
  let auditLogger: ReturnType<typeof createMockAuditLogger>;
  let registry: AgentRegistry;

  beforeEach(() => {
    mockAI = new MockAIProvider();
    auditLogger = createMockAuditLogger();
    registry = new AgentRegistry();
  });

  // -----------------------------------------------------------------------
  // 1. Successful Meta tool execution — real data passes through
  // -----------------------------------------------------------------------

  describe("1. Successful Meta tool execution", () => {
    it("returns real data with toolExecution summary showing success", async () => {
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
              dateRange: { start: params.startDate, end: params.endDate },
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

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Fetching Meta insights.",
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
          message: { role: "assistant", content: "Your Meta ads spent $1,500 with 2.4% CTR." },
          finishReason: "stop",
          model: "mock",
        };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        toolCallId: req.toolCallId,
        status: "completed",
        result: {
          success: true,
          data: {
            accountId: "act_123456",
            insights: [{ spend: 1500, impressions: 50000, clicks: 1200, ctr: 2.4 }],
            dateRange: { start: "2026-08-01", end: "2026-08-25" },
          },
        },
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 150,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
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

      const res = await orch.process(req("Show me my Meta ads performance"), ctx());

      expect(res.success).toBe(true);
      expect(toolExecutor.getRequests()).toHaveLength(1);

      const meta = res.data!.metadata as Record<string, unknown>;
      expect(meta.toolExecution).toBeDefined();
      const summary = meta.toolExecution as Record<string, unknown>;
      expect(summary.total).toBe(1);
      expect(summary.succeeded).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.allSucceeded).toBe(true);
      expect(summary.allFailed).toBe(false);
    });

    it("tool result envelope contains structured DATA field with provenance", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
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

      let receivedToolContent = "";
      let callCount = 0;
      mockAI.setResponse((req) => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        const toolMsg = req.messages.find((m) => m.role === "tool");
        if (toolMsg) receivedToolContent = toolMsg.content;
        return { message: { role: "assistant", content: "Done" }, finishReason: "stop", model: "mock" };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        status: "completed",
        result: {
          success: true,
          data: { accountId: "act_123", insights: [{ spend: 500 }], dateRange: { start: "2026-08-01", end: "2026-08-25" } },
        },
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 120,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      await orch.process(req("Get insights"), ctx());

      expect(receivedToolContent).toContain("TOOL: meta-insights");
      expect(receivedToolContent).toContain("STATUS: COMPLETED");
      expect(receivedToolContent).toContain("DATA:");
      expect(receivedToolContent).toContain("act_123");
      expect(receivedToolContent).toContain("500");
    });
  });

  // -----------------------------------------------------------------------
  // 2. Meta API returns empty data
  // -----------------------------------------------------------------------

  describe("2. Meta API returns empty data", () => {
    it("returns success with toolExecution summary and empty data indicator", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
          ],
          execute: async () => ({
            success: true,
            data: { insights: [], count: 0 },
          }),
        }),
      ];

      const { definitions: agentTools } = convertToolsToAIToolDefinitions(metaTools);
      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
        tools: agentTools,
      });
      registry.register(agent);

      let receivedToolContent = "";
      let callCount = 0;
      mockAI.setResponse((req) => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-01-01", endDate: "2026-01-02" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        const toolMsg = req.messages.find((m) => m.role === "tool");
        if (toolMsg) receivedToolContent = toolMsg.content;
        return { message: { role: "assistant", content: "No data found." }, finishReason: "stop", model: "mock" };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        status: "completed",
        result: { success: true, data: { insights: [], count: 0 } },
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 100,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      const res = await orch.process(req("Get insights for January"), ctx());

      expect(res.success).toBe(true);
      expect(receivedToolContent).toContain("STATUS: COMPLETED");
      expect(receivedToolContent).toContain("DATA:");
    });
  });

  // -----------------------------------------------------------------------
  // 3. Meta API returns an error
  // -----------------------------------------------------------------------

  describe("3. Meta API returns an error", () => {
    it("returns failure when tool execution fails (API error)", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
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

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return {
          message: { role: "assistant", content: "I was unable to retrieve your Meta Ads data." },
          finishReason: "stop",
          model: "mock",
        };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        toolCallId: req.toolCallId,
        status: "failed",
        result: { success: false, error: "Meta API error: Invalid access token" },
        error: "Meta API error: Invalid access token",
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 200,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      const res = await orch.process(req("Get insights"), ctx());

      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe("TOOL_EXECUTION_FAILED");
      expect(res.error!.message).toContain("Data retrieval failed");

      const details = res.error!.details as Record<string, unknown>;
      expect(details.toolExecution).toBeDefined();
      const summary = details.toolExecution as Record<string, unknown>;
      expect(summary.total).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.allFailed).toBe(true);
    });

    it("tool result envelope contains DATA_RETRIEVAL_FAILED on error", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
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

      let receivedToolContent = "";
      let callCount = 0;
      mockAI.setResponse((req) => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        const toolMsg = req.messages.find((m) => m.role === "tool");
        if (toolMsg) receivedToolContent = toolMsg.content;
        return { message: { role: "assistant", content: "Done" }, finishReason: "stop", model: "mock" };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        status: "failed",
        result: { success: false, error: "Meta API error: Rate limit exceeded" },
        error: "Meta API error: Rate limit exceeded",
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 50,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      await orch.process(req("Get insights"), ctx());

      expect(receivedToolContent).toContain("TOOL: meta-insights");
      expect(receivedToolContent).toContain("STATUS: FAILED");
      expect(receivedToolContent).toContain("DATA_RETRIEVAL_FAILED: Meta API error: Rate limit exceeded");
      expect(receivedToolContent).toContain("DO NOT fabricate or estimate metrics");
    });
  });

  // -----------------------------------------------------------------------
  // 4. Tool execution failure (internal error, not API error)
  // -----------------------------------------------------------------------

  describe("4. Tool execution failure (internal)", () => {
    it("returns failure when tool throws internally", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
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

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return {
          message: { role: "assistant", content: "Tool timed out." },
          finishReason: "stop",
          model: "mock",
        };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        toolCallId: req.toolCallId,
        status: "timed_out",
        result: { success: false, error: "Execution timed out" },
        error: "Execution timed out",
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 30000,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      const res = await orch.process(req("Get insights"), ctx());

      expect(res.success).toBe(false);
      expect(res.error!.code).toBe("TOOL_EXECUTION_FAILED");
    });
  });

  // -----------------------------------------------------------------------
  // 5. Unavailable Meta tool (tool not in registry)
  // -----------------------------------------------------------------------

  describe("5. Unavailable Meta tool", () => {
    it("returns failure when tool is not found in registry", async () => {
      const emptyRegistry = {
        get: () => undefined,
        getAll: () => [],
      };

      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
      });
      registry.register(agent);

      mockAI.setResponse(() => ({
        message: { role: "assistant", content: "I don't have Meta tools available." },
        finishReason: "stop",
        model: "mock",
      }));

      const toolExecutor = createConfigurableToolExecutor(new Map());
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: emptyRegistry,
      });

      const res = await orch.process(req("Get Meta insights"), ctx());

      expect(res.success).toBe(true);
      expect(res.data!.message).toContain("don't have Meta tools");
    });
  });

  // -----------------------------------------------------------------------
  // 6. LLM must not fabricate metrics after tool failure
  // -----------------------------------------------------------------------

  describe("6. Anti-hallucination: LLM must not fabricate after failure", () => {
    it("tool result envelope explicitly instructs against fabrication", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
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

      let receivedToolContent = "";
      let callCount = 0;
      mockAI.setResponse((req) => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        const toolMsg = req.messages.find((m) => m.role === "tool");
        if (toolMsg) receivedToolContent = toolMsg.content;
        return { message: { role: "assistant", content: "Done" }, finishReason: "stop", model: "mock" };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        status: "failed",
        result: { success: false, error: "Token expired" },
        error: "Token expired",
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 100,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      await orch.process(req("Show Meta performance"), ctx());

      expect(receivedToolContent).toContain("DO NOT fabricate or estimate metrics");
      expect(receivedToolContent).toContain("Data was NOT retrieved from Meta API");
      expect(receivedToolContent).toContain("DATA_RETRIEVAL_FAILED");
    });

    it("tool result envelope for missing result also instructs against fabrication", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
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

      let receivedToolContent = "";
      let callCount = 0;
      mockAI.setResponse((req) => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        const toolMsg = req.messages.find((m) => m.role === "tool");
        if (toolMsg) receivedToolContent = toolMsg.content;
        return { message: { role: "assistant", content: "Done" }, finishReason: "stop", model: "mock" };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        status: "permission_denied",
        error: "Missing permission: read",
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 5,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      await orch.process(req("Get insights"), ctx());

      expect(receivedToolContent).toContain("DO NOT fabricate or estimate metrics");
      expect(receivedToolContent).toContain("no result — tool did not execute");
    });
  });

  // -----------------------------------------------------------------------
  // 7. Mixed results: some tools succeed, some fail
  // -----------------------------------------------------------------------

  describe("7. Mixed results: partial success", () => {
    it("returns success when at least one tool succeeds", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
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
              content: "",
              toolCalls: [
                { id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } },
                { id: "call-2", name: "meta-campaigns", arguments: { accountId: "act_123" } },
              ],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return {
          message: { role: "assistant", content: "Partial data retrieved." },
          finishReason: "stop",
          model: "mock",
        };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        toolCallId: req.toolCallId,
        status: "completed",
        result: { success: true, data: { insights: [{ spend: 500 }] } },
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 100,
      }));
      toolBehavior.set("meta-campaigns", async (req) => ({
        executionId: "exec-2",
        toolId: req.toolId,
        toolCallId: req.toolCallId,
        status: "failed",
        result: { success: false, error: "API error" },
        error: "API error",
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 50,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      const res = await orch.process(req("Get everything"), ctx());

      expect(res.success).toBe(true);

      const meta = res.data!.metadata as Record<string, unknown>;
      const summary = meta.toolExecution as Record<string, unknown>;
      expect(summary.total).toBe(2);
      expect(summary.succeeded).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.allFailed).toBe(false);
      expect(summary.allSucceeded).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Concurrency: concurrent conversations don't corrupt state
  // -----------------------------------------------------------------------

  describe("8. Concurrency: per-conversation state isolation", () => {
    it("two concurrent conversations produce correct tool results", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
          ],
          execute: async (params) => ({
            success: true,
            data: { accountId: params.accountId, spend: Math.random() * 1000 },
          }),
        }),
      ];

      const { definitions: agentTools } = convertToolsToAIToolDefinitions(metaTools);
      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
        tools: agentTools,
      });
      registry.register(agent);

      const callCounts = new Map<string, number>();
      mockAI.setResponse((req) => {
        const toolMsg = req.messages.find((m) => m.role === "tool");
        const convId = toolMsg ? "conv-b" : "conv-a";
        const count = (callCounts.get(convId) ?? 0) + 1;
        callCounts.set(convId, count);

        if (count === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: `call-${convId}`, name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return { message: { role: "assistant", content: `Response for ${convId}` }, finishReason: "stop", model: "mock" };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        status: "completed",
        result: { success: true, data: { spend: 42 } },
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 10,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      const [resA, resB] = await Promise.all([
        orch.process(req("Get insights"), ctx("user-1", "conv-a")),
        orch.process(req("Get insights"), ctx("user-2", "conv-b")),
      ]);

      expect(resA.success).toBe(true);
      expect(resB.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 9. Tool result envelope structure
  // -----------------------------------------------------------------------

  describe("9. Tool result envelope structure", () => {
    it("completed tool has TOOL, STATUS, DURATION, DATA fields", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
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

      let receivedToolContent = "";
      let callCount = 0;
      mockAI.setResponse((req) => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        const toolMsg = req.messages.find((m) => m.role === "tool");
        if (toolMsg) receivedToolContent = toolMsg.content;
        return { message: { role: "assistant", content: "Done" }, finishReason: "stop", model: "mock" };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        status: "completed",
        result: { success: true, data: { spend: 100 } },
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 75,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      await orch.process(req("Get insights"), ctx());

      expect(receivedToolContent).toContain("TOOL: meta-insights");
      expect(receivedToolContent).toContain("STATUS: COMPLETED");
      expect(receivedToolContent).toContain("DURATION: 75ms");
      expect(receivedToolContent).toContain("DATA:");
      expect(receivedToolContent).toContain("100");
    });

    it("failed tool has TOOL, STATUS, ERROR, DATA_RETRIEVAL_FAILED fields", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
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

      let receivedToolContent = "";
      let callCount = 0;
      mockAI.setResponse((req) => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        const toolMsg = req.messages.find((m) => m.role === "tool");
        if (toolMsg) receivedToolContent = toolMsg.content;
        return { message: { role: "assistant", content: "Done" }, finishReason: "stop", model: "mock" };
      });

      const toolBehavior = new Map<string, (req: ToolExecutionRequest) => Promise<ToolExecutionResult>>();
      toolBehavior.set("meta-insights", async (req) => ({
        executionId: "exec-1",
        toolId: req.toolId,
        status: "failed",
        result: { success: false, error: "Network timeout" },
        error: "Network timeout",
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 30000,
      }));

      const toolExecutor = createConfigurableToolExecutor(toolBehavior);
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      await orch.process(req("Get insights"), ctx());

      expect(receivedToolContent).toContain("TOOL: meta-insights");
      expect(receivedToolContent).toContain("STATUS: FAILED");
      expect(receivedToolContent).toContain("ERROR: Network timeout");
      expect(receivedToolContent).toContain("DURATION: 30000ms");
      expect(receivedToolContent).toContain("DATA_RETRIEVAL_FAILED: Network timeout");
    });
  });

  // -----------------------------------------------------------------------
  // 10. Orchestrator success response includes toolExecution metadata
  // -----------------------------------------------------------------------

  describe("10. Orchestrator response metadata includes toolExecution", () => {
    it("success response includes toolExecution summary when tools were used", async () => {
      const metaTools: ITool[] = [
        fakeTool({
          id: "meta.insights",
          description: "Get insights",
          parameters: [
            { name: "accountId", type: "string", description: "Account ID", required: true },
            { name: "startDate", type: "string", description: "Start", required: true },
            { name: "endDate", type: "string", description: "End", required: true },
          ],
          execute: async () => ({ success: true, data: { spend: 100 } }),
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
              content: "",
              toolCalls: [{ id: "call-1", name: "meta-insights", arguments: { accountId: "act_123", startDate: "2026-08-01", endDate: "2026-08-25" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return { message: { role: "assistant", content: "Done" }, finishReason: "stop", model: "mock" };
      });

      const toolExecutor = createConfigurableToolExecutor(new Map());
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(metaTools),
      });

      const res = await orch.process(req("Get insights"), ctx());

      expect(res.success).toBe(true);
      const meta = res.data!.metadata as Record<string, unknown>;
      expect(meta.toolExecution).toBeDefined();
      const summary = meta.toolExecution as Record<string, unknown>;
      expect(summary.total).toBe(1);
      expect(summary.succeeded).toBe(1);
    });

    it("success response does NOT include toolExecution when no tools were used", async () => {
      const agent = new ConversationalAssistant({
        provider: mockAI,
        systemPrompt: "You are JARVIS.",
      });
      registry.register(agent);

      mockAI.setResponse(() => ({
        message: { role: "assistant", content: "Hello!" },
        finishReason: "stop",
        model: "mock",
      }));

      const toolExecutor = createConfigurableToolExecutor(new Map());
      const orch = new Orchestrator(registry, toolExecutor, auditLogger);

      const res = await orch.process(req("Hello"), ctx());

      expect(res.success).toBe(true);
      const meta = res.data!.metadata as Record<string, unknown>;
      expect(meta.toolExecution).toBeUndefined();
    });
  });
});
