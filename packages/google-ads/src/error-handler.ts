import { JarvisError } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Google error classification (Sprint 5.2)
// ---------------------------------------------------------------------------
// Mirrors packages/meta-graph/src/error-handler.ts, including its most
// important property: every message is passed through a redactor before it can
// reach a log, an audit row, or an LLM context window. Google echoes request
// detail into error strings, and OAuth failures can carry token fragments.
// ---------------------------------------------------------------------------

export type GoogleErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHORIZATION_FAILED"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "TOOL_TIMEOUT"
  | "INTERNAL_ERROR";

export interface ClassifiedGoogleError {
  code: GoogleErrorCode;
  retryable: boolean;
  message: string;
  googleStatus?: string;
  requestId?: string;
}

interface GoogleApiErrorDetail {
  code?: number;
  message?: string;
  status?: string;
  details?: unknown;
}

/**
 * Two incompatible error shapes share this field name:
 *   Ads API  -> error: { message, status }
 *   OAuth    -> error: "invalid_grant", error_description: "..."
 * Modelling `error` as the union is what lets the checks below narrow.
 */
interface GoogleApiErrorBody {
  error?: GoogleApiErrorDetail | string;
  error_description?: string;
  requestId?: string;
}

/**
 * Google reports quota exhaustion as RESOURCE_EXHAUSTED and transient backend
 * faults as UNAVAILABLE; both are safe to retry. PERMISSION_DENIED is not.
 */
const RETRYABLE_STATUSES = new Set(["UNAVAILABLE", "RESOURCE_EXHAUSTED", "INTERNAL", "ABORTED"]);

export function classifyGoogleError(status: number, body: unknown): ClassifiedGoogleError {
  let message = "Unknown Google API error";
  let googleStatus: string | undefined;
  let requestId: string | undefined;

  if (body && typeof body === "object") {
    const b = body as GoogleApiErrorBody;

    if (typeof b.error === "string") {
      // OAuth flat form: { error: "invalid_grant", error_description: "..." }
      message = b.error_description ? `${b.error}: ${b.error_description}` : b.error;
      googleStatus = b.error;
    } else if (b.error && typeof b.error === "object") {
      message = b.error.message || message;
      googleStatus = b.error.status;
    }
    if (typeof b.requestId === "string") requestId = b.requestId;
  } else if (typeof body === "string" && body.length > 0) {
    message = body;
  }

  const safeMessage = redactSensitiveInfo(message);
  const base = { message: safeMessage, googleStatus, requestId };

  // invalid_grant means the refresh token is revoked or expired: the user must
  // reconnect. Surfacing it as a generic 400 would send callers into a retry
  // loop that can never succeed.
  if (googleStatus === "invalid_grant") {
    return { ...base, code: "AUTHENTICATION_REQUIRED", retryable: false };
  }
  if (status === 401 || googleStatus === "UNAUTHENTICATED" || googleStatus === "invalid_client") {
    return { ...base, code: "AUTHENTICATION_REQUIRED", retryable: false };
  }
  if (status === 403 || googleStatus === "PERMISSION_DENIED") {
    return { ...base, code: "AUTHORIZATION_FAILED", retryable: false };
  }
  if (status === 429 || googleStatus === "RESOURCE_EXHAUSTED") {
    return { ...base, code: "RATE_LIMITED", retryable: true };
  }
  if (status === 400 || status === 404 || googleStatus === "INVALID_ARGUMENT" || googleStatus === "NOT_FOUND") {
    return { ...base, code: "INVALID_REQUEST", retryable: false };
  }
  if (status === 408 || status === 504 || googleStatus === "DEADLINE_EXCEEDED") {
    return { ...base, code: "TOOL_TIMEOUT", retryable: true };
  }
  if (status >= 500 || (googleStatus && RETRYABLE_STATUSES.has(googleStatus))) {
    return { ...base, code: "INTERNAL_ERROR", retryable: true };
  }
  return { ...base, code: "INTERNAL_ERROR", retryable: false };
}

export function toJarvisError(classified: ClassifiedGoogleError): JarvisError {
  return new JarvisError(classified.code, classified.message);
}

/**
 * Removes credential material from anything destined for a log or a model.
 * Google access tokens start ya29., refresh tokens 1//; developer tokens and
 * bearer headers are stripped wholesale.
 */
export function redactSensitiveInfo(message: string): string {
  return message
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED_TOKEN]")
    .replace(/1\/\/[A-Za-z0-9._-]+/g, "[REDACTED_REFRESH_TOKEN]")
    .replace(/bearer\s+[^\s,]+/gi, "Bearer [REDACTED]")
    .replace(/(access_token|refresh_token|client_secret|developer-?token)["'\s:=]+[^\s,"'}]+/gi, "$1: [REDACTED]");
}
