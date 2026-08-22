import type {
  MetaAdsProvider,
  MetaAdsWriteProvider,
  MetaAdsBudgetProvider,
  MetaCampaignCreatorProvider,
  MetaAccountAuthorizer,
  ProviderCallOptions,
} from "@jarvis/tools";
import type {
  MetaAdAccount,
  MetaCampaign,
  MetaAdSet,
  MetaAd,
  MetaInsights,
  MetaDateRange,
  MetaPagination,
  MetaCampaignInput,
} from "@jarvis/core";
import { normalizeAccountId } from "./config.js";
import { createMetaHttpClient, isSuccessResponse, extractError, type MetaHttpClient, type MetaHttpResponse } from "./client.js";
import {
  parseAdAccount,
  parseCampaign,
  parseAdSet,
  parseAd,
  parseInsights,
} from "./response-validator.js";
import { classifyMetaError, toJarvisError } from "./error-handler.js";

export interface MetaGraphProviderConfig {
  accessToken: string;
  adAccountId: string;
  apiVersion?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  httpClient?: MetaHttpClient;
}

export interface MetaGraphProvider
  extends MetaAdsProvider,
    MetaAdsWriteProvider,
    MetaAdsBudgetProvider,
    MetaCampaignCreatorProvider,
    MetaAccountAuthorizer {}

