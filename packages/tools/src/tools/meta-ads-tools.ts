import { BaseTool } from "../base-tool.js";
import type { ToolResult, ToolContext } from "@jarvis/core";
import type { MetaAdsProvider, MetaAccountAuthorizer } from "./meta-ads-provider.js";
import {
  validateAccountId,
  validateEntityId,
  validateDateRange,
  validateLimit,
  validateMetrics,
  validateBreakdown,
  validateInsightLevel,
} from "./meta-ads-validators.js";

// ---------------------------------------------------------------------------
// Shared base for all Meta Ads tools
// ---------------------------------------------------------------------------

abstract class BaseMetaAdsTool extends BaseTool {
  protected readonly provider: MetaAdsProvider;
  protected readonly authorizer: MetaAccountAuthorizer;

  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[],
    provider: MetaAdsProvider,
    authorizer: MetaAccountAuthorizer,
    version = "1.0.0"
  ) {
    super(
      id,
      name,
      description,
      "marketing",
      parameters,
      false,
      ["read"],
      "READ_ONLY",
      version,
      true
    );
    this.provider = provider;
    this.authorizer = authorizer;
  }

  protected async checkAccess(userId: string, accountId: string): Promise<ToolResult | null> {
    const validAccount = validateAccountId(accountId);
    if (!validAccount) {
      return this.failure("Invalid account ID format");
    }
    const authorized = await this.authorizer.isAuthorized(userId, validAccount);
    if (!authorized) {
      return this.failure("Not authorized to access this Meta account");
    }
    return null;
  }

  protected sanitizeAccountResult<T extends Record<string, unknown>>(data: T): T {
    const sanitized = { ...data };
    delete sanitized.access_token;
    delete sanitized.token;
    delete sanitized.secret;
    return sanitized;
  }
}

// ---------------------------------------------------------------------------
// meta.accounts — List ad accounts
// ---------------------------------------------------------------------------

