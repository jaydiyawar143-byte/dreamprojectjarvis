// ---------------------------------------------------------------------------
// Phase 19 — Browser Agent chat integration, step 2: a browsing request
// through the REAL chat route.
//
// The real-Chromium E2E calls the orchestrator directly, with the Browser
// Agent named on every request. A person's message does not arrive that way:
// it arrives at POST /chat, and before any agent is chosen the route decides
// whether the message is "work" for the task path (`detectWorkRequest` ->
// `TaskConversationService`). Only what is left reaches the router and the
// orchestrator. This file drives that whole path.
//
// WHAT IS REAL. The chat route; the work detector; the task path
// (TaskConversationService, TaskPlannerService, TaskExecutionService,
// TaskService) with the production allow-list (`schedulableToolIds`); the
// router; the Orchestrator with the production collaborators the container
// gives it (permission checker, tool-approval service, shared-connection
// gate); the real ConversationalAssistant and BrowserAgent; ToolExecutor;
// the real browser tools; RemoteBrowserRuntime; BrowserServiceClient
// (signing every request); the Organization rules (in-memory tenancy).
//
// WHAT IS NOT. The models (scripted: which tool a model picks is not what this
// file is about), the stores (in memory) and the browser service: the
// transport is a script standing in for the service AND the page behind it.
// No socket is opened, so `example.com` is never contacted, and no database,
// Docker or browser is needed.
//
// THE THREE MODELS ARE SEPARATE DOUBLES — the general assistant's, the
// Browser Agent's and the task planner's — so "who handled this turn?" has a
// direct answer rather than an inference.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import { AgentRegistry, BrowserAgent, ConversationalAssistant, Orchestrator, schedulableToolIds } from "@jarvis/agents";
import {
  BrowserServiceClient,
  BrowserServiceTransportError,
  RemoteBrowserRuntime,
  successEnvelope,
  type BrowserServiceTransport,
  type BrowserServiceTransportResponse,
} from "@jarvis/browser-protocol";
import {
  SHARED_INTEGRATION_CONNECTORS,
  type AICompletionRequest,
  type AICompletionResponse,
  type AuditEntry,
  type Conversation,
  type ConversationMessage,
  type ConversationStorePort,
  type IAIProvider,
  type IAuditRepository,
  type TaskStatus,
  type ToolResult,
} from "@jarvis/core";
import type { TaskRecord } from "@jarvis/db";
import { ApprovalService, AuditLogger, PermissionService, ToolApprovalService } from "@jarvis/security";
import { BaseTool, MemoryExecutionJournal, ToolExecutor, ToolRegistry, createBrowserTools } from "@jarvis/tools";
import { describe, expect, it } from "vitest";

import { createChatRouter, type ChatRouterDeps } from "../src/routes/chat.js";
import { TaskConversationService } from "../src/services/tasks/task-conversation-service.js";
import { TaskExecutionService } from "../src/services/tasks/task-execution-service.js";
import { TaskPlannerService } from "../src/services/tasks/task-planner-service.js";
import { TaskService } from "../src/services/tasks/task-service.js";
import {
  createBrowserSessionTenantResolver,
  createBrowserWriteScopeResolver,
  createSharedConnectionToolGate,
} from "../src/services/tenancy/shared-connection-access.js";
import { countTaskRows } from "./helpers/count-task-rows.js";
import { MemoryOrgApprovals } from "./helpers/memory-org-approvals.js";
import { accessOver, memoryTenancy } from "./helpers/shared-access.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = "user-p19-chat";
const ORG = "org-p19-chat";
const BROWSER_AGENT = "browser-agent";
const GENERAL_ASSISTANT = "conversational-assistant";

/** The page behind the fake service. The marker proves a reply was built from what the browser read. */
const PAGE = { url: "https://example.com/", title: "Example Domain", status: 200 };
const PAGE_TEXT = "Example Domain. This domain is for use in documentation examples. Fixture marker P19-CHAT-7F3A.";
const SCREENSHOT_ID = randomUUID();

