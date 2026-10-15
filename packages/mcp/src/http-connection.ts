// ---------------------------------------------------------------------------
// The MCP Streamable-HTTP connector.
//
// The stdio runtime in `connection.ts` is for LOCAL, REVIEWED servers: a process
// JARVIS spawns, whose whole tool listing is pinned in MCP_MANIFEST and whose
// every tool must match a fingerprint or the server is disabled.
//
// A REMOTE MCP server is neither. n8n Cloud's MCP endpoint is an HTTPS service
// reached with a bearer token, and the tools it lists are the workflows that
// exist at that moment — there is no review to pin them to. Forcing them through
// the reviewed-manifest path would mean either inventing fingerprints (a lie) or
// loosening the stdio contract (a hole). So this is a SECOND transport, and it
// stays honest about what it is: a DISCOVERY-AND-INVOKE client. `listTools()`
// returns what the server listed, marked as discovered; it never claims a tool
// was reviewed. Invocation is the caller's to gate — this returns the result, and
// the approval boundary for anything that writes lives above it, exactly as for
// every other external side effect.
//
// It is the only other place in the repository that touches the MCP SDK, kept in
// packages/mcp beside the stdio runtime for that reason.
//
// SESSION AND NEGOTIATION are the SDK's: `StreamableHTTPClientTransport` performs
// the MCP initialize handshake, negotiates the protocol version and echoes the
// server's `Mcp-Session-Id` on later requests. This module does not re-implement
// either — a hand-rolled session header is exactly the kind of thing that works
// until it does not.
//
// THREE PROPERTIES, all deliberate:
//
//  1. THE TOKEN TRAVELS IN A HEADER, NEVER A URL. The caller builds the header
//     map; this module forwards it to the transport and never puts it in a
//     query, a log or an error message. Failures are the fixed sentences core
//     maps a code to — never the server's text, which can echo a header back.
//
//  2. THE URL IS VALIDATED BEFORE ANY SOCKET OPENS. HTTPS only, no embedded
//     credentials, and — when the caller supplies an allow-list — confined to
//     it. A remote MCP endpoint is an SSRF target otherwise.
//
//  3. EVERY WAIT IS BOUNDED. Connect, one call and one page each carry a fixed
//     timeout, and the listing is capped in both pages and tools, so a server
//     that answers forever cannot exhaust the caller.
// ---------------------------------------------------------------------------

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { mcpFailure, type McpCallResult, type McpFailure } from "@jarvis/core";
import { failureFromError, normalizeCallResult } from "./normalize.js";

/** Fixed, conservative bounds. Nothing here is configured at runtime. */
export const MCP_HTTP_BOUNDS = Object.freeze({
  /** Spawn, initialize and the handshake — all of it. */
  connectTimeoutMs: 10_000,
  /** One `tools/call`. The caller's own deadline is the authority above it. */
  callTimeoutMs: 30_000,
  /** tools/list pages read before a listing counts as runaway… */
  maxListPages: 10,
  /** …and tools it may hold across them. */
  maxListedTools: 200,
});

/** A discovered tool. `readOnly` is the server's own HINT, never a permission. */
export interface HttpMcpTool {
  name: string;
  description: string | null;
  /** The tool's declared input schema, or null when it did not declare one. */
  inputSchema: Readonly<Record<string, unknown>> | null;
  /** From the tool's annotations. Advisory only — a hint is not a guarantee. */
  readOnly: boolean;
  destructive: boolean;
}

/** The subset of `fetch` the transport calls. Injectable so tests need no network. */
export type McpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpMcpServerInfo {
  name: string;
  version: string;
}

