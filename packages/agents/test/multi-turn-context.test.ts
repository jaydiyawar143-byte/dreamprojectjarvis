import { describe, it, expect, beforeEach } from "vitest";
import type {
  IAIProvider,
  IToolExecutor,
  AuditLogger,
  AICompletionRequest,
  AICompletionResponse,
  ToolExecutionRequest,
  ToolExecutionResult,
  AuditEntry,
  JarvisRequest,
  SessionContext,
  ConversationMessage,
  RiskLevel,
  ITool,
} from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";

// ---------------------------------------------------------------------------
// Mock AI Provider — captures all messages sent to OpenAI
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
    return {
      message: { role: "assistant", content: "Default response" },
      finishReason: "stop",
      model: this.defaultModel,
    };
  }
  async listModels() { return [this.defaultModel]; }
  async isAvailable() { return true; }

  getReceivedRequests(): AICompletionRequest[] {
    return this.receivedRequests;
  }
}

// ---------------------------------------------------------------------------
// Mock Tool Executor
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
// Tool Registry
// ---------------------------------------------------------------------------

function createToolRegistry(tools: ITool[] = []) {
  const map = new Map(tools.map((t) => [t.id, t]));
  return {
    get: (toolId: string) => map.get(toolId),
    getAll: () => [...tools],
  };
}

// ---------------------------------------------------------------------------
// Fake tool for testing tool-call + context continuation
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
// Helpers
// ---------------------------------------------------------------------------

function ctx(userId = "user-1", conversationId?: string): SessionContext {
  return {
    auth: { userId, role: "member", email: `${userId}@test.com` },
    conversationId,
    traceId: "00000000-0000-0000-0000-000000000001",
  };
}

function req(message: string, conversationId?: string, conversationHistory?: ConversationMessage[]): JarvisRequest {
  return { message, conversationId, conversationHistory, stream: false };
}

