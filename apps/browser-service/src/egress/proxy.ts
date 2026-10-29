// ---------------------------------------------------------------------------
// Phase 19, Stage 19.3 — the browser's egress proxy.
//
// Chromium in the browser-service container is launched with this proxy as its
// only way out (`--proxy-server`, loopback included, and a host resolver that
// can resolve nothing but the proxy's own name). Compose puts that container
// on an internal network whose only other members are the API and this proxy.
// So every request the browser makes — a navigation, a redirect hop, an image,
// an XHR, a WebSocket — arrives here, and is judged here, one at a time.
//
//   CONNECT host:port   HTTPS and WebSockets. Judged, then tunnelled to the
//                       judged address. The proxy never sees inside TLS.
//   GET http://…        Plain HTTP, absolute-form. Judged, then forwarded to
//                       the judged address with its own Host header. A
//                       redirect is passed back, never followed: the browser's
//                       next request is judged on its own.
//
// Anything else is refused: an origin-form request (nobody asks the proxy for
// its own pages), an `https://` absolute URL, an HTTP Upgrade outside CONNECT.
//
// The address a connection opens to is the one the policy judged. Nothing here
// resolves a name a second time, so a DNS answer that changes after the check
// — rebinding — is never dialled.
//
// A refusal is `403` with `X-Jarvis-Egress-Denied: <reason>`, and one log line
// with the reason, the port and the host. Never the path, the query, a header
// or a body.
// ---------------------------------------------------------------------------

import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import {
  judgeEgressTarget,
  parseConnectTarget,
  parseHttpProxyTarget,
  systemResolver,
  type EgressPolicy,
  type ResolveHost,
} from "./policy.js";

export type EgressLog = (event: string, fields?: Record<string, string | number | boolean>) => void;

export interface EgressProxyDeps {
  policy: EgressPolicy;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxConnections: number;
  /** DNS seam; production resolves with the system resolver. */
  resolveHost?: ResolveHost;
  /** Socket seam; production dials the judged address directly. */
  openSocket?: (address: string, port: number) => Socket;
  log?: EgressLog;
}

/**
 * Headers that describe ONE hop and must not be forwarded (RFC 9110 §7.6.1),
 * plus the proxy's own. A header the `Connection` header names is hop-by-hop
 * too, and is dropped with them.
 */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function rawResponse(status: number, text: string, extra: Record<string, string> = {}): string {
  const headers = Object.entries({ "content-length": "0", connection: "close", ...extra })
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  return `HTTP/1.1 ${status} ${text}\r\n${headers}\r\n\r\n`;
}

const DENIED_HEADER = "x-jarvis-egress-denied";