/** What the server says when browsing is unavailable. The container supplies the real sentence. */
const BROWSING_UNAVAILABLE = "Opening web pages is not available on this test server, so nothing was opened.";

/** What the fake Amazon search page says: a price with its currency, availability, and a decoy. */
const PRODUCT_PAGE = { url: "https://www.amazon.in/s?k=iphone%2017", title: "Amazon.in : iphone 17", status: 200 };
const PRODUCT_TEXT =
  "Results. Apple iPhone 17 (256 GB) - Black. ₹79,900. In stock. FREE delivery. " +
  "Sponsored: iPhone 17 Silicone Case ₹499. Fixture marker P19-PRICE-91B2.";
const HINGLISH = "Amazon kholo aur iPhone 17 ka price check karo.";

const OPEN = "Open https://example.com";
const CHECK_AND_SUMMARIZE = "Check https://example.com and summarize the page";
const SCREENSHOT = "Take a screenshot of https://example.com";

// ---------------------------------------------------------------------------
// Doubles: models, stores, the browser service
// ---------------------------------------------------------------------------

/** A model that records every request and answers from a queue, then from `fallback`. */
class ScriptedModel implements IAIProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel = "scripted-model";
  readonly requests: AICompletionRequest[] = [];
  private readonly queue: AICompletionResponse[] = [];

  constructor(id: string, private readonly fallback: (request: AICompletionRequest) => string) {
    this.id = id;
    this.name = id;
  }

  /** The next turn asks for one tool, by the name a model is shown (dots are not legal there). */
  callsTool(registryId: string, args: Record<string, unknown>): this {
    this.queue.push({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: `call-${this.queue.length + 1}`, name: registryId.replace(/\./g, "-"), arguments: args }],
      },
      finishReason: "tool_calls",
      model: this.defaultModel,
    });
    return this;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    return (
      this.queue.shift() ?? {
        message: { role: "assistant", content: this.fallback(request) },
        finishReason: "stop",
        model: this.defaultModel,
      }
    );
  }

  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const lastUserMessage = (request: AICompletionRequest): string =>
  String(request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "");

/** The Browser Agent's model, after a tool ran: it reports what the tool returned, verbatim. */
const reportToolResult = (request: AICompletionRequest): string => {
  const envelope = [...request.messages].reverse().find((message) => String(message.content ?? "").includes("TOOL: browser."));
  return envelope ? `From the page: ${String(envelope.content)}` : "No page was read.";
};

function memoryConversationStore() {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ConversationMessage[]>();
  let seq = 0;
  const store: ConversationStorePort = {
    async create(input) {
      const id = `conv-${++seq}`;
      const now = new Date().toISOString();
      conversations.set(id, { id, title: input.title ?? null, userId: input.userId, agentId: input.agentId ?? null, createdAt: now, updatedAt: now });
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
      messages.get(input.conversationId)!.push(message);
      return message;
    },
  };
  return { store, of: (conversationId: string) => messages.get(conversationId) ?? [] };
}

function taskStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;
  return {
    rows,
    async create(userId: string, input: { title: string; description?: string | null; createdBy?: string | null }) {
      const now = new Date();
      const row: TaskRecord = {
        id: `task-${++seq}`, userId, title: input.title,
        description: input.description ?? null, dueAt: null, priority: "NORMAL",
        status: "PENDING", startedAt: null, completedAt: null, error: null,
        remindedAt: null, scheduledAt: null, claimedAt: null, executionId: null,
        createdBy: input.createdBy ?? null, createdAt: now, updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
    },
    async list(userId: string) {
      return [...rows.values()].filter((row) => row.userId === userId);
    },
    async listByStatus(userId: string, status: TaskStatus) {
      return [...rows.values()].filter((row) => row.userId === userId && row.status === status);
    },
    async countByStatus(userId: string, options: { createdBy?: string } = {}) {
      return countTaskRows(rows.values(), userId, options);
    },
    async findOwned(userId: string, taskId: string) {
      const row = rows.get(taskId);
      return row && row.userId === userId ? row : null;
    },
    async transitionOwned(userId: string, taskId: string, expectedFrom: TaskStatus, to: TaskStatus, options: { error?: string | null } = {}) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) return { ok: false as const, reason: "not_found" as const, current: null };
      if (row.status !== expectedFrom) return { ok: false as const, reason: "state_changed" as const, current: row.status };
      row.status = to;
      if (to === "RUNNING") row.startedAt = new Date();
      if (to === "COMPLETED") { row.completedAt = new Date(); row.error = null; }
      if (to === "FAILED") row.error = options.error ?? null;
      return { ok: true as const, task: row };
    },
  };
}

