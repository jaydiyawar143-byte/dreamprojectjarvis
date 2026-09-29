// ---------------------------------------------------------------------------
// S7.2 L2 Step 1 — the chat route hands the orchestrator the id of the user
// message it just saved.
//
// Memory provenance points at the exact message a memory came from. The only
// place that id exists is here: the route saves the user's message, then
// calls the orchestrator. The id goes into the SERVER-built session context as
// `userMessageId`, beside the route's own `traceId` — never from the request
// body, which a client controls.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type {
  Conversation,
  ConversationMessage,
  ConversationStorePort,
  IOrchestrator,
  IToolExecutor,
  JarvisRequest,
  JarvisResponse,
  SessionContext,
} from "@jarvis/core";
import { createChatRouter, type ChatRouterDeps } from "../src/routes/chat.js";

function memoryConversationStore() {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ConversationMessage[]>();
  let seq = 0;
  const store: ConversationStorePort = {
    async create(input) {
      const id = `conv-${++seq}`;
      conversations.set(id, {
        id,
        title: input.title ?? null,
        userId: input.userId,
        agentId: input.agentId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      messages.set(id, []);
      return conversations.get(id)!;
    },
    async findByIdAndUserId(conversationId, userId) {
      const found = conversations.get(conversationId);
      return found && found.userId === userId ? found : null;
    },
    async getMessages(conversationId) {
      return [...(messages.get(conversationId) ?? [])];
    },
    async addMessage(input) {
      const message: ConversationMessage = {
        id: `msg-${++seq}`,
        role: input.role as ConversationMessage["role"],
        content: input.content,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        createdAt: new Date().toISOString(),
      };
      const list = messages.get(input.conversationId) ?? [];
      list.push(message);
      messages.set(input.conversationId, list);
      return message;
    },
  };
  return {
    store,
    usersOf(conversationId: string): ConversationMessage[] {
      return (messages.get(conversationId) ?? []).filter((m) => m.role === "user");
    },
  };
}

const tokenService = {
  verifyAccessToken: (token: string) =>
    token === "token-user-1" ? { userId: "user-1", role: "member", email: "user-1@test.local" } : null,
} as unknown as ChatRouterDeps["tokenService"];

function answeringOrchestrator() {
  const seen: Array<{ request: JarvisRequest; context: SessionContext }> = [];
  const orchestrator: IOrchestrator = {
    async process(request, context): Promise<JarvisResponse> {
      // A copy: the route must not be able to change what was seen afterwards.
      seen.push({ request, context: { ...context } });
      return {
        success: true,
        data: { message: "Noted.", conversationId: context.conversationId ?? "", agentId: "conversational-assistant" },
        traceId: context.traceId,
        timestamp: new Date().toISOString(),
      };
    },
  };
  return { orchestrator, seen };
}

const unreachableExecutor: IToolExecutor = {
  async execute(): Promise<never> {
    throw new Error("ToolExecutor was not expected to run in this test");
  },
};

function postChat(
  store: ConversationStorePort,
  orchestrator: IOrchestrator,
  body: Record<string, unknown>
): Promise<{ status: number; body: { traceId?: string; data?: { conversationId?: string } } }> {
  const chatRouter = createChatRouter({ tokenService, orchestrator, executor: unreachableExecutor, googleWrites: null, conversationRepo: store });
  return new Promise((resolve) => {
    const headers: Record<string, string> = { authorization: "Bearer token-user-1" };
    const req = {
      method: "POST",
      path: "/",
      url: "/",
      headers,
      body,
      params: {},
      query: {},
      ip: "127.0.0.1",
      get: (name: string) => headers[name.toLowerCase()],
    } as never;
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        resolve({ status: this.statusCode, body: payload as never });
        return this;
      },
      setHeader() {
        return this;
      },
    };
    const layer = (
      chatRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => void }> } }>;
      }
    ).stack.find((l) => l.route?.path === "/" && l.route.methods.post);
    const handlers = layer!.route!.stack.map((s) => s.handle);
    let index = 0;
    const next = () => {
      if (index < handlers.length) handlers[index++]!(req, res, next);
    };
    next();
  });
}

describe("L2 — the orchestrator receives the saved user message's id", () => {
  it("context.userMessageId is the id of the user message this request saved, beside its traceId", async () => {
    const conversations = memoryConversationStore();
    const { orchestrator, seen } = answeringOrchestrator();
    const res = await postChat(conversations.store, orchestrator, { message: "I prefer short captions." });

    const [saved] = conversations.usersOf(res.body.data!.conversationId!);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.context.userMessageId).toBe(saved!.id);
    expect(saved!.content).toBe("I prefer short captions.");
    expect(saved!.metadata).toEqual({ traceId: seen[0]!.context.traceId });
  });

  it("on a later turn it is the NEW message's id, not an earlier one", async () => {
    const conversations = memoryConversationStore();
    const { orchestrator, seen } = answeringOrchestrator();
    const first = await postChat(conversations.store, orchestrator, { message: "Hello JARVIS." });
    const conversationId = first.body.data!.conversationId!;
    await postChat(conversations.store, orchestrator, { message: "I prefer short captions.", conversationId });

    const users = conversations.usersOf(conversationId);
    expect(users.map((m) => m.content)).toEqual(["Hello JARVIS.", "I prefer short captions."]);
    expect(seen.map((s) => s.context.userMessageId)).toEqual([users[0]!.id, users[1]!.id]);
  });

  it("a client cannot supply the id: body fields are ignored", async () => {
    const conversations = memoryConversationStore();
    const { orchestrator, seen } = answeringOrchestrator();
    const res = await postChat(conversations.store, orchestrator, {
      message: "I prefer short captions.",
      userMessageId: "forged-message",
      sourceMessageId: "forged-message",
    });

    const [saved] = conversations.usersOf(res.body.data!.conversationId!);
    expect(seen[0]!.context.userMessageId).toBe(saved!.id);
    expect(JSON.stringify(seen[0])).not.toContain("forged-message");
  });
});
