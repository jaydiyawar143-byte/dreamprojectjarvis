// ---------------------------------------------------------------------------
// R-26 — the retry policy shared by the model-provider adapters.
//
// An adapter decides WHICH failures may be retried, because its provider's
// error classes are its own. This module decides HOW: exponential backoff with
// bounded jitter, a cap on every single wait — including one a provider asks
// for through Retry-After — a total time budget, and an abort that ends a wait
// at once. It retries one provider call; it never re-runs anything around it,
// so a tool, an approval or a persisted message cannot be repeated by it.
//
// Pure apart from the default clock and sleep, which callers can replace.
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Retries after the first attempt. 0 disables retrying. */
  maxRetries: number;
  /** Wait before the first retry; doubled for each retry after it. */
  baseDelayMs: number;
  /** Upper bound on any single wait, Retry-After included. */
  maxDelayMs: number;
  /** Random extra wait added to the exponential delay, at most this much. */
  maxJitterMs: number;
  /** No retry starts once this much time has passed since the first attempt. */
  maxElapsedMs: number;
}

/**
 * The defaults.
 *
 * `maxRetries`, `baseDelayMs` and `maxJitterMs` are the values the adapters
 * already used. The caps are new: 8s matches the OpenAI SDK's own retry
 * ceiling, and 45s lets a request retry once after a 30s timeout (the adapters'
 * default) but not twice.
 */
export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  maxJitterMs: 1000,
  maxElapsedMs: 45_000,
});

/** Whether a failure may be retried, and any wait the provider asked for. */
export interface RetryDecision {
  retry: boolean;
  retryAfterMs?: number;
}

/** Thrown when the caller's signal aborts before or between attempts. */
export class RetryAbortedError extends Error {
  constructor() {
    super("Request was aborted");
    this.name = "RetryAbortedError";
  }
}

/**
 * The wait before retry number `retryIndex` (0 for the first retry).
 *
 * A usable Retry-After replaces the exponential delay; either way the result
 * never exceeds `maxDelayMs`.
 */
export function computeRetryDelayMs(
  retryIndex: number,
  policy: RetryPolicy,
  options: { random?: () => number; retryAfterMs?: number } = {}
): number {
  const { retryAfterMs } = options;
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, policy.maxDelayMs);
  }

  const random = options.random ?? Math.random;
  const exponential = policy.baseDelayMs * 2 ** retryIndex;
  const jitter = Math.min(Math.max(random(), 0), 1) * policy.maxJitterMs;
  return Math.min(exponential + jitter, policy.maxDelayMs);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;

  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value: unknown = get.call(headers, name);
    return typeof value === "string" ? value : undefined;
  }

  const value = (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The wait a response asked for, in milliseconds, or undefined.
 *
 * Reads `retry-after-ms`, then `retry-after` as seconds or an HTTP date — the
 * same headers, in the same order, as the OpenAI and Anthropic SDKs. Accepts a
 * fetch `Headers` or the plain lower-cased object the SDKs attach to an error.
 */
export function parseRetryAfterMs(headers: unknown, now: number = Date.now()): number | undefined {
  const milliseconds = readHeader(headers, "retry-after-ms");
  if (milliseconds !== undefined) {
    const value = Number(milliseconds);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  const retryAfter = readHeader(headers, "retry-after")?.trim();
  if (!retryAfter) return undefined;

  if (/^\d+(\.\d+)?$/.test(retryAfter)) {
    return Number(retryAfter) * 1000;
  }

  const date = Date.parse(retryAfter);
  if (Number.isNaN(date)) return undefined;
  const delta = date - now;
  return delta >= 0 ? delta : undefined;
}

/** A wait that ends early, with RetryAbortedError, when the signal aborts. */
export function sleepWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryAbortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RetryAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RunWithRetryOptions {
  policy: RetryPolicy;
  shouldRetry: (error: unknown) => RetryDecision;
  signal?: AbortSignal | null;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/**
 * Runs `attempt`, retrying failures `shouldRetry` accepts within the policy.
 *
 * Rethrows the last failure unchanged when it may not be retried, when the
 * retries are used up, or when the next wait would pass the time budget. An
 * abort — before an attempt, during one, or during a wait — ends everything
 * with RetryAbortedError.
 */
export async function runWithRetry<T>(attempt: () => Promise<T>, options: RunWithRetryOptions): Promise<T> {
  const { policy, shouldRetry, signal } = options;
  const sleep = options.sleep ?? sleepWithAbort;
  const now = options.now ?? Date.now;
  const startedAt = now();

  for (let retries = 0; ; retries++) {
    if (signal?.aborted) throw new RetryAbortedError();

    try {
      return await attempt();
    } catch (error) {
      // A failure caused by the abort is the abort, whatever it looks like.
      if (signal?.aborted) throw new RetryAbortedError();

      const decision = shouldRetry(error);
      if (!decision.retry || retries >= policy.maxRetries) throw error;

      const delay = computeRetryDelayMs(retries, policy, {
        random: options.random,
        retryAfterMs: decision.retryAfterMs,
      });
      if (now() - startedAt + delay > policy.maxElapsedMs) throw error;

      await sleep(delay, signal);
    }
  }
}
