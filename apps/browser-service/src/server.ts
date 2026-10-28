// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the browser service's HTTP surface.
//
// One authenticated route (`POST /v1/execute`) and one liveness route
// (`GET /healthz`). Nothing else exists, so there is no third route to forget
// to authenticate.
//
// The service listens with mutual TLS and nothing else (Stage 19.2 audit, M2):
// there is no plain-HTTP mode to fall back to. Its /healthz therefore needs the
// client certificate like everything else on that port.
//
// The container's own health check cannot present one, so liveness has a
// SECOND listener (Stage 19.2 audit, M1): `createBrowserServiceHealthServer`,
// bound by index.ts to 127.0.0.1 inside the container. It answers `/healthz`
// and nothing else — it has no route to the registry and no signed-request
// path — and it refuses any peer that is not loopback even if bound wider. Its
// body is fixed: the process is up and whether Chromium is switched on. When
// BROWSER_SERVICE_HEALTH_TOKEN is set both listeners require it too. Neither
// is ever published on a host port.
//
// Every refusal is the fixed sentence for its code. The service's own
// operational log line carries the request id and the code, never a header, a
// body, a page, a selector or an environment value.
// ---------------------------------------------------------------------------

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import {
  BROWSER_PROTOCOL_VERSION,
  BROWSER_SERVICE_HEADERS,
  BrowserServiceError,
  failureEnvelope,
  isBrowserServiceWriteOperation,
  parseBrowserServiceRequest,
  successEnvelope,
  verifySignedRequest,
  type BrowserServiceErrorCode,
  type BrowserServiceKey,
  type NonceStorePort,
} from "@jarvis/browser-protocol";
import { BrowserControlResultSchema } from "@jarvis/core";

import type { BrowserServiceConfig } from "./config.js";
import { peerIdentityFromRequest } from "./identity.js";
import type { BrowserSessionRegistry } from "./session-registry.js";

export type BrowserServiceLog = (
  event: string,
  fields?: Record<string, string | number | boolean>
) => void;

export interface BrowserServiceServerDeps {
  config: BrowserServiceConfig;
  registry: BrowserSessionRegistry;
  nonces: NonceStorePort;
  chromiumEnabled: boolean;
  now?: () => number;
  log?: BrowserServiceLog;
}

const STATUS_BY_CODE: Readonly<Record<BrowserServiceErrorCode, number>> = Object.freeze({
  INVALID_REQUEST: 400,
  UNSUPPORTED_VERSION: 400,
  UNKNOWN_OPERATION: 400,
  UNAUTHENTICATED: 401,
  REQUEST_EXPIRED: 401,
  REPLAY_DETECTED: 401,
  NOT_AUTHORIZED: 403,
  CROSS_TENANT_DENIED: 403,
  SESSION_NOT_FOUND: 404,
  SESSION_EXPIRED: 409,
  LIMIT_EXCEEDED: 429,
  TOO_LARGE: 413,
  TIMEOUT: 408,
  UNAVAILABLE: 503,
  PROVIDER_ERROR: 502,
  UNKNOWN_OUTCOME: 502,
});

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf8")),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendFailure(
  response: ServerResponse,
  requestId: string | null,
  code: BrowserServiceErrorCode
): void {
  sendJson(response, STATUS_BY_CODE[code], failureEnvelope(requestId, code));
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        settled = true;
        // Keep draining so the response can be written on the same socket.
        request.resume();
        reject(new BrowserServiceError("TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "content-length": "0" });
  response.end();
}

/** The liveness answer both listeners give. Fixed fields; nothing from a request. */
function healthHandler(
  config: Pick<BrowserServiceConfig, "healthToken">,
  chromiumEnabled: boolean
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendEmpty(response, 405);
      return;
    }
    if (config.healthToken) {
      const presented = request.headers[BROWSER_SERVICE_HEADERS.healthToken];
      if (typeof presented !== "string" || !tokenMatches(presented, config.healthToken)) {
        // Not found, not forbidden: a liveness route should not confirm its
        // own existence to an unauthenticated caller.
        sendEmpty(response, 404);
        return;
      }
    }
    sendJson(response, 200, {
      status: "ok",
      service: "jarvis-browser",
      version: BROWSER_PROTOCOL_VERSION,
      chromium: chromiumEnabled ? "enabled" : "disabled",
    });
  };
}

function requestPath(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? "/", "http://browser-service").pathname;
  } catch {
    return null;
  }
}

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The loopback-only liveness listener (Stage 19.2 audit, M1).
 *
 * It is a different server object from the mTLS one, built from nothing but
 * the health token and the Chromium switch: no registry, no keys, no nonce
 * store. There is therefore no request it can be sent that reaches a browser
 * session — not by path, not by method. Any path other than /healthz is 404,
 * and so is any peer that is not loopback, so binding it wider by mistake
 * still exposes nothing.
 */
