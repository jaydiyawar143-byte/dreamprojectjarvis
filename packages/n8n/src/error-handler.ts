import { JarvisError } from "@jarvis/core";

// ---------------------------------------------------------------------------
// n8n error classification (Sprint 5.4)
// ---------------------------------------------------------------------------
// Same contract as the Meta, Google and WhatsApp handlers: map to the shared
// JARVIS codes, mark retryability honestly, redact before anything is logged.
//
// One n8n-specific hazard drives the retryability rules: triggering a workflow
// is NOT idempotent from our side. A timeout or a dropped connection means the
// workflow may already be running, so those outcomes are reported as ambiguous
// and are never marked safely retryable.
// ---------------------------------------------------------------------------

export type N8nErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHORIZATION_FAILED"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "TOOL_TIMEOUT"
  | "WORKFLOW_FAILED"
  | "NETWORK_ERROR"
  | "INTERNAL_ERROR";

export interface ClassifiedN8nError {
  code: N8nErrorCode;
  /** Safe to send the SAME trigger again without risking a duplicate run. */
  retryable: boolean;
  /**
   * True when the request may have reached n8n and started a workflow despite
   * the error. Such a run must never be auto-retried.
   */
  sideEffectPossible: boolean;
  message: string;
  httpStatus?: number;
}

interface N8nErrorBody {
  message?: string;
  error?: string;
  code?: number | string;
  hint?: string;
}

export function classifyN8nError(status: number, body: unknown): ClassifiedN8nError {
  let message = "Unknown n8n error";

  if (body && typeof body === "object") {
    const b = body as N8nErrorBody;
    message = b.message || b.error || message;
    if (b.hint) message = `${message} (${b.hint})`;
  } else if (typeof body === "string" && body.length > 0) {
    message = body;
  }

  const safeMessage = redactSensitiveInfo(message);
  const base = { message: safeMessage, httpStatus: status };

  // 401/403 from n8n means our API key is wrong or revoked. The request was
  // rejected at the door, so no workflow started.
  if (status === 401) {
    return { ...base, code: "AUTHENTICATION_REQUIRED", retryable: false, sideEffectPossible: false };
  }
  if (status === 403) {
    return { ...base, code: "AUTHORIZATION_FAILED", retryable: false, sideEffectPossible: false };
  }
  // 404 usually means the workflow is inactive or the webhook path is stale.
  if (status === 404) {
    return {
      ...base,
      code: "INVALID_REQUEST",
      retryable: false,
      sideEffectPossible: false,
      message: `${safeMessage} (workflow not found or not active)`,
    };
  }
  if (status === 400 || status === 422) {
    return { ...base, code: "INVALID_REQUEST", retryable: false, sideEffectPossible: false };
  }
  if (status === 429) {
    return { ...base, code: "RATE_LIMITED", retryable: true, sideEffectPossible: false };
  }
  if (status === 408 || status === 504) {
    // The gateway timed out, but the workflow behind it may still be running.
    return { ...base, code: "TOOL_TIMEOUT", retryable: false, sideEffectPossible: true };
  }
  if (status >= 500) {
    // A 500 from n8n usually means the workflow itself threw AFTER starting.
    return { ...base, code: "WORKFLOW_FAILED", retryable: false, sideEffectPossible: true };
  }
  return { ...base, code: "INTERNAL_ERROR", retryable: false, sideEffectPossible: true };
}

/** Classifies a transport-level failure (DNS, refused, reset, abort). */
export function classifyTransportError(err: unknown, transmitted: boolean): ClassifiedN8nError {
  const raw = err instanceof Error ? err.message : "n8n request failed";
  const name = err instanceof Error ? err.name : "";
  const isAbort = name === "AbortError" || /abort/i.test(raw);

  return {
    code: isAbort ? "TOOL_TIMEOUT" : "NETWORK_ERROR",
    retryable: false,
    // A request that never left the process cannot have started a workflow;
    // one that was transmitted might have.
    sideEffectPossible: transmitted,
    message: redactSensitiveInfo(
      isAbort ? "n8n request timed out" : `n8n request failed: ${raw}`
    ),
  };
}

export function toJarvisError(classified: ClassifiedN8nError): JarvisError {
  return new JarvisError(
    // WORKFLOW_FAILED and NETWORK_ERROR are n8n-specific; map them onto codes
    // the rest of JARVIS already understands.
    classified.code === "WORKFLOW_FAILED" || classified.code === "NETWORK_ERROR"
      ? "INTERNAL_ERROR"
      : classified.code,
    classified.message
  );
}

/**
 * Strips credential material. n8n echoes request detail into errors, and a
 * misconfigured workflow can put the API key or callback secret into a message.
 */
export function redactSensitiveInfo(message: string): string {
  return message
    .replace(/bearer\s+[^\s,]+/gi, "Bearer [REDACTED]")
    .replace(
      /(x-n8n-api-key|n8n_api_key|apiKey|api_key|callbackSecret|callback_secret|X-Jarvis-Signature)["'\s:=]+[^\s,"'}]+/gi,
      "$1: [REDACTED]"
    )
    // Credentials embedded in a URL, e.g. https://user:pass@host/...
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
