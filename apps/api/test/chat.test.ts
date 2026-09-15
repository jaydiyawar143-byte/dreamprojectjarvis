import { describe, it, expect, beforeEach } from "vitest";
import type {
  IOrchestrator,
  JarvisRequest,
  JarvisResponse,
  SessionContext,
  AuditEntry,
  AuditLogger,
  Conversation,
  ConversationMessage,
} from "@jarvis/core";
import type { TokenService } from "@jarvis/security";
import type { PrismaConversationRepository } from "@jarvis/db";
import { createChatRouter } from "../src/routes/chat.js";

function createMockTokenService(): TokenService {
  const tokens = new Map<string, { userId: string; role: string; email: string }>();
  return {
    generateAccessToken(payload: { userId: string; role: string; email: string }): string {
      const token = `mock-token-${payload.userId}-${Date.now()}`;
      tokens.set(token, payload);
      return token;
    },
    generateRefreshToken(): string {
      return "mock-refresh-token";
    },
    verifyAccessToken(token: string): { userId: string; role: string; email: string } | null {
      return tokens.get(token) ?? null;
    },
    hashToken(token: string): string {
      return `hash-${token}`;
    },
    getRefreshTokenExpiry(): Date {
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    },
  } as TokenService;
}

function createMockOrchestrator(
  responseText = "Mock JARVIS response",
  auditLogger?: AuditLogger
): IOrchestrator & {
  getProcessedRequests: () => JarvisRequest[];
  getContexts: () => SessionContext[];
} {
  const processedRequests: JarvisRequest[] = [];
  const contexts: SessionContext[] = [];

  return {
    async process(request: JarvisRequest, context: SessionContext): Promise<JarvisResponse> {
      if (request.agentId && request.agentId !== "conversational-assistant") {
        return {
          success: false,
          error: { code: "AGENT_NOT_FOUND", message: `Agent not found: ${request.agentId}` },
          traceId: context.traceId,
          timestamp: new Date().toISOString(),
        };
      }

      processedRequests.push(request);
      contexts.push(context);

      if (auditLogger) {
        await auditLogger.log({
          userId: context.auth.userId,
          agentId: context.agentId,
          action: "orchestrator.process",
          result: "success",
          traceId: context.traceId,
        });
      }

      return {
        success: true,
        data: {
          message: responseText,
          conversationId: context.conversationId ?? "",
          agentId: context.agentId,
        },
        traceId: context.traceId,
        timestamp: new Date().toISOString(),
      };
    },
    getProcessedRequests: () => processedRequests,
    getContexts: () => contexts,
  };
}

function createMockConversationRepo(): PrismaConversationRepository & {
  getConversations: () => Map<string, Conversation>;
  getAllMessages: () => Map<string, ConversationMessage[]>;
} {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ConversationMessage[]>();

  return {
    async create(input) {
      const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const conv: Conversation = {
        id,
        title: input.title ?? null,
        userId: input.userId,
        agentId: input.agentId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      conversations.set(id, conv);
      messages.set(id, []);
      return conv;
    },
    async findById(id) {
      return conversations.get(id) ?? null;
    },
    async findByIdAndUserId(id, userId) {
      const conv = conversations.get(id);
      if (conv && conv.userId === userId) return conv;
      return null;
    },
    async addMessage(input) {
      const msg: ConversationMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: input.role as ConversationMessage["role"],
        content: input.content,
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
      };
      const list = messages.get(input.conversationId) ?? [];
      list.push(msg);
      messages.set(input.conversationId, list);
      return msg;
    },
    async getMessages(conversationId) {
      return messages.get(conversationId) ?? [];
    },
    async listByUserId(userId) {
      return Array.from(conversations.values()).filter((c) => c.userId === userId);
    },
    async delete(conversationId, userId) {
      const conv = conversations.get(conversationId);
      if (conv && conv.userId === userId) {
        conversations.delete(conversationId);
        messages.delete(conversationId);
        return true;
      }
      return false;
    },
    getConversations: () => conversations,
    getAllMessages: () => messages,
  } as PrismaConversationRepository & {
    getConversations: () => Map<string, Conversation>;
    getAllMessages: () => Map<string, ConversationMessage[]>;
  };
}

