// ---------------------------------------------------------------------------
// Phase 15 — reading one public web page over plain HTTP(S).
//
// WHAT THIS IS FOR. The SEO audit and the competitor comparison need the HTML
// of a page the user named. They do not need a browser: no script is run, no
// click is made, nothing is rendered. So this is one GET, bounded in time and
// size, that hands back text.
//
// IT IS THE SAME NAVIGATION POLICY, NOT A SECOND ONE. Every address this
// module opens — the one asked for, and every redirect hop after it — is put
// through `validateNavigationTarget`, the single SSRF decision the browser
// tools already use: http/https only, default ports, no credentials in the
// URL, the operator's domain allowlist, and a refusal for any host that
// resolves to a private, loopback, link-local or metadata address.
//
// AND IT CLOSES THE ONE GAP THE BROWSER CANNOT. The navigation policy's own
// header names its residual risk: it resolves a host and judges the answers,
// then Chrome resolves the host again, and a hostile DNS server can answer
// differently the second time. Here there is no second resolution. The
// connection is opened to the exact address that was just judged (`lookup`
// below returns it and nothing else), while TLS still verifies the
// certificate against the host name. A rebinding answer has nowhere to land.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//   - It sends no cookie, no credential and no referrer, and keeps none.
//   - It follows redirects itself, a bounded number of times, re-judging each.
//   - It stops reading at a byte ceiling instead of trusting Content-Length.
//   - It does not crawl: one call reads one page. Links on it are counted by
//     the audit, never followed.
//   - It returns the body as DATA. Nothing in it is executed or interpreted
//     here, and the caller treats it as untrusted.
//
// Error messages are fixed strings. They name the reason a URL was refused
// (which the policy already words without echoing a credential) and never
// carry a response body.
// ---------------------------------------------------------------------------

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Transform } from "node:stream";

import { parseIpAddress } from "./ip-rules.js";
import {
  validateNavigationTarget,
  type NavigationDenyReason,
  type NavigationPolicyConfig,
} from "./navigation-policy.js";

export const PAGE_FETCH_DEFAULT_TIMEOUT_MS = 15_000;
export const PAGE_FETCH_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_FETCH_DEFAULT_MAX_REDIRECTS = 5;
export const PAGE_FETCH_USER_AGENT = "JARVIS-PageResearch/1.0 (single-page read; no crawling)";

export type PageFetchFailureCode =
  /** The navigation policy refused the address, or a redirect to it. */
  | "URL_NOT_ALLOWED"
  | "TOO_MANY_REDIRECTS"
  /** A redirect with no usable Location. */
  | "BAD_REDIRECT"
  /** The response is not an HTML document. */
  | "NOT_HTML"
  | "TIMEOUT"
  | "ABORTED"
  | "NETWORK_ERROR";

/** A page that could not be read, and why — in words fit to show a person. */
export class PageFetchError extends Error {
  override readonly name = "PageFetchError";
  constructor(
    readonly code: PageFetchFailureCode,
    message: string,
    /** Set when the navigation policy refused the address. */
    readonly denyReason?: NavigationDenyReason
  ) {
    super(message);
  }
}

export interface FetchedPage {
  /** The address that was asked for, normalised. */
  requestedUrl: string;
  /** The address the content came from, after redirects. */
  finalUrl: string;
  httpStatus: number;
  contentType: string | null;
  /** The body as text. Untrusted. */
  html: string;
  /** Bytes read from the network. */
  bytes: number;
  /** True when the body was cut off at the byte ceiling. */
  truncated: boolean;
  redirects: number;
  fetchedAt: string;
}

/** One HTTP exchange, already aimed at a judged address. */
export interface PageTransportRequest {
  url: URL;
  /** The ONLY address the connection may be opened to. */
  address: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Stop reading the (decoded) body here. */
  maxBytes: number;
}

export interface PageTransportResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: Uint8Array;
  truncated: boolean;
}

export type PageTransport = (request: PageTransportRequest) => Promise<PageTransportResponse>;

