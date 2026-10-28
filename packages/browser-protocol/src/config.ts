// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the API's endpoint configuration.
//
// THREE STATES, and the difference between the last two is the whole point:
//
//   absent   BROWSER_SERVICE_URL is unset. The deployment has not asked for a
//            remote browser, so the existing in-process behaviour is allowed.
//   invalid  an operator asked for the remote browser and the configuration
//            cannot be used. Browser tools are NOT registered and the local
//            runtime is NOT used: falling back would silently turn a failed
//            hardening change into an unhardened one.
//   ready    usable.
//
// Error messages name fields, never values. A secret is never echoed, and a
// short secret is reported as short rather than quoted.
// ---------------------------------------------------------------------------

import {
  BROWSER_PROTOCOL_DEFAULT_TIMEOUT_MS,
  BROWSER_PROTOCOL_MIN_SECRET_LENGTH,
} from "./limits.js";

export interface BrowserServiceClientTls {
  certPath: string;
  keyPath: string;
  /** The CA that signed the browser service's certificate, when it is private. */
  caPath: string | null;
}

export interface BrowserServiceEndpointConfig {
  /** Origin and optional path prefix, with no trailing slash. */
  baseUrl: string;
  keyId: string;
  secret: string;
  /** The identity this API presents to the service, and signs over. */
  peerIdentity: string;
  timeoutMs: number;
  /**
   * The API's client certificate. `readBrowserServiceEndpoint` never returns a
   * config without it; the transport refuses to send without it too. Typed as
   * nullable only so a test can hand the client a transport of its own.
   */
  tls: BrowserServiceClientTls | null;
}

export type BrowserServiceEndpointRead =
  | { state: "absent"; reason: string }
  | { state: "invalid"; reason: string }
  | { state: "ready"; config: BrowserServiceEndpointConfig };

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text && text.length > 0 ? text : null;
}

function parseTimeout(raw: string | undefined): number | null {
  const text = trimmed(raw);
  if (!text) return BROWSER_PROTOCOL_DEFAULT_TIMEOUT_MS;
  if (!/^[0-9]{1,7}$/.test(text)) return null;
  const value = Number(text);
  if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) return null;
  return value;
}

/**
 * Read the API-side endpoint configuration.
 *
 * The URL is parsed, not trusted: credentials in the authority, a query string
 * or a fragment would end up outside the signed request target, so each is
 * refused rather than quietly dropped.
 */
export function readBrowserServiceEndpoint(
  env: NodeJS.ProcessEnv = process.env
): BrowserServiceEndpointRead {
  const rawUrl = trimmed(env.BROWSER_SERVICE_URL);
  if (!rawUrl) {
    return { state: "absent", reason: "BROWSER_SERVICE_URL is not set" };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { state: "invalid", reason: "BROWSER_SERVICE_URL is not a valid URL" };
  }
  // Stage 19.2 audit (M2): the service accepts mutual TLS only, so a plain
  // http endpoint could never authenticate — and would carry typed text and
  // form values in the clear if it somehow answered. It is refused here.
  if (url.protocol !== "https:") {
    return { state: "invalid", reason: "BROWSER_SERVICE_URL must use https" };
  }
  if (url.username || url.password) {
    return { state: "invalid", reason: "BROWSER_SERVICE_URL must not carry credentials" };
  }
  if (url.search || url.hash) {
    return { state: "invalid", reason: "BROWSER_SERVICE_URL must not carry a query or fragment" };
  }

  const keyId = trimmed(env.BROWSER_SERVICE_KEY_ID);
  if (!keyId) return { state: "invalid", reason: "BROWSER_SERVICE_KEY_ID is not set" };

  const secret = trimmed(env.BROWSER_SERVICE_SHARED_SECRET);
  if (!secret) return { state: "invalid", reason: "BROWSER_SERVICE_SHARED_SECRET is not set" };
  if (secret.length < BROWSER_PROTOCOL_MIN_SECRET_LENGTH) {
    return {
      state: "invalid",
      reason: `BROWSER_SERVICE_SHARED_SECRET is shorter than ${BROWSER_PROTOCOL_MIN_SECRET_LENGTH} characters`,
    };
  }

  const peerIdentity = trimmed(env.BROWSER_SERVICE_PEER_IDENTITY);
  if (!peerIdentity) {
    return { state: "invalid", reason: "BROWSER_SERVICE_PEER_IDENTITY is not set" };
  }

  const timeoutMs = parseTimeout(env.BROWSER_SERVICE_TIMEOUT_MS);
  if (timeoutMs === null) {
    return {
      state: "invalid",
      reason: `BROWSER_SERVICE_TIMEOUT_MS must be a whole number of milliseconds between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    };
  }

  const certPath = trimmed(env.BROWSER_SERVICE_CLIENT_CERT_PATH);
  const keyPath = trimmed(env.BROWSER_SERVICE_CLIENT_KEY_PATH);
  const caPath = trimmed(env.BROWSER_SERVICE_CA_PATH);
  // The client certificate is what proves this API's identity at the socket;
  // without it the service refuses the handshake. Required, not optional.
  if (certPath === null || keyPath === null) {
    return {
      state: "invalid",
      reason:
        "BROWSER_SERVICE_CLIENT_CERT_PATH and BROWSER_SERVICE_CLIENT_KEY_PATH are required: the browser service accepts mutual TLS only",
    };
  }

  const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;

  return {
    state: "ready",
    config: {
      baseUrl,
      keyId,
      secret,
      peerIdentity,
      timeoutMs,
      tls: { certPath, keyPath, caPath },
    },
  };
}
