// ---------------------------------------------------------------------------
// Integration Control Center — the HTTP face of IntegrationCommandService.
//
// THIS ROUTER HOLDS NO BUSINESS LOGIC. Every handler does the same three
// things: read `req.auth.userId`, translate the request into an
// `IntegrationCommandInput`, and hand it to the command service. There is no
// validation here that the service does not also perform, no provider call, and
// no branch that a JARVIS command would not equally take — because the JARVIS
// tools call the SAME service with the SAME input shape.
//
// That is the whole design. If this file grew a check of its own, that check
// would be absent from the voice path, and the two ways of operating an
// integration would have quietly stopped being equivalent.
//
// TENANT ISOLATION IS STRUCTURAL. `req.auth.userId` is the only user id that
// reaches the service; no route accepts one as a parameter, so a user cannot
// name, enumerate or act on anybody else's connections.
//
// THE OLD ENDPOINTS STILL WORK. `GET /`, `GET /:id`, `POST /:id/test` and
// `POST /:id/refresh` keep their paths and their response envelope, because a
// deployed frontend is calling them. They now route through the command
// service like everything else.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import {
  isIntegrationId,
  type IntegrationCommand,
  type IntegrationCommandContext,
  type IntegrationCommandInput,
  type IntegrationCommandResult,
  type IntegrationErrorCode,
  type IntegrationId,
} from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import {
  getIntegration,
  invalidateChecks,
  listIntegrations,
  runCheck,
  type IntegrationDeps,
} from "../services/integration-registry.js";

/** Maps a command failure onto the HTTP status that means the same thing. */
const STATUS_FOR: Record<IntegrationErrorCode, number> = {
  UNKNOWN_INTEGRATION: 404,
  NOT_CONFIGURED: 503,
  NOT_CONNECTED: 409,
  INVALID_CONFIG: 400,
  NEEDS_REAUTH: 409,
  PERMISSION_DENIED: 403,
  // 428 Precondition Required: the request is well-formed and permitted, but a
  // confirmation must be obtained first. Distinct from 403, which would tell
  // the client it may never do this.
  CONFIRMATION_REQUIRED: 428,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  TIMEOUT: 504,
  UNSUPPORTED_COMMAND: 405,
  INTERNAL_ERROR: 500,
};

