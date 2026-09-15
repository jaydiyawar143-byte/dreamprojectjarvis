// ---------------------------------------------------------------------------
// R-31 — no provider text reaches the browser.
//
// A provider failure used to reach the chat response with the provider's own
// words as `error.message` — "The server is overloaded", "The model
// `gpt-unknown` does not exist", a rate limit naming the organisation and the
// model — and with whatever `details.cause` held, serialised as-is.
//
// Real OpenAIAdapter and SDK, real ConversationalAssistant, Orchestrator and
// chat route. The upstream is a local HTTP server scripted one reply per
// request, as in agent-recovery-after-provider-failure.test.ts, so every
// failure is the one the SDK really throws.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AICompletionResponse, AuditLogger, Conversation, ConversationMessage, IAIProvider } from "@jarvis/core";
import { FallbackAIProvider, JarvisError } from "@jarvis/core";
import { Orchestrator, AgentRegistry, ConversationalAssistant } from "@jarvis/agents";
import { OpenAIAdapter } from "@jarvis/ai-openai";
import { createChatRouter } from "../src/routes/chat.js";

const FAKE_KEY = "sk-test-r31-not-a-real-key";
const INTERNAL_URL = "https://internal-gateway.example/v1";

/** Nothing the browser receives may contain any of these. */
const LEAKS = [
  FAKE_KEY,
  "Incorrect API key",
  "internal-gateway",
  "openai.com",
  "org-r31secret",
  "proj_r31secret",
  "gpt-r31-secret",
  "req_r31_trace",
  "temperature",
  "overloaded",
  "Request timed out",
  "Unexpected token",
  "Cannot read properties",
  "/srv/jarvis",
  "    at ",
];

type Reply = (res: ServerResponse) => void;

/** Requests a `hang` reply left open, released after each test. */
const hanging: ServerResponse[] = [];

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Reply =>
  (res) => {
    res.writeHead(status, { "content-type": "application/json", connection: "close", ...headers });
    res.end(JSON.stringify(body));
  };

