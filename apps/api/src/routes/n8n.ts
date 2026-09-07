// ---------------------------------------------------------------------------
// Sprint 5.4 — n8n integration API
//
//   POST /api/v1/n8n/callback      workflow result callback (public, signed)
//   GET  /api/v1/n8n/workflows     registered workflows (bearer token)
//   GET  /api/v1/n8n/executions    execution audit trail (bearer token)
//   GET  /api/v1/n8n/executions/:id  one execution (bearer token)
//
// Security model — the callback route is deliberately UNAUTHENTICATED in the
// session sense, because n8n calls it, not a logged-in user. Its protections:
//
//  - Authenticity: X-Jarvis-Signature, an HMAC over the RAW body keyed with
//    N8N_CALLBACK_SECRET. The router installs its own express.raw() so the
//    app-wide JSON parser cannot destroy the exact bytes.
//  - The callback secret is a DIFFERENT secret from N8N_API_KEY. The API key
//    travels outbound to n8n and may be visible to workflow authors, so it must
//    never be accepted as an inbound credential.
//  - Ownership: the execution id in the payload resolves to a row that already
//    carries a userId, so a callback can only ever complete an execution JARVIS
//    itself started. It cannot create rows or name a tenant.
//  - Replay: a freshness window plus the unique callback_event_id constraint.
//
// The callback answers 200 for anything it has authenticated and understood,
// including duplicates and unknown execution ids, so a retrying workflow is not
// driven into an endless redelivery loop. Only signature failure returns 401.
//
// There is no endpoint here that CREATES or EDITS a workflow: registering one
// is an operator action, and building an editor was explicitly out of scope.
// ---------------------------------------------------------------------------

import { Router, raw } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import type { Container } from "../services/container.js";
import type { IN8nRepository, AuditLogger } from "@jarvis/core";
import {
  verifyCallbackSignature,
  parseCallbackPayload,
  isCallbackFresh,
  type N8nConfig,
} from "@jarvis/n8n";

export interface N8nRouterDeps {
  repo: IN8nRepository;
  config: N8nConfig;
  /** Optional: callbacks are recorded to the shared audit log when present. */
  auditLogger?: Pick<AuditLogger, "log">;
  now?: () => Date;
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

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

/** Curated projection. Never exposes the payload hash's source or internals. */
function serializeExecution(e: {
  id: string;
  workflowId: string;
  status: string;
  remoteExecutionId: string | null;
  resultSummary: string | null;
  errorCode: string | null;
  traceId: string;
  triggeredAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: e.id,
    workflowId: e.workflowId,
    status: e.status,
    remoteExecutionId: e.remoteExecutionId,
    resultSummary: e.resultSummary,
    errorCode: e.errorCode,
    traceId: e.traceId,
    triggeredAt: e.triggeredAt.toISOString(),
    completedAt: e.completedAt ? e.completedAt.toISOString() : null,
  };
}

export function createN8nRouter(container: Container, deps: N8nRouterDeps): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const now = deps.now ?? (() => new Date());

  // Raw parser scoped to the callback path only, so body parsing for every
  // other route in the application is unchanged.
  const rawJson = raw({ type: "application/json", limit: "1mb" });

  // -------------------------------------------------------------------------
  // POST /callback
  // -------------------------------------------------------------------------
  router.post("/callback", rawJson, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const rawBody: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;

    const signature = verifyCallbackSignature(
      rawBody,
      req.headers["x-jarvis-signature"] as string | undefined,
      deps.config.callbackSecret
    );
    if (!signature.valid) {
      // The reason is logged, never returned: the response must not become an
      // oracle for how to forge a valid callback.
      logEvent("n8n_callback_signature_rejected", { reason: signature.reason });
      return fail(res, 401, "AUTHENTICATION_REQUIRED", "Invalid signature");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody!.toString("utf8"));
    } catch {
      logEvent("n8n_callback_unparseable");
      return fail(res, 400, "INVALID_REQUEST", "Malformed callback body");
    }

    const parsed = parseCallbackPayload(payload, now());
    if (!parsed.ok) {
      logEvent("n8n_callback_invalid", { reason: parsed.reason });
      return fail(res, 400, "INVALID_REQUEST", "Callback payload is missing required fields");
    }
    const event = parsed.event;

    // Replay guard 1 — freshness. A signature proves authenticity, not recency.
    if (!isCallbackFresh(event.timestamp, deps.config.callbackMaxAgeMs, now())) {
      logEvent("n8n_callback_stale", { eventId: event.eventId, executionId: event.executionId });
      return ok(res, { applied: false, reason: "stale" });
    }

    // Replay guard 2 — the unique callback_event_id, claimed atomically.
    const result = await deps.repo.applyCallback(event);

    if (result.notFound) {
      // Signed but names an execution we never started. 200 stops a retry loop
      // that could never succeed; the event is logged for investigation.
      logEvent("n8n_callback_unknown_execution", { executionId: event.executionId });
      return ok(res, { applied: false, reason: "unknown_execution" });
    }
    if (result.duplicate) {
      logEvent("n8n_callback_duplicate", { eventId: event.eventId });
      return ok(res, { applied: false, reason: "duplicate" });
    }

    // Audit trail. Attribution comes from the execution row the repository
    // resolved, NOT from the callback payload — an inbound event must never be
    // able to name the tenant an audit entry is filed against.
    if (deps.auditLogger) {
      await deps.auditLogger
        .log({
          userId: result.userId ?? "unknown",
          action: "n8n.callback",
          toolId: "n8n.trigger",
          result: event.status === "success" ? "success" : "failure",
          traceId: result.traceId,
          metadata: {
            executionId: event.executionId,
            eventId: event.eventId,
            remoteExecutionId: event.remoteExecutionId,
          },
        } as never)
        .catch(() => {
          // Audit failure must not turn a delivered result into a retry.
        });
    }

    logEvent("n8n_callback_applied", {
      eventId: event.eventId,
      executionId: event.executionId,
      status: event.status,
    });
    ok(res, { applied: true, status: event.status });
  }));

  // -------------------------------------------------------------------------
  // GET /workflows
  // -------------------------------------------------------------------------
  router.get("/workflows", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const workflows = await deps.repo.listWorkflowsForUser(req.auth.userId);
    ok(res, {
      // webhookPath is deliberately omitted: it is the address of a live
      // automation endpoint and the client never needs it.
      workflows: workflows.map((w) => ({
        id: w.id,
        name: w.name,
        isActive: w.isActive,
        createdAt: w.createdAt.toISOString(),
      })),
      count: workflows.length,
    });
  }));

  // -------------------------------------------------------------------------
  // GET /executions
  // -------------------------------------------------------------------------
  router.get("/executions", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const workflowId = typeof req.query.workflowId === "string" ? req.query.workflowId : undefined;
    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) ? limitParam : undefined;

    // Scope comes from the verified token, never from the query string.
    const executions = await deps.repo.listExecutionsForUser(req.auth.userId, {
      workflowId,
      limit,
    });
    ok(res, { executions: executions.map(serializeExecution), count: executions.length });
  }));

  // -------------------------------------------------------------------------
  // GET /executions/:id
  // -------------------------------------------------------------------------
  router.get("/executions/:id", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const execution = await deps.repo.findExecutionForUser(req.auth.userId, req.params.id);
    // Another tenant's execution reads as NOT_FOUND rather than FORBIDDEN, so
    // the endpoint does not confirm that the id exists.
    if (!execution) return fail(res, 404, "NOT_FOUND", "Execution not found");

    ok(res, serializeExecution(execution));
  }));

  return router;
}