class MemoryAudit implements IAuditRepository {
  readonly entries: AuditEntry[] = [];
  async create(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry> {
    const row = { ...entry, id: `audit-${this.entries.length + 1}`, timestamp: new Date() } as AuditEntry;
    this.entries.push(row);
    return row;
  }
  async query(): Promise<AuditEntry[]> {
    return [...this.entries];
  }
}

/** A read tool the general assistant and the task path may use: the non-browsing control. */
class SystemStatusTool extends BaseTool {
  calls = 0;
  constructor() {
    super("system.status", "System status", "Read the system status.", "system", [], false, ["read"], "READ_ONLY");
  }
  async execute(): Promise<ToolResult> {
    this.calls += 1;
    return this.success({ healthy: true });
  }
}

/** The browser service and the page behind it, as a script. Records every operation it was sent. */
interface ServiceRecord {
  /** The payload of every operation sent, in order (a URL the browser was asked to open is here). */
  payloads: Array<{ operation: string; payload?: Record<string, unknown> }>;
}

function serviceAndPage(operations: string[], record: ServiceRecord, down: boolean): BrowserServiceTransport {
  const sessionId = randomUUID();
  return async (request) => {
    const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as {
      requestId: string;
      operation: string;
      payload?: Record<string, unknown>;
    };
    operations.push(body.operation);
    record.payloads.push({ operation: body.operation, ...(body.payload ? { payload: body.payload } : {}) });
    // The service is not reachable at all: nothing was sent, and nothing answers.
    if (down) throw new BrowserServiceTransportError(false);
    const ok = (result: unknown): BrowserServiceTransportResponse => ({
      status: 200,
      headers: {},
      body: JSON.stringify(successEnvelope(body.requestId, result)),
      tooLarge: false,
    });
    switch (body.operation) {
      case "session.open":
        return ok({ sessionId, expiresAt: Date.now() + 60_000, ttlMs: 60_000 });
      case "session.close":
        return ok({ closed: true });
      case "browser.navigate": {
        // The runtime opens the page, then reads the page it landed on.
        const toProduct = String(body.payload?.url ?? "").includes("amazon.in");
        return ok({ action: "browser.navigate", ok: true, page: toProduct ? PRODUCT_PAGE : PAGE, redirected: false });
      }
      case "browser.extract": {
        const wantsProduct = String(body.payload?.url ?? "").includes("amazon.in");
        return ok({
          action: "browser.extract",
          ok: true,
          page: wantsProduct ? PRODUCT_PAGE : PAGE,
          text: wantsProduct ? PRODUCT_TEXT : PAGE_TEXT,
          fields: {},
          truncated: false,
        });
      }
      case "browser.screenshot":
        return ok({ action: "browser.screenshot", ok: true, page: PAGE, screenshotId: SCREENSHOT_ID, byteSize: 2048, format: "png" });
      default:
        throw new Error(`the fake service was sent an unexpected operation: ${body.operation}`);
    }
  };
}

// ---------------------------------------------------------------------------
// The stack, wired as the container wires it
// ---------------------------------------------------------------------------

interface StackOptions {
  /** Whether this server registered the browser tools and the Browser Agent. */
  browsing: boolean;
  /** What the task planner's model answers, when it is asked. */
  plan?: Record<string, unknown>;
  /** A scheduler, for a turn that names a time. */
  scheduler?: boolean;
  /** The browser service is registered but cannot be reached. */
  serviceDown?: boolean;
}

function stack(options: StackOptions) {
  const conversations = memoryConversationStore();
  const tasks = taskStore();
  const operations: string[] = [];
  const record: ServiceRecord = { payloads: [] };
  const scheduled: Array<{ taskId: string; at: Date }> = [];

  const general = new ScriptedModel("general", (request) => `General answer to: ${lastUserMessage(request)}`);
  const browserModel = new ScriptedModel("browser", reportToolResult);
  const planner = new ScriptedModel("planner", () =>
    JSON.stringify(options.plan ?? { executable: false, reason: "No listed tool does that." })
  );

  const browser = SHARED_INTEGRATION_CONNECTORS.browser;
  const tenancy = memoryTenancy({
    owners: { [`${browser.providerId}/${browser.connector}`]: ORG },
    members: [{ userId: USER, tenantId: ORG, role: "owner" }],
  });
  const access = accessOver(tenancy);
  const approvals = new MemoryOrgApprovals(tenancy);
  const permissions = new PermissionService();
  const audit = new MemoryAudit();
  const auditLogger = new AuditLogger(audit);

  const tools = new ToolRegistry();
  const status = new SystemStatusTool();
  tools.register(status);
  if (options.browsing) {
    const client = new BrowserServiceClient({
      config: {
        baseUrl: "https://browser-service.invalid:3200",
        keyId: "api-key-p19-chat",
        secret: "p19-chat-route-not-a-real-secret-0123456789",
        peerIdentity: "jarvis-api",
        timeoutMs: 30_000,
        tls: null,
      },
      transport: serviceAndPage(operations, record, options.serviceDown === true),
    });
    const runtime = new RemoteBrowserRuntime({ client, tenant: createBrowserSessionTenantResolver(access) });
    const consumption = { consumeForExecution: async () => ({ ok: false as const, reason: "no approvals in this test" }) };
    // As the container registers them where approvals cannot be sealed: the reads.
    for (const tool of createBrowserTools(runtime, new MemoryExecutionJournal(), consumption, createBrowserWriteScopeResolver(access))) {
      if (!tool.requiresApproval) tools.register(tool);
    }
  }

  const accessGate = createSharedConnectionToolGate(access);
  const executor = new ToolExecutor(tools, permissions, new ApprovalService(approvals), auditLogger, { accessGate });

  const allowedToolIds = schedulableToolIds();
  const taskService = new TaskService({ tasks });
  const taskConversation = new TaskConversationService({
    tasks: taskService,
    planner: new TaskPlannerService({ provider: planner, registry: tools, allowedToolIds }),
    execution: new TaskExecutionService({ tasks: taskService, executor, allowedToolIds }),
    ...(options.scheduler
      ? {
          scheduler: {
            scheduleTask: async (_userId: string, taskId: string, at: Date) => {
              scheduled.push({ taskId, at });
              const task = tasks.rows.get(taskId)!;
              task.scheduledAt = at;
              return { ok: true as const, task };
            },
          } as never,
        }
      : {}),
  });

  const agents = new AgentRegistry({ requirePolicy: true });
  agents.register(new ConversationalAssistant({ provider: general, systemPrompt: "You are JARVIS." }));
  if (options.browsing) agents.register(new BrowserAgent({ provider: browserModel }));

  const orchestrator = new Orchestrator(agents, executor, auditLogger, {
    toolRegistry: tools,
    permissionChecker: permissions,
    toolApprovalService: new ToolApprovalService(approvals, audit, permissions),
    accessGate,
    // As the container passes it: only where the Browser Agent is absent.
    ...(options.browsing ? {} : { browsingUnavailableReason: BROWSING_UNAVAILABLE }),
  });

  const tokenService = {
    verifyAccessToken: (token: string) => (token === "token-p19" ? { userId: USER, role: "owner", email: "p19@test.local" } : null),
  } as unknown as ChatRouterDeps["tokenService"];

  const chat = createChatRouter({ tokenService, conversationRepo: conversations.store, orchestrator, executor, taskConversation, googleWrites: null });

  return { chat, conversations, tasks, operations, record, scheduled, general, browserModel, planner, status, audit };
}

type Stack = ReturnType<typeof stack>;
interface ChatReply {
  status: number;
  body: {
    success: boolean;
    data?: {
      message: string;
      conversationId: string;
      agentId?: string;
      taskId?: string;
      metadata?: { toolExecution?: { executions: Array<{ toolId: string; status: string }> } } & Record<string, unknown>;
    };
    error?: { code: string; message: string };
  };
}

/** POST /chat, through the route's own handler stack (auth middleware included). */
function post(s: Stack, message: string): Promise<ChatReply> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { authorization: "Bearer token-p19" };
    const req = {
      method: "POST", path: "/", url: "/", headers, body: { message }, params: {}, query: {}, ip: "127.0.0.1",
      get: (name: string) => headers[name.toLowerCase()],
    } as never;
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        resolve({ status: this.statusCode, body: payload as ChatReply["body"] });
        return this;
      },
      setHeader() {
        return this;
      },
    };
    const layer = (
      s.chat as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => void }> } }>;
      }
    ).stack.find((entry) => entry.route?.path === "/" && entry.route.methods.post);
    const handlers = layer!.route!.stack.map((handler) => handler.handle);
    let index = 0;
    const next = () => {
      if (index < handlers.length) handlers[index++]!(req, res, next);
    };
    next();
  });
}