const completion = (content: string): Reply =>
  json(200, {
    id: "chatcmpl-r31",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const REPLY = {
  invalidRequest: json(
    400,
    {
      error: {
        message: `Invalid value for 'temperature' on gpt-r31-secret (key ${FAKE_KEY}): see https://platform.openai.com/docs`,
        type: "invalid_request_error",
        param: "temperature",
        code: "integer_above_max_value",
      },
    },
    { "x-request-id": "req_r31_trace" }
  ),
  unknownModel: json(404, {
    error: {
      message: "The model `gpt-r31-secret` does not exist or you do not have access to it.",
      type: "invalid_request_error",
      code: "model_not_found",
    },
  }),
  noAccess: json(403, {
    error: { message: "Project `proj_r31secret` does not have access to model `gpt-r31-secret`", type: "permission_error" },
  }),
  invalidKey: json(401, {
    error: {
      message: `Incorrect API key provided: ${FAKE_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`,
      type: "invalid_request_error",
      code: "invalid_api_key",
    },
  }),
  rateLimit: json(429, {
    error: {
      message: "Rate limit reached for gpt-r31-secret in organization org-r31secret on tokens per min (TPM).",
      type: "tokens",
      code: "rate_limit_exceeded",
    },
  }),
  /** Never answers, so the adapter's own timeout ends the request. */
  hang: ((res) => {
    hanging.push(res);
  }) as Reply,
  overloaded: json(503, {
    error: { message: `The server is overloaded. Upstream ${INTERNAL_URL} failed.`, type: "server_error" },
  }),
  /** Declares JSON and sends a proxy's HTML page: the SDK's parse fails. */
  unparseable: ((res) => {
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end("<html><body>proxy error in /srv/jarvis/node_modules/openai</body></html>");
  }) as Reply,
  /** Parses, but has no `choices`: the adapter's conversion fails. */
  empty: json(200, {}),
};

let server: Server;
let baseURL: string;
let script: Reply[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The real adapter against the fake upstream, retries off. */
function realAdapter(): OpenAIAdapter {
  vi.stubEnv("OPENAI_BASE_URL", baseURL);
  return new OpenAIAdapter({ apiKey: FAKE_KEY, timeoutMs: 300, maxRetries: 0 });
}

function throwingProvider(failure: unknown): IAIProvider {
  return {
    id: "throwing",
    name: "Throwing provider",
    defaultModel: "throwing-model",
    async complete(): Promise<AICompletionResponse> {
      throw failure;
    },
    async listModels() {
      return [];
    },
    async isAvailable() {
      return true;
    },
  };
}

function chatRouter(provider: IAIProvider) {
  const registry = new AgentRegistry();
  registry.register(new ConversationalAssistant({ provider, systemPrompt: "You are JARVIS." }));
  const auditLogger = { log: async () => {}, query: async () => [] } as unknown as AuditLogger;
  const executor = {
    execute: async () => {
      throw new Error("no tool may run in this test");
    },
  };
  const messages: ConversationMessage[] = [];
  const conversationRepo = {
    create: async (input: { userId: string }): Promise<Conversation> => ({
      id: "conv-r31",
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
  return createChatRouter({
    tokenService: { verifyAccessToken: () => ({ userId: "user-r31", role: "member", email: "r31@example.com" }) },
    orchestrator: new Orchestrator(registry, executor as never, auditLogger, {}),
    conversationRepo,
    auditLogger,
  } as never);
}

interface ChatBody {
  success: boolean;
  data?: { message: string };
  error?: { code: string; message: string; details?: unknown };
}

/** One chat message through the real router: the status, the body, and the body as the browser receives it. */
async function chat(provider: IAIProvider): Promise<{ status: number; body: ChatBody; text: string }> {
  const { status, body } = await postChat(chatRouter(provider), "Hello JARVIS");
  return { status, body: body as ChatBody, text: JSON.stringify(body) };
}

describe("R-31 — what the browser receives when OpenAI fails", () => {
  it.each([
    ["an invalid request (400)", REPLY.invalidRequest, 400, "INVALID_REQUEST", /could not process this request/i],
    ["an unknown model (404)", REPLY.unknownModel, 400, "INVALID_REQUEST", /administrator/i],
    ["no access to the model (403)", REPLY.noAccess, 403, "AUTHORIZATION_FAILED", /administrator/i],
    ["a rejected key (401)", REPLY.invalidKey, 503, "AI_PROVIDER_AUTH_FAILED", /administrator/i],
    ["a rate limit (429)", REPLY.rateLimit, 429, "RATE_LIMITED", /too many requests/i],
    ["a timeout", REPLY.hang, 500, "INTERNAL_ERROR", /took too long/i],
    ["an overloaded server (503)", REPLY.overloaded, 500, "INTERNAL_ERROR", /temporarily unavailable/i],
    ["a response the SDK cannot parse", REPLY.unparseable, 500, "INTERNAL_ERROR", /something went wrong/i],
    ["a 200 with no choices", REPLY.empty, 500, "INTERNAL_ERROR", /internal processing error/i],
  ])("%s: a fixed message and nothing of the provider's", async (_label, reply, status, code, message) => {
    script = [reply];

    const response = await chat(realAdapter());

    expect(response.status).toBe(status);
    expect(response.body.error?.code).toBe(code);
    expect(response.body.error?.message).toMatch(message);
    for (const leak of LEAKS) {
      expect(response.text).not.toContain(leak);
    }
  });

  it("inside the provider chain, as the container wires it, a rejected request carries only the fixed message", async () => {
    script = [REPLY.invalidRequest];

    const response = await chat(new FallbackAIProvider([realAdapter()]));

    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe("INVALID_REQUEST");
    expect(response.body.error?.message).toMatch(/could not process this request/i);
    for (const leak of LEAKS) {
      expect(response.text).not.toContain(leak);
    }
  });
});

describe("R-31 — details.cause is sanitised before the response is sent", () => {
  it.each([
    ["provider text", `model gpt-r31-secret rejected at ${INTERNAL_URL} with ${FAKE_KEY}`],
    ["an object", { status: 401, body: `Incorrect API key provided: ${FAKE_KEY}` }],
  ])("a cause that is %s is dropped", async (_label, cause) => {
    const failure = new JarvisError("AI_PROVIDER_UNAVAILABLE", "The AI provider is temporarily unavailable.", {
      transient: true,
      cause,
    });

    const response = await chat(throwingProvider(failure));

    expect(response.status).toBe(503);
    expect(response.body.error?.details).toEqual({ transient: true });
    for (const leak of LEAKS) {
      expect(response.text).not.toContain(leak);
    }
  });
});

describe("R-31 — R-30's AI_PROVIDER_UNAVAILABLE response is unchanged", () => {
  it("answers 503 with the fixed recovery message and the cause code", async () => {
    script = [REPLY.invalidKey];

    const response = await chat(new FallbackAIProvider([realAdapter()]));

    expect(response.status).toBe(503);
    expect(response.body.error).toEqual({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: expect.stringMatching(/temporarily unavailable/i),
      details: { transient: true, cause: "AI_PROVIDER_AUTH_FAILED" },
    });
  });
});

describe("R-31 — the server log keeps what the response leaves out", () => {
  it("logs the provider's status, type, code, request id and redacted text, and never the key", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    script = [REPLY.invalidRequest];

    const response = await chat(realAdapter());

    const records = lines.filter((line) => line.includes('"ai_provider_error"')).map((line) => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({
        level: "warn",
        event: "ai_provider_error",
        provider: "openai",
        code: "INVALID_REQUEST",
        transient: false,
        status: 400,
        type: "invalid_request_error",
        providerCode: "integer_above_max_value",
        providerRequestId: "req_r31_trace",
        message: expect.stringContaining("temperature"),
      }),
    ]);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
    expect(response.text).not.toContain("req_r31_trace");
  });
});

describe("R-31 — a successful reply is unchanged", () => {
  it("returns the model's text exactly, even when it reads like an error", async () => {
    const content =
      "A bad request means: see https://platform.openai.com/docs and check the api_key: setting. Trace at handler (server.js)";
    script = [completion(content)];

    const response = await chat(realAdapter());

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data?.message).toBe(content);
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
