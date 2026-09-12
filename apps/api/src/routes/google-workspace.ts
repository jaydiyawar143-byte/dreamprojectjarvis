// ---------------------------------------------------------------------------
// Gmail, Drive and Calendar over HTTP — Phase 12.
//
// NO LOGIC LIVES HERE. Each handler reads `req.auth.userId`, names an action,
// forwards the query parameters and returns the envelope. The JARVIS Workspace
// tools call the SAME `GoogleWorkspaceTaskService` with the same action names,
// so a dashboard panel and a spoken request run identical checks — availability,
// enabled state, rate limit, connection, scope, refresh, audit.
//
// THE ENVELOPE IS RETURNED AS-IS, INCLUDING ITS STATUS. A `needs_reauth` is not
// flattened into a 500: the HTTP status carries the category and the body
// carries the remedy, so the UI can render a Reconnect button rather than a
// generic failure.
//
// EVERY ROUTE IS A GET. This phase is read-only, and a router with no POST
// handler cannot be where a write appears by accident.
//
// NO TOKEN CROSSES THIS BOUNDARY. The service returns normalized domain types
// that have no field for one; the access token exists only inside the provider
// call's Authorization header.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import type { GoogleTaskResult, GoogleTaskStatus } from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";

/** Maps a task status onto the HTTP status that means the same thing. */
const STATUS_FOR: Record<GoogleTaskStatus, number> = {
  ok: 200,
  // 409 Conflict: the request is valid and permitted, but the account is in the
  // wrong state for it. Distinct from 403, which would say "never".
  not_connected: 409,
  needs_reauth: 409,
  permission_missing: 403,
  provider_error: 502,
};

export function createGoogleWorkspaceRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const workspace = container.googleWorkspace;

  /** Serialises the envelope. The shape is identical on both paths. */
  function send(res: Response, result: GoogleTaskResult<unknown>): void {
    res.status(STATUS_FOR[result.status] ?? 500).json(result);
  }

  /**
   * Runs one action, or explains why Workspace access is unavailable.
   *
   * Reported as a 503 naming the reason rather than a 404: a missing route is
   * not something a UI can act on, and "Google is not configured on this
   * server" is.
   */
  async function run(
    req: AuthenticatedRequest,
    res: Response,
    action: string,
    params: Record<string, unknown>
  ): Promise<void> {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        source: "gmail",
        status: "not_connected",
        data: null,
        message: "Authentication required",
      });
      return;
    }

    if (!workspace) {
      res.status(503).json({
        success: false,
        source: action.split(".")[0],
        status: "not_connected",
        data: null,
        message:
          "Google Workspace access is unavailable on this server: it needs a Google OAuth client and JARVIS_ENCRYPTION_KEY.",
        requiredAction: "Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and JARVIS_ENCRYPTION_KEY, then restart.",
      });
      return;
    }

    // Tenant isolation is structural: `req.auth.userId` is the only id that
    // reaches the service, and no route accepts one as a parameter.
    send(
      res,
      await workspace.executeTask(
        { action, params },
        {
          userId: req.auth.userId,
          source: "frontend",
          ...((req as { traceId?: string }).traceId
            ? { traceId: (req as { traceId?: string }).traceId! }
            : {}),
        }
      )
    );
  }

  /** Bounded integer query parameter. The service clamps again. */
  const num = (req: AuthenticatedRequest, name: string): number | undefined => {
    const raw = Number(req.query[name]);
    return Number.isFinite(raw) ? raw : undefined;
  };

  const str = (req: AuthenticatedRequest, name: string): string | undefined =>
    typeof req.query[name] === "string" ? (req.query[name] as string) : undefined;

  // -------------------------------------------------------------------------
  // Gmail
  // -------------------------------------------------------------------------

  router.get("/gmail/unread", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await run(req, res, "gmail.listUnread", { limit: num(req, "limit") });
  });

  router.get("/gmail/search", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await run(req, res, "gmail.search", {
      query: str(req, "q"),
      limit: num(req, "limit"),
      pageToken: str(req, "pageToken"),
    });
  });

  router.get("/gmail/messages/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await run(req, res, "gmail.getMessage", { messageId: req.params.id });
  });

  router.get("/gmail/threads/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await run(req, res, "gmail.getThread", { threadId: req.params.id });
  });

  // -------------------------------------------------------------------------
  // Drive
  // -------------------------------------------------------------------------

  router.get("/drive/search", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await run(req, res, "drive.searchFiles", {
      query: str(req, "q"),
      limit: num(req, "limit"),
      pageToken: str(req, "pageToken"),
    });
  });

  router.get("/drive/recent", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await run(req, res, "drive.listRecentFiles", {
      limit: num(req, "limit"),
      pageToken: str(req, "pageToken"),
    });
  });

  router.get("/drive/files/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await run(req, res, "drive.getFileMetadata", { fileId: req.params.id });
  });

  // -------------------------------------------------------------------------
  // Calendar
  // -------------------------------------------------------------------------

  router.get("/calendar/upcoming", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await run(req, res, "calendar.listUpcomingEvents", {
      limit: num(req, "limit"),
      windowDays: num(req, "windowDays"),
      fromIso: str(req, "from"),
      calendarId: str(req, "calendarId"),
    });
  });

  router.get("/calendar/events/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await run(req, res, "calendar.getEvent", {
      eventId: req.params.id,
      calendarId: str(req, "calendarId"),
    });
  });

  return router;
}
