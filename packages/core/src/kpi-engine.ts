/**
 * ---------------------------------------------------------------------------
 * Canonical KPI Engine — Phase 11.1
 * ---------------------------------------------------------------------------
 * Centralized, deterministic server-side mathematical calculations for Meta
 * Ads performance metrics.
 * 
 * Rules:
 * - 0 denominators return `null` and flag `isDefined[kpi] = false`.
 * - Negative inputs or invalid numeric strings default to 0.
 * - Standardized decimal rounding:
 *   - Currency (spend, cpc, cpm, cpa, revenue): 2 decimal places.
 *   - Rates & Ratios (ctr, cvr, roas): 4 decimal places.
 *   - Counts & Aggregates (impressions, clicks, reach): integers.
 *   - Frequency: 2 decimal places.
 * ---------------------------------------------------------------------------
 */

export interface RawMetricInputs {
  spend?: number | string | null;
  impressions?: number | string | null;
  clicks?: number | string | null;
  reach?: number | string | null;
  conversions?: number | string | null;
  revenue?: number | string | null;
}

export interface CalculatedKPIs {
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  conversions: number;
  revenue: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  roas: number | null;
  cvr: number | null;
  frequency: number | null;
  isDefined: {
    ctr: boolean;
    cpc: boolean;
    cpm: boolean;
    cpa: boolean;
    roas: boolean;
    cvr: boolean;
    frequency: boolean;
  };
}

export function parseNumericValue(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return Number.isFinite(val) && val >= 0 ? val : 0;
  if (typeof val === "string") {
    const parsed = parseFloat(val.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
}

export function calculateCanonicalKPIs(inputs: RawMetricInputs): CalculatedKPIs {
  const spend = parseNumericValue(inputs.spend);
  const impressions = parseNumericValue(inputs.impressions);
  const clicks = parseNumericValue(inputs.clicks);
  const reach = parseNumericValue(inputs.reach);
  const conversions = parseNumericValue(inputs.conversions);
  const revenue = parseNumericValue(inputs.revenue);

  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const cpc = clicks > 0 ? spend / clicks : null;
  const cpm = impressions > 0 ? (spend / impressions) * 1000 : null;
  const cpa = conversions > 0 ? spend / conversions : null;
  const roas = spend > 0 ? revenue / spend : null;
  const cvr = clicks > 0 ? (conversions / clicks) * 100 : null;
  const frequency = reach > 0 ? impressions / reach : null;

  return {
    spend: Math.round(spend * 100) / 100,
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    reach: Math.round(reach),
    conversions: Math.round(conversions * 100) / 100,
    revenue: Math.round(revenue * 100) / 100,
    ctr: ctr !== null ? Math.round(ctr * 10000) / 10000 : null,
    cpc: cpc !== null ? Math.round(cpc * 100) / 100 : null,
    cpm: cpm !== null ? Math.round(cpm * 100) / 100 : null,
    cpa: cpa !== null ? Math.round(cpa * 100) / 100 : null,
    roas: roas !== null ? Math.round(roas * 10000) / 10000 : null,
    cvr: cvr !== null ? Math.round(cvr * 10000) / 10000 : null,
    frequency: frequency !== null ? Math.round(frequency * 100) / 100 : null,
    isDefined: {
      ctr: ctr !== null,
      cpc: cpc !== null,
      cpm: cpm !== null,
      cpa: cpa !== null,
      roas: roas !== null,
      cvr: cvr !== null,
      frequency: frequency !== null,
    },
  };
}

// ---------------------------------------------------------------------------
// R-32 — evidence-based baseline for outcome creation
// ---------------------------------------------------------------------------
// Turns a recommendation's own `evidence.currentMetrics` snapshot (a loose
// record of `number | null`) into the `CalculatedKPIs` the outcome baseline
// needs. Deliberately NOT `calculateCanonicalKPIs`: it never coerces a missing
// counter to zero. A day with no spend is zero; a recommendation whose
// evidence lacks spend at all is NOT an opportunity to fabricate a baseline.
// The required counters must be present and finite or the whole baseline is
// refused (null) — the caller then skips outcome creation. Derived KPIs simply
// pass through whatever the evidence says, null included, because
// `BaselineKPIValues` already allows them to be null.
// ---------------------------------------------------------------------------

const REQUIRED_BASELINE_COUNTERS = [
  "spend",
  "impressions",
  "clicks",
  "reach",
  "conversions",
  "revenue",
] as const;

const DERIVED_BASELINE_KPIS = [
  "ctr",
  "cpc",
  "cpm",
  "cpa",
  "roas",
  "cvr",
  "frequency",
] as const;

export function baselineKpisFromEvidence(
  currentMetrics: Readonly<Record<string, number | null> | undefined>
): CalculatedKPIs | null {
  if (!currentMetrics) return null;

  const required: Record<string, number> = {};
  for (const key of REQUIRED_BASELINE_COUNTERS) {
    const value = currentMetrics[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    required[key] = value;
  }

  const derivedValue = (key: (typeof DERIVED_BASELINE_KPIS)[number]): number | null => {
    const value = currentMetrics[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  };

  return {
    spend: required["spend"],
    impressions: required["impressions"],
    clicks: required["clicks"],
    reach: required["reach"],
    conversions: required["conversions"],
    revenue: required["revenue"],
    ctr: derivedValue("ctr"),
    cpc: derivedValue("cpc"),
    cpm: derivedValue("cpm"),
    cpa: derivedValue("cpa"),
    roas: derivedValue("roas"),
    cvr: derivedValue("cvr"),
    frequency: derivedValue("frequency"),
    isDefined: {
      ctr: derivedValue("ctr") !== null,
      cpc: derivedValue("cpc") !== null,
      cpm: derivedValue("cpm") !== null,
      cpa: derivedValue("cpa") !== null,
      roas: derivedValue("roas") !== null,
      cvr: derivedValue("cvr") !== null,
      frequency: derivedValue("frequency") !== null,
    },
  };
}