export class MetaGetAccountsTool extends BaseMetaAdsTool {
  constructor(provider: MetaAdsProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.accounts",
      "Meta Ad Accounts",
      "List Meta ad accounts accessible to the user. Returns account info including name, currency, and spend.",
      [
        {
          name: "limit",
          type: "number",
          description: "Max accounts to return (1-500, default 50)",
          required: false,
        },
        {
          name: "after",
          type: "string",
          description: "Pagination cursor for next page",
          required: false,
        },
      ],
      provider,
      authorizer
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      const authorizedIds = await this.authorizer.getAuthorizedAccountIds(context.userId);

      const limit = validateLimit(params.limit);
      const pagination = { limit: 500, after: typeof params.after === "string" ? params.after : undefined };
      const result = await this.provider.getAdAccounts(pagination);

      const filtered = authorizedIds.length > 0
        ? result.data.filter((a) => authorizedIds.includes(a.accountId))
        : [];

      const paged = filtered.slice(0, limit);

      return this.success(
        {
          accounts: paged.map((a) => this.sanitizeAccountResult(a as Record<string, unknown>)),
          count: paged.length,
          totalAuthorized: filtered.length,
          nextPage: filtered.length > limit ? result.nextPage : undefined,
        },
        {
          toolId: this.id,
          risk: this.risk,
          userId: context.userId,
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch accounts";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.campaigns — List campaigns for an account
// ---------------------------------------------------------------------------

export class MetaGetCampaignsTool extends BaseMetaAdsTool {
  constructor(provider: MetaAdsProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.campaigns",
      "Meta Campaigns",
      "List campaigns for a Meta ad account. Returns campaign name, status, objective, and budget info.",
      [
        {
          name: "accountId",
          type: "string",
          description: "Meta ad account ID (e.g. act_123456789)",
          required: true,
        },
        {
          name: "limit",
          type: "number",
          description: "Max campaigns to return (1-500, default 50)",
          required: false,
        },
        {
          name: "after",
          type: "string",
          description: "Pagination cursor",
          required: false,
        },
      ],
      provider,
      authorizer
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const accessError = await this.checkAccess(context.userId, accountId);
    if (accessError) return accessError;

    const validAccount = validateAccountId(accountId)!;

    try {
      const limit = validateLimit(params.limit);
      const pagination = { limit, after: typeof params.after === "string" ? params.after : undefined };
      const result = await this.provider.getCampaigns(validAccount, pagination);

      return this.success(
        {
          accountId: validAccount,
          campaigns: result.data,
          count: result.data.length,
          nextPage: result.nextPage,
        },
        { toolId: this.id, risk: this.risk, userId: context.userId }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch campaigns";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.adsets — List ad sets
// ---------------------------------------------------------------------------

export class MetaGetAdSetsTool extends BaseMetaAdsTool {
  constructor(provider: MetaAdsProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.adsets",
      "Meta Ad Sets",
      "List ad sets for a Meta ad account or campaign. Returns ad set name, status, budget, and targeting summary.",
      [
        {
          name: "accountId",
          type: "string",
          description: "Meta ad account ID",
          required: true,
        },
        {
          name: "campaignId",
          type: "string",
          description: "Optional campaign ID to filter by",
          required: false,
        },
        {
          name: "limit",
          type: "number",
          description: "Max ad sets to return (1-500, default 50)",
          required: false,
        },
        {
          name: "after",
          type: "string",
          description: "Pagination cursor",
          required: false,
        },
      ],
      provider,
      authorizer
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const accessError = await this.checkAccess(context.userId, accountId);
    if (accessError) return accessError;

    const validAccount = validateAccountId(accountId)!;
    const campaignId = typeof params.campaignId === "string" ? validateEntityId(params.campaignId) : undefined;

    try {
      const limit = validateLimit(params.limit);
      const pagination = { limit, after: typeof params.after === "string" ? params.after : undefined };
      const result = await this.provider.getAdSets(validAccount, campaignId ?? undefined, pagination);

      return this.success(
        {
          accountId: validAccount,
          campaignId: campaignId ?? null,
          adSets: result.data,
          count: result.data.length,
          nextPage: result.nextPage,
        },
        { toolId: this.id, risk: this.risk, userId: context.userId }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch ad sets";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.ads — List ads
// ---------------------------------------------------------------------------

export class MetaGetAdsTool extends BaseMetaAdsTool {
  constructor(provider: MetaAdsProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.ads",
      "Meta Ads",
      "List ads for a Meta ad account, campaign, or ad set. Returns ad name, status, and creative info.",
      [
        {
          name: "accountId",
          type: "string",
          description: "Meta ad account ID",
          required: true,
        },
        {
          name: "campaignId",
          type: "string",
          description: "Optional campaign ID to filter by",
          required: false,
        },
        {
          name: "adSetId",
          type: "string",
          description: "Optional ad set ID to filter by",
          required: false,
        },
        {
          name: "limit",
          type: "number",
          description: "Max ads to return (1-500, default 50)",
          required: false,
        },
        {
          name: "after",
          type: "string",
          description: "Pagination cursor",
          required: false,
        },
      ],
      provider,
      authorizer
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const accessError = await this.checkAccess(context.userId, accountId);
    if (accessError) return accessError;

    const validAccount = validateAccountId(accountId)!;
    const campaignId = typeof params.campaignId === "string" ? validateEntityId(params.campaignId) : undefined;
    const adSetId = typeof params.adSetId === "string" ? validateEntityId(params.adSetId) : undefined;

    try {
      const limit = validateLimit(params.limit);
      const pagination = { limit, after: typeof params.after === "string" ? params.after : undefined };
      const result = await this.provider.getAds(
        validAccount,
        campaignId ?? undefined,
        adSetId ?? undefined,
        pagination
      );

      return this.success(
        {
          accountId: validAccount,
          campaignId: campaignId ?? null,
          adSetId: adSetId ?? null,
          ads: result.data,
          count: result.data.length,
          nextPage: result.nextPage,
        },
        { toolId: this.id, risk: this.risk, userId: context.userId }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch ads";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.insights — Performance metrics
// ---------------------------------------------------------------------------

export class MetaGetInsightsTool extends BaseMetaAdsTool {
  constructor(provider: MetaAdsProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.insights",
      "Meta Insights",
      "Get performance insights for a Meta ad account. Returns metrics like spend, impressions, clicks, CTR, CPC, CPM, conversions, and ROAS.",
      [
        {
          name: "accountId",
          type: "string",
          description: "Meta ad account ID",
          required: true,
        },
        {
          name: "startDate",
          type: "string",
          description: "Start date (YYYY-MM-DD)",
          required: true,
        },
        {
          name: "endDate",
          type: "string",
          description: "End date (YYYY-MM-DD)",
          required: true,
        },
        {
          name: "level",
          type: "string",
          description: "Insight level: account, campaign, adset, ad (default: account)",
          required: false,
        },
        {
          name: "campaignIds",
          type: "array",
          description: "Filter by specific campaign IDs",
          required: false,
        },
        {
          name: "fields",
          type: "array",
          description: "Specific metrics to return (default: all available)",
          required: false,
        },
        {
          name: "breakdown",
          type: "string",
          description: "Breakdown dimension: age, gender, country, placement, device_platform, publisher_platform",
          required: false,
        },
        {
          name: "limit",
          type: "number",
          description: "Max rows to return (1-500, default 50)",
          required: false,
        },
        {
          name: "after",
          type: "string",
          description: "Pagination cursor",
          required: false,
        },
      ],
      provider,
      authorizer
    );
  }

  validate(params: Record<string, unknown>): boolean {
    if (!super.validate(params)) return false;
    const dateRange = { start: params.startDate as string, end: params.endDate as string };
    const dateValidation = validateDateRange(dateRange);
    return dateValidation.valid;
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const accessError = await this.checkAccess(context.userId, accountId);
    if (accessError) return accessError;

    const validAccount = validateAccountId(accountId)!;
    const dateRange = { start: params.startDate as string, end: params.endDate as string };
    const dateValidation = validateDateRange(dateRange);
    if (!dateValidation.valid) {
      return this.failure(dateValidation.error!);
    }

    const level = validateInsightLevel(params.level);
    const fields = validateMetrics(params.fields);
    const breakdown = validateBreakdown(params.breakdown);
    const campaignIds = Array.isArray(params.campaignIds)
      ? (params.campaignIds as unknown[])
          .filter((id): id is string => typeof id === "string")
          .map(validateEntityId)
          .filter((id): id is string => id !== null)
      : undefined;

    try {
      const limit = validateLimit(params.limit);
      const pagination = { limit, after: typeof params.after === "string" ? params.after : undefined };
      const result = await this.provider.getInsights(
        validAccount,
        dateRange,
        level as "account" | "campaign" | "adset" | "ad",
        {
          campaignIds,
          fields: fields.length > 0 ? fields : undefined,
          breakdown: breakdown ?? undefined,
        },
        pagination
      );

      return this.success(
        {
          accountId: validAccount,
          dateRange,
          level,
          breakdown: breakdown ?? null,
          insights: result.data,
          count: result.data.length,
          nextPage: result.nextPage,
        },
        { toolId: this.id, risk: this.risk, userId: context.userId }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch insights";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}
