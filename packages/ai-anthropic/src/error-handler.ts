import {
  JarvisError,
  DEFAULT_RETRY_POLICY,
  RetryAbortedError,
  computeRetryDelayMs,
  parseRetryAfterMs,
  runWithRetry,
  type RetryPolicy,
} from "@jarvis/core";
import { APIConnectionError, APIUserAbortError } from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// R-28 — Anthropic failures under the contract `@jarvis/ai-openai` uses:
// the same codes, `details.transient` for failures that say nothing about the
// next request, `details.aborted` for a cancelled call, and the shared retry
// policy from @jarvis/core. This adapter is not wired into the runtime (D-3).
// ---------------------------------------------------------------------------

const RETRYABLE_ERROR_TYPES = new Set([
  "rate_limit_error",
  "api_error",
  "overloaded_error",
]);

const CONTEXT_LENGTH_MESSAGE =
  "This conversation is too long for the AI model. Start a new conversation or send a shorter message.";

const AUTH_FAILED_MESSAGE =
  "The AI provider rejected this server's API key. An administrator needs to check the Anthropic API key and restart the API.";

const ABORTED_MESSAGE = "Request was aborted";

export interface ClassifiedClaudeError {
  code:
    | "AI_PROVIDER_AUTH_FAILED"
    | "AUTHORIZATION_FAILED"
    | "CONTEXT_LENGTH_EXCEEDED"
    | "INVALID_REQUEST"
    | "RATE_LIMITED"
    | "INTERNAL_ERROR";
  /** Retried by `executeWithRetry`: exactly the transient failures. */
  retryable: boolean;
  transient: boolean;
  aborted: boolean;
  /** R-30 — an unknown model: every request would fail alike. */
  providerScoped: boolean;
  message: string;
}

/**
 * Anthropic sends no dedicated code for an exceeded context window, only a
 * 400 invalid_request_error, so its two known wordings are matched.
 */
function isContextLengthError(status: number, claudeType: string, rawMessage: string): boolean {
  return (
    (status === 400 || claudeType === "invalid_request_error") &&
    /prompt is too long|exceed context limit/i.test(rawMessage)
  );
}

export function classifyClaudeError(error: unknown): ClassifiedClaudeError {
  const err = error as {
    status?: number;
    message?: string;
    error?: { type?: string; message?: string; error?: { type?: string; message?: string } };
  };

  const status = typeof err.status === "number" ? err.status : 0;
  // The SDK keeps the whole response body on `error` —
  // { type: "error", error: { type, message } } — so the provider's type and
  // message are one level down. Reading `error.type` gave "error" for every
  // failure, and no type-based rule ever matched.
  const body = err.error?.error ?? err.error;
  const claudeType = body?.type ?? "";
  const rawMessage = body?.message ?? err.message ?? "Unknown AI provider error";

  const safeMessage = sanitizeErrorMessage(rawMessage);

  const result = (
    code: ClassifiedClaudeError["code"],
    transient: boolean,
    message: string = safeMessage,
    aborted = false
  ): ClassifiedClaudeError => ({ code, retryable: transient, transient, aborted, providerScoped: false, message });

  if (error instanceof APIUserAbortError) {
    return result("INTERNAL_ERROR", false, ABORTED_MESSAGE, true);
  }

  if (status === 401 || claudeType === "authentication_error") {
    return result("AI_PROVIDER_AUTH_FAILED", false, AUTH_FAILED_MESSAGE);
  }

  if (status === 403 || claudeType === "permission_error") {
    return result("AUTHORIZATION_FAILED", false);
  }

  if (isContextLengthError(status, claudeType, rawMessage)) {
    return result("CONTEXT_LENGTH_EXCEEDED", false, CONTEXT_LENGTH_MESSAGE);
  }

  // 404 is an unknown model: no request can succeed with it (R-30).
  if (status === 404 || claudeType === "not_found_error") {
    return { ...result("INVALID_REQUEST", false), providerScoped: true };
  }

  if (status === 400 || claudeType === "invalid_request_error") {
    return result("INVALID_REQUEST", false);
  }

  if (status === 429 || claudeType === "rate_limit_error") {
    return result("RATE_LIMITED", true);
  }

  // 529 "overloaded" is a 5xx; a timeout or dropped connection has no status.
  if (
    status === 408 ||
    status >= 500 ||
    RETRYABLE_ERROR_TYPES.has(claudeType) ||
    error instanceof APIConnectionError
  ) {
    return result("INTERNAL_ERROR", true);
  }

  return result("INTERNAL_ERROR", false);
}

/** The wait before retry `attempt` under the default policy. */
export function calculateRetryDelay(attempt: number): number {
  return computeRetryDelayMs(attempt, DEFAULT_RETRY_POLICY);
}

export function toJarvisError(error: unknown): JarvisError {
  if (error instanceof RetryAbortedError) {
    return new JarvisError("INTERNAL_ERROR", ABORTED_MESSAGE, { aborted: true });
  }
  const classified = classifyClaudeError(error);
  const details = classified.aborted
    ? { aborted: true }
    : classified.transient
      ? { transient: true }
      : classified.providerScoped
        ? { scope: "provider" }
        : undefined;
  return new JarvisError(classified.code, classified.message, details);
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED]")
    .replace(/api[_-]?key[:\s]*[^\s,]+/gi, "api_key: [REDACTED]")
    .replace(/bearer\s+[^\s,]+/gi, "Bearer [REDACTED]");
}

export interface RetryOptions {
  /** Backoff bounds. The retry count is the `maxRetries` argument. */
  policy?: Partial<Omit<RetryPolicy, "maxRetries">>;
  /** Replaces the real wait; tests use it so no backoff is actually slept. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** One SDK call, retried within the shared policy; ends with ONE JarvisError. */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  signal?: AbortSignal | null,
  options: RetryOptions = {}
): Promise<T> {
  try {
    return await runWithRetry(fn, {
      policy: { ...DEFAULT_RETRY_POLICY, ...options.policy, maxRetries },
      signal,
      sleep: options.sleep,
      now: options.now,
      random: options.random,
      shouldRetry: (error) => ({
        retry: classifyClaudeError(error).retryable,
        retryAfterMs: parseRetryAfterMs((error as { headers?: unknown } | null)?.headers),
      }),
    });
  } catch (error) {
    throw toJarvisError(error);
  }
}
