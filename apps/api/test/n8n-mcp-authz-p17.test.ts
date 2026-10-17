// ---------------------------------------------------------------------------
// Phase 17, Stages 2 and 3A — the n8n MCP read routes are authorized, from
// database state, before anything reaches the connector.
//
//   GET /api/v1/n8n/mcp/tools
//   GET /api/v1/n8n/mcp/automations
//
// Driven through the router's own stack, like n8n-mcp-discovery.test.ts. The
// connector and the organization reads are injected and count every call, so
// "never reached" is a counted fact, not an inference. What is held here:
//
//   • the connection belongs to the Organization an operator recorded; with no
//     owner, or an invalid one, everybody is refused;
//   • the role that counts is the caller's MEMBERSHIP in that Organization:
//     owner, admin and member are served read-only; a viewer is refused; an
//     account-wide owner or admin who is not a member is refused;
//   • a non-member gets one uniform answer, whatever the precise reason, and
//     the audit row keeps the reason but never a tenant id;
//   • ownership and membership are read on EVERY request — a change applies
//     to the very next one — and an unreadable read refuses, fail-closed;
//   • a request that names a tenant, organization, business, account,
//     workspace, owner, user, agent or operation is refused, never obeyed;
//   • no path invokes a tool or executes a workflow, and nothing reaches the
//     connector or the limiter after a refusal;
//   • the existing rate-limit, audit and safe-error behaviour is unchanged.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import type { Response } from "express";
import {
  authorizeN8nMcpRead,
  createN8nMcpRouter,
  N8N_MCP_ATTEMPT_LIMITS,
  N8N_MCP_CONNECTION_KEY,
  N8N_MCP_READ_OPERATIONS,
  N8N_MCP_ROUTE_OPERATIONS,
  type N8nMcpTenancy,
} from "../src/routes/n8n-mcp.js";
import type { N8nMcpConnector, N8nMcpDiscovery, N8nMcpResult } from "@jarvis/n8n";
import { SHARED_CONNECTOR_KEYS } from "@jarvis/core";
import type { AuthContext, ConnectorOwnerLookup, TenantMembershipContext, TenantRole } from "@jarvis/core";
import type { Container } from "../src/services/container.js";

// ---------------------------------------------------------------------------
// Fixtures — one Organization owns the connection; each account's membership
// role is stated here, apart from its account-wide role.
// ---------------------------------------------------------------------------