export interface HttpMcpConnectionOptions {
  /** The MCP endpoint. Must be HTTPS, with no embedded credentials. */
  url: string | URL;
  /**
   * Extra request headers — a caller's `Authorization: Bearer …`. Forwarded to
   * the transport verbatim and never recorded. The transport adds its own
   * `Accept`, `Content-Type` and `Mcp-Session-Id` headers on top.
   */
  headers?: Readonly<Record<string, string>>;
  /** Origins the endpoint must belong to, when the caller wants containment. */
  allowedOrigins?: readonly string[];
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxListPages?: number;
  maxListedTools?: number;
  /** Reported to the server during initialize. */
  clientInfo?: { name: string; version: string };
  /**
   * Overrides `fetch`. Used by tests to drive the transport without a socket;
   * production leaves it unset and the transport uses the global fetch.
   */
  fetch?: McpFetch;
}

export type HttpMcpResult<T> = { ok: true; data: T } | { ok: false; failure: McpFailure };

export interface HttpMcpListing {
  tools: readonly HttpMcpTool[];
  serverInfo: HttpMcpServerInfo | null;
  /** True when the page or tool ceiling was reached before the listing ended. */
  truncated: boolean;
}

/** The default client identity JARVIS reports to a remote MCP server. */
const DEFAULT_CLIENT_INFO = { name: "jarvis", version: "1.0.0" } as const;

/** MCP tool names are plain identifiers; a name that is not one is refused. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function clamp(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  const whole = Math.trunc(raw);
  return whole < 1 ? 1 : whole;
}

/**
 * Validates the endpoint before a socket opens.
 *
 * HTTPS only: a bearer token over cleartext is a token in the clear. No
 * embedded credentials: `https://user:pass@host` would put a secret somewhere
 * the transport, proxies and error messages can surface. When `allowedOrigins`
 * is given, the endpoint must be one of them, so a configuration mistake cannot
 * aim JARVIS at an arbitrary host.
 */
function resolveEndpoint(raw: string | URL, allowedOrigins: readonly string[] | undefined): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? new URL(raw.toString()) : new URL(raw);
  } catch {
    throw new Error("MCP endpoint is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("MCP endpoint must use https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("MCP endpoint must not embed credentials");
  }
  if (allowedOrigins && allowedOrigins.length > 0 && !allowedOrigins.includes(url.origin)) {
    throw new Error("MCP endpoint is outside the configured allowed origins");
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeTool(live: unknown): HttpMcpTool | null {
  if (!isRecord(live)) return null;
  const name = nonEmptyString(live.name);
  if (name === null || !TOOL_NAME.test(name)) return null;
  const annotations = isRecord(live.annotations) ? live.annotations : {};
  return {
    name,
    description: nonEmptyString(live.description),
    inputSchema: isRecord(live.inputSchema) ? live.inputSchema : null,
    readOnly: annotations.readOnlyHint === true,
    destructive: annotations.destructiveHint === true,
  };
}

function normalizeServerInfo(client: Client): HttpMcpServerInfo | null {
  const version = client.getServerVersion();
  if (!isRecord(version)) return null;
  const name = nonEmptyString(version.name);
  const v = nonEmptyString(version.version);
  return name !== null && v !== null ? { name, version: v } : null;
}

/**
 * An HTTP status on a transport error, if there is one. The SDK reports a
 * non-2xx with `StreamableHTTPError`, whose `code` is the status.
 */
function httpStatus(error: unknown): number | null {
  if (error instanceof StreamableHTTPError && typeof error.code === "number") {
    return error.code;
  }
  // Some SDK versions throw a different error shape; be defensive.
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.code === "number" && Number.isInteger(e.code)) return e.code;
    const resp = e.response as Record<string, unknown> | undefined;
    if (resp && typeof resp.status === "number") return resp.status;
    const cause = e.cause as unknown;
    if (cause && typeof cause === "object") {
      const c = cause as Record<string, unknown>;
      if (typeof c.code === "number" && Number.isInteger(c.code)) return c.code;
      const cresp = c.response as Record<string, unknown> | undefined;
      if (cresp && typeof cresp.status === "number") return cresp.status;
    }
  }
  return null;
}

