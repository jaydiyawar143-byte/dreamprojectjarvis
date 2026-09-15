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
// From the subpath, not the package root: the SDK's error classes live in this
// module either way, and tests that mock "openai" leave it untouched.
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai/error";

const RETRYABLE_ERROR_TYPES = new Set([
  "rate_limit",
  "timeout",
  "connection",
  "server",
]);

/**
 * R-25 — shown instead of the provider's text, which quotes token counts and
 * gives the user nothing to do.
 */
const CONTEXT_LENGTH_MESSAGE =
  "This conversation is too long for the AI model. Start a new conversation or send a shorter message.";

/**
 * R-29 — shown instead of the provider's text, which quotes part of the key.
 * The user cannot fix this; an administrator can.
 */
const AUTH_FAILED_MESSAGE =
  "The AI provider rejected this server's API key. An administrator needs to check the OpenAI API key and restart the API.";

const ABORTED_MESSAGE = "Request was aborted";

export interface ClassifiedOpenAIError {
  code:
    | "AI_PROVIDER_AUTH_FAILED"
    | "AUTHORIZATION_FAILED"
    | "CONTEXT_LENGTH_EXCEEDED"
    | "INVALID_REQUEST"
    | "RATE_LIMITED"
    | "INTERNAL_ERROR";
  /** Retried by `executeWithRetry`. Since R-26, exactly the transient failures. */
  retryable: boolean;
  /**
   * R-24 — the failure says nothing about the next request: a timeout, a
   * dropped connection, a rate limit or a 5xx. The agent that saw it stays in
   * service, and the circuit breaker counts it.
   */
  transient: boolean;
  /** R-26 — the caller cancelled. Not a provider failure at all. */
  aborted: boolean;
  /**
   * R-30 — the failure concerns the provider's configuration (an unknown or
   * inaccessible model), so every request would fail the same way. The
   * provider chain falls back and disables the provider for a cooldown.
   */
  providerScoped: boolean;
  /** R-31 — fixed for the category. Never the provider's text. */
  message: string;
  /** R-31 — the provider's own account of the failure, for the server log. */
  diagnostic: ProviderErrorDiagnostic;
}

/**
 * R-25 — the context window, and only the context window.
 *
 * The SDK's `code` is the stable signal. The message is a fallback for a
 * response that carries none, and it matches the context-window wording only:
 * a single message over the length limit is a different 400 and stays an
 * invalid request.
 */
function isContextLengthError(code: unknown, status: number, openaiType: string, rawMessage: string): boolean {
  if (code === "context_length_exceeded") return true;
  return (
    (status === 400 || openaiType === "invalid_request_error") &&
    /maximum context length|context_length_exceeded/i.test(rawMessage)
  );
}

/** R-31 — status, type, code, request id and the provider's redacted text. */
function describeFailure(error: unknown, status: number, openaiType: string, rawMessage: string): ProviderErrorDiagnostic {
  const { code, request_id: requestId } = (error ?? {}) as { code?: unknown; request_id?: unknown };
  // A failure that is not a provider response has no type; its class says what it was.
  const type = openaiType || (error instanceof Error && error.name !== "Error" ? error.name : "");
  return {
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(typeof code === "string" ? { providerCode: code } : {}),
    ...(typeof requestId === "string" ? { providerRequestId: requestId } : {}),
    message: redactProviderText(sanitizeErrorMessage(rawMessage)),
  };
}

export function classifyOpenAIError(error: unknown): ClassifiedOpenAIError {
  const err = error as {
    status?: number;
    code?: string;
    type?: string;
    message?: string;
    error?: { type?: string; message?: string };
  };

  const status = err.status ?? 0;
  const openaiType = err.error?.type ?? err.type ?? "";
  const rawMessage = err.error?.message ?? err.message ?? "Unknown AI provider error";
  const diagnostic = describeFailure(error, status, openaiType, rawMessage);

  const result = (
    code: ClassifiedOpenAIError["code"],
    transient: boolean,
    message: string,
    aborted = false
  ): ClassifiedOpenAIError => ({ code, retryable: transient, transient, aborted, providerScoped: false, message, diagnostic });

  if (error instanceof APIUserAbortError) {
    return result("INTERNAL_ERROR", false, ABORTED_MESSAGE, true);
  }

  if (status === 401 || openaiType === "authentication_error") {
    return result("AI_PROVIDER_AUTH_FAILED", false, AUTH_FAILED_MESSAGE);
  }

  if (status === 403 || openaiType === "permission_error") {
    return result("AUTHORIZATION_FAILED", false, PROVIDER_ERROR_MESSAGES.accessDenied);
  }

  if (isContextLengthError(err.code, status, openaiType, rawMessage)) {
    return result("CONTEXT_LENGTH_EXCEEDED", false, CONTEXT_LENGTH_MESSAGE);
  }

  // R-30 — an unknown or inaccessible model fails every request alike.
  if (status === 404 || err.code === "model_not_found") {
    return { ...result("INVALID_REQUEST", false, PROVIDER_ERROR_MESSAGES.modelUnavailable), providerScoped: true };
  }

  if (status === 400 || openaiType === "invalid_request_error") {
    return result("INVALID_REQUEST", false, PROVIDER_ERROR_MESSAGES.invalidRequest);
  }

  if (status === 429 || openaiType === "rate_limit") {
    return result("RATE_LIMITED", true, PROVIDER_ERROR_MESSAGES.rateLimited);
  }

  // A timeout carries no status. The SDK's timeout error is also a connection
  // error, so it is matched first.
  if (status === 408 || openaiType === "timeout" || error instanceof APIConnectionTimeoutError) {
    return result("INTERNAL_ERROR", true, PROVIDER_ERROR_MESSAGES.timeout);
  }

  // A dropped connection carries no status and no type; a 504 is a 5xx like
  // any other.
  if (
    status >= 500 ||
    openaiType === "server_error" ||
    openaiType === "api_connection_error" ||
    RETRYABLE_ERROR_TYPES.has(openaiType) ||
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
  const classified = classifyOpenAIError(error);
  // Read by the agent to decide whether it stays in service (R-24, R-25) and by
  // the adapter's circuit breaker to decide what counts (R-27).
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
    .replace(/sk-[a-zA-Z0-9_-]+/g, "[REDACTED]")
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

/**
 * R-26 — one SDK call, retried within the shared policy.
 *
 * Retries transient failures only, honouring a capped Retry-After, and always
 * ends with ONE JarvisError. Only the SDK call is repeated; nothing the caller
 * does with the result can run twice.
 */
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
        retry: classifyOpenAIError(error).retryable,
        retryAfterMs: parseRetryAfterMs((error as { headers?: unknown } | null)?.headers),
      }),
    });
  } catch (error) {
    throw toJarvisError(error);
  }
}
