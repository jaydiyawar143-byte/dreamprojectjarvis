// ---------------------------------------------------------------------------
// Sprint 4.4 — Chart tokens.
//
// No charting library. The dashboard needs exactly two forms — a single-series
// line and a horizontal magnitude bar — and a library that draws them would add
// several hundred kilobytes to a 108 kB route for shapes that are a few dozen
// lines of SVG. These tokens are the whole "design system" the two charts share.
//
// SERIES colour is not the UI accent. sys-cyan (#3ee0f2) is tuned to glow on
// chrome; as a data mark on the panel surface it sits at L 0.833, outside the
// legible band for a dark surface. #12a5bd is the same hue family, stepped down
// until it passed every check of the palette validator against surface #070d16:
// lightness band, chroma floor, and >= 3:1 contrast. Do not "brighten" it back
// to the accent without re-validating.
// ---------------------------------------------------------------------------

export const CHART = {
  /** The one data colour. Validated; see the note above. */
  series: "#12a5bd",
  /** Same hue, low alpha, for an area wash under the line. */
  seriesWash: "rgba(18, 165, 189, 0.16)",
  /** Emphasised endpoint / hovered marker. */
  seriesBright: "#3ee0f2",
  /** Recessive grid — present enough to read a value against, quiet enough to ignore. */
  grid: "rgba(93, 113, 131, 0.22)",
  /** Axis rule, slightly stronger than the grid. */
  axis: "rgba(93, 113, 131, 0.45)",
  /** Text tokens. Data text never wears the series colour. */
  label: "#5b7183",
  labelStrong: "#c3d3e0",
  /** Crosshair. */
  crosshair: "rgba(195, 211, 224, 0.35)",
} as const;

/** Metrics the dashboard can plot, with how each one is written. */
export type MetricKey =
  | "spend"
  | "impressions"
  | "clicks"
  | "reach"
  | "conversions"
  | "revenue"
  | "ctr"
  | "cpc"
  | "cpm"
  | "cpa"
  | "roas";

export interface MetricSpec {
  key: MetricKey;
  label: string;
  /** currency and rate values are written differently from raw counts. */
  kind: "currency" | "count" | "percent" | "ratio";
}

export const METRIC_SPECS: MetricSpec[] = [
  { key: "spend", label: "Spend", kind: "currency" },
  { key: "impressions", label: "Impressions", kind: "count" },
  { key: "clicks", label: "Clicks", kind: "count" },
  { key: "reach", label: "Reach", kind: "count" },
  { key: "conversions", label: "Conversions", kind: "count" },
  { key: "revenue", label: "Revenue", kind: "currency" },
  { key: "ctr", label: "CTR", kind: "percent" },
  { key: "cpc", label: "CPC", kind: "currency" },
  { key: "cpm", label: "CPM", kind: "currency" },
  { key: "cpa", label: "CPA", kind: "currency" },
  { key: "roas", label: "ROAS", kind: "ratio" },
];

export const METRIC_BY_KEY: Record<MetricKey, MetricSpec> = Object.fromEntries(
  METRIC_SPECS.map((s) => [s.key, s])
) as Record<MetricKey, MetricSpec>;

/**
 * Writes a metric value.
 *
 * A null is rendered as an em dash, never as 0 — the dashboard must not turn a
 * gap in Meta's data into a measurement.
 */
export function formatMetric(value: number | null | undefined, kind: MetricSpec["kind"]): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";

  switch (kind) {
    case "currency":
      return value >= 1000
        ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
        : value.toFixed(2);
    case "percent":
      return `${value.toFixed(2)}%`;
    case "ratio":
      return `${value.toFixed(2)}×`;
    case "count":
    default:
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
      if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
      return String(Math.round(value));
  }
}

/** Short axis form: "12 Aug" rather than an ISO string. */
export function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${d.toLocaleString("en", { month: "short", timeZone: "UTC" })}`;
}

/**
 * Axis ticks that land on round numbers.
 *
 * Every tick names a value the chart actually reaches, and the top tick is at
 * or above the maximum so no mark escapes the plot.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const rough = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((ticks[ticks.length - 1]! + step).toFixed(6)));
  return ticks;
}
