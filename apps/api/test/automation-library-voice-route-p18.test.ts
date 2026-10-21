// ---------------------------------------------------------------------------
// Phase 18, Stage 18.2 — the server marks a spoken turn, and the execution
// layer refuses a library sync for it.
//
// The voice client sends a transcript through the same POST /api/v1/chat a
// typed turn uses. The chat route marks the turn as voice when the client says
// so OR when the text is one the server itself transcribed for that account a
// moment ago (`RecentTranscripts`, fed by POST /voice/transcribe). The mark
// only narrows: "text" never unmarks a recognised transcript. From the session
// it reaches the ToolExecutor, which refuses the sync before the tool, the
// service or n8n is reached.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AUTOMATION_LIBRARY_TOOL_IDS,
  VOICE_REFUSED_TOOLS,
  libraryInstanceKey,
  type AuditLogger,
  type Conversation,
  type ConversationMessage,
  type ConversationStorePort,
  type IApprovalManager,
  type IOrchestrator,
  type SessionContext,
  type ToolExecutionResult,
} from "@jarvis/core";
import { createVoiceConfig } from "@jarvis/config";
import { PermissionService } from "@jarvis/security";
import { ToolExecutor, ToolRegistry, createAutomationLibraryTools } from "@jarvis/tools";
import { createChatRouter, type ChatRouterDeps } from "../src/routes/chat.js";
import { createVoiceRouter } from "../src/routes/voice.js";
import { RECENT_TRANSCRIPT_MAX, RECENT_TRANSCRIPT_TTL_MS, RecentTranscripts } from "../src/services/recent-transcripts.js";
import { AutomationLibraryService } from "../src/services/automation-library/library-service.js";
import { accessOver, memoryTenancy } from "./helpers/shared-access.js";
import { fakeN8nCatalog, memoryLibraryStore } from "./helpers/memory-library.js";

const http = globalThis.fetch.bind(globalThis);
const SYNC = AUTOMATION_LIBRARY_TOOL_IDS.sync;

