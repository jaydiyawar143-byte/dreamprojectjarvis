// ---------------------------------------------------------------------------
// Phase 18, Stage 18.3A — a spoken turn never confirms: the chat route and the
// final confirmation endpoint.
//
// VOICE_APPROVAL_POLICY says voice may propose an approval-gated action and
// never confirm one. Until 18.3A only the voice client kept to it: the chat
// route confirmed a spoken "yes" like a typed one, and handed a Google write
// to the service with `voice: false`. These tests prove the server now refuses
// it, from the turn's server-established mode:
//   • a spoken "yes" — flagged by the client, or recognised by the server as
//     its own transcript whatever the client says — leaves the pending action
//     and its approval untouched, and reaches no executor, Google write
//     service, provider or mutation;
//   • rejecting by voice still works, and a typed "yes" still confirms and runs;
//   • the on-screen Confirm endpoint refuses a confirmation that says it was
//     spoken, before anything moves, and otherwise confirms and runs as before.
// Fakes only: no provider, no network.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  VOICE_CONFIRMATION_REFUSED_MESSAGE,
  VOICE_TOOL_REFUSED_CODE,
  type Conversation,
  type ConversationMessage,
  type ConversationStorePort,
  type IOrchestrator,
  type PendingAction,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from "@jarvis/core";
import { createChatRouter, type ChatRouterDeps } from "../src/routes/chat.js";
import { createPendingActionsRouter } from "../src/routes/pending-actions.js";
import { RecentTranscripts } from "../src/services/recent-transcripts.js";

const http = globalThis.fetch.bind(globalThis);
const USER = "user-1";

const tokenService = {
  verifyAccessToken: (token: string) => {
    const userId = token.replace(/^tok-/, "");
    return userId ? { userId, role: "owner", email: `${userId}@test.local` } : null;
  },
};

function conversationStore(): ConversationStorePort & { messages: Map<string, ConversationMessage[]> } {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ConversationMessage[]>();
  let seq = 0;
  return {
    messages,
    async create(input) {
      const id = `conv-${++seq}`;
      const at = new Date().toISOString();
      conversations.set(id, { id, title: input.title ?? null, userId: input.userId, agentId: input.agentId ?? null, createdAt: at, updatedAt: at });
      return conversations.get(id)!;
    },
    async findByIdAndUserId(id, userId) {
      const found = conversations.get(id);
      return found && found.userId === userId ? found : null;
    },
    async getMessages(id) {
      return [...(messages.get(id) ?? [])];
    },
    async addMessage(input) {
      const message: ConversationMessage = {
        id: `msg-${++seq}`,
        role: input.role as ConversationMessage["role"],
        content: input.content,
        createdAt: new Date().toISOString(),
      };
      messages.set(input.conversationId, [...(messages.get(input.conversationId) ?? []), message]);
      return message;
    },
  };
}

const pendingOf = (conversationId: string, over: Partial<PendingAction> = {}): PendingAction => ({
  id: "pa-1",
  conversationId,
  userId: USER,
  toolId: "whatsapp.send",
  action: "whatsapp.send",
  params: { to: "+910000000000", body: "Invoice ready" },
  riskLevel: "EXTERNAL_SIDE_EFFECT",
  state: "WAITING_CONFIRMATION",
  approvalId: "apr-1",
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  createdAt: new Date().toISOString(),
  ...over,
});

/** The pending-action store, faked: what a confirm or a reject changes. */
function pendingActions() {
  let current: PendingAction | null = null;
  const service = {
    getActivePendingAction: vi.fn(async () => current),
    confirmPendingAction: vi.fn(async (_c: string, _u: string, id: string) => {
      if (!current || current.id !== id) return { success: false, message: "Nothing is waiting.", reason: "NOT_FOUND" as const };
      current = { ...current, state: "CONFIRMED" as PendingAction["state"] };
      return { success: true, message: "Confirmed.", pendingAction: current };
    }),
    rejectPendingAction: vi.fn(async (_c: string, _u: string, id: string) => {
      if (!current || current.id !== id) return { success: false, message: "Nothing is waiting." };
      current = null;
      return { success: true, message: "Cancelled. Nothing was done." };
    }),
    modifyPendingAction: vi.fn(),
    createPendingAction: vi.fn(),
  };
  return {
    service,
    set(action: PendingAction | null) {
      current = action;
    },
    get current() {
      return current;
    },
  };
}

