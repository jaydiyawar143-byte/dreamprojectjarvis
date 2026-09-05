import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Webhook signature verification (Sprint 5.3)
// ---------------------------------------------------------------------------
// Meta signs every webhook POST with:
//
//   X-Hub-Signature-256: sha256=<hex HMAC-SHA256(rawBody, appSecret)>
//
// Three properties this module exists to guarantee:
//
//  1. The HMAC is computed over the EXACT bytes Meta sent. Re-serialising a
//     parsed body (JSON.stringify of the object) changes key order, spacing and
//     unicode escaping, so the digest silently stops matching. The route must
//     therefore hand us the raw Buffer, which is why the webhook mounts its own
//     express.raw() parser ahead of the app-wide JSON parser.
//
//  2. Comparison is CONSTANT-TIME. A byte-by-byte early-exit compare leaks the
//     expected digest one byte at a time to an attacker who can time responses.
//
//  3. Failure is never explained. Every rejection returns the same opaque
//     result, so the endpoint cannot be used as an oracle for why a forgery was
//     rejected.
// ---------------------------------------------------------------------------

const SIGNATURE_PREFIX = "sha256=";
const SHA256_HEX_LENGTH = 64;

export type SignatureFailureReason =
  | "MISSING_HEADER"
  | "MALFORMED_HEADER"
  | "MISMATCH"
  | "EMPTY_BODY";

export interface SignatureResult {
  valid: boolean;
  /** Diagnostic only — for server-side logs, never for the HTTP response. */
  reason?: SignatureFailureReason;
}

/**
 * Verifies X-Hub-Signature-256 over the raw request body.
 *
 * @param rawBody  Exact bytes received. A string is encoded as utf8.
 * @param header   Raw header value, e.g. "sha256=ab12...".
 * @param appSecret Meta app secret (the HMAC key).
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string | undefined | null,
  header: string | undefined | null,
  appSecret: string
): SignatureResult {
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
  // Validate shape BEFORE hashing: timingSafeEqual throws on a length mismatch,
  // and a thrown error would be a louder signal than a plain rejection.
  if (provided.length !== SHA256_HEX_LENGTH || !/^[0-9a-f]+$/i.test(provided)) {
    return { valid: false, reason: "MALFORMED_HEADER" };
  }

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", appSecret).update(body).digest("hex");

  const a = Buffer.from(provided.toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { valid: false, reason: "MISMATCH" };

  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: "MISMATCH" };
}

/** Test/tooling helper: produces the header Meta would send for a body. */
export function signPayload(rawBody: Buffer | string, appSecret: string): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return SIGNATURE_PREFIX + createHmac("sha256", appSecret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// GET webhook verification handshake
// ---------------------------------------------------------------------------
// Meta calls the webhook once with ?hub.mode=subscribe&hub.verify_token=...&
// hub.challenge=... and expects the challenge echoed verbatim. The token is
// compared in constant time for the same reason as the signature.
// ---------------------------------------------------------------------------

export interface VerificationQuery {
  "hub.mode"?: unknown;
  "hub.verify_token"?: unknown;
  "hub.challenge"?: unknown;
}

export interface VerificationResult {
  ok: boolean;
  challenge?: string;
}

export function verifyWebhookChallenge(
  query: VerificationQuery,
  expectedToken: string
): VerificationResult {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];

  if (mode !== "subscribe") return { ok: false };
  if (typeof token !== "string" || typeof challenge !== "string") return { ok: false };

  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expectedToken, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };

  return { ok: true, challenge };
}
