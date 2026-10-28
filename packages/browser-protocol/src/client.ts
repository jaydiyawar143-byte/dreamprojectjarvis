// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the only thing the API holds for a remote browser.
//
// A typed, signed client. It has no browser, no Playwright import, no handle
// and no filesystem path. Every method either returns a validated result or
// throws a `BrowserServiceError` carrying one fixed sentence.
//
// It is also the place where the two transport-level limits are enforced on
// the caller's side: an oversized request is refused before a socket is
// opened, and an oversized response is refused before it is parsed. A service
// that misbehaves is bounded by the client even when it does not bound itself.
// ---------------------------------------------------------------------------

import { randomBytes, randomUUID } from "node:crypto";

import type { BrowserServiceEndpointConfig } from "./config.js";
import {
  isBrowserServiceWriteOperation,
  parseBrowserServiceResponse,
  type BrowserServiceOperation,
  type BrowserServiceSubject,
} from "./contract.js";
import {
  BrowserServiceError,
  outcomeOfServiceRefusal,
  type BrowserServiceErrorCode,
  type BrowserServiceOutcome,
} from "./errors.js";
import {
  BROWSER_PROTOCOL_MAX_BODY_BYTES,
  BROWSER_PROTOCOL_MAX_RESPONSE_BYTES,
} from "./limits.js";
import {
  BROWSER_SERVICE_HEADERS,
  computeBodySha256,
  computeRequestSignature,
  type SignedRequestParts,
} from "./signing.js";
import {
  BrowserServiceTransportError,
  nodeBrowserServiceTransport,
  type BrowserServiceTransport,
  type BrowserServiceTransportResponse,
} from "./transport.js";
import { BROWSER_PROTOCOL_VERSION } from "./version.js";

export interface BrowserServiceClientOptions {
  config: BrowserServiceEndpointConfig;
  transport?: BrowserServiceTransport;
  now?: () => number;
  /** Test seam; production uses 144 bits of randomness per request. */
  nonce?: () => string;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export interface BrowserServiceExecuteInput {
  operation: BrowserServiceOperation;
  sessionId?: string;
  subject: BrowserServiceSubject;
  payload?: Record<string, unknown>;
}

function statusCodeFor(status: number): BrowserServiceErrorCode {
  switch (status) {
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "NOT_AUTHORIZED";
    case 404:
      return "SESSION_NOT_FOUND";
    case 408:
      return "TIMEOUT";
    case 409:
      return "SESSION_EXPIRED";
    case 413:
      return "TOO_LARGE";
    case 429:
      return "LIMIT_EXCEEDED";
    case 503:
      return "UNAVAILABLE";
    default:
      return "PROVIDER_ERROR";
  }
}

export class BrowserServiceClient {
  private readonly config: BrowserServiceEndpointConfig;
  private readonly transport: BrowserServiceTransport;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly url: URL;

  constructor(options: BrowserServiceClientOptions) {
    this.config = options.config;
    if (!this.config.secret || this.config.secret.length < 32) {
      // Startup configuration, not a request: a plain error is right here and
      // it still names the field rather than the value.
      throw new Error("browser service configuration error: BROWSER_SERVICE_SHARED_SECRET is too short");
    }
    this.transport = options.transport ?? nodeBrowserServiceTransport;
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(24).toString("base64url"));
    this.maxRequestBytes = options.maxRequestBytes ?? BROWSER_PROTOCOL_MAX_BODY_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? BROWSER_PROTOCOL_MAX_RESPONSE_BYTES;
    this.url = new URL(`${this.config.baseUrl}/v1/execute`);
  }