const ran = (reply: ChatReply) =>
  (reply.body.data?.metadata?.toolExecution?.executions ?? []).map((execution) => [execution.toolId, execution.status]);

/** The turn reached the Browser Agent, and nothing else answered it. */
function expectBrowserAgentAnswered(s: Stack, reply: ChatReply): void {
  expect(reply.status).toBe(200);
  expect(reply.body.success).toBe(true);
  expect(reply.body.data!.agentId).toBe(BROWSER_AGENT);
  expect(s.general.requests).toHaveLength(0);
  // Not the task path: no plan was asked for, and no task was recorded.
  expect(s.planner.requests).toHaveLength(0);
  expect(s.tasks.rows.size).toBe(0);
  expect(reply.body.data!.taskId).toBeUndefined();
}

/** The reply that was sent is the reply that was stored. */
function expectStored(s: Stack, reply: ChatReply, userMessage: string): void {
  const stored = s.conversations.of(reply.body.data!.conversationId).map((message) => [message.role, message.content]);
  expect(stored).toEqual([
    ["user", userMessage],
    ["assistant", reply.body.data!.message],
  ]);
}

// ---------------------------------------------------------------------------
// 1. "Open https://example.com"
// ---------------------------------------------------------------------------

describe("Open https://example.com", () => {
  it("is answered by the Browser Agent, which runs browser.navigate through the browser service", async () => {
    const s = stack({ browsing: true });
    s.browserModel.callsTool("browser.navigate", { url: "https://example.com" });

    const reply = await post(s, OPEN);

    expectBrowserAgentAnswered(s, reply);
    expect(ran(reply)).toEqual([["browser.navigate", "completed"]]);
    expect(s.operations).toEqual(["session.open", "browser.navigate", "session.close"]);
  });

  it("puts what the browser read into the chat reply, and stores that reply", async () => {
    const s = stack({ browsing: true });
    s.browserModel.callsTool("browser.navigate", { url: "https://example.com" });

    const reply = await post(s, OPEN);

    expect(reply.body.data!.message).toContain("Example Domain");
    expect(reply.body.data!.message).toContain("https://example.com/");
    expectStored(s, reply, OPEN);
  });
});

