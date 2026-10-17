// ---------------------------------------------------------------------------
// Phase 16, Stage 1 — read-only n8n MCP discovery
//
//   GET /api/v1/n8n/mcp/tools        the tools the n8n MCP server exposes now
//   GET /api/v1/n8n/mcp/automations  a unified, read-only automation view
//                                    (Stage 2; see below)
//
// WHY THIS EXISTS. The MCP connector (packages/n8n/src/mcp-connector.ts) can
// discover tools, but until now nothing could reach it: it was built in the
// container and closed at shutdown, and no route, tool or agent called it. This
// route is the read-only window onto that discovery, so an operator — and,
// later, a screen — can see what an n8n instance offers WITHOUT anything being
// invoked.
//
// WHAT IT IS NOT. It is not an execution surface. It never calls `invokeTool`
// and has no input that could reach it. Invoking an n8n MCP tool is an external
// write; a write is approval-gated and ToolExecutor-mediated (see
// docs/n8n-mcp-execution-architecture.md). There is deliberately no tool
// registry entry, no agent allowlist entry and no callable MCP tool here.
//
// WHAT LEAVES. Tool NAMES and their advisory annotation flags (`readOnly`,
// `destructive`), plus the server's name/version and whether the listing was
// truncated. Descriptions and input schemas are WITHHELD: a description is the
// server's own prose (which can echo an instance's internals), and an input
// schema is precisely the argument list a caller would need to do the very thing
// this route must not enable. Upstream failure text never crosses — a fixed
// sentence is returned instead, so a token or a raw n8n error cannot leak.
//
// AUTH IS THE SESSION'S, NOT n8n'S. `requireAuth` verifies a JARVIS access
// token. The n8n credentials are server-side and used only outbound by the
// connector. The two are independent: a caller cannot present an n8n key here,
// and a valid n8n MCP token is not a JARVIS session.
//
// THE SWITCH IS THE CONTAINER'S. When `N8N_MCP_ENABLED` is not exactly "true",
// or the token or endpoint is missing, no connector is built and this route
// answers `MCP_NOT_CONFIGURED`. The route never builds one itself, so the
// surface cannot be switched on by a request.
//
// COST IS METERED AND AUDITED. Every call reaches outside JARVIS, so it is
// rate-limited under its own namespace BEFORE the connector is touched, and each
// attempt is audited. The audit row records an outcome and a count — never a
// token, an endpoint credential or a tool's arguments.
//
// STAGE 2 — THE UNIFIED VIEW (`/automations`). It composes what this deployment
// can currently see into one normalized list, each record carrying its source
// provenance (`observedVia`, `handles`) and each surface stating its own
// availability. The two surfaces are NOT interchangeable, and the view says which
// one a record came from rather than implying they are the same. Today only the
// MCP surface is read; the REST surface is reported as **unread with a reason**,
// never as an empty list — the difference between "we did not try" and "there is
// nothing there" is exactly what a reader must not have to guess. The builder,
// `buildAutomationCatalog` in `@jarvis/n8n`, is pure and holds no connector, so
// it cannot execute anything; and this file still adds no tool registry entry,
// no agent allowlist entry and no callable MCP tool.
//
// PHASE 17 STAGE 2 — EVERY REQUEST IS AUTHORIZED BEFORE THE CONNECTOR. After
// `requireAuth`, and before the limiter, the connector or discovery, each route
// asks the Permission and Risk Engine (`authorizeAutomationOperation` in
// @jarvis/security) whether this session may perform its operation:
//
//   • The OPERATION is the route's own literal (`N8N_MCP_ROUTE_OPERATIONS`),
//     never a request value, and must be one of the operations these routes
//     explicitly permit — read-only ones (`N8N_MCP_READ_OPERATIONS`). A decision
//     that comes back as anything but READ_ONLY, or as needing approval, is
//     refused here even though the engine allowed it.
//   • The SURFACE offered to the engine is MCP alone. `list` prefers REST, and
//     every role holds `rest:read`; offering both would let a member be approved
//     on REST and then served MCP discovery. With MCP alone there is nothing to
//     fall back to, and the decision must still name `mcp:read` — REST and MCP
//     stay separate grants.
//   • The IDENTITY is `req.auth`, from the verified token. An HTTP session
//     carries no agent context, so none is passed — and no request field can
//     supply one.
//   • A request that tries to name an operation, a tenant, an organization, a
//     business, an account, a workspace, an owner, a user or an agent is
//     refused outright, never obeyed.
//
// PHASE 17 STAGE 3A — THE CONNECTION BELONGS TO AN ORGANIZATION. The n8n MCP
// connection is configured once for the whole deployment; which tenant
// (Organization) owns it is a database row only an operator can set. On EVERY
// request, from the database, with no cache:
//
//   1. the owner is read (`findConnectorOwner`). None recorded, or a record
//      whose tenant cannot be resolved: refused — never inferred from the
//      caller or from an account-wide role;
//   2. the caller's membership IN THAT TENANT is read, by both ids;
//   3. the engine decides from the MEMBERSHIP role. An account-wide owner or
//      admin who is not a member holds nothing here; a viewer holds no MCP
//      read; owner, admin and member are served, read-only.
//
// A non-member gets ONE answer — `TENANT_ACCESS_DENIED` — whether the
// connection is unassigned, invalidly assigned or owned by someone else, so
// the refusal tells a caller nothing about who owns it. The audit row keeps the
// precise reason, and carries no tenant id for a caller who is not a member.
// If the owner or the membership cannot be read, the request is refused
// (`AUTHORIZATION_UNAVAILABLE`) before any connector is touched.
//
// A refusal is audited like every other attempt (and so counts against the
// same budget), answered with a stable code and a fixed sentence, and leaves
// the connector untouched.
//
// EVERY ATTEMPT IS COUNTED BEFORE THE DATABASE IS (review finding M1). Right
// after the identity check, each request — refused or not — takes a place in a
// per-account, per-route attempt window held in process memory
// (`N8N_MCP_ATTEMPT_LIMITS`, the fixed-window counter of ip-rate-limiter.ts).
// Past it the answer is 429 with no database read, no audit row and no log
// line — except ONE audit row and one log line per window, when throttling
// begins. So a flood of refusals costs at most the window's attempts plus one
// row, per account and per API instance, and nothing grows without bound. The
// database-backed limiter below still meters authorized calls across
// instances, as before.
//
// HEADERS ARE NEVER READ FOR SCOPE (review finding L2). Apart from
// `Authorization`, which `requireAuth` verifies, this file reads no request
// header. A header that names a tenant, an organization, an owner or an agent
// — `X-Tenant-Id` and the like — is ignored: neither refused, as a query or
// body field is, nor obeyed. The tenant comes from the stored owner record
// alone.
//
// AUTHORIZATION IS DECIDED ONCE, WHEN THE REQUEST STARTS (review finding L3).
// Discovery runs afterwards and is not re-checked or cancelled: nothing passes
// it an abort signal. It is bounded by the connector's own deadlines —
// N8N_MCP_TIMEOUT_MS to connect, when no session is open yet, and
// N8N_MCP_TIMEOUT_MS again for the whole listing — so at most twice that value
// (15 s each by default, 120 s each at most). A membership removed or
// re-roled, or the connection moved to another Organization, while a
// discovery is in flight does not stop it: that one listing is returned to
// the caller who was authorized when it started, and the very next request is
// decided on the new state.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import { getN8nMcpConnector, type Container } from "../services/container.js";
import { DbBackedRateLimiter, RATE_LIMIT_NAMESPACES } from "../services/rate-limiter.js";
import { IpRateLimiter, type IpRateLimitRule } from "../services/ip-rate-limiter.js";
import { operationalLog } from "../services/observability/index.js";
import type {
  AuthContext,
  AutomationConnectorOwnerReader,
  AutomationConnectorStatus,
  AutomationOperation,
  McpFailureCode,
  TenantMembershipContext,
  TenantMembershipReader,
} from "@jarvis/core";
import {
  authorizeAutomationOperation,
  type AutomationAuthzDenyCode,
  type AutomationResourceScope,
} from "@jarvis/security";
import {
  buildAutomationCatalog,
  isN8nConfigured,
  type AutomationCatalog,
  type AutomationSource,
  type N8nMcpConnector,
  type N8nMcpDiscovery,
  type N8nMcpTool,
} from "@jarvis/n8n";