export function createIntegrationsRouter(
  container: Container,
  deps: IntegrationDeps
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const commands = container.integrationCommands;

  function ok(res: Response, data: unknown, status = 200): void {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
  }

  function fail(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
    res.status(status).json({
      success: false,
      error: { code, message, ...(extra ?? {}) },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Serialises a command result into this API's envelope.
   *
   * A failed COMMAND is a failed REQUEST, with a status that matches the reason.
   * Returning 200 with `ok: false` would make every client responsible for
   * remembering to look, and some client eventually would not.
   */
  function send(res: Response, result: IntegrationCommandResult): void {
    if (result.ok) {
      ok(res, {
        ...(typeof result.data === "object" && result.data !== null ? result.data : { result: result.data }),
        message: result.message,
        ...(result.view ? { view: result.view } : {}),
      });
      return;
    }

    fail(res, STATUS_FOR[result.code] ?? 500, result.code, result.message, {
      ...(result.confirmationRequired ? { confirmation: result.confirmationRequired } : {}),
    });
  }

  /** Builds the command context from the authenticated session. Never from the body. */
  function contextOf(req: AuthenticatedRequest): IntegrationCommandContext {
    return {
      userId: req.auth!.userId,
      // The caller's REAL role. Not defaulted upward: an absent role becomes
      // the lowest one inside the service.
      ...(req.auth!.role ? { role: req.auth!.role } : {}),
      source: "frontend",
      ...((req as { traceId?: string }).traceId ? { traceId: (req as { traceId?: string }).traceId! } : {}),
    };
  }

  /**
   * Runs a command, or explains why the integration layer is unavailable.
   *
   * The `commands === null` case is a deployment without an encryption key. It
   * is reported as a 503 with the reason rather than as a missing route,
   * because "this endpoint does not exist" is not something a UI can act on and
   * "set JARVIS_ENCRYPTION_KEY" is.
   */
  async function run(
    req: AuthenticatedRequest,
    res: Response,
    input: IntegrationCommandInput
  ): Promise<void> {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    if (!commands) {
      return fail(
        res,
        503,
        "NOT_CONFIGURED",
        "Integration management is unavailable because JARVIS_ENCRYPTION_KEY is not set on this server, so third-party credentials cannot be stored safely."
      );
    }
    send(res, await commands.execute(input, contextOf(req)));
  }

  /** Reads and validates the `:integration` path parameter. */
  function integrationParam(req: AuthenticatedRequest): IntegrationId | null {
    const raw = req.params.integration ?? "";
    return isIntegrationId(raw) ? raw : null;
  }

  // -------------------------------------------------------------------------
  // Catalogue — what this deployment can manage at all.
  //
  // Static, so it needs no user scope and touches no provider. The UI uses it
  // to render configuration forms from the SAME field specs the server
  // validates against, which is what stops the two disagreeing about what a
  // valid customer id looks like.
  // -------------------------------------------------------------------------
  router.get("/catalog", requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
    const { INTEGRATION_CATALOG, GOOGLE_SERVICES } = await import("@jarvis/core");
    ok(res, {
      integrations: INTEGRATION_CATALOG,
      googleServices: GOOGLE_SERVICES,
    });
  });

  // -------------------------------------------------------------------------
  // GET / — every integration, for the AUTHENTICATED user only.
  //
  // Does NOT call five external APIs. It reports what is configured plus the
  // last verified result; anything unverified comes back as UNVERIFIED so the
  // UI says "not checked" rather than claiming a connection it has not seen
  // work.
  // -------------------------------------------------------------------------
  router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    // Legacy shape when the command service is unavailable: the read-only
    // registry still works without an encryption key, and a status page that
    // renders is more useful than a 503.
    if (!commands) {
      try {
        return ok(res, { integrations: await listIntegrations(req.auth.userId, deps) });
      } catch {
        return fail(res, 500, "INTERNAL_ERROR", "Could not read integration status");
      }
    }

    const result = await commands.execute({ command: "list", integration: null }, contextOf(req));
    if (!result.ok) return fail(res, STATUS_FOR[result.code] ?? 500, result.code, result.message);
    ok(res, result.data);
  });

  // -------------------------------------------------------------------------
  // GET /:integration — one integration's full state.
  // -------------------------------------------------------------------------
  router.get("/:integration", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");

    if (!commands) {
      const found = await getIntegration(req.auth.userId, id, deps);
      if (!found) return fail(res, 404, "NOT_FOUND", "Unknown integration");
      return ok(res, found);
    }

    const result = await commands.execute({ command: "status", integration: id }, contextOf(req));
    if (!result.ok) return fail(res, STATUS_FOR[result.code] ?? 500, result.code, result.message);
    ok(res, result.data);
  });

  // -------------------------------------------------------------------------
  // POST /:integration/test — a REAL call to the provider.
  //
  // Every outcome is audited inside the command service, success and failure
  // alike, because "who checked this credential and when" is exactly the
  // question asked after an incident.
  // -------------------------------------------------------------------------
  router.post("/:integration/test", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");

    if (!commands) {
      try {
        const result = await runCheck(req.auth.userId, id, deps);
        if (!result) return fail(res, 404, "NOT_FOUND", "Unknown integration");
        await container.auditLogger?.log({
          userId: req.auth.userId,
          action: "integration.test",
          result: result.health === "CONNECTED" ? "success" : "failure",
          metadata: { integration: id, health: result.health },
        });
        return ok(res, result);
      } catch {
        return fail(res, 500, "INTERNAL_ERROR", "The connection test could not be completed");
      }
    }

    // The legacy response body was the CheckResult itself, so it is returned
    // flat here rather than nested — an existing client must keep working.
    const result = await commands.execute({ command: "testConnection", integration: id }, contextOf(req));
    if (result.ok) return ok(res, result.data);
    fail(res, STATUS_FOR[result.code] ?? 500, result.code, result.message);
  });

  // -------------------------------------------------------------------------
  // POST /:integration/refresh — forget the cached verdict.
  //
  // Performs no external call and reveals nothing; it drops this user's own
  // cache entry so a card cannot keep showing a verdict that predates a change.
  // -------------------------------------------------------------------------
  router.post("/:integration/refresh", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");

    invalidateChecks(req.auth.userId, id);

    if (!commands) return ok(res, await getIntegration(req.auth.userId, id, deps));

    const result = await commands.execute({ command: "status", integration: id }, contextOf(req));
    if (!result.ok) return fail(res, STATUS_FOR[result.code] ?? 500, result.code, result.message);
    ok(res, result.data);
  });

  // -------------------------------------------------------------------------
  // The management verbs.
  //
  // One route each rather than a single `POST /:integration/command` taking a
  // verb in the body: distinct paths are what let the reverse proxy, the access
  // log and a future per-verb rate limit tell a disconnect from a status read.
  // Each one is still a one-line translation into the same command input.
  // -------------------------------------------------------------------------

  /** Begins OAuth consent. Returns a URL; the caller decides how to present it. */
  router.post("/:integration/connect", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");

    const services = Array.isArray(req.body?.services)
      ? (req.body.services as unknown[]).filter((s): s is string => typeof s === "string")
      : undefined;

    // `accessLevel: "write"` is how a write upgrade is requested. It must be
    // named explicitly — there is no way to obtain a write scope by omission.
    const accessLevel = req.body?.accessLevel === "write" ? "write" : "read";

    await run(req, res, {
      command: "connect",
      integration: id,
      accessLevel,
      ...(services ? { services } : {}),
    });
  });

  /** Saves configuration. Secrets travel in; nothing secret comes back. */
  router.put("/:integration/config", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");

    await run(req, res, {
      command: "configure",
      integration: id,
      config: (req.body?.config ?? {}) as Record<string, string>,
    });
  });

  /** Validates without saving. Same validator, so the two cannot disagree. */
  router.post("/:integration/validate", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");

    await run(req, res, {
      command: "validateConfig",
      integration: id,
      config: (req.body?.config ?? {}) as Record<string, string>,
    });
  });

  router.get("/:integration/permissions", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");
    await run(req, res, { command: "getPermissions", integration: id });
  });

  router.get("/:integration/health", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");
    await run(req, res, { command: "getHealth", integration: id });
  });

  router.get("/:integration/audit", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");

    const raw = Number.parseInt(String(req.query.limit ?? ""), 10);
    await run(req, res, {
      command: "getAudit",
      integration: id,
      ...(Number.isFinite(raw) ? { limit: raw } : {}),
    });
  });

  router.post("/:integration/reconnect", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");
    await run(req, res, { command: "reconnect", integration: id });
  });

  router.post("/:integration/enable", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");
    await run(req, res, { command: "enable", integration: id });
  });

  router.post("/:integration/disable", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");
    await run(req, res, { command: "disable", integration: id });
  });

  router.delete("/:integration", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");
    await run(req, res, { command: "disconnect", integration: id });
  });

  /**
   * Runs a provider action.
   *
   * Anything that writes outside JARVIS answers 428 with a confirmation
   * summary the first time, and only runs when the caller echoes the token
   * back. The token is bound to these exact parameters, so a confirmation for
   * one campaign cannot be replayed against another.
   */
  router.post("/:integration/actions/:action", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const id = integrationParam(req);
    if (!id) return fail(res, 404, "NOT_FOUND", "Unknown integration");

    await run(req, res, {
      command: "executeAction",
      integration: id,
      actionId: req.params.action ?? "",
      actionParams: (req.body?.params ?? {}) as Record<string, unknown>,
      ...(typeof req.body?.confirmationToken === "string"
        ? { confirmationToken: req.body.confirmationToken }
        : {}),
    });
  });

  return router;
}

/** Exported for the parity test, which asserts both paths use the same verbs. */
export const INTEGRATION_ROUTE_COMMANDS: readonly IntegrationCommand[] = [
  "list",
  "status",
  "connect",
  "configure",
  "validateConfig",
  "testConnection",
  "getPermissions",
  "reconnect",
  "enable",
  "disable",
  "disconnect",
  "getHealth",
  "getAudit",
  "executeAction",
];