export function createBrowserServiceHealthServer(deps: {
  config: Pick<BrowserServiceConfig, "healthToken">;
  chromiumEnabled: boolean;
}): Server {
  const handleHealth = healthHandler(deps.config, deps.chromiumEnabled);
  const server = createHttpServer((request, response) => {
    if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? "")) {
      sendEmpty(response, 404);
      return;
    }
    if (requestPath(request) !== "/healthz") {
      sendEmpty(response, 404);
      return;
    }
    handleHealth(request, response);
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  return server;
}

export function createBrowserServiceServer(deps: BrowserServiceServerDeps): Server {
  const { config, registry } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const keys: readonly BrowserServiceKey[] = [
    { keyId: config.keyId, secret: config.secret, identity: config.peerIdentity },
  ];

  const handleHealth = healthHandler(config, deps.chromiumEnabled);

  const handleExecute = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const requestIdForLog: { value: string | null } = { value: null };

    try {
      if ((request.headers["content-type"] ?? "").toLowerCase().indexOf("application/json") < 0) {
        sendFailure(response, null, "INVALID_REQUEST");
        return;
      }

      const body = await readBody(request, config.maxBodyBytes);

      const peerIdentity = peerIdentityFromRequest(request);
      const verification = await verifySignedRequest({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body,
        peerIdentity,
        keys,
        now: now(),
        clockSkewMs: config.clockSkewMs,
        nonces: deps.nonces,
      });
      if (!verification.ok) {
        sendFailure(response, null, verification.code);
        log("browser_service_request_refused", { code: verification.code });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        sendFailure(response, null, "INVALID_REQUEST");
        return;
      }

      const requestParse = parseBrowserServiceRequest(parsed);
      if (!requestParse.ok) {
        sendFailure(response, null, requestParse.code);
        log("browser_service_request_refused", { code: requestParse.code });
        return;
      }
      const envelope = requestParse.value;
      requestIdForLog.value = envelope.requestId;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        if (envelope.operation === "session.open") {
          const opened = await registry.open(envelope.subject);
          sendJson(response, 200, successEnvelope(envelope.requestId, opened));
          return;
        }

        if (envelope.operation === "session.close") {
          await registry.close(envelope.sessionId ?? "", envelope.subject);
          sendJson(response, 200, successEnvelope(envelope.requestId, { closed: true }));
          return;
        }

        const result = await registry.execute(
          envelope.sessionId ?? "",
          envelope.subject,
          envelope.control!,
          controller.signal
        );

        // The result is validated against the SAME Phase 19.1 result contract
        // the tools consume. A browser that returns something else is a
        // provider failure, never a result to pass along — and for a write the
        // action has already run, so its outcome is unknown (Stage 19.2 audit,
        // H2), never a failure a new approval could repeat.
        const validated = BrowserControlResultSchema.safeParse(result);
        if (!validated.success) {
          sendFailure(
            response,
            envelope.requestId,
            isBrowserServiceWriteOperation(envelope.operation) ? "UNKNOWN_OUTCOME" : "PROVIDER_ERROR"
          );
          log("browser_service_result_invalid", { requestId: envelope.requestId });
          return;
        }

        sendJson(response, 200, successEnvelope(envelope.requestId, validated.data));
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const code = error instanceof BrowserServiceError ? error.code : "PROVIDER_ERROR";
      sendFailure(response, requestIdForLog.value, code);
      log("browser_service_request_failed", {
        requestId: requestIdForLog.value ?? "unknown",
        code,
      });
    }
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const path = requestPath(request);
    if (path === null) {
      sendFailure(response, null, "INVALID_REQUEST");
      return;
    }

    if (path === "/healthz") {
      handleHealth(request, response);
      return;
    }

    if (path !== "/v1/execute") {
      sendEmpty(response, 404);
      return;
    }

    if (request.method !== "POST") {
      sendEmpty(response, 405);
      return;
    }

    void handleExecute(request, response);
  };

  // Mutual TLS, always. A peer without a certificate signed by the configured
  // CA never completes the handshake, so it never reaches a route at all.
  const server = createHttpsServer(
    {
      key: readFileSync(config.tls.keyPath),
      cert: readFileSync(config.tls.certPath),
      ca: readFileSync(config.tls.caPath),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    handler
  );

  server.requestTimeout = config.requestTimeoutMs + 5_000;
  server.headersTimeout = 10_000;
  return server;
}