export interface PublicPageFetcherConfig {
  /** The navigation policy. The same object shape the browser tools use. */
  policy: NavigationPolicyConfig;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Test seam. Production leaves it unset and gets `node:http(s)`. */
  transport?: PageTransport;
  now?: () => Date;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const DENY_MESSAGES: Readonly<Record<NavigationDenyReason, string>> = Object.freeze({
  "invalid-url": "That is not a web address JARVIS can open.",
  "too-long": "That web address is too long.",
  "blocked-scheme": "Only http and https addresses can be opened.",
  "credentials-in-url": "A web address that contains a username or password cannot be opened.",
  "blocked-port": "Only the standard web ports can be opened.",
  "not-allowlisted": "That site is not on this deployment's list of allowed sites.",
  "dns-failure": "That site's address could not be found.",
  "blocked-address": "That address points to a private or internal network, which JARVIS does not open.",
});

function isHtmlContentType(contentType: string | null): boolean {
  // No Content-Type at all is let through: plenty of small sites omit it, and
  // the audit reads whatever markup is there. A DECLARED non-HTML type is not.
  if (contentType === null) return true;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

function charsetOf(contentType: string | null, head: Uint8Array): string {
  const declared = contentType ? /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1] : undefined;
  if (declared) return declared;
  // The page's own declaration, looked for in its first bytes only. Decoded as
  // latin1 so every byte maps to one character and nothing can throw.
  const sniffed = Buffer.from(head.subarray(0, 2048)).toString("latin1");
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(sniffed)?.[1];
  return meta ?? "utf-8";
}

function decodeBody(body: Uint8Array, contentType: string | null): string {
  const label = charsetOf(contentType, body);
  try {
    return new TextDecoder(label, { fatal: false }).decode(body);
  } catch {
    // An encoding label this runtime does not know.
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

// ---------------------------------------------------------------------------
// The default transport: node:http / node:https, pinned to one address
// ---------------------------------------------------------------------------

function decompressor(encoding: string | undefined): Transform | null {
  const value = (encoding ?? "").trim().toLowerCase();
  if (value === "gzip" || value === "x-gzip") return createGunzip();
  if (value === "br") return createBrotliDecompress();
  if (value === "deflate") return createInflate();
  return null;
}

/**
 * One GET over `node:http(s)`.
 *
 * `lookup` is the pin: whatever name the socket layer asks about, it is told
 * the one address that was judged. `servername` and the `Host` header keep the
 * real host name, so virtual hosting works and the certificate is checked
 * against the name the user asked for — not against an IP.
 */
export const nodePageTransport: PageTransport = (request) =>
  new Promise<PageTransportResponse>((resolve, reject) => {
    const { url, address, headers, signal, maxBytes } = request;
    const isHttps = url.protocol === "https:";
    const family = parseIpAddress(address)?.family ?? 4;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        host: hostname,
        port: url.port.length > 0 ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { ...headers, host: url.host },
        signal,
        ...(isHttps ? { servername: parseIpAddress(hostname) ? undefined : hostname } : {}),
        // No connection is ever reused: an agent would also hold sockets open
        // after the read is over.
        agent: false,
        lookup: (_host, options, callback) => {
          const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
          if (wantsAll) {
            (callback as unknown as (err: null, addresses: Array<{ address: string; family: number }>) => void)(null, [
              { address, family },
            ]);
          } else {
            (callback as unknown as (err: null, address: string, family: number) => void)(null, address, family);
          }
        },
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") responseHeaders[name.toLowerCase()] = value;
          else if (Array.isArray(value) && value.length > 0) responseHeaders[name.toLowerCase()] = value[0]!;
        }

        // A redirect's body is never read: only its Location matters.
        if (REDIRECT_STATUSES.has(status)) {
          response.destroy();
          finish(() => resolve({ status, headers: responseHeaders, body: new Uint8Array(0), truncated: false }));
          return;
        }

        const decoder = decompressor(responseHeaders["content-encoding"]);
        const stream = decoder ? response.pipe(decoder) : response;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        const done = (): void => {
          finish(() => resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks), truncated }));
        };

        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = maxBytes - size;
          if (chunk.length >= room) {
            // The ceiling counts DECODED bytes, so a small compressed body
            // cannot expand past it.
            chunks.push(chunk.subarray(0, room));
            size += room;
            truncated = true;
            response.destroy();
            decoder?.destroy();
            done();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on("end", done);
        stream.on("error", (error: Error) => {
          // What was read before a broken stream is still what was read.
          if (truncated || chunks.length > 0) done();
          else finish(() => reject(error));
        });
        response.on("error", (error: Error) => {
          if (truncated) return;
          if (chunks.length > 0) done();
          else finish(() => reject(error));
        });
      }
    );

    req.on("error", (error: Error) => finish(() => reject(error)));
    req.end();
  });