// ---------------------------------------------------------------------------
// 2. "Check https://example.com and summarize the page"
// ---------------------------------------------------------------------------

describe("Check https://example.com and summarize the page", () => {
  // What a planner model would plausibly answer if the task path were asked:
  // one read of the page. The task path can run one tool, and cannot
  // summarise what it returned.
  const PLAN_EXTRACT = {
    executable: true,
    toolId: "browser.extract",
    params: { url: "https://example.com" },
    reason: "Reading the page answers this.",
  };

  it("is not taken by the task path: no plan, no task", async () => {
    const s = stack({ browsing: true, plan: PLAN_EXTRACT });
    s.browserModel.callsTool("browser.extract", { url: "https://example.com" });

    const reply = await post(s, CHECK_AND_SUMMARIZE);

    expect(s.planner.requests).toHaveLength(0);
    expect(s.tasks.rows.size).toBe(0);
    expect(reply.body.data!.taskId).toBeUndefined();
  });

  it("is answered by the Browser Agent, which reads the page with browser.extract", async () => {
    const s = stack({ browsing: true, plan: PLAN_EXTRACT });
    s.browserModel.callsTool("browser.extract", { url: "https://example.com" });

    const reply = await post(s, CHECK_AND_SUMMARIZE);

    expectBrowserAgentAnswered(s, reply);
    expect(ran(reply)).toEqual([["browser.extract", "completed"]]);
    expect(s.operations).toContain("browser.extract");
  });

  it("returns a reply built from the page's text, not a note that a tool ran", async () => {
    const s = stack({ browsing: true, plan: PLAN_EXTRACT });
    s.browserModel.callsTool("browser.extract", { url: "https://example.com" });

    const reply = await post(s, CHECK_AND_SUMMARIZE);

    expect(reply.body.data!.message).toContain("P19-CHAT-7F3A");
    expect(reply.body.data!.message).not.toMatch(/^Done — I ran /);
    expectStored(s, reply, CHECK_AND_SUMMARIZE);
  });

  it("with a time named, stays a scheduled task: nothing is opened now", async () => {
    const s = stack({ browsing: true, plan: PLAN_EXTRACT, scheduler: true });

    const reply = await post(s, "Tomorrow at 10 am check https://example.com and summarize the page");

    expect(reply.status).toBe(200);
    expect(s.scheduled).toHaveLength(1);
    expect(s.operations).toEqual([]);
    expect(s.browserModel.requests).toHaveLength(0);
    expect(reply.body.data!.message).toContain("Nothing has run yet.");
  });
});

