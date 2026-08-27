import { calculateCanonicalKPIs } from "./kpi-engine.js";
import type {
  AggregationLevel,
  DataQualityStatus,
  MetricComparison,
  NormalizedPerformanceRecord,
  PerformanceSummary,
  PerformanceWindowType,
  PerformanceWindowComparison,
} from "./types/performance-aggregation.js";

// ---------------------------------------------------------------------------
// Performance Aggregator & Window Engine — Phase 11.2
// ---------------------------------------------------------------------------

/**
 * Safely compare two numeric values and calculate absolute and percentage deltas.
 * Guarantees NO `NaN` or `Infinity` is ever returned.
 */
export function calculateMetricComparison(
  current: number | null | undefined,
  previous: number | null | undefined
): MetricComparison<number> {
  const curr = current !== null && current !== undefined && Number.isFinite(current) ? current : null;
  const prev = previous !== null && previous !== undefined && Number.isFinite(previous) ? previous : null;

  if (curr === null || prev === null) {
    return {
      current: curr,
      previous: prev,
      changeAbsolute: null,
      changePercent: null,
    };
  }

  const changeAbsolute = Math.round((curr - prev) * 10000) / 10000;

  if (prev === 0) {
    if (curr === 0) {
      return {
        current: curr,
        previous: prev,
        changeAbsolute: 0,
        changePercent: 0,
      };
    }
    // Previous is 0 and current > 0: avoid division by zero (Infinity)
    return {
      current: curr,
      previous: prev,
      changeAbsolute,
      changePercent: null,
    };
  }

  const rawPercent = ((curr - prev) / Math.abs(prev)) * 100;
  const changePercent = Number.isFinite(rawPercent)
    ? Math.round(rawPercent * 100) / 100
    : null;

  return {
    current: curr,
    previous: prev,
    changeAbsolute,
    changePercent,
  };
}

/**
 * Format a Date object to YYYY-MM-DD in the target timezone.
 */
export function formatDateInTimezone(date: Date, timezoneName: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezoneName,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  } catch {
    // Fallback to UTC if timezone is invalid
    return date.toISOString().split("T")[0]!;
  }
}

/**
 * Calculate date window range (current and previous comparison period) in YYYY-MM-DD format.
 */
export function computeDateWindowRange(
  window: PerformanceWindowType,
  timezoneName = "UTC",
  customRange?: { start: string; end: string },
  referenceDate = new Date()
): {
  current: { startDate: string; endDate: string };
  previous: { startDate: string; endDate: string };
} {
  if (window === "custom" && customRange) {
    const currStart = new Date(customRange.start);
    const currEnd = new Date(customRange.end);
    const durationDays = Math.max(
      1,
      Math.round((currEnd.getTime() - currStart.getTime()) / (1000 * 60 * 60 * 24)) + 1
    );

    const prevEnd = new Date(currStart.getTime() - 1000 * 60 * 60 * 24);
    const prevStart = new Date(prevEnd.getTime() - 1000 * 60 * 60 * 24 * (durationDays - 1));

    return {
      current: { startDate: customRange.start, endDate: customRange.end },
      previous: {
        startDate: formatDateInTimezone(prevStart, timezoneName),
        endDate: formatDateInTimezone(prevEnd, timezoneName),
      },
    };
  }

  const todayStr = formatDateInTimezone(referenceDate, timezoneName);
  const ref = new Date(`${todayStr}T12:00:00Z`);

  function addDays(d: Date, days: number): string {
    const copy = new Date(d.getTime() + days * 86400000);
    return formatDateInTimezone(copy, timezoneName);
  }

  switch (window) {
    case "today":
      return {
        current: { startDate: todayStr, endDate: todayStr },
        previous: { startDate: addDays(ref, -1), endDate: addDays(ref, -1) },
      };

    case "yesterday": {
      const yest = addDays(ref, -1);
      return {
        current: { startDate: yest, endDate: yest },
        previous: { startDate: addDays(ref, -2), endDate: addDays(ref, -2) },
      };
    }

    case "last_7_days":
    case "previous_7_days":
      return {
        current: { startDate: addDays(ref, -7), endDate: addDays(ref, -1) },
        previous: { startDate: addDays(ref, -14), endDate: addDays(ref, -8) },
      };

    case "last_14_days":
    case "previous_14_days":
      return {
        current: { startDate: addDays(ref, -14), endDate: addDays(ref, -1) },
        previous: { startDate: addDays(ref, -28), endDate: addDays(ref, -15) },
      };

    case "last_30_days":
    case "previous_30_days":
    default:
      return {
        current: { startDate: addDays(ref, -30), endDate: addDays(ref, -1) },
        previous: { startDate: addDays(ref, -60), endDate: addDays(ref, -31) },
      };
  }
}