/** Reaches outside JARVIS once per call, so it is metered per user. */
export const N8N_MCP_RATE_LIMITS = {
  discover: { limit: 30, windowMs: 60_000 },
  catalog: { limit: 30, windowMs: 60_000 },
} as const;

/**
 * Attempts per account, per route, per window — refused or not — counted in
 * process memory BEFORE any database read or audit write (review finding M1).
 * The same size as the metered budget above, so an authorized caller is never
 * throttled sooner than before; with N API instances the ceiling is N times
 * this (ip-rate-limiter.ts states that limitation).
 */
export const N8N_MCP_ATTEMPT_LIMITS = {
  discover: { limit: 30, windowMs: 60_000 },
  catalog: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<"discover" | "catalog", IpRateLimitRule>;

const log = operationalLog.child("n8n-mcp");

// ---------------------------------------------------------------------------
// Phase 17 Stage 2 — authorization
// ---------------------------------------------------------------------------

/** The operation each route performs. Server-side literals, never request values. */
export const N8N_MCP_ROUTE_OPERATIONS = {
  discover: "list",
  catalog: "list",
} as const satisfies Record<"discover" | "catalog", AutomationOperation>;

/**
 * The only operations these routes may perform: explicitly listed, and
 * read-only. Anything else — `describe` included, until a route needs it — is
 * refused even when the engine would allow it.
 */
export const N8N_MCP_READ_OPERATIONS: readonly AutomationOperation[] = ["list"];

/**
 * The surface these routes read, as the route declares it: MCP alone. Stated
 * statically so that authorization comes first and an unauthorized caller
 * learns nothing about whether the surface is configured; the configuration is
 * checked afterwards (`MCP_NOT_CONFIGURED`).
 */
const MCP_DISCOVERY_SURFACE: readonly AutomationConnectorStatus[] = [
  { connector: "mcp", available: true, operations: N8N_MCP_READ_OPERATIONS },
];

/**
 * The deployment-wide connection these routes read, as recorded in
 * `AutomationConnectorOwner`. Must be one of core's `SHARED_CONNECTOR_KEYS`,
 * or the operator command could not assign it an owner.
 */
export const N8N_MCP_CONNECTION_KEY = { providerId: "n8n", connector: "mcp" } as const;

/** A tenant id as the schema writes it. An owner record with anything else is invalid. */
const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Request fields that would name an operation or a scope — a tenant, an
 * organization, a business, an account, a workspace, an owner, a user or an
 * agent. All of them are taken from the server only; a request carrying any of
 * them is refused, never obeyed. Compared case- and separator-insensitively, so
 * `tenant_id` and `Tenant-Id` are the same attempt as `tenantId`.
 */
const SERVER_ONLY_FIELDS: ReadonlySet<string> = new Set([
  "operation",
  "userid",
  "owneruserid",
  "agentid",
  "tenantid",
  "organizationid",
  "orgid",
  "businessid",
  "accountid",
  "workspaceid",
]);

const normalizeField = (key: string) => key.toLowerCase().replace(/[-_\s]/g, "");

/** What the route's organization reads need. The repository implements both. */
export type N8nMcpTenancy = TenantMembershipReader & AutomationConnectorOwnerReader;

export type N8nMcpAccess =
  | { allowed: true }
  | {
      allowed: false;
      status: 401 | 403;
      /** What the caller is told. */
      code: string;
      message: string;
      /** What the audit row records — the precise reason, never shown to the caller. */
      reason: string;
    };

/**
 * Engine refusals that concern WHOSE resource this is. A caller outside the
 * owning organization is told the same thing for every one of them, so the
 * answer cannot be used to learn who owns the connection or whether anybody
 * does.
 */
const TENANT_ACCESS_REASONS: ReadonlySet<AutomationAuthzDenyCode> = new Set<AutomationAuthzDenyCode>([
  "RESOURCE_OWNERSHIP_MISSING",
  "TENANT_MEMBERSHIP_REQUIRED",
  "SCOPE_TENANT_MISMATCH",
  "SCOPE_OWNER_MISMATCH",
  "AGENT_CONTEXT_REQUIRED",
  "AGENT_SCOPE_MISMATCH",
]);

const TENANT_ACCESS_DENIED = {
  status: 403 as const,
  code: "TENANT_ACCESS_DENIED",
  message: "This session has no access to the organization that owns this resource.",
};

/**
 * The route's authorization: the engine's decision for one read on the MCP
 * surface, plus the invariants these routes add on top of it. Pure — the
 * caller has already read the owning tenant and the membership.
 *
 * `agentId` exists so the engine's agent rule is exercised the same way here
 * as elsewhere; the routes pass none, because an HTTP session has no agent.
 */
export function authorizeN8nMcpRead(input: {
  auth: AuthContext | null | undefined;
  membership: TenantMembershipContext | null | undefined;
  agentId?: string;
  operation: string;
  scope: AutomationResourceScope;
}): N8nMcpAccess {
  const decision = authorizeAutomationOperation({
    subject: { auth: input.auth, membership: input.membership, agentId: input.agentId },
    operation: input.operation,
    scope: input.scope,
    connectors: MCP_DISCOVERY_SURFACE,
  });

  if (!decision.allowed) {
    if (decision.code === "IDENTITY_REQUIRED") {
      return {
        allowed: false,
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication required",
        reason: decision.code,
      };
    }
    if (TENANT_ACCESS_REASONS.has(decision.code)) {
      return { allowed: false, ...TENANT_ACCESS_DENIED, reason: decision.code };
    }
    return { allowed: false, status: 403, code: decision.code, message: decision.message, reason: decision.code };
  }

  // Allowed by the engine — and still refused unless it is exactly what these
  // routes are for. Each check stands even if the surface above is widened.
  if (
    !N8N_MCP_READ_OPERATIONS.includes(decision.operation) ||
    decision.risk !== "READ_ONLY" ||
    decision.requiresApproval
  ) {
    return {
      allowed: false,
      status: 403,
      code: "OPERATION_NOT_PERMITTED",
      message: "These endpoints perform read-only discovery only.",
      reason: "OPERATION_NOT_PERMITTED",
    };
  }
  if (decision.surface !== "mcp" || decision.capability !== "mcp:read") {
    return {
      allowed: false,
      status: 403,
      code: "SURFACE_PERMISSION_DENIED",
      message: "The session holds no read capability on the n8n MCP surface.",
      reason: "SURFACE_PERMISSION_DENIED",
    };
  }
  return { allowed: true };
}

/** Whether the query or body tries to name an operation or a scope. */
function carriesServerOnlyField(req: AuthenticatedRequest): boolean {
  const sources = [req.query, req.body] as unknown[];
  return sources.some(
    (source) =>
      source !== null &&
      typeof source === "object" &&
      Object.keys(source).some((key) => SERVER_ONLY_FIELDS.has(normalizeField(key)))
  );
}

/**
 * The connector accessor and the organization reads. Both default to the
 * container's; a test injects its own so no network or database is reached
 * and every path is exercised.
 */
export interface N8nMcpRouterDeps {
  getConnector?: () => N8nMcpConnector | null;
  now?: () => Date;
  /** Owner and membership reads. Defaults to the container's tenant repository. */
  tenancy?: N8nMcpTenancy;
}

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    success: false,
    error: { code, message },
    timestamp: new Date().toISOString(),
  });
}

