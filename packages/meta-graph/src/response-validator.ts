import type {
  MetaAdAccount,
  MetaCampaign,
  MetaAdSet,
  MetaAd,
  MetaInsights,
} from "@jarvis/core";
import {
  MetaAdAccountSchema,
  MetaCampaignSchema,
  MetaAdSetSchema,
  MetaAdSchema,
} from "@jarvis/core";

export function parseAdAccount(data: unknown): MetaAdAccount | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const mapped = {
    accountId: String(d.id ?? d.account_id ?? ""),
    name: String(d.name ?? ""),
    currency: String(d.currency ?? "USD"),
    timezoneName: d.timezone_name ? String(d.timezone_name) : undefined,
    accountStatus: typeof d.account_status === "number" ? d.account_status : undefined,
    spendCap: d.spend_cap ? String(d.spend_cap) : undefined,
    amountSpent: d.amount_spent ? String(d.amount_spent) : undefined,
    balance: d.balance ? String(d.balance) : undefined,
    businessName: d.business_name ? String(d.business_name) : undefined,
  };
  const result = MetaAdAccountSchema.safeParse(mapped);
  return result.success ? result.data : null;
}

export function parseCampaign(data: unknown): MetaCampaign | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const statusMap: Record<string, string> = {
    ACTIVE: "ACTIVE",
    PAUSED: "PAUSED",
    DELETED: "DELETED",
    ARCHIVED: "ARCHIVED",
    IN_PROCESS: "IN_PROCESS",
    WITH_ISSUES: "WITH_ISSUES",
  };
  const rawStatus = String(d.status ?? "ACTIVE").toUpperCase();
  const mapped = {
    campaignId: String(d.id ?? d.campaign_id ?? ""),
    name: String(d.name ?? ""),
    status: statusMap[rawStatus] ?? "ACTIVE",
    objective: d.objective ? String(d.objective) : undefined,
    dailyBudget: d.daily_budget ? String(d.daily_budget) : undefined,
    lifetimeBudget: d.lifetime_budget ? String(d.lifetime_budget) : undefined,
    startTime: d.start_time ? String(d.start_time) : undefined,
    endTime: d.end_time ? String(d.end_time) : undefined,
    bidStrategy: d.bid_strategy ? String(d.bid_strategy) : undefined,
    buyingType: d.buying_type ? String(d.buying_type) : undefined,
  };
  const result = MetaCampaignSchema.safeParse(mapped);
  return result.success ? result.data : null;
}

export function parseAdSet(data: unknown): MetaAdSet | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const statusMap: Record<string, string> = {
    ACTIVE: "ACTIVE", PAUSED: "PAUSED", DELETED: "DELETED",
    ARCHIVED: "ARCHIVED", IN_PROCESS: "IN_PROCESS", WITH_ISSUES: "WITH_ISSUES",
  };
  const rawStatus = String(d.status ?? "ACTIVE").toUpperCase();
  const mapped = {
    adSetId: String(d.id ?? d.adset_id ?? ""),
    campaignId: String(d.campaign_id ?? ""),
    name: String(d.name ?? ""),
    status: statusMap[rawStatus] ?? "ACTIVE",
    targeting: d.targeting && typeof d.targeting === "object" ? d.targeting as Record<string, unknown> : undefined,
    dailyBudget: d.daily_budget ? String(d.daily_budget) : undefined,
    lifetimeBudget: d.lifetime_budget ? String(d.lifetime_budget) : undefined,
    bidAmount: typeof d.bid_amount === "number" ? d.bid_amount : undefined,
    optimizationGoal: d.optimization_goal ? String(d.optimization_goal) : undefined,
    startTime: d.start_time ? String(d.start_time) : undefined,
    endTime: d.end_time ? String(d.end_time) : undefined,
  };
  const result = MetaAdSetSchema.safeParse(mapped);
  return result.success ? result.data : null;
}

export function parseAd(data: unknown): MetaAd | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const statusMap: Record<string, string> = {
    ACTIVE: "ACTIVE", PAUSED: "PAUSED", DELETED: "DELETED",
    ARCHIVED: "ARCHIVED", IN_PROCESS: "IN_PROCESS", WITH_ISSUES: "WITH_ISSUES",
  };
  const rawStatus = String(d.status ?? "ACTIVE").toUpperCase();
  const mapped = {
    adId: String(d.id ?? d.ad_id ?? ""),
    adSetId: String(d.adset_id ?? ""),
    campaignId: String(d.campaign_id ?? ""),
    name: String(d.name ?? ""),
    status: statusMap[rawStatus] ?? "ACTIVE",
    creative: d.creative && typeof d.creative === "object" ? d.creative as Record<string, unknown> : undefined,
  };
  const result = MetaAdSchema.safeParse(mapped);
  return result.success ? result.data : null;
}

export function parseInsights(data: unknown): MetaInsights | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  return {
    impressions: String(d.impressions ?? "0"),
    clicks: String(d.clicks ?? "0"),
    spend: String(d.spend ?? "0"),
    reach: String(d.reach ?? "0"),
    cpc: d.cpc ? String(d.cpc) : undefined,
    cpm: d.cpm ? String(d.cpm) : undefined,
    ctr: d.ctr ? String(d.ctr) : undefined,
    dateStart: d.date_start ? String(d.date_start) : undefined,
    dateStop: d.date_stop ? String(d.date_stop) : undefined,
  };
}

export interface MetaListResponse<T> {
  data: T[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
    previous?: string;
  };
}

export function extractNextPage<T>(response: MetaListResponse<T>): string | undefined {
  return response.paging?.next;
}
