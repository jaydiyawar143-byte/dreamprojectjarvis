// ---------------------------------------------------------------------------
// Integration Control Center — the unified READ and TEST surface.
//
// WHAT THIS ROUTER DELIBERATELY DOES NOT DO.
//
// It does not store credentials, run an OAuth flow, or delete a connection.
// Every one of those already exists — `PUT /credentials/:provider`,
// `POST /google/connect`, `DELETE /credentials/:provider` — each with its own
// validation, encryption and audit. Adding a second write path to the same
// encrypted store would mean two places that can save a secret and two places
// that can forget to audit it.
//
// So this router answers "what is the state of everything, and does it actually
// work", and hands the browser the EXISTING endpoint to call for each action
// (`actions.connectUrl`, `configureUrl`, `disconnectUrl`). The Control Center
// drives those; it does not reimplement them.
//
// It also does not execute anything. Connecting an integration is
// configuration; running an external action is execution, and execution goes
// USER → Orchestrator → agent → ToolExecutor → permission → approval → audit.
// There is no endpoint here that a dashboard button could use to skip that.
//
// TESTS ARE READS. Every connection test below is the cheapest call that proves
// a credential works, and not one of them writes anything: no message is sent,
// no workflow triggered, no campaign touched.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import {
  getIntegration,
  invalidateChecks,
  listIntegrations,
  runCheck,
  type IntegrationDeps,
} from "../services/integration-registry.js";

export function createIntegrationsRouter(
  container: Container,
  deps: IntegrationDeps
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

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

  // -------------------------------------------------------------------------
  // GET / — every integration, for the AUTHENTICATED user only.
  //
  // Tenant isolation is structural: `req.auth.userId` is the only id that
  // reaches the registry, and there is no query parameter that could name a
  // different one. A user cannot enumerate anybody else's connections.
  //
  // This does NOT call five external APIs. It reports what is configured plus
  // the last verified result; anything unverified comes back as UNVERIFIED, so
  // the UI can say "not checked" rather than claiming a connection it has not
  // seen work.
  // -------------------------------------------------------------------------
  router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    try {
      ok(res, { integrations: await listIntegrations(req.auth.userId, deps) });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not read integration status");
    }
  });

  // -------------------------------------------------------------------------
  // GET /:integration — one integration, same shape as a list entry.
  // -------------------------------------------------------------------------
  router.get("/:integration", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    try {
      const found = await getIntegration(req.auth.userId, req.params.integration ?? "", deps);
      if (!found) return fail(res, 404, "NOT_FOUND", "Unknown integration");
      ok(res, found);
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not read integration status");
    }
  });

  // -------------------------------------------------------------------------
  // POST /:integration/test — a REAL call to the provider.
  //
  // Every outcome is audited, success and failure alike, because "who checked
  // this credential and when" is exactly the question asked after an incident.
  // The audit metadata carries the integration id and the verdict — never the
  // credential, and never the provider's raw response.
  // -------------------------------------------------------------------------
  router.post("/:integration/test", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const id = req.params.integration ?? "";

    try {
      const result = await runCheck(req.auth.userId, id, deps);
      if (!result) return fail(res, 404, "NOT_FOUND", "Unknown integration");

      await container.auditLogger?.log({
        userId: req.auth.userId,
        action: "integration.test",
        result: result.health === "CONNECTED" ? "success" : "failure",
        metadata: { integration: id, health: result.health },
      });

      ok(res, result);
    } catch {
      // A thrown test is itself a result the operator should see, but the
      // exception text is not — it can carry a URL with a token in it.
      fail(res, 500, "INTERNAL_ERROR", "The connection test could not be completed");
    }
  });

  // -------------------------------------------------------------------------
  // POST /:integration/refresh — forget the cached verdict.
  //
  // Called after connect, configure or disconnect so the card cannot keep
  // showing a verdict that predates the change. It performs no external call
  // and reveals nothing; it only drops this user's own cache entry.
  // -------------------------------------------------------------------------
  router.post("/:integration/refresh", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const id = req.params.integration ?? "";
    const found = await getIntegration(req.auth.userId, id, deps);
    if (!found) return fail(res, 404, "NOT_FOUND", "Unknown integration");

    invalidateChecks(req.auth.userId, id);
    ok(res, await getIntegration(req.auth.userId, id, deps));
  });

  return router;
}