/** Map a thrown remote error to a failure code, without ever keeping its text. */
function failureFromRemote(error: unknown, phase: "connect" | "call"): McpFailure {
  if (error instanceof UnauthorizedError) return mcpFailure("AUTH_FAILURE");
  const status = httpStatus(error);
  if (status !== null) {
    if (status === 401 || status === 403) return mcpFailure("AUTH_FAILURE");
    if (status === 429) return mcpFailure("RATE_LIMITED");
    if (status === 404) return mcpFailure(phase === "connect" ? "SERVER_UNAVAILABLE" : "TOOL_NOT_FOUND");
    if (status >= 500) return mcpFailure("REMOTE_ERROR");
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return mcpFailure("TIMEOUT");
  }
  // A cancellation the caller caused is CANCELLED; the SDK reports an abort and
  // a timeout with the same shape, so the caller's signal decides — the code
  // above has already caught the SDK's own RequestTimeout.
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return mcpFailure("CANCELLED");
  }
  const failure = failureFromError(error, phase);
  // If we got this far with no specific match but it's an error from a transport
  // that may carry an HTTP status on its cause, check again defensively.
  const statusAgain = httpStatus(error);
  if (statusAgain !== null) {
    if (statusAgain === 401 || statusAgain === 403) return mcpFailure("AUTH_FAILURE");
    if (statusAgain === 429) return mcpFailure("RATE_LIMITED");
    if (statusAgain === 404) return mcpFailure(phase === "connect" ? "SERVER_UNAVAILABLE" : "TOOL_NOT_FOUND");
    if (statusAgain >= 500) return mcpFailure("REMOTE_ERROR");
  }
  // Fallback: if it's an HTTP-like error by shape (has response/status) treat by phase conservatively.
  const rootStatus = httpStatus(error);
  if (rootStatus !== null) {
    if (rootStatus === 401 || rootStatus === 403) return mcpFailure("AUTH_FAILURE");
    if (rootStatus === 429) return mcpFailure("RATE_LIMITED");
    if (rootStatus === 404) return mcpFailure(phase === "connect" ? "SERVER_UNAVAILABLE" : "TOOL_NOT_FOUND");
    if (rootStatus >= 500) return mcpFailure("REMOTE_ERROR");
  }
  return failure;
}

/**
 * A cancellation bound to BOTH the caller's signal and a timeout, so a server
 * that simply never answers cannot hold a request open forever.
 */
function deadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // `setTimeout` must not keep the process alive for the whole timeout window.
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
  const combined =
    typeof AbortSignal.any === "function" && signal
      ? AbortSignal.any([signal, controller.signal])
      : signal ?? controller.signal;
  return { signal: combined, clear: () => clearTimeout(timer) };
}

/**
 * One remote MCP server over Streamable HTTP.
 *
 * LAZY. Nothing is sent until `connect()` is first called; `listTools()` and
 * `callTool()` connect first if they must, so a caller cannot accidentally use
 * an un-initialized session.
 *
 * FAIL-CLOSED ON AUTH. A 401/403 is AUTH_FAILURE and never a retry — a bad token
 * is not a transient condition, and retrying it is how an account gets locked.
 */
export class HttpMcpConnection {
  private readonly endpoint: URL;
  private readonly headers: Record<string, string>;
  private readonly clientInfo: { name: string; version: string };
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly maxListPages: number;
  private readonly maxListedTools: number;
  private readonly fetchImpl: McpFetch | undefined;

  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private ready = false;

  constructor(options: HttpMcpConnectionOptions) {
    this.endpoint = resolveEndpoint(options.url, options.allowedOrigins);
    this.headers = { ...(options.headers ?? {}) };
    this.clientInfo = options.clientInfo ?? { ...DEFAULT_CLIENT_INFO };
    this.connectTimeoutMs = clamp(options.connectTimeoutMs, MCP_HTTP_BOUNDS.connectTimeoutMs);
    this.callTimeoutMs = clamp(options.callTimeoutMs, MCP_HTTP_BOUNDS.callTimeoutMs);
    this.maxListPages = clamp(options.maxListPages, MCP_HTTP_BOUNDS.maxListPages);
    this.maxListedTools = clamp(options.maxListedTools, MCP_HTTP_BOUNDS.maxListedTools);
    this.fetchImpl = options.fetch;
  }

