// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — short-lived signed requests (ADR-19-002).
//
// Two mechanisms, two jobs:
//
//   mutual TLS   proves the transport peers are the provisioned API and the
//                provisioned browser service;
//   this module  authorises ONE request, binds it to its exact bytes, gives it
//                a short life and makes it single-use.
//
// The signature covers the HTTP method, the request target, the timestamp, the
// nonce, the key id, the SHA-256 of the body and the transport identity the
// caller claims. Covering the identity is what stops a valid signature made by
// one service from being replayed by another that somehow holds the key: the
// verifier also requires the claimed identity to equal the certificate's.
//
// Verification order matters. Everything cheap and local happens before the
// nonce store is touched, so an unauthenticated flood cannot fill it, and the
// nonce is spent LAST — a request whose signature does not verify has spent
// nothing.
// ---------------------------------------------------------------------------

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { BrowserServiceErrorCode } from "./errors.js";
import { nonceExpiryFor, type NonceStorePort } from "./nonce.js";

/**
 * Header names, lower-case because Node gives them that way.
 *
 * There is no identity header (Stage 19.2 audit, M2). The peer identity is
 * what the TLS stack verified from the client certificate; a header a caller
 * writes is never transport authentication, so none exists to write.
 */
export const BROWSER_SERVICE_HEADERS = Object.freeze({
  keyId: "x-jarvis-key-id",
  timestamp: "x-jarvis-timestamp",
  nonce: "x-jarvis-nonce",
  bodySha256: "x-jarvis-content-sha256",
  signature: "x-jarvis-signature",
  healthToken: "x-jarvis-health-token",
});

/** A provisioned signing key and the service identity it belongs to. */
export interface BrowserServiceKey {
  keyId: string;
  secret: string;
  /**
   * The transport identity the key is bound to — the certificate's subject
   * identity, or the identity a trusted TLS terminator asserts. A request is
   * accepted only when this equals the peer identity of the connection.
   */
  identity: string;
}

export interface SignedRequestParts {
  method: string;
  /** The request target, including any query string. */
  path: string;
  timestamp: string;
  nonce: string;
  keyId: string;
  bodySha256: string;
  peerIdentity: string;
}

const CANONICAL_PREFIX = "jarvis-browser-request/1";
const TIMESTAMP_PATTERN = /^[0-9]{1,15}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One canonical string, so both sides derive the same bytes.
 *
 * Fields are joined with newlines and the prefix pins the purpose and version.
 * None of the fields may contain a newline — a header cannot, and the body
 * hash and key id are validated before signing — so the encoding is
 * unambiguous.
 */
export function canonicalRequestString(parts: SignedRequestParts): string {
  return [
    CANONICAL_PREFIX,
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.keyId,
    parts.bodySha256,
    parts.peerIdentity,
  ].join("\n");
}

export function computeBodySha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function computeRequestSignature(secret: string, parts: SignedRequestParts): string {
  return createHmac("sha256", secret).update(canonicalRequestString(parts), "utf8").digest("hex");
}

/** Constant-time comparison of two hex strings; malformed input is a mismatch. */
function equalsHex(presented: string, expected: string): boolean {
  if (!SHA256_PATTERN.test(presented)) return false;
  const a = Buffer.from(presented, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyRequestSignature(
  secret: string,
  parts: SignedRequestParts,
  presented: string
): boolean {
  if (!SIGNATURE_PATTERN.test(presented)) return false;
  const expected = computeRequestSignature(secret, parts);
  return equalsHex(presented, expected);
}

/** True when the timestamp is a whole number of milliseconds inside the window. */
export function isTimestampFresh(timestamp: string, now: number, clockSkewMs: number): boolean {
  if (!TIMESTAMP_PATTERN.test(timestamp)) return false;
  const value = Number(timestamp);
  if (!Number.isSafeInteger(value) || value <= 0) return false;
  return Math.abs(now - value) <= clockSkewMs;
}

export function isNonceShapeValid(nonce: string): boolean {
  return NONCE_PATTERN.test(nonce);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const raw = headers[name];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "string" && raw[0].length > 0) {
    return raw[0];
  }
  return null;
}

export interface VerifySignedRequestInput {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
  /** The identity the transport proved, or null when it proved none. */
  peerIdentity: string | null;
  keys: readonly BrowserServiceKey[];
  now: number;
  clockSkewMs: number;
  nonces: NonceStorePort;
}

export type SignedRequestVerification =
  | { ok: true; keyId: string; identity: string }
  | { ok: false; code: BrowserServiceErrorCode };

/**
 * Verify one request, spending its nonce only if everything before it passed.
 *
 * A missing peer identity refuses before anything else: mutual TLS is not a
 * header the caller can set, it is a fact about the connection.
 *
 * The nonce store is per process (`ProcessNonceStore`): a restart forgets the
 * nonces it saw, so a request captured inside its clock-skew window could be
 * replayed once against a freshly started process. Capturing one needs the
 * TLS session; the window is 60 s by default; a shared store is Stage 19.7.
 */
export async function verifySignedRequest(
  input: VerifySignedRequestInput
): Promise<SignedRequestVerification> {
  if (!input.peerIdentity) return { ok: false, code: "UNAUTHENTICATED" };

  const keyId = headerValue(input.headers, BROWSER_SERVICE_HEADERS.keyId);
  const timestamp = headerValue(input.headers, BROWSER_SERVICE_HEADERS.timestamp);
  const nonce = headerValue(input.headers, BROWSER_SERVICE_HEADERS.nonce);
  const bodySha256 = headerValue(input.headers, BROWSER_SERVICE_HEADERS.bodySha256);
  const signature = headerValue(input.headers, BROWSER_SERVICE_HEADERS.signature);
  if (!keyId || !timestamp || !nonce || !bodySha256 || !signature) {
    return { ok: false, code: "UNAUTHENTICATED" };
  }

  if (!isNonceShapeValid(nonce)) return { ok: false, code: "UNAUTHENTICATED" };
  if (!isTimestampFresh(timestamp, input.now, input.clockSkewMs)) {
    return { ok: false, code: "REQUEST_EXPIRED" };
  }

  const actualBodyHash = computeBodySha256(input.body);
  if (!equalsHex(bodySha256, actualBodyHash)) return { ok: false, code: "UNAUTHENTICATED" };

  const key = input.keys.find((candidate) => candidate.keyId === keyId);
  if (!key) return { ok: false, code: "UNAUTHENTICATED" };

  // The certificate identity and the signing key id must resolve to the SAME
  // service identity. A key that is valid but belongs to someone else is not
  // a valid request from this peer.
  if (key.identity !== input.peerIdentity) return { ok: false, code: "UNAUTHENTICATED" };

  const parts: SignedRequestParts = {
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    keyId,
    bodySha256: actualBodyHash,
    peerIdentity: input.peerIdentity,
  };
  if (!verifyRequestSignature(key.secret, parts, signature)) {
    return { ok: false, code: "UNAUTHENTICATED" };
  }

  const firstUse = await input.nonces.use(
    nonce,
    nonceExpiryFor(Number(timestamp), input.clockSkewMs, input.now)
  );
  if (!firstUse) return { ok: false, code: "REPLAY_DETECTED" };

  return { ok: true, keyId: key.keyId, identity: key.identity };
}
