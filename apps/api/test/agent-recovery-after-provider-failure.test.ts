// ---------------------------------------------------------------------------
// R-24 to R-29 — what a request, and the request after it, see when the model
// provider fails.
//
// Real OpenAIAdapter, real OpenAI SDK, real ConversationalAssistant, real
// Orchestrator and — where persistence matters — the real chat route. The only
// fake is upstream: a local HTTP server the SDK is pointed at through
// OPENAI_BASE_URL, scripted one reply per request. So every failure is the one
// the SDK really throws, classified, retried and counted by the real adapter,
// and the status that follows is decided by the real agent.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AuditLogger,
  Conversation,
  ConversationMessage,
  IAIProvider,
  JarvisRequest,
  JarvisResponse,
  SessionContext,
} from "@jarvis/core";
import { Orchestrator, AgentRegistry, ConversationalAssistant } from "@jarvis/agents";
import { OpenAIAdapter, NotConfiguredAIProvider, type OpenAIAdapterConfig } from "@jarvis/ai-openai";
import { createChatRouter } from "../src/routes/chat.js";

const FAKE_KEY = "sk-test-r24-not-a-real-key";

type Reply = (res: ServerResponse) => void;

/** Requests a `hang` reply left open, released after each test. */
const hanging: ServerResponse[] = [];

// `connection: close` so no test can inherit a keep-alive socket from the one
// before it: a reused socket that was already torn down fails as a connection
// error, which is a transient failure of its own and would mask the reply the
// test scripted.
const json =
  (status: number, body: unknown): Reply =>
  (res) => {
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(body));
  };