export function createMetaGraphProvider(config: MetaGraphProviderConfig): MetaGraphProvider {
  const metaConfig = {
    accessToken: config.accessToken,
    adAccountId: normalizeAccountId(config.adAccountId),
    apiVersion: config.apiVersion ?? "v21.0",
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs ?? 30000,
    maxRetries: config.maxRetries ?? 0,
  };

  const client = config.httpClient ?? createMetaHttpClient(metaConfig);

  function extractNextPagePaging(resp: { paging?: unknown }): string | undefined {
    const p = resp.paging as { next?: string } | undefined;
    return p?.next;
  }

  // Phase 10.4: the caller's AbortSignal rides on every Graph request so a
  // deadline/abort cancels the actual HTTP call (GET reads AND POST writes).
  async function graphGet<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    options?: ProviderCallOptions
  ): Promise<T> {
    const resp = await client.request({ method: "GET", path, params, signal: options?.signal });
    if (!isSuccessResponse(resp)) {
      throw toJarvisError(extractError(resp));
    }
    return resp.body as T;
  }

  async function graphPost(
    path: string,
    body: Record<string, unknown>,
    options?: ProviderCallOptions
  ): Promise<MetaHttpResponse> {
    const resp = await client.request({ method: "POST", path, body, signal: options?.signal });
    if (!isSuccessResponse(resp)) {
      throw toJarvisError(extractError(resp));
    }
    return resp;
  }

  const AD_ACCOUNT_FIELDS =
    "id,name,currency,timezone_name,account_status,spend_cap,amount_spent,balance,business_name";

  async function fetchAdAccountListIds(options?: ProviderCallOptions): Promise<string[]> {
    const resp = await graphGet<{ data: Array<{ id: string }> }>("me/adaccounts", {
      fields: "id",
      limit: 100,
    }, options);
    return (resp.data ?? []).map((a) => String(a.id));
  }

  function isConfiguredAccount(accountId: string): boolean {
    try {
      return normalizeAccountId(accountId) === metaConfig.adAccountId;
    } catch {
      return false;
    }
  }

  /**
   * Directly verifies the server-configured ad account.
   *
   * Business Manager-owned accounts may be absent from /me/adaccounts while
   * remaining directly accessible. This fallback performs a GET against ONLY
   * metaConfig.adAccountId (never an arbitrary ID from tool input), validates
   * the response through the shared Zod schema, and requires the returned
   * account ID to exactly match the configured account ID. Any non-2xx,
   * error body, malformed payload, or mismatched ID is treated as
   * unauthorized.
   */
  async function verifyConfiguredAccountDirectly(options?: ProviderCallOptions): Promise<boolean> {
    try {
      const resp = await client.request({
        method: "GET",
        path: metaConfig.adAccountId,
        params: { fields: AD_ACCOUNT_FIELDS },
        signal: options?.signal,
      });
      if (!isSuccessResponse(resp)) return false;
      const parsed = parseAdAccount(resp.body);
      return parsed !== null && parsed.accountId === metaConfig.adAccountId;
    } catch {
      return false;
    }
  }

  async function checkAccountAccess(accountId: string, options?: ProviderCallOptions): Promise<void> {
    const accountIdNorm = normalizeAccountId(accountId);

    // 1st mechanism: discovery via /me/adaccounts (auth errors propagate).
    const accountIds = await fetchAdAccountListIds(options);
    if (accountIds.includes(accountIdNorm) || accountIds.includes(accountId)) {
      return;
    }

    // 2nd mechanism: direct verification, restricted to the server-configured
    // account only. Arbitrary IDs from tool input can never reach this path.
    if (isConfiguredAccount(accountIdNorm) && (await verifyConfiguredAccountDirectly(options))) {
      return;
    }

    throw toJarvisError(classifyMetaError(403, { error: { message: "Not authorized to access this Meta account", type: "authorization", code: 403 } }));
  }

  return {
    // =========================================================================
    // MetaAdsProvider — Read-only
    // =========================================================================

    async getAdAccounts(pagination?: MetaPagination, options?: ProviderCallOptions) {
      const params: Record<string, string | number | boolean | undefined> = {
        fields: "id,name,currency,timezone_name,account_status,spend_cap,amount_spent,balance,business_name",
        limit: pagination?.limit ?? 25,
      };
      if (pagination?.after) params.after = pagination.after;

      const resp = await graphGet<{ data: unknown[]; paging?: unknown }>("me/adaccounts", params, options);
      const accounts = (resp.data ?? [])
        .map(parseAdAccount)
        .filter((a): a is MetaAdAccount => a !== null);

      return { data: accounts, nextPage: extractNextPagePaging(resp) };
    },

    async getCampaigns(accountId: string, pagination?: MetaPagination, options?: ProviderCallOptions) {
      const accountIdNorm = normalizeAccountId(accountId);
      const params: Record<string, string | number | boolean | undefined> = {
        // created_time supports Phase 10.5 reconciliation correlation windows.
        fields: "id,name,status,objective,daily_budget,lifetime_budget,start_time,end_time,bid_strategy,buying_type,created_time",
        limit: pagination?.limit ?? 25,
      };
      if (pagination?.after) params.after = pagination.after;

      const resp = await graphGet<{ data: unknown[]; paging?: unknown }>(`${accountIdNorm}/campaigns`, params, options);
      const campaigns = (resp.data ?? [])
        .map(parseCampaign)
        .filter((c): c is MetaCampaign => c !== null);

      return { data: campaigns, nextPage: extractNextPagePaging(resp) };
    },

    async getAdSets(accountId: string, campaignId?: string, pagination?: MetaPagination, options?: ProviderCallOptions) {
      const accountIdNorm = normalizeAccountId(accountId);
      const params: Record<string, string | number | boolean | undefined> = {
        fields: "id,campaign_id,name,status,targeting,daily_budget,lifetime_budget,bid_amount,optimization_goal,start_time,end_time",
        limit: pagination?.limit ?? 25,
      };
      if (pagination?.after) params.after = pagination.after;

      const path = campaignId
        ? `${campaignId}/adsets`
        : `${accountIdNorm}/adsets`;

      const resp = await graphGet<{ data: unknown[]; paging?: unknown }>(path, params, options);
      const adSets = (resp.data ?? [])
        .map(parseAdSet)
        .filter((a): a is MetaAdSet => a !== null);

      return { data: adSets, nextPage: extractNextPagePaging(resp) };
    },

    async getAds(accountId: string, campaignId?: string, adSetId?: string, pagination?: MetaPagination, options?: ProviderCallOptions) {
      const accountIdNorm = normalizeAccountId(accountId);
      const params: Record<string, string | number | boolean | undefined> = {
        fields: "id,adset_id,campaign_id,name,status,creative",
        limit: pagination?.limit ?? 25,
      };
      if (pagination?.after) params.after = pagination.after;

      let path: string;
      if (adSetId) {
        path = `${adSetId}/ads`;
      } else if (campaignId) {
        path = `${campaignId}/ads`;
      } else {
        path = `${accountIdNorm}/ads`;
      }

      const resp = await graphGet<{ data: unknown[]; paging?: unknown }>(path, params, options);
      const ads = (resp.data ?? [])
        .map(parseAd)
        .filter((a): a is MetaAd => a !== null);

      return { data: ads, nextPage: extractNextPagePaging(resp) };
    },

    async getInsights(
      accountId: string,
      dateRange: MetaDateRange,
      level: "account" | "campaign" | "adset" | "ad",
      filters?: { campaignIds?: string[]; adSetIds?: string[]; adIds?: string[]; fields?: string[]; breakdown?: string },
      pagination?: MetaPagination,
      options?: ProviderCallOptions
    ) {
      const accountIdNorm = normalizeAccountId(accountId);
      const params: Record<string, string | number | boolean | undefined> = {
        time_range: JSON.stringify({ since: dateRange.start, until: dateRange.end }),
        level,
        limit: pagination?.limit ?? 25,
      };

      if (filters?.fields?.length) {
        params.fields = filters.fields.join(",");
      } else {
        params.fields = "impressions,clicks,spend,reach,cpc,cpm,ctr,date_start,date_stop";
      }

      if (filters?.breakdown) params.breakdown = filters.breakdown;
      if (filters?.campaignIds?.length) params.filtering = JSON.stringify([{ field: "campaign.id", operator: "IN", value: filters.campaignIds }]);
      if (filters?.adSetIds?.length) params.filtering = JSON.stringify([{ field: "adset.id", operator: "IN", value: filters.adSetIds }]);
      if (filters?.adIds?.length) params.filtering = JSON.stringify([{ field: "ad.id", operator: "IN", value: filters.adIds }]);
      if (pagination?.after) params.after = pagination.after;

      const resp = await graphGet<{ data: unknown[]; paging?: unknown }>(`${accountIdNorm}/insights`, params, options);
      const insights = (resp.data ?? [])
        .map(parseInsights)
        .filter((i): i is MetaInsights => i !== null);

      return { data: insights, nextPage: extractNextPagePaging(resp) };
    },

    // =========================================================================
    // MetaAdsWriteProvider — Status toggles (Phase 9.1)
    // =========================================================================

    async updateCampaignStatus(accountId: string, campaignId: string, status: "ACTIVE" | "PAUSED", options?: ProviderCallOptions) {
      await checkAccountAccess(normalizeAccountId(accountId), options);

      await graphPost(campaignId, { status }, options);
      const resp = await graphGet<Record<string, unknown>>(campaignId, {
        fields: "id,name,status,objective,daily_budget,lifetime_budget,bid_strategy,buying_type",
      }, options);
      const campaign = parseCampaign(resp);
      if (!campaign) throw new Error("Failed to verify campaign after status update");
      return { success: true, campaign };
    },

    async updateAdSetStatus(accountId: string, adSetId: string, status: "ACTIVE" | "PAUSED", options?: ProviderCallOptions) {
      await checkAccountAccess(normalizeAccountId(accountId), options);

      await graphPost(adSetId, { status }, options);
      const resp = await graphGet<Record<string, unknown>>(adSetId, {
        fields: "id,campaign_id,name,status,daily_budget,lifetime_budget,bid_amount,optimization_goal",
      }, options);
      const adSet = parseAdSet(resp);
      if (!adSet) throw new Error("Failed to verify ad set after status update");
      return { success: true, adSet };
    },

    async updateAdStatus(accountId: string, adId: string, status: "ACTIVE" | "PAUSED", options?: ProviderCallOptions) {
      await checkAccountAccess(normalizeAccountId(accountId), options);

      await graphPost(adId, { status }, options);
      const resp = await graphGet<Record<string, unknown>>(adId, {
        fields: "id,adset_id,campaign_id,name,status,creative",
      }, options);
      const ad = parseAd(resp);
      if (!ad) throw new Error("Failed to verify ad after status update");
      return { success: true, ad };
    },

    // =========================================================================
    // MetaAdsBudgetProvider — Budget writes (Phase 9.2)
    // =========================================================================

    async updateCampaignBudget(accountId: string, campaignId: string, dailyBudget: string, options?: ProviderCallOptions) {
      await checkAccountAccess(normalizeAccountId(accountId), options);

      await graphPost(campaignId, { daily_budget: dailyBudget }, options);
      const resp = await graphGet<Record<string, unknown>>(campaignId, {
        fields: "id,name,status,objective,daily_budget,lifetime_budget,bid_strategy,buying_type",
      }, options);
      const campaign = parseCampaign(resp);
      if (!campaign) throw new Error("Failed to verify campaign after budget update");
      return { success: true, campaign };
    },

    async updateAdSetBudget(accountId: string, adSetId: string, dailyBudget: string, options?: ProviderCallOptions) {
      await checkAccountAccess(normalizeAccountId(accountId), options);

      await graphPost(adSetId, { daily_budget: dailyBudget }, options);
      const resp = await graphGet<Record<string, unknown>>(adSetId, {
        fields: "id,campaign_id,name,status,daily_budget,lifetime_budget,bid_amount,optimization_goal",
      }, options);
      const adSet = parseAdSet(resp);
      if (!adSet) throw new Error("Failed to verify ad set after budget update");
      return { success: true, adSet };
    },

    // =========================================================================
    // MetaCampaignCreatorProvider — Campaign creation (Phase 9.3)
    // =========================================================================

    async createCampaign(accountId: string, input: MetaCampaignInput, options?: ProviderCallOptions) {
      const accountIdNorm = normalizeAccountId(accountId);
      await checkAccountAccess(accountIdNorm, options);

      const body: Record<string, string> = {
        name: input.name,
        objective: input.objective,
        status: input.status ?? "PAUSED",
        buying_type: input.buyingType ?? "AUCTION",
        // Meta Graph API v21+ requires special_ad_categories on campaign
        // creation, even when the campaign targets no special category.
        special_ad_categories: JSON.stringify(input.specialAdCategories ?? []),
      };

      if (input.dailyBudget) body.daily_budget = input.dailyBudget;
      if (input.lifetimeBudget) body.lifetime_budget = input.lifetimeBudget;

      const resp = await graphPost(`${accountIdNorm}/campaigns`, body, options);
      const bodyData = resp.body as Record<string, unknown>;
      const newId = String(bodyData.id ?? "");
      if (!newId) throw new Error("Campaign creation returned no ID");

      const campaignResp = await graphGet<Record<string, unknown>>(newId, {
        fields: "id,name,status,objective,daily_budget,lifetime_budget,bid_strategy,buying_type",
      }, options);
      const campaign = parseCampaign(campaignResp);
      if (!campaign) throw new Error("Failed to verify campaign after creation");
      return { success: true, campaign };
    },

    // =========================================================================
    // MetaAccountAuthorizer — Server-side account access control
    // =========================================================================

    async getAuthorizedAccountIds(_userId: string, options?: ProviderCallOptions): Promise<string[]> {
      const ids = new Set<string>();
      try {
        for (const id of await fetchAdAccountListIds(options)) {
          ids.add(id);
        }
      } catch {
        // Discovery unavailable; configured-account verification still applies.
      }
      if (!ids.has(metaConfig.adAccountId) && (await verifyConfiguredAccountDirectly(options))) {
        ids.add(metaConfig.adAccountId);
      }
      return [...ids];
    },

    async isAuthorized(_userId: string, accountId: string, options?: ProviderCallOptions): Promise<boolean> {
      let accountIdNorm: string;
      try {
        accountIdNorm = normalizeAccountId(accountId);
      } catch {
        return false;
      }
      try {
        const accountIds = await fetchAdAccountListIds(options);
        if (accountIds.includes(accountIdNorm) || accountIds.includes(accountId)) {
          return true;
        }
      } catch {
        // Discovery unavailable; fall through to configured-account verification.
      }
      if (isConfiguredAccount(accountIdNorm)) {
        return verifyConfiguredAccountDirectly(options);
      }
      return false;
    },
  };
}
