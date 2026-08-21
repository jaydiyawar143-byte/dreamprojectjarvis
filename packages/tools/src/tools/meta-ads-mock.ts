import type { MetaAdsProvider, MetaAdsWriteProvider, MetaAdsBudgetProvider, MetaCampaignCreatorProvider } from "./meta-ads-provider.js";
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

export interface MockMetaProviderConfig {
  accounts?: MetaAdAccount[];
  campaigns?: MetaCampaign[];
  adSets?: MetaAdSet[];
  ads?: MetaAd[];
  insights?: MetaInsights[];
  throwOnCall?: string;
  delayMs?: number;
}

const DEFAULT_ACCOUNTS: MetaAdAccount[] = [
  {
    accountId: "act_111111111",
    name: "Test Account 1",
    currency: "USD",
    timezoneName: "America/New_York",
    accountStatus: 1,
    amountSpent: "5000.00",
    balance: "0",
  },
  {
    accountId: "act_222222222",
    name: "Test Account 2",
    currency: "EUR",
    timezoneName: "Europe/London",
    accountStatus: 1,
    amountSpent: "12000.00",
    balance: "100.00",
  },
];

const DEFAULT_CAMPAIGNS: MetaCampaign[] = [
  {
    campaignId: "100000001",
    name: "Brand Awareness Q1",
    status: "ACTIVE",
    objective: "BRAND_AWARENESS",
    dailyBudget: "100.00",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    buyingType: "AUCTION",
  },
  {
    campaignId: "100000002",
    name: "Conversions Spring Sale",
    status: "ACTIVE",
    objective: "CONVERSIONS",
    lifetimeBudget: "5000.00",
    startTime: "2025-03-01T00:00:00+0000",
    endTime: "2025-03-31T23:59:59+0000",
  },
  {
    campaignId: "100000003",
    name: "Retargeting - Paused",
    status: "PAUSED",
    objective: "TRAFFIC",
    dailyBudget: "50.00",
  },
];

const DEFAULT_ADSETS: MetaAdSet[] = [
  {
    adSetId: "200000001",
    campaignId: "100000001",
    name: "US Adults 25-54",
    status: "ACTIVE",
    dailyBudget: "50.00",
    optimizationGoal: "REACH",
    bidAmount: 500,
  },
  {
    adSetId: "200000002",
    campaignId: "100000001",
    name: "UK Young Adults",
    status: "ACTIVE",
    dailyBudget: "30.00",
    optimizationGoal: "IMPRESSIONS",
  },
  {
    adSetId: "200000003",
    campaignId: "100000002",
    name: "Website Purchasers",
    status: "ACTIVE",
    lifetimeBudget: "2500.00",
    optimizationGoal: "OFFSITE_CONVERSIONS",
  },
];

const DEFAULT_ADS: MetaAd[] = [
  {
    adId: "300000001",
    adSetId: "200000001",
    campaignId: "100000001",
    name: "Video Ad - Product Demo",
    status: "ACTIVE",
    creative: { id: "400000001", name: "Product Demo Video" },
  },
  {
    adId: "300000002",
    adSetId: "200000001",
    campaignId: "100000001",
    name: "Carousel Ad - Collection",
    status: "ACTIVE",
    creative: { id: "400000002", name: "Collection Carousel" },
  },
  {
    adId: "300000003",
    adSetId: "200000003",
    campaignId: "100000002",
    name: "Dynamic Product Ad",
    status: "ACTIVE",
  },
];

const DEFAULT_INSIGHTS: MetaInsights[] = [
  {
    impressions: "150000",
    reach: "80000",
    clicks: "3500",
    spend: "1250.75",
    ctr: "2.33",
    cpc: "0.36",
    cpm: "8.34",
    frequency: "1.88",
    conversions: "120",
    costPerConversion: "10.42",
    roas: "4.2",
    dateStart: "2025-03-01",
    dateStop: "2025-03-07",
    accountId: "act_111111111",
  },
  {
    impressions: "95000",
    reach: "55000",
    clicks: "2100",
    spend: "800.50",
    ctr: "2.21",
    cpc: "0.38",
    cpm: "8.43",
    frequency: "1.73",
    conversions: "75",
    costPerConversion: "10.67",
    roas: "3.8",
    dateStart: "2025-03-01",
    dateStop: "2025-03-07",
    campaignId: "100000001",
  },
];

