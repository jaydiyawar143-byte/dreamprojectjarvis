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

  reset() {
    this.receivedRequests = [];
    this.responseFn = null;
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
        result: { success: true, data: { campaignId: "new-campaign-123" } },
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
// Helpers
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are JARVIS, a helpful AI assistant with direct access to the user's Meta Ads account.",
  "For write operations, explain what you will do and get confirmation first.",
  "MULTI-TURN CONTEXT RESOLUTION:",
  "- You have access to the FULL conversation history. Use it to resolve references.",
  "- When the user says short follow-ups like 'yes', 'please do', 'do it', 'proceed', 'create it', 'go ahead', 'haan', 'kar do', 'nahi tum karo', 'same', 'same details', 'proceed with that' — resolve them against the immediately preceding conversation context.",
  "- NEVER re-ask for information that was ALREADY provided in the conversation.",
  "- If all required information for a requested action is available in the conversation history, proceed directly.",
  "- When the user confirms and you have all required details, present the approval request immediately. Do not re-summarize or re-ask.",
].join("\n");

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

function buildInfrastructure() {
  const provider = new MockAIProvider();
  const assistant = new ConversationalAssistant({
    provider,
    systemPrompt: SYSTEM_PROMPT,
    temperature: 0.7,
    maxTokens: 4096,
  });

  const registry = new AgentRegistry();
  registry.register(assistant);

  const toolExecutor = createMockToolExecutor();
  const auditLogger = createMockAuditLogger();

  const toolMap = new Map<string, ITool>();
  toolMap.set("meta.campaign.create", {
    name: "meta.campaign.create",
    description: "Create a new Meta campaign",
    category: "marketing",
    risk: "EXTERNAL_SIDE_EFFECT" as RiskLevel,
    parameters: [
      { name: "accountId", type: "string", description: "Meta ad account ID", required: true },
      { name: "proposal", type: "object", description: "Campaign proposal", required: true },
    ],
    requiresApproval: true,
    requiredPermissions: ["read", "write"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true, data: { campaignId: "new-campaign-123" } }),
    validate: () => true,
  });

  toolMap.set("meta.campaign.pause", {
    name: "meta.campaign.pause",
    description: "Pause a Meta campaign",
    category: "marketing",
    risk: "EXTERNAL_SIDE_EFFECT" as RiskLevel,
    parameters: [
      { name: "accountId", type: "string", description: "Meta ad account ID", required: true },
      { name: "campaignId", type: "string", description: "Campaign ID", required: true },
    ],
    requiresApproval: true,
    requiredPermissions: ["read", "write"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
  });

  const toolRegistry = {
    get: (toolId: string) => toolMap.get(toolId),
    getAll: () => [...toolMap.values()],
  };

  const orchestrator = new Orchestrator(registry, toolExecutor, auditLogger, {
    toolRegistry,
    toolApprovalService: null,
  });

  return { provider, toolExecutor, auditLogger, orchestrator };
}

/**
 * Creates a stateful mock response:
 * - 1st call: returns a tool call
 * - 2nd+ calls: returns a text response
 */
