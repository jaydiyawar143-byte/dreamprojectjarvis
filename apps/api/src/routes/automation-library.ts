// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — the Automation Library's API.
//
//   GET  /api/v1/n8n/library/workflows   the catalog, paginated and filtered
//   GET  /api/v1/n8n/library/status      sync state: running, partial, complete
//                                        or failed, the open scan's progress,
//                                        the last complete scan, recent runs
//   POST /api/v1/n8n/library/sync        start (or resume) one bounded run —
//                                        or, with continueUntilComplete, a
//                                        chain of them (Stage 18.2); 202, then
//                                        follow it on /status
//
// THIS ROUTER IMPLEMENTS NOTHING. Each handler turns a request into one call on
// `AutomationLibraryService` and its answer into HTTP. Who may do what, the
// budgets, the single-run lease, what is stored and what is said are all the
// service's — and the JARVIS tools (`automation.library.*`) reach the same
// instance, so a sentence and a button meet the same rules. The request rules
// themselves (the query's bounds, the server-only fields, the sync options)
// are core's, shared with the tools, so an equivalent request is refused in
// the same words on both.
//
// WHAT IS DECIDED HERE, AND ONLY THIS:
//   • Identity is the verified access token (`requireAuth`); nothing in the
//     request names a user, an Organization, an instance, a provider, a URL or
//     a cursor. A query or body field that tries is refused outright (400
//     REQUEST_SCOPE_REFUSED), never obeyed; headers are not read for scope.
//   • Every attempt — served or refused — takes a place in a per-account,
//     per-route window held in memory BEFORE the database is read
//     (`LIBRARY_ATTEMPT_LIMITS`), so a flood of requests costs nothing past it.
//     The budgets that guard n8n itself are the service's, in PostgreSQL.
//   • Query values are validated and bounded.
//
// STAGE 18.3B:
//   GET  /workflows/:entryId/inspection           one entry's sanitized
//                                                 structure, from the catalog
//   POST /workflows/:entryId/allowlist-proposals  propose it for the caller's
//                                                 trigger allow-list (an approval)
//   POST /workflows/:entryId/allowlist-proposals/:approvalId/apply
//                                                 add it, once ANOTHER owner or
//                                                 admin approved — on screen only
//
// NOTHING HERE ACTS ON A WORKFLOW. There is no endpoint that activates, edits
// or runs one: a catalog entry is an observation, and triggering stays the
// approval-gated `n8n.trigger`.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Response } from "express";
import {
  LIBRARY_INVALID_QUERY_MESSAGE,
  LIBRARY_INVALID_SYNC_MESSAGE,
  LIBRARY_LIST_LIMIT_MAX,
  LIBRARY_SCOPE_REFUSED_MESSAGE,
  namesLibraryServerScope,
  validateLibraryEntryQuery,
  validateLibrarySyncOptions,
  type LibraryEntryQuery,
  type LibraryResult,
} from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import type { Container } from "../services/container.js";
import { IpRateLimiter, type IpRateLimitRule } from "../services/ip-rate-limiter.js";
import type { AutomationLibraryService } from "../services/automation-library/library-service.js";
import type { LibraryAllowlistFlow } from "../services/automation-library/allowlist-flow.js";

const APPROVAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Attempts per account, per route, per minute — counted before the database. */
export const LIBRARY_ATTEMPT_LIMITS = {
  read: { limit: 120, windowMs: 60_000 },
  sync: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<"read" | "sync", IpRateLimitRule>;

/** The largest page of the catalog one request may ask for. */
export const LIBRARY_MAX_LIST_LIMIT = LIBRARY_LIST_LIMIT_MAX;

function carriesServerOnlyField(req: AuthenticatedRequest): boolean {
  return [req.query, req.body].some(namesLibraryServerScope);
}

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message }, timestamp: new Date().toISOString() });
}

function send<T>(res: Response, result: LibraryResult<T>, project: (value: T) => unknown, status = 200): void {
  if (result.ok) ok(res, project(result.value), status);
  else fail(res, result.status, result.code, result.message);
}

