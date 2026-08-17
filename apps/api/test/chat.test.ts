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
  getMessages: () => Map<string, ConversationMessage[]>;
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
    getMessages: () => messages,
  } as PrismaConversationRepository & {
    getConversations: () => Map<string, Conversation>;
    getMessages: () => Map<string, ConversationMessage[]>;
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
    const msgs = mockConversationRepo.getMessages().get(convId) ?? [];
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
    const msgs = mockConversationRepo.getMessages().get(convId) ?? [];
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
});
