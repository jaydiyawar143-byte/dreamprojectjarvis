// ---------------------------------------------------------------------------
// Phase 15 — the Marketing page's API.
//
//   GET    /api/v1/marketing/status
//   GET    /api/v1/marketing/campaigns                  POST  .../campaigns
//   GET    /api/v1/marketing/campaigns/:id              PATCH .../campaigns/:id
//   GET    /api/v1/marketing/content                    POST  .../content
//   GET    /api/v1/marketing/content/:id                PATCH .../content/:id
//   POST   /api/v1/marketing/content/:id/mark-published
//   GET    /api/v1/marketing/content/:id/publish        (the publish check — a read)
//   POST   /api/v1/marketing/content/:id/publish        (request, or execute with an approval)
//   GET    /api/v1/marketing/research                   GET   .../research/:id
//   POST   /api/v1/marketing/research/seo-audit         POST  .../research/competitor
//   GET    /api/v1/marketing/reports                    POST  .../reports
//   GET    /api/v1/marketing/reports/:id                GET   .../reports/:id/export
//   GET    /api/v1/marketing/recommendations
//
// THIS ROUTER IMPLEMENTS NOTHING. Every handler below turns a request into one
// tool call and runs it through `ToolExecutor` — the same tools, with the same
// ids, that the marketing agent proposes in chat. So a button on the page and
// a sentence in a conversation pass one permission check, one approval gate
// and one audit row, and arrive at one `MarketingService`. A rule that should
// hold for both belongs in that service; a rule written here would hold for
// the page alone.
//
// What IS decided here is only what belongs to HTTP: who the caller is (the
// verified token, never the body, the query or the path), which status code a
// refusal maps to, and the shape of the envelope.
//
// The one read that does not go through a tool is `/status`: it reports which
// marketing tools this deployment registered, and which of them the caller's
// role could run, so the page can decline to draw a control that could not do
// anything. It decides nothing: a control it lets the page draw still goes
// through the executor, which asks the same question of the same table.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Response } from "express";
import {
  MARKETING_TOOL_IDS,
  renderReportHtml,
  renderReportMarkdown,
  reportFileName,
  type IToolExecutor,
  type ITokenService,
  type ITool,
  type MarketingChannel,
  type MarketingReportView,
  type Role,
  type ToolExecutionResult,
  type ToolPermission,
} from "@jarvis/core";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import type { MarketingPublishFlow, PublishFlowResult } from "../services/marketing/publish-flow.js";

export interface MarketingRouterDeps {
  tokenService: ITokenService;
  executor: Pick<IToolExecutor, "execute">;
  toolRegistry: { get(toolId: string): ITool | undefined };
  marketing: { researchAvailable(): boolean; publishableChannels(): MarketingChannel[] };
  publishFlow: MarketingPublishFlow;
  /** The same role table the executor checks against. Read here, never decided here. */
  permissions: { checkToolPermissions(role: Role, required: ToolPermission[]): boolean };
}

const T = MARKETING_TOOL_IDS;

/** How a refusal from the marketing service maps onto HTTP. */
const STATUS_FOR_CODE: Readonly<Record<string, number>> = Object.freeze({
  NOT_FOUND: 404,
  INVALID: 400,
  LIMIT: 409,
  CONFLICT: 409,
  OUT_OF_SCOPE: 403,
  UNAVAILABLE: 503,
  PROVIDER_FAILED: 502,
  RATE_LIMITED: 429,
});

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  // `code` and `message` are written last: nothing in `extra` can replace them.
  res.status(status).json({ success: false, error: { ...extra, code, message }, timestamp: new Date().toISOString() });
}

