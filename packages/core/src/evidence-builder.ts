import type {
  MetricComparison,
  PerformanceWindowComparison,
} from "./types/performance-aggregation.js";
import type { MarketingAnomaly } from "./types/anomaly-detection.js";
import {
  DIAGNOSIS_SCHEMA_VERSION,
  EvidencePackageSchema,
  type DateRange,
  type EvidencePackage,
  type Freshness,
  type MetricFact,
  type MetricUnit,
  type RelevantContext,
} from "./types/diagnosis.js";
import { computeParamsHash } from "./utils/params-hash.js";

// ---------------------------------------------------------------------------
// Deterministic Evidence Builder — Phase 11.4
// ---------------------------------------------------------------------------
// The AI NEVER decides which facts are true. This module deterministically
// converts verified Phase 11.2 comparisons + Phase 11.3 anomalies into a
// schema-valid EvidencePackage with a deterministic evidenceHash.
//
// Same account + entity + metrics + anomalies + window ⇒ same evidenceHash.
// ---------------------------------------------------------------------------

export const DEFAULT_METRIC_SOURCE = "META_INSIGHTS";

const METRIC_UNITS: Record<string, MetricUnit> = {
  spend: "CURRENCY",
  cpc: "CURRENCY",
  cpm: "CURRENCY",
  cpa: "CURRENCY",
  revenue: "CURRENCY",
  impressions: "COUNT",
  clicks: "COUNT",
  reach: "COUNT",
  conversions: "COUNT",
  ctr: "PERCENT",
  cvr: "PERCENT",
  roas: "RATIO",
  frequency: "RATIO",
};

const METRIC_ORDER = [
  "spend", "impressions", "clicks", "reach", "conversions", "revenue",
  "ctr", "cpc", "cpm", "cpa", "roas", "cvr", "frequency",
] as const;

// --- Untrusted-text sanitization -------------------------------------------

/** Markers used to fence untrusted data in prompts must never be forgeable. */
const FORGEABLE_MARKERS = [
  /<<<|\.{3,}/g,
  /EVIDENCE_(?:BEGIN|END)/gi,
  /UNTRUSTED_MARKETING_TEXT_(?:BEGIN|END)/gi,
  /DATA_(?:BEGIN|END)/gi,
];

/**
 * Neutralize control characters and prompt-fence escape attempts, and cap
 * length. Applied to ALL attacker-controlled marketing text before it can
 * reach an EvidencePackage or a prompt.
 */