let server: Server;
let base = "";
let store: ReturnType<typeof conversationStore>;
let pending: ReturnType<typeof pendingActions>;
let transcripts: RecentTranscripts;
let executor: { execute: ReturnType<typeof vi.fn>; requests: ToolExecutionRequest[] };
let googleWrites: { execute: ReturnType<typeof vi.fn> };
let orchestrator: IOrchestrator & { process: ReturnType<typeof vi.fn> };
let audits: Array<{ action: string; result: string; metadata?: Record<string, unknown> }>;
let taskTurns: Array<Record<string, unknown>>;
let conversationId = "";

function completed(request: ToolExecutionRequest): ToolExecutionResult {
  return {
    executionId: "exec-1",
    toolId: request.toolId,
    status: "completed",
    result: { success: true, data: { sent: true } },
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 1,
  };
}

beforeEach(async () => {
  store = conversationStore();
  conversationId = (await store.create({ userId: USER, title: "t" })).id;
  pending = pendingActions();
  pending.set(pendingOf(conversationId));
  transcripts = new RecentTranscripts();
  audits = [];
  taskTurns = [];
  const requests: ToolExecutionRequest[] = [];
  executor = {
    requests,
    execute: vi.fn(async (request: ToolExecutionRequest) => {
      requests.push(request);
      return completed(request);
    }),
  };
  googleWrites = {
    execute: vi.fn(async () => ({ success: true, action: "gmail.createDraft", message: "Draft created.", data: { id: "d1" } })),
  };
  orchestrator = {
    process: vi.fn(async (_request, context) => ({
      success: true,
      data: { message: "ok", conversationId: context.conversationId ?? "" },
      traceId: context.traceId,
      timestamp: new Date().toISOString(),
    })),
  } as never;
});

