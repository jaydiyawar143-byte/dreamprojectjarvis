// ---------------------------------------------------------------------------
// Sprint 4.3 — Dashboard data API.
//
//   GET /api/v1/dashboard/summary          cross-domain counts
//   GET /api/v1/dashboard/status           capability status (no secrets)
//   GET /api/v1/dashboard/meta/overview    KPI totals for a date range
//   GET /api/v1/dashboard/meta/timeseries  daily series, for charts
//   GET /api/v1/dashboard/meta/campaigns   per-campaign rows, for comparison
//
// This router owns NO business logic. Every figure it returns is produced by
// something that already existed:
//
//   counts .............. the Sprint 1–3 repositories, unchanged
//   Meta metrics ........ the Phase 8 read-only tools, through the existing
//                         ToolExecutor, which applies the existing
//                         MetaAccountAuthorizer
//
// Why it exists at all, rather than the dashboard calling what was already
// there: an overview needs five domains at once, and none of the existing
// endpoints returns a count without also returning its full payload. Meta has
// no HTTP surface whatsoever — before this, insights were reachable only by
// sending natural language to POST /api/v1/chat.
//
// Security
//  - Every route requires a bearer token and is scoped to req.auth.userId.
//  - The Meta account id comes from server configuration, NEVER from the
//    client — the same rule the opportunities router already follows.
//  - Only tool ids in READ_ONLY_TOOLS may be executed here, checked at call
//    time. No write tool is reachable through this router, so no approval
//    boundary can be crossed by rendering a dashboard.
//  - Responses carry curated fields only: no tokens, no raw provider payloads,
//    no JarvisError details.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import { PrismaRecommendationRepository, prisma } from "@jarvis/db";
import type { Role, ToolExecutionResult } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Tool allow-list
// ---------------------------------------------------------------------------

/**
 * The only tools this router may run.
 *
 * Every one is registered with mutationType READ_ONLY and requiresApproval
 * false. Keeping the list here — rather than trusting the caller or the
 * registry — means a future write tool cannot become reachable from the
 * dashboard by accident.
 */
const READ_ONLY_TOOLS = new Set(["meta.insights", "meta.campaigns", "meta.accounts"]);

// ---------------------------------------------------------------------------
// Response helpers — matching the existing routers' envelope
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    success: false,
    error: { code, message },
    timestamp: now(),
  });
}