function createMockAuditLogger(): AuditLogger & {
  getEntries: () => AuditEntry[];
} {
  const entries: AuditEntry[] = [];
  return {
    async log(entry) {
      entries.push({
        ...entry,
        id: `audit-${entries.length}`,
        timestamp: new Date(),
      } as AuditEntry);
    },
    async query() {
      return entries;
    },
    getEntries: () => entries,
  } as AuditLogger & { getEntries: () => AuditEntry[] };
}

async function makeRequest(
  router: ReturnType<typeof createChatRouter>,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
) {
  const { method = "POST", path = "/", headers = {}, body } = options;

  return new Promise<{ status: number; body: unknown }>((resolve) => {
    const mockReq = {
      method,
      path,
      url: path,
      headers,
      body,
      params: {},
      query: {},
      ip: "127.0.0.1",
      get(header: string) {
        return headers[header.toLowerCase()] ?? headers[header];
      },
    } as any;

    const mockRes = {
      _status: 200,
      _body: null as unknown,
      _headers: {} as Record<string, string>,
      status(code: number) {
        this._status = code;
        return this;
      },
      json(data: unknown) {
        this._body = data;
        return this;
      },
      setHeader(name: string, value: string) {
        this._headers[name] = value;
        return this;
      },
      get _captured() {
        return { status: this._status, body: this._body };
      },
    } as any;

    const middlewares = (router as any).stack ?? [];
    let matched = false;

    for (const layer of middlewares) {
      if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
        matched = true;
        const handlers = layer.route.stack.map((r: any) => r.handle);
        let idx = 0;
        const next = () => {
          if (idx < handlers.length) {
            handlers[idx++](mockReq, mockRes, next);
          }
        };
        next();
        break;
      }
    }

    if (!matched) {
      resolve({ status: 404, body: { error: "Not found" } });
      return;
    }

    setTimeout(() => {
      resolve({ status: mockRes._status, body: mockRes._body });
    }, 50);
  });
}

