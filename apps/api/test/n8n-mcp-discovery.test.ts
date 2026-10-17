// ---------------------------------------------------------------------------
// Phase 16, Stage 1 — GET /api/v1/n8n/mcp/tools
//
// These tests drive the router directly (its `stack`), the pattern the other
// route suites use. They never reach a network: the connector is injected, so a
// "discovery" is whatever the test says it is.
//
// What is held here, and why each matters:
//   • authz — the route is a session route; an MCP token is not a session.
//   • the projection — names and annotation flags only; a description or an
//     input schema must never leave.
//   • absent connector — reported, not 404-route-missing, and never built.
//   • upstream failure — reported as a fixed sentence and a category, never as
//     the server's own text (which can echo a header back).
//   • no invocation — `invokeTool` is never reached by a discovery request.
//   • credential separation — discovery needs no REST credentials at all, and
//     the response carries no secret.
//   • the limiter — a budget of its own, counted by its own namespace.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Response } from "express";
import { createN8nMcpRouter } from "../src/routes/n8n-mcp.js";
import type { N8nMcpConnector, N8nMcpDiscovery, N8nMcpResult } from "@jarvis/n8n";
import type { McpFailure } from "@jarvis/core";
import type { Container } from "../src/services/container.js";

interface CapturedResponse {
  status: number;
  body: Record<string, unknown>;
}

function fakeRes(): { res: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: {} };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

const AUTH = { userId: "user-42", role: "owner", email: "o@test.local" };

/** A discovered tool that carries everything the route must NOT return. */
function richTool(overrides: Partial<N8nMcpDiscovery["tools"][number]> = {}) {
  return {
    name: "send_email",
    description: "INTERNAL ONLY: posts to smtp://mail.corp.example",
    inputSchema: { type: "object", properties: { to: { type: "string" } } },
    readOnly: false,
    destructive: true,
    ...overrides,
  };
}

function stubConnector(options: {
  discovery?: N8nMcpResult<N8nMcpDiscovery>;
} = {}): { connector: N8nMcpConnector; calls: { discover: number; invoke: number } } {
  const calls = { discover: 0, invoke: 0 };
  const discovery: N8nMcpResult<N8nMcpDiscovery> =
    options.discovery ?? {
      ok: true,
      data: {
        tools: [richTool(), richTool({ name: "list_sheets", readOnly: true, destructive: false })],
        serverInfo: { name: "n8n MCP Server", version: "1.2.0" },
        truncated: false,
      },
    };
  const connector: N8nMcpConnector = {
    endpoint: "https://n8n.example.com/mcp-server/http",
    async discoverTools(): Promise<N8nMcpResult<N8nMcpDiscovery>> {
      calls.discover += 1;
      return discovery;
    },
    async invokeTool() {
      calls.invoke += 1;
      return { ok: true, content: [] };
    },
    async close() {
      /* nothing */
    },
  };
  return { connector, calls };
}

interface ContainerSlice {
  tokenService: { verifyAccessToken: (t: string) => unknown };
  auditLogger: {
    log: (entry: unknown) => Promise<void>;
    query: (q: {
      userId: string;
      startDate: Date;
      endDate: Date;
    }) => Promise<Array<{ action: string; userId: string }>>;
  };
}

function buildContainer(opts: {
  priorAuditActions?: string[];
  verifyToken?: (token: string) => unknown;
} = {}): { container: Container; audit: unknown[]; queries: unknown[] } {
  const audit: unknown[] = [];
  const queries: unknown[] = [];
  const slice: ContainerSlice = {
    tokenService: {
      verifyAccessToken: opts.verifyToken ?? (() => AUTH),
    },
    auditLogger: {
      log: async (entry: unknown) => {
        audit.push(entry);
      },
      query: async (q) => {
        queries.push(q);
        return (opts.priorAuditActions ?? []).map((action) => ({
          action,
          userId: AUTH.userId,
        }));
      },
    },
  };
  return { container: slice as unknown as Container, audit, queries };
}

/**
 * Phase 17 Stage 3A — the connection now belongs to an Organization, read on
 * every request. These Phase 16 tests are about discovery itself, so they run
 * as an owner of the Organization that owns the connection; the organization
 * rules have their own suite (n8n-mcp-authz-p17.test.ts).
 */
const OWNING_ORG_TENANCY = {
  async findConnectorOwner() {
    return { status: "assigned" as const, tenantId: "tenant-owning-org" };
  },
  async findMembership(userId: string, tenantId: string) {
    return userId === AUTH.userId && tenantId === "tenant-owning-org" ? { role: "owner" as const } : null;
  },
};

/**
 * Runs one request through the router without an HTTP server.
 *
 * With `auth`, the terminal handler runs (middleware skipped — its own concern).
 * Without it, the real auth middleware runs, so the unauthenticated path is the
 * production one.
 */
