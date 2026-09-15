// ---------------------------------------------------------------------------
// R-26 — which OpenAI failures the adapter retries, and how.
//
// `executeWithRetry` wraps a single SDK call. It retries transient failures
// only — a timeout, a dropped connection, 429 and 5xx — with bounded backoff
// from the shared policy in @jarvis/core, and ends with ONE JarvisError.
// Failures that would fail again unchanged (an invalid key, model or request,
// an exceeded context window) are never retried.
//
// Real SDK error classes; an injected sleep, so no test waits on a backoff.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";

import { executeWithRetry } from "../src/error-handler.js";

function httpFailure(status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) {
  return APIError.generate(status, { error }, undefined, headers);
}

const POLICY = { baseDelayMs: 100, maxDelayMs: 1000, maxJitterMs: 0, maxElapsedMs: 60_000 };

function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    options: {
      policy: POLICY,
      random: () => 0,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    },
  };
}

/** An SDK call that throws the given failures in order, then succeeds. */
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

const TRANSIENT: Array<[string, () => unknown]> = [
  ["a rate limit (429)", () => httpFailure(429, { message: "Rate limit reached", type: "requests" })],
  ["a 500", () => httpFailure(500, { message: "The server had an error", type: "server_error" })],
  ["a 502", () => httpFailure(502, { message: "Bad gateway" })],
  ["a 503", () => httpFailure(503, { message: "The server is overloaded", type: "server_error" })],
  ["a 504", () => httpFailure(504, { message: "Gateway timeout" })],
  ["a timeout", () => new APIConnectionTimeoutError()],
  ["a dropped connection", () => new APIConnectionError({})],
];

describe("R-26 — transient failures are retried", () => {
  it.each(TRANSIENT)("retries %s and returns the result", async (_label, makeFailure) => {
    const time = fakeSleep();
    const sdk = scripted([makeFailure()]);

    await expect(executeWithRetry(sdk.call, 2, undefined, time.options)).resolves.toBe("ok");
    expect(sdk.calls()).toBe(2);
    expect(time.delays).toEqual([100]);
  });

  it("backs off exponentially", async () => {
    const time = fakeSleep();
    const failures = [1, 2, 3].map(() => httpFailure(503, { message: "overloaded" }));

    await executeWithRetry(scripted(failures).call, 3, undefined, time.options);

    expect(time.delays).toEqual([100, 200, 400]);
  });

  it("gives up after maxRetries with one controlled, transient JarvisError", async () => {
    const time = fakeSleep();
    const sdk = scripted([1, 2, 3].map(() => httpFailure(503, { message: "overloaded" })));

    await expect(executeWithRetry(sdk.call, 2, undefined, time.options)).rejects.toMatchObject({
      name: "JarvisError",
      code: "INTERNAL_ERROR",
      details: { transient: true },
    });
    expect(sdk.calls()).toBe(3);
  });

  it("waits as long as Retry-After asks, capped at the maximum delay", async () => {
    const time = fakeSleep();
    const sdk = scripted([
      httpFailure(429, { message: "Rate limit reached" }, { "retry-after": "0.5" }),
      httpFailure(429, { message: "Rate limit reached" }, { "retry-after": "120" }),
    ]);

    await executeWithRetry(sdk.call, 2, undefined, time.options);

    expect(time.delays).toEqual([500, 1000]);
  });
});

describe("R-26 — failures that would fail again are not retried", () => {
  it.each([
    [
      "an invalid API key",
      httpFailure(401, { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" }),
      "AI_PROVIDER_AUTH_FAILED",
    ],
    [
      "an unknown model",
      httpFailure(404, { message: "The model does not exist", type: "invalid_request_error", code: "model_not_found" }),
      "INVALID_REQUEST",
    ],
    [
      "an invalid request",
      httpFailure(400, { message: "Invalid value for 'temperature'", type: "invalid_request_error" }),
      "INVALID_REQUEST",
    ],
    [
      "an exceeded context window",
      httpFailure(400, {
        message: "This model's maximum context length is 8192 tokens.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      }),
      "CONTEXT_LENGTH_EXCEEDED",
    ],
  ])("does not retry %s", async (_label, failure, code) => {
    const time = fakeSleep();
    const sdk = scripted([failure, failure, failure]);

    await expect(executeWithRetry(sdk.call, 3, undefined, time.options)).rejects.toMatchObject({ code });
    expect(sdk.calls()).toBe(1);
    expect(time.delays).toEqual([]);
  });
});

describe("R-26 — cancellation", () => {
  it("an abort during the backoff stops the retries", async () => {
    const controller = new AbortController();
    const sdk = scripted([1, 2, 3].map(() => httpFailure(503, { message: "overloaded" })));

    // The real sleep, with a wait far longer than the test: only the abort ends it.
    const pending = executeWithRetry(sdk.call, 3, controller.signal, {
      policy: { baseDelayMs: 60_000, maxDelayMs: 60_000, maxJitterMs: 0, maxElapsedMs: 120_000 },
    });
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toMatchObject({ code: "INTERNAL_ERROR", details: { aborted: true } });
    expect(sdk.calls()).toBe(1);
  });

  it("an already-aborted signal makes no call at all", async () => {
    const controller = new AbortController();
    controller.abort();
    const sdk = scripted([]);

    await expect(executeWithRetry(sdk.call, 3, controller.signal, fakeSleep().options)).rejects.toMatchObject({
      details: { aborted: true },
    });
    expect(sdk.calls()).toBe(0);
  });
});