// ---------------------------------------------------------------------------

export class PublicPageFetcher {
  private readonly policy: NavigationPolicyConfig;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly transport: PageTransport;
  private readonly now: () => Date;

  constructor(config: PublicPageFetcherConfig) {
    this.policy = config.policy;
    this.timeoutMs = config.timeoutMs ?? PAGE_FETCH_DEFAULT_TIMEOUT_MS;
    this.maxBytes = config.maxBytes ?? PAGE_FETCH_DEFAULT_MAX_BYTES;
    this.maxRedirects = config.maxRedirects ?? PAGE_FETCH_DEFAULT_MAX_REDIRECTS;
    this.transport = config.transport ?? nodePageTransport;
    this.now = config.now ?? (() => new Date());
  }

  /**
   * Read one page.
   *
   * Resolves with the page whatever its HTTP status — a 404 page is still a
   * page, and its status is part of what an audit reports. Rejects with a
   * `PageFetchError` when no page could be read at all.
   */
  async fetch(rawUrl: unknown, options: { signal?: AbortSignal } = {}): Promise<FetchedPage> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;

    try {
      let current: unknown = rawUrl;
      let requestedUrl: string | null = null;
      let redirects = 0;

      for (;;) {
        // The initial address AND every hop after it. A decision is only
        // valid for the exact URL it was made about.
        const decision = await validateNavigationTarget(current, this.policy);
        if (!decision.allowed) {
          throw new PageFetchError(
            "URL_NOT_ALLOWED",
            redirects === 0
              ? DENY_MESSAGES[decision.reason]
              : `The page redirected somewhere JARVIS does not open. ${DENY_MESSAGES[decision.reason]}`,
            decision.reason
          );
        }
        if (requestedUrl === null) requestedUrl = decision.url;
        if (signal.aborted) throw this.abortError(options.signal);

        const url = new URL(decision.url);
        let response: PageTransportResponse;
        try {
          response = await this.transport({
            url,
            // The first address the policy judged — and the policy has already
            // refused the host if ANY of its addresses was not public.
            address: decision.addresses[0]!,
            headers: {
              "user-agent": PAGE_FETCH_USER_AGENT,
              accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
              "accept-language": "en,*;q=0.5",
              "accept-encoding": "gzip, deflate, br",
            },
            signal,
            maxBytes: this.maxBytes,
          });
        } catch (error) {
          if (signal.aborted) throw this.abortError(options.signal);
          if (error instanceof PageFetchError) throw error;
          throw new PageFetchError("NETWORK_ERROR", "The page could not be reached.");
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers["location"];
          if (!location) throw new PageFetchError("BAD_REDIRECT", "The page redirected without saying where to.");
          redirects += 1;
          if (redirects > this.maxRedirects) {
            throw new PageFetchError("TOO_MANY_REDIRECTS", "The page redirected too many times.");
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw new PageFetchError("BAD_REDIRECT", "The page redirected to an address that could not be read.");
          }
          current = next.toString();
          continue;
        }

        const contentType = response.headers["content-type"] ?? null;
        if (!isHtmlContentType(contentType)) {
          throw new PageFetchError("NOT_HTML", "That address is not a web page (it is not an HTML document).");
        }

        return {
          requestedUrl,
          finalUrl: decision.url,
          httpStatus: response.status,
          contentType,
          html: decodeBody(response.body, contentType),
          bytes: response.body.byteLength,
          truncated: response.truncated,
          redirects,
          fetchedAt: this.now().toISOString(),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private abortError(callerSignal: AbortSignal | undefined): PageFetchError {
    return callerSignal?.aborted
      ? new PageFetchError("ABORTED", "Reading the page was cancelled.")
      : new PageFetchError("TIMEOUT", "The page took too long to answer.");
  }
}
