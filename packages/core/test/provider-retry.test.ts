// ---------------------------------------------------------------------------
// R-26 — the shared retry policy for model-provider calls.
//
// Provider adapters decide WHICH failures may be retried; this policy decides
// HOW: bounded exponential backoff with jitter, a cap on every wait (including
// one a provider asks for through Retry-After), a total time budget, and an
// abort that ends the waiting at once. Time is injected, so nothing here waits
// on a real backoff.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import {
  computeRetryDelayMs,
  parseRetryAfterMs,
  runWithRetry,
  RetryAbortedError,
  type RetryPolicy,
} from "../src/provider-retry.js";

const POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  maxJitterMs: 500,
  maxElapsedMs: 60_000,
};

/** A fake clock and sleep: every wait is recorded and advances the clock. */
function fakeTime(overrides: Partial<RetryPolicy> = {}) {
  const delays: number[] = [];
  let clock = 0;
  return {
    delays,
    advance: (ms: number) => {
      clock += ms;
    },
    options: {
      policy: { ...POLICY, ...overrides },
      sleep: async (ms: number) => {
        delays.push(ms);
        clock += ms;
      },
      now: () => clock,
      random: () => 0,
    },
  };
}

const RETRY = { retry: true } as const;
const NO_RETRY = { retry: false } as const;

describe("R-26 — computeRetryDelayMs", () => {
  it("doubles from the base delay", () => {
    expect([0, 1, 2].map((i) => computeRetryDelayMs(i, POLICY, { random: () => 0 }))).toEqual([
      1000, 2000, 4000,
    ]);
  });

  it("never waits longer than the maximum delay", () => {
    for (const retryIndex of [3, 4, 10, 50]) {
      expect(computeRetryDelayMs(retryIndex, POLICY, { random: () => 0.999999 })).toBeLessThanOrEqual(8000);
    }
    expect(computeRetryDelayMs(10, POLICY, { random: () => 0 })).toBe(8000);
  });

  it("adds jitter no larger than the configured maximum", () => {
    const jitter = computeRetryDelayMs(1, POLICY, { random: () => 0.999999 }) - 2000;

    expect(jitter).toBeGreaterThan(0);
    expect(jitter).toBeLessThanOrEqual(500);
  });

  it("waits as long as a provider's Retry-After asks", () => {
    expect(computeRetryDelayMs(0, POLICY, { random: () => 0.5, retryAfterMs: 3000 })).toBe(3000);
  });

  it("caps Retry-After at the maximum delay", () => {
    expect(computeRetryDelayMs(0, POLICY, { retryAfterMs: 600_000 })).toBe(8000);
  });
});

describe("R-26 — parseRetryAfterMs", () => {
  const NOW = Date.parse("2026-09-15T10:00:00Z");

  it.each([
    ["retry-after-ms", { "retry-after-ms": "1500" }, 1500],
    ["retry-after in seconds", { "retry-after": "2" }, 2000],
    ["fractional seconds", { "retry-after": "0.5" }, 500],
    ["an HTTP date", { "retry-after": new Date(NOW + 5000).toUTCString() }, 5000],
  ])("reads %s", (_label, headers, expected) => {
    expect(parseRetryAfterMs(headers, NOW)).toBe(expected);
  });

  it.each([
    ["an absent header", {}],
    ["absent headers", undefined],
    ["an unreadable value", { "retry-after": "soon" }],
    ["a date in the past", { "retry-after": new Date(NOW - 5000).toUTCString() }],
    ["a negative value", { "retry-after-ms": "-5" }],
  ])("ignores %s", (_label, headers) => {
    expect(parseRetryAfterMs(headers, NOW)).toBeUndefined();
  });

  it("reads a fetch Headers object", () => {
    expect(parseRetryAfterMs(new Headers({ "Retry-After": "3" }), NOW)).toBe(3000);
  });
});

describe("R-26 — runWithRetry", () => {
  it("retries a retryable failure and returns the eventual result", async () => {
    const time = fakeTime();
    let calls = 0;

    const result = await runWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("503");
        return "ok";
      },
      { ...time.options, shouldRetry: () => RETRY }
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(time.delays).toEqual([1000, 2000]);
  });

  it("does not retry a failure the classifier rejects", async () => {
    const time = fakeTime();
    const failure = new Error("401");
    let calls = 0;

    await expect(
      runWithRetry(
        async () => {
          calls++;
          throw failure;
        },
        { ...time.options, shouldRetry: () => NO_RETRY }
      )
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(time.delays).toEqual([]);
  });

  it("stops after maxRetries and rethrows only the last failure", async () => {
    const time = fakeTime({ maxRetries: 2 });
    let calls = 0;

    await expect(
      runWithRetry(
        async () => {
          calls++;
          throw new Error(`attempt ${calls}`);
        },
        { ...time.options, shouldRetry: () => RETRY }
      )
    ).rejects.toThrow("attempt 3");
    expect(calls).toBe(3);
  });

  it("starts no retry that would run past the total time budget", async () => {
    const time = fakeTime({ maxElapsedMs: 2500 });
    let calls = 0;

    await expect(
      runWithRetry(
        async () => {
          calls++;
          time.advance(1000); // each attempt takes a second
          throw new Error("timeout");
        },
        { ...time.options, shouldRetry: () => RETRY }
      )
    ).rejects.toThrow("timeout");
    // 1s attempt + 1s wait fits in 2.5s; a second 1s attempt + 2s wait does not.
    expect(calls).toBe(2);
    expect(time.delays).toEqual([1000]);
  });

  it("waits for Retry-After when the provider sends one, capped", async () => {
    const time = fakeTime();
    let calls = 0;

    await runWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error("short");
        if (calls === 2) throw new Error("long");
        return "ok";
      },
      {
        ...time.options,
        shouldRetry: (error) => ({
          retry: true,
          retryAfterMs: (error as Error).message === "short" ? 3000 : 600_000,
        }),
      }
    );

    expect(time.delays).toEqual([3000, 8000]);
  });

  it("makes no call when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    await expect(
      runWithRetry(
        async () => {
          calls++;
          return "ok";
        },
        { ...fakeTime().options, shouldRetry: () => RETRY, signal: controller.signal }
      )
    ).rejects.toBeInstanceOf(RetryAbortedError);
    expect(calls).toBe(0);
  });

  it("stops waiting, and never retries, once aborted during the backoff", async () => {
    const controller = new AbortController();
    let calls = 0;

    const pending = runWithRetry(
      async () => {
        calls++;
        throw new Error("503");
      },
      {
        // The real sleep, with a wait far longer than the test: only the abort
        // can end it.
        policy: { ...POLICY, baseDelayMs: 60_000, maxDelayMs: 60_000, maxJitterMs: 0, maxElapsedMs: 120_000 },
        shouldRetry: () => RETRY,
        signal: controller.signal,
      }
    );
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toBeInstanceOf(RetryAbortedError);
    expect(calls).toBe(1);
  });

  it("reports a failure caused by an abort as the abort, not as a retryable failure", async () => {
    const controller = new AbortController();
    const time = fakeTime();
    let calls = 0;

    await expect(
      runWithRetry(
        async () => {
          calls++;
          controller.abort();
          throw new Error("socket hang up");
        },
        { ...time.options, shouldRetry: () => RETRY, signal: controller.signal }
      )
    ).rejects.toBeInstanceOf(RetryAbortedError);
    expect(calls).toBe(1);
    expect(time.delays).toEqual([]);
  });
});
