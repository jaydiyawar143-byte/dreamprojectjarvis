import { BaseTool } from "../base-tool.js";
import type { ToolResult, ToolContext } from "@jarvis/core";
import { maskIdentifier } from "@jarvis/core";
import type { MetaAdsProvider, MetaAccountAuthorizer, ProviderCallOptions } from "./meta-ads-provider.js";
import {
  validateAccountId,
  validateEntityId,
  validateDateRange,
  resolveInsightsDateRange,
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

  protected async checkAccess(userId: string, accountId: string, options?: ProviderCallOptions): Promise<ToolResult | null> {
    const validAccount = validateAccountId(accountId);
    if (!validAccount) {
      return this.failure("Invalid account ID format");
    }
    const authorized = await this.authorizer.isAuthorized(userId, validAccount, options);
    if (!authorized) {
      return this.failure("Not authorized to access this Meta account");
    }
    return null;
  }

  /**
   * The account a READ should actually run against.
   *
   * WHY THIS EXISTS. The account id was being supplied by the MODEL, copied out
   * of the system prompt. That works while the conversation is obviously about
   * Meta and fails the moment it is not: asked "compare this week with previous
   * week", with no Meta word anywhere in it, the model reached for whatever
   * looked like an account id — the `act_123456789` example in this file's own
   * parameter descriptions, the literal string `meta-ad-account-id`, or nothing
   * at all. Every one of those is refused by `checkAccess`, so a perfectly
   * ordinary question died as "Not authorized to access this Meta account" and
   * the user was told, in effect, that their own account was not theirs.
   *
   * Making the prompt shoutier is not a fix; it is the same bet on the model
   * copying a constant, placed again. The server knows the answer, so the
   * server supplies it — exactly as it now does for the date range.
   *
   * THIS CANNOT WIDEN ACCESS. The fallback is drawn from
   * `getAuthorizedAccountIds`, so it can only ever land on an account this user
   * is ALREADY authorized for. A supplied-and-authorized id is used untouched;
   * an unauthorized one is still refused rather than quietly swapped, so a
   * genuine attempt to reach someone else's account fails as loudly as before.
   * And with more than one account it refuses to choose — guessing which of a
   * user's clients they meant is the failure this must not trade down into.
   */
  protected async resolveReadAccount(
    userId: string,
    accountId: unknown,
    options?: ProviderCallOptions
  ): Promise<{ accountId: string; error: null; substituted: boolean } | { accountId: null; error: ToolResult; substituted: false }> {
    const supplied = typeof accountId === "string" ? validateAccountId(accountId) : null;

    if (supplied) {
      const authorized = await this.authorizer.isAuthorized(userId, supplied, options);
      if (authorized) return { accountId: supplied, error: null, substituted: false };
      // Deliberately NOT falling back when the id was well-formed but
      // unauthorized: that is the shape a real access attempt takes, and it
      // must keep failing exactly as it did before.
      return {
        accountId: null,
        error: this.failure("Not authorized to access this Meta account"),
        substituted: false,
      };
    }

    // Missing or malformed — i.e. the model did not know it. Ask the authorizer.
    const authorizedIds = await this.authorizer.getAuthorizedAccountIds(userId, options);

    if (authorizedIds.length === 0) {
      return {
        accountId: null,
        error: this.failure(
          "No Meta ad account is connected. Connect a Meta account before asking for ad data."
        ),
        substituted: false,
      };
    }

    if (authorizedIds.length > 1) {
      return {
        accountId: null,
        error: this.failure(
          `You have ${authorizedIds.length} Meta ad accounts connected. Tell me which one you mean and I'll pull the data for it.`
        ),
        substituted: false,
      };
    }

    return { accountId: authorizedIds[0]!, error: null, substituted: true };
  }

  /** Phase 10.4 — cancellation options for provider calls. */
  protected callOpts(context: ToolContext): ProviderCallOptions {
    return { signal: context.signal };
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
          description: "Pagination cursor",
          required: false,
        },
        {
          name: "timeIncrement",
          type: "number",
          description: "Split range into N-day rows (1 = daily). 1-90.",
          required: false,
        },
      ],
      provider,
      authorizer
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      const authorizedIds = await this.authorizer.getAuthorizedAccountIds(context.userId, this.callOpts(context));

      const limit = validateLimit(params.limit);
      const pagination = { limit: 500, after: typeof params.after === "string" ? params.after : undefined };
      const result = await this.provider.getAdAccounts(pagination, this.callOpts(context));

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
          description: "Meta ad account ID. Use ONLY the account id supplied in your system context; never invent one and never copy an example id from documentation.",
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
      const result = await this.provider.getCampaigns(validAccount, pagination, this.callOpts(context));

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
      const result = await this.provider.getAdSets(validAccount, campaignId ?? undefined, pagination, this.callOpts(context));

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
        pagination,
        this.callOpts(context)
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
          // Optional for the same reason the dates are: a required field the
          // model cannot reliably fill is a field it will fill with a
          // placeholder. Omitted, the server uses the user's connected account.
          description:
            "Meta ad account ID. OPTIONAL — if you were not given a real account id, OMIT this entirely and the server will use the user's connected account. Never invent one and never copy an example id from documentation.",
          required: false,
        },
        {
          name: "startDate",
          type: "string",
          // Optional, and it must stay optional: a required date forced the
          // model to invent one, and it invented 2023. Omit both and the
          // server resolves the last 7 days from its own clock.
          description:
            "Start date (YYYY-MM-DD). OPTIONAL — omit BOTH dates and the last 7 days are used automatically. Never guess a date; if the user gave no range, leave this out.",
          required: false,
        },
        {
          name: "endDate",
          type: "string",
          description:
            "End date (YYYY-MM-DD). OPTIONAL — omit BOTH dates and the last 7 days are used automatically. Never guess a date; if the user gave no range, leave this out.",
          required: false,
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
    // Resolved first: omitting both dates is now the normal case, and it must
    // validate rather than being rejected before execute() can default it.
    const resolved = resolveInsightsDateRange(params);
    return validateDateRange({ start: resolved.start, end: resolved.end }).valid;
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Server-resolved, for the same reason the date range is: the model does
    // not reliably know it, and when it guesses it guesses a placeholder.
    const account = await this.resolveReadAccount(context.userId, params.accountId, this.callOpts(context));
    if (account.error) {
      // Logged on this path too. `checkAccess` used to return early, so a
      // refused account produced no insights log at all — and "which account
      // did it actually ask for" is exactly the question you need answered
      // when a caller is passing the wrong one. Masked, so the log is safe
      // whether or not the id was real.
      console.log(
        JSON.stringify({
          level: "warn",
          event: "meta_insights_request",
          conversationId: context.conversationId ?? null,
          traceId: context.traceId ?? null,
          resolvedIntent: "meta.performance.insights",
          selectedTool: this.id,
          selectedAccountId: maskIdentifier(String(params.accountId ?? "")),
          toolExecutionStatus: "ACCESS_DENIED",
          dataAvailability: "NO_DATA_NOT_EXECUTED",
        })
      );
      return account.error;
    }

    const validAccount = account.accountId;
    const accountSource = account.substituted ? "server-resolved" : "supplied";
    const resolvedRange = resolveInsightsDateRange(params);
    const dateRange = { start: resolvedRange.start, end: resolvedRange.end };
    const dateValidation = validateDateRange(dateRange);
    if (!dateValidation.valid) {
      return this.failure(dateValidation.error!);
    }

    const level = validateInsightLevel(params.level);
    const fields = validateMetrics(params.fields);
    const breakdown = validateBreakdown(params.breakdown);
    let timeIncrement: number | undefined;
    if (params.timeIncrement !== undefined) {
      const raw = Number(params.timeIncrement);
      if (!Number.isInteger(raw) || raw < 1 || raw > 90) {
        return this.failure("timeIncrement must be an integer between 1 and 90");
      }
      timeIncrement = raw;
    }
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
          timeIncrement,
        },
        pagination,
        this.callOpts(context)
      );

      // Structured insights log. The account id is MASKED — the range, the
      // outcome and whether the range was chosen or defaulted are the facts
      // worth having when an answer looks wrong, and none of them need a full
      // identifier to be useful.
      console.log(
        JSON.stringify({
          level: "info",
          event: "meta_insights_request",
          conversationId: context.conversationId ?? null,
          traceId: context.traceId ?? null,
          resolvedIntent: "meta.performance.insights",
          selectedTool: this.id,
          selectedAccountId: maskIdentifier(validAccount),
          dateRange: `${dateRange.start}..${dateRange.end}`,
          dateRangeSource: resolvedRange.source,
          accountSource,
          // Named `insightLevel`, not `level` — the log envelope already owns
          // `level` for severity.
          insightLevel: level,
          toolExecutionStatus: "SUCCESS",
          dataAvailability: result.data.length > 0 ? "DATA_RETURNED" : "EMPTY_RESULT",
          rowCount: result.data.length,
        })
      );

      return this.success(
        {
          accountId: validAccount,
          dateRange,
          // Provenance for the range, so the answer can state the window it
          // used and whether the user chose it — and so "empty because the
          // range was wrong" can never again be reported as "no data exists".
          dateRangeSource: resolvedRange.source,
          dateRangeLabel: resolvedRange.label,
          level,
          breakdown: breakdown ?? null,
          insights: result.data,
          count: result.data.length,
          // An EMPTY result is not a failure, and the difference has to survive
          // into the answer. The tool succeeded; Meta simply returned no rows.
          dataAvailability: result.data.length > 0 ? "DATA_RETURNED" : "EMPTY_RESULT",
          nextPage: result.nextPage,
        },
        { toolId: this.id, risk: this.risk, userId: context.userId }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch insights";
      // A FAILURE is not an empty result, and the log has to keep them apart
      // for the same reason the answer does.
      console.log(
        JSON.stringify({
          level: "warn",
          event: "meta_insights_request",
          conversationId: context.conversationId ?? null,
          traceId: context.traceId ?? null,
          resolvedIntent: "meta.performance.insights",
          selectedTool: this.id,
          selectedAccountId: maskIdentifier(validAccount),
          dateRange: `${dateRange.start}..${dateRange.end}`,
          dateRangeSource: resolvedRange.source,
          toolExecutionStatus: "FAILED",
          dataAvailability: "NO_DATA_TOOL_FAILED",
        })
      );
      return this.failure(`Meta API error: ${message}`);
    }
  }
}
