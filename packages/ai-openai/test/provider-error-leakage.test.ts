// ---------------------------------------------------------------------------
// R-31 — an OpenAI failure's message never carries the provider's text.
//
// Before R-31, every classified failure except a rejected key and an exceeded
// context window used the provider's own wording as its message. Keys and
// bearer tokens were redacted; model names, organisation and project ids,
// URLs and the SDK's own parse errors were not. The message is what the
// browser shows.
//
// Now the message is fixed for each category, and the provider's account of
// the failure travels on the error as a diagnostic only the server can read.
// Codes and details are unchanged; error-classification.test.ts pins those.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { PROVIDER_ERROR_MESSAGES, getProviderDiagnostic } from "@jarvis/core";

import { toJarvisError } from "../src/error-handler.js";

const FAKE_KEY = "sk-test-r31-not-a-real-key";

/** An HTTP failure exactly as the SDK constructs one from a response. */
function httpFailure(status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) {
  return APIError.generate(status, { error }, undefined, headers);
}

const INVALID_TEMPERATURE = {
  message: "Invalid value for 'temperature' on gpt-r31-secret: see https://platform.openai.com/docs",
  type: "invalid_request_error",
  param: "temperature",
  code: "integer_above_max_value",
};

/** A programming error whose message and stack point into the server's files. */
function programmingError(): TypeError {
  const error = new TypeError("Cannot read properties of undefined (reading 'choices')");
  error.stack =
    "TypeError: Cannot read properties of undefined (reading 'choices')\n" +
    "    at convertResponse (/srv/jarvis/packages/ai-openai/dist/message-converter.js:41:7)";
  return error;
}

describe("R-31 — the message is fixed for each category", () => {
  it.each([
    [
      "an invalid request (400)",
      httpFailure(400, INVALID_TEMPERATURE),
      "INVALID_REQUEST",
      PROVIDER_ERROR_MESSAGES.invalidRequest,
      ["temperature", "gpt-r31-secret", "platform.openai.com"],
    ],
    [
      "an unknown model (404)",
      httpFailure(404, {
        message: "The model `gpt-r31-secret` does not exist or you do not have access to it.",
        type: "invalid_request_error",
        code: "model_not_found",
      }),
      "INVALID_REQUEST",
      PROVIDER_ERROR_MESSAGES.modelUnavailable,
      ["gpt-r31-secret"],
    ],
    [
      "no access to the model (403)",
      httpFailure(403, {
        message: "Project `proj_r31secret` does not have access to model `gpt-r31-secret`",
        type: "permission_error",
      }),
      "AUTHORIZATION_FAILED",
      PROVIDER_ERROR_MESSAGES.accessDenied,
      ["proj_r31secret", "gpt-r31-secret"],
    ],
    [
      "a rate limit (429)",
      httpFailure(429, {
        message: "Rate limit reached for gpt-r31-secret in organization org-r31secret on tokens per min (TPM): Limit 30000, Used 29000.",
        type: "tokens",
        code: "rate_limit_exceeded",
      }),
      "RATE_LIMITED",
      PROVIDER_ERROR_MESSAGES.rateLimited,
      ["org-r31secret", "gpt-r31-secret", "30000"],
    ],
    [
      "a timeout",
      new APIConnectionTimeoutError(),
      "INTERNAL_ERROR",
      PROVIDER_ERROR_MESSAGES.timeout,
      ["Request timed out"],
    ],
    [
      "a request timeout status (408)",
      httpFailure(408, { message: "upstream timed out at https://internal-gateway.example/v1" }),
      "INTERNAL_ERROR",
      PROVIDER_ERROR_MESSAGES.timeout,
      ["internal-gateway"],
    ],
    [
      "an overloaded server (503)",
      httpFailure(503, { message: "The server is overloaded", type: "server_error" }),
      "INTERNAL_ERROR",
      PROVIDER_ERROR_MESSAGES.unavailable,
      ["overloaded"],
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
  it("keeps the status, type, code, request id and the provider's text for the log", () => {
    const error = toJarvisError(httpFailure(400, INVALID_TEMPERATURE, { "x-request-id": "req_r31_openai" }));

    expect(getProviderDiagnostic(error)).toEqual({
      status: 400,
      type: "invalid_request_error",
      providerCode: "integer_above_max_value",
      providerRequestId: "req_r31_openai",
      message: expect.stringContaining("temperature"),
    });
  });

  it("never keeps the key, not even there", () => {
    const error = toJarvisError(
      httpFailure(401, {
        message: `Incorrect API key provided: ${FAKE_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`,
        type: "invalid_request_error",
        code: "invalid_api_key",
      })
    );

    expect(getProviderDiagnostic(error)?.providerCode).toBe("invalid_api_key");
    expect(JSON.stringify(getProviderDiagnostic(error))).not.toContain(FAKE_KEY);
    expect(error.message).not.toContain(FAKE_KEY);
    expect(error.message).not.toContain("platform.openai.com");
  });

  it("is not part of anything the error serialises to", () => {
    const error = toJarvisError(httpFailure(400, INVALID_TEMPERATURE));

    expect(JSON.stringify(error)).not.toContain("temperature");
    expect(JSON.stringify({ code: error.code, message: error.message, details: error.details })).not.toContain(
      "temperature"
    );
  });

  it("names the error class of a failure that is not an HTTP response", () => {
    expect(getProviderDiagnostic(toJarvisError(programmingError()))).toMatchObject({ type: "TypeError" });
  });
});