export interface AggregationOptions {
  accountId?: string;
  level: AggregationLevel;
  entityId: string;
  entityName?: string;
  windowType?: PerformanceWindowType;
  startDate?: string;
  endDate?: string;
  expectedRecordCount?: number;
  source?: string;
  allowEmpty?: boolean;
}

/**
 * Aggregate raw performance records deterministically.
 * 
 * CRITICAL RULE: Parent KPIs are computed by passing the summed raw counts
 * into `calculateCanonicalKPIs`. Parent KPIs are NEVER computed by averaging
 * child-level KPIs!
 */
export function aggregatePerformanceRecords(
  records: NormalizedPerformanceRecord[],
  options: AggregationOptions
): PerformanceSummary {
  const accountId = options.accountId ?? records[0]?.accountId;
  if (records.length === 0) {
    if (!options.allowEmpty) {
      // Empty set return null summary with UNAVAILABLE quality
    }
    const emptyKPIs = calculateCanonicalKPIs({
      spend: 0,
      impressions: 0,
      clicks: 0,
      reach: 0,
      conversions: 0,
      revenue: 0,
    });
    return {
      accountId,
      level: options.level,
      entityId: options.entityId,
      entityName: options.entityName,
      currency: "USD",
      timezone: "UTC",
      window: {
        type: options.windowType ?? "custom",
        startDate: options.startDate ?? "",
        endDate: options.endDate ?? "",
      },
      recordCount: 0,
      kpis: emptyKPIs,
      quality: "UNAVAILABLE",
      fetchedAt: new Date().toISOString(),
      source: options.source ?? "meta-graph",
    };
  }

  // Verify currency consistency
  const currencySet = new Set(records.map((r) => r.currency));
  if (currencySet.size > 1) {
    throw new Error(
      `CURRENCY_MISMATCH: Cannot aggregate records with different currencies [${Array.from(currencySet).join(", ")}]`
    );
  }

  const currency = Array.from(currencySet)[0]!;
  const timezone = records[0]?.timezone ?? "UTC";

  // Sum raw metrics across records
  let totalSpend = 0;
  let totalImpressions = 0;
  let totalClicks = 0;
  let totalReach = 0;
  let totalConversions = 0;
  let totalRevenue = 0;

  for (const r of records) {
    totalSpend += r.spend;
    totalImpressions += r.impressions;
    totalClicks += r.clicks;
    totalReach += r.reach;
    totalConversions += r.conversions;
    totalRevenue += r.revenue;
  }

  // Deterministically compute parent KPIs from summed raw counts
  const kpis = calculateCanonicalKPIs({
    spend: totalSpend,
    impressions: totalImpressions,
    clicks: totalClicks,
    reach: totalReach,
    conversions: totalConversions,
    revenue: totalRevenue,
  });

  let quality: DataQualityStatus = "COMPLETE";
  if (options.expectedRecordCount && records.length < options.expectedRecordCount) {
    quality = "PARTIAL";
  }

  // Derive date bounds from records if not explicitly passed
  let minDate = options.startDate ?? records[0]?.date ?? "";
  let maxDate = options.endDate ?? records[0]?.date ?? "";
  for (const r of records) {
    if (!minDate || r.date < minDate) minDate = r.date;
    if (!maxDate || r.date > maxDate) maxDate = r.date;
  }

  return {
    accountId,
    level: options.level,
    entityId: options.entityId,
    entityName: options.entityName ?? records[0]?.entityName,
    currency,
    timezone,
    window: {
      type: options.windowType ?? "custom",
      startDate: minDate,
      endDate: maxDate,
    },
    recordCount: records.length,
    kpis,
    quality,
    fetchedAt: new Date().toISOString(),
    source: options.source ?? "meta-graph",
  };
}
/**
 * Compare two PerformanceSummary objects and calculate absolute and percentage deltas for all KPIs.
 */