type FullProvider = MetaAdsProvider & MetaAdsWriteProvider & MetaAdsBudgetProvider & MetaCampaignCreatorProvider;

export function createMockMetaProvider(config: MockMetaProviderConfig = {}): FullProvider {
  const accounts = config.accounts ?? DEFAULT_ACCOUNTS;
  const campaigns = (config.campaigns ?? DEFAULT_CAMPAIGNS).map(c => ({ ...c }));
  const adSets = (config.adSets ?? DEFAULT_ADSETS).map(a => ({ ...a }));
  const ads = (config.ads ?? DEFAULT_ADS).map(a => ({ ...a }));
  const insights = config.insights ?? DEFAULT_INSIGHTS;
  const throwOnCall = config.throwOnCall;
  const delayMs = config.delayMs ?? 0;

  // Created resources get IDs in a range disjoint from the seeded fixtures,
  // deterministically (independent of how many campaigns were seeded).
  let createdCampaigns = 0;

  const delay = () =>
    delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();

  return {
    getAdAccounts: async (pagination?: MetaPagination) => {
      await delay();
      if (throwOnCall === "getAdAccounts") throw new Error("Meta API unavailable");
      const limit = pagination?.limit ?? 50;
      const data = accounts.slice(0, limit);
      return { data, nextPage: accounts.length > limit ? "cursor_next" : undefined };
    },

    getCampaigns: async (_accountId: string, pagination?: MetaPagination) => {
      await delay();
      if (throwOnCall === "getCampaigns") throw new Error("Meta API unavailable");
      const limit = pagination?.limit ?? 50;
      const data = campaigns.slice(0, limit);
      return { data, nextPage: campaigns.length > limit ? "cursor_next" : undefined };
    },

    getAdSets: async (_accountId: string, campaignId?: string, pagination?: MetaPagination) => {
      await delay();
      if (throwOnCall === "getAdSets") throw new Error("Meta API unavailable");
      let filtered = adSets;
      if (campaignId) {
        filtered = filtered.filter((a) => a.campaignId === campaignId);
      }
      const limit = pagination?.limit ?? 50;
      const data = filtered.slice(0, limit);
      return { data, nextPage: filtered.length > limit ? "cursor_next" : undefined };
    },

    getAds: async (_accountId: string, campaignId?: string, adSetId?: string, pagination?: MetaPagination) => {
      await delay();
      if (throwOnCall === "getAds") throw new Error("Meta API unavailable");
      let filtered = ads;
      if (campaignId) filtered = filtered.filter((a) => a.campaignId === campaignId);
      if (adSetId) filtered = filtered.filter((a) => a.adSetId === adSetId);
      const limit = pagination?.limit ?? 50;
      const data = filtered.slice(0, limit);
      return { data, nextPage: filtered.length > limit ? "cursor_next" : undefined };
    },

    getInsights: async (
      _accountId: string,
      _dateRange: MetaDateRange,
      _level: string,
      filters?: { campaignIds?: string[]; fields?: string[]; breakdown?: string },
      pagination?: MetaPagination
    ) => {
      await delay();
      if (throwOnCall === "getInsights") throw new Error("Meta API unavailable");
      let filtered = insights;
      if (filters?.campaignIds && filters.campaignIds.length > 0) {
        filtered = filtered.filter(
          (i) => i.campaignId && filters.campaignIds!.includes(i.campaignId)
        );
      }
      const limit = pagination?.limit ?? 50;
      const data = filtered.slice(0, limit);
      return { data, nextPage: filtered.length > limit ? "cursor_next" : undefined };
    },

    // --- Write methods (Phase 9.1) ---

    updateCampaignStatus: async (_accountId: string, campaignId: string, status: "ACTIVE" | "PAUSED") => {
      await delay();
      if (throwOnCall === "updateCampaignStatus") throw new Error("Meta API unavailable");
      const campaign = campaigns.find((c) => c.campaignId === campaignId);
      if (!campaign) return { success: false, campaign: {} as MetaCampaign };
      campaign.status = status;
      return { success: true, campaign: { ...campaign } };
    },

    updateAdSetStatus: async (_accountId: string, adSetId: string, status: "ACTIVE" | "PAUSED") => {
      await delay();
      if (throwOnCall === "updateAdSetStatus") throw new Error("Meta API unavailable");
      const adSet = adSets.find((a) => a.adSetId === adSetId);
      if (!adSet) return { success: false, adSet: {} as MetaAdSet };
      adSet.status = status;
      return { success: true, adSet: { ...adSet } };
    },

    updateAdStatus: async (_accountId: string, adId: string, status: "ACTIVE" | "PAUSED") => {
      await delay();
      if (throwOnCall === "updateAdStatus") throw new Error("Meta API unavailable");
      const ad = ads.find((a) => a.adId === adId);
      if (!ad) return { success: false, ad: {} as MetaAd };
      ad.status = status;
      return { success: true, ad: { ...ad } };
    },

    // --- Budget write methods (Phase 9.2) ---

    updateCampaignBudget: async (_accountId: string, campaignId: string, dailyBudget: string) => {
      await delay();
      if (throwOnCall === "updateCampaignBudget") throw new Error("Meta API unavailable");
      const campaign = campaigns.find((c) => c.campaignId === campaignId);
      if (!campaign) return { success: false, campaign: {} as MetaCampaign };
      campaign.dailyBudget = dailyBudget;
      return { success: true, campaign: { ...campaign } };
    },

    updateAdSetBudget: async (_accountId: string, adSetId: string, dailyBudget: string) => {
      await delay();
      if (throwOnCall === "updateAdSetBudget") throw new Error("Meta API unavailable");
      const adSet = adSets.find((a) => a.adSetId === adSetId);
      if (!adSet) return { success: false, adSet: {} as MetaAdSet };
      adSet.dailyBudget = dailyBudget;
      return { success: true, adSet: { ...adSet } };
    },

    // --- Campaign creation (Phase 9.3) ---

    createCampaign: async (_accountId: string, input: MetaCampaignInput) => {
      await delay();
      if (throwOnCall === "createCampaign") throw new Error("Meta API unavailable");
      const newId = String(100000010 + createdCampaigns++);
      const campaign: MetaCampaign = {
        campaignId: newId,
        name: input.name,
        status: input.status,
        objective: input.objective,
        dailyBudget: input.dailyBudget,
        lifetimeBudget: input.lifetimeBudget,
        buyingType: input.buyingType,
        bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      };
      campaigns.push(campaign);
      return { success: true, campaign: { ...campaign } };
    },
  };
}