export function sanitizeUntrustedText(text: string, maxLength = 300): string {
  let out = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/`{3,}/g, "'''");
  for (const marker of FORGEABLE_MARKERS) {
    out = out.replace(marker, "[filtered]");
  }
  return out.slice(0, maxLength);
}

function sanitizeLabels(
  labels?: Array<{ key: string; value: string }>
): RelevantContext["labels"] {
  if (!labels || labels.length === 0) return [];
  return labels.slice(0, 20).map((l) => ({
    key: sanitizeUntrustedText(l.key, 64),
    value: sanitizeUntrustedText(l.value, 500),
  }));
}

// --- Builder ----------------------------------------------------------------

export interface EvidenceBuilderInput {
  accountId: string;
  /** Verified window comparison from the Phase 11.2 aggregator. */
  comparison: PerformanceWindowComparison;
  /** Verified anomalies from the Phase 11.3 engine (same entity/window). */
  anomalies: MarketingAnomaly[];
  objective?: string;
  campaignLifecycleState?: string;
  freshnessOverride?: Freshness;
  sourceLabel?: string;
  /**
   * UNTRUSTED marketing text (names, creative previews). Sanitized before
   * storage and fenced as DATA in prompts — never instructions.
   */
  untrustedTexts?: Array<{ key: string; value: string }>;
  builtAt?: Date;
}

function metricFactsFromComparison(
  comparison: PerformanceWindowComparison,
  sourceLabel: string
): { details: MetricFact[]; current: Record<string, number | null>; previous: Record<string, number | null> } {
  const details: MetricFact[] = [];
  const current: Record<string, number | null> = {};
  const previous: Record<string, number | null> = {};

  const comparisons = comparison.comparisons as unknown as Record<string, MetricComparison<number>>;
  const window: DateRange = {
    startDate: comparison.currentWindow.startDate,
    endDate: comparison.currentWindow.endDate,
  };

  for (const key of METRIC_ORDER) {
    const cmp: MetricComparison<number> | undefined = comparisons[key];
    if (!cmp) continue;
    const unit = METRIC_UNITS[key] ?? "COUNT";
    current[key] = cmp.current ?? null;
    previous[key] = cmp.previous ?? null;
    details.push({
      metric: key,
      current: cmp.current ?? null,
      previous: cmp.previous ?? null,
      changeAbsolute: cmp.changeAbsolute ?? null,
      changePercent: cmp.changePercent ?? null,
      unit,
      window,
      provenance: { source: sourceLabel, aggregationLevel: comparison.level },
    });
  }
  return { details, current, previous };
}

/**
 * Canonical hash input excludes volatile timestamps (builtAt, detectedAt)
 * so identical evidence content always yields an identical hash.
 */
function canonicalHashInput(pkg: Omit<EvidencePackage, "evidenceHash" | "builtAt">): Record<string, unknown> {
  return {
    schemaVersion: pkg.schemaVersion,
    accountId: pkg.accountId,
    entityLevel: pkg.entityLevel,
    entityId: pkg.entityId,
    currency: pkg.currency,
    timezone: pkg.timezone,
    performanceWindow: pkg.performanceWindow,
    comparisonWindow: pkg.comparisonWindow ?? null,
    currentMetrics: pkg.currentMetrics,
    previousMetrics: pkg.previousMetrics ?? null,
    metricDetails: pkg.metricDetails,
    anomalies: pkg.anomalies.map((a) => ({ ...a, detectedAt: undefined })),
    dataQuality: pkg.dataQuality,
    freshness: pkg.freshness,
    campaignLifecycleState: pkg.campaignLifecycleState ?? null,
    relevantContext: pkg.relevantContext,
  };
}

export function computeEvidenceHash(stable: Omit<EvidencePackage, "evidenceHash" | "builtAt">): string {
  return computeParamsHash(canonicalHashInput(stable));
}

export function buildEvidencePackage(input: EvidenceBuilderInput): EvidencePackage {
  const { comparison } = input;
  const sourceLabel = input.sourceLabel ?? DEFAULT_METRIC_SOURCE;
  const { details, current, previous } = metricFactsFromComparison(comparison, sourceLabel);

  const stable: Omit<EvidencePackage, "evidenceHash" | "builtAt"> = {
    schemaVersion: DIAGNOSIS_SCHEMA_VERSION,
    accountId: input.accountId,
    entityLevel: comparison.level,
    entityId: comparison.entityId,
    entityName: comparison.entityName
      ? sanitizeUntrustedText(comparison.entityName, 200)
      : undefined,
    objective: input.objective ? sanitizeUntrustedText(input.objective, 64) : undefined,
    currency: comparison.currency,
    timezone: comparison.timezone,
    performanceWindow: {
      startDate: comparison.currentWindow.startDate,
      endDate: comparison.currentWindow.endDate,
    },
    comparisonWindow: {
      startDate: comparison.previousWindow.startDate,
      endDate: comparison.previousWindow.endDate,
    },
    currentMetrics: current,
    previousMetrics: previous,
    metricDetails: details,
    anomalies: input.anomalies.map((a) => ({
      ...a,
      entityName: a.entityName ? sanitizeUntrustedText(a.entityName, 200) : undefined,
    })),
    dataQuality: comparison.quality,
    freshness: input.freshnessOverride ?? "FRESH",
    campaignLifecycleState: input.campaignLifecycleState
      ? sanitizeUntrustedText(input.campaignLifecycleState, 32)
      : undefined,
    relevantContext: {
      labels: sanitizeLabels(input.untrustedTexts),
      notes: [],
    },
  };

  return {
    ...stable,
    evidenceHash: computeEvidenceHash(stable),
    builtAt: (input.builtAt ?? new Date()).toISOString(),
  };
}

/** Re-validate any (possibly deserialized) package against the strict schema. */
export function validateEvidencePackage(pkg: unknown): EvidencePackage {
  return EvidencePackageSchema.parse(pkg);
}

// ---------------------------------------------------------------------------
// Evidence reference grammar + resolution
// ---------------------------------------------------------------------------
//   anomaly:<anomalyId>
//   metric:<metric>:<current|previous|change_percent|change_absolute>
//   meta:<account|entity|window_performance|window_comparison|data_quality|
//         freshness|lifecycle|currency|timezone>
// ---------------------------------------------------------------------------

const META_REF_FIELDS = new Set([
  "account", "entity", "window_performance", "window_comparison",
  "data_quality", "freshness", "lifecycle", "currency", "timezone",
]);

export interface ResolvedEvidenceRef {
  kind: "anomaly" | "metric" | "meta" | "none";
  metricField?: "current" | "previous" | "change_percent" | "change_absolute";
  metric?: string;
  anomalyId?: string;
  value?: number | string | null;
}

export function resolveEvidenceRef(
  pkg: EvidencePackage,
  ref: string
): ResolvedEvidenceRef {
  if (ref.startsWith("anomaly:")) {
    const id = ref.slice("anomaly:".length);
    const anomaly = pkg.anomalies.find((a) => a.anomalyId === id);
    return anomaly
      ? { kind: "anomaly", anomalyId: id, value: anomaly.percentDeviation }
      : { kind: "none" };
  }

  if (ref.startsWith("metric:")) {
    const rest = ref.slice("metric:".length);
    const idx = rest.lastIndexOf(":");
    if (idx === -1) return { kind: "none" };
    const metric = rest.slice(0, idx);
    const field = rest.slice(idx + 1);
    if (!["current", "previous", "change_percent", "change_absolute"].includes(field)) {
      return { kind: "none" };
    }
    const detail = pkg.metricDetails.find((d) => d.metric === metric);
    if (!detail) return { kind: "none" };
    const value =
      field === "current" ? detail.current
      : field === "previous" ? detail.previous
      : field === "change_percent" ? detail.changePercent
      : detail.changeAbsolute;
    return { kind: "metric", metric, metricField: field as ResolvedEvidenceRef["metricField"], value };
  }

  if (ref.startsWith("meta:")) {
    const field = ref.slice("meta:".length);
    if (!META_REF_FIELDS.has(field)) return { kind: "none" };
    const value =
      field === "account" ? pkg.accountId
      : field === "entity" ? pkg.entityId
      : field === "window_performance" ? `${pkg.performanceWindow.startDate}..${pkg.performanceWindow.endDate}`
      : field === "window_comparison" ? (pkg.comparisonWindow ? `${pkg.comparisonWindow.startDate}..${pkg.comparisonWindow.endDate}` : null)
      : field === "data_quality" ? pkg.dataQuality
      : field === "freshness" ? pkg.freshness
      : field === "lifecycle" ? (pkg.campaignLifecycleState ?? null)
      : field === "currency" ? pkg.currency
      : pkg.timezone;
    return { kind: "meta", value };
  }

  return { kind: "none" };
}

export function evidenceRefExists(pkg: EvidencePackage, ref: string): boolean {
  return resolveEvidenceRef(pkg, ref).kind !== "none";
}

// ---------------------------------------------------------------------------
// Deterministic evidence compression (context budget)
// ---------------------------------------------------------------------------
// Priority order when over budget:
//   1. keep anomalies (strongest first: CRITICAL > WARNING, larger deviation)
//   2. keep current vs previous metric records
//   3. trim untrusted context text
//   4. drop non-anomalous metricDetails
//   5. drop previousMetrics record (details retain previous values)
// Never mid-JSON truncation — output is re-parsed against the strict schema.
// Compression affects ONLY what is sent to the model; verification always
// runs against the ORIGINAL uncompressed package.
// ---------------------------------------------------------------------------

export interface CompressionResult {
  pkg: EvidencePackage;
  compressed: boolean;
  originalChars: number;
  finalChars: number;
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 2, WARNING: 1, NORMAL: 0 };

function rankAnomaly(a: MarketingAnomaly): number {
  return (
    SEVERITY_RANK[a.severity] * 1_000_000 +
    Math.min(999_999, Math.round(Math.abs(a.percentDeviation ?? Math.abs(a.absoluteDeviation))))
  );
}

export function compressEvidencePackage(
  pkg: EvidencePackage,
  maxChars: number
): CompressionResult {
  const measure = (p: EvidencePackage): number => JSON.stringify(p).length;
  const originalChars = measure(pkg);
  if (originalChars <= maxChars) {
    return { pkg, compressed: false, originalChars, finalChars: originalChars };
  }

  let working: EvidencePackage = structuredCloneInternal(pkg);

  // Step 1: shrink untrusted context.
  if (measure(working) > maxChars) {
    working = {
      ...working,
      relevantContext: {
        labels: working.relevantContext.labels.map((l) => ({
          key: l.key,
          value: l.value.slice(0, 80),
        })).slice(0, 5),
        notes: working.relevantContext.notes.slice(0, 3).map((n) => n.slice(0, 120)),
      },
    };
  }

  // Step 2: keep only metric details that anomalies reference.
  if (measure(working) > maxChars) {
    const anomalousMetrics = new Set(working.anomalies.map((a) => a.metric));
    working = {
      ...working,
      metricDetails: working.metricDetails.filter(
        (d) => anomalousMetrics.has(d.metric) ||
          d.metric === "cpa" || d.metric === "ctr" || d.metric === "frequency"
      ),
    };
  }

  // Step 3: drop the redundant previousMetrics record.
  if (measure(working) > maxChars) {
    working = { ...working, previousMetrics: undefined };
  }

  // Step 4: cap entity name + label length hard.
  if (measure(working) > maxChars) {
    working = {
      ...working,
      entityName: working.entityName?.slice(0, 40),
      relevantContext: {
        labels: working.relevantContext.labels.slice(0, 2).map((l) => ({
          key: l.key.slice(0, 16),
          value: l.value.slice(0, 40),
        })),
        notes: [],
      },
    };
  }

  // Step 5 (last resort): keep only the strongest anomalies.
  if (measure(working) > maxChars && working.anomalies.length > 1) {
    const sorted = [...working.anomalies].sort((a, b) => rankAnomaly(b) - rankAnomaly(a));
    let lo = 1;
    let hi = sorted.length - 1;
    let best = working;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = { ...working, anomalies: sorted.slice(0, mid) };
      if (measure(candidate) <= maxChars) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    working = best;
  }

  return {
    pkg: working,
    compressed: true,
    originalChars,
    finalChars: measure(working),
  };
}

// Node 18+/20 has structuredClone, but keep a local safe fallback for tests.
function structuredCloneInternal<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