describe("POST /api/v1/chat", () => {
  let tokenService: ReturnType<typeof createMockTokenService>;
  let mockOrchestrator: ReturnType<typeof createMockOrchestrator>;
  let mockConversationRepo: ReturnType<typeof createMockConversationRepo>;
  let mockAuditLogger: ReturnType<typeof createMockAuditLogger>;
  let router: ReturnType<typeof createChatRouter>;
  let userToken: string;

  beforeEach(() => {
    tokenService = createMockTokenService();
    mockAuditLogger = createMockAuditLogger();
    mockOrchestrator = createMockOrchestrator("Hello! I am JARVIS.", mockAuditLogger);
    mockConversationRepo = createMockConversationRepo();

    router = createChatRouter({
      tokenService,
      orchestrator: mockOrchestrator,
      conversationRepo: mockConversationRepo as any,
      auditLogger: mockAuditLogger as any,
    });

    userToken = tokenService.generateAccessToken({
      userId: "user-1",
      role: "member",
      email: "test@example.com",
    });
  });

  it("1. Unauthenticated request returns 401", async () => {
    const res = await makeRequest(router, {
      body: { message: "Hello" },
    });
    expect(res.status).toBe(401);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("2. Invalid JWT returns 401", async () => {
    const res = await makeRequest(router, {
      headers: { authorization: "Bearer invalid-token-xyz" },
      body: { message: "Hello" },
    });
    expect(res.status).toBe(401);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("3. Invalid request body returns validation error", async () => {
    const res = await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "" },
    });
    expect(res.status).toBe(400);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error.code).toBe("INVALID_REQUEST");
  });

  it("4. Authenticated normal chat returns success", async () => {
    const res = await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello JARVIS" },
    });
    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect((res.body as any).data.message).toBe("Hello! I am JARVIS.");
  });

  it("5. AuthContext reaches Orchestrator", async () => {
    await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Test" },
    });

    const contexts = mockOrchestrator.getContexts();
    expect(contexts.length).toBe(1);
    expect(contexts[0].auth.userId).toBe("user-1");
    expect(contexts[0].auth.role).toBe("member");
    expect(contexts[0].auth.email).toBe("test@example.com");
  });

  it("6. Mock provider response becomes JarvisResponse", async () => {
    const res = await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hi" },
    });
    const body = res.body as any;
    expect(body.success).toBe(true);
    expect(body.data.message).toBe("Hello! I am JARVIS.");
    expect(typeof body.data.conversationId).toBe("string");
    expect(typeof body.traceId).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });

  it("7. Real OpenAI adapter remains injectable (architecture test)", async () => {
    const { OpenAIAdapter } = await import("@jarvis/ai-openai");
    expect(typeof OpenAIAdapter).toBe("function");
    const adapter = new (OpenAIAdapter as any)({ apiKey: "sk-test-fake" });
    expect(adapter.id).toBe("openai");
    expect(adapter.name).toBe("OpenAI");
  });

  it("8. Unknown agent returns error", async () => {
    const res = await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello", agentId: "nonexistent-agent" },
    });
    expect(res.status).toBe(404);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error.code).toBe("AGENT_NOT_FOUND");
  });

  it("9. Disabled agent returns error", async () => {
    const disabledOrchestrator: IOrchestrator = {
      async process() {
        return {
          success: false,
          error: { code: "AGENT_ERROR", message: "Agent is disabled: disabled-agent" },
          traceId: "test-trace",
          timestamp: new Date().toISOString(),
        };
      },
    };

    const testRouter = createChatRouter({
      tokenService,
      orchestrator: disabledOrchestrator,
      conversationRepo: mockConversationRepo as any,
      auditLogger: mockAuditLogger as any,
    });

    const res = await makeRequest(testRouter, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello", agentId: "disabled-agent" },
    });
    expect(res.status).toBe(500);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error.code).toBe("AGENT_ERROR");
  });

  it("10. Provider failure returns error", async () => {
    const failingOrchestrator: IOrchestrator = {
      async process(_req, ctx) {
        return {
          success: false,
          error: { code: "INTERNAL_ERROR", message: "Provider failure" },
          traceId: ctx.traceId,
          timestamp: new Date().toISOString(),
        };
      },
    };

    const testRouter = createChatRouter({
      tokenService,
      orchestrator: failingOrchestrator,
      conversationRepo: mockConversationRepo as any,
      auditLogger: mockAuditLogger as any,
    });

    const res = await makeRequest(testRouter, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello" },
    });
    expect(res.status).toBe(500);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error.code).toBe("INTERNAL_ERROR");
  });

  it("11. Provider timeout returns error", async () => {
    const timeoutOrchestrator: IOrchestrator = {
      async process(_req, ctx) {
        return {
          success: false,
          error: { code: "RATE_LIMITED", message: "Request timed out" },
          traceId: ctx.traceId,
          timestamp: new Date().toISOString(),
        };
      },
    };

    const testRouter = createChatRouter({
      tokenService,
      orchestrator: timeoutOrchestrator,
      conversationRepo: mockConversationRepo as any,
      auditLogger: mockAuditLogger as any,
    });

    const res = await makeRequest(testRouter, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello" },
    });
    expect(res.status).toBe(429);
    expect((res.body as any).success).toBe(false);
  });

  it("12. traceId propagation", async () => {
    const res = await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello" },
    });

    const traceId = (res.body as any).traceId;
    expect(typeof traceId).toBe("string");
    expect(traceId.length).toBeGreaterThan(0);

    const contexts = mockOrchestrator.getContexts();
    expect(contexts[0].traceId).toBe(traceId);
  });

  it("13. AuditLog created", async () => {
    await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello" },
    });

    const entries = mockAuditLogger.getEntries();
    expect(entries.length).toBeGreaterThan(0);
    const auditEntry = entries.find((e) => e.action === "orchestrator.process");
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.userId).toBe("user-1");
  });

  it("14. Conversation created for new chat", async () => {
    await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello" },
    });

    const convs = mockConversationRepo.getConversations();
    expect(convs.size).toBe(1);
    const conv = Array.from(convs.values())[0];
    expect(conv.userId).toBe("user-1");
  });

  it("15. User message persisted", async () => {
    await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello JARVIS" },
    });

    const convs = mockConversationRepo.getConversations();
    const convId = Array.from(convs.keys())[0];
    const msgs = mockConversationRepo.getAllMessages().get(convId) ?? [];
    const userMsg = msgs.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("Hello JARVIS");
  });

  it("16. Assistant message persisted", async () => {
    await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello" },
    });

    const convs = mockConversationRepo.getConversations();
    const convId = Array.from(convs.keys())[0];
    const msgs = mockConversationRepo.getAllMessages().get(convId) ?? [];
    const assistantMsg = msgs.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("Hello! I am JARVIS.");
  });

  it("17. Conversation ownership enforced", async () => {
    await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello" },
    });

    const convs = mockConversationRepo.getConversations();
    const convId = Array.from(convs.keys())[0];

    const otherToken = tokenService.generateAccessToken({
      userId: "user-2",
      role: "member",
      email: "other@example.com",
    });

    const res = await makeRequest(router, {
      headers: { authorization: `Bearer ${otherToken}` },
      body: { message: "Continue", conversationId: convId },
    });
    expect(res.status).toBe(404);
    expect((res.body as any).error.code).toBe("CONVERSATION_NOT_FOUND");
  });

  it("18. User A cannot access User B conversation", async () => {
    const userAToken = tokenService.generateAccessToken({
      userId: "user-a",
      role: "member",
      email: "a@example.com",
    });

    await makeRequest(router, {
      headers: { authorization: `Bearer ${userAToken}` },
      body: { message: "My conversation" },
    });

    const convs = mockConversationRepo.getConversations();
    const convId = Array.from(convs.keys())[0];

    const userBToken = tokenService.generateAccessToken({
      userId: "user-b",
      role: "member",
      email: "b@example.com",
    });

    const res = await makeRequest(router, {
      headers: { authorization: `Bearer ${userBToken}` },
      body: { message: "Hijack", conversationId: convId },
    });
    expect(res.status).toBe(404);
    expect((res.body as any).error.code).toBe("CONVERSATION_NOT_FOUND");
  });

  it("19. No secrets in response", async () => {
    const res = await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello" },
    });

    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("sk-");
    expect(bodyStr).not.toContain("OPENAI_API_KEY");
    expect(bodyStr).not.toContain("DATABASE_URL");
    expect(bodyStr).not.toContain("JWT_SECRET");
  });

  it("20. No stack trace in response", async () => {
    const failingOrchestrator: IOrchestrator = {
      async process(_req, ctx) {
        throw new Error("Internal stack trace should not leak");
      },
    };

    const testRouter = createChatRouter({
      tokenService,
      orchestrator: failingOrchestrator,
      conversationRepo: mockConversationRepo as any,
      auditLogger: mockAuditLogger as any,
    });

    const res = await makeRequest(testRouter, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Trigger error" },
    });

    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("Internal stack trace");
    expect(bodyStr).not.toContain("at ");
    expect(bodyStr).not.toContain(".ts:");
  });

  it("21. Multi-turn: history loaded from DB on second turn", async () => {
    const res1 = await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Create a campaign called Summer Push" },
    });
    expect((res1.body as any).success).toBe(true);
    const conversationId = (res1.body as any).data.conversationId;

    const res2 = await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "What did I just ask you to create?", conversationId },
    });
    expect((res2.body as any).success).toBe(true);

    const requests = mockOrchestrator.getProcessedRequests();
    const secondRequest = requests[requests.length - 1];
    expect(secondRequest.conversationHistory).toBeDefined();
    expect(secondRequest.conversationHistory!.length).toBeGreaterThanOrEqual(2);

    const historyRoles = secondRequest.conversationHistory!.map((m) => m.role);
    expect(historyRoles).toContain("user");
    expect(historyRoles).toContain("assistant");
  });

  it("22. Multi-turn: current message not duplicated in history", async () => {
    const res1 = await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "First message" },
    });
    const conversationId = (res1.body as any).data.conversationId;

    await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Second message", conversationId },
    });

    const requests = mockOrchestrator.getProcessedRequests();
    const secondRequest = requests[requests.length - 1];

    expect(secondRequest.message).toBe("Second message");

    const historyUserContents = secondRequest.conversationHistory!
      .filter((m) => m.role === "user")
      .map((m) => m.content);

    expect(historyUserContents).toContain("First message");
    expect(historyUserContents).not.toContain("Second message");
  });

  it("23. Multi-turn: conversation history only contains user/assistant (no system/tool)", async () => {
    const res1 = await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello" },
    });
    const conversationId = (res1.body as any).data.conversationId;

    await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Follow up", conversationId },
    });

    const requests = mockOrchestrator.getProcessedRequests();
    const secondRequest = requests[requests.length - 1];

    for (const msg of secondRequest.conversationHistory!) {
      expect(["user", "assistant"]).toContain(msg.role);
    }
  });

  it("24. Conversation isolation: User A history invisible to User B", async () => {
    const userAToken = tokenService.generateAccessToken({
      userId: "user-alpha",
      role: "member",
      email: "alpha@test.com",
    });
    const userBToken = tokenService.generateAccessToken({
      userId: "user-beta",
      role: "member",
      email: "beta@test.com",
    });

    const resA1 = await makeRequest(router, {
      headers: { authorization: `Bearer ${userAToken}` },
      body: { message: "My secret Q4 budget is 50000" },
    });
    const convIdA = (resA1.body as any).data.conversationId;

    const resB1 = await makeRequest(router, {
      headers: { authorization: `Bearer ${userBToken}` },
      body: { message: "Tell me about the budget" },
    });
    const convIdB = (resB1.body as any).data.conversationId;

    await makeRequest(router, {
      headers: { authorization: `Bearer ${userBToken}` },
      body: { message: "What is the Q4 budget?", conversationId: convIdB },
    });

    const requests = mockOrchestrator.getProcessedRequests();
    const lastRequest = requests[requests.length - 1];
    const allHistory = (lastRequest.conversationHistory ?? []).map((m) => m.content).join(" ");
    expect(allHistory).not.toContain("50000");
    expect(allHistory).not.toContain("secret Q4 budget");
  });

  it("25. New conversation (no conversationId) sends empty history", async () => {
    await makeRequest(router, {
      headers: { authorization: `Bearer ${userToken}` },
      body: { message: "Hello" },
    });

    const requests = mockOrchestrator.getProcessedRequests();
    const lastRequest = requests[requests.length - 1];
    expect(lastRequest.conversationHistory).toBeDefined();
    expect(lastRequest.conversationHistory!.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R-21 — chat on a server with no OpenAI key.
//
// Real Orchestrator, real ConversationalAssistant and the real not-configured
// provider, so the whole path a message takes is exercised: the provider
// refuses, the agent rethrows, the orchestrator reports the code, the route
// picks the status. Only authentication and persistence are doubles.
// ---------------------------------------------------------------------------

/** Resolves when the route answers, not after a fixed delay. */
function postChat(
  router: ReturnType<typeof createChatRouter>,
  token: string,
  message: string
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const req = {
      method: "POST",
      path: "/",
      url: "/",
      headers,
      body: { message },
      params: {},
      query: {},
      ip: "127.0.0.1",
      get: (name: string) => headers[name.toLowerCase()],
    } as any;
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        resolve({ status: this.statusCode, body });
        return this;
      },
      setHeader() {
        return this;
      },
    } as any;

    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/" && l.route.methods.post
    );
    const handlers = layer.route.stack.map((s: any) => s.handle);
    let index = 0;
    const next = () => {
      if (index < handlers.length) handlers[index++](req, res, next);
    };
    next();
  });
}