async function invoke(
  container: Container,
  deps: Parameters<typeof createN8nMcpRouter>[1],
  auth: { userId: string; role: string; email: string } | null,
  headers: Record<string, string> = {},
  path = "/tools"
): Promise<CapturedResponse> {
  const router = createN8nMcpRouter(container, { tenancy: OWNING_ORG_TENANCY, ...deps });
  const layer = (
    router as unknown as {
      stack: Array<{
        route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> };
      }>;
    }
  ).stack.find((l) => l.route?.path === path && l.route.methods.get);
  if (!layer?.route) throw new Error(`No GET ${path} route`);

  const { res, captured } = fakeRes();
  const req = {
    method: "GET",
    url: path,
    path,
    params: {},
    query: {},
    headers,
    get: (h: string) => headers[h],
    auth: auth ?? undefined,
  } as never;

  const handlers = layer.route.stack.map((s) => s.handle);
  const handler = auth ? handlers[handlers.length - 1]! : handlers[0]!;
  await handler(req, res, () => undefined);
  return captured;
}

describe("Phase 16 Stage 1 — n8n MCP discovery route", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requires a JARVIS session, not an n8n MCP token", async () => {
    const { container } = buildContainer({
      // An MCP bearer token resolves to no JARVIS session.
      verifyToken: () => null,
    });
    const { connector, calls } = stubConnector();

    const res = await invoke(
      container,
      { getConnector: () => connector },
      null,
      { authorization: "Bearer n8n-mcp-personal-access-token" }
    );

    expect(res.status).toBe(401);
    expect((res.body.error as { code: string }).code).toBe("AUTHENTICATION_REQUIRED");
    // The route body never ran: discovery was not attempted with an unverified
    // caller.
    expect(calls.discover).toBe(0);
  });

  it("returns names and annotation flags only — never a description or schema", async () => {
    const { container } = buildContainer();
    const { connector } = stubConnector();

    const res = await invoke(container, { getConnector: () => connector }, AUTH);

    expect(res.status).toBe(200);
    const data = res.body.data as {
      server: { name: string; version: string } | null;
      truncated: boolean;
      count: number;
      tools: Array<{ name: string; readOnly: boolean; destructive: boolean }>;
    };
    expect(data.server).toEqual({ name: "n8n MCP Server", version: "1.2.0" });
    expect(data.count).toBe(2);
    expect(data.tools).toEqual([
      { name: "send_email", readOnly: false, destructive: true },
      { name: "list_sheets", readOnly: true, destructive: false },
    ]);

    // The withheld material is absent from the serialized body, not merely
    // from a field: a description or a schema anywhere would fail this.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("INTERNAL ONLY");
    expect(serialized).not.toContain("smtp://");
    expect(serialized).not.toContain("inputSchema");
    expect(serialized).not.toContain("properties");
  });

  it("reports an absent connector as MCP_NOT_CONFIGURED and builds nothing", async () => {
    const { container, audit } = buildContainer();

    const res = await invoke(container, { getConnector: () => null }, AUTH);

    expect(res.status).toBe(404);
    expect((res.body.error as { code: string }).code).toBe("MCP_NOT_CONFIGURED");
    expect(audit).toHaveLength(1);
    expect((audit[0] as { action: string }).action).toBe("n8n_mcp.discover");
    expect((audit[0] as { result: string }).result).toBe("failure");
  });

  it("carries the failure category, never the server's own text", async () => {
    const { container, audit } = buildContainer();
    const failure: McpFailure = {
      code: "AUTH_FAILURE",
      // A hostile upstream string that must not reach the client.
      message: "raw upstream: Authorization: Bearer sk-super-secret-token",
    };
    const { connector } = stubConnector({ discovery: { ok: false, failure } });

    const res = await invoke(container, { getConnector: () => connector }, AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({
      code: "MCP_AUTH_FAILURE",
      message: "The n8n MCP server refused JARVIS's configured credentials.",
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("sk-super-secret-token");
    expect(serialized).not.toContain("raw upstream");
    expect((audit[0] as { metadata: { reason?: string } }).metadata.reason).toBe("AUTH_FAILURE");
  });

  it("maps a rate-limited upstream to 503 without a write", async () => {
    const { container } = buildContainer();
    const { connector } = stubConnector({
      discovery: { ok: false, failure: { code: "RATE_LIMITED", message: "x" } },
    });

    const res = await invoke(container, { getConnector: () => connector }, AUTH);
    expect(res.status).toBe(503);
    expect((res.body.error as { code: string }).code).toBe("MCP_RATE_LIMITED");
  });

  it("never invokes a tool — discovery is read-only", async () => {
    const { container } = buildContainer();
    const { connector, calls } = stubConnector();

    const res = await invoke(container, { getConnector: () => connector }, AUTH);

    expect(res.status).toBe(200);
    expect(calls.discover).toBe(1);
    expect(calls.invoke).toBe(0);
  });

  it("succeeds with no REST credentials at all — the surfaces are independent", async () => {
    // The container slice has only a token service and an audit logger. There is
    // no N8N_API_KEY, no REST client, no base URL. Discovery still answers,
    // which is the point: the MCP surface does not route through the REST key.
    const { container } = buildContainer();
    const { connector } = stubConnector();

    const res = await invoke(container, { getConnector: () => connector }, AUTH);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("api-key");
  });

  it("meters discovery under its own namespace and refuses when exhausted", async () => {
    const { container } = buildContainer({
      priorAuditActions: Array.from({ length: 30 }, () => "n8n_mcp.discover"),
    });
    const { connector, calls } = stubConnector();

    const res = await invoke(container, { getConnector: () => connector }, AUTH);

    expect(res.status).toBe(429);
    expect((res.body.error as { code: string }).code).toBe("RATE_LIMITED");
    // Refused BEFORE the connector was touched.
    expect(calls.discover).toBe(0);
  });

  it("is not throttled by another namespace's rows", async () => {
    const { container } = buildContainer({
      priorAuditActions: Array.from({ length: 30 }, () => "approval.list"),
    });
    const { connector } = stubConnector();

    const res = await invoke(container, { getConnector: () => connector }, AUTH);
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Stage 2 — GET /automations, the unified read-only view
  // -------------------------------------------------------------------------
  describe("GET /automations", () => {
    it("returns provenance, and says the REST surface was unread rather than empty", async () => {
      const { container, audit } = buildContainer();
      const { connector, calls } = stubConnector();

      const res = await invoke(
        container,
        { getConnector: () => connector },
        AUTH,
        {},
        "/automations"
      );

      expect(res.status).toBe(200);
      const data = res.body.data as {
        providerId: string;
        count: number;
        records: Array<Record<string, unknown>>;
        sources: {
          rest: { available: boolean; reason: string | null; count: number };
          mcp: { available: boolean; reason: string | null; count: number };
        };
      };

      expect(data.providerId).toBe("n8n");
      expect(data.count).toBe(2);
      // Every record carries its source: MCP-only, no invented REST rows.
      expect(data.records.every((r) => (r.observedVia as string[]).join(",") === "mcp")).toBe(
        true
      );
      // The withheld provider prose does not reappear through the view.
      expect(JSON.stringify(res.body)).not.toContain("INTERNAL ONLY");
      expect(data.records[0]).not.toHaveProperty("description");
      expect(data.records[0]).not.toHaveProperty("inputSchema");

      // REST: present but unread, with a reason and a zero count — distinct from
      // "read and there is nothing there".
      expect(data.sources.rest.available).toBe(false);
      expect(data.sources.rest.reason).toBeTypeOf("string");
      expect(data.sources.rest.reason).not.toBe("");
      expect(data.sources.rest.count).toBe(0);
      expect(data.sources.mcp).toEqual({
        connector: "mcp",
        available: true,
        reason: null,
        count: 2,
      });

      // The view is read-only: discovery happened, invocation did not.
      expect(calls.discover).toBe(1);
      expect(calls.invoke).toBe(0);
      expect(audit).toHaveLength(1);
      expect((audit[0] as { action: string }).action).toBe("n8n_mcp.catalog");
    });

    it("requires a JARVIS session", async () => {
      const { container } = buildContainer({ verifyToken: () => null });
      const { connector, calls } = stubConnector();

      const res = await invoke(
        container,
        { getConnector: () => connector },
        null,
        { authorization: "Bearer n8n-mcp-personal-access-token" },
        "/automations"
      );

      expect(res.status).toBe(401);
      expect(calls.discover).toBe(0);
    });

    it("reports an absent connector instead of returning an empty view", async () => {
      const { container } = buildContainer();

      const res = await invoke(container, { getConnector: () => null }, AUTH, {}, "/automations");

      expect(res.status).toBe(404);
      expect((res.body.error as { code: string }).code).toBe("MCP_NOT_CONFIGURED");
    });

    it("keeps a budget separate from discovery", async () => {
      const { container } = buildContainer({
        priorAuditActions: Array.from({ length: 30 }, () => "n8n_mcp.discover"),
      });
      const { connector, calls } = stubConnector();

      const res = await invoke(
        container,
        { getConnector: () => connector },
        AUTH,
        {},
        "/automations"
      );

      expect(res.status).toBe(200);
      expect(calls.invoke).toBe(0);
    });

    it("is throttled under its own namespace, before discovery", async () => {
      const { container } = buildContainer({
        priorAuditActions: Array.from({ length: 30 }, () => "n8n_mcp.catalog"),
      });
      const { connector, calls } = stubConnector();

      const res = await invoke(
        container,
        { getConnector: () => connector },
        AUTH,
        {},
        "/automations"
      );

      expect(res.status).toBe(429);
      expect(calls.discover).toBe(0);
    });
  });
});
