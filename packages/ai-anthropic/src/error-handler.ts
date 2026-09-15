import {
  JarvisError,
  DEFAULT_RETRY_POLICY,
  PROVIDER_ERROR_MESSAGES,
  RetryAbortedError,
  attachProviderDiagnostic,
  computeRetryDelayMs,
  parseRetryAfterMs,
  redactProviderText,
  runWithRetry,
  type ProviderErrorDiagnostic,
  type RetryPolicy,
} from "@jarvis/core";
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// R-28 — Anthropic failures under the contract `@jarvis/ai-openai` uses:
// the same codes, `details.transient` for failures that say nothing about the
// next request, `details.aborted` for a cancelled call, and the shared retry
// policy from @jarvis/core. This adapter is not wired into the runtime (D-3).
//
// R-31 — and the same messages: fixed for each category, with the provider's
// own account kept as a diagnostic for the server log.
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
  /** R-31 — fixed for the category. Never the provider's text. */
  message: string;
  /** R-31 — the provider's own account of the failure, for the server log. */
  diagnostic: ProviderErrorDiagnostic;
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

/** R-31 — status, type, request id and the provider's redacted text. */
function describeFailure(error: unknown, status: number, claudeType: string, rawMessage: string): ProviderErrorDiagnostic {
  const { request_id: requestId } = (error ?? {}) as { request_id?: unknown };
  // A failure that is not a provider response has no type; its class says what it was.
  const type = claudeType || (error instanceof Error && error.name !== "Error" ? error.name : "");
  return {
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(typeof requestId === "string" ? { providerRequestId: requestId } : {}),
    message: redactProviderText(sanitizeErrorMessage(rawMessage)),
  };
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
  const diagnostic = describeFailure(error, status, claudeType, rawMessage);

  const result = (
    code: ClassifiedClaudeError["code"],
    transient: boolean,
    message: string,
    aborted = false
  ): ClassifiedClaudeError => ({ code, retryable: transient, transient, aborted, providerScoped: false, message, diagnostic });

  if (error instanceof APIUserAbortError) {
    return result("INTERNAL_ERROR", false, ABORTED_MESSAGE, true);
  }

  if (status === 401 || claudeType === "authentication_error") {
    return result("AI_PROVIDER_AUTH_FAILED", false, AUTH_FAILED_MESSAGE);
  }

  if (status === 403 || claudeType === "permission_error") {
    return result("AUTHORIZATION_FAILED", false, PROVIDER_ERROR_MESSAGES.accessDenied);
  }

  if (isContextLengthError(status, claudeType, rawMessage)) {
    return result("CONTEXT_LENGTH_EXCEEDED", false, CONTEXT_LENGTH_MESSAGE);
  }

  // 404 is an unknown model: no request can succeed with it (R-30).
  if (status === 404 || claudeType === "not_found_error") {
    return { ...result("INVALID_REQUEST", false, PROVIDER_ERROR_MESSAGES.modelUnavailable), providerScoped: true };
  }

  if (status === 400 || claudeType === "invalid_request_error") {
    return result("INVALID_REQUEST", false, PROVIDER_ERROR_MESSAGES.invalidRequest);
  }

  if (status === 429 || claudeType === "rate_limit_error") {
    return result("RATE_LIMITED", true, PROVIDER_ERROR_MESSAGES.rateLimited);
  }

  // A timeout carries no status. The SDK's timeout error is also a connection
  // error, so it is matched first.
  if (status === 408 || error instanceof APIConnectionTimeoutError) {
    return result("INTERNAL_ERROR", true, PROVIDER_ERROR_MESSAGES.timeout);
  }

  // 529 "overloaded" is a 5xx; a dropped connection has no status.
  if (
    status >= 500 ||
    RETRYABLE_ERROR_TYPES.has(claudeType) ||
    error instanceof APIConnectionError
  ) {
    return result("INTERNAL_ERROR", true, PROVIDER_ERROR_MESSAGES.unavailable);
  }

  return result("INTERNAL_ERROR", false, PROVIDER_ERROR_MESSAGES.unknown);
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
  // R-31 — the diagnostic rides on the error where nothing serialises it; the
  // adapter logs it.
  return attachProviderDiagnostic(new JarvisError(classified.code, classified.message, details), classified.diagnostic);
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
