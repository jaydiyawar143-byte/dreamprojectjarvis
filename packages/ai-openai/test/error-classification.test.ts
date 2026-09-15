// ---------------------------------------------------------------------------
// R-24, R-25, R-29 — how an OpenAI failure becomes a JarvisError.
//
// `toJarvisError` is the single point where an SDK failure becomes a
// JarvisError, and the agent that saw the failure decides from the result
// whether it can serve the next request:
//
//   transient (details.transient)   timeout, dropped connection, 429, 5xx
//   CONTEXT_LENGTH_EXCEEDED         this conversation is too long (R-25)
//   AI_PROVIDER_AUTH_FAILED         the server's key was rejected (R-29)
//   aborted (details.aborted)       the caller cancelled
//   everything else                 unchanged
//
// Every case uses the SDK's own error classes, built the way the SDK builds
// them, so the shapes here are the shapes production sees.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";

import { toJarvisError } from "../src/error-handler.js";

const FAKE_KEY = "sk-test-r24-not-a-real-key";

/** An HTTP failure exactly as the SDK constructs one from a response. */
function httpFailure(status: number, error: Record<string, unknown>) {
  return APIError.generate(status, { error }, undefined, {});
}

const CONTEXT_LENGTH_BODY = {
  message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.",
  type: "invalid_request_error",
  param: "messages",
  code: "context_length_exceeded",
};

describe("R-24 — transient provider failures are marked transient", () => {
  it.each([
    ["a request timeout", new APIConnectionTimeoutError(), "INTERNAL_ERROR"],
    ["a dropped connection", new APIConnectionError({}), "INTERNAL_ERROR"],
    [
      "a rate limit (429)",
      httpFailure(429, { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" }),
      "RATE_LIMITED",
    ],
    ["a 500", httpFailure(500, { message: "The server had an error", type: "server_error" }), "INTERNAL_ERROR"],
    ["a 502", httpFailure(502, { message: "Bad gateway" }), "INTERNAL_ERROR"],
    ["a 503", httpFailure(503, { message: "The server is overloaded", type: "server_error" }), "INTERNAL_ERROR"],
    ["a 504", httpFailure(504, { message: "Gateway timeout" }), "INTERNAL_ERROR"],
  ])("%s", (_label, failure, code) => {
    const error = toJarvisError(failure);

    expect(error.code).toBe(code);
    expect(error.details).toEqual({ transient: true });
  });
});

describe("R-24 — permanent and unexpected failures are not", () => {
  it.each([
    [
      "a key without access (403)",
      httpFailure(403, { message: "Project does not have access", type: "permission_error" }),
      "AUTHORIZATION_FAILED",
    ],
    [
      "an unknown model (404)",
      httpFailure(404, {
        message: "The model `gpt-unknown` does not exist",
        type: "invalid_request_error",
        code: "model_not_found",
      }),
      "INVALID_REQUEST",
    ],
    [
      "a rejected request (400)",
      httpFailure(400, { message: "Invalid value for 'temperature'", type: "invalid_request_error" }),
      "INVALID_REQUEST",
    ],
    [
      "a single message over the length limit (400), which is not the context window",
      httpFailure(400, {
        message: "Invalid 'messages[1].content': string too long. Expected a string with maximum length 10485760.",
        type: "invalid_request_error",
        code: "string_above_max_length",
      }),
      "INVALID_REQUEST",
    ],
    ["a programming error", new TypeError("Cannot read properties of undefined"), "INTERNAL_ERROR"],
  ])("%s", (_label, failure, code) => {
    const error = toJarvisError(failure);

    expect(error.code).toBe(code);
    expect(error.details).toBeUndefined();
  });
});

describe("R-25 — an exceeded context window", () => {
  it.each([
    ["the error code", httpFailure(400, CONTEXT_LENGTH_BODY)],
    [
      "the message, when no code is sent",
      httpFailure(400, {
        message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.",
        type: "invalid_request_error",
      }),
    ],
  ])("is recognised by %s", (_label, failure) => {
    const error = toJarvisError(failure);

    expect(error.code).toBe("CONTEXT_LENGTH_EXCEEDED");
    expect(error.statusCode).toBe(413);
    expect(error.details).toBeUndefined();
  });

  it("answers with a safe message of its own, not the provider's text", () => {
    const { message } = toJarvisError(httpFailure(400, CONTEXT_LENGTH_BODY));

    expect(message).toMatch(/too long/i);
    expect(message).toMatch(/new conversation/i);
    expect(message).not.toContain("128000");
    expect(message).not.toContain("tokens");
  });
});

describe("R-29 — the provider rejects the server's API key", () => {
  const invalidKey = () =>
    httpFailure(401, {
      message: `Incorrect API key provided: ${FAKE_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`,
      type: "invalid_request_error",
      code: "invalid_api_key",
    });

  it("is a server configuration failure, answered as 503 and never as the user's 401", () => {
    const error = toJarvisError(invalidKey());

    expect(error.code).toBe("AI_PROVIDER_AUTH_FAILED");
    expect(error.statusCode).toBe(503);
    expect(error.details).toBeUndefined();
  });

  it("tells the user an administrator must fix it, without the key or the provider's text", () => {
    const { message } = toJarvisError(invalidKey());

    expect(message).toMatch(/administrator/i);
    expect(message).not.toContain(FAKE_KEY);
    expect(message).not.toContain("Incorrect API key");
    expect(message).not.toContain("platform.openai.com");
  });
});

describe("R-26 — a cancelled request", () => {
  it("is marked aborted, not transient", () => {
    const error = toJarvisError(new APIUserAbortError());

    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.details).toEqual({ aborted: true });
  });
});