// ---------------------------------------------------------------------------
// 3. "Take a screenshot of https://example.com"
// ---------------------------------------------------------------------------

describe("Take a screenshot of https://example.com", () => {
  it("is answered by the Browser Agent, which runs browser.screenshot", async () => {
    const s = stack({ browsing: true });
    s.browserModel.callsTool("browser.screenshot", { url: "https://example.com" });

    const reply = await post(s, SCREENSHOT);

    expectBrowserAgentAnswered(s, reply);
    expect(ran(reply)).toEqual([["browser.screenshot", "completed"]]);
    expect(s.operations).toContain("browser.screenshot");
    expect(reply.body.data!.message).toContain(SCREENSHOT_ID);
  });
});

// ---------------------------------------------------------------------------
// 4. The Browser Agent is unavailable
// ---------------------------------------------------------------------------

describe("when this server has no Browser Agent", () => {
  it.each([
    ["Open https://example.com", OPEN],
    ["Check … and summarize the page", CHECK_AND_SUMMARIZE],
    ["Take a screenshot of …", SCREENSHOT],
  ])("%s is answered with the explanation, and nothing pretends to have read the page", async (_label, message) => {
    const s = stack({ browsing: false, plan: { executable: true, toolId: "system.status", params: {}, reason: "wrong tool" } });

    const reply = await post(s, message);

    expect(reply.status).toBe(200);
    expect(reply.body.success).toBe(true);
    expect(reply.body.data!.message).toBe(BROWSING_UNAVAILABLE);
    // No model answered it, so nothing could claim to have read the page...
    expect(s.general.requests).toHaveLength(0);
    expect(s.browserModel.requests).toHaveLength(0);
    // ...nothing was planned or run in its place...
    expect(s.planner.requests).toHaveLength(0);
    expect(s.tasks.rows.size).toBe(0);
    expect(s.status.calls).toBe(0);
    expect(s.operations).toEqual([]);
    // ...and the person sees the same explanation when they come back to it.
    expectStored(s, reply, message);
  });

  it("records that browsing was asked for and was unavailable", async () => {
    const s = stack({ browsing: false });

    await post(s, OPEN);

    expect(s.audit.entries.filter((entry) => entry.action === "agent.unavailable")).toEqual([
      expect.objectContaining({ userId: USER, agentId: BROWSER_AGENT, result: "rejected" }),
    ]);
  });

  it("still lets the general assistant answer a message that only mentions a link", async () => {
    const s = stack({ browsing: false });

    const reply = await post(s, "Write a tagline for my site https://example.com");

    expect(reply.body.data!.agentId).toBe(GENERAL_ASSISTANT);
    expect(reply.body.data!.message).toBe("General answer to: Write a tagline for my site https://example.com");
  });
});