export function createFailingMetaProvider(errorMessage = "Meta API unavailable"): FullProvider {
  const fail = async () => {
    throw new Error(errorMessage);
  };
  return {
    getAdAccounts: fail,
    getCampaigns: fail,
    getAdSets: fail,
    getAds: fail,
    getInsights: fail,
    updateCampaignStatus: fail as MetaAdsWriteProvider["updateCampaignStatus"],
    updateAdSetStatus: fail as MetaAdsWriteProvider["updateAdSetStatus"],
    updateAdStatus: fail as MetaAdsWriteProvider["updateAdStatus"],
    updateCampaignBudget: fail as MetaAdsBudgetProvider["updateCampaignBudget"],
    updateAdSetBudget: fail as MetaAdsBudgetProvider["updateAdSetBudget"],
    createCampaign: fail as MetaCampaignCreatorProvider["createCampaign"],
  };
}

export function createEmptyMetaProvider(): FullProvider {
  const empty = async () => ({ data: [], nextPage: undefined });
  return {
    getAdAccounts: empty,
    getCampaigns: empty,
    getAdSets: empty,
    getAds: empty,
    getInsights: empty,
    updateCampaignStatus: async (_accountId: string, _campaignId: string, _status: "ACTIVE" | "PAUSED") => ({
      success: false,
      campaign: {} as MetaCampaign,
    }),
    updateAdSetStatus: async (_accountId: string, _adSetId: string, _status: "ACTIVE" | "PAUSED") => ({
      success: false,
      adSet: {} as MetaAdSet,
    }),
    updateAdStatus: async (_accountId: string, _adId: string, _status: "ACTIVE" | "PAUSED") => ({
      success: false,
      ad: {} as MetaAd,
    }),
    updateCampaignBudget: async (_accountId: string, _campaignId: string, _dailyBudget: string) => ({
      success: false,
      campaign: {} as MetaCampaign,
    }),
    updateAdSetBudget: async (_accountId: string, _adSetId: string, _dailyBudget: string) => ({
      success: false,
      adSet: {} as MetaAdSet,
    }),
    createCampaign: async (_accountId: string, _input: MetaCampaignInput) => ({
      success: false,
      campaign: {} as MetaCampaign,
    }),
  };
}