/** One query value as a string, or undefined; an array or an object is not a value. */
function single(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

/**
 * The catalog query, validated — or null when any part of it is not
 * acceptable. A URL's values are strings; an array or an object is not a
 * value. The bounds are core's, the same the search tool is held to.
 */
export function parseLibraryQuery(query: Record<string, unknown>): LibraryEntryQuery | null {
  const fields = ["page", "limit", "search", "active", "presence"] as const;
  const values: Partial<Record<(typeof fields)[number], string>> = {};
  for (const field of fields) {
    const value = single(query[field]);
    if (value === null) return null;
    if (value !== undefined) values[field] = value;
  }
  return validateLibraryEntryQuery(values);
}

export interface AutomationLibraryRouterDeps {
  /** Defaults to the container's. */
  library?: AutomationLibraryService;
  now?: () => Date;
}

export function createAutomationLibraryRouter(
  container: Pick<Container, "tokenService" | "automationLibrary"> & { automationLibraryAllowlist?: LibraryAllowlistFlow },
  deps: AutomationLibraryRouterDeps = {}
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const library = deps.library ?? container.automationLibrary;
  const now = deps.now ?? (() => new Date());
  const attempts = new IpRateLimiter(() => now().getTime());

  /** Identity, the attempt window and the scope check — or the answer that ends the request. */
  const admit = (req: AuthenticatedRequest, res: Response, bucket: "read" | "sync"): string | null => {
    const userId = req.auth?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      return null;
    }
    const attempt = attempts.check(`automation_library:${bucket}:${userId}`, LIBRARY_ATTEMPT_LIMITS[bucket]);
    if (!attempt.allowed) {
      res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
      fail(res, 429, "RATE_LIMITED", "Too many workflow library requests; retry later");
      return null;
    }
    if (carriesServerOnlyField(req)) {
      fail(res, 400, "REQUEST_SCOPE_REFUSED", LIBRARY_SCOPE_REFUSED_MESSAGE);
      return null;
    }
    return userId;
  };

  router.get(
    "/workflows",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "read");
      if (!userId) return;
      const query = parseLibraryQuery(req.query as Record<string, unknown>);
      if (!query) {
        fail(res, 400, "INVALID_QUERY", LIBRARY_INVALID_QUERY_MESSAGE);
        return;
      }
      send(res, await library.list(userId, query), (page) => page);
    })
  );

  router.get(
    "/status",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "read");
      if (!userId) return;
      send(res, await library.status(userId), (status) => status);
    })
  );

  router.post(
    "/sync",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "sync");
      if (!userId) return;
      const body = req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
      // A JSON body carries real booleans; "true" in a body is not one.
      if ([body.restart, body.continueUntilComplete].some((value) => value !== undefined && typeof value !== "boolean")) {
        fail(res, 400, "INVALID_REQUEST", LIBRARY_INVALID_SYNC_MESSAGE);
        return;
      }
      const options = validateLibrarySyncOptions(body);
      if (!options) {
        fail(res, 400, "INVALID_REQUEST", LIBRARY_INVALID_SYNC_MESSAGE);
        return;
      }
      // The work continues after this answer; its end is audited and logged by the service.
      const result = await library.startSync(userId, { ...options, via: "api" });
      // Running: accepted, follow it on /status. An idempotent replay of a
      // chain that already ended: here is how it ended.
      send(res, result, (started) => started, result.ok && result.value.state !== "running" ? 200 : 202);
    })
  );

  // ---------------------------------------------------------------------------
  // Stage 18.3B
  // ---------------------------------------------------------------------------

  router.get(
    "/workflows/:entryId/inspection",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "read");
      if (!userId) return;
      send(res, await library.inspect(userId, String(req.params.entryId)), (view) => view);
    })
  );

  router.post(
    "/workflows/:entryId/allowlist-proposals",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "sync");
      if (!userId) return;
      const result = await library.proposeAllowlist(userId, String(req.params.entryId), { via: "api" });
      send(res, result, (proposal) => proposal, result.ok && !result.value.existing ? 201 : 200);
    })
  );

  router.post(
    "/workflows/:entryId/allowlist-proposals/:approvalId/apply",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = admit(req, res, "sync");
      if (!userId) return;
      const flow = container.automationLibraryAllowlist;
      if (!flow) {
        fail(res, 503, "PROPOSALS_UNAVAILABLE", "Adding to the trigger allow-list is not available on this server.");
        return;
      }
      const approvalId = String(req.params.approvalId);
      if (!APPROVAL_ID.test(approvalId)) {
        fail(res, 400, "INVALID_REQUEST", "That is not a proposal id.");
        return;
      }
      const body = req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
      const inputMode = body.inputMode;
      if (inputMode !== undefined && inputMode !== "text" && inputMode !== "voice") {
        fail(res, 400, "INVALID_REQUEST", "inputMode must be text or voice.");
        return;
      }
      const role = req.auth?.role;
      const result = await flow.apply(
        {
          userId,
          role: role === "owner" || role === "admin" || role === "member" || role === "viewer" ? role : "viewer",
          traceId: randomUUID(),
          ...(req.ip ? { ipAddress: req.ip } : {}),
          ...(inputMode ? { inputMode } : {}),
        },
        String(req.params.entryId),
        approvalId
      );
      send(res, result, (applied) => applied);
    })
  );

  return router;
}