function makeHistory(messages: Array<{ role: "user" | "assistant"; content: string }>): ConversationMessage[] {
  return messages.map((m, i) => ({
    id: `msg-${i}`,
    role: m.role,
    content: m.content,
    createdAt: new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Build agent infrastructure (mirrors container.ts wiring)
// ---------------------------------------------------------------------------

function buildAgentInfrastructure(provider: MockAIProvider, systemPrompt?: string) {
  const assistant = new ConversationalAssistant({
    provider,
    systemPrompt: systemPrompt ?? "You are JARVIS. You are a helpful AI assistant.",
    temperature: 0.7,
    maxTokens: 4096,
  });

  const registry = new AgentRegistry();
  registry.register(assistant);

  return { assistant, registry };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("Multi-turn conversation context retention", () => {
  let provider: MockAIProvider;
  let toolExecutor: ReturnType<typeof createMockToolExecutor>;
  let auditLogger: ReturnType<typeof createMockAuditLogger>;
  let registry: AgentRegistry;

  beforeEach(() => {
    provider = new MockAIProvider();
    toolExecutor = createMockToolExecutor();
    auditLogger = createMockAuditLogger();
    const infra = buildAgentInfrastructure(provider);
    registry = infra.registry;
  });

  it("includes conversation history in OpenAI messages on subsequent turns", async () => {
    const history = makeHistory([
      { role: "user", content: "Create a campaign called Summer Push" },
      { role: "assistant", content: "Sure! I'll create a campaign called Summer Push. What budget do you want?" },
      { role: "user", content: "100 dollars per day" },
      { role: "assistant", content: "Done! Campaign Summer Push created with $100/day budget." },
    ]);

    provider.setResponse(() => ({
      message: { role: "assistant", content: "The Summer Push campaign is performing well." },
      finishReason: "stop",
      model: "mock-model",
    }));

    const orchestrator = new Orchestrator(registry, toolExecutor, auditLogger);
    const conversationId = "conv-multi-1";

    await orchestrator.process(
      req("How is the Summer Push campaign doing?", conversationId, history),
      ctx("user-1", conversationId)
    );

    const requests = provider.getReceivedRequests();
    expect(requests.length).toBe(1);

    const messages = requests[0].messages;
    const userContents = messages.filter((m) => m.role === "user").map((m) => m.content);

    expect(userContents).toContain("Create a campaign called Summer Push");
    expect(userContents).toContain("100 dollars per day");
    expect(userContents).toContain("How is the Summer Push campaign doing?");
  });

  it("includes assistant responses in history context", async () => {
    const history = makeHistory([
      { role: "user", content: "What campaigns are running?" },
      { role: "assistant", content: "You have 3 campaigns: Summer Push, Winter Sale, Holiday Blast." },
    ]);

    provider.setResponse(() => ({
      message: { role: "assistant", content: "Let me pause the Holiday Blast campaign." },
      finishReason: "stop",
      model: "mock-model",
    }));

    const orchestrator = new Orchestrator(registry, toolExecutor, auditLogger);
    const conversationId = "conv-assistant-history";

    await orchestrator.process(
      req("Pause the holiday one", conversationId, history),
      ctx("user-1", conversationId)
    );

    const messages = provider.getReceivedRequests()[0].messages;
    const assistantContents = messages.filter((m) => m.role === "assistant").map((m) => m.content);

    expect(assistantContents).toContain("You have 3 campaigns: Summer Push, Winter Sale, Holiday Blast.");
  });

  it("works with empty history (first turn)", async () => {
    provider.setResponse(() => ({
      message: { role: "assistant", content: "Hello! How can I help?" },
      finishReason: "stop",
      model: "mock-model",
    }));

    const orchestrator = new Orchestrator(registry, toolExecutor, auditLogger);

    await orchestrator.process(
      req("Hello JARVIS"),
      ctx("user-1", "conv-first-turn")
    );

    const messages = provider.getReceivedRequests()[0].messages;
    expect(messages.length).toBe(2); // system + user
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Hello JARVIS");
  });

  it("system prompt appears before history in message array", async () => {
    const history = makeHistory([
      { role: "user", content: "Earlier message" },
      { role: "assistant", content: "Earlier response" },
    ]);

    provider.setResponse(() => ({
      message: { role: "assistant", content: "OK" },
      finishReason: "stop",
      model: "mock-model",
    }));

    const orchestrator = new Orchestrator(registry, toolExecutor, auditLogger);

    await orchestrator.process(
      req("Current message", "conv-sys-first", history),
      ctx("user-1", "conv-sys-first")
    );

    const messages = provider.getReceivedRequests()[0].messages;
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Earlier message");
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].content).toBe("Earlier response");
    expect(messages[3].role).toBe("user");
    expect(messages[3].content).toBe("Current message");
  });

  it("resolves 'create it' by including prior context about what 'it' refers to", async () => {
    const history = makeHistory([
      { role: "user", content: "I want a new campaign for Black Friday with 50 dollar budget" },
      { role: "assistant", content: "I'll create a Black Friday campaign with $50/day. Shall I proceed?" },
    ]);

    provider.setResponse(() => ({
      message: { role: "assistant", content: "Creating the Black Friday campaign now..." },
      finishReason: "stop",
      model: "mock-model",
    }));

    const orchestrator = new Orchestrator(registry, toolExecutor, auditLogger);
    const conversationId = "conv-ref-resolve";

    await orchestrator.process(
      req("Yeah create it", conversationId, history),
      ctx("user-1", conversationId)
    );

    const messages = provider.getReceivedRequests()[0].messages;
    const allContent = messages.map((m) => m.content).join(" ");

    expect(allContent).toContain("Black Friday");
    expect(allContent).toContain("50 dollar");
    expect(allContent).toContain("Yeah create it");
  });

  it("preserves history across tool-call continuation loop", async () => {
    const history = makeHistory([
      { role: "user", content: "Show me campaign data" },
      { role: "assistant", content: "Here's the data for your campaigns." },
    ]);

    let callCount = 0;
    provider.setResponse(() => {
      callCount++;
      if (callCount === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc-1", name: "meta.campaigns", arguments: { accountId: "act_123" } }],
          },
          finishReason: "tool_calls",
          model: "mock-model",
        };
      }
      return {
        message: { role: "assistant", content: "The data looks great!" },
        finishReason: "stop",
        model: "mock-model",
      };
    });

    const orchestrator = new Orchestrator(registry, toolExecutor, auditLogger);
    const conversationId = "conv-tool-loop";

    await orchestrator.process(
      req("Show me updated data", conversationId, history),
      ctx("user-1", conversationId)
    );

    const requests = provider.getReceivedRequests();
    expect(requests.length).toBe(2);

    const secondRequestMessages = requests[1].messages;
    const userContents = secondRequestMessages.filter((m) => m.role === "user").map((m) => m.content);

    expect(userContents).toContain("Show me campaign data");
  });

  it("does not leak history from conversation A into conversation B", async () => {
    const historyA = makeHistory([
      { role: "user", content: "My secret campaign plan for Q4" },
      { role: "assistant", content: "Noted! I'll keep your Q4 plan in mind." },
    ]);

    provider.setResponse(() => ({
      message: { role: "assistant", content: "I don't have context about any Q4 plan." },
      finishReason: "stop",
      model: "mock-model",
    }));

    const orchestrator = new Orchestrator(registry, toolExecutor, auditLogger);

    await orchestrator.process(
      req("What did I tell you about Q4?", "conv-B-unknown"),
      ctx("user-2", "conv-B-unknown")
    );

    const messages = provider.getReceivedRequests()[0].messages;
    const allContent = messages.map((m) => m.content).join(" ");

    expect(allContent).not.toContain("secret campaign plan for Q4");
    expect(allContent).not.toContain("Noted! I'll keep your Q4 plan in mind.");
  });

  it("history is filtered to only user and assistant messages (no system/tool)", async () => {
    const mixedHistory: ConversationMessage[] = [
      { id: "msg-1", role: "user", content: "Hello" },
      { id: "msg-2", role: "assistant", content: "Hi there!" },
      { id: "msg-3", role: "system", content: "System internal message" },
      { id: "msg-4", role: "user", content: "How are you?" },
    ];

    provider.setResponse(() => ({
      message: { role: "assistant", content: "I'm good!" },
      finishReason: "stop",
      model: "mock-model",
    }));

    const orchestrator = new Orchestrator(registry, toolExecutor, auditLogger);

    await orchestrator.process(
      req("Current question", "conv-filter", mixedHistory),
      ctx("user-1", "conv-filter")
    );

    const messages = provider.getReceivedRequests()[0].messages;
    const allContent = messages.map((m) => m.content).join(" ");

    expect(allContent).toContain("Hello");
    expect(allContent).toContain("Hi there!");
    expect(allContent).toContain("How are you?");
  });

  it("many turns of history are all included", async () => {
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 20; i++) {
      turns.push({ role: "user", content: `User message ${i}` });
      turns.push({ role: "assistant", content: `Assistant response ${i}` });
    }
    const history = makeHistory(turns);

    provider.setResponse(() => ({
      message: { role: "assistant", content: "Got it" },
      finishReason: "stop",
      model: "mock-model",
    }));

    const orchestrator = new Orchestrator(registry, toolExecutor, auditLogger);

    await orchestrator.process(
      req("Final message", "conv-many", history),
      ctx("user-1", "conv-many")
    );

    const messages = provider.getReceivedRequests()[0].messages;
    const userMessages = messages.filter((m) => m.role === "user");

    expect(userMessages.length).toBe(21);
    expect(userMessages[0].content).toBe("User message 0");
    expect(userMessages[20].content).toBe("Final message");
  });
});

