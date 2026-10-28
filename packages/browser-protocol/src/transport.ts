// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the HTTP transport the API uses.
//
// It is `node:https`, not `fetch`, for one reason that matters: a client
// certificate. Presenting one through `fetch` means constructing an undici
// dispatcher, and a TLS detail hidden behind a dispatcher is a detail nobody
// reviews. `https.request` takes `cert`, `key` and `ca` as first-class
// options, and the service's mutual-TLS requirement is then visible at the one
// place that opens the connection.
//
// The transport is injected into the client so tests never open a socket.
// Nothing here reads or logs a header, a body or a certificate.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import type { BrowserServiceClientTls } from "./config.js";

export interface BrowserServiceTransportRequest {
  url: URL;
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array;
  signal: AbortSignal;
  tls: BrowserServiceClientTls | null;
  maxResponseBytes: number;
}

export interface BrowserServiceTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Set when the body crossed the ceiling; the body is then incomplete. */
  tooLarge: boolean;
}

export type BrowserServiceTransport = (
  request: BrowserServiceTransportRequest
) => Promise<BrowserServiceTransportResponse>;

/**
 * A transport failure, and whether the request had been sent when it happened
 * (Stage 19.2 audit, H2).
 *
 * `requestSent` is false only when the request provably never left: the
 * connection, the handshake or the write did not complete. Once the whole body
 * has been written the service may have acted, so a failure after that point
 * says `true` — the caller cannot tell "never arrived" from "arrived, acted,
 * and the answer was lost", and must not pretend it can.
 *
 * It carries no message of the underlying error: a socket error's text can
 * name a host or a certificate.
 */
export class BrowserServiceTransportError extends Error {
  override readonly name = "BrowserServiceTransportError";

  constructor(readonly requestSent: boolean) {
    super(requestSent ? "The connection failed after the request was sent." : "The request was not sent.");
  }
}

function stringHeaders(source: NodeJS.Dict<string | string[]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") result[name.toLowerCase()] = value;
    else if (Array.isArray(value) && value.length > 0) result[name.toLowerCase()] = value.join(", ");
  }
  return result;
}

/**
 * The real transport.
 *
 * Certificate files are read per request rather than cached for the process
 * lifetime, so a rotated certificate is picked up by a restart of the API —
 * and, more importantly, a file that has become unreadable is an error at the
 * moment of use instead of a silently stale credential held in memory.
 */
export const nodeBrowserServiceTransport: BrowserServiceTransport = async (input) => {
  // Mutual TLS or nothing (Stage 19.2 audit, M2). A plain http request, or an
  // https one without the API's client certificate, could never authenticate
  // and would carry typed text and form values unprotected: it is not sent.
  if (input.url.protocol !== "https:" || !input.tls) {
    throw new BrowserServiceTransportError(false);
  }

  const body = Buffer.from(input.body);
  let tlsMaterial;
  try {
    tlsMaterial = {
      cert: readFileSync(input.tls.certPath),
      key: readFileSync(input.tls.keyPath),
      ...(input.tls.caPath ? { ca: readFileSync(input.tls.caPath) } : {}),
    };
  } catch {
    throw new BrowserServiceTransportError(false);
  }
  const options = {
    method: input.method,
    hostname: input.url.hostname,
    port: input.url.port || 443,
    path: `${input.url.pathname}${input.url.search}`,
    headers: { ...input.headers, "content-length": String(body.byteLength) },
    signal: input.signal,
    ...tlsMaterial,
  };

  // Set once the whole request has been handed to the socket. Before that the
  // service cannot have received it; after it, the service may have acted.
  let requestSent = false;

  let response: IncomingMessage;
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpsRequest(options, resolve);
      req.on("finish", () => {
        requestSent = true;
      });
      req.on("error", reject);
      req.end(body);
    });
  } catch {
    throw new BrowserServiceTransportError(requestSent);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  try {
    for await (const chunk of response) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buf.byteLength;
      if (size > input.maxResponseBytes) {
        tooLarge = true;
        response.destroy();
        break;
      }
      chunks.push(buf);
    }
  } catch {
    // The service had answered and the answer was cut off.
    throw new BrowserServiceTransportError(true);
  }

  return {
    status: response.statusCode ?? 0,
    headers: stringHeaders(response.headers),
    body: Buffer.concat(chunks).toString("utf8"),
    tooLarge,
  };
};