describe("R-21 — POST /api/v1/chat without an OpenAI key", () => {
  async function buildRouter() {
    const { Orchestrator, AgentRegistry, ConversationalAssistant } = await import("@jarvis/agents");
    const { NotConfiguredAIProvider } = await import("@jarvis/ai-openai");

    const registry = new AgentRegistry();
    registry.register(
      new ConversationalAssistant({
        provider: new NotConfiguredAIProvider(),
        systemPrompt: "You are JARVIS.",
      })
    );

    const auditLogger = createMockAuditLogger();
    const executor = {
      execute: async () => {
        throw new Error("no tool may run when the model cannot be reached");
      },
    };
    const orchestrator = new Orchestrator(registry, executor as any, auditLogger as any, {});

    const tokenService = createMockTokenService();
    const router = createChatRouter({
      tokenService,
      orchestrator,
      conversationRepo: createMockConversationRepo() as any,
      auditLogger: auditLogger as any,
    } as any);
    const token = tokenService.generateAccessToken({
      userId: "user-1",
      role: "member",
      email: "test@example.com",
    });

    return { router, token };
  }

  it("answers 503 AI_PROVIDER_NOT_CONFIGURED with a message the user can act on", async () => {
    const { router, token } = await buildRouter();

    const res = await postChat(router, token, "Hello JARVIS");

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("AI_PROVIDER_NOT_CONFIGURED");
    expect(res.body.error.message).toMatch(/not configured/i);
  });

  it("keeps answering 503 on every later message, not only the first", async () => {
    // A provider refusal must not leave the assistant unselectable: the
    // second message has to get the same actionable answer as the first.
    const { router, token } = await buildRouter();

    const first = await postChat(router, token, "Hello JARVIS");
    const second = await postChat(router, token, "Are you there?");
    const third = await postChat(router, token, "Hello again");

    expect([first.status, second.status, third.status]).toEqual([503, 503, 503]);
    expect(third.body.error.code).toBe("AI_PROVIDER_NOT_CONFIGURED");
  });

  it("leaks no variable name, key, secret or stack trace", async () => {
    const { router, token } = await buildRouter();

    const res = await postChat(router, token, "Hello JARVIS");
    const bodyStr = JSON.stringify(res.body);

    expect(bodyStr).not.toContain("OPENAI_API_KEY");
    expect(bodyStr).not.toContain("sk-");
    expect(bodyStr).not.toContain("DATABASE_URL");
    expect(bodyStr).not.toContain("JWT_SECRET");
    expect(bodyStr).not.toMatch(/\bat .+:\d+:\d+/);
    expect(res.body.error).not.toHaveProperty("stack");
  });
});

