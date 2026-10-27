// ---------------------------------------------------------------------------
// Phase 19.1 (C1) — the chat path and the conversation history.
//
// A pending browser action's parameters ARE its sensitive payload: the text to
// type, the values to submit. The orchestrator hands the chat route a
// presentation copy of the pending action with those parameters; the route
// used to return it, and to store it in the assistant message twice (as
// `pendingAction` and inside `model`), from where the history endpoint
// returned it again.
//
// These tests drive the real chat and conversations routers over HTTP and read
// three places — the chat response, the stored message, the history response —
// for the planted secrets. They also prove the card still has what it needs
// (ids, tool, state, risk, expiry), a Meta action keeps its preview, and a
// message stored BEFORE this fix is projected on the way out.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  Conversation,
  ConversationMessage,
  ConversationStorePort,
  IOrchestrator,
  IToolExecutor,
  JarvisResponse,
  PendingAction,
} from "@jarvis/core";
import { createChatRouter, type ChatRouterDeps, type PendingActionPort } from "../src/routes/chat.js";
import { createConversationsRouter } from "../src/routes/conversations.js";

const SECRETS = ["hunter2-TYPED", "Summer2026!", "sk-live-abcdefghijklmnopqrstuv", "4111-1111-1111-1111"];

function store() {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ConversationMessage[]>();
  let seq = 0;
  const port: ConversationStorePort & { listByUserId?: unknown } = {
    async create(input) {
      const id = `conv-${++seq}`;
      const conversation: Conversation = {
        id,
        title: input.title ?? null,
        userId: input.userId,
        agentId: input.agentId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      conversations.set(id, conversation);
      messages.set(id, []);
      return conversation;
    },
    async findByIdAndUserId(conversationId, userId) {
      const found = conversations.get(conversationId);
      return found && found.userId === userId ? found : null;
    },
    async getMessages(conversationId) {
      return structuredClone(messages.get(conversationId) ?? []);
    },
    async addMessage(input) {
      const message: ConversationMessage = {
        id: `msg-${++seq}`,
        role: input.role as ConversationMessage["role"],
        content: input.content,
        ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
        createdAt: new Date().toISOString(),
      };
      messages.set(input.conversationId, [...(messages.get(input.conversationId) ?? []), message]);
      return message;
    },
  };
  return { port, messages, conversations };
}

const tokenService = {
  verifyAccessToken: (token: string) => (token === "tok-1" ? { userId: "user-1", role: "member", email: "u@test.local" } : null),
} as unknown as ChatRouterDeps["tokenService"];

const unreachableExecutor: IToolExecutor = {
  async execute(): Promise<never> {
    throw new Error("not expected");
  },
};

/** The presentation copy the real orchestrator builds (orchestrator.ts, `capturedPendingAction`). */
function orchestratorCopy(toolId: string, params: Record<string, unknown>, riskLevel = "LOW_IMPACT") {
  return {
    id: "pa-1",
    toolId,
    action: toolId,
    params,
    riskLevel,
    state: "WAITING_CONFIRMATION",
    approvalId: "ap-1",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    summary: `${toolId} requires your confirmation.`,
    needsIndependentApproval: true,
  };
}

let nextMetadata: Record<string, unknown> = {};
const orchestrator: IOrchestrator = {
  async process(_request, context): Promise<JarvisResponse> {
    return {
      success: true,
      data: { message: "I need your confirmation first.", conversationId: context.conversationId ?? "", agentId: "browser-agent", metadata: structuredClone(nextMetadata) },
      traceId: context.traceId,
      timestamp: new Date().toISOString(),
    };
  },
};

let active: PendingAction | null = null;
const pendingActions = {
  async getActivePendingAction() {
    return active;
  },
  async confirmPendingAction() {
    return { success: false, message: "not in this test" };
  },
  async rejectPendingAction() {
    return { success: true, message: "Cancelled." };
  },
  async modifyPendingAction(_conversationId: string, _userId: string, params: Record<string, unknown>) {
    return { pendingAction: { ...active!, params: { ...active!.params, ...params } }, message: "Updated. Confirm to proceed." };
  },
} as unknown as PendingActionPort;

let db: ReturnType<typeof store>;
let server: Server;
let base = "";

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use("/chat", (req, res, next) =>
    createChatRouter({
      tokenService,
      orchestrator,
      executor: unreachableExecutor,
      googleWrites: null,
      conversationRepo: db.port,
      pendingActionService: pendingActions,
    } as ChatRouterDeps)(req, res, next)
  );
  app.use("/conversations", (req, res, next) => createConversationsRouter({ tokenService, conversationRepo: db.port } as never)(req, res, next));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  db = store();
  active = null;
  nextMetadata = {};
});

async function http(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: "Bearer tok-1", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const noSecret = (where: string, value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text, `${where}: ${secret}`).not.toContain(secret);
};

const TYPE_PARAMS = { url: "https://shop.example/login", selector: "#password", text: "hunter2-TYPED" };
const SUBMIT_PARAMS = { url: "https://shop.example/pay", selector: "#pay", fields: { "#card": "4111-1111-1111-1111", "#pin": "Summer2026!" } };

