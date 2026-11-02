// ---------------------------------------------------------------------------
// Phase 19, Stage 19.6 — the Computer Control page's routes.
//
// Authenticated people only, and every decision is DesktopControlService's:
// this router turns HTTP into calls and answers, nothing more. Mounted only
// when the desktop agent is enabled; otherwise none of these paths exist.
//
//   GET  /organizations                         what the caller administers: id, name
//   POST /pairings                              a one-time code (Owner/Admin)
//   GET  /devices                               own devices, and administered ones
//   POST /devices/:id/confirm                   the fingerprint, compared by its user
//   POST /devices/:id/revoke                    its user, or an Owner/Admin
//   POST /devices/:id/session/end               end control now
//   POST /devices/:id/commands                  ask for one command → an approval
//   POST /devices/:id/approvals/:approvalId/confirm   approve and send it
//   GET  /devices/:id/commands, /commands/:id   what happened
//
// The three command routes are beyond the brief's five: they are how a person
// drives a device from the web UI. Chat reaches the same service through its own
// port (Stage 19.7) and never these routes. So is /organizations: pairing names its Organization, and it is how the page knows
// what to offer.
// ---------------------------------------------------------------------------

import { Router, type Response } from "express";

import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import { DesktopControlError, type DesktopControlService } from "../services/desktop/desktop-control-service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPROVAL_ID = /^[a-zA-Z0-9_-]{8,64}$/;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message }, timestamp: new Date().toISOString() });
}

export function createDesktopRouter(container: Container, service: DesktopControlService): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  /** Runs one service call for an authenticated person; its refusals become their fixed answers. */
  const handle =
    (work: (userId: string, req: AuthenticatedRequest) => Promise<unknown>) =>
    async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      for (const [name, pattern] of [["id", UUID], ["approvalId", APPROVAL_ID]] as const) {
        const value = req.params[name];
        if (value !== undefined && !pattern.test(value)) return fail(res, 404, "NOT_FOUND", "Not found.");
      }
      try {
        const data = await work(req.auth.userId, req);
        res.status(200).json({ success: true, data: data ?? null, timestamp: new Date().toISOString() });
      } catch (error) {
        if (error instanceof DesktopControlError) return fail(res, error.status, error.code, error.message);
        fail(res, 503, "UNAVAILABLE", "Desktop control is not available right now; nothing was done.");
      }
    };

  router.get("/organizations", requireAuth, handle((userId) => service.listOrganizations(userId)));
  router.post("/pairings", requireAuth, handle((userId, req) => service.createPairingCode(userId, { organizationId: req.body?.organizationId })));
  router.get("/devices", requireAuth, handle((userId) => service.listDevices(userId)));
  router.post("/devices/:id/confirm", requireAuth, handle((userId, req) => service.confirmDevice(userId, req.params.id!, { fingerprint: req.body?.fingerprint })));
  router.post("/devices/:id/revoke", requireAuth, handle((userId, req) => service.revokeDevice(userId, req.params.id!)));
  router.post("/devices/:id/session/end", requireAuth, handle((userId, req) => service.endSession(userId, req.params.id!)));
  router.post("/devices/:id/commands", requireAuth, handle((userId, req) => service.requestCommand(userId, req.params.id!, req.body)));
  router.post(
    "/devices/:id/approvals/:approvalId/confirm",
    requireAuth,
    handle((userId, req) => service.confirmCommand(userId, req.params.id!, req.params.approvalId!))
  );
  router.get("/devices/:id/commands", requireAuth, handle((userId, req) => service.listCommands(userId, req.params.id!)));
  router.get("/commands/:id", requireAuth, handle((userId, req) => service.getCommand(userId, req.params.id!)));
  return router;
}
