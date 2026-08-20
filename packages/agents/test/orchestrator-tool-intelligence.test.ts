import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  IAIProvider,
  IToolExecutor,
  ITool,
  AuditLogger,
  AICompletionRequest,
  AICompletionResponse,
  ToolExecutionRequest,
  ToolExecutionResult,
  AuditEntry,
  JarvisRequest,
  SessionContext,
  RiskLevel,
  IToolApprovalService,
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
  private shouldFail = false;

  setResponse(fn: (req: AICompletionRequest) => AICompletionResponse) {
    this.responseFn = fn;
  }
  setShouldFail(fail: boolean) { this.shouldFail = fail; }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    if (this.shouldFail) throw new Error("AI provider unavailable");
    if (this.responseFn) return this.responseFn(request);
    return { message: { role: "assistant", content: "Default response" }, finishReason: "stop", model: this.defaultModel };
  }
  async listModels() { return [this.defaultModel]; }
  async isAvailable() { return !this.shouldFail; }
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
// Mock Tool Approval Service
// ---------------------------------------------------------------------------

function createMockApprovalService(
  overrides: {
    allowedByDefault?: boolean;
    requiresApproval?: boolean;
    approvalId?: string;
  } = {}
): IToolApprovalService & { getCheckCalls: () => Array<{ tool: ITool; params: Record<string, unknown> }> } {
  const checkCalls: Array<{ tool: ITool; params: Record<string, unknown> }> = [];
  return {
    async checkPreExecution(tool, params, _request) {
      checkCalls.push({ tool, params });
      if (overrides.requiresApproval) {
        return {
          allowed: false,
          requiresApproval: true,
          approvalId: overrides.approvalId ?? "approval-1",
          reason: `Approval required for ${tool.id}`,
        };
      }
      return {
        allowed: overrides.allowedByDefault ?? true,
        requiresApproval: false,
      };
    },
    getCheckCalls: () => checkCalls,
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
// Setup
// ---------------------------------------------------------------------------

let mockAI: MockAIProvider;
let toolExecutor: ReturnType<typeof createMockToolExecutor>;
let auditLogger: ReturnType<typeof createMockAuditLogger>;
let registry: AgentRegistry;

beforeEach(() => {
  mockAI = new MockAIProvider();
  toolExecutor = createMockToolExecutor();
  auditLogger = createMockAuditLogger();
  registry = new AgentRegistry();

  const agent = new ConversationalAssistant({
    provider: mockAI,
    systemPrompt: "You are JARVIS.",
  });
  registry.register(agent);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 6.5: Orchestrator Tool Intelligence Integration", () => {
  // -----------------------------------------------------------------------
  // buildToolSystemPrompt
  // -----------------------------------------------------------------------

  describe("buildToolSystemPrompt", () => {
    it("returns empty string when no tool registry", () => {
      const orch = new Orchestrator(registry, toolExecutor, auditLogger);
      expect(orch.buildToolSystemPrompt()).toBe("");
    });

    it("builds tool descriptions from registry", () => {
      const tools = [
        fakeTool({
          id: "web_research",
          description: "Search the web",
          risk: "READ_ONLY",
          parameters: [
            { name: "query", type: "string", description: "Search query", required: true },
          ],
        }),
      ];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
      });
      const prompt = orch.buildToolSystemPrompt();
      expect(prompt).toContain("web_research");
      expect(prompt).toContain("Search the web");
      expect(prompt).toContain("tool plan");
    });

    it("includes risk labels", () => {
      const tools = [
        fakeTool({ id: "meta_create", description: "Create campaign", risk: "FINANCIAL", requiresApproval: true }),
      ];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
      });
      const prompt = orch.buildToolSystemPrompt();
      expect(prompt).toContain("FINANCIAL");
      expect(prompt).toContain("approval required");
    });

    it("excludes disabled tools", () => {
      const tools = [
        fakeTool({ id: "enabled-tool", enabled: true }),
        fakeTool({ id: "disabled-tool", enabled: false }),
      ];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
      });
      const prompt = orch.buildToolSystemPrompt();
      expect(prompt).toContain("enabled-tool");
      expect(prompt).not.toContain("disabled-tool");
    });
  });

  // -----------------------------------------------------------------------
  // validateToolPlan
  // -----------------------------------------------------------------------

  describe("validateToolPlan", () => {
    it("returns error when no registry", () => {
      const orch = new Orchestrator(registry, toolExecutor, auditLogger);
      const result = orch.validateToolPlan({ intent: "test", requiresTools: false, steps: [] });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("No tool registry");
    });

    it("validates a correct plan", () => {
      const tools = [fakeTool({ id: "web_research" })];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
      });
      const result = orch.validateToolPlan({
        intent: "search",
        requiresTools: true,
        steps: [{ tool: "web_research", params: {} }],
      });
      expect(result.valid).toBe(true);
    });

    it("rejects plan with unknown tool", () => {
      const tools = [fakeTool({ id: "existing" })];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
      });
      const result = orch.validateToolPlan({
        intent: "test",
        requiresTools: true,
        steps: [{ tool: "nonexistent", params: {} }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("not found");
    });
  });

  // -----------------------------------------------------------------------
  // parseToolPlan
  // -----------------------------------------------------------------------

  describe("parseToolPlan", () => {
    it("parses JSON tool plan from model output", () => {
      const orch = new Orchestrator(registry, toolExecutor, auditLogger);
      const plan = orch.parseToolPlan(
        '{"intent":"search","requiresTools":true,"steps":[{"tool":"web_research","params":{"query":"hello"}}]}'
      );
      expect(plan).not.toBeNull();
      expect(plan!.intent).toBe("search");
      expect(plan!.steps).toHaveLength(1);
    });

    it("returns null for non-JSON output", () => {
      const orch = new Orchestrator(registry, toolExecutor, auditLogger);
      expect(orch.parseToolPlan("Hello, how can I help?")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Approval gate integration
  // -----------------------------------------------------------------------

  describe("approval gate in executeTools", () => {
    it("executes tool normally when approval service allows", async () => {
      const approvalService = createMockApprovalService({ allowedByDefault: true });
      const tools = [fakeTool({ id: "echo", risk: "READ_ONLY" })];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
        toolApprovalService: approvalService,
      });

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Running tool",
              toolCalls: [{ id: "call-1", name: "echo", arguments: { message: "hi" } }],
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

      const res = await orch.process(req("Run echo"), ctx());
      expect(res.success).toBe(true);
      expect(approvalService.getCheckCalls()).toHaveLength(1);
      expect(toolExecutor.getRequests()).toHaveLength(1);
      expect(toolExecutor.getRequests()[0]!.toolId).toBe("echo");
    });

    it("blocks tool when approval service denies", async () => {
      const approvalService = createMockApprovalService({
        allowedByDefault: false,
        requiresApproval: true,
        approvalId: "approval-42",
      });
      const tools = [fakeTool({ id: "deploy", risk: "HIGH_IMPACT" })];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
        toolApprovalService: approvalService,
      });

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Deploying...",
              toolCalls: [{ id: "call-1", name: "deploy", arguments: {} }],
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

      const res = await orch.process(req("Deploy to prod"), ctx());
      expect(res.success).toBe(true);
      expect(toolExecutor.getRequests()).toHaveLength(0);
      expect(approvalService.getCheckCalls()).toHaveLength(1);
    });

    it("skips approval gate when no approval service configured", async () => {
      const tools = [fakeTool({ id: "echo" })];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
      });

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Running tool",
              toolCalls: [{ id: "call-1", name: "echo", arguments: {} }],
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

      const res = await orch.process(req("Run echo"), ctx());
      expect(res.success).toBe(true);
      expect(toolExecutor.getRequests()).toHaveLength(1);
    });

    it("skips approval gate for tool not in registry", async () => {
      const approvalService = createMockApprovalService({ allowedByDefault: true });
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry([]),
        toolApprovalService: approvalService,
      });

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Running tool",
              toolCalls: [{ id: "call-1", name: "unknown-tool", arguments: {} }],
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

      const res = await orch.process(req("Run unknown"), ctx());
      expect(res.success).toBe(true);
      expect(toolExecutor.getRequests()).toHaveLength(1);
    });

    it("approval gate receives correct params", async () => {
      const approvalService = createMockApprovalService({ allowedByDefault: true });
      const tools = [fakeTool({ id: "research" })];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
        toolApprovalService: approvalService,
      });

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Running tool",
              toolCalls: [{ id: "call-1", name: "research", arguments: { query: "AI news" } }],
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

      await orch.process(req("Research AI"), ctx());
      const calls = approvalService.getCheckCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.tool.id).toBe("research");
      expect(calls[0]!.params).toEqual({ query: "AI news" });
    });
  });

  // -----------------------------------------------------------------------
  // End-to-end: tool execution results fed back to agent
  // -----------------------------------------------------------------------

  describe("end-to-end tool execution flow", () => {
    it("feeds tool results back to agent for final response", async () => {
      const tools = [fakeTool({ id: "echo" })];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
      });

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "I'll run the tool",
              toolCalls: [{ id: "call-1", name: "echo", arguments: { msg: "hi" } }],
            },
            finishReason: "tool_calls",
            model: "mock",
          };
        }
        return {
          message: { role: "assistant", content: "Tool completed successfully!" },
          finishReason: "stop",
          model: "mock",
        };
      });

      const res = await orch.process(req("Echo hi"), ctx());
      expect(res.success).toBe(true);
      expect(res.data!.message).toBe("Tool completed successfully!");
      expect(toolExecutor.getRequests()).toHaveLength(1);
    });

    it("enforces maxToolExecutions limit", async () => {
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        maxToolExecutions: 2,
        toolRegistry: createToolRegistry([fakeTool({ id: "loop" })]),
      });

      let callCount = 0;
      mockAI.setResponse(() => {
        callCount++;
        return {
          message: {
            role: "assistant",
            content: "Keep going",
            toolCalls: [{ id: `call-${callCount}`, name: "loop", arguments: {} }],
          },
          finishReason: "tool_calls",
          model: "mock",
        };
      });

      const res = await orch.process(req("Loop forever"), ctx());
      expect(res.success).toBe(false);
      expect(res.error!.code).toBe("INTERNAL_ERROR");
      expect(res.error!.message).toContain("limit exceeded");
    });
  });

  // -----------------------------------------------------------------------
  // ToolRegistry wiring to agent context
  // -----------------------------------------------------------------------

  describe("tool registry passed to agent", () => {
    it("passes real tool registry to agent context", async () => {
      const tools = [fakeTool({ id: "echo" })];
      const orch = new Orchestrator(registry, toolExecutor, auditLogger, {
        toolRegistry: createToolRegistry(tools),
      });

      mockAI.setResponse(() => ({
        message: { role: "assistant", content: "Done" },
        finishReason: "stop",
        model: "mock",
      }));

      const res = await orch.process(req("Hello"), ctx());
      expect(res.success).toBe(true);
    });

    it("falls back to noop registry when none configured", async () => {
      const orch = new Orchestrator(registry, toolExecutor, auditLogger);
      mockAI.setResponse(() => ({
        message: { role: "assistant", content: "Done" },
        finishReason: "stop",
        model: "mock",
      }));
      const res = await orch.process(req("Hello"), ctx());
      expect(res.success).toBe(true);
    });
  });
});