/** One string query value, or undefined. An array or an object is not a value. */
function q(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function createMarketingRouter(deps: MarketingRouterDeps): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.tokenService);

  const callerOf = (req: AuthenticatedRequest) => ({
    userId: req.auth!.userId,
    role: req.auth!.role as Role,
    traceId: typeof req.headers["x-trace-id"] === "string" ? req.headers["x-trace-id"] : randomUUID(),
    ...(typeof req.ip === "string" && req.ip.length > 0 ? { ipAddress: req.ip } : {}),
  });

  /**
   * Run one marketing tool as the caller.
   *
   * The executor decides whether the caller's role may run it, whether it
   * needs an approval, and writes the audit row. Nothing here second-guesses
   * any of that.
   */
  function run(req: AuthenticatedRequest, toolId: string, params: Record<string, unknown>): Promise<ToolExecutionResult> {
    return deps.executor.execute({ toolId, params, ...callerOf(req) });
  }

  /** Answer with a tool's result: its data, or its refusal with the right status. */
  function send(res: Response, result: ToolExecutionResult, successStatus = 200): void {
    if (result.status === "completed" && result.result?.success) {
      return ok(res, result.result.data ?? null, successStatus);
    }
    if (result.status === "permission_denied") {
      return fail(res, 403, "FORBIDDEN", "Your role is not allowed to do that.");
    }
    if (result.status === "timed_out") {
      return fail(res, 504, "TIMEOUT", "That took too long and was stopped.");
    }
    if (result.error === "Tool not found") {
      return fail(res, 503, "UNAVAILABLE", "That is not available on this server.");
    }
    if (result.error === "Invalid input parameters") {
      return fail(res, 400, "INVALID", "The request is missing something or is not in the expected form.");
    }
    if (result.status === "approval_pending" || result.status === "approval_required" || result.status === "approval_denied") {
      // No tool reached through `send` is approval-gated. If one ever is, it
      // is surfaced as a refusal, never run and never rendered as missing data.
      return fail(res, 409, "APPROVAL_REQUIRED", "That needs an approval this endpoint does not request.");
    }
    const code = typeof result.result?.metadata?.code === "string" ? result.result.metadata.code : "FAILED";
    // The service's messages are fixed sentences written to be shown.
    fail(res, STATUS_FOR_CODE[code] ?? 500, code, result.result?.error ?? result.error ?? "The request could not be completed.");
  }

  /** The project the screen is showing, when one is selected. */
  const projectOf = (req: AuthenticatedRequest): Record<string, string> => {
    const projectId = q(req.query.projectId) ?? (typeof (req.body as { projectId?: unknown })?.projectId === "string" ? ((req.body as { projectId: string }).projectId.trim() || undefined) : undefined);
    return projectId ? { projectId } : {};
  };

  const body = (req: AuthenticatedRequest): Record<string, unknown> =>
    req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

  /** Only the named keys of a body, so nothing else a client sends reaches a tool. */
  function only(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
    return out;
  }

  const handle = (handler: (req: AuthenticatedRequest, res: Response) => Promise<void> | void) =>
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      await handler(req, res);
    });

  const validId = (res: Response, id: unknown, what: string): id is string => {
    if (typeof id === "string" && ID.test(id)) return true;
    fail(res, 404, "NOT_FOUND", `That ${what} was not found.`);
    return false;
  };

  // -------------------------------------------------------------------------
  // What this deployment can do
  // -------------------------------------------------------------------------

  router.get(
    "/status",
    requireAuth,
    handle((req, res) => {
      const registered = (id: string) => deps.toolRegistry.get(id) !== undefined;
      // Registered here AND within the caller's role — the executor's own
      // two conditions, in the executor's own terms.
      const may = (id: string): boolean => {
        const tool = deps.toolRegistry.get(id);
        return tool !== undefined && deps.permissions.checkToolPermissions(req.auth!.role as Role, tool.requiredPermissions);
      };
      ok(res, {
        research: {
          available: deps.marketing.researchAvailable() && registered(T.seoAudit),
          // Said in the terms of what an operator would have to do.
          reason: deps.marketing.researchAvailable()
            ? null
            : "Reading web pages is switched off on this server. An administrator can switch it on by setting BROWSER_ENABLED=true and restarting.",
        },
        publishing: {
          available: registered(T.contentPublish),
          channels: registered(T.contentPublish) ? deps.marketing.publishableChannels() : [],
          reason: registered(T.contentPublish) ? null : "No publishing connection is configured on this server.",
        },
        adAccount: { available: registered("meta.insights") },
        // What THIS caller's role could run. A hint for the screen, not a grant.
        caller: {
          canEdit: may(T.contentUpdate),
          canResearch: may(T.seoAudit),
          canPublish: may(T.contentPublish),
        },
      });
    })
  );

  // -------------------------------------------------------------------------
  // Campaign workspaces
  // -------------------------------------------------------------------------

  const CAMPAIGN_FIELDS = ["name", "objective", "brief", "channels", "startDate", "endDate", "status", "metaCampaignIds"] as const;

  router.get(
    "/campaigns",
    requireAuth,
    handle(async (req, res) => {
      send(res, await run(req, T.campaignList, { includeArchived: req.query.includeArchived === "true", ...projectOf(req) }));
    })
  );

  router.post(
    "/campaigns",
    requireAuth,
    handle(async (req, res) => {
      send(res, await run(req, T.campaignCreate, { ...only(body(req), CAMPAIGN_FIELDS), ...projectOf(req) }), 201);
    })
  );

  router.get(
    "/campaigns/:id",
    requireAuth,
    handle(async (req, res) => {
      if (!validId(res, req.params.id, "campaign")) return;
      send(res, await run(req, T.campaignGet, { campaign: req.params.id, ...projectOf(req) }));
    })
  );

  router.patch(
    "/campaigns/:id",
    requireAuth,
    handle(async (req, res) => {
      if (!validId(res, req.params.id, "campaign")) return;
      send(res, await run(req, T.campaignUpdate, { campaign: req.params.id, ...only(body(req), CAMPAIGN_FIELDS), ...projectOf(req) }));
    })
  );

  // -------------------------------------------------------------------------
  // Content and the calendar
  // -------------------------------------------------------------------------

  const CONTENT_FIELDS = ["title", "channel", "format", "body", "link", "notes", "scheduledDate", "scheduledTime", "status"] as const;

  router.get(
    "/content",
    requireAuth,
    handle(async (req, res) => {
      const limit = Number(q(req.query.limit));
      send(
        res,
        await run(req, T.contentList, {
          ...(q(req.query.campaign) ? { campaign: q(req.query.campaign) } : {}),
          ...(q(req.query.from) ? { from: q(req.query.from) } : {}),
          ...(q(req.query.to) ? { to: q(req.query.to) } : {}),
          ...(q(req.query.status) ? { status: q(req.query.status) } : {}),
          ...(q(req.query.channel) ? { channel: q(req.query.channel) } : {}),
          ...(Number.isInteger(limit) ? { limit } : { limit: 100 }),
          ...projectOf(req),
        })
      );
    })
  );

  router.post(
    "/content",
    requireAuth,
    handle(async (req, res) => {
      const payload = body(req);
      send(
        res,
        await run(req, T.contentPlan, {
          ...(typeof payload.campaign === "string" && payload.campaign.trim() ? { campaign: payload.campaign.trim() } : {}),
          items: payload.items,
          ...projectOf(req),
        }),
        201
      );
    })
  );

  router.get(
    "/content/:id",
    requireAuth,
    handle(async (req, res) => {
      if (!validId(res, req.params.id, "content item")) return;
      send(res, await run(req, T.contentList, { contentId: req.params.id, ...projectOf(req) }));
    })
  );

  router.patch(
    "/content/:id",
    requireAuth,
    handle(async (req, res) => {
      if (!validId(res, req.params.id, "content item")) return;
      send(res, await run(req, T.contentUpdate, { contentId: req.params.id, ...only(body(req), CONTENT_FIELDS), ...projectOf(req) }));
    })
  );

  router.post(
    "/content/:id/mark-published",
    requireAuth,
    handle(async (req, res) => {
      if (!validId(res, req.params.id, "content item")) return;
      send(res, await run(req, T.contentMarkPublished, { contentId: req.params.id, ...only(body(req), ["url", "publishedOn"]), ...projectOf(req) }));
    })
  );

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /** The publish check: can it be published, where, and with exactly what. A read. */
  router.get(
    "/content/:id/publish",
    requireAuth,
    handle(async (req, res) => {
      if (!validId(res, req.params.id, "content item")) return;
      send(res, await run(req, T.publishPrepare, { contentId: req.params.id, ...(q(req.query.targetId) ? { targetId: q(req.query.targetId) } : {}), ...projectOf(req) }));
    })
  );

  const PUBLISH_HTTP: Readonly<Record<PublishFlowResult["status"], number>> = Object.freeze({
    PUBLISHED: 200,
    // Accepted, and waiting on a person. Nothing has been posted.
    APPROVAL_REQUIRED: 202,
    NOT_READY: 409,
    DECLINED: 409,
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    UNAVAILABLE: 503,
    FAILED: 502,
    // Sent, outcome not known. Not a success, and not safe to report as a
    // plain failure a client might retry.
    UNCONFIRMED: 502,
  });

  /**
   * Ask to publish, or — with the id of an approval the user has decided —
   * publish.
   *
   * The body carries no text and no target name: what is posted comes from the
   * saved item, and where from the provider's own list, both read on the
   * server. A client can choose WHICH target by its id and nothing more.
   */
  router.post(
    "/content/:id/publish",
    requireAuth,
    handle(async (req, res) => {
      if (!validId(res, req.params.id, "content item")) return;
      const payload = body(req);
      const caller = { ...callerOf(req), ...projectOf(req) };

      let result: PublishFlowResult;
      if (payload.approvalId !== undefined) {
        if (typeof payload.approvalId !== "string" || !ID.test(payload.approvalId)) {
          return fail(res, 404, "NOT_FOUND", "That approval was not found for this item.");
        }
        result = await deps.publishFlow.execute(caller, req.params.id, payload.approvalId);
      } else {
        const targetId = typeof payload.targetId === "string" && ID.test(payload.targetId) ? payload.targetId : undefined;
        result = await deps.publishFlow.request(caller, req.params.id, targetId);
      }

      const status = PUBLISH_HTTP[result.status];
      if (result.status === "PUBLISHED" || result.status === "APPROVAL_REQUIRED") {
        // `published` is true in exactly one case, and it is spelled out so a
        // client never has to infer it from a status code.
        return ok(res, { ...result, published: result.status === "PUBLISHED" }, status);
      }
      const { status: code, message, ...rest } = result;
      // Written after the result's own fields: a refusal is never `published`.
      fail(res, status, code, message, { ...rest, published: false });
    })
  );

  // -------------------------------------------------------------------------
  // Research
  // -------------------------------------------------------------------------

  router.get(
    "/research",
    requireAuth,
    handle(async (req, res) => {
      send(
        res,
        await run(req, T.researchList, {
          ...(q(req.query.campaign) ? { campaign: q(req.query.campaign) } : {}),
          ...(q(req.query.kind) ? { kind: q(req.query.kind) } : {}),
          ...projectOf(req),
        })
      );
    })
  );

  router.get(
    "/research/:id",
    requireAuth,
    handle(async (req, res) => {
      if (!validId(res, req.params.id, "research result")) return;
      send(res, await run(req, T.researchList, { researchId: req.params.id, ...projectOf(req) }));
    })
  );

  router.post(
    "/research/seo-audit",
    requireAuth,
    handle(async (req, res) => {
      send(res, await run(req, T.seoAudit, { ...only(body(req), ["url", "campaign"]), ...projectOf(req) }), 201);
    })
  );

  router.post(
    "/research/competitor",
    requireAuth,
    handle(async (req, res) => {
      send(res, await run(req, T.competitorAnalyze, { ...only(body(req), ["competitorUrl", "ownUrl", "campaign"]), ...projectOf(req) }), 201);
    })
  );

  // -------------------------------------------------------------------------
  // Reports and recommendations
  // -------------------------------------------------------------------------

  router.get(
    "/reports",
    requireAuth,
    handle(async (req, res) => {
      send(res, await run(req, T.reportList, { ...(q(req.query.campaign) ? { campaign: q(req.query.campaign) } : {}), ...projectOf(req) }));
    })
  );

  router.post(
    "/reports",
    requireAuth,
    handle(async (req, res) => {
      send(res, await run(req, T.reportGenerate, { ...only(body(req), ["kind", "campaign", "from", "to", "title", "compare"]), ...projectOf(req) }), 201);
    })
  );

  router.get(
    "/reports/:id",
    requireAuth,
    handle(async (req, res) => {
      if (!validId(res, req.params.id, "report")) return;
      send(res, await run(req, T.reportGet, { reportId: req.params.id, ...projectOf(req) }));
    })
  );

  /**
   * A saved report as a file: a self-contained HTML document, or Markdown.
   *
   * Rendered by the same pure functions from the same saved document, so the
   * file says what the screen says. It is sent as a download, never rendered
   * in this origin, and the HTML loads and runs nothing.
   */
  router.get(
    "/reports/:id/export",
    requireAuth,
    handle(async (req, res) => {
      if (!validId(res, req.params.id, "report")) return;
      const format = q(req.query.format) ?? "html";
      if (format !== "html" && format !== "md") {
        return fail(res, 400, "INVALID", "format must be html or md.");
      }
      const result = await run(req, T.reportGet, { reportId: req.params.id, ...projectOf(req) });
      if (result.status !== "completed" || !result.result?.success) return send(res, result);

      const report = (result.result.data as { report: MarketingReportView }).report;
      const text = format === "html" ? renderReportHtml(report.document) : renderReportMarkdown(report.document);
      res
        .status(200)
        .setHeader("Content-Type", format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8")
        .setHeader("Content-Disposition", `attachment; filename="${reportFileName(report.document, format)}"`)
        .setHeader("X-Content-Type-Options", "nosniff")
        .setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .setHeader("Cache-Control", "private, no-store")
        .send(text);
    })
  );

  router.get(
    "/recommendations",
    requireAuth,
    handle(async (req, res) => {
      send(res, await run(req, T.recommendations, { ...(q(req.query.campaign) ? { campaign: q(req.query.campaign) } : {}), ...projectOf(req) }));
    })
  );

  return router;
}
