// ---------------------------------------------------------------------------
// R-28 — Anthropic failures under the same contract as OpenAI.
//
//   transient (details.transient)   timeout, dropped connection, 429, 5xx, 529
//   CONTEXT_LENGTH_EXCEEDED         the prompt is too long for the model
//   AI_PROVIDER_AUTH_FAILED         the server's key was rejected
//   aborted (details.aborted)       the caller cancelled
//   INVALID_REQUEST / AUTHORIZATION_FAILED / INTERNAL_ERROR otherwise
//
// The adapter is NOT wired into the runtime (decision D-3 is open), so this is
// adapter-level coverage only. The agent lifecycle that consumes these codes is
// covered in packages/agents against the same contract.
//
// Every failure is built with the SDK's own classes. Note the shape: the SDK
// keeps the whole response body on `error`, so the provider's type and message
// sit one level deeper, at `error.error`.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";

import { executeWithRetry, toJarvisError } from "../src/error-handler.js";

const FAKE_KEY = "sk-ant-test-r28-not-a-real-key";

/** An HTTP failure exactly as the SDK constructs one from a response. */
function httpFailure(status: number, type: string, message: string, headers: Record<string, string> = {}) {
  return APIError.generate(status, { type: "error", error: { type, message } }, undefined, headers);
}

describe("R-28 — transient Anthropic failures", () => {
  it.each([
    ["a request timeout", new APIConnectionTimeoutError(), "INTERNAL_ERROR"],
    ["a dropped connection", new APIConnectionError({}), "INTERNAL_ERROR"],
    ["a rate limit (429)", httpFailure(429, "rate_limit_error", "Number of request tokens has exceeded your rate limit"), "RATE_LIMITED"],
    ["an API error (500)", httpFailure(500, "api_error", "Internal server error"), "INTERNAL_ERROR"],
    ["a 503", httpFailure(503, "api_error", "Service unavailable"), "INTERNAL_ERROR"],
    ["an overload (529)", httpFailure(529, "overloaded_error", "Overloaded"), "INTERNAL_ERROR"],
  ])("%s is transient", (_label, failure, code) => {
    const error = toJarvisError(failure);

    expect(error.code).toBe(code);
    expect(error.details).toEqual({ transient: true });
  });
});

describe("R-28 — permanent Anthropic failures", () => {
  it.each([
    ["a key without permission (403)", httpFailure(403, "permission_error", "Your API key does not have permission"), "AUTHORIZATION_FAILED"],
    ["an invalid request (400)", httpFailure(400, "invalid_request_error", "max_tokens: Field required"), "INVALID_REQUEST"],
    ["a programming error", new TypeError("Cannot read properties of undefined"), "INTERNAL_ERROR"],
  ])("%s is not transient", (_label, failure, code) => {
    const error = toJarvisError(failure);

    expect(error.code).toBe(code);
    expect(error.details).toBeUndefined();
  });

  it("a rejected key (401) is the server's configuration failure, 503 and never the user's 401", () => {
    const error = toJarvisError(httpFailure(401, "authentication_error", `invalid x-api-key ${FAKE_KEY}`));

    expect(error.code).toBe("AI_PROVIDER_AUTH_FAILED");
    expect(error.statusCode).toBe(503);
    expect(error.details).toBeUndefined();
    expect(error.message).toMatch(/administrator/i);
    expect(error.message).not.toContain(FAKE_KEY);
    expect(error.message).not.toContain("x-api-key");
  });
});

describe("R-30 — an unknown Anthropic model", () => {
  it("is INVALID_REQUEST, marked with scope provider so the chain can fall back", () => {
    const error = toJarvisError(httpFailure(404, "not_found_error", "model: claude-unknown"));

    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.details).toEqual({ scope: "provider" });
  });
});

describe("R-28 — an exceeded context window", () => {
  it.each([
    ["a prompt over the limit", "prompt is too long: 208310 tokens > 200000 maximum"],
    [
      "input and max_tokens over the limit",
      "input length and `max_tokens` exceed context limit: 197000 + 21333 > 200000, decrease input length or `max_tokens` and try again",
    ],
  ])("is recognised for %s", (_label, message) => {
    const error = toJarvisError(httpFailure(400, "invalid_request_error", message));

    expect(error.code).toBe("CONTEXT_LENGTH_EXCEEDED");
    expect(error.statusCode).toBe(413);
    expect(error.details).toBeUndefined();
    expect(error.message).not.toContain("200000");
  });
});

describe("R-28 — a cancelled request", () => {
  it("is marked aborted, not transient", () => {
    expect(toJarvisError(new APIUserAbortError()).details).toEqual({ aborted: true });
  });
});

describe("R-28 — the shared retry policy", () => {
  const options = { policy: { baseDelayMs: 100, maxDelayMs: 1000, maxJitterMs: 0, maxElapsedMs: 60_000 }, random: () => 0, sleep: async () => {} };

  function scripted(failures: unknown[]) {
    let calls = 0;
    return {
      call: async () => {
        const failure = failures[calls];
        calls++;
        if (failure !== undefined) throw failure;
        return "ok";
      },
      calls: () => calls,
    };
  }

  it("retries an overload and returns the result", async () => {
    const sdk = scripted([httpFailure(529, "overloaded_error", "Overloaded")]);

    await expect(executeWithRetry(sdk.call, 2, undefined, options)).resolves.toBe("ok");
    expect(sdk.calls()).toBe(2);
  });

  it.each([
    ["a rejected key", httpFailure(401, "authentication_error", "invalid x-api-key"), "AI_PROVIDER_AUTH_FAILED"],
    ["an exceeded context window", httpFailure(400, "invalid_request_error", "prompt is too long: 208310 tokens > 200000 maximum"), "CONTEXT_LENGTH_EXCEEDED"],
  ])("does not retry %s", async (_label, failure, code) => {
    const sdk = scripted([failure, failure, failure]);

    await expect(executeWithRetry(sdk.call, 2, undefined, options)).rejects.toMatchObject({ code });
    expect(sdk.calls()).toBe(1);
  });
});