// ---------------------------------------------------------------------------
// R-25 / R-27 / R-29 — the HTTP status a provider failure reaches the browser
// with. A 401 would make the web client refresh the session and resend the
// message, so no provider failure may use it.
// ---------------------------------------------------------------------------

describe("R-25 / R-27 / R-29 — provider failures reach the browser with the right status", () => {
  async function routerThatFailsWith(failure: unknown) {
    const { Orchestrator, AgentRegistry, ConversationalAssistant } = await import("@jarvis/agents");

    const registry = new AgentRegistry();
    registry.register(
      new ConversationalAssistant({
        provider: {
          id: "test-provider",
          name: "Test provider",
          defaultModel: "test-model",
          complete: async () => {
            throw failure;
          },
          listModels: async () => [],
          isAvailable: async () => false,
        },
        systemPrompt: "You are JARVIS.",
      })
    );

    const auditLogger = createMockAuditLogger();
    const executor = {
      execute: async () => {
        throw new Error("no tool may run when the model cannot be reached");
      },
    };
    const orchestrator = new Orchestrator(registry, executor as any, auditLogger as any, {});
    const tokenService = createMockTokenService();
    const router = createChatRouter({
      tokenService,
      orchestrator,
      conversationRepo: createMockConversationRepo() as any,
      auditLogger: auditLogger as any,
    } as any);
    const token = tokenService.generateAccessToken({
      userId: "user-1",
      role: "member",
      email: "test@example.com",
    });

    return { router, token };
  }

  it.each([
    ["an exceeded context window", 413, "CONTEXT_LENGTH_EXCEEDED", undefined],
    ["an open provider circuit", 503, "AI_PROVIDER_UNAVAILABLE", { transient: true }],
    ["a provider that rejects the server's API key", 503, "AI_PROVIDER_AUTH_FAILED", undefined],
  ])("answers %s with HTTP %i, never 401", async (_label, status, code, details) => {
    const { JarvisError } = await import("@jarvis/core");
    const { router, token } = await routerThatFailsWith(
      new JarvisError(code as any, "A safe message.", details as any)
    );

    const res = await postChat(router, token, "Hello JARVIS");

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });
});