/**
 * How an upstream discovery failure is presented. The code names the category
 * so an operator can act on it, and the message is a fixed sentence of our own,
 * never the connector's or the server's text. A 502/503/504 keeps an upstream
 * problem from reading as the caller's own authentication failure (which is a
 * 401 and terminated by `requireAuth`, before this code ever runs).
 */
function discoveryFailure(code: McpFailureCode): {
  status: number;
  code: string;
  message: string;
} {
  switch (code) {
    case "AUTH_FAILURE":
      return {
        status: 502,
        code: "MCP_AUTH_FAILURE",
        message: "The n8n MCP server refused JARVIS's configured credentials.",
      };
    case "RATE_LIMITED":
      return {
        status: 503,
        code: "MCP_RATE_LIMITED",
        message: "The n8n MCP server is rate-limiting this deployment.",
      };
    case "TIMEOUT":
    case "CANCELLED":
      return {
        status: 504,
        code: "MCP_TIMEOUT",
        message: "The n8n MCP server did not answer in time.",
      };
    case "SERVER_UNAVAILABLE":
    case "INITIALIZATION_FAILED":
      return {
        status: 502,
        code: "MCP_UNAVAILABLE",
        message: "The n8n MCP server could not be reached.",
      };
    default:
      return {
        status: 502,
        code: "MCP_DISCOVERY_FAILED",
        message: "The n8n MCP server's tool listing could not be read.",
      };
  }
}

