// ---------------------------------------------------------------------------
// R-31 — an Anthropic failure's message never carries the provider's text.
//
// The same contract as @jarvis/ai-openai: a fixed message for each category,
// and the provider's account of the failure kept as a server-side diagnostic
// that the adapter logs. The adapter is not wired into the runtime (D-3), so
// this is its only coverage — including one real ClaudeAdapter, with the real
// SDK, against a local upstream it reaches through ANTHROPIC_BASE_URL.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { PROVIDER_ERROR_MESSAGES, getProviderDiagnostic } from "@jarvis/core";

import { toJarvisError } from "../src/error-handler.js";
import { ClaudeAdapter } from "../src/claude-adapter.js";

const FAKE_KEY = "sk-ant-test-r31-not-a-real-key";

/** An HTTP failure exactly as the SDK constructs one from a response. */
function httpFailure(status: number, type: string, message: string, headers: Record<string, string> = {}) {
  return APIError.generate(status, { type: "error", error: { type, message } }, undefined, headers);
}

/** A programming error whose message and stack point into the server's files. */
function programmingError(): TypeError {
  const error = new TypeError("Cannot read properties of undefined (reading 'content')");
  error.stack =
    "TypeError: Cannot read properties of undefined (reading 'content')\n" +
    "    at convertResponse (/srv/jarvis/packages/ai-anthropic/dist/message-converter.js:52:9)";
  return error;
}

describe("R-31 — the message is fixed for each category", () => {
  it.each([
    [
      "an invalid request (400)",
      httpFailure(400, "invalid_request_error", "max_tokens: 999999 > 8192, which is the maximum allowed for claude-r31-secret"),
      "INVALID_REQUEST",
      PROVIDER_ERROR_MESSAGES.invalidRequest,
      ["max_tokens", "claude-r31-secret"],
    ],
    [
      "an unknown model (404)",
      httpFailure(404, "not_found_error", "model: claude-r31-secret"),
      "INVALID_REQUEST",
      PROVIDER_ERROR_MESSAGES.modelUnavailable,
      ["claude-r31-secret"],
    ],
    [
      "no permission (403)",
      httpFailure(403, "permission_error", "Your API key does not have permission to use the specified resource in workspace wrkspc_r31secret"),
      "AUTHORIZATION_FAILED",
      PROVIDER_ERROR_MESSAGES.accessDenied,
      ["wrkspc_r31secret", "API key"],
    ],
    [
      "a rate limit (429)",
      httpFailure(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit for organization org-r31secret"),
      "RATE_LIMITED",
      PROVIDER_ERROR_MESSAGES.rateLimited,
      ["org-r31secret", "per-minute"],
    ],
    [
      "a timeout",
      new APIConnectionTimeoutError(),
      "INTERNAL_ERROR",
      PROVIDER_ERROR_MESSAGES.timeout,
      ["Request timed out"],
    ],
    [
      "an overload (529)",
      httpFailure(529, "overloaded_error", "Overloaded"),
      "INTERNAL_ERROR",
      PROVIDER_ERROR_MESSAGES.unavailable,
      ["Overloaded"],
    ],
    [
      "a dropped connection",
      new APIConnectionError({ message: "Connection error. connect ECONNREFUSED 10.20.30.40:443" }),
      "INTERNAL_ERROR",
      PROVIDER_ERROR_MESSAGES.unavailable,
      ["ECONNREFUSED", "10.20.30.40"],
    ],
    [
      "a response the SDK cannot parse",
      new SyntaxError(`Unexpected token '<', "<html><bod"... is not valid JSON`),
      "INTERNAL_ERROR",
      PROVIDER_ERROR_MESSAGES.unknown,
      ["Unexpected token", "<html>"],
    ],
    [
      "an unknown error with a stack trace",
      programmingError(),
      "INTERNAL_ERROR",
      PROVIDER_ERROR_MESSAGES.unknown,
      ["Cannot read properties", "/srv/jarvis", "convertResponse"],
    ],
  ])("%s", (_label, failure, code, message, leaks) => {
    const error = toJarvisError(failure);

    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    for (const leak of leaks) {
      expect(error.message).not.toContain(leak);
    }
  });
});

describe("R-31 — the provider's account stays on the server", () => {
  it("keeps the status, type, request id and the provider's text for the log", () => {
    const error = toJarvisError(
      httpFailure(400, "invalid_request_error", "max_tokens: Field required", { "request-id": "req_r31_anthropic" })
    );

    expect(getProviderDiagnostic(error)).toEqual({
      status: 400,
      type: "invalid_request_error",
      providerRequestId: "req_r31_anthropic",
      message: expect.stringContaining("max_tokens"),
    });
  });

  it("never keeps the key, not even there", () => {
    const error = toJarvisError(httpFailure(401, "authentication_error", `invalid x-api-key ${FAKE_KEY}`));

    expect(error.code).toBe("AI_PROVIDER_AUTH_FAILED");
    expect(error.message).not.toContain(FAKE_KEY);
    expect(JSON.stringify(getProviderDiagnostic(error))).not.toContain(FAKE_KEY);
  });

  it("is not part of anything the error serialises to", () => {
    const error = toJarvisError(httpFailure(400, "invalid_request_error", "max_tokens: Field required"));

    expect(JSON.stringify(error)).not.toContain("max_tokens");
  });
});

describe("R-31 — a real ClaudeAdapter", () => {
  let server: Server;
  let reply: { status: number; body: unknown; headers?: Record<string, string> };

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(reply.status, { "content-type": "application/json", connection: "close", ...reply.headers });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function adapter(): ClaudeAdapter {
    vi.stubEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return new ClaudeAdapter({ apiKey: FAKE_KEY, maxRetries: 0, timeoutMs: 2000 });
  }

  it("rejects with the fixed message and logs the provider's account, without the key", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    reply = {
      status: 400,
      headers: { "request-id": "req_r31_anthropic" },
      body: {
        type: "error",
        error: { type: "invalid_request_error", message: `max_tokens too large for claude-r31-secret (key ${FAKE_KEY})` },
      },
    };

    const failure = await adapter()
      .complete({ messages: [{ role: "user", content: "Hello" }] })
      .catch((error: unknown) => error as { code?: string; message?: string });

    expect(failure).toMatchObject({ code: "INVALID_REQUEST", message: PROVIDER_ERROR_MESSAGES.invalidRequest });
    const records = lines.filter((line) => line.includes('"ai_provider_error"')).map((line) => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({
        level: "warn",
        event: "ai_provider_error",
        provider: "claude",
        code: "INVALID_REQUEST",
        transient: false,
        status: 400,
        type: "invalid_request_error",
        providerRequestId: "req_r31_anthropic",
        message: expect.stringContaining("claude-r31-secret"),
      }),
    ]);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
  });
});
