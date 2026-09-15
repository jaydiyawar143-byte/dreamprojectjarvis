// ---------------------------------------------------------------------------
// R-31 — what may leave the server when a model provider fails.
//
// A provider's own account of a failure names models, organisations,
// projects and URLs, and sometimes quotes part of a key. None of it is for the
// user; all of it is what an operator needs. So a provider failure carries:
//
//   a fixed message for its category   what a response may show
//   a provider diagnostic              status, type, code, request id and the
//                                      provider's text, redacted and capped;
//                                      readable on the server, invisible to
//                                      every serialisation
//
// And `details.cause`, which the provider chain fills with an error code
// (R-30), reaches a response only while it is one.
//
// Pure: the adapters decide where a log record is written.
// ---------------------------------------------------------------------------

import { ErrorCodeSchema } from "./types/errors.js";
import { redactSecrets } from "./utils/redact-secrets.js";

/**
 * What the user sees for each category of provider failure. Rejected keys,
 * exceeded context windows and open circuits keep the messages R-25, R-27 and
 * R-29 gave them.
 */
export const PROVIDER_ERROR_MESSAGES = Object.freeze({
  invalidRequest:
    "The AI provider could not process this request. Try rephrasing your message, or start a new conversation if it keeps happening.",
  modelUnavailable:
    "The AI model this server is set up to use is not available. An administrator needs to check the model setting.",
  accessDenied:
    "The AI provider refused this server access. An administrator needs to check the provider account and its permissions.",
  rateLimited: "The AI service is receiving too many requests right now. Please try again in a moment.",
  timeout: "The AI service took too long to respond. Please try again in a moment.",
  unavailable: "The AI service is temporarily unavailable. Please try again in a moment.",
  unknown: "Something went wrong while contacting the AI service. Please try again.",
});

/** The provider's own account of a failure. For the server log only. */
export interface ProviderErrorDiagnostic {
  /** The HTTP status the provider answered with, when it answered. */
  status?: number;
  /** The provider's error type, or the error class of a failure that was not a response. */
  type?: string;
  /** The provider's own error code, e.g. `model_not_found`. */
  providerCode?: string;
  /** The provider's id for the request, which its support can look up. */
  providerRequestId?: string;
  /** The provider's text, with secrets redacted and its length capped. */
  message?: string;
}

// A symbol, so no JSON, spread or key listing carries the diagnostic anywhere;
// `Symbol.for`, so a second copy of this package in the module graph reads the
// same key.
const DIAGNOSTIC = Symbol.for("jarvis.providerErrorDiagnostic");

/** Enough to identify a failure; never a complete provider payload. */
const MAX_DIAGNOSTIC_TEXT = 300;

/** Provider text fit for a log line: secrets redacted, length capped. */
export function redactProviderText(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > MAX_DIAGNOSTIC_TEXT
    ? `${redacted.slice(0, MAX_DIAGNOSTIC_TEXT)}…[truncated]`
    : redacted;
}

export function attachProviderDiagnostic<T extends object>(error: T, diagnostic: ProviderErrorDiagnostic): T {
  Object.defineProperty(error, DIAGNOSTIC, { value: diagnostic, enumerable: false, configurable: true });
  return error;
}

export function getProviderDiagnostic(error: unknown): ProviderErrorDiagnostic | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const diagnostic = (error as Record<symbol, unknown>)[DIAGNOSTIC];
  return typeof diagnostic === "object" && diagnostic !== null ? (diagnostic as ProviderErrorDiagnostic) : undefined;
}

/**
 * The one log record of a failed provider call: its code, whether it was
 * transient, and the diagnostic. Undefined for a cancelled call, which is the
 * caller's decision rather than a provider failure.
 */
export function providerFailureLogRecord(provider: string, error: unknown): Record<string, unknown> | undefined {
  const { code, details } = (error ?? {}) as { code?: unknown; details?: { transient?: unknown; aborted?: unknown } };
  if (details?.aborted === true) return undefined;
  return {
    level: "warn",
    event: "ai_provider_error",
    provider,
    code,
    transient: details?.transient === true,
    ...getProviderDiagnostic(error),
  };
}

/**
 * `details` as a response may carry them. `cause` survives only while it is an
 * error code — R-30's chain reports the code that made a provider unusable
 * there — and anything else, provider text included, is dropped.
 */
export function toClientErrorDetails(
  details: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (details === undefined || !("cause" in details)) return details;
  if (ErrorCodeSchema.safeParse(details.cause).success) return details;
  const safe = { ...details };
  delete safe.cause;
  return Object.keys(safe).length > 0 ? safe : undefined;
}
