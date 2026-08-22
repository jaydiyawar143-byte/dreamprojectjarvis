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

// ---------------------------------------------------------------------------
// ProviderCallOptions — per-call cancellation (Phase 10.4)
// ---------------------------------------------------------------------------
// Every provider method accepts an OPTIONAL trailing options object carrying
// the caller's AbortSignal. Implementations MUST forward it to the HTTP layer
// so a deadline/abort actually cancels the in-flight request. Implementations
// written before Phase 10.4 (fewer parameters) remain structurally compatible.
// ---------------------------------------------------------------------------

export interface ProviderCallOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// MetaAdsProvider — Read-only interface for Meta Graph API
// ---------------------------------------------------------------------------
// Implementations must NEVER expose credentials.
// The provider is the ONLY boundary to the Meta API.
// ---------------------------------------------------------------------------

export interface MetaAdsProvider {
  /** List ad accounts accessible to the authenticated user. */
  getAdAccounts(pagination?: MetaPagination, options?: ProviderCallOptions): Promise<{
    data: MetaAdAccount[];
    nextPage?: string;
  }>;

  /** List campaigns for a given ad account. */
  getCampaigns(
    accountId: string,
    pagination?: MetaPagination,
    options?: ProviderCallOptions
  ): Promise<{
    data: MetaCampaign[];
    nextPage?: string;
  }>;

  /** List ad sets for a given campaign or ad account. */
  getAdSets(
    accountId: string,
    campaignId?: string,
    pagination?: MetaPagination,
    options?: ProviderCallOptions
  ): Promise<{
    data: MetaAdSet[];
    nextPage?: string;
  }>;

  /** List ads for a given ad set, campaign, or ad account. */
  getAds(
    accountId: string,
    campaignId?: string,
    adSetId?: string,
    pagination?: MetaPagination,
    options?: ProviderCallOptions
  ): Promise<{
    data: MetaAd[];
    nextPage?: string;
  }>;

  /** Get insights/performance metrics. */
  getInsights(
    accountId: string,
    dateRange: MetaDateRange,
    level: "account" | "campaign" | "adset" | "ad",
    filters?: {
      campaignIds?: string[];
      adSetIds?: string[];
      adIds?: string[];
      fields?: string[];
      breakdown?: string;
    },
    pagination?: MetaPagination,
    options?: ProviderCallOptions
  ): Promise<{
    data: MetaInsights[];
    nextPage?: string;
  }>;
}

// ---------------------------------------------------------------------------
// MetaAdsWriteProvider — Write interface for Meta Graph API (Phase 9.1)
// ---------------------------------------------------------------------------
// Only status toggle actions (pause/resume) are allowed.
// Budget, targeting, creation, deletion are FORBIDDEN in Phase 9.1.
// ---------------------------------------------------------------------------

export interface MetaAdsWriteProvider {
  /** Set campaign status (ACTIVE ↔ PAUSED). */
  updateCampaignStatus(
    accountId: string,
    campaignId: string,
    status: "ACTIVE" | "PAUSED",
    options?: ProviderCallOptions
  ): Promise<{ success: boolean; campaign: MetaCampaign }>;

  /** Set ad set status (ACTIVE ↔ PAUSED). */
  updateAdSetStatus(
    accountId: string,
    adSetId: string,
    status: "ACTIVE" | "PAUSED",
    options?: ProviderCallOptions
  ): Promise<{ success: boolean; adSet: MetaAdSet }>;

  /** Set ad status (ACTIVE ↔ PAUSED). */
  updateAdStatus(
    accountId: string,
    adId: string,
    status: "ACTIVE" | "PAUSED",
    options?: ProviderCallOptions
  ): Promise<{ success: boolean; ad: MetaAd }>;
}

// ---------------------------------------------------------------------------
// MetaAdsBudgetProvider — Budget write interface for Meta Graph API (Phase 9.2)
// ---------------------------------------------------------------------------
// Only daily budget updates for campaigns and ad sets.
// Lifetime budget, bid strategy, targeting, creation, deletion are FORBIDDEN in Phase 9.2.
// ---------------------------------------------------------------------------

export interface MetaAdsBudgetProvider {
  /** Set campaign daily budget. */
  updateCampaignBudget(
    accountId: string,
    campaignId: string,
    dailyBudget: string,
    options?: ProviderCallOptions
  ): Promise<{ success: boolean; campaign: MetaCampaign }>;

  /** Set ad set daily budget. */
  updateAdSetBudget(
    accountId: string,
    adSetId: string,
    dailyBudget: string,
    options?: ProviderCallOptions
  ): Promise<{ success: boolean; adSet: MetaAdSet }>;
}

// ---------------------------------------------------------------------------
// MetaCampaignCreatorProvider — Campaign creation interface (Phase 9.3)
// ---------------------------------------------------------------------------
// Creates campaigns only. Does NOT create ads, ad sets, creatives, or targeting.
// All creation requires human approval.
// ---------------------------------------------------------------------------

export interface MetaCampaignCreatorProvider {
  /** Create a new campaign under the given ad account. */
  createCampaign(
    accountId: string,
    input: MetaCampaignInput,
    options?: ProviderCallOptions
  ): Promise<{ success: boolean; campaign: MetaCampaign }>;
}

// ---------------------------------------------------------------------------
// MetaAccountAuthorizer — Server-side account access control
// ---------------------------------------------------------------------------
// Determines which Meta accounts a user is authorized to access.
// Never trust client-provided account IDs.
// ---------------------------------------------------------------------------

export interface MetaAccountAuthorizer {
  /** Get the list of Meta account IDs the user is authorized to access. */
  getAuthorizedAccountIds(userId: string, options?: ProviderCallOptions): Promise<string[]>;

  /** Check if a user is authorized to access a specific Meta account. */
  isAuthorized(userId: string, accountId: string, options?: ProviderCallOptions): Promise<boolean>;
}