function chatDeps(): ChatRouterDeps {
  return {
    tokenService: tokenService as never,
    conversationRepo: store,
    orchestrator,
    executor: executor as never,
    pendingActionService: pending.service as never,
    googleWrites: googleWrites as never,
    recentTranscripts: transcripts,
    auditLogger: { log: async (entry) => void audits.push(entry as never) },
    taskConversation: {
      handle: async (input) => {
        taskTurns.push(input as never);
        return { message: "Done.", taskId: "task-1" };
      },
    },
  };
}

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use("/chat", (req, res, next) => createChatRouter(chatDeps())(req, res, next));
  app.use("/pending-actions", (req, res, next) =>
    createPendingActionsRouter({
      tokenService,
      pendingActionService: pending.service,
      executor,
      toolRegistry: { get: (id: string) => ({ id }) },
      googleWrites,
      auditLogger: { log: async (entry: never) => void audits.push(entry) },
    } as never)(req, res, next)
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

async function post(path: string, body: unknown) {
  const res = await http(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer tok-${USER}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const nothingMoved = () => {
  expect(pending.service.confirmPendingAction).not.toHaveBeenCalled();
  expect(executor.execute).not.toHaveBeenCalled();
  expect(googleWrites.execute).not.toHaveBeenCalled();
  expect(orchestrator.process).not.toHaveBeenCalled();
  expect(pending.current?.state).toBe("WAITING_CONFIRMATION");
};

describe("the chat route refuses a spoken confirmation", () => {
  it("when the client says the turn was spoken", async () => {
    const res = await post("/chat", { message: "yes", conversationId, inputMode: "voice" });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe(VOICE_CONFIRMATION_REFUSED_MESSAGE);
    expect(res.body.data.metadata).toMatchObject({ pendingActionId: "pa-1", confirmation: "refused_voice" });
    nothingMoved();
    expect(audits).toEqual([
      expect.objectContaining({ action: "chat.voice_confirmation_refused", result: "rejected", metadata: expect.objectContaining({ pendingActionId: "pa-1", inputMode: "voice" }) }),
    ]);
    // Nothing secret or identifying in the reply.
    expect(JSON.stringify(res.body)).not.toContain("+910000000000");
  });

  it("when the server transcribed the words itself — whatever the client says", async () => {
    transcripts.remember(USER, "Haan kar do");
    for (const body of [
      { message: "haan kar do", conversationId },
      { message: "HAAN KAR DO", conversationId, inputMode: "text" },
    ]) {
      const res = await post("/chat", body);
      expect(res.body.data.message).toBe(VOICE_CONFIRMATION_REFUSED_MESSAGE);
    }
    nothingMoved();
  });

  it("for a Google write: the write service is never reached", async () => {
    pending.set(pendingOf(conversationId, { id: "pa-g", toolId: "gmail.createDraft", action: "gmail.createDraft", approvalId: "apr-g" }));
    const res = await post("/chat", { message: "go ahead", conversationId, inputMode: "voice" });
    expect(res.body.data.message).toBe(VOICE_CONFIRMATION_REFUSED_MESSAGE);
    nothingMoved();
  });

  it("still lets voice cancel — cancelling runs nothing", async () => {
    const res = await post("/chat", { message: "cancel", conversationId, inputMode: "voice" });
    expect(res.body.data.message).toMatch(/Cancelled/);
    expect(pending.service.rejectPendingAction).toHaveBeenCalledTimes(1);
    expect(pending.service.confirmPendingAction).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("confirms and runs a typed yes, as before — with no voice mark on the execution", async () => {
    const res = await post("/chat", { message: "yes", conversationId });
    expect(res.body.data.message).toMatch(/Action executed successfully/);
    expect(pending.service.confirmPendingAction).toHaveBeenCalledWith(conversationId, USER, "pa-1");
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]).toMatchObject({ toolId: "whatsapp.send", approvalId: "apr-1" });
    expect(executor.requests[0]!.inputMode).toBeUndefined();
    expect(audits).toEqual([]);
  });

  it("hands a typed Google confirmation to the write service as not-voice", async () => {
    pending.set(pendingOf(conversationId, { id: "pa-g", toolId: "gmail.createDraft", action: "gmail.createDraft", approvalId: "apr-g" }));
    await post("/chat", { message: "yes", conversationId });
    expect(googleWrites.execute).toHaveBeenCalledTimes(1);
    expect(googleWrites.execute.mock.calls[0]![0]).toBe("apr-g");
    expect(googleWrites.execute.mock.calls[0]![1]).toMatchObject({ userId: USER, voice: false });
  });

  it("hands a spoken work request to the task path with its mode — and a typed one without", async () => {
    await post("/chat", { message: "check digitalonebox.com", conversationId, inputMode: "voice" });
    await post("/chat", { message: "check digitalonebox.com", conversationId });
    expect(taskTurns.map((t) => t.inputMode)).toEqual(["voice", undefined]);
  });

  it("does not let another account's transcript mark this turn", async () => {
    transcripts.remember("someone-else", "yes");
    const res = await post("/chat", { message: "yes", conversationId });
    expect(res.body.data.message).toMatch(/Action executed successfully/);
  });
});

describe("the final confirmation endpoint — the on-screen Confirm", () => {
  it("refuses a confirmation that says it was spoken, before anything moves", async () => {
    const res = await post("/pending-actions/pa-1/confirm", { conversationId, inputMode: "voice" });
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: VOICE_TOOL_REFUSED_CODE, message: VOICE_CONFIRMATION_REFUSED_MESSAGE });
    nothingMoved();
    expect(audits).toEqual([expect.objectContaining({ action: "pending_action.voice_confirmation_refused", result: "rejected" })]);
  });

  it("refuses an input mode it does not know", async () => {
    const res = await post("/pending-actions/pa-1/confirm", { conversationId, inputMode: "telepathy" });
    expect(res.status).toBe(400);
    nothingMoved();
  });

  it("confirms and runs a click, as before", async () => {
    const res = await post("/pending-actions/pa-1/confirm", { conversationId });
    expect(res.status).toBe(200);
    expect(res.body.data.executionResult.status).toBe("completed");
    expect(executor.requests[0]).toMatchObject({ toolId: "whatsapp.send", approvalId: "apr-1" });
    expect(executor.requests[0]!.inputMode).toBeUndefined();
    const typed = await post("/pending-actions/pa-1/confirm", { conversationId, inputMode: "text" });
    expect(typed.status).not.toBe(403);
  });

  it("hands a clicked Google confirmation to the write service as not-voice", async () => {
    pending.set(pendingOf(conversationId, { id: "pa-g", toolId: "gmail.createDraft", action: "gmail.createDraft", approvalId: "apr-g" }));
    const res = await post("/pending-actions/pa-g/confirm", { conversationId });
    expect(res.status).toBe(200);
    expect(googleWrites.execute.mock.calls[0]![1]).toMatchObject({ voice: false });
  });
});
