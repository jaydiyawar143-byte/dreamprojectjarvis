import { JarvisError } from "@jarvis/core";

// ---------------------------------------------------------------------------
// WhatsApp Cloud API error classification (Sprint 5.3)
// ---------------------------------------------------------------------------
// Same contract as packages/meta-graph/src/error-handler.ts and
// packages/google-ads/src/error-handler.ts: classify into the shared JARVIS
// codes, mark retryability honestly, and redact before anything reaches a log,
// an audit row, or a model context.
// ---------------------------------------------------------------------------

export type WhatsAppErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHORIZATION_FAILED"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "TOOL_TIMEOUT"
  | "INTERNAL_ERROR";

export interface ClassifiedWhatsAppError {
  code: WhatsAppErrorCode;
  retryable: boolean;
  message: string;
  metaCode?: number;
  metaSubcode?: number;
  fbtraceId?: string;
}

interface WhatsAppApiError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
  fbtrace_id?: string;
}

/**
 * Cloud API rate-limit and transient codes.
 *   4   — application request limit reached
 *   80007 — rate limit hit
 *   131048 — spam rate limit hit
 *   1     — unknown transient API error
 *   2     — temporary service outage
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 131048]);

/**
 * Codes that mean "this exact send will never succeed as written". Retrying
 * them burns quota and, for 131047, can look like abuse to Meta.
 *   131047 — re-engagement required (outside the 24h customer service window)
 *   131026 — message undeliverable (recipient not on WhatsApp)
 *   132000 — template param count mismatch
 */
const PERMANENT_SEND_FAILURES = new Set([131047, 131026, 132000, 131051]);

export function classifyWhatsAppError(status: number, body: unknown): ClassifiedWhatsAppError {
  let message = "Unknown WhatsApp API error";
  let metaCode: number | undefined;
  let metaSubcode: number | undefined;
  let fbtraceId: string | undefined;

  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: WhatsAppApiError }).error ?? {};
    message = err.message || message;
    metaCode = typeof err.code === "number" ? err.code : undefined;
    metaSubcode = err.error_subcode;
    fbtraceId = err.fbtrace_id;
    if (err.error_data?.details) message = `${message} (${err.error_data.details})`;
  } else if (typeof body === "string" && body.length > 0) {
    message = body;
  }

  const safeMessage = redactSensitiveInfo(message);
  const base = { message: safeMessage, metaCode, metaSubcode, fbtraceId };

  if (metaCode !== undefined && PERMANENT_SEND_FAILURES.has(metaCode)) {
    return { ...base, code: "INVALID_REQUEST", retryable: false };
  }
  if (status === 401 || metaCode === 190) {
    return { ...base, code: "AUTHENTICATION_REQUIRED", retryable: false };
  }
  if (status === 403 || metaCode === 200 || metaCode === 10) {
    return { ...base, code: "AUTHORIZATION_FAILED", retryable: false };
  }
  if (status === 429 || (metaCode !== undefined && RETRYABLE_CODES.has(metaCode) && metaCode !== 2)) {
    return { ...base, code: "RATE_LIMITED", retryable: true };
  }
  if (status === 408 || status === 504) {
    return { ...base, code: "TOOL_TIMEOUT", retryable: true };
  }
  if (status === 400 || status === 404) {
    return { ...base, code: "INVALID_REQUEST", retryable: false };
  }
  if (status >= 500 || metaCode === 2) {
    return { ...base, code: "INTERNAL_ERROR", retryable: true };
  }
  return { ...base, code: "INTERNAL_ERROR", retryable: false };
}

export function toJarvisError(classified: ClassifiedWhatsAppError): JarvisError {
  return new JarvisError(classified.code, classified.message);
}

/**
 * Strips credential material. Meta user/system tokens start EAA; the app secret
 * and access token can both be echoed back inside error text.
 */
export function redactSensitiveInfo(message: string): string {
  return message
    .replace(/EAA[A-Za-z0-9]+/g, "[REDACTED_TOKEN]")
    .replace(/bearer\s+[^\s,]+/gi, "Bearer [REDACTED]")
    .replace(
      /(access_token|app_secret|appSecret|verify_token|verifyToken)["'\s:=]+[^\s,"'}]+/gi,
      "$1: [REDACTED]"
    );
}

/**
 * Phone numbers are personal data. Logs record a masked form so an operator can
 * correlate a conversation without the log becoming a contact list.
 */
export function maskPhoneNumber(waId: string): string {
  if (typeof waId !== "string" || waId.length < 4) return "***";
  return `***${waId.slice(-4)}`;
}