const completion = (content: string): Reply =>
  json(200, {
    id: "chatcmpl-r24",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const REPLY = {
  success: completion("recovered"),
  /** Never answers, so the adapter's own timeout is what ends the request. */
  hang: ((res) => {
    hanging.push(res);
  }) as Reply,
  /** Closes the socket without a response: a dropped connection. */
  dropped: ((res) => {
    res.socket?.destroy();
  }) as Reply,
  rateLimit: json(429, {
    error: { message: "Rate limit reached for gpt-4o-mini", type: "requests", code: "rate_limit_exceeded" },
  }),
  serverError: (status: number) =>
    json(status, { error: { message: "The server is overloaded", type: "server_error" } }),
  invalidKey: json(401, {
    error: { message: `Incorrect API key provided: ${FAKE_KEY}.`, type: "invalid_request_error", code: "invalid_api_key" },
  }),
  invalidModel: json(404, {
    error: {
      message: "The model `gpt-unknown` does not exist or you do not have access to it.",
      type: "invalid_request_error",
      code: "model_not_found",
    },
  }),
  contextLength: json(400, {
    error: {
      message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.",
      type: "invalid_request_error",
      param: "messages",
      code: "context_length_exceeded",
    },
  }),
  /** A 200 the adapter cannot read: no `choices` at all. */
  malformed: json(200, {}),
};

/** Retries on, with waits too short to slow any test. */
const FAST_RETRIES: OpenAIAdapterConfig = {
  maxRetries: 2,
  retryPolicy: { baseDelayMs: 1, maxDelayMs: 5, maxJitterMs: 0 },
};

let server: Server;
let baseURL: string;
let script: Reply[] = [];
let upstreamCalls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      upstreamCalls++;
      const reply = script.shift() ?? json(418, { error: { message: "unscripted request" } });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  for (const res of hanging.splice(0)) {
    res.socket?.destroy();
  }
  script = [];
  upstreamCalls = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The real adapter against the fake upstream. Retries off unless asked for. */
function realAdapter(config: OpenAIAdapterConfig = {}): OpenAIAdapter {
  vi.stubEnv("OPENAI_BASE_URL", baseURL);
  return new OpenAIAdapter({ apiKey: FAKE_KEY, timeoutMs: 300, maxRetries: 0, ...config });
}

function buildOrchestrator(provider: IAIProvider): Orchestrator {
  const registry = new AgentRegistry();
  registry.register(new ConversationalAssistant({ provider, systemPrompt: "You are JARVIS." }));
  const auditLogger = { log: async () => {}, query: async () => [] } as unknown as AuditLogger;
  const executor = {
    execute: async () => {
      throw new Error("no tool may run in this test");
    },
  };
  return new Orchestrator(registry, executor as never, auditLogger, {});
}

function send(orchestrator: Orchestrator, message: string, conversationId = "conv-r24"): Promise<JarvisResponse> {
  const request = { message, conversationId, stream: false } as JarvisRequest;
  const context: SessionContext = {
    auth: { userId: "user-r24", role: "member", email: "r24@example.com" },
    conversationId,
    traceId: "00000000-0000-0000-0000-000000000024",
  };
  return orchestrator.process(request, context);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("R-24 — a transient provider failure does not take the assistant out of service", () => {
  it.each([
    ["a timeout", REPLY.hang, "INTERNAL_ERROR"],
    ["a rate limit (429)", REPLY.rateLimit, "RATE_LIMITED"],
    ["a temporary 500", REPLY.serverError(500), "INTERNAL_ERROR"],
    ["a temporary 503", REPLY.serverError(503), "INTERNAL_ERROR"],
    ["a temporary 504", REPLY.serverError(504), "INTERNAL_ERROR"],
  ])("answers the next request after %s", async (_label, failure, code) => {
    const orchestrator = buildOrchestrator(realAdapter());
    script = [failure, REPLY.success];

    const first = await send(orchestrator, "Hello JARVIS");
    const second = await send(orchestrator, "Hello again");

    expect(first.success).toBe(false);
    expect(first.error?.code).toBe(code);
    expect(second.success).toBe(true);
    expect(second.data?.message).toBe("recovered");
    expect(upstreamCalls).toBe(2);
  });
});

describe("R-24 — a missing provider is unchanged (R-21)", () => {
  it("answers AI_PROVIDER_NOT_CONFIGURED again on the next request", async () => {
    const orchestrator = buildOrchestrator(new NotConfiguredAIProvider());

    const first = await send(orchestrator, "Hello JARVIS");
    const second = await send(orchestrator, "Hello again");

    expect([first.error?.code, second.error?.code]).toEqual([
      "AI_PROVIDER_NOT_CONFIGURED",
      "AI_PROVIDER_NOT_CONFIGURED",
    ]);
  });
});

describe("R-24 / R-29 — permanent and unexpected failures keep today's behaviour", () => {
  it("an invalid API key stays permanent: the next request is refused without calling OpenAI", async () => {
    const orchestrator = buildOrchestrator(realAdapter(FAST_RETRIES));
    script = [REPLY.invalidKey, REPLY.success];

    const first = await send(orchestrator, "Hello JARVIS");
    const second = await send(orchestrator, "Hello again");

    // R-29: reported as the server's configuration failure, not the user's 401.
    expect(first.error?.code).toBe("AI_PROVIDER_AUTH_FAILED");
    expect(JSON.stringify(first)).not.toContain(FAKE_KEY);
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe("AGENT_ERROR");
    expect(upstreamCalls).toBe(1);
  });

  it("an invalid model stays permanent: the next request is refused without calling OpenAI", async () => {
    const orchestrator = buildOrchestrator(realAdapter(FAST_RETRIES));
    script = [REPLY.invalidModel, REPLY.success];

    const first = await send(orchestrator, "Hello JARVIS");
    const second = await send(orchestrator, "Hello again");

    expect(first.error?.code).toBe("INVALID_REQUEST");
    expect(second.error?.code).toBe("AGENT_ERROR");
    expect(upstreamCalls).toBe(1);
  });

  it("an unexpected fatal error (a malformed 200 response) leaves the assistant errored, as before", async () => {
    const orchestrator = buildOrchestrator(realAdapter());
    script = [REPLY.malformed, REPLY.success];

    const first = await send(orchestrator, "Hello JARVIS");
    const second = await send(orchestrator, "Hello again");

    expect(first.error?.code).toBe("INTERNAL_ERROR");
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe("AGENT_ERROR");
    expect(upstreamCalls).toBe(1);
  });
});

describe("R-25 — an exceeded context window is isolated to its request", () => {
  it("answers CONTEXT_LENGTH_EXCEEDED once, with a safe message, and does not retry", async () => {
    const orchestrator = buildOrchestrator(realAdapter(FAST_RETRIES));
    script = [REPLY.contextLength, REPLY.success];

    const response = await send(orchestrator, "A very long conversation", "conv-long");

    expect(response.error?.code).toBe("CONTEXT_LENGTH_EXCEEDED");
    expect(response.error?.message).toMatch(/too long/i);
    expect(JSON.stringify(response)).not.toContain("128000");
    expect(JSON.stringify(response)).not.toContain(FAKE_KEY);
    expect(upstreamCalls).toBe(1);
  });

  it("leaves the assistant serving the same conversation and every other one", async () => {
    const orchestrator = buildOrchestrator(realAdapter(FAST_RETRIES));
    script = [REPLY.contextLength, completion("same conversation"), completion("other conversation")];

    const failed = await send(orchestrator, "A very long conversation", "conv-long");
    const sameConversation = await send(orchestrator, "A shorter question", "conv-long");
    const otherConversation = await send(orchestrator, "Hello", "conv-other");

    expect(failed.error?.code).toBe("CONTEXT_LENGTH_EXCEEDED");
    expect(sameConversation.data?.message).toBe("same conversation");
    expect(otherConversation.data?.message).toBe("other conversation");
    expect(upstreamCalls).toBe(3);
  });
});

describe("R-26 — transient failures are retried inside the request", () => {
  it.each([
    ["a rate limit (429)", REPLY.rateLimit],
    ["a 500", REPLY.serverError(500)],
    ["a 502", REPLY.serverError(502)],
    ["a 503", REPLY.serverError(503)],
    ["a 504", REPLY.serverError(504)],
    ["a timeout", REPLY.hang],
    ["a dropped connection", REPLY.dropped],
  ])("recovers from %s without the user seeing it", async (_label, failure) => {
    const orchestrator = buildOrchestrator(realAdapter(FAST_RETRIES));
    script = [failure, REPLY.success];

    const response = await send(orchestrator, "Hello JARVIS");

    expect(response.success).toBe(true);
    expect(response.data?.message).toBe("recovered");
    expect(upstreamCalls).toBe(2);
  });

  it("gives up after maxRetries with one error, and the next request still works", async () => {
    const orchestrator = buildOrchestrator(realAdapter(FAST_RETRIES));
    script = [REPLY.serverError(503), REPLY.serverError(503), REPLY.serverError(503), REPLY.success];

    const exhausted = await send(orchestrator, "Hello JARVIS");
    const next = await send(orchestrator, "Hello again");

    expect(exhausted.error?.code).toBe("INTERNAL_ERROR");
    expect(next.data?.message).toBe("recovered");
    expect(upstreamCalls).toBe(4);
  });

  it("a retried call persists the user's message and the reply exactly once", async () => {
    const messages: ConversationMessage[] = [];
    const conversationRepo = {
      create: async (input: { userId: string }): Promise<Conversation> => ({
        id: "conv-retry",
        title: null,
        userId: input.userId,
        agentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      findByIdAndUserId: async () => null,
      getMessages: async () => [],
      addMessage: async (input: { role: string; content: string }) => {
        const message = {
          id: `m${messages.length}`,
          role: input.role,
          content: input.content,
          createdAt: new Date().toISOString(),
        } as ConversationMessage;
        messages.push(message);
        return message;
      },
    };
    const router = createChatRouter({
      tokenService: { verifyAccessToken: () => ({ userId: "user-r26", role: "member", email: "r26@example.com" }) },
      orchestrator: buildOrchestrator(realAdapter(FAST_RETRIES)),
      conversationRepo,
      auditLogger: { log: async () => {} },
    } as never);
    script = [REPLY.serverError(503), REPLY.success];

    const response = await postChat(router, "Hello JARVIS");

    expect(response.status).toBe(200);
    expect(upstreamCalls).toBe(2);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("R-27 — the provider circuit breaker", () => {
  const BREAKER = (openDurationMs: number): OpenAIAdapterConfig => ({
    maxRetries: 0,
    circuitBreaker: { failureThreshold: 2, openDurationMs, halfOpenMaxProbes: 1 },
  });

  it("opens after the threshold and refuses without calling OpenAI, while the assistant stays selectable", async () => {
    const orchestrator = buildOrchestrator(realAdapter(BREAKER(60_000)));
    script = [REPLY.serverError(503), REPLY.serverError(503), REPLY.success];

    await send(orchestrator, "one");
    await send(orchestrator, "two");
    const refused = await send(orchestrator, "three");
    const refusedAgain = await send(orchestrator, "four");

    expect(refused.error?.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(refusedAgain.error?.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(upstreamCalls).toBe(2);
  });

  it("answers an open circuit with a stable message that reveals no internal state", async () => {
    const orchestrator = buildOrchestrator(realAdapter(BREAKER(60_000)));
    script = [REPLY.serverError(503), REPLY.serverError(503)];

    await send(orchestrator, "one");
    await send(orchestrator, "two");
    const refused = await send(orchestrator, "three");
    const body = JSON.stringify(refused);

    expect(refused.error?.message).toMatch(/temporarily unavailable/i);
    expect(body).not.toMatch(/circuit|half.?open|threshold|consecutive/i);
    expect(body).not.toContain(FAKE_KEY);
  });

  it("is not opened by failures that are not transient", async () => {
    const orchestrator = buildOrchestrator(realAdapter(BREAKER(60_000)));
    script = [REPLY.contextLength, REPLY.contextLength, REPLY.contextLength, REPLY.success];

    for (const message of ["one", "two", "three"]) {
      await send(orchestrator, message);
    }
    const fourth = await send(orchestrator, "four");

    expect(fourth.data?.message).toBe("recovered");
    expect(upstreamCalls).toBe(4);
  });

  it("closes after a successful probe once the open duration has passed", async () => {
    const orchestrator = buildOrchestrator(realAdapter(BREAKER(50)));
    script = [REPLY.serverError(503), REPLY.serverError(503)];
    await send(orchestrator, "one");
    await send(orchestrator, "two");

    await pause(80);
    script = [completion("probe"), completion("after")];
    const probe = await send(orchestrator, "three");
    const after = await send(orchestrator, "four");

    expect(probe.data?.message).toBe("probe");
    expect(after.data?.message).toBe("after");
    expect(upstreamCalls).toBe(4);
  });

  it("reopens after a failed probe", async () => {
    const orchestrator = buildOrchestrator(realAdapter(BREAKER(50)));
    script = [REPLY.serverError(503), REPLY.serverError(503)];
    await send(orchestrator, "one");
    await send(orchestrator, "two");

    await pause(80);
    script = [REPLY.serverError(503), REPLY.success];
    const failedProbe = await send(orchestrator, "three");
    const refused = await send(orchestrator, "four");

    expect(failedProbe.error?.code).toBe("INTERNAL_ERROR");
    expect(refused.error?.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(upstreamCalls).toBe(3);
  });

  it("belongs to one adapter: another adapter, or a restarted process, is unaffected", async () => {
    const broken = buildOrchestrator(realAdapter(BREAKER(60_000)));
    script = [REPLY.serverError(503), REPLY.serverError(503)];
    await send(broken, "one");
    await send(broken, "two");
    expect((await send(broken, "three")).error?.code).toBe("AI_PROVIDER_UNAVAILABLE");

    const fresh = buildOrchestrator(realAdapter(BREAKER(60_000)));
    script = [REPLY.success];

    expect((await send(fresh, "hello")).data?.message).toBe("recovered");
  });

  it("logs its state changes with counts only", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const orchestrator = buildOrchestrator(realAdapter(BREAKER(60_000)));
    script = [REPLY.serverError(503), REPLY.serverError(503)];

    await send(orchestrator, "one");
    await send(orchestrator, "two");

    const circuitLines = lines.filter((line) => line.includes('"ai_provider_circuit"'));
    expect(circuitLines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: "ai_provider_circuit", provider: "openai", from: "closed", to: "open", consecutiveFailures: 2 }),
    ]);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
  });
});

/** POST /api/v1/chat through the real router; resolves when it answers. */
function postChat(router: ReturnType<typeof createChatRouter>, message: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { authorization: "Bearer test-token" };
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
    } as never;
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
    };
    const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => void }> } }> }).stack.find(
      (l) => l.route?.path === "/" && l.route.methods.post
    );
    const handlers = layer!.route!.stack.map((s) => s.handle);
    let index = 0;
    const next = () => {
      if (index < handlers.length) handlers[index++]!(req, res, next);
    };
    next();
  });
}