describe("RecentTranscripts — what the server just transcribed", () => {
  it("recognises a transcript for the account it was made for, however it is spaced or cased", () => {
    const memory = new RecentTranscripts();
    memory.remember("user-1", "Sync the n8n library");
    expect(memory.recognises("user-1", "  sync   the N8N library ")).toBe(true);
    expect(memory.recognises("user-2", "Sync the n8n library")).toBe(false);
    expect(memory.recognises("user-1", "Sync the n8n library now")).toBe(false);
  });

  it("forgets after its time, and holds a bounded number", () => {
    let now = 0;
    const memory = new RecentTranscripts(() => now, 1_000, 3);
    memory.remember("u", "one");
    now = 999;
    expect(memory.recognises("u", "one")).toBe(true);
    now = 1_000;
    expect(memory.recognises("u", "one")).toBe(false);
    for (const text of ["a", "b", "c", "d"]) memory.remember("u", text);
    expect(memory.recognises("u", "a")).toBe(false);
    expect(["b", "c", "d"].every((text) => memory.recognises("u", text))).toBe(true);
    expect(RECENT_TRANSCRIPT_TTL_MS).toBe(120_000);
    expect(RECENT_TRANSCRIPT_MAX).toBeGreaterThan(0);
  });

  it("keeps hashes, never the words, and ignores silence", () => {
    const memory = new RecentTranscripts();
    memory.remember("user-1", "the secret project name");
    memory.remember("user-1", "   ");
    const held = [...(memory as unknown as { seen: Map<string, number> }).seen.keys()];
    expect(held).toHaveLength(1);
    expect(held[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(memory.recognises("user-1", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The chat route, the transcribe route and the executor, together
// ---------------------------------------------------------------------------

function conversationStore(): ConversationStorePort {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ConversationMessage[]>();
  let seq = 0;
  return {
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

let server: Server;
let base = "";
let transcripts: RecentTranscripts;
let seen: SessionContext[];
let executions: ToolExecutionResult[];
let service: AutomationLibraryService;
let catalogCalls: () => number;
let deps: ChatRouterDeps;

const tokenService = {
  verifyAccessToken: (token: string) => {
    const userId = token.replace(/^tok-/, "");
    return userId ? { userId, role: "owner", email: `${userId}@test.local` } : null;
  },
};

beforeEach(() => {
  transcripts = new RecentTranscripts();
  seen = [];
  executions = [];
  const tenancy = memoryTenancy({ owners: { "n8n/rest": "org-lib" }, members: [{ userId: "owner-1", tenantId: "org-lib", role: "owner" }] });
  const catalog = fakeN8nCatalog(20);
  catalogCalls = () => catalog.calls.length;
  service = new AutomationLibraryService({
    store: memoryLibraryStore(),
    access: accessOver(tenancy),
    source: { pages: catalog, instanceKey: libraryInstanceKey("https://n8n.internal.example.test")! },
    budget: { reserveForUser: async () => ({ allowed: true }), reserveForOrganization: async () => ({ allowed: true }) },
    audit: { log: async () => undefined },
  });
  const registry = new ToolRegistry();
  for (const tool of createAutomationLibraryTools(service)) registry.register(tool);
  const executor = new ToolExecutor(registry, new PermissionService(), {} as IApprovalManager, { log: async () => undefined } as unknown as AuditLogger);
  // Stands in for the orchestrator: it asks for the sync on every turn and,
  // like the real one (pinned in packages/agents), carries the session's
  // input mode onto the execution request.
  const orchestrator: IOrchestrator = {
    async process(_request, context) {
      seen.push({ ...context });
      executions.push(
        await executor.execute({
          toolId: SYNC,
          params: { continueUntilComplete: true },
          userId: context.auth.userId,
          role: context.auth.role,
          traceId: context.traceId,
          ...(context.inputMode ? { inputMode: context.inputMode } : {}),
        })
      );
      return {
        success: true,
        data: { message: "ok", conversationId: context.conversationId ?? "" },
        traceId: context.traceId,
        timestamp: new Date().toISOString(),
      };
    },
  };
  deps = {
    tokenService: tokenService as never,
    conversationRepo: conversationStore(),
    orchestrator,
    executor,
    googleWrites: null,
    recentTranscripts: transcripts,
  };
});

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use("/chat", (req, res, next) => createChatRouter(deps)(req, res, next));
  app.use("/voice", (req, res, next) =>
    createVoiceRouter(
      {
        tokenService,
        auditLogger: { log: async () => undefined, query: async () => [] },
        recentTranscripts: transcripts,
      } as never,
      {
        provider: {
          id: "fake",
          name: "fake",
          sttModel: "stt",
          ttsModel: "tts",
          defaultVoice: "v",
          transcribe: async () => ({ text: "Sync the n8n workflow library", model: "stt", latencyMs: 1 }),
          synthesize: async () => {
            throw new Error("not used");
          },
          isAvailable: async () => true,
        } as never,
        config: createVoiceConfig({}, {}),
      }
    )(req, res, next)
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

async function post(path: string, body: unknown, userId = "owner-1") {
  const res = await http(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer tok-${userId}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("the chat route marks a spoken turn", () => {
  it("from the client's word: the sync is refused by the executor, and nothing reaches n8n", async () => {
    const startSync = vi.spyOn(service, "startSync");
    const res = await post("/chat", { message: "Sync the n8n workflow library", inputMode: "voice" });
    expect(res.status).toBe(200);
    expect(seen[0]!.inputMode).toBe("voice");
    expect(executions[0]).toMatchObject({ status: "permission_denied", error: VOICE_REFUSED_TOOLS[SYNC] });
    expect(startSync).not.toHaveBeenCalled();
    expect(catalogCalls()).toBe(0);
  });

  it("from its own transcript, when the client says nothing — and 'text' does not unmark it", async () => {
    const heard = await post("/voice/transcribe", { audio: Buffer.from("audio").toString("base64"), mimeType: "audio/webm" });
    expect(heard.status).toBe(200);
    expect(heard.body.data.text).toBe("Sync the n8n workflow library");

    await post("/chat", { message: "Sync the n8n workflow library" });
    await post("/chat", { message: "sync the n8n workflow library", inputMode: "text" });
    expect(seen.map((c) => c.inputMode)).toEqual(["voice", "voice"]);
    expect(executions.every((e) => e.status === "permission_denied")).toBe(true);
    expect(catalogCalls()).toBe(0);
  });

  it("leaves a typed turn unmarked, and the same sync runs", async () => {
    await post("/chat", { message: "Sync the n8n workflow library" });
    expect(seen[0]!.inputMode).toBeUndefined();
    expect(executions[0]).toMatchObject({ status: "completed", result: { data: { mode: "continue" } } });
  });

  it("does not take another account's transcript as this one's", async () => {
    transcripts.remember("someone-else", "Sync the n8n workflow library");
    await post("/chat", { message: "Sync the n8n workflow library" });
    expect(seen[0]!.inputMode).toBeUndefined();
  });

  it("refuses an input mode it does not know", async () => {
    const res = await post("/chat", { message: "hello", inputMode: "telepathy" });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
