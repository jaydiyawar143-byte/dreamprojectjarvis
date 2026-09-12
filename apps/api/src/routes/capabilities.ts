// ---------------------------------------------------------------------------
// Capability discovery over HTTP.
//
// The same rule as the integrations router: this file holds NO logic. Each
// handler reads `req.auth.userId`, calls the one `CapabilityService`, and
// serialises the result. The JARVIS capability tools call that same instance
// through `CapabilityPort`, so a rendered page and a spoken answer cannot
// report different capabilities.
//
// Every response is a READ. Nothing here can execute a capability it describes.
//
// Identifiers arrive already masked — the service masks at construction, so
// there is no field on these responses that could carry a full account id.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { resolveIntegrationAlias } from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";

export function createCapabilitiesRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const capabilities = container.capabilities;

  function ok(res: Response, data: unknown): void {
    res.status(200).json({ success: true, data, timestamp: new Date().toISOString() });
  }

  function fail(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({
      success: false,
      error: { code, message },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Capability discovery needs integration state, which needs the encryption
   * key. Without it the honest answer is a 503 that names the reason, not a
   * partial report that looks authoritative.
   */
  function unavailable(res: Response): void {
    fail(
      res,
      503,
      "NOT_CONFIGURED",
      "Capability discovery is unavailable because JARVIS_ENCRYPTION_KEY is not set, so integration state cannot be read."
    );
  }

  // GET / — the full report.
  router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    if (!capabilities) return unavailable(res);

    try {
      ok(res, await capabilities.report(req.auth.userId));
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not read capabilities");
    }
  });

  // GET /connected — integrations whose REAL connection state is connected.
  router.get("/connected", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    if (!capabilities) return unavailable(res);

    try {
      const connected = await capabilities.connectedIntegrations(req.auth.userId);
      ok(res, { connected, count: connected.length });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not read connected integrations");
    }
  });

  // GET /permissions — registered versus granted, kept apart.
  router.get("/permissions", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    if (!capabilities) return unavailable(res);

    try {
      ok(res, await capabilities.permissions(req.auth.userId));
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not read permissions");
    }
  });

  // GET /:integration — one integration, accepting a common name.
  router.get("/:integration", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    if (!capabilities) return unavailable(res);

    // Resolved through the SAME alias table the JARVIS tool uses, so "gmail"
    // means the same thing on both paths.
    const resolved = resolveIntegrationAlias(req.params.integration ?? "");
    if (!resolved) return fail(res, 404, "NOT_FOUND", "Unknown integration");

    try {
      const view = await capabilities.forIntegration(req.auth.userId, resolved);
      if (!view) return fail(res, 404, "NOT_FOUND", "Unknown integration");
      ok(res, view);
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not read integration capabilities");
    }
  });

  return router;
}