export function createEgressProxy(deps: EgressProxyDeps): Server {
  const resolveHost = deps.resolveHost ?? systemResolver(deps.policy.dnsTimeoutMs);
  const openSocket = deps.openSocket ?? ((address: string, port: number) => netConnect({ host: address, port }));
  const log = deps.log ?? (() => undefined);
  let active = 0;

  const server = createServer();

  server.on("connect", (request: IncomingMessage, client: Duplex, head: Buffer) => {
    if (active >= deps.maxConnections) {
      client.end(rawResponse(503, "Service Unavailable"));
      log("egress_refused", { reason: "capacity" });
      return;
    }
    active += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active -= 1;
      }
    };
    client.on("close", release);
    client.on("error", () => client.destroy());

    const target = parseConnectTarget(request.url);
    if (!target) {
      client.end(rawResponse(400, "Bad Request", { [DENIED_HEADER]: "invalid-target" }));
      log("egress_denied", { reason: "invalid-target", method: "CONNECT" });
      return;
    }

    void judgeEgressTarget(target, deps.policy, resolveHost).then((decision) => {
      if (client.destroyed) return;
      if (!decision.allowed) {
        client.end(rawResponse(403, "Forbidden", { [DENIED_HEADER]: decision.reason }));
        log("egress_denied", {
          reason: decision.reason,
          detail: decision.detail,
          host: target.host,
          port: target.port,
          method: "CONNECT",
        });
        return;
      }

      const upstream = openSocket(decision.address, decision.port);
      let connected = false;
      const connectTimer = setTimeout(() => {
        if (!connected) upstream.destroy(new Error("connect timeout"));
      }, deps.connectTimeoutMs);

      upstream.once("connect", () => {
        connected = true;
        clearTimeout(connectTimer);
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.setTimeout(deps.idleTimeoutMs, () => upstream.destroy());
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => {
        clearTimeout(connectTimer);
        if (!connected && !client.destroyed) client.end(rawResponse(502, "Bad Gateway"));
        else client.destroy();
      });
      upstream.on("close", () => {
        clearTimeout(connectTimer);
        client.destroy();
      });
      client.on("close", () => upstream.destroy());
    });
  });

  server.on("request", (request, response) => {
    const target = parseHttpProxyTarget(request.url);
    if (!target) {
      response.writeHead(400, { [DENIED_HEADER]: "invalid-target", "content-length": "0", connection: "close" });
      response.end();
      log("egress_denied", { reason: "invalid-target", method: request.method ?? "" });
      return;
    }
    if (active >= deps.maxConnections) {
      response.writeHead(503, { "content-length": "0", connection: "close" });
      response.end();
      log("egress_refused", { reason: "capacity" });
      return;
    }
    active += 1;
    let released = false;
    response.on("close", () => {
      if (!released) {
        released = true;
        active -= 1;
      }
    });

    void judgeEgressTarget(target, deps.policy, resolveHost).then((decision) => {
      if (response.destroyed) return;
      if (!decision.allowed) {
        response.writeHead(403, { [DENIED_HEADER]: decision.reason, "content-length": "0", connection: "close" });
        response.end();
        log("egress_denied", {
          reason: decision.reason,
          detail: decision.detail,
          host: target.host,
          port: target.port,
          method: request.method ?? "",
        });
        return;
      }

      const headers = endToEnd(request.headers);
      headers.host = target.hostHeader;
      headers.connection = "close";
      const upstream = httpRequest({
        method: request.method,
        path: target.path,
        headers,
        // No agent: the socket is this one, opened to the judged address.
        createConnection: () => openSocket(decision.address, decision.port),
        timeout: deps.idleTimeoutMs,
      });
      upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
      upstream.on("response", (answer) => {
        if (response.destroyed) {
          answer.destroy();
          return;
        }
        response.writeHead(answer.statusCode ?? 502, endToEnd(answer.headers));
        answer.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.headersSent) {
          response.writeHead(502, { "content-length": "0", connection: "close" });
          response.end();
        } else {
          response.destroy();
        }
      });
      request.pipe(upstream);
    });
  });

  // A WebSocket travels inside CONNECT. An Upgrade on a plain request is
  // something no supported client sends through this proxy.
  server.on("upgrade", (_request: IncomingMessage, socket: Duplex) => {
    socket.end(rawResponse(400, "Bad Request", { [DENIED_HEADER]: "invalid-target" }));
    log("egress_denied", { reason: "invalid-target", method: "UPGRADE" });
  });

  server.on("clientError", (_error, socket: Duplex) => {
    if (socket.writable) socket.end(rawResponse(400, "Bad Request"));
    else socket.destroy();
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The proxy's own liveness listener, bound by `main.ts` to 127.0.0.1 inside
 * its container, like the browser service's (Stage 19.2, M1). `/healthz` and
 * nothing else, and only to a loopback peer. It has no route to the proxy.
 */
export function createEgressHealthServer(): Server {
  const server = createServer((request, response) => {
    const path = (() => {
      try {
        return new URL(request.url ?? "/", "http://egress").pathname;
      } catch {
        return null;
      }
    })();
    if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? "") || path !== "/healthz") {
      response.writeHead(404, { "content-length": "0" });
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-length": "0" });
      response.end();
      return;
    }
    const body = JSON.stringify({ status: "ok", service: "jarvis-browser-egress" });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store",
    });
    response.end(body);
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  return server;
}