// ---------------------------------------------------------------------------
// 4b. "Amazon kholo aur iPhone 17 ka price check karo." — a site by NAME, no link
// ---------------------------------------------------------------------------

describe(HINGLISH, () => {
  const AMAZON_SEARCH = "https://www.amazon.in/s?k=iphone%2017";

  it("is answered by the Browser Agent, not saved as a task", async () => {
    const s = stack({ browsing: true });
    s.browserModel.callsTool("browser.extract", { url: AMAZON_SEARCH });

    const reply = await post(s, HINGLISH);

    expectBrowserAgentAnswered(s, reply);
    expect(ran(reply)).toEqual([["browser.extract", "completed"]]);
  });

  it("opens the search address the agent chose, through the browser service", async () => {
    const s = stack({ browsing: true });
    s.browserModel.callsTool("browser.extract", { url: AMAZON_SEARCH });

    await post(s, HINGLISH);

    // One fresh session: the page is opened, read, and the session closed.
    expect(s.operations).toEqual(["session.open", "browser.navigate", "browser.extract", "session.close"]);
    expect(s.record.payloads.find((entry) => entry.operation === "browser.navigate")?.payload).toMatchObject({ url: AMAZON_SEARCH });
  });

  it("hands the model the page's displayed price, currency, availability and source URL", async () => {
    const s = stack({ browsing: true });
    s.browserModel.callsTool("browser.extract", { url: AMAZON_SEARCH });

    const reply = await post(s, HINGLISH);

    // The scripted model repeats the tool result it was shown; what matters is
    // that every fact the prompt asks it to report was in front of it.
    const message = reply.body.data!.message;
    expect(message).toContain("₹79,900");
    expect(message).toContain("In stock");
    expect(message).toContain("P19-PRICE-91B2");
    expect(message).toContain(PRODUCT_PAGE.url);
    expectStored(s, reply, HINGLISH);
  });

  it("is told, where this server has no Browser Agent, that nothing was opened", async () => {
    const s = stack({ browsing: false, plan: { executable: true, toolId: "system.status", params: {}, reason: "wrong tool" } });

    const reply = await post(s, HINGLISH);

    expect(reply.status).toBe(200);
    expect(reply.body.data!.message).toBe(BROWSING_UNAVAILABLE);
    expect(s.general.requests).toHaveLength(0);
    expect(s.planner.requests).toHaveLength(0);
    expect(s.tasks.rows.size).toBe(0);
    expect(s.operations).toEqual([]);
  });
});