function createStatefulToolThenTextResponse(
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  textResponse: string
) {
  let callCount = 0;
  return (_req: AICompletionRequest): AICompletionResponse => {
    callCount++;
    if (callCount === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [toolCall],
        },
        finishReason: "tool_calls",
        model: "mock-model",
      };
    }
    return {
      message: { role: "assistant", content: textResponse },
      finishReason: "stop",
      model: "mock-model",
    };
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("Campaign creation — context resolution across turns", () => {
  let provider: MockAIProvider;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    const infra = buildInfrastructure();
    provider = infra.provider;
    orchestrator = infra.orchestrator;
  });

  it("TEST A: 'please do' resolves previous campaign context and triggers tool call", async () => {
    const history = makeHistory([
      {
        role: "user",
        content: [
          "campaign name - Whatsa lead campaign",
          "Objective - lead form",
          "Budget - ₹100/day",
          "Target audience - jo best ho",
          "Ad creative - abhi nahi hai",
        ].join("\n"),
      },
      {
        role: "assistant",
        content: [
          "Here's the campaign configuration I'll create:",
          "",
          "Campaign: Whatsa lead campaign",
          "Objective: Leads (Lead Generation)",
          "Budget: ₹100/day",
          "Target Audience: Broad targeting (optimized for best results)",
          "Creative: Not provided — you can add this later",
          "Status: Paused (as per default)",
          "",
          "Shall I proceed with creating this campaign?",
        ].join("\n"),
      },
    ]);

    provider.setResponse(createStatefulToolThenTextResponse(
      {
        id: "tc-create-1",
        name: "meta.campaign.create",
        arguments: {
          accountId: "act_2478566669291624",
          proposal: {
            name: "Whatsa lead campaign",
            objective: "OUTCOME_LEADS",
            dailyBudget: 100,
            status: "PAUSED",
            adSets: [{ name: "Default Ad Set" }],
          },
        },
      },
      "I need your approval to create this campaign. The campaign 'Whatsa lead campaign' will be created with a ₹100/day budget in paused state."
    ));

    const conversationId = "conv-campaign-create";

    const result = await orchestrator.process(
      req("please do", conversationId, history),
      ctx("user-1", conversationId)
    );

    expect(result.success).toBe(true);

    const requests = provider.getReceivedRequests();
    expect(requests.length).toBe(2);

    const firstCallMessages = requests[0].messages;
    const allContent = firstCallMessages.map((m) => m.content).join(" ");

    expect(allContent).toContain("Whatsa lead campaign");
    expect(allContent).toContain("lead form");
    expect(allContent).toContain("100");
    expect(allContent).toContain("please do");

    const toolRequests = (orchestrator as any).toolExecutor.getRequests();
    expect(toolRequests.length).toBe(1);
    expect(toolRequests[0].toolId).toBe("meta.campaign.create");
  });

  it("TEST A variant: 'yes' resolves context", async () => {
    const history = makeHistory([
      { role: "user", content: "Create a campaign called Holiday Blast with ₹200/day budget for leads" },
      { role: "assistant", content: "Got it! Holiday Blast campaign, ₹200/day, Leads objective. Ready to create. Confirm?" },
    ]);

    provider.setResponse(createStatefulToolThenTextResponse(
      {
        id: "tc-yes",
        name: "meta.campaign.create",
        arguments: {
          accountId: "act_2478566669291624",
          proposal: { name: "Holiday Blast", objective: "OUTCOME_LEADS", dailyBudget: 200, status: "PAUSED", adSets: [{ name: "Default" }] },
        },
      },
      "Approval request ready for Holiday Blast campaign."
    ));

    const result = await orchestrator.process(
      req("yes", "conv-yes", history),
      ctx("user-1", "conv-yes")
    );

    expect(result.success).toBe(true);
    const msgs = provider.getReceivedRequests()[0].messages;
    const allContent = msgs.map((m) => m.content).join(" ");
    expect(allContent).toContain("Holiday Blast");
    expect(allContent).toContain("200");
  });

  it("TEST A variant: 'go ahead' resolves context", async () => {
    const history = makeHistory([
      { role: "user", content: "Set up a retargeting campaign for website visitors, budget ₹150/day" },
      { role: "assistant", content: "Campaign configured: Retargeting - Website Visitors, ₹150/day. Ready when you are." },
    ]);

    provider.setResponse(createStatefulToolThenTextResponse(
      {
        id: "tc-ga",
        name: "meta.campaign.create",
        arguments: {
          accountId: "act_2478566669291624",
          proposal: { name: "Retargeting - Website Visitors", objective: "OUTCOME_TRAFFIC", dailyBudget: 150, status: "PAUSED", adSets: [{ name: "Default" }] },
        },
      },
      "Creating the retargeting campaign now."
    ));

    const result = await orchestrator.process(
      req("go ahead", "conv-ga", history),
      ctx("user-1", "conv-ga")
    );

    expect(result.success).toBe(true);
    const msgs = provider.getReceivedRequests()[0].messages;
    const allContent = msgs.map((m) => m.content).join(" ");
    expect(allContent).toContain("Retargeting");
    expect(allContent).toContain("150");
  });

  it("TEST A variant: 'create it' resolves context", async () => {
    const history = makeHistory([
      { role: "user", content: "I want a campaign for Diwali sale, ₹300/day, targeting women 25-45" },
      { role: "assistant", content: "Diwali Sale campaign ready: ₹300/day, targeting women 25-45. Should I create it?" },
    ]);

    provider.setResponse(createStatefulToolThenTextResponse(
      {
        id: "tc-ci",
        name: "meta.campaign.create",
        arguments: {
          accountId: "act_2478566669291624",
          proposal: { name: "Diwali Sale", objective: "OUTCOME_SALES", dailyBudget: 300, status: "PAUSED", adSets: [{ name: "Default" }] },
        },
      },
      "Diwali Sale campaign creation request submitted for approval."
    ));

    const result = await orchestrator.process(
      req("create it", "conv-ci", history),
      ctx("user-1", "conv-ci")
    );

    expect(result.success).toBe(true);
    const msgs = provider.getReceivedRequests()[0].messages;
    const allContent = msgs.map((m) => m.content).join(" ");
    expect(allContent).toContain("Diwali");
    expect(allContent).toContain("300");
  });

  it("TEST A variant: 'haan kar do' resolves context (Hindi)", async () => {
    const history = makeHistory([
      { role: "user", content: "Ek campaign banao Brand Awareness ke liye, ₹80/day" },
      { role: "assistant", content: "Brand Awareness campaign ready at ₹80/day. Create karun?" },
    ]);

    provider.setResponse(createStatefulToolThenTextResponse(
      {
        id: "tc-hindi",
        name: "meta.campaign.create",
        arguments: {
          accountId: "act_2478566669291624",
          proposal: { name: "Brand Awareness", objective: "OUTCOME_AWARENESS", dailyBudget: 80, status: "PAUSED", adSets: [{ name: "Default" }] },
        },
      },
      "Brand Awareness campaign ke liye approval request ready hai."
    ));

    const result = await orchestrator.process(
      req("haan kar do", "conv-hindi", history),
      ctx("user-1", "conv-hindi")
    );

    expect(result.success).toBe(true);
  });

  it("TEST A variant: 'proceed with that' resolves context", async () => {
    const history = makeHistory([
      { role: "user", content: "App install campaign for iOS, budget ₹500/day" },
      { role: "assistant", content: "iOS App Install campaign, ₹500/day. Shall I proceed?" },
    ]);

    provider.setResponse(createStatefulToolThenTextResponse(
      {
        id: "tc-pwt",
        name: "meta.campaign.create",
        arguments: {
          accountId: "act_2478566669291624",
          proposal: { name: "iOS App Install", objective: "OUTCOME_APP_INSTALLS", dailyBudget: 500, status: "PAUSED", adSets: [{ name: "Default" }] },
        },
      },
      "iOS App Install campaign approval request is ready."
    ));

    const result = await orchestrator.process(
      req("proceed with that", "conv-pwt", history),
      ctx("user-1", "conv-pwt")
    );

    expect(result.success).toBe(true);
  });

  it("TEST A variant: 'nahi tum karo' resolves context (Hinglish)", async () => {
    const history = makeHistory([
      { role: "user", content: "Catalog sales campaign banao, ₹120/day" },
      { role: "assistant", content: "Catalog Sales campaign at ₹120/day. Banaaun?" },
    ]);

    provider.setResponse(createStatefulToolThenTextResponse(
      {
        id: "tc-hinglish",
        name: "meta.campaign.create",
        arguments: {
          accountId: "act_2478566669291624",
          proposal: { name: "Catalog Sales", objective: "OUTCOME_CATALOG_SALES", dailyBudget: 120, status: "PAUSED", adSets: [{ name: "Default" }] },
        },
      },
      "Catalog Sales campaign ke liye approval request bhej raha hun."
    ));

    const result = await orchestrator.process(
      req("nahi tum karo", "conv-hinglish", history),
      ctx("user-1", "conv-hinglish")
    );

    expect(result.success).toBe(true);
  });

  it("TEST A variant: 'same details' resolves context", async () => {
    const history = makeHistory([
      { role: "user", content: "Video views campaign, ₹250/day, 18-35 age group" },
      { role: "assistant", content: "Video Views campaign configured: ₹250/day, age 18-35. Ready to create." },
    ]);

    provider.setResponse(createStatefulToolThenTextResponse(
      {
        id: "tc-same",
        name: "meta.campaign.create",
        arguments: {
          accountId: "act_2478566669291624",
          proposal: { name: "Video Views", objective: "OUTCOME_VIEWS", dailyBudget: 250, status: "PAUSED", adSets: [{ name: "Default" }] },
        },
      },
      "Video Views campaign approval request is ready."
    ));

    const result = await orchestrator.process(
      req("same details", "conv-same", history),
      ctx("user-1", "conv-same")
    );

    expect(result.success).toBe(true);
  });

  it("TEST B: Conversation isolation — history from conv-A not visible in conv-B", async () => {
    provider.setResponse(() => ({
      message: { role: "assistant", content: "How can I help you?" },
      finishReason: "stop",
      model: "mock-model",
    }));

    await orchestrator.process(
      req("What did I ask you to create?", "conv-B-isolation"),
      ctx("user-2", "conv-B-isolation")
    );

    const msgs = provider.getReceivedRequests()[0].messages;
    const allContent = msgs.map((m) => m.content).join(" ");
    expect(allContent).not.toContain("Super Bowl");
    expect(allContent).not.toContain("10000");
  });

  it("TEST: Empty history — LLM responds to bare 'proceed' without inventing", async () => {
    provider.setResponse(() => ({
      message: { role: "assistant", content: "How can I help you with your Meta Ads today?" },
      finishReason: "stop",
      model: "mock-model",
    }));

    const result = await orchestrator.process(
      req("proceed", "conv-empty"),
      ctx("user-1", "conv-empty")
    );

    expect(result.success).toBe(true);
    const msgs = provider.getReceivedRequests()[0].messages;
    const allContent = msgs.map((m) => m.content).join(" ");
    expect(allContent).toContain("proceed");
  });

  it("TEST: Partial info — LLM asks for missing required fields", async () => {
    const history = makeHistory([
      { role: "user", content: "I want to create a campaign" },
      { role: "assistant", content: "What should the campaign be called and what's the objective?" },
    ]);

    provider.setResponse(() => ({
      message: {
        role: "assistant",
        content: "I still need a few details: What's the campaign name and what objective? Also, what's your daily budget?",
      },
      finishReason: "stop",
      model: "mock-model",
    }));

    const result = await orchestrator.process(
      req("do it", "conv-partial", history),
      ctx("user-1", "conv-partial")
    );

    expect(result.success).toBe(true);
  });

  it("TEST: History includes both user and assistant messages for full context", async () => {
    const history = makeHistory([
      { role: "user", content: "Show me my campaigns" },
      { role: "assistant", content: "You have 3 active campaigns: Summer Sale, Winter Blast, Holiday Special." },
      { role: "user", content: "Pause the Winter Blast one" },
      { role: "assistant", content: "I'll pause the Winter Blast campaign. This requires approval. Shall I proceed?" },
    ]);

    provider.setResponse(createStatefulToolThenTextResponse(
      {
        id: "tc-pause",
        name: "meta.campaign.pause",
        arguments: { accountId: "act_2478566669291624", campaignId: "winter-blast-123" },
      },
      "Winter Blast campaign pause request submitted for approval."
    ));

    const result = await orchestrator.process(
      req("yes", "conv-pause", history),
      ctx("user-1", "conv-pause")
    );

    expect(result.success).toBe(true);
    const msgs = provider.getReceivedRequests()[0].messages;
    const allContent = msgs.map((m) => m.content).join(" ");
    expect(allContent).toContain("Winter Blast");
    expect(allContent).toContain("Pause");
  });
});