describe("ConversationalAssistant — direct buildInitialMessages", () => {
  let provider: MockAIProvider;

  beforeEach(() => {
    provider = new MockAIProvider();
  });

  it("passes conversationHistory through to OpenAI messages", async () => {
    const assistant = new ConversationalAssistant({
      provider,
      systemPrompt: "You are JARVIS.",
    });

    const history = makeHistory([
      { role: "user", content: "Tell me about campaigns" },
      { role: "assistant", content: "You have 5 active campaigns." },
    ]);

    provider.setResponse(() => ({
      message: { role: "assistant", content: "OK" },
      finishReason: "stop",
      model: "mock-model",
    }));

    await assistant.initialize({
      userId: "user-1",
      conversationId: "direct-test",
      traceId: "00000000-0000-0000-0000-000000000001",
      memoryManager: { isAvailable: async () => false } as any,
      toolRegistry: { get: () => undefined, getAll: () => [] },
      auditLogger: { log: async () => {}, query: async () => [] },
    });

    await assistant.process({
      message: "What about the budget?",
      conversationId: "direct-test",
      conversationHistory: history,
    });

    const messages = provider.getReceivedRequests()[0].messages;
    expect(messages.length).toBe(4); // system + history(user+assistant) + current user
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toBe("Tell me about campaigns");
    expect(messages[2].content).toBe("You have 5 active campaigns.");
    expect(messages[3].content).toBe("What about the budget?");
  });

  it("works without conversationHistory (backward compat)", async () => {
    const assistant = new ConversationalAssistant({
      provider,
      systemPrompt: "You are JARVIS.",
    });

    provider.setResponse(() => ({
      message: { role: "assistant", content: "Hello!" },
      finishReason: "stop",
      model: "mock-model",
    }));

    await assistant.initialize({
      userId: "user-1",
      conversationId: "compat-test",
      traceId: "00000000-0000-0000-0000-000000000001",
      memoryManager: { isAvailable: async () => false } as any,
      toolRegistry: { get: () => undefined, getAll: () => [] },
      auditLogger: { log: async () => {}, query: async () => [] },
    });

    await assistant.process({
      message: "Hello",
      conversationId: "compat-test",
    });

    const messages = provider.getReceivedRequests()[0].messages;
    expect(messages.length).toBe(2); // system + user only
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });
});
