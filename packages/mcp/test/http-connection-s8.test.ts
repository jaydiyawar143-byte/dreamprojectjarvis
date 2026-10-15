import { describe, it, expect } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { HttpMcpConnection, MCP_HTTP_BOUNDS } from "../src/http-connection.js";

// ---------------------------------------------------------------------------
// HttpMcpConnection — transport contract and safety
//
// The fake fetch emulates the MCP Streamable HTTP transport: JSON-RPC over POST,
// an initialize handshake, and JSON responses. It never touches a socket, so the
// tests assert:
//
//  1. SSRF: HTTPS only, no embedded credentials, allowedOrigins containment.
//  2. Discovery and invocation: listTools accumulates tools, bounds the listing
//     and normalizes the server's own answer.
//  3. Error mapping: HTTP statuses and JSON-RPC error codes both map to the
//     credential-free failure vocabulary.
//
// ROUTING IS BY JSON-RPC METHOD, NOT BY CALL ORDER. After the initialized
// notification a real server may open a GET SSE stream, so an index-based script
// hands its response to the wrong request. Method-based routing is what makes
// these tests deterministic.
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: JsonRpcRequest | null;
}

type Handler = (req: Captured) => Response | Promise<Response>;

function createFakeFetch(handlers: Record<string, Handler>): { fetch: (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit | undefined).entries()) as Record<string, string>;

    let body: JsonRpcRequest | null = null;
    if (init?.body) {
      try {
        const raw = typeof init.body === "string" ? init.body : await new Response(init.body).text();
        body = JSON.parse(raw) as JsonRpcRequest;
      } catch {
        body = null;
      }
    }

    const captured: Captured = { url, method, headers, body };
    calls.push(captured);

    if (method !== "POST") {
      // The transport's optional GET SSE. Modelled as "not offered" so no
      // long-lived stream keeps the test process alive.
      return new Response(null, { status: 405 });
    }
    const key = body?.method ?? "";
    const handler = handlers[key];
    if (!handler) return new Response("{}", { status: 501 });
    return handler(captured);
  };
  return { fetch, calls };
}

function jsonResult(req: Captured, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.body?.id, result }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonError(req: Captured, error: { code: number; message: string }): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.body?.id, error }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function httpError(status: number): Response {
  return new Response("{}", { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const SERVER_INFO = { name: "n8n-mcp", version: "1.0.0" };

const initializeResult = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: SERVER_INFO,
};

/**
 * The standard two-step handshake plus `tools/list` and `tools/call`, unless a
 * test overrides one. `notifications/initialized` answers 200 rather than 202:
 * a 202 makes the SDK open a GET SSE stream, which a fixed fake cannot serve
 * without keeping the process alive. Both are legal; 200 keeps the fake honest
 * about only what it can answer.
 */
function baseHandlers(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    initialize: (req) => jsonResult(req, initializeResult),
    "notifications/initialized": (req) => jsonResult(req, {}),
    "tools/list": (req) => jsonResult(req, { tools: [] }),
    "tools/call": (req) => jsonResult(req, { content: [{ type: "text", text: "done" }] }),
    ...extra,
  };
}

describe("HttpMcpConnection — SSRF validation", () => {
  it("refuses non-HTTPS endpoints", () => {
    expect(() => new HttpMcpConnection({ url: "http://example.com/mcp" })).toThrow(/https/i);
  });

  it("refuses endpoints that embed credentials", () => {
    expect(() => new HttpMcpConnection({ url: "https://user:pass@example.com/mcp" })).toThrow(/credentials/i);
  });

  it("confines the endpoint to the allowed origins set", () => {
    expect(
      () => new HttpMcpConnection({ url: "https://other.example.com/mcp", allowedOrigins: ["https://example.com"] })
    ).toThrow(/outside the configured allowed origins/i);
  });

  it("accepts an HTTPS endpoint whose origin is in the allow-list", () => {
    expect(
      () => new HttpMcpConnection({ url: "https://example.com/mcp", allowedOrigins: ["https://example.com"] })
    ).not.toThrow();
  });

  it("never puts the token in the URL — only in headers", async () => {
    const { fetch, calls } = createFakeFetch(baseHandlers());
    const conn = new HttpMcpConnection({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret-token" },
      fetch,
    });
    await conn.listTools();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).not.toContain("secret-token");
      expect(call.headers.authorization).toBe("Bearer secret-token");
    }
  });
});