// ---------------------------------------------------------------------------
// R-30 — no usable provider, through the real route and the real chain.
// ---------------------------------------------------------------------------

describe("R-30 — POST /api/v1/chat when no provider is usable", () => {
  it("answers 503 with a recovery message and the cause code, and leaks no provider detail", async () => {
    const { Orchestrator, AgentRegistry, ConversationalAssistant } = await import("@jarvis/agents");
    const { FallbackAIProvider, JarvisError } = await import("@jarvis/core");

    const failingProvider = (id: string, failure: unknown) => ({
      id,
      name: id,
      defaultModel: `${id}-model`,
      complete: async () => {
        throw failure;
      },
      listModels: async () => [],
      isAvailable: async () => false,
    });
    const chain = new FallbackAIProvider([
      failingProvider("primary", new JarvisError("AI_PROVIDER_AUTH_FAILED" as any, "Incorrect API key provided: sk-test-r30-leak")),
      failingProvider(
        "fallback",
        new JarvisError("INTERNAL_ERROR", "502 from https://internal.provider.example/v1", { transient: true })
      ),
    ]);

    const registry = new AgentRegistry();
    registry.register(new ConversationalAssistant({ provider: chain, systemPrompt: "You are JARVIS." }));
    const auditLogger = createMockAuditLogger();
    const orchestrator = new Orchestrator(
      registry,
      { execute: async () => { throw new Error("no tool may run"); } } as any,
      auditLogger as any,
      {}
    );
    const tokenService = createMockTokenService();
    const router = createChatRouter({
      tokenService,
      orchestrator,
      conversationRepo: createMockConversationRepo() as any,
      auditLogger: auditLogger as any,
    } as any);
    const token = tokenService.generateAccessToken({ userId: "user-1", role: "member", email: "test@example.com" });

    const res = await postChat(router, token, "Hello JARVIS");
    const bodyStr = JSON.stringify(res.body);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(res.body.error.details).toEqual({ transient: true, cause: "AI_PROVIDER_AUTH_FAILED" });
    expect(res.body.error.message).toMatch(/temporarily unavailable/i);
    expect(res.body.error.message).toMatch(/recover/i);
    expect(bodyStr).not.toContain("sk-test-r30-leak");
    expect(bodyStr).not.toContain("Incorrect API key");
    expect(bodyStr).not.toContain("internal.provider.example");
    expect(bodyStr).not.toMatch(/\bat .+:\d+:\d+/);
  });
});