describe("a pending browser action reaches the chat client without its parameters", () => {
  it.each([
    ["browser.type", TYPE_PARAMS],
    ["browser.submit", SUBMIT_PARAMS],
  ] as const)("%s — in the chat response, the stored message and the history", async (toolId, params) => {
    nextMetadata = {
      model: "gpt-test",
      usage: { totalTokens: 10 },
      toolExecution: { total: 1, executions: [{ toolId, status: "approval_required", success: false }] },
      pendingAction: orchestratorCopy(toolId, params),
    };

    const chat = await http("POST", "/chat", { message: "log in for me" });
    expect(chat.status).toBe(200);
    // The card's facts are all still there.
    for (const card of [chat.body.data.pendingAction, chat.body.data.metadata.pendingAction]) {
      expect(card).toMatchObject({ id: "pa-1", toolId, action: toolId, riskLevel: "LOW_IMPACT", state: "WAITING_CONFIRMATION", approvalId: "ap-1", needsIndependentApproval: true, params: {} });
      expect(typeof card.expiresAt).toBe("string");
    }
    expect(chat.body.data.metadata.toolExecution.total).toBe(1);
    noSecret("chat response", chat.body);

    // What was stored — the copy inside `model` too.
    const conversationId = chat.body.data.conversationId;
    const stored = db.messages.get(conversationId)!.filter((m) => m.role === "assistant");
    expect(stored).toHaveLength(1);
    const meta = stored[0]!.metadata as Record<string, any>;
    expect(meta.pendingAction).toMatchObject({ id: "pa-1", approvalId: "ap-1", toolId, params: {} });
    expect(meta.model.pendingAction).toMatchObject({ id: "pa-1", approvalId: "ap-1", toolId, params: {} });
    noSecret("stored message", stored);

    // And the history.
    const history = await http("GET", `/conversations/${conversationId}`);
    expect(history.status).toBe(200);
    const reply = history.body.data.messages.find((m: ConversationMessage) => m.role === "assistant");
    expect(reply.metadata.pendingAction).toMatchObject({ id: "pa-1", toolId, approvalId: "ap-1", params: {} });
    noSecret("conversation history", history.body);
  });

  it("keeps the preview a Meta action's card renders", async () => {
    nextMetadata = {
      pendingAction: orchestratorCopy("meta.campaign.create", { name: "Diwali sale", objective: "OUTCOME_SALES", dailyBudget: 500, targeting: { geo: "IN" } }, "FINANCIAL"),
    };
    const chat = await http("POST", "/chat", { message: "create the campaign" });
    expect(chat.body.data.pendingAction.params).toEqual({ name: "Diwali sale", objective: "OUTCOME_SALES", dailyBudget: 500 });
  });

  it("returns an answer with no pending action exactly as before", async () => {
    nextMetadata = { model: "gpt-test", surface: { kind: "weather" } };
    const chat = await http("POST", "/chat", { message: "weather?" });
    expect(chat.body.data.metadata).toEqual({ model: "gpt-test", surface: { kind: "weather" } });
    expect(chat.body.data.pendingAction).toBeUndefined();
  });
});

describe("changing a pending browser action", () => {
  it("answers and stores the changed action without its parameters", async () => {
    const opened = await http("POST", "/chat", { message: "hello" });
    const conversationId = opened.body.data.conversationId;
    active = {
      ...(orchestratorCopy("browser.type", TYPE_PARAMS) as unknown as PendingAction),
      conversationId,
      userId: "user-1",
      createdAt: new Date().toISOString(),
    };

    const modified = await http("POST", "/chat", { message: "make it ₹200/day", conversationId });
    expect(modified.status).toBe(200);
    expect(modified.body.data.pendingAction).toMatchObject({ id: "pa-1", toolId: "browser.type", approvalId: "ap-1", params: {}, summary: "Updated. Confirm to proceed." });
    noSecret("modify response", modified.body);

    const stored = db.messages.get(conversationId)!.filter((m) => m.role === "assistant").pop()!;
    expect((stored.metadata as Record<string, any>).pendingAction).toMatchObject({ id: "pa-1", params: {} });
    noSecret("stored modify message", stored);
  });
});

describe("a message stored before this fix", () => {
  it("is projected on the way out of the history, and keeps everything else", async () => {
    const conversation = await db.port.create({ userId: "user-1", title: "old" });
    await db.port.addMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "Confirm?",
      metadata: {
        traceId: "trace-old",
        surface: { kind: "map" },
        pendingAction: orchestratorCopy("browser.submit", SUBMIT_PARAMS),
        model: { model: "gpt-test", pendingAction: orchestratorCopy("browser.submit", SUBMIT_PARAMS) },
      },
    });
    await db.port.addMessage({ conversationId: conversation.id, role: "user", content: "hi", metadata: { traceId: "trace-u" } });

    const history = await http("GET", `/conversations/${conversation.id}`);
    const [reply, user] = history.body.data.messages;
    expect(reply.metadata).toMatchObject({
      traceId: "trace-old",
      surface: { kind: "map" },
      pendingAction: { id: "pa-1", approvalId: "ap-1", toolId: "browser.submit", params: {} },
      model: { model: "gpt-test", pendingAction: { id: "pa-1", params: {} } },
    });
    expect(user.metadata).toEqual({ traceId: "trace-u" });
    noSecret("legacy history", history.body);
  });

  it("drops the parameters of a malformed stored pending action entirely", async () => {
    const conversation = await db.port.create({ userId: "user-1" });
    await db.port.addMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "?",
      metadata: { pendingAction: { id: "pa-x", params: { text: "hunter2-TYPED" } } },
    });
    const history = await http("GET", `/conversations/${conversation.id}`);
    expect(history.body.data.messages[0].metadata.pendingAction).toEqual({ id: "pa-x", params: {} });
  });
});
