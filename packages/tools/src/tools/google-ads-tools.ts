import { BaseTool } from "../base-tool.js";
import type { ToolResult, ToolContext } from "@jarvis/core";
import type { ProviderCallOptions } from "./meta-ads-provider.js";
import type { GoogleAdsProvider, GoogleAccountAuthorizer } from "./google-ads-provider.js";

// ---------------------------------------------------------------------------
// Google Ads tools (Sprint 5.2) — ALL READ-ONLY
// ---------------------------------------------------------------------------
// Mirrors meta-ads-tools.ts. Every tool here is RiskLevel READ_ONLY with
// permission ["read"], which means ToolApprovalService auto-approves them
// (RISK_REQUIRES_APPROVAL.READ_ONLY === false) — the same treatment the Meta
// read tools get, and no weakening of the approval boundary.
//
// A future Google WRITE tool must declare EXTERNAL_SIDE_EFFECT or FINANCIAL,
// which the existing table already forces through the approval flow. Nothing
// here bypasses that; there is simply nothing to approve yet.
// ---------------------------------------------------------------------------

const CUSTOMER_ID_PATTERN = /^\d{10}$/;
const MAX_RANGE_DAYS = 365;

/** Strips dashes; returns null when the id is not 10 digits. */
export function validateCustomerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.trim().replace(/-/g, "");
  return CUSTOMER_ID_PATTERN.test(stripped) ? stripped : null;
}

export function validateDateRange(
  since: unknown,
  until: unknown
): { since: string; until: string } | null {
  if (typeof since !== "string" || typeof until !== "string") return null;
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(since) || !pattern.test(until)) return null;

  const from = Date.parse(since);
  const to = Date.parse(until);
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) return null;
  if ((to - from) / 86_400_000 > MAX_RANGE_DAYS) return null;
  return { since, until };
}

abstract class BaseGoogleAdsTool extends BaseTool {
  protected readonly provider: GoogleAdsProvider;
  protected readonly authorizer: GoogleAccountAuthorizer;

  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[],
    provider: GoogleAdsProvider,
    authorizer: GoogleAccountAuthorizer,
    version = "1.0.0"
  ) {
    super(id, name, description, "marketing", parameters, false, ["read"], "READ_ONLY", version, true);
    this.provider = provider;
    this.authorizer = authorizer;
  }

  protected callOpts(context: ToolContext): ProviderCallOptions {
    return { signal: context.signal };
  }

  /**
   * Server-side authorization. Returns a failure ToolResult when the caller may
   * not touch this customer, so a tool body can early-return it directly.
   *
   * The denial message is identical for "not a real account" and "not yours",
   * so the tool cannot be used to enumerate which customer ids exist.
   */
  protected async checkAccess(
    userId: string,
    customerId: string,
    options?: ProviderCallOptions
  ): Promise<{ error: ToolResult } | { customerId: string }> {
    const valid = validateCustomerId(customerId);
    if (!valid) {
      return { error: this.failure("Invalid Google Ads customer ID format") };
    }
    const authorized = await this.authorizer.isAuthorized(userId, valid, options);
    if (!authorized) {
      return { error: this.failure("Not authorized to access this Google Ads account") };
    }
    return { customerId: valid };
  }

  /** Normalises any provider throw into a ToolResult without leaking internals. */
  protected toFailure(err: unknown): ToolResult {
    const message = err instanceof Error ? err.message : "Google Ads request failed";
    return this.failure(message);
  }
}

// ---------------------------------------------------------------------------
// google.accounts
// ---------------------------------------------------------------------------

export class GoogleGetAccountsTool extends BaseGoogleAdsTool {
  constructor(provider: GoogleAdsProvider, authorizer: GoogleAccountAuthorizer) {
    super(
      "google.accounts",
      "Google Ads Accounts",
      "List Google Ads accounts the user has connected. Returns account name, currency and timezone.",
      [],
      provider,
      authorizer
    );
  }

  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      const customers = await this.provider.getAccessibleCustomers(
        context.userId,
        this.callOpts(context)
      );
      return this.success(
        { accounts: customers, count: customers.length },
        { source: "google-ads", readOnly: true }
      );
    } catch (err) {
      return this.toFailure(err);
    }
  }
}

// ---------------------------------------------------------------------------
// google.campaigns
// ---------------------------------------------------------------------------

export class GoogleGetCampaignsTool extends BaseGoogleAdsTool {
  constructor(provider: GoogleAdsProvider, authorizer: GoogleAccountAuthorizer) {
    super(
      "google.campaigns",
      "Google Ads Campaigns",
      "List campaigns for a connected Google Ads account, with status, channel type and daily budget.",
      [
        {
          name: "customerId",
          type: "string",
          description: "10-digit Google Ads customer ID (dashes optional)",
          required: true,
        },
      ],
      provider,
      authorizer
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const access = await this.checkAccess(
      context.userId,
      String(params.customerId ?? ""),
      this.callOpts(context)
    );
    if ("error" in access) return access.error;

    try {
      const campaigns = await this.provider.getCampaigns(
        context.userId,
        access.customerId,
        this.callOpts(context)
      );
      return this.success(
        { customerId: access.customerId, campaigns, count: campaigns.length },
        { source: "google-ads", readOnly: true }
      );
    } catch (err) {
      return this.toFailure(err);
    }
  }
}

// ---------------------------------------------------------------------------
// google.insights
// ---------------------------------------------------------------------------

export class GoogleGetInsightsTool extends BaseGoogleAdsTool {
  constructor(provider: GoogleAdsProvider, authorizer: GoogleAccountAuthorizer) {
    super(
      "google.insights",
      "Google Ads Performance",
      "Fetch Google Ads performance metrics (impressions, clicks, cost, conversions) for a date range.",
      [
        {
          name: "customerId",
          type: "string",
          description: "10-digit Google Ads customer ID (dashes optional)",
          required: true,
        },
        { name: "since", type: "string", description: "Start date, YYYY-MM-DD", required: true },
        { name: "until", type: "string", description: "End date, YYYY-MM-DD", required: true },
        {
          name: "daily",
          type: "boolean",
          description: "Segment results by date instead of totals",
          required: false,
        },
      ],
      provider,
      authorizer
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const access = await this.checkAccess(
      context.userId,
      String(params.customerId ?? ""),
      this.callOpts(context)
    );
    if ("error" in access) return access.error;

    const range = validateDateRange(params.since, params.until);
    if (!range) {
      return this.failure(
        "Invalid date range: expected YYYY-MM-DD, since <= until, span at most 365 days"
      );
    }

    try {
      const metrics = await this.provider.getMetrics(context.userId, access.customerId, range, {
        ...this.callOpts(context),
        daily: params.daily === true,
      });
      return this.success(
        { customerId: access.customerId, dateRange: range, metrics, count: metrics.length },
        { source: "google-ads", readOnly: true }
      );
    } catch (err) {
      return this.toFailure(err);
    }
  }
}