interface Captured {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

type Auth = { userId: string; role: string; email: string };

const ORG = "tenant-owner-org";
const OTHER_ORG = "tenant-other-org";

// Account-wide roles are deliberately unrelated to the membership roles.
const OWNER: Auth = { userId: "user-owner", role: "member", email: "o@test.local" };
const ADMIN: Auth = { userId: "user-admin", role: "member", email: "a@test.local" };
const MEMBER: Auth = { userId: "user-member", role: "member", email: "m@test.local" };
const VIEWER: Auth = { userId: "user-viewer", role: "member", email: "v@test.local" };
const OUTSIDER: Auth = { userId: "user-outsider", role: "member", email: "x@test.local" };
const PLATFORM_OWNER: Auth = { userId: "user-platform-owner", role: "owner", email: "po@test.local" };
const PLATFORM_ADMIN: Auth = { userId: "user-platform-admin", role: "admin", email: "pa@test.local" };

const PATHS = ["/tools", "/automations"] as const;
const BUCKET = { "/tools": "discover", "/automations": "catalog" } as const;

interface TenancyState {
  owner: ConnectorOwnerLookup;
  /** `${tenantId}:${userId}` → membership role */
  members: Map<string, TenantRole | string>;
  fail?: "owner" | "membership";
}

function defaultState(): TenancyState {
  return {
    owner: { status: "assigned", tenantId: ORG },
    members: new Map<string, TenantRole | string>([
      [`${ORG}:${OWNER.userId}`, "owner"],
      [`${ORG}:${ADMIN.userId}`, "admin"],
      [`${ORG}:${MEMBER.userId}`, "member"],
      [`${ORG}:${VIEWER.userId}`, "viewer"],
      // The outsider belongs to ANOTHER organization, as an owner there.
      [`${OTHER_ORG}:${OUTSIDER.userId}`, "owner"],
    ]),
  };
}

/** Organization reads over mutable state — the database, as far as the route can tell. */
function fakeTenancy(state: TenancyState = defaultState()) {
  const calls = { owner: [] as Array<[string, string]>, membership: [] as Array<[string, string]> };
  const tenancy: N8nMcpTenancy = {
    async findConnectorOwner(providerId, connector) {
      calls.owner.push([providerId, connector]);
      if (state.fail === "owner") throw new Error("connection refused: postgres://u:SECRET@db/jarvis");
      return state.owner;
    },
    async findMembership(userId, tenantId) {
      calls.membership.push([userId, tenantId]);
      if (state.fail === "membership") throw new Error("connection refused");
      const role = state.members.get(`${tenantId}:${userId}`);
      return role ? { role: role as TenantRole } : null;
    },
  };
  return { tenancy, calls, state };
}

function fakeRes(): { res: Response; captured: Captured } {
  const captured: Captured = { status: 0, body: {}, headers: {} };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers![name.toLowerCase()] = value;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

/** A connector that counts every way it could be reached. */
function stubConnector(discovery?: N8nMcpResult<N8nMcpDiscovery>) {
  const calls = { get: 0, discover: 0, invoke: 0 };
  const connector: N8nMcpConnector = {
    endpoint: "https://n8n.example.com/mcp-server/http",
    async discoverTools() {
      calls.discover += 1;
      return (
        discovery ?? {
          ok: true,
          data: {
            tools: [{ name: "list_sheets", description: "INTERNAL", inputSchema: {}, readOnly: true, destructive: false }],
            serverInfo: { name: "n8n MCP Server", version: "1.2.0" },
            truncated: false,
          },
        }
      );
    },
    async invokeTool() {
      calls.invoke += 1;
      return { ok: true, content: [] };
    },
    async close() {
      /* nothing */
    },
  };
  return {
    calls,
    getConnector: () => {
      calls.get += 1;
      return connector;
    },
  };
}

type AuditRow = { userId: string; action: string; result: string; metadata: Record<string, unknown> };

function buildContainer(opts: { priorAuditActions?: string[]; verifyToken?: (t: string) => unknown } = {}) {
  const audit: AuditRow[] = [];
  const queries: unknown[] = [];
  const container = {
    tokenService: { verifyAccessToken: opts.verifyToken ?? (() => OWNER) },
    auditLogger: {
      log: async (entry: never) => {
        audit.push(entry);
      },
      query: async (q: unknown) => {
        queries.push(q);
        return (opts.priorAuditActions ?? []).map((action) => ({ action, userId: OWNER.userId }));
      },
    },
  } as unknown as Container;
  return { container, audit, queries };
}

interface Call {
  path?: (typeof PATHS)[number];
  /** With auth, the terminal handler runs; without, the real middleware does. */
  auth?: Auth | null;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

/** ONE router, many requests — so "read on every request" is tested across calls. */
function routerFor(container: Container, deps: Parameters<typeof createN8nMcpRouter>[1]) {
  const router = createN8nMcpRouter(container, deps);
  return async (call: Call = {}): Promise<Captured> => {
    const path = call.path ?? "/tools";
    const layer = (
      router as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
      }
    ).stack.find((l) => l.route?.path === path && l.route.methods.get);
    if (!layer?.route) throw new Error(`No GET ${path} route`);

    const headers = call.headers ?? {};
    const { res, captured } = fakeRes();
    const req = {
      method: "GET",
      url: path,
      path,
      params: {},
      query: call.query ?? {},
      body: call.body,
      headers,
      get: (h: string) => headers[h],
      auth: call.auth ?? undefined,
    } as never;

    const handlers = layer.route.stack.map((s) => s.handle);
    const handler = call.auth ? handlers[handlers.length - 1]! : handlers[0]!;
    await handler(req, res, () => undefined);
    return captured;
  };
}

async function invoke(container: Container, deps: Parameters<typeof createN8nMcpRouter>[1], call: Call = {}) {
  return routerFor(container, deps)(call);
}

const code = (r: Captured) => (r.body.error as { code: string } | undefined)?.code;
const errorOf = (r: Captured) => r.body.error as { code: string; message: string };

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

describe.each(PATHS)("Phase 17 — GET %s is authorized from database state, before the connector", (path) => {
  const bucket = BUCKET[path];

  describe("members of the owning Organization", () => {
    it.each([
      ["owner", OWNER],
      ["admin", ADMIN],
      ["member", MEMBER],
    ] as const)("serves a %s, read-only, and records the Organization on the served row", async (_label, auth) => {
      const { container, audit } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const { tenancy, calls: reads } = fakeTenancy();

      const res = await invoke(container, { getConnector, tenancy }, { path, auth });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(calls.discover).toBe(1);
      expect(calls.invoke).toBe(0);
      // The connection key, then the membership by BOTH ids.
      expect(reads.owner).toEqual([[N8N_MCP_CONNECTION_KEY.providerId, N8N_MCP_CONNECTION_KEY.connector]]);
      expect(reads.membership).toEqual([[auth.userId, ORG]]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ userId: auth.userId, action: `n8n_mcp.${bucket}`, result: "success" });
      expect(audit[0]!.metadata.tenantId).toBe(ORG);
    });

    it("refuses a viewer — a viewer holds no MCP read", async () => {
      const { container, audit } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const { tenancy } = fakeTenancy();

      const res = await invoke(container, { getConnector, tenancy }, { path, auth: VIEWER });

      expect(res.status).toBe(403);
      expect(code(res)).toBe("SURFACE_PERMISSION_DENIED");
      expect(calls).toEqual({ get: 0, discover: 0, invoke: 0 });
      expect(audit).toEqual([
        { userId: VIEWER.userId, action: `n8n_mcp.${bucket}`, result: "rejected", metadata: { authz: "SURFACE_PERMISSION_DENIED" } },
      ]);
    });

    it("refuses a membership role the code does not know", async () => {
      const state = defaultState();
      state.members.set(`${ORG}:${MEMBER.userId}`, "superuser");
      const { container } = buildContainer();
      const { calls, getConnector } = stubConnector();

      const res = await invoke(container, { getConnector, tenancy: fakeTenancy(state).tenancy }, { path, auth: MEMBER });

      expect(res.status).toBe(403);
      expect(code(res)).toBe("ROLE_UNRECOGNIZED");
      expect(calls.discover).toBe(0);
    });
  });

  describe("cross-Organization and platform roles", () => {
    it("refuses an owner of ANOTHER Organization with the uniform answer", async () => {
      const { container, audit } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const { tenancy } = fakeTenancy();

      const res = await invoke(container, { getConnector, tenancy }, { path, auth: OUTSIDER });

      expect(res.status).toBe(403);
      expect(code(res)).toBe("TENANT_ACCESS_DENIED");
      expect(calls).toEqual({ get: 0, discover: 0, invoke: 0 });
      // The precise reason is kept — and no tenant id, in the answer or the row.
      expect(audit[0]).toMatchObject({ result: "rejected", metadata: { authz: "TENANT_MEMBERSHIP_REQUIRED" } });
      expect(JSON.stringify(res.body)).not.toContain(ORG);
      expect(JSON.stringify(audit)).not.toContain(ORG);
    });

    it.each([
      ["account-wide owner", PLATFORM_OWNER],
      ["account-wide admin", PLATFORM_ADMIN],
    ] as const)("refuses an %s who is not a member — no implicit access", async (_label, auth) => {
      const { container } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const { tenancy } = fakeTenancy();

      const res = await invoke(container, { getConnector, tenancy }, { path, auth });

      expect(res.status).toBe(403);
      expect(code(res)).toBe("TENANT_ACCESS_DENIED");
      expect(calls).toEqual({ get: 0, discover: 0, invoke: 0 });
    });

    it("gives the account-wide owner exactly the membership's grants when it is a viewer member", async () => {
      const state = defaultState();
      state.members.set(`${ORG}:${PLATFORM_OWNER.userId}`, "viewer");
      const { container } = buildContainer();
      const { calls, getConnector } = stubConnector();

      const res = await invoke(container, { getConnector, tenancy: fakeTenancy(state).tenancy }, { path, auth: PLATFORM_OWNER });

      expect(res.status).toBe(403);
      expect(code(res)).toBe("SURFACE_PERMISSION_DENIED");
      expect(calls.discover).toBe(0);
    });
  });

  describe("connection ownership — missing or invalid fails closed", () => {
    it("refuses everyone while no owner is recorded, and never reads a membership", async () => {
      const state = defaultState();
      state.owner = { status: "unassigned" };
      for (const auth of [OWNER, ADMIN, MEMBER, PLATFORM_OWNER]) {
        const { container, audit } = buildContainer();
        const { calls, getConnector } = stubConnector();
        const { tenancy, calls: reads } = fakeTenancy(state);

        const res = await invoke(container, { getConnector, tenancy }, { path, auth });

        expect(res.status, auth.userId).toBe(403);
        expect(code(res)).toBe("TENANT_ACCESS_DENIED");
        expect(calls).toEqual({ get: 0, discover: 0, invoke: 0 });
        expect(reads.membership).toEqual([]);
        expect(audit[0]).toMatchObject({ result: "rejected", metadata: { authz: "RESOURCE_OWNERSHIP_MISSING" } });
      }
    });

    it.each([
      ["an invalid record", { status: "invalid" } as ConnectorOwnerLookup],
      ["an empty tenant id", { status: "assigned", tenantId: "" } as ConnectorOwnerLookup],
      ["a malformed tenant id", { status: "assigned", tenantId: "../other org" } as ConnectorOwnerLookup],
    ])("refuses everyone for %s, without reading a membership", async (_label, owner) => {
      const state = defaultState();
      state.owner = owner;
      const { container, audit } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const { tenancy, calls: reads } = fakeTenancy(state);

      const res = await invoke(container, { getConnector, tenancy }, { path, auth: OWNER });

      expect(res.status).toBe(403);
      expect(code(res)).toBe("TENANT_ACCESS_DENIED");
      expect(calls).toEqual({ get: 0, discover: 0, invoke: 0 });
      expect(reads.membership).toEqual([]);
      expect(audit[0]).toMatchObject({ metadata: { authz: "RESOURCE_OWNERSHIP_INVALID" } });
    });

    it("answers unassigned, invalid and someone-else's exactly alike", async () => {
      const answers: unknown[] = [];
      for (const [auth, owner] of [
        [OWNER, { status: "unassigned" }],
        [OWNER, { status: "invalid" }],
        [OUTSIDER, { status: "assigned", tenantId: ORG }],
      ] as const) {
        const state = defaultState();
        state.owner = owner as ConnectorOwnerLookup;
        const { container } = buildContainer();
        const { getConnector } = stubConnector();
        const res = await invoke(container, { getConnector, tenancy: fakeTenancy(state).tenancy }, { path, auth });
        answers.push({ status: res.status, error: res.body.error });
      }
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[2]).toEqual(answers[0]);
      expect(errorOf({ status: 0, body: { error: (answers[0] as { error: unknown }).error } }).message).toMatch(/organization/);
    });

    it("never infers an owner from the caller or from an account-wide role", async () => {
      // A platform owner with every account-wide privilege, and nothing recorded.
      const state = defaultState();
      state.owner = { status: "unassigned" };
      const { container } = buildContainer();
      const { calls, getConnector } = stubConnector();

      const res = await invoke(container, { getConnector, tenancy: fakeTenancy(state).tenancy }, { path, auth: PLATFORM_OWNER });

      expect(res.status).toBe(403);
      expect(calls.discover).toBe(0);
      // ...and asking again does not make it so: nothing was recorded by asking.
      expect(state.owner).toEqual({ status: "unassigned" });
    });
  });

  describe("membership is read on every request — changes apply to the next one", () => {
    it("revoking, re-roling and restoring a member take effect immediately", async () => {
      const { container } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const fake = fakeTenancy();
      const send = routerFor(container, { getConnector, tenancy: fake.tenancy });

      expect((await send({ path, auth: MEMBER })).status).toBe(200);

      fake.state.members.delete(`${ORG}:${MEMBER.userId}`); // removed
      const removed = await send({ path, auth: MEMBER });
      expect(removed.status).toBe(403);
      expect(code(removed)).toBe("TENANT_ACCESS_DENIED");

      fake.state.members.set(`${ORG}:${MEMBER.userId}`, "viewer"); // re-added as a viewer
      expect(code(await send({ path, auth: MEMBER }))).toBe("SURFACE_PERMISSION_DENIED");

      fake.state.members.set(`${ORG}:${MEMBER.userId}`, "member"); // restored
      expect((await send({ path, auth: MEMBER })).status).toBe(200);

      expect(calls.discover).toBe(2);
      expect(fake.calls.membership).toHaveLength(4);
    });

    it("moving the connection to another Organization moves access with it", async () => {
      const { container } = buildContainer();
      const { getConnector } = stubConnector();
      const fake = fakeTenancy();
      const send = routerFor(container, { getConnector, tenancy: fake.tenancy });

      expect((await send({ path, auth: OWNER })).status).toBe(200);
      expect(code(await send({ path, auth: OUTSIDER }))).toBe("TENANT_ACCESS_DENIED");

      fake.state.owner = { status: "assigned", tenantId: OTHER_ORG };

      expect(code(await send({ path, auth: OWNER }))).toBe("TENANT_ACCESS_DENIED");
      expect((await send({ path, auth: OUTSIDER })).status).toBe(200);
    });
  });

  describe("reads that fail are refusals", () => {
    it.each(["owner", "membership"] as const)(
      "refuses with AUTHORIZATION_UNAVAILABLE when the %s read fails — before the limiter and the connector",
      async (failing) => {
        const state = defaultState();
        state.fail = failing;
        const { container, audit, queries } = buildContainer();
        const { calls, getConnector } = stubConnector();

        const res = await invoke(container, { getConnector, tenancy: fakeTenancy(state).tenancy }, { path, auth: OWNER });

        expect(res.status).toBe(503);
        expect(code(res)).toBe("AUTHORIZATION_UNAVAILABLE");
        expect(calls).toEqual({ get: 0, discover: 0, invoke: 0 });
        expect(queries).toHaveLength(0);
        // The database's own words never reach the caller or the audit row.
        expect(JSON.stringify(res.body)).not.toContain("SECRET");
        expect(JSON.stringify(res.body)).not.toContain("connection refused");
        expect(audit[0]).toMatchObject({ result: "rejected", metadata: { authz: "AUTHORIZATION_UNAVAILABLE" } });
      }
    );

    it("refuses when no organization reads exist at all (a container without them)", async () => {
      const { container } = buildContainer();
      const { calls, getConnector } = stubConnector();

      const res = await invoke(container, { getConnector }, { path, auth: OWNER });

      expect(res.status).toBe(503);
      expect(code(res)).toBe("AUTHORIZATION_UNAVAILABLE");
      expect(calls.discover).toBe(0);
    });
  });

  describe("forged scope identifiers are refused, never obeyed", () => {
    it.each([
      "tenantId",
      "organizationId",
      "orgId",
      "businessId",
      "accountId",
      "workspaceId",
      "tenant_id",
      "Tenant-Id",
      "ORGANIZATION_ID",
      "userId",
      "ownerUserId",
      "agentId",
      "operation",
    ])("refuses ?%s — before any organization read", async (field) => {
      const { container, audit } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const { tenancy, calls: reads } = fakeTenancy();

      const res = await invoke(container, { getConnector, tenancy }, { path, auth: OWNER, query: { [field]: "forged-value-7" } });

      expect(res.status).toBe(400);
      expect(code(res)).toBe("REQUEST_SCOPE_REFUSED");
      expect(calls).toEqual({ get: 0, discover: 0, invoke: 0 });
      expect(reads.owner).toEqual([]);
      expect(reads.membership).toEqual([]);
      // The supplied value is neither echoed nor recorded.
      expect(JSON.stringify(res.body)).not.toContain("forged-value-7");
      expect(JSON.stringify(audit)).not.toContain("forged-value-7");
      expect(audit[0]).toMatchObject({ result: "rejected", metadata: { authz: "REQUEST_SCOPE_REFUSED" } });
    });

    it("refuses even the TRUE owning Organization's id when a request supplies it", async () => {
      const { container } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const { tenancy } = fakeTenancy();

      const res = await invoke(container, { getConnector, tenancy }, { path, auth: OUTSIDER, query: { tenantId: ORG } });

      expect(res.status).toBe(400);
      expect(calls.discover).toBe(0);
    });

    it("refuses an Organization named in a body as well", async () => {
      const { container } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const { tenancy } = fakeTenancy();

      const res = await invoke(container, { getConnector, tenancy }, { path, auth: OUTSIDER, body: { organizationId: ORG } });

      expect(res.status).toBe(400);
      expect(calls.discover).toBe(0);
    });

    it("does not let a request supply an agent context — not even a plausible one", async () => {
      const { container } = buildContainer();
      const { calls, getConnector } = stubConnector();

      const res = await invoke(container, { getConnector, tenancy: fakeTenancy().tenancy }, {
        path,
        auth: OWNER,
        query: { agentId: "automation-agent" },
      });

      expect(res.status).toBe(400);
      expect(calls.discover).toBe(0);
    });
  });

  describe("identity", () => {
    it("refuses a request with no session, in the real middleware", async () => {
      const { container, audit } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const { tenancy, calls: reads } = fakeTenancy();

      const res = await invoke(container, { getConnector, tenancy }, { path, auth: null });

      expect(res.status).toBe(401);
      expect(code(res)).toBe("AUTHENTICATION_REQUIRED");
      expect(calls).toEqual({ get: 0, discover: 0, invoke: 0 });
      expect(reads.owner).toEqual([]);
      expect(audit).toHaveLength(0);
    });

    it("refuses a token that is not a JARVIS session", async () => {
      const { container } = buildContainer({ verifyToken: () => null });
      const { calls, getConnector } = stubConnector();

      const res = await invoke(container, { getConnector, tenancy: fakeTenancy().tenancy }, {
        path,
        auth: null,
        headers: { authorization: "Bearer n8n-mcp-personal-access-token" },
      });

      expect(res.status).toBe(401);
      expect(calls.discover).toBe(0);
    });

    it("refuses an identity with no user id, before any read, audit, limiter or connector", async () => {
      const { container, audit, queries } = buildContainer();
      const { calls, getConnector } = stubConnector();
      const { tenancy, calls: reads } = fakeTenancy();

      const res = await invoke(container, { getConnector, tenancy }, { path, auth: { ...OWNER, userId: "" } });

      expect(res.status).toBe(401);
      expect(code(res)).toBe("AUTHENTICATION_REQUIRED");
      expect(calls).toEqual({ get: 0, discover: 0, invoke: 0 });
      expect(reads.owner).toEqual([]);
      expect(queries).toHaveLength(0);
      expect(audit).toHaveLength(0);
    });
  });

  describe("existing behaviour is preserved", () => {
    it("still meters an authorized member and refuses when the budget is spent", async () => {
      const { container } = buildContainer({ priorAuditActions: Array.from({ length: 30 }, () => `n8n_mcp.${bucket}`) });
      const { calls, getConnector } = stubConnector();

      const res = await invoke(container, { getConnector, tenancy: fakeTenancy().tenancy }, { path, auth: MEMBER });

      expect(res.status).toBe(429);
      expect(code(res)).toBe("RATE_LIMITED");
      expect(calls.discover).toBe(0);
    });

    it("refuses an unauthorized caller without spending a limiter query", async () => {
      const { container, queries } = buildContainer();
      const { getConnector } = stubConnector();

      await invoke(container, { getConnector, tenancy: fakeTenancy().tenancy }, { path, auth: OUTSIDER });
      await invoke(container, { getConnector, tenancy: fakeTenancy().tenancy }, { path, auth: VIEWER });

      expect(queries).toHaveLength(0);
    });

    it("audits a refusal under the route's own action, so it counts against the same budget", async () => {
      const { container, audit } = buildContainer();
      const { getConnector } = stubConnector();

      await invoke(container, { getConnector, tenancy: fakeTenancy().tenancy }, { path, auth: OUTSIDER });

      expect(audit).toHaveLength(1);
      expect(audit[0]!.action).toBe(`n8n_mcp.${bucket}`);
    });

    it("still answers an upstream failure with a fixed sentence, never the server's text", async () => {
      const { container } = buildContainer();
      const { getConnector } = stubConnector({
        ok: false,
        failure: { code: "AUTH_FAILURE", message: "raw upstream: Bearer sk-super-secret-token" },
      });

      const res = await invoke(container, { getConnector, tenancy: fakeTenancy().tenancy }, { path, auth: MEMBER });

      expect(res.status).toBe(502);
      expect(code(res)).toBe("MCP_AUTH_FAILURE");
      expect(JSON.stringify(res.body)).not.toContain("sk-super-secret-token");
    });

    it("still reports an unconfigured surface — to an authorized member only", async () => {
      const { container } = buildContainer();

      const member = await invoke(container, { getConnector: () => null, tenancy: fakeTenancy().tenancy }, { path, auth: MEMBER });
      expect(member.status).toBe(404);
      expect(code(member)).toBe("MCP_NOT_CONFIGURED");

      // A refused caller is refused first, and learns nothing about configuration.
      const outsider = await invoke(container, { getConnector: () => null, tenancy: fakeTenancy().tenancy }, { path, auth: OUTSIDER });
      expect(outsider.status).toBe(403);
      expect(code(outsider)).not.toBe("MCP_NOT_CONFIGURED");
    });

    it("answers every refusal with a stable code and a fixed sentence that names no id or role", async () => {
      const { container } = buildContainer();
      const { getConnector } = stubConnector();

      for (const auth of [VIEWER, OUTSIDER, PLATFORM_ADMIN]) {
        const res = await invoke(container, { getConnector, tenancy: fakeTenancy().tenancy }, { path, auth });
        const error = errorOf(res);
        expect(error.code).toMatch(/^[A-Z_]+$/);
        expect(error.message.length).toBeGreaterThan(0);
        for (const leaked of [auth.userId, ORG, OTHER_ORG]) expect(error.message).not.toContain(leaked);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The route's authorization function, directly — inputs a request can never
// supply, so they are exercised here.
// ---------------------------------------------------------------------------

describe("authorizeN8nMcpRead", () => {
  const auth = (a: Auth) => a as AuthContext;
  const membership = (a: Auth, role: TenantRole, tenantId = ORG): TenantMembershipContext => ({
    tenantId,
    userId: a.userId,
    role,
  });
  const own = { tenantId: ORG };

  it("allows the routes' own operation for owner, admin and member memberships, on mcp:read", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      for (const operation of Object.values(N8N_MCP_ROUTE_OPERATIONS)) {
        expect(
          authorizeN8nMcpRead({ auth: auth(MEMBER), membership: membership(MEMBER, role), operation, scope: own })
        ).toEqual({ allowed: true });
      }
    }
  });

  it("refuses a viewer membership", () => {
    expect(
      authorizeN8nMcpRead({ auth: auth(VIEWER), membership: membership(VIEWER, "viewer"), operation: "list", scope: own })
    ).toMatchObject({ allowed: false, status: 403, code: "SURFACE_PERMISSION_DENIED" });
  });

  it("permits exactly the explicitly listed read-only operations", () => {
    expect([...N8N_MCP_READ_OPERATIONS]).toEqual(["list"]);
    expect(Object.values(N8N_MCP_ROUTE_OPERATIONS).every((op) => N8N_MCP_READ_OPERATIONS.includes(op))).toBe(true);
  });

  it.each(["execute", "manage"])("refuses the write/execute operation %s, even for an owner membership", (operation) => {
    expect(
      authorizeN8nMcpRead({ auth: auth(OWNER), membership: membership(OWNER, "owner"), operation, scope: own })
    ).toMatchObject({ allowed: false, status: 403 });
  });

  it("refuses a read-only operation these routes do not list", () => {
    expect(
      authorizeN8nMcpRead({ auth: auth(OWNER), membership: membership(OWNER, "owner"), operation: "describe", scope: own })
    ).toMatchObject({ allowed: false, status: 403 });
  });

  it.each(["", "LIST", "execuite", "__proto__", "constructor", "toString"])("refuses the unknown operation %j", (operation) => {
    expect(
      authorizeN8nMcpRead({ auth: auth(OWNER), membership: membership(OWNER, "owner"), operation, scope: own })
    ).toMatchObject({ allowed: false, status: 403, code: "OPERATION_UNKNOWN" });
  });

  it("refuses an absent identity as 401", () => {
    for (const a of [null, undefined]) {
      expect(
        authorizeN8nMcpRead({ auth: a, membership: membership(OWNER, "owner"), operation: "list", scope: own })
      ).toMatchObject({ allowed: false, status: 401, code: "AUTHENTICATION_REQUIRED" });
    }
  });

  it("answers every whose-resource refusal with the uniform code, keeping the precise reason", () => {
    const cases: Array<[string, Parameters<typeof authorizeN8nMcpRead>[0]]> = [
      ["RESOURCE_OWNERSHIP_MISSING", { auth: auth(OWNER), membership: membership(OWNER, "owner"), operation: "list", scope: { tenantId: "" } }],
      ["TENANT_MEMBERSHIP_REQUIRED", { auth: auth(OWNER), membership: null, operation: "list", scope: own }],
      ["TENANT_MEMBERSHIP_REQUIRED", { auth: auth(OWNER), membership: membership(ADMIN, "owner"), operation: "list", scope: own }],
      ["SCOPE_TENANT_MISMATCH", { auth: auth(OWNER), membership: membership(OWNER, "owner", OTHER_ORG), operation: "list", scope: own }],
      ["SCOPE_OWNER_MISMATCH", { auth: auth(OWNER), membership: membership(OWNER, "owner"), operation: "list", scope: { tenantId: ORG, ownerUserId: "someone-else" } }],
      ["AGENT_CONTEXT_REQUIRED", { auth: auth(OWNER), membership: membership(OWNER, "owner"), operation: "list", scope: { tenantId: ORG, agentId: "automation-agent" } }],
      ["AGENT_SCOPE_MISMATCH", { auth: auth(OWNER), membership: membership(OWNER, "owner"), agentId: "marketing-agent", operation: "list", scope: { tenantId: ORG, agentId: "automation-agent" } }],
    ];
    for (const [reason, input] of cases) {
      const access = authorizeN8nMcpRead(input);
      expect(access, reason).toMatchObject({ allowed: false, status: 403, code: "TENANT_ACCESS_DENIED", reason });
    }
  });

  it("allows the matching agent for an agent-scoped resource (control)", () => {
    expect(
      authorizeN8nMcpRead({
        auth: auth(OWNER),
        membership: membership(OWNER, "owner"),
        agentId: "automation-agent",
        operation: "list",
        scope: { tenantId: ORG, agentId: "automation-agent" },
      })
    ).toEqual({ allowed: true });
  });

  it("ignores the account-wide role in both directions", () => {
    // Account-wide owner, viewer membership: refused.
    expect(
      authorizeN8nMcpRead({ auth: auth(PLATFORM_OWNER), membership: membership(PLATFORM_OWNER, "viewer"), operation: "list", scope: own })
    ).toMatchObject({ allowed: false, code: "SURFACE_PERMISSION_DENIED" });
    // Account-wide member, member membership: served.
    expect(
      authorizeN8nMcpRead({ auth: auth(MEMBER), membership: membership(MEMBER, "member"), operation: "list", scope: own })
    ).toEqual({ allowed: true });
  });

  it("reads a connection the operator command can assign an owner to", () => {
    expect(SHARED_CONNECTOR_KEYS).toContainEqual(N8N_MCP_CONNECTION_KEY);
  });
});

// ---------------------------------------------------------------------------
// Never an execution surface
// ---------------------------------------------------------------------------

describe("the discovery routes never invoke a tool or execute a workflow", () => {
  it("has no call to invokeTool, and no execution or workflow-trigger reference, in the route", () => {
    const source = readFileSync(new URL("../src/routes/n8n-mcp.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.invokeTool\s*\(/);
    expect(source).not.toMatch(/\bcallTool\s*\(/);
    expect(source).not.toMatch(/toolExecutor|ToolExecutor\s*\(|\.execute\s*\(/);
    expect(source).not.toMatch(/n8n\.trigger|triggerWorkflow|\/webhook\//);
  });

  it("writes no organization state — the route holds only the two reads", () => {
    const source = readFileSync(new URL("../src/routes/n8n-mcp.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/runTenantAdminCommand|tenant-admin|tenantMembership\.(create|update|delete|upsert)/);
  });

  it("invokes nothing on any path — served, refused, throttled, unassigned or failed", async () => {
    const unassigned = (): TenancyState => ({ ...defaultState(), owner: { status: "unassigned" } });
    const failing = (): TenancyState => ({ ...defaultState(), fail: "membership" });
    const scenarios: Array<{ auth: Auth; query?: Record<string, unknown>; prior?: number; state?: () => TenancyState }> = [
      { auth: OWNER },
      { auth: MEMBER },
      { auth: VIEWER },
      { auth: OUTSIDER },
      { auth: PLATFORM_ADMIN },
      { auth: OWNER, query: { operation: "execute" } },
      { auth: OWNER, query: { tenantId: OTHER_ORG } },
      { auth: OWNER, prior: 30 },
      { auth: OWNER, state: unassigned },
      { auth: OWNER, state: failing },
    ];
    for (const path of PATHS) {
      for (const s of scenarios) {
        const { container } = buildContainer({
          priorAuditActions: Array.from({ length: s.prior ?? 0 }, () => `n8n_mcp.${BUCKET[path]}`),
        });
        const { calls, getConnector } = stubConnector();
        await invoke(container, { getConnector, tenancy: fakeTenancy(s.state?.()).tenancy }, { path, auth: s.auth, query: s.query });
        expect(calls.invoke).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Review finding M1 — every attempt is counted before the database is.
//
// One router per test, as production has one, so the attempt window is the
// real one. `audit` and `queries` count every database write and limiter read
// the route makes; the fake organization reads count theirs.
// ---------------------------------------------------------------------------

describe.each(PATHS)("M1 — GET %s counts every attempt before the database", (path) => {
  const bucket = BUCKET[path];
  const { limit, windowMs } = N8N_MCP_ATTEMPT_LIMITS[bucket];
  const FLOOD = limit + 15;

  async function flood(send: (call: Call) => Promise<Captured>, call: Call, times = FLOOD) {
    const statuses: number[] = [];
    let last: Captured | null = null;
    for (let i = 0; i < times; i++) {
      last = await send(call);
      statuses.push(last.status);
    }
    return { statuses, last: last! };
  }

  const tally = (statuses: number[]) =>
    statuses.reduce<Record<number, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});

  it("throttles a non-member's refusals: past the window nothing is read and only one row is written", async () => {
    const { container, audit, queries } = buildContainer();
    const { calls, getConnector } = stubConnector();
    const fake = fakeTenancy();
    const send = routerFor(container, { getConnector, tenancy: fake.tenancy });

    const { statuses, last } = await flood(send, { path, auth: OUTSIDER });

    expect(tally(statuses)).toEqual({ 403: limit, 429: FLOOD - limit });
    expect(code(last)).toBe("RATE_LIMITED");
    expect(Number(last.headers?.["retry-after"])).toBeGreaterThan(0);
    // The organization was read only for the attempts inside the window.
    expect(fake.calls.owner).toHaveLength(limit);
    expect(fake.calls.membership).toHaveLength(limit);
    // One row per refusal inside the window, ONE row for the whole throttle.
    expect(audit).toHaveLength(limit + 1);
    expect(audit.filter((row) => row.metadata.throttled === true)).toHaveLength(1);
    expect(queries).toHaveLength(0);
    expect(calls).toEqual({ get: 0, discover: 0, invoke: 0 });
  });

  it("throttles while the connection is unassigned", async () => {
    const state = defaultState();
    state.owner = { status: "unassigned" };
    const { container, audit } = buildContainer();
    const fake = fakeTenancy(state);
    const send = routerFor(container, { getConnector: stubConnector().getConnector, tenancy: fake.tenancy });

    const { statuses } = await flood(send, { path, auth: OWNER });

    expect(tally(statuses)).toEqual({ 403: limit, 429: FLOOD - limit });
    expect(fake.calls.owner).toHaveLength(limit);
    expect(fake.calls.membership).toHaveLength(0);
    expect(audit).toHaveLength(limit + 1);
  });

  it("throttles while the organization reads are unavailable", async () => {
    const state = defaultState();
    state.fail = "owner";
    const { container, audit } = buildContainer();
    const fake = fakeTenancy(state);
    const send = routerFor(container, { getConnector: stubConnector().getConnector, tenancy: fake.tenancy });

    const { statuses } = await flood(send, { path, auth: MEMBER });

    expect(tally(statuses)).toEqual({ 503: limit, 429: FLOOD - limit });
    expect(fake.calls.owner).toHaveLength(limit);
    expect(audit).toHaveLength(limit + 1);
  });

  it("throttles a flood of forged scope fields before anything is read", async () => {
    const { container, audit } = buildContainer();
    const fake = fakeTenancy();
    const send = routerFor(container, { getConnector: stubConnector().getConnector, tenancy: fake.tenancy });

    const { statuses } = await flood(send, { path, auth: OUTSIDER, query: { tenantId: ORG } });

    expect(tally(statuses)).toEqual({ 400: limit, 429: FLOOD - limit });
    expect(fake.calls.owner).toHaveLength(0);
    expect(audit).toHaveLength(limit + 1);
  });

  it("gives an authorized member the same budget as before — and no more", async () => {
    const { container, queries } = buildContainer();
    const { calls, getConnector } = stubConnector();
    const send = routerFor(container, { getConnector, tenancy: fakeTenancy().tenancy });

    const { statuses } = await flood(send, { path, auth: MEMBER }, limit + 1);

    expect(tally(statuses)).toEqual({ 200: limit, 429: 1 });
    expect(calls.discover).toBe(limit);
    // The database-backed limiter still meters every authorized call.
    expect(queries).toHaveLength(limit);
  });

  it("keeps windows per account and per route", async () => {
    const { container } = buildContainer();
    const send = routerFor(container, { getConnector: stubConnector().getConnector, tenancy: fakeTenancy().tenancy });

    await flood(send, { path, auth: OUTSIDER });
    expect((await send({ path, auth: OUTSIDER })).status).toBe(429);

    // Another account is untouched, and so is the other route for this one.
    expect((await send({ path, auth: MEMBER })).status).toBe(200);
    const otherPath = path === "/tools" ? "/automations" : "/tools";
    expect((await send({ path: otherPath, auth: OUTSIDER })).status).toBe(403);
  });

  it("opens a fresh window when the old one ends, with one throttle row per window", async () => {
    let clock = Date.parse("2026-10-17T12:00:00.000Z");
    const { container, audit } = buildContainer();
    const fake = fakeTenancy();
    const send = routerFor(container, {
      getConnector: stubConnector().getConnector,
      tenancy: fake.tenancy,
      now: () => new Date(clock),
    });

    await flood(send, { path, auth: OUTSIDER });
    clock += windowMs;
    const { statuses } = await flood(send, { path, auth: OUTSIDER });

    expect(tally(statuses)).toEqual({ 403: limit, 429: FLOOD - limit });
    expect(audit.filter((row) => row.metadata.throttled === true)).toHaveLength(2);
    expect(audit).toHaveLength(2 * (limit + 1));
    expect(fake.calls.owner).toHaveLength(2 * limit);
  });

  it("counts no attempt for a request without an identity", async () => {
    const { container, audit } = buildContainer();
    const send = routerFor(container, { getConnector: stubConnector().getConnector, tenancy: fakeTenancy().tenancy });

    // Past the window's size and still 401, never 429: nothing was counted.
    for (let i = 0; i < FLOOD; i++) {
      expect((await send({ path, auth: { ...OUTSIDER, userId: "" } })).status).toBe(401);
    }
    expect(audit).toHaveLength(0);
    expect((await send({ path, auth: MEMBER })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Review finding L2 — a header can name an organization; it changes nothing.
// ---------------------------------------------------------------------------

describe.each(PATHS)("L2 — GET %s ignores headers that name a scope", (path) => {
  const forgedHeaders = (value: string): Record<string, string> => ({
    "x-tenant-id": value,
    "x-organization-id": value,
    "x-org-id": value,
    "x-business-id": value,
    "x-account-id": value,
    "x-workspace-id": value,
    "x-user-id": OWNER.userId,
    "x-owner-user-id": OWNER.userId,
    "x-agent-id": "automation-agent",
    "tenant-id": value,
    organization: value,
  });

  it("does not let an outsider in by naming the owning organization in headers", async () => {
    const { container, audit } = buildContainer();
    const { calls, getConnector } = stubConnector();
    const fake = fakeTenancy();

    const res = await invoke(container, { getConnector, tenancy: fake.tenancy }, {
      path,
      auth: OUTSIDER,
      headers: forgedHeaders(ORG),
    });

    expect(res.status).toBe(403);
    expect(code(res)).toBe("TENANT_ACCESS_DENIED");
    expect(calls.discover).toBe(0);
    // The membership read is the caller's own, in the RECORDED owner.
    expect(fake.calls.membership).toEqual([[OUTSIDER.userId, ORG]]);
    expect(audit[0]).toMatchObject({ metadata: { authz: "TENANT_MEMBERSHIP_REQUIRED" } });
  });

  it("does not move a member to another organization by naming it in headers", async () => {
    const { container, audit } = buildContainer();
    const fake = fakeTenancy();

    const res = await invoke(container, { getConnector: stubConnector().getConnector, tenancy: fake.tenancy }, {
      path,
      auth: MEMBER,
      headers: forgedHeaders(OTHER_ORG),
    });

    expect(res.status).toBe(200);
    expect(fake.calls.membership).toEqual([[MEMBER.userId, ORG]]);
    expect(audit[0]!.metadata.tenantId).toBe(ORG);
  });

  it("answers with headers exactly as without them", async () => {
    for (const auth of [OUTSIDER, VIEWER, MEMBER, PLATFORM_ADMIN]) {
      const plain = await invoke(buildContainer().container, { getConnector: stubConnector().getConnector, tenancy: fakeTenancy().tenancy }, { path, auth });
      const forged = await invoke(buildContainer().container, { getConnector: stubConnector().getConnector, tenancy: fakeTenancy().tenancy }, {
        path,
        auth,
        headers: forgedHeaders(auth === MEMBER ? OTHER_ORG : ORG),
      });
      expect({ status: forged.status, code: code(forged) }, auth.userId).toEqual({ status: plain.status, code: code(plain) });
    }
  });
});

describe("L2 — the route reads no request header at all", () => {
  it("never touches req.headers, req.get or req.header (requireAuth reads Authorization)", () => {
    const source = readFileSync(new URL("../src/routes/n8n-mcp.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/req\.(headers|get|header)\b/);
  });
});

// ---------------------------------------------------------------------------
// Review finding L3 — authorization is decided when the request starts; an
// in-flight discovery is neither re-checked nor cancelled.
// ---------------------------------------------------------------------------

/** A connector whose discovery waits until the test releases it. */
function deferredConnector() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = { discover: 0, invoke: 0, signals: [] as unknown[] };
  const connector: N8nMcpConnector = {
    endpoint: "https://n8n.example.com/mcp-server/http",
    async discoverTools(signal?: AbortSignal): Promise<N8nMcpResult<N8nMcpDiscovery>> {
      calls.discover += 1;
      calls.signals.push(signal);
      if (calls.discover === 1) await gate;
      return {
        ok: true,
        data: {
          tools: [{ name: "list_sheets", description: null, inputSchema: null, readOnly: true, destructive: false }],
          serverInfo: null,
          truncated: false,
        },
      };
    },
    async invokeTool() {
      calls.invoke += 1;
      return { ok: true, content: [] };
    },
    async close() {
      /* nothing */
    },
  };
  return { calls, release, getConnector: () => connector };
}

describe.each(PATHS)("L3 — GET %s decides once, when the request starts", (path) => {
  it("completes a discovery already in flight when the membership is removed, and refuses the next request", async () => {
    const { container, audit } = buildContainer();
    const connector = deferredConnector();
    const fake = fakeTenancy();
    const send = routerFor(container, { getConnector: connector.getConnector, tenancy: fake.tenancy });

    const inFlight = send({ path, auth: MEMBER });
    await new Promise((resolve) => setImmediate(resolve));
    expect(connector.calls.discover).toBe(1); // authorized, and now waiting on n8n

    fake.state.members.delete(`${ORG}:${MEMBER.userId}`);
    connector.release();

    const first = await inFlight;
    expect(first.status).toBe(200); // not cancelled by the revocation
    expect(audit.at(-1)).toMatchObject({ result: "success", metadata: { tenantId: ORG } });

    const next = await send({ path, auth: MEMBER });
    expect(next.status).toBe(403);
    expect(code(next)).toBe("TENANT_ACCESS_DENIED");
    expect(connector.calls.discover).toBe(1);
  });

  it("completes for the caller authorized at the start when ownership moves mid-request; the next request follows the new owner", async () => {
    const { container, audit } = buildContainer();
    const connector = deferredConnector();
    const fake = fakeTenancy();
    const send = routerFor(container, { getConnector: connector.getConnector, tenancy: fake.tenancy });

    const inFlight = send({ path, auth: MEMBER });
    await new Promise((resolve) => setImmediate(resolve));
    fake.state.owner = { status: "assigned", tenantId: OTHER_ORG };
    connector.release();

    expect((await inFlight).status).toBe(200);
    // Recorded against the organization that owned the connection when it started.
    expect(audit.at(-1)!.metadata.tenantId).toBe(ORG);

    expect(code(await send({ path, auth: MEMBER }))).toBe("TENANT_ACCESS_DENIED");
    const outsider = await send({ path, auth: OUTSIDER });
    expect(outsider.status).toBe(200);
  });

  it("passes no abort signal to discovery — nothing can cancel one that has started", async () => {
    const { container } = buildContainer();
    const connector = deferredConnector();
    const send = routerFor(container, { getConnector: connector.getConnector, tenancy: fakeTenancy().tenancy });

    const inFlight = send({ path, auth: MEMBER });
    await new Promise((resolve) => setImmediate(resolve));
    connector.release();
    await inFlight;

    expect(connector.calls.signals).toEqual([undefined]);
  });
});