export function comparePerformanceSummaries(
  current: PerformanceSummary,
  previous: PerformanceSummary
): PerformanceWindowComparison {
  if (current.currency !== previous.currency) {
    throw new Error(
      `CURRENCY_MISMATCH: Cannot compare summaries with different currencies (${current.currency} vs ${previous.currency})`
    );
  }

  const cKPIs = current.kpis;
  const pKPIs = previous.kpis;

  let quality: DataQualityStatus = "COMPLETE";
  if (current.quality === "UNAVAILABLE" || previous.quality === "UNAVAILABLE") {
    quality = "UNAVAILABLE";
  } else if (current.quality === "PARTIAL" || previous.quality === "PARTIAL") {
    quality = "PARTIAL";
  }

  return {
    level: current.level,
    entityId: current.entityId,
    entityName: current.entityName,
    currency: current.currency,
    timezone: current.timezone,
    currentWindow: current.window,
    previousWindow: previous.window,
    currentSummary: current,
    previousSummary: previous,
    comparisons: {
      spend: calculateMetricComparison(cKPIs.spend, pKPIs.spend),
      impressions: calculateMetricComparison(cKPIs.impressions, pKPIs.impressions),
      clicks: calculateMetricComparison(cKPIs.clicks, pKPIs.clicks),
      reach: calculateMetricComparison(cKPIs.reach, pKPIs.reach),
      conversions: calculateMetricComparison(cKPIs.conversions, pKPIs.conversions),
      revenue: calculateMetricComparison(cKPIs.revenue, pKPIs.revenue),
      ctr: calculateMetricComparison(cKPIs.ctr, pKPIs.ctr),
      cpc: calculateMetricComparison(cKPIs.cpc, pKPIs.cpc),
      cpm: calculateMetricComparison(cKPIs.cpm, pKPIs.cpm),
      cpa: calculateMetricComparison(cKPIs.cpa, pKPIs.cpa),
      roas: calculateMetricComparison(cKPIs.roas, pKPIs.roas),
      cvr: calculateMetricComparison(cKPIs.cvr, pKPIs.cvr),
      frequency: calculateMetricComparison(cKPIs.frequency, pKPIs.frequency),
    },
    quality,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Exhaustive Pagination Consumer safeguard.
 * Loops through provider pages, detecting repeated cursors or infinite loops.
 */
export async function consumeAllPages<T>(
  fetchPage: (cursor?: string) => Promise<{ data: T[]; nextPage?: string }>,
  maxPages = 100
): Promise<{ data: T[]; totalPages: number; hasMore: boolean; quality: DataQualityStatus }> {
  const allData: T[] = [];
  const seenCursors = new Set<string>();
  let currentCursor: string | undefined = undefined;
  let pageCount = 0;
  let quality: DataQualityStatus = "COMPLETE";

  while (pageCount < maxPages) {
    pageCount++;
    try {
      const res = await fetchPage(currentCursor);
      allData.push(...res.data);

      if (!res.nextPage) {
        break; // Reached end of pagination cleanly
      }

      if (seenCursors.has(res.nextPage)) {
        // Repeated cursor detected: break to prevent infinite loop
        quality = "PARTIAL";
        break;
      }

      seenCursors.add(res.nextPage);
      currentCursor = res.nextPage;
    } catch {
      quality = "PARTIAL";
      break; // Abort cleanly on error, returning accumulated pages marked as PARTIAL
    }
  }

  if (pageCount >= maxPages && currentCursor) {
    quality = "PARTIAL";
  }

  return {
    data: allData,
    totalPages: pageCount,
    hasMore: Boolean(currentCursor && quality === "PARTIAL"),
    quality,
  };
}