  /** The endpoint this connection is confined to. Safe to log — no token in it. */
  get url(): string {
    return this.endpoint.toString();
  }

  isReady(): boolean {
    return this.ready;
  }

  async connect(signal?: AbortSignal): Promise<McpConnectResultLike> {
    if (this.ready && this.client) return { ok: true };

    const transport = new StreamableHTTPClientTransport(this.endpoint, {
      requestInit: { headers: this.headers },
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    const client = new Client(this.clientInfo, { capabilities: {} });

    const bound = deadline(signal, this.connectTimeoutMs);
    try {
      await client.connect(transport, { signal: bound.signal, timeout: this.connectTimeoutMs });
      this.client = client;
      this.transport = transport;
      this.ready = true;
      return { ok: true };
    } catch (error) {
      // A half-open session is discarded, never left for the next call to find.
      this.ready = false;
      this.client = null;
      this.transport = null;
      await transport.close().catch(() => undefined);
      return { ok: false, failure: failureFromRemote(error, "connect") };
    } finally {
      bound.clear();
    }
  }

  /**
   * Lists the tools the server exposes NOW. Bounded in pages and tools; a
   * listing that hits either ceiling comes back `truncated: true` rather than
   * pretending to be complete.
   */
  async listTools(signal?: AbortSignal): Promise<HttpMcpResult<HttpMcpListing>> {
    const connected = await this.connect(signal);
    if (!connected.ok) return connected;
    const client = this.client!;

    const tools: HttpMcpTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let truncated = false;

    const bound = deadline(signal, this.callTimeoutMs);
    try {
      for (let page = 0; page < this.maxListPages; page += 1) {
        const result = (await client.listTools(
          cursor ? { cursor } : undefined,
          { signal: bound.signal, timeout: this.callTimeoutMs }
        )) as { tools?: unknown; nextCursor?: unknown };

        const rawTools = Array.isArray(result.tools) ? result.tools : [];
        for (const raw of rawTools) {
          const tool = normalizeTool(raw);
          // An unusable or repeated tool is skipped, not surfaced as a phantom.
          if (tool === null || seen.has(tool.name)) continue;
          if (tools.length >= this.maxListedTools) {
            truncated = true;
            break;
          }
          seen.add(tool.name);
          tools.push(tool);
        }

        if (truncated) break;
        const next = nonEmptyString(result.nextCursor);
        if (next === null || next === cursor) break;
        
        cursor = next;
      }

      return {
        ok: true,
        data: { tools, serverInfo: normalizeServerInfo(client), truncated },
      };
    } catch (error) {
      return { ok: false, failure: failureFromRemote(error, "call") };
    } finally {
      bound.clear();
    }
  }

  /** Invokes one discovered tool by name. The caller owns the approval boundary. */
  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<McpCallResult> {
    if (typeof name !== "string" || !TOOL_NAME.test(name)) {
      return { ok: false, failure: mcpFailure("INVALID_ARGUMENTS") };
    }
    const connected = await this.connect(signal);
    if (!connected.ok) return connected;
    const client = this.client!;

    const bound = deadline(signal, this.callTimeoutMs);
    try {
      const result = await client.callTool(
        { name, arguments: { ...args } },
        undefined,
        { signal: bound.signal, timeout: this.callTimeoutMs }
      );
      return normalizeCallResult(result);
    } catch (error) {
      return { ok: false, failure: failureFromRemote(error, "call") };
    } finally {
      bound.clear();
    }
  }

  /** Ends the session, if one was opened. Idempotent and never throws. */
  async close(): Promise<void> {
    this.ready = false;
    const transport = this.transport;
    this.transport = null;
    this.client = null;
    if (transport) await transport.close().catch(() => undefined);
  }
}

/** `McpConnectResult` from core, restated locally to keep this file's imports small. */
type McpConnectResultLike = { ok: true } | { ok: false; failure: McpFailure };