describe("HttpMcpConnection — discovery and invocation", () => {
  it("connects, lists tools and invokes a discovered tool", async () => {
    const tools = [
      { name: "run_workflow", description: "Run", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: "list_workflows", description: "List", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    ];
    const { fetch, calls } = createFakeFetch(baseHandlers({ "tools/list": (req) => jsonResult(req, { tools }) }));

    const conn = new HttpMcpConnection({ url: "https://example.com/mcp-server/http", fetch });
    const list = await conn.listTools();

    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.tools).toHaveLength(2);
    expect(list.data.serverInfo).toEqual(SERVER_INFO);
    expect(list.data.truncated).toBe(false);
    expect(list.data.tools[0]).toMatchObject({ name: "run_workflow", readOnly: false, destructive: true });
    expect(list.data.tools[1]).toMatchObject({ name: "list_workflows", readOnly: true, destructive: false });

    const call = await conn.callTool("run_workflow", { id: "42" });
    expect(call.ok).toBe(true);
    if (!call.ok) return;
    expect(call.content).toEqual([{ type: "text", text: "done" }]);

    // The invocation carried the caller's arguments, unchanged.
    const callRequest = [...calls].reverse().find((c) => c.body?.method === "tools/call");
    expect(callRequest).toBeDefined();
    expect((callRequest!.body!.params as Record<string, unknown>).arguments).toEqual({ id: "42" });
  });

  it("marks a listing truncated at the tool ceiling", async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object", properties: {} }, annotations: {} }));
    const { fetch } = createFakeFetch(baseHandlers({ "tools/list": (req) => jsonResult(req, { tools, nextCursor: "more" }) }));

    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch, maxListedTools: 2 });
    const list = await conn.listTools();

    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.tools).toHaveLength(2);
    expect(list.data.truncated).toBe(true);
  });

  it("follows pagination until the cursor runs out", async () => {
    const { fetch, calls } = createFakeFetch(
      baseHandlers({
        "tools/list": (req) => {
          const cursor = (req.body?.params as { cursor?: string } | undefined)?.cursor;
          return cursor === "page-2"
            ? jsonResult(req, { tools: [{ name: "second", inputSchema: { type: "object", properties: {} }, annotations: {} }] })
            : jsonResult(req, { tools: [{ name: "first", inputSchema: { type: "object", properties: {} }, annotations: {} }], nextCursor: "page-2" });
        },
      })
    );

    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch });
    const list = await conn.listTools();

    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.tools.map((t) => t.name)).toEqual(["first", "second"]);
    expect(list.data.truncated).toBe(false);
    expect(calls.filter((c) => c.body?.method === "tools/list")).toHaveLength(2);
  });

  it("skips a repeated or mis-named tool instead of surfacing a phantom", async () => {
    // The SDK validates the listing against its own schema FIRST (a nameless
    // entry is rejected there), so what reaches our normalizer is schema-valid
    // but still unusable: a repeated name, and one that is not a plain
    // identifier. Both are dropped rather than surfaced.
    const tools = [
      { name: "good", description: "ok", inputSchema: { type: "object", properties: {} }, annotations: {} },
      { name: "good", description: "duplicate", inputSchema: { type: "object", properties: {} }, annotations: {} },
      { name: "bad name with spaces", inputSchema: { type: "object", properties: {} }, annotations: {} },
    ];
    const { fetch } = createFakeFetch(baseHandlers({ "tools/list": (req) => jsonResult(req, { tools }) }));

    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch });
    const list = await conn.listTools();

    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.tools.map((t) => t.name)).toEqual(["good"]);
  });

  it("rejects a tool name that is not a plain identifier", async () => {
    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch: async () => new Response() });
    const bad = await conn.callTool("bad name/../", {});
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.failure.code).toBe("INVALID_ARGUMENTS");
  });

  it("reports a tool-level error as REMOTE_ERROR without the server's text", async () => {
    const { fetch } = createFakeFetch(
      baseHandlers({ "tools/call": (req) => jsonResult(req, { isError: true, content: [{ type: "text", text: "secret detail" }] }) })
    );
    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch });
    const call = await conn.callTool("t", {});
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.failure.code).toBe("REMOTE_ERROR");
    expect(call.failure.message).not.toContain("secret detail");
  });
});

