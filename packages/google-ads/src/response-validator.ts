import { z } from "zod";
import type {
  GoogleAdsCustomer,
  GoogleAdsCampaign,
  GoogleAdsCampaignStatus,
  GoogleAdsMetrics,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// Google Ads response parsing (Sprint 5.2)
// ---------------------------------------------------------------------------
// Mirrors packages/meta-graph/src/response-validator.ts. Two Google-specific
// hazards are handled here so no caller has to:
//
//   1. MICROS. Google reports money as integers of 1/1,000,000 currency units.
//      A cost of 12.34 arrives as 12340000. Treating that as a currency value
//      overstates spend by a factor of a million, so every monetary field is
//      converted exactly once, here, and leaves as a decimal string.
//
//   2. Numbers as strings. int64 fields are JSON strings ("1234"), because the
//      values can exceed IEEE-754 integer precision. Parsing is explicit.
// ---------------------------------------------------------------------------

const MICROS_PER_UNIT = 1_000_000;

/** Converts Google micros to a fixed-2 decimal string in the account currency. */
export function microsToDecimal(micros: string | number | undefined | null): string {
  if (micros === undefined || micros === null || micros === "") return "0.00";
  const raw = typeof micros === "string" ? Number(micros) : micros;
  if (!Number.isFinite(raw)) return "0.00";
  return (raw / MICROS_PER_UNIT).toFixed(2);
}

/** int64-as-string to number, defaulting to 0 rather than NaN. */
function toNumber(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : 0;
}

const customerSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  resourceName: z.string().optional(),
  descriptiveName: z.string().nullish(),
  currencyCode: z.string().nullish(),
  timeZone: z.string().nullish(),
  manager: z.boolean().nullish(),
  testAccount: z.boolean().nullish(),
});

export function parseCustomer(raw: unknown): GoogleAdsCustomer {
  const parsed = customerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Malformed Google Ads customer payload");
  }
  const c = parsed.data;
  // Prefer the explicit id; fall back to the tail of "customers/1234567890".
  const id = c.id !== undefined ? String(c.id) : (c.resourceName?.split("/").pop() ?? "");
  return {
    customerId: id,
    descriptiveName: c.descriptiveName ?? "",
    currencyCode: c.currencyCode ?? "USD",
    timeZone: c.timeZone ?? "UTC",
    isManager: c.manager ?? false,
    isTestAccount: c.testAccount ?? false,
  };
}

const VALID_STATUSES: readonly GoogleAdsCampaignStatus[] = ["ENABLED", "PAUSED", "REMOVED"];

function toStatus(value: unknown): GoogleAdsCampaignStatus {
  return VALID_STATUSES.includes(value as GoogleAdsCampaignStatus)
    ? (value as GoogleAdsCampaignStatus)
    : "UNKNOWN";
}

export function parseCampaign(row: unknown): GoogleAdsCampaign {
  const r = (row ?? {}) as Record<string, any>;
  const campaign = r.campaign ?? {};
  const budget = r.campaignBudget ?? {};
  return {
    campaignId: campaign.id !== undefined ? String(campaign.id) : "",
    name: campaign.name ?? "",
    status: toStatus(campaign.status),
    advertisingChannelType: campaign.advertisingChannelType ?? "UNSPECIFIED",
    startDate: campaign.startDate ?? undefined,
    endDate: campaign.endDate ?? undefined,
    budgetAmount:
      budget.amountMicros !== undefined ? microsToDecimal(budget.amountMicros) : undefined,
  };
}

export function parseMetrics(row: unknown): GoogleAdsMetrics {
  const r = (row ?? {}) as Record<string, any>;
  const m = r.metrics ?? {};
  const campaign = r.campaign ?? {};
  const segments = r.segments ?? {};

  const impressions = toNumber(m.impressions);
  const clicks = toNumber(m.clicks);

  return {
    campaignId: campaign.id !== undefined ? String(campaign.id) : undefined,
    campaignName: campaign.name ?? undefined,
    date: segments.date ?? undefined,
    impressions,
    clicks,
    cost: microsToDecimal(m.costMicros),
    conversions: toNumber(m.conversions),
    conversionValue: toNumber(m.conversionsValue).toFixed(2),
    // Google supplies ctr as a ratio; derive it when absent so a caller never
    // has to divide by a possibly-zero impression count itself.
    ctr: m.ctr !== undefined ? toNumber(m.ctr) : impressions > 0 ? clicks / impressions : 0,
    averageCpc: m.averageCpc !== undefined ? microsToDecimal(m.averageCpc) : undefined,
  };
}

/**
 * googleAds:search returns { results: [...] }; searchStream returns an array of
 * such chunks. Both shapes are accepted so the caller need not care.
 */
export function extractRows(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body.flatMap((chunk) => extractRows(chunk));
  }
  if (body && typeof body === "object" && Array.isArray((body as { results?: unknown[] }).results)) {
    return (body as { results: unknown[] }).results;
  }
  return [];
}

export function extractNextPageToken(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const token = (body as { nextPageToken?: unknown }).nextPageToken;
    if (typeof token === "string" && token.length > 0) return token;
  }
  return undefined;
}