describe("natural price and search phrasings through the chat route", () => {
  const PHRASES = [
    "Price of iPhone 17 on Flipkart",
    "Amazon par iPhone 17 search karo",
    "Myntra par shoes dekho",
    "Flipkart par laptop ka price check karo",
    "Search iPhone 17 on Amazon",
  ];

  it.each(PHRASES)("%s reaches the Browser Agent, not the general model or the task path", async (message) => {
    const s = stack({ browsing: true });
    s.browserModel.callsTool("browser.extract", { url: "https://www.amazon.in/s?k=iphone%2017" });

    const reply = await post(s, message);

    expectBrowserAgentAnswered(s, reply);
    expect(s.general.requests).toHaveLength(0);
    expect(s.tasks.rows.size).toBe(0);
  });

  it.each(PHRASES)("%s is told, where this server has no Browser Agent, that nothing was opened", async (message) => {
    const s = stack({ browsing: false, plan: { executable: true, toolId: "system.status", params: {}, reason: "wrong tool" } });

    const reply = await post(s, message);

    expect(reply.body.data!.message).toBe(BROWSING_UNAVAILABLE);
    expect(s.general.requests).toHaveLength(0);
    expect(s.operations).toEqual([]);
  });

  it.each(["Amazon Ads campaign strategy batao", "Tell me about Amazon Web Services", "Flipkart business model explain karo"])(
    "%s is not a browsing request: nothing is opened",
    async (message) => {
      const s = stack({ browsing: true });

      await post(s, message);

      expect(s.operations).toEqual([]);
      expect(s.browserModel.requests).toHaveLength(0);
    }
  );
});

describe("when the browser service is registered but cannot be reached", () => {
  it.each([OPEN, HINGLISH])("%s fails with an actionable sentence, and nothing claims the page was read", async (message) => {
    const s = stack({ browsing: true, serviceDown: true });
    s.browserModel.callsTool("browser.extract", { url: "https://www.amazon.in/s?k=iphone%2017" });

    const reply = await post(s, message);

    expect(reply.body.success).toBe(false);
    expect(reply.status).toBeGreaterThanOrEqual(500);
    const said = reply.body.error!.message;
    expect(said).toContain("browser service");
    expect(said).toContain("was not opened or read");
    expect(said).toContain("running and reachable");
    // Nothing from a page, no price, and no pretence that the task was done.
    expect(said).not.toMatch(/P19-|₹|Done|From the page/);
    expect(said).not.toBe("Data retrieval failed.");
    expect(reply.body.data).toBeUndefined();
    // It was asked, once, and it did not turn into a task.
    expect(s.tasks.rows.size).toBe(0);
    expect(s.planner.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. General chat is unchanged
// ---------------------------------------------------------------------------

describe("general chat, with and without browsing", () => {
  it.each([true, false])("a question is answered by the general assistant (browsing %s)", async (browsing) => {
    const s = stack({ browsing });

    const reply = await post(s, "What is the capital of France");

    expect(reply.status).toBe(200);
    expect(reply.body.data!.agentId).toBe(GENERAL_ASSISTANT);
    expect(reply.body.data!.message).toBe("General answer to: What is the capital of France");
    expect(s.browserModel.requests).toHaveLength(0);
    expect(s.operations).toEqual([]);
    expect(s.tasks.rows.size).toBe(0);
  });

  it.each([true, false])("work that names no page still goes to the task path (browsing %s)", async (browsing) => {
    const s = stack({ browsing, plan: { executable: true, toolId: "system.status", params: {}, reason: "Reading the status answers this." } });

    const reply = await post(s, "check my system status");

    expect(reply.status).toBe(200);
    expect(s.planner.requests).toHaveLength(1);
    expect(s.tasks.rows.size).toBe(1);
    expect(s.status.calls).toBe(1);
    expect(reply.body.data!.message).toBe('Done — I ran system.status for "check my system status".');
    expect(s.general.requests).toHaveLength(0);
    expect(s.browserModel.requests).toHaveLength(0);
  });
});
