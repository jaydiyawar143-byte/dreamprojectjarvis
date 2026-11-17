// ---------------------------------------------------------------------------
// Phase 19, P0 — can this API actually talk to its browser service?
//
// A configuration can be complete and its TLS files sound, and the service can
// still be unreachable, refuse the API's certificate, reject its signature,
// disagree about the clock, or speak another protocol version. Each of those
// used to surface only as "unavailable" on a person's first browser request.
//
// The probe is one AUTHENTICATED NO-OP over the real protocol: closing a
// session id that was never issued, as a subject that is no person. The
// service authenticates the request (mutual TLS, then the signature, the
// timestamp and the nonce), checks the protocol version, and answers
// `{ closed: true }` — closing an unknown session is idempotent and touches no
// session, so no operation had to be added for it. It works with Chromium off.
//
// The answer is a fixed reason and a fixed sentence. Never a host, a path, a
// certificate, a header, a body or a value.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import { BrowserServiceClient } from "./client.js";
import type { BrowserServiceEndpointConfig } from "./config.js";
import type { BrowserServiceSubject } from "./contract.js";
import { BrowserServiceError } from "./errors.js";
import {
  BrowserServiceTransportError,
  nodeBrowserServiceTransport,
  type BrowserServiceTransport,
  type BrowserServiceTransportFailure,
} from "./transport.js";

/** The probe's subject. Not a user and not an Organization; no session is ever bound to it. */
export const BROWSER_SERVICE_PROBE_SUBJECT: Readonly<BrowserServiceSubject> = Object.freeze({
  userId: "jarvis-startup-probe",
  organizationId: "jarvis-startup-probe",
});

export type BrowserServiceProbeFailure =
  | "client-credentials-unreadable"
  | "unreachable"
  | "tls-handshake"
  | "authentication"
  | "clock-skew"
  | "protocol-version"
  | "timeout"
  | "service-unavailable"
  | "unexpected-response";

export type BrowserServiceProbeResult =
  | { ok: true }
  | { ok: false; reason: BrowserServiceProbeFailure; message: string };

/** What to tell an operator, per reason. Fixed sentences: no value is ever interpolated. */
export const BROWSER_SERVICE_PROBE_MESSAGES: Readonly<Record<BrowserServiceProbeFailure, string>> = Object.freeze({
  "client-credentials-unreadable":
    "The API could not read its client certificate, key or CA file (BROWSER_SERVICE_CLIENT_CERT_PATH, BROWSER_SERVICE_CLIENT_KEY_PATH, BROWSER_SERVICE_CA_PATH).",
  unreachable:
    "The browser service could not be reached: the connection was refused or reset, or BROWSER_SERVICE_URL's host did not resolve. Check that the service is running and on the API's network.",
  "tls-handshake":
    "The TLS handshake with the browser service failed: check BROWSER_SERVICE_CA_PATH, that the service's certificate names BROWSER_SERVICE_URL's host, and that the service trusts the API's client certificate.",
  authentication:
    "The browser service refused the API's identity: BROWSER_SERVICE_KEY_ID, BROWSER_SERVICE_SHARED_SECRET and BROWSER_SERVICE_PEER_IDENTITY must match the service's, and the client certificate must name that identity.",
  "clock-skew":
    "The browser service refused the request as too old or too new: the API's and the service's clocks disagree by more than the service allows.",
  "protocol-version":
    "The browser service speaks a different protocol version than this API: deploy the API and the service from the same release.",
  timeout: "The browser service did not answer in time (BROWSER_SERVICE_TIMEOUT_MS).",
  "service-unavailable": "The browser service answered that it is unavailable.",
  "unexpected-response": "The browser service answered with something other than the expected acknowledgement.",
});

export interface BrowserServiceProbeOptions {
  transport?: BrowserServiceTransport;
  now?: () => number;
  nonce?: () => string;
}

function failed(reason: BrowserServiceProbeFailure): BrowserServiceProbeResult {
  return { ok: false, reason, message: BROWSER_SERVICE_PROBE_MESSAGES[reason] };
}

function fromTransport(failure: BrowserServiceTransportFailure | null): BrowserServiceProbeFailure {
  switch (failure) {
    case "credentials":
    case "refused-locally":
      return "client-credentials-unreadable";
    case "tls":
      return "tls-handshake";
    case "network":
      return "unreachable";
    default:
      return "unreachable";
  }
}

/**
 * Probe the browser service once. Never throws: every failure is a reason.
 */
export async function probeBrowserService(
  config: BrowserServiceEndpointConfig,
  options: BrowserServiceProbeOptions = {}
): Promise<BrowserServiceProbeResult> {
  const base = options.transport ?? nodeBrowserServiceTransport;
  // The client turns every transport failure into one error code; the probe
  // keeps the transport's own classification beside it.
  let transportFailure: BrowserServiceTransportFailure | null = null;
  const transport: BrowserServiceTransport = async (request) => {
    try {
      return await base(request);
    } catch (error) {
      transportFailure = error instanceof BrowserServiceTransportError ? error.failure : "unknown";
      throw error;
    }
  };

  let client: BrowserServiceClient;
  try {
    client = new BrowserServiceClient({
      config,
      transport,
      ...(options.now ? { now: options.now } : {}),
      ...(options.nonce ? { nonce: options.nonce } : {}),
    });
  } catch {
    return failed("authentication");
  }

  let result: unknown;
  try {
    result = await client.execute({
      operation: "session.close",
      sessionId: randomUUID(),
      subject: { ...BROWSER_SERVICE_PROBE_SUBJECT },
    });
  } catch (error) {
    if (!(error instanceof BrowserServiceError)) return failed("unexpected-response");
    switch (error.code) {
      case "UNAVAILABLE":
        return failed(transportFailure === null ? "service-unavailable" : fromTransport(transportFailure));
      case "TIMEOUT":
        return failed("timeout");
      case "UNAUTHENTICATED":
      case "NOT_AUTHORIZED":
      case "REPLAY_DETECTED":
        return failed("authentication");
      case "REQUEST_EXPIRED":
        return failed("clock-skew");
      case "UNSUPPORTED_VERSION":
        return failed("protocol-version");
      default:
        return failed("unexpected-response");
    }
  }

  const closed = (result as { closed?: unknown } | null)?.closed;
  return closed === true ? { ok: true } : failed("unexpected-response");
}