/**
 * The safe projection. Names and the server's own annotation flags only — no
 * description, no input schema, nothing the server said about itself beyond its
 * name and version.
 */
function projectDiscovery(discovery: N8nMcpDiscovery): {
  server: { name: string; version: string } | null;
  truncated: boolean;
  count: number;
  tools: Array<{ name: string; readOnly: boolean; destructive: boolean }>;
} {
  return {
    server: discovery.serverInfo
      ? { name: discovery.serverInfo.name, version: discovery.serverInfo.version }
      : null,
    truncated: discovery.truncated,
    count: discovery.tools.length,
    tools: discovery.tools.map((tool) => ({
      name: tool.name,
      readOnly: tool.readOnly,
      destructive: tool.destructive,
    })),
  };
}

/**
 * The wire shape of a record — the descriptive part of an `AutomationRecord`:
 * where it came from, how to address it, and what each surface declares it can
 * do with it.
 *
 * `description` is deliberately NOT returned, for the same reason `/tools`
 * withholds it: a provider's own prose can echo an instance's internals, and it
 * is not what a viewer needs to decide what an automation is. `operations` names
 * a surface's DECLARED capability — nothing here has been executed, and nothing
 * on this route can execute it.
 */
function projectCatalog(catalog: AutomationCatalog): {
  providerId: string;
  count: number;
  records: Array<Record<string, unknown>>;
  connectors: AutomationCatalog["connectors"];
  sources: AutomationCatalog["sources"];
} {
  return {
    providerId: catalog.providerId,
    count: catalog.records.length,
    records: catalog.records.map((record) => ({
      providerId: record.providerId,
      kind: record.kind,
      externalId: record.externalId,
      name: record.name,
      available: record.available,
      operations: record.operations,
      observedVia: record.observedVia,
      handles: record.handles,
      metadata: record.metadata,
    })),
    connectors: catalog.connectors,
    sources: catalog.sources,
  };
}

