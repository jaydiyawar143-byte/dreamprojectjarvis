// ---------------------------------------------------------------------------
// Google write routes — Phase 13.
//
//   POST /plan                  describe a write, create a PENDING approval
//   GET  /:approvalId           read a plan and its current status
//   POST /:approvalId/execute   perform it, if and only if APPROVED
//
// APPROVING IS NOT HERE. It happens on the existing `/approvals/:id/approve`
// endpoint, deliberately: approval is one concept in this system with one
// durable store and one audit trail, and giving Google writes their own
// approve button would create a second way to say yes that the Approvals page
// would not know about.
//
// THIS ROUTER HOLDS NO GATE LOGIC. `plan` and `execute` are one-line
// translations onto `GoogleWriteService`, which owns every check. The gate
// itself is `consumeForExecution` — one database transaction verifying user,
// tool, payload hash, APPROVED status and expiry, then flipping to CONSUMED.
// A check written in this file would be a check the JARVIS path does not
// perform.
//
// TENANT ISOLATION IS STRUCTURAL. `req.auth.userId` is the only user id that
// reaches the service, and no route accepts one as a parameter, so a user
// cannot plan, read or execute against anybody else's approvals. A wrong-user
// approval id returns the same "does not exist" as a fabricated one, so ids
// cannot be probed for.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import type { GoogleWritePlanResult, GoogleWriteResult } from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";

/** Plan statuses → the HTTP status that means the same thing. */
const PLAN_STATUS: Record<GoogleWritePlanResult["status"], number> = {
  // 202: understood, recorded, and waiting on a human. Not 200 — nothing has
  // been done yet, and a 200 invites a client to render it as complete.
  approval_required: 202,
  invalid: 400,
  not_connected: 409,
  needs_reauth: 409,
  permission_missing: 403,
};

export function createGoogleWritesRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const writes = container.googleWrites;

  function traceOf(req: AuthenticatedRequest): string | undefined {
    return (req as { traceId?: string }).traceId;
  }

  /**
   * Reports why writes are unavailable, rather than 404ing.
   *
   * A missing route is not something a UI can act on; "this server has no
   * Google OAuth client" is.
   */
  function unavailable(res: Response): void {
    res.status(503).json({
      success: false,
      status: "not_connected",
      plan: null,
      approvalId: null,
      message:
        "Google write actions are unavailable on this server: they need a Google OAuth client and JARVIS_ENCRYPTION_KEY.",
      requiredAction:
        "Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and JARVIS_ENCRYPTION_KEY, then restart.",
      requestId: null,
    });
  }

  function unauthenticated(res: Response): void {
    res.status(401).json({
      success: false,
      error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
    });
  }

  // -------------------------------------------------------------------------
  // POST /plan — describes the write. Calls NO provider endpoint.
  // -------------------------------------------------------------------------
  router.post("/plan", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return unauthenticated(res);
    if (!writes) return unavailable(res);

    const action = typeof req.body?.action === "string" ? req.body.action : "";
    const params =
      req.body?.params && typeof req.body.params === "object" && !Array.isArray(req.body.params)
        ? (req.body.params as Record<string, unknown>)
        : {};

    const result = await writes.plan(action, params, {
      userId: req.auth.userId,
      source: "frontend",
      ...(traceOf(req) ? { traceId: traceOf(req)! } : {}),
      ...(typeof req.body?.conversationId === "string"
        ? { conversationId: req.body.conversationId }
        : {}),
    });

    res.status(PLAN_STATUS[result.status] ?? 400).json(result);
  });

  // -------------------------------------------------------------------------
  // GET /:approvalId — the plan and its current status.
  //
  // User-scoped, so this is also how the UI refreshes a pending approval
  // without being able to see anybody else's.
  // -------------------------------------------------------------------------
  router.get("/:approvalId", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return unauthenticated(res);
    if (!writes) return unavailable(res);

    const view = await writes.describe(req.params.approvalId ?? "", req.auth.userId);
    if (!view) {
      // The same answer as a fabricated id: an approval belonging to someone
      // else must not be distinguishable from one that never existed.
      res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "That approval does not exist." },
      });
      return;
    }

    res.status(200).json({ success: true, data: view });
  });

  // -------------------------------------------------------------------------
  // POST /:approvalId/execute — performs the write.
  //
  // Requires an APPROVED, unexpired, unconsumed approval whose payload hash
  // still matches. All five conditions are enforced in one transaction inside
  // the service; this route only reports the outcome.
  // -------------------------------------------------------------------------
  router.post(
    "/:approvalId/execute",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) return unauthenticated(res);
      if (!writes) return unavailable(res);

      const result: GoogleWriteResult = await writes.execute(req.params.approvalId ?? "", {
        userId: req.auth.userId,
        source: "frontend",
        ...(traceOf(req) ? { traceId: traceOf(req)! } : {}),
        // Explicitly NOT voice: this is an HTTP request from a rendered page.
        // The voice path cannot reach this route, and the service refuses a
        // voice context anyway.
        voice: false,
      });

      // A refused execution is a failed request, with the status naming why.
      // 409 for "the approval is not in a state that permits this", which
      // covers unapproved, expired, reused and payload-mismatch alike — the
      // client's remedy is the same in every case: plan again.
      const status = result.success
        ? 200
        : result.status === "needs_reauth" || result.status === "not_connected"
          ? 409
          : result.status === "permission_missing"
            ? 403
            : result.verification === "indeterminate"
              ? 504
              : 409;

      res.status(status).json(result);
    }
  );

  return router;
}