function ok(res: Response, data: Record<string, unknown>): void {
  res.status(200).json({ success: true, data, timestamp: now() });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Meta's own insights window ceiling; also bounds the work a request can ask for. */
const MAX_RANGE_DAYS = 366;

interface DateRange {
  start: string;
  end: string;
}

type Validated<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/**
 * Resolves the requested window.
 *
 * Defaults to the last 30 days ending yesterday: today is still accruing, and
 * a partial final day reads on a chart as a collapse in performance.
 */
function parseDateRange(q: Record<string, unknown>): Validated<DateRange> {
  const startRaw = typeof q.startDate === "string" ? q.startDate : undefined;
  const endRaw = typeof q.endDate === "string" ? q.endDate : undefined;

  if (startRaw === undefined && endRaw === undefined) {
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 29);
    return {
      ok: true,
      value: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    };
  }

  if (!startRaw || !endRaw) {
    return { ok: false, code: "INVALID_REQUEST", message: "startDate and endDate must be supplied together" };
  }
  if (!DATE_RE.test(startRaw) || !DATE_RE.test(endRaw)) {
    return { ok: false, code: "INVALID_REQUEST", message: "Dates must be formatted YYYY-MM-DD" };
  }

  const start = new Date(`${startRaw}T00:00:00Z`);
  const end = new Date(`${endRaw}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, code: "INVALID_REQUEST", message: "Dates must be real calendar dates" };
  }
  if (start > end) {
    return { ok: false, code: "INVALID_REQUEST", message: "startDate must not be after endDate" };
  }
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    return { ok: false, code: "INVALID_REQUEST", message: `Date range must not exceed ${MAX_RANGE_DAYS} days` };
  }

  return { ok: true, value: { start: startRaw, end: endRaw } };
}

function parseLimit(raw: unknown, fallback: number, max: number): Validated<number> {
  if (raw === undefined) return { ok: true, value: fallback };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    return { ok: false, code: "INVALID_REQUEST", message: `limit must be an integer between 1 and ${max}` };
  }
  return { ok: true, value: n };
}

// ---------------------------------------------------------------------------
// Metric normalisation
// ---------------------------------------------------------------------------

/**
 * Meta returns every metric as a string, and omits any it has no data for.
 * Absent stays absent: a missing metric becomes null, never 0, because a zero
 * on a chart is a measurement and a null is a gap.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

interface MetricRow {
  date: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  reach: number | null;
  conversions: number | null;
  revenue: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  roas: number | null;
}

/**
 * Maps one insights row onto the dashboard's metric shape.
 *
 * Only fields the UI plots are kept. The raw provider payload — which can carry
 * account identifiers and nested action breakdowns — is deliberately dropped.
 */
function toMetricRow(raw: Record<string, unknown>): MetricRow {
  const spend = num(raw.spend);
  const conversions = num(raw.conversions ?? raw.actions_count);
  const revenue = num(raw.revenue ?? raw.purchase_value);

  return {
    date: typeof raw.date_start === "string" ? raw.date_start : null,
    spend,
    impressions: num(raw.impressions),
    clicks: num(raw.clicks),
    reach: num(raw.reach),
    conversions,
    revenue,
    ctr: num(raw.ctr),
    cpc: num(raw.cpc),
    cpm: num(raw.cpm),
    // Derived only when both sides are present and the divisor is non-zero,
    // so a division never invents a figure Meta did not support.
    cpa: num(raw.cpa) ?? (spend !== null && conversions !== null && conversions > 0 ? spend / conversions : null),
    roas: num(raw.roas) ?? (revenue !== null && spend !== null && spend > 0 ? revenue / spend : null),
  };
}

/** Sums a series into one KPI row. Rates are recomputed, never averaged. */
function totalsOf(rows: MetricRow[]): Omit<MetricRow, "date"> {
  const sum = (key: keyof MetricRow): number | null => {
    const present = rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
    return present.length ? present.reduce((a, b) => a + b, 0) : null;
  };

  const spend = sum("spend");
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const conversions = sum("conversions");
  const revenue = sum("revenue");

  const ratio = (a: number | null, b: number | null): number | null =>
    a !== null && b !== null && b > 0 ? a / b : null;

  return {
    spend,
    impressions,
    clicks,
    reach: sum("reach"),
    conversions,
    revenue,
    // Averaging per-day rates would weight a £5 day the same as a £5,000 one.
    ctr: ratio(clicks, impressions) === null ? null : (clicks! / impressions!) * 100,
    cpc: ratio(spend, clicks),
    cpm: ratio(spend, impressions) === null ? null : (spend! / impressions!) * 1000,
    cpa: ratio(spend, conversions),
    roas: ratio(revenue, spend),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Injection seam, matching the knowledge router's. Production passes nothing;
 * tests supply doubles so the router can be exercised without Postgres, a Meta
 * token, or the network.
 */
export interface DashboardRouterOverrides {
  recommendationRepo?: Pick<PrismaRecommendationRepository, "listForOpportunityQueue">;
}

export function createDashboardRouter(
  container: Container,
  overrides: DashboardRouterOverrides = {}
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const recommendationRepo =
    overrides.recommendationRepo ?? new PrismaRecommendationRepository(prisma);

  /** The server's configured ad account. Never read from the request. */
  const configuredAccountId = (): string | undefined => process.env.META_AD_ACCOUNT_ID;

  /**
   * Runs one allow-listed read-only tool on the caller's behalf.
   *
   * Goes through the existing ToolExecutor rather than touching the provider,
   * so audit logging, timeouts, cancellation and the account authorizer all
   * apply exactly as they do for the agent.
   */
  async function runReadTool(
    toolId: string,
    params: Record<string, unknown>,
    auth: { userId: string; role: Role }
  ): Promise<ToolExecutionResult> {
    if (!READ_ONLY_TOOLS.has(toolId)) {
      // Unreachable from any route below; the guard exists so it stays that way.
      throw new Error(`Refusing to execute non-read tool from the dashboard: ${toolId}`);
    }
    return container.executor.execute({
      toolId,
      params,
      userId: auth.userId,
      role: auth.role,
      traceId: randomUUID(),
      timeoutMs: 20_000,
    });
  }

  /** HTTP status for a tool-layer failure code. */
  function statusForToolFailure(code: string): number {
    if (code === "FORBIDDEN") return 403;
    if (code === "APPROVAL_REQUIRED") return 403;
    return 502;
  }

  /** Rows from a tool result, or a typed failure for the caller to surface. */
  function rowsFrom(result: ToolExecutionResult): Validated<Record<string, unknown>[]> {
    // A denial is not an outage, and must not be reported as one. Read-only
    // tools should never reach an approval state at all; if one somehow does,
    // it is surfaced rather than silently rendered as missing data.
    if (result.status === "permission_denied") {
      return { ok: false, code: "FORBIDDEN", message: "Not authorized to access this ad account" };
    }
    if (
      result.status === "approval_required" ||
      result.status === "approval_pending" ||
      result.status === "approval_denied"
    ) {
      return {
        ok: false,
        code: "APPROVAL_REQUIRED",
        message: "This data requires an approval the dashboard will not request",
      };
    }

    // "completed" is the executor's success state; every other state, and any
    // tool that completed while reporting failure, is an upstream problem.
    if (result.status !== "completed" || !result.result?.success) {
      return {
        ok: false,
        code: "UPSTREAM_UNAVAILABLE",
        // The tool's own message is safe: tools sanitise before returning.
        message: result.result?.error ?? result.error ?? "Meta data is unavailable",
      };
    }
    const data = (result.result.data ?? {}) as Record<string, unknown>;
    const list =
      (Array.isArray(data.insights) && data.insights) ||
      (Array.isArray(data.campaigns) && data.campaigns) ||
      (Array.isArray(data.accounts) && data.accounts) ||
      (Array.isArray(data.data) && data.data) ||
      [];
    return { ok: true, value: list as Record<string, unknown>[] };
  }

  // -------------------------------------------------------------------------
  // GET /summary — one call for the overview's counts
  // -------------------------------------------------------------------------
  router.get("/summary", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    const { userId } = req.auth;

    try {
      const accountId = configuredAccountId();

      // Independent reads, issued together. Each is individually owner-scoped
      // by the repository it comes from.
      const [approvals, conversations, documents, opportunities] = await Promise.all([
        container.approvalRepo.listByUser(userId, { status: "pending", page: 1, limit: 1 }),
        container.conversationRepo.listByUserId(userId),
        container.knowledgeRepo
          ? container.knowledgeRepo.listDocuments(userId)
          : Promise.resolve([]),
        accountId
          ? recommendationRepo.listForOpportunityQueue(userId, accountId, { limit: 1 })
          : Promise.resolve({ items: [], total: 0 }),
      ]);

      const docs = documents as Array<{ status: string }>;

      ok(res, {
        pendingApprovals: approvals.total,
        conversations: Array.isArray(conversations) ? conversations.length : 0,
        knowledgeDocuments: docs.length,
        knowledgeProcessed: docs.filter((d) => d.status === "PROCESSED").length,
        openOpportunities: opportunities.total,
        // Absent rather than zero when Meta is not configured: the dashboard
        // shows "not configured", which is true, instead of "none", which is not.
        metaConfigured: Boolean(accountId),
      });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Failed to build dashboard summary");
    }
  });

  // -------------------------------------------------------------------------
  // GET /status — which capabilities this deployment actually has
  // -------------------------------------------------------------------------
  router.get("/status", requireAuth, (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    // Booleans only. Whether a key is present is useful; the key is not.
    ok(res, {
      service: "jarvis-api",
      uptimeSeconds: Math.round(process.uptime()),
      capabilities: {
        knowledgeBase: Boolean(container.knowledgeRepo),
        retrieval: container.knowledgeRetriever !== null,
        memory: container.memoryStore !== null,
        embeddings: container.embeddingProvider !== null,
        metaAds: Boolean(configuredAccountId()),
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /meta/account — account context (Sprint 4.6)
  //
  // The only Meta fact the dashboard needed that nothing else exposed: which
  // account these numbers describe, in what currency, in what timezone.
  //
  // meta.accounts filters to the caller's authorized accounts before returning,
  // so a user who is not authorized for the configured account gets an empty
  // list here — reported as "not authorized", never as the account's details.
  // -------------------------------------------------------------------------
  router.get("/meta/account", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const accountId = configuredAccountId();
    if (!accountId) {
      return fail(res, 503, "ACCOUNT_NOT_CONFIGURED", "Ad account not configured on this server");
    }

    try {
      const result = await runReadTool("meta.accounts", { limit: 50 }, req.auth);
      const rows = rowsFrom(result);
      if (!rows.ok) return fail(res, statusForToolFailure(rows.code), rows.code, rows.message);

      const match = rows.value.find(
        (a) => typeof a.accountId === "string" && a.accountId === accountId
      );

      if (!match) {
        return fail(
          res,
          403,
          "ACCOUNT_NOT_AUTHORIZED",
          "You are not authorized to view this ad account"
        );
      }

      // Curated: name, money and time. Never the token, never the raw payload.
      ok(res, {
        account: {
          accountId,
          name: typeof match.name === "string" ? match.name : null,
          currency: typeof match.currency === "string" ? match.currency : null,
          timezone:
            typeof match.timezoneName === "string"
              ? match.timezoneName
              : typeof match.timezone_name === "string"
                ? match.timezone_name
                : null,
          status:
            typeof match.accountStatus === "string" || typeof match.accountStatus === "number"
              ? String(match.accountStatus)
              : null,
        },
      });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Failed to load account context");
    }
  });

  // -------------------------------------------------------------------------
  // GET /meta/overview — KPI totals
  // -------------------------------------------------------------------------
  router.get("/meta/overview", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const accountId = configuredAccountId();
    if (!accountId) {
      return fail(res, 503, "ACCOUNT_NOT_CONFIGURED", "Ad account not configured on this server");
    }

    const range = parseDateRange(req.query as Record<string, unknown>);
    if (!range.ok) return fail(res, 400, range.code, range.message);

    try {
      const result = await runReadTool(
        "meta.insights",
        { accountId, startDate: range.value.start, endDate: range.value.end, level: "account" },
        req.auth
      );
      const rows = rowsFrom(result);
      if (!rows.ok) return fail(res, statusForToolFailure(rows.code), rows.code, rows.message);

      const metrics = rows.value.map(toMetricRow);
      ok(res, {
        accountId,
        dateRange: range.value,
        totals: totalsOf(metrics),
        rowCount: metrics.length,
      });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Failed to load Meta overview");
    }
  });

  // -------------------------------------------------------------------------
  // GET /meta/timeseries — daily rows for charting
  // -------------------------------------------------------------------------
  router.get("/meta/timeseries", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const accountId = configuredAccountId();
    if (!accountId) {
      return fail(res, 503, "ACCOUNT_NOT_CONFIGURED", "Ad account not configured on this server");
    }

    const range = parseDateRange(req.query as Record<string, unknown>);
    if (!range.ok) return fail(res, 400, range.code, range.message);

    try {
      const result = await runReadTool(
        "meta.insights",
        {
          accountId,
          startDate: range.value.start,
          endDate: range.value.end,
          level: "account",
          // Daily granularity is what makes this a series rather than a total.
          timeIncrement: 1,
          limit: 500,
        },
        req.auth
      );
      const rows = rowsFrom(result);
      if (!rows.ok) return fail(res, statusForToolFailure(rows.code), rows.code, rows.message);

      const series = rows.value
        .map(toMetricRow)
        .filter((r) => r.date !== null)
        .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));

      ok(res, {
        accountId,
        dateRange: range.value,
        series,
        pointCount: series.length,
      });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Failed to load Meta time series");
    }
  });

  // -------------------------------------------------------------------------
  // GET /meta/campaigns — per-campaign rows for comparison
  // -------------------------------------------------------------------------
  router.get("/meta/campaigns", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const accountId = configuredAccountId();
    if (!accountId) {
      return fail(res, 503, "ACCOUNT_NOT_CONFIGURED", "Ad account not configured on this server");
    }

    const range = parseDateRange(req.query as Record<string, unknown>);
    if (!range.ok) return fail(res, 400, range.code, range.message);

    const limit = parseLimit(req.query.limit, 10, 50);
    if (!limit.ok) return fail(res, 400, limit.code, limit.message);

    try {
      const result = await runReadTool(
        "meta.insights",
        {
          accountId,
          startDate: range.value.start,
          endDate: range.value.end,
          level: "campaign",
          limit: limit.value,
        },
        req.auth
      );
      const rows = rowsFrom(result);
      if (!rows.ok) return fail(res, statusForToolFailure(rows.code), rows.code, rows.message);

      const campaigns = rows.value.map((raw) => ({
        campaignId: typeof raw.campaign_id === "string" ? raw.campaign_id : null,
        campaignName: typeof raw.campaign_name === "string" ? raw.campaign_name : null,
        ...toMetricRow(raw),
      }));

      // Biggest spender first: on a comparison chart the reader is looking for
      // where the money went, not for alphabetical order.
      campaigns.sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1));

      ok(res, { accountId, dateRange: range.value, campaigns, campaignCount: campaigns.length });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Failed to load Meta campaign comparison");
    }
  });

  return router;
}