export function createN8nMcpRouter(
  container: Container,
  deps: N8nMcpRouterDeps = {}
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const limiter = new DbBackedRateLimiter(
    container.auditLogger,
    RATE_LIMIT_NAMESPACES.n8n_mcp
  );
  const getConnector = deps.getConnector ?? getN8nMcpConnector;
  const now = deps.now ?? (() => new Date());
  // Absent (a container without a database): every read below throws, and the
  // request is refused as AUTHORIZATION_UNAVAILABLE — never served unchecked.
  const tenancy: N8nMcpTenancy | undefined = deps.tenancy ?? container.tenantRepo;
  // M1 — the attempt window, per account and per route, before the database.
  // One per router, which production builds once.
  const attempts = new IpRateLimiter(() => now().getTime());

  // One audit row per attempt. The row is also what the limiter counts, so it is
  // written for every outcome, including a refusal. A failure to write it must
  // never change the response, so it is swallowed — the request has already
  // reached an answer either way. The bucket is part of the action, so the two
  // endpoints keep separate budgets.
  const audit = async (
    userId: string,
    bucket: "discover" | "catalog",
    result: "success" | "failure" | "rejected",
    metadata: Record<string, unknown>
  ): Promise<void> => {
    try {
      await container.auditLogger.log({
        userId,
        action: `n8n_mcp.${bucket}`,
        result,
        metadata,
      } as never);
    } catch {
      /* audit must not alter the outcome */
    }
  };

  /**
   * Phase 17 Stages 2 and 3A — answers the request with a refusal and returns
   * null, or returns the owning tenant when this session may perform the
   * route's operation. Runs before the limiter, the connector and discovery,
   * and reads the owner and the membership from the database on every call.
   *
   * A refusal is audited with its precise reason only — never the request's
   * values, and never a tenant id: the row is the caller's own, and must not
   * tell a non-member which organization owns the connection.
   */
  const authorize = async (
    req: AuthenticatedRequest,
    res: Response,
    bucket: "discover" | "catalog"
  ): Promise<{ tenantId: string } | null> => {
    const auth = req.auth;
    const userId = auth?.userId;

    // No identity: refused before anything is counted, read or written.
    if (!auth || typeof userId !== "string" || userId.length === 0) {
      fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      return null;
    }

    // M1 — this attempt takes its place in the window before ANY database
    // access: past the ceiling nothing is read and nothing is written, except
    // the one audit row and log line that mark the start of throttling.
    const attempt = attempts.check(`n8n_mcp:${bucket}:${userId}`, N8N_MCP_ATTEMPT_LIMITS[bucket]);
    if (!attempt.allowed) {
      if (attempt.currentCount === attempt.limit + 1) {
        await audit(userId, bucket, "rejected", { throttled: true });
        log.warn("n8n_mcp_throttled", { bucket });
      }
      res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
      fail(
        res,
        429,
        "RATE_LIMITED",
        bucket === "discover"
          ? "Too many n8n MCP discovery requests; retry later"
          : "Too many n8n MCP automation requests; retry later"
      );
      return null;
    }

    if (carriesServerOnlyField(req)) {
      await audit(userId, bucket, "rejected", { authz: "REQUEST_SCOPE_REFUSED" });
      fail(
        res,
        400,
        "REQUEST_SCOPE_REFUSED",
        "This endpoint takes its operation, organization and owner from the server; they cannot be supplied in the request."
      );
      return null;
    }

    // The owner, then this caller's membership in it — both from the database,
    // now. If either cannot be read, nothing is decided and nothing is served.
    let owner: Awaited<ReturnType<N8nMcpTenancy["findConnectorOwner"]>>;
    let membership: Awaited<ReturnType<N8nMcpTenancy["findMembership"]>> = null;
    try {
      if (!tenancy) throw new Error("tenancy unavailable");
      owner = await tenancy.findConnectorOwner(N8N_MCP_CONNECTION_KEY.providerId, N8N_MCP_CONNECTION_KEY.connector);
      if (owner.status === "assigned" && TENANT_ID_PATTERN.test(owner.tenantId)) {
        membership = await tenancy.findMembership(userId, owner.tenantId);
      }
    } catch {
      await audit(userId, bucket, "rejected", { authz: "AUTHORIZATION_UNAVAILABLE" });
      log.warn("n8n_mcp_authorization_unavailable", { bucket });
      fail(
        res,
        503,
        "AUTHORIZATION_UNAVAILABLE",
        "Organization access could not be verified right now, so nothing was done. Try again."
      );
      return null;
    }

    // Missing or invalid ownership: refused for everyone, with the answer a
    // non-member gets — the connection is never treated as the caller's.
    if (owner.status !== "assigned" || !TENANT_ID_PATTERN.test(owner.tenantId)) {
      const reason = owner.status === "unassigned" ? "RESOURCE_OWNERSHIP_MISSING" : "RESOURCE_OWNERSHIP_INVALID";
      await audit(userId, bucket, "rejected", { authz: reason });
      log.warn("n8n_mcp_access_denied", { bucket, code: reason });
      fail(res, TENANT_ACCESS_DENIED.status, TENANT_ACCESS_DENIED.code, TENANT_ACCESS_DENIED.message);
      return null;
    }
    const tenantId = owner.tenantId;

    const access = authorizeN8nMcpRead({
      auth,
      membership: membership ? { tenantId, userId, role: membership.role } : null,
      operation: N8N_MCP_ROUTE_OPERATIONS[bucket],
      scope: { tenantId },
    });
    if (!access.allowed) {
      await audit(userId, bucket, "rejected", { authz: access.reason });
      log.warn("n8n_mcp_access_denied", { bucket, code: access.reason });
      fail(res, access.status, access.code, access.message);
      return null;
    }
    return { tenantId };
  };

  router.get(
    "/tools",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) {
        fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
        return;
      }
      const userId = req.auth.userId;
      const access = await authorize(req, res, "discover");
      if (!access) return;

      const { limit, windowMs } = N8N_MCP_RATE_LIMITS.discover;
      const decision = await limiter.check(
        userId,
        "discover",
        limit,
        windowMs,
        now()
      );
      if (!decision.allowed) {
        await audit(userId, "discover", "rejected", { rateLimited: true });
        fail(res, 429, "RATE_LIMITED", "Too many n8n MCP discovery requests; retry later");
        return;
      }

      const connector = getConnector();
      if (!connector) {
        await audit(userId, "discover", "failure", { reason: "not_configured" });
        fail(
          res,
          404,
          "MCP_NOT_CONFIGURED",
          "The n8n MCP surface is not configured on this server."
        );
        return;
      }

      const result = await connector.discoverTools();
      if (!result.ok) {
        // Report the category, never the server's wording.
        const { status, code, message } = discoveryFailure(result.failure.code);
        await audit(userId, "discover", "failure", { reason: result.failure.code });
        log.warn("n8n_mcp_discover_failed", { code: result.failure.code });
        fail(res, status, code, message);
        return;
      }

      await audit(userId, "discover", "success", { count: result.data.tools.length, tenantId: access.tenantId });
      log.info("n8n_mcp_discovered", {
        count: result.data.tools.length,
        truncated: result.data.truncated,
      });
      ok(res, projectDiscovery(result.data));
    })
  );

  // -------------------------------------------------------------------------
  // GET /automations — the unified, read-only view (Stage 2)
  //
  // Same session guard, same metering and the same error contract as `/tools`:
  // this is a read of the very same surface, so a failure of that surface must
  // not be papered over as an empty view. What differs is the answer — records
  // normalized through the Automation Registry, each carrying its provenance,
  // and an explicit statement of what each surface contributed or did not.
  // -------------------------------------------------------------------------
  router.get(
    "/automations",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) {
        fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
        return;
      }
      const userId = req.auth.userId;
      const access = await authorize(req, res, "catalog");
      if (!access) return;

      const { limit, windowMs } = N8N_MCP_RATE_LIMITS.catalog;
      const decision = await limiter.check(userId, "catalog", limit, windowMs, now());
      if (!decision.allowed) {
        await audit(userId, "catalog", "rejected", { rateLimited: true });
        fail(res, 429, "RATE_LIMITED", "Too many n8n MCP automation requests; retry later");
        return;
      }

      const connector = getConnector();
      if (!connector) {
        await audit(userId, "catalog", "failure", { reason: "not_configured" });
        fail(
          res,
          404,
          "MCP_NOT_CONFIGURED",
          "The n8n MCP surface is not configured on this server."
        );
        return;
      }

      const discovery = await connector.discoverTools();
      if (!discovery.ok) {
        const { status, code, message } = discoveryFailure(discovery.failure.code);
        await audit(userId, "catalog", "failure", { reason: discovery.failure.code });
        log.warn("n8n_mcp_catalog_failed", { code: discovery.failure.code });
        fail(res, status, code, message);
        return;
      }

      // The MCP surface was read. The REST surface is not read here at all — so
      // it is reported UNREAD with a reason, never as an empty list. Nothing
      // fabricates a workflow JARVIS did not see on this request.
      const mcp: AutomationSource<N8nMcpTool> = {
        available: true,
        items: discovery.data.tools,
      };
      const catalog = buildAutomationCatalog({
        rest: {
          available: false,
          reason: isN8nConfigured()
            ? "The n8n REST surface is not read by this endpoint."
            : "The n8n REST surface is not configured on this server.",
        },
        mcp,
      });

      await audit(userId, "catalog", "success", {
        count: catalog.records.length,
        mcpCount: discovery.data.tools.length,
        tenantId: access.tenantId,
      });
      log.info("n8n_mcp_catalog_built", { count: catalog.records.length });
      ok(res, projectCatalog(catalog));
    })
  );

  return router;
}