describe("HttpMcpConnection — error mapping", () => {
  it("maps HTTP 401 on connect to AUTH_FAILURE", async () => {
    const { fetch } = createFakeFetch({ initialize: () => httpError(401) });
    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch });
    const list = await conn.listTools();
    expect(list.ok).toBe(false);
    if (list.ok) return;
    expect(list.failure.code).toBe("AUTH_FAILURE");
  });

  it("maps HTTP 429 on a call to RATE_LIMITED", async () => {
    const { fetch } = createFakeFetch(baseHandlers({ "tools/call": () => httpError(429) }));
    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch });
    const call = await conn.callTool("t", {});
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.failure.code).toBe("RATE_LIMITED");
  });

  it("maps HTTP 404 on a call to TOOL_NOT_FOUND", async () => {
    const { fetch } = createFakeFetch(baseHandlers({ "tools/call": () => httpError(404) }));
    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch });
    const call = await conn.callTool("missing", {});
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.failure.code).toBe("TOOL_NOT_FOUND");
  });

  it("maps a JSON-RPC MethodNotFound error to TOOL_NOT_FOUND", async () => {
    const { fetch } = createFakeFetch(
      baseHandlers({ "tools/call": (req) => jsonError(req, { code: ErrorCode.MethodNotFound, message: "no such tool" }) })
    );
    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch });
    const call = await conn.callTool("missing", {});
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.failure.code).toBe("TOOL_NOT_FOUND");
    expect(call.failure.message).not.toContain("no such tool");
  });

  it("maps HTTP 500 on connect to REMOTE_ERROR", async () => {
    const { fetch } = createFakeFetch({ initialize: () => httpError(500) });
    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch });
    const list = await conn.listTools();
    expect(list.ok).toBe(false);
    if (list.ok) return;
    expect(list.failure.code).toBe("REMOTE_ERROR");
  });

  it("reports the endpoint but never the token", async () => {
    const conn = new HttpMcpConnection({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer super-secret" },
      fetch: async () => new Response(),
    });
    expect(conn.url).toBe("https://example.com/mcp");
    expect(conn.url).not.toContain("super-secret");
  });
});

describe("HttpMcpConnection — bounds and lifecycle", () => {
  it("uses conservative bound constants", () => {
    expect(MCP_HTTP_BOUNDS.connectTimeoutMs).toBe(10_000);
    expect(MCP_HTTP_BOUNDS.callTimeoutMs).toBe(30_000);
    expect(MCP_HTTP_BOUNDS.maxListedTools).toBe(200);
    expect(MCP_HTTP_BOUNDS.maxListPages).toBe(10);
  });

  it("clamps caller-supplied bounds rather than trusting them", async () => {
    const { fetch } = createFakeFetch(baseHandlers());
    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch, connectTimeoutMs: 0, maxListedTools: -5 });
    await conn.listTools();
    expect(conn.isReady()).toBe(true);
  });

  it("closes idempotently and never throws", async () => {
    const { fetch } = createFakeFetch(baseHandlers());
    const conn = new HttpMcpConnection({ url: "https://example.com/mcp", fetch });
    await conn.listTools();
    await conn.close();
    await conn.close();
    expect(conn.isReady()).toBe(false);
  });
});