  /**
   * Sign and send one request.
   *
   * `signal` is the executor's or the tool's deadline. It is combined with the
   * client's own timeout; whichever fires first aborts the socket.
   *
   * Every error names its outcome (Stage 19.2 audit, H2). Before the request
   * leaves it is `not-sent`. After that, a WRITE whose answer is missing,
   * unreadable or not definitive is `uncertain` — the click or submit may have
   * reached the site — and only a refusal the service sent from
   * `outcomeOfServiceRefusal`'s allowlist is `no-effect`. A read or a session
   * operation changes nothing outside JARVIS, so its failures are `no-effect`.
   */
  async execute(input: BrowserServiceExecuteInput, signal?: AbortSignal): Promise<unknown> {
    const write = isBrowserServiceWriteOperation(input.operation);
    const afterSend: BrowserServiceOutcome = write ? "uncertain" : "no-effect";
    const requestId = randomUUID();
    const hasPayload = input.payload !== undefined && Object.keys(input.payload).length > 0;
    const envelope = {
      version: BROWSER_PROTOCOL_VERSION,
      requestId,
      operation: input.operation,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      subject: input.subject,
      ...(hasPayload ? { payload: input.payload } : {}),
    };

    const body = Buffer.from(JSON.stringify(envelope), "utf8");
    if (body.byteLength > this.maxRequestBytes) throw new BrowserServiceError("TOO_LARGE");

    const timestamp = String(this.now());
    const nonce = this.nonce();
    const bodySha256 = computeBodySha256(body);
    const parts: SignedRequestParts = {
      method: "POST",
      path: `${this.url.pathname}${this.url.search}`,
      timestamp,
      nonce,
      keyId: this.config.keyId,
      bodySha256,
      peerIdentity: this.config.peerIdentity,
    };
    const signature = computeRequestSignature(this.config.secret, parts);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      [BROWSER_SERVICE_HEADERS.keyId]: this.config.keyId,
      [BROWSER_SERVICE_HEADERS.timestamp]: timestamp,
      [BROWSER_SERVICE_HEADERS.nonce]: nonce,
      [BROWSER_SERVICE_HEADERS.bodySha256]: bodySha256,
      [BROWSER_SERVICE_HEADERS.signature]: signature,
    };

    // A deadline that has already passed sends nothing.
    if (signal?.aborted) throw new BrowserServiceError("TIMEOUT", "not-sent");

    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);

    let response: BrowserServiceTransportResponse;
    try {
      response = await this.transport({
        url: this.url,
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        tls: this.config.tls,
        maxResponseBytes: this.maxResponseBytes,
      });
    } catch (error) {
      // Only a transport that says so is believed to have sent nothing. Any
      // other failure — including one from a transport that cannot tell — is
      // treated as having sent the request, because for a write that is the
      // answer that can never cause a second submit.
      const sent = !(error instanceof BrowserServiceTransportError && !error.requestSent);
      const code = timedOut || controller.signal.aborted ? "TIMEOUT" : "UNAVAILABLE";
      // The transport's own error message may contain a host, a certificate
      // detail or a header. It never leaves this line.
      throw new BrowserServiceError(code, sent ? afterSend : "not-sent");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }

    // From here the service has answered something. An answer that cannot be
    // read is not an answer: for a write, the action may still have happened.
    if (response.tooLarge) throw new BrowserServiceError("TOO_LARGE", afterSend);
    if (Buffer.byteLength(response.body, "utf8") > this.maxResponseBytes) {
      throw new BrowserServiceError("TOO_LARGE", afterSend);
    }

    let parsed: ReturnType<typeof parseBrowserServiceResponse> | null = null;
    try {
      parsed = parseBrowserServiceResponse(JSON.parse(response.body) as unknown);
    } catch {
      parsed = null;
    }
    if (parsed) {
      // A response names the request it answers. One that names another is not
      // an answer to this call — a misrouted or replayed response must never be
      // handed to a caller as its result. A null id is the service saying it
      // could not read the request, so there is nothing to compare.
      if (parsed.requestId !== null && parsed.requestId !== requestId) {
        throw new BrowserServiceError("PROVIDER_ERROR", afterSend);
      }
      if (!parsed.ok) {
        throw new BrowserServiceError(parsed.code, outcomeOfServiceRefusal(parsed.code, write));
      }
      return parsed.result;
    }

    // Not an envelope: the status is all there is, and it proves nothing about
    // what a write did.
    throw new BrowserServiceError(statusCodeFor(response.status), afterSend);
  }
}
