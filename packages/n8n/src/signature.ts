import { createHmac, timingSafeEqual, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// n8n callback authentication (Sprint 5.4)
// ---------------------------------------------------------------------------
// n8n has no built-in outgoing webhook signature, so the contract is ours: a
// workflow's final HTTP Request node must send
//
//   X-Jarvis-Signature: sha256=<hex HMAC-SHA256(rawBody, callbackSecret)>
//
// Same three properties as the WhatsApp verifier in packages/whatsapp, and for
// the same reasons:
//
//  1. The HMAC covers the EXACT bytes received. The route therefore parses the
//     callback with its own express.raw(); re-serialising a parsed body would
//     change key order and escaping and silently break every signature.
//  2. Comparison is constant-time, so response timing cannot leak the digest.
//  3. Rejections are opaque to the caller; the reason is logged, never returned.
//
// This module is intentionally self-contained rather than importing the
// WhatsApp implementation: the two integrations must be able to change their
// wire formats independently, and Sprint 5.4 must not modify WhatsApp.
// ---------------------------------------------------------------------------

const SIGNATURE_PREFIX = "sha256=";
const SHA256_HEX_LENGTH = 64;

export type CallbackFailureReason =
  | "MISSING_HEADER"
  | "MALFORMED_HEADER"
  | "MISMATCH"
  | "EMPTY_BODY";

export interface CallbackSignatureResult {
  valid: boolean;
  /** Server-side diagnostic only. Never include in an HTTP response. */
  reason?: CallbackFailureReason;
}

export function verifyCallbackSignature(
  rawBody: Buffer | string | undefined | null,
  header: string | undefined | null,
  callbackSecret: string
): CallbackSignatureResult {
  if (rawBody === undefined || rawBody === null) {
    return { valid: false, reason: "EMPTY_BODY" };
  }
  if (typeof header !== "string" || header.length === 0) {
    return { valid: false, reason: "MISSING_HEADER" };
  }
  if (!header.startsWith(SIGNATURE_PREFIX)) {
    return { valid: false, reason: "MALFORMED_HEADER" };
  }

  const provided = header.slice(SIGNATURE_PREFIX.length);
  // Shape is validated BEFORE hashing: timingSafeEqual throws on differing
  // lengths, and a throw would be a louder signal than a plain rejection.
  if (provided.length !== SHA256_HEX_LENGTH || !/^[0-9a-f]+$/i.test(provided)) {
    return { valid: false, reason: "MALFORMED_HEADER" };
  }

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", callbackSecret).update(body).digest("hex");

  const a = Buffer.from(provided.toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { valid: false, reason: "MISMATCH" };

  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: "MISMATCH" };
}

/** Produces the header an n8n workflow must send. Used by tests and docs. */
export function signCallback(rawBody: Buffer | string, callbackSecret: string): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return SIGNATURE_PREFIX + createHmac("sha256", callbackSecret).update(body).digest("hex");
}

/** SHA-256 of a request payload, for auditing what was sent without storing it. */
export function hashPayload(payload: unknown): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Deterministic idempotency key for an outbound trigger.
 *
 * Keyed on user + workflow + payload, so an identical retry converges on the
 * same execution row while a genuinely different payload starts a new run.
 */
export function buildIdempotencyKey(
  userId: string,
  workflowId: string,
  payloadHash: string
): string {
  return `n8n:${userId}:${workflowId}:${payloadHash}`;
}
