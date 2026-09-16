// ---------------------------------------------------------------------------
// R-32 — one place that turns raw provider insight rows into normalised
// performance records.
//
// This logic was written inline inside `OutcomeWorker.processDue`, where it
// filtered a whole account's daily rows down to one entity and one date range
// before aggregation. It is extracted here so the rule — which rows belong to
// this entity, in this window, with what numeric coercion — has a single
// owner and can be tested directly.
//
// NOTE on reuse: the outcome-CREATION path added in R-32 builds its baseline
// from the recommendation's own evidence snapshot and never fetches raw rows,
// so it does not call this. The worker is the only caller today.
// ---------------------------------------------------------------------------

import type { AggregationLevel } from "./types/performance-aggregation.js";
import type { NormalizedPerformanceRecord } from "./types/performance-aggregation.js";

export interface InsightRowSelection {
  /** Account the rows belong to. */
  accountId: string;
  /** Entity level being measured. ACCOUNT keeps every row in the account. */
  entityType: AggregationLevel;
  /** Entity whose rows are kept, when the level is narrower than ACCOUNT. */
  entityId: string;
  /** Inclusive window start, YYYY-MM-DD in the account's timezone. */
  startDate: string;
  /** Inclusive window end, YYYY-MM-DD in the account's timezone. */
  endDate: string;
  currency: string;
  timezone: string;
}

/**
 * Keep the rows for one entity inside one date window, in ascending date
 * order, coercing provider strings to numbers.
 *
 * Coercion matches the provider's own shape: everything arrives as a string,
 * and a missing value means zero for that day rather than an unknown — a day
 * the provider reported with no spend genuinely had no spend. That is NOT the
 * same as inventing a KPI for a metric the provider never reported at all.
 */
export function normalizeInsightRows(
  rawRows: ReadonlyArray<Record<string, unknown>>,
  selection: InsightRowSelection
): NormalizedPerformanceRecord[] {
  const { accountId, entityType, entityId, startDate, endDate, currency, timezone } = selection;

  return rawRows
    .filter((r) => {
      const rowDate = String(r.dateStart || r.dateStop || "");
      if (rowDate < startDate || rowDate > endDate) return false;

      if (entityType === "CAMPAIGN") return String(r.campaignId ?? "") === entityId;
      if (entityType === "AD_SET") return String(r.adsetId ?? "") === entityId;
      if (entityType === "AD") return String(r.adId ?? "") === entityId;
      return true; // ACCOUNT level includes all rows in account
    })
    .map((r) => ({
      accountId,
      campaignId: r.campaignId ? String(r.campaignId) : undefined,
      adSetId: r.adsetId ? String(r.adsetId) : undefined,
      adId: r.adId ? String(r.adId) : undefined,
      date: String(r.dateStart || r.dateStop || ""),
      spend: parseFloat(String(r.spend ?? "0")) || 0,
      impressions: parseInt(String(r.impressions ?? "0"), 10) || 0,
      clicks: parseInt(String(r.clicks ?? "0"), 10) || 0,
      reach: parseInt(String(r.reach ?? "0"), 10) || 0,
      conversions: parseFloat(String(r.conversions ?? "0")) || 0,
      revenue: (parseFloat(String(r.roas ?? "0")) || 0) * (parseFloat(String(r.spend ?? "0")) || 0),
      currency,
      timezone,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
