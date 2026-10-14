// ---------------------------------------------------------------------------
// Phase 15 — the report builder, as pure functions.
//
// A report is ARITHMETIC OVER ROWS THAT WERE READ, and nothing else. This
// module is handed the rows — it fetches none — and turns them into totals, a
// comparison with the period before, a per-campaign table and a list of the
// workspace's content for the period. No model is involved, so there is no
// sentence in a report that a model wrote and no number a model chose.
//
// THE RULE THAT SHAPES IT: A METRIC THE PROVIDER DID NOT SEND IS UNKNOWN, NOT
// ZERO. Meta leaves `conversions` and `roas` off a row when it has nothing to
// say. Summing those as zeros would print "0 conversions, ROAS 0.00" — two
// figures nobody measured. So every row carries `null` for what was absent,
// `metricsReported` records which inputs really arrived, and anything derived
// from a missing input is shown as not available, with a note saying why.
//
// A source that could not be read is recorded as not read (`dataSources`),
// never dropped: a report that silently omits Google Ads reads as "there was
// no Google Ads spend", which is a different and false statement.
// ---------------------------------------------------------------------------

import { calculateCanonicalKPIs, type CalculatedKPIs } from "./kpi-engine.js";
import { channelLabel } from "./marketing-content.js";
import {
  inclusiveDays,
  type CampaignStatus,
  type ContentItemView,
  type MarketingReportDocument,
  type MarketingReportKind,
  type ReportCampaignRow,
  type ReportContentRow,
  type ReportDataSource,
  type ReportMetricChange,
} from "./types/marketing.js";

/** One row of provider metrics, as numbers. `null` means the provider did not report it. */
export interface ReportMetricRow {
  campaignId?: string;
  campaignName?: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number | null;
  conversions: number | null;
  revenue: number | null;
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * A Meta insights row, as the `meta.insights` tool returns it, as numbers.
 *
 * Spend, impressions and clicks are always present on a row Meta returns, so
 * an absent one is zero for that row. Reach, conversions and ROAS are left
 * off when Meta has nothing to report, so an absent one stays `null`. Revenue
 * is ROAS × spend, the same derivation the outcome pipeline uses.
 */
export function metricRowFromMetaInsight(
  row: Readonly<Record<string, unknown>>,
  campaignName?: string | null
): ReportMetricRow {
  const spend = numberOrNull(row.spend) ?? 0;
  const roas = numberOrNull(row.roas);
  const campaignId = typeof row.campaignId === "string" && row.campaignId.length > 0 ? row.campaignId : undefined;
  return {
    ...(campaignId ? { campaignId } : {}),
    ...(campaignName !== undefined ? { campaignName } : {}),
    spend,
    impressions: numberOrNull(row.impressions) ?? 0,
    clicks: numberOrNull(row.clicks) ?? 0,
    reach: numberOrNull(row.reach),
    conversions: numberOrNull(row.conversions),
    revenue: roas === null ? null : roas * spend,
  };
}

export interface MetricsReported {
  conversions: boolean;
  revenue: boolean;
  reach: boolean;
}

/**
 * Totals over a set of rows.
 *
 * `reachAdditive` says whether adding `reach` across these rows means
 * anything. Across campaigns it does not — one person reached by two
 * campaigns is one person — so the total is withheld rather than overstated.
 */
export function totalsFor(
  rows: readonly ReportMetricRow[],
  options: { reachAdditive: boolean }
): { kpis: CalculatedKPIs; reported: MetricsReported } {
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let reach = 0;
  let conversions = 0;
  let revenue = 0;
  const reported: MetricsReported = { conversions: false, revenue: false, reach: false };

  for (const row of rows) {
    spend += row.spend;
    impressions += row.impressions;
    clicks += row.clicks;
    if (row.conversions !== null) {
      conversions += row.conversions;
      reported.conversions = true;
    }
    if (row.revenue !== null) {
      revenue += row.revenue;
      reported.revenue = true;
    }
    if (options.reachAdditive && row.reach !== null) {
      reach += row.reach;
      reported.reach = true;
    }
  }

  const kpis = calculateCanonicalKPIs({ spend, impressions, clicks, reach, conversions, revenue });

  // What was not reported cannot be the input to a figure that is shown.
  if (!reported.conversions) {
    kpis.cpa = null;
    kpis.cvr = null;
    kpis.isDefined.cpa = false;
    kpis.isDefined.cvr = false;
  }
  if (!reported.revenue) {
    kpis.roas = null;
    kpis.isDefined.roas = false;
  }
  if (!reported.reach) {
    kpis.frequency = null;
    kpis.isDefined.frequency = false;
  }
  return { kpis, reported };
}

const CHANGE_METRICS: ReadonlyArray<{
  metric: keyof CalculatedKPIs;
  label: string;
  unit: ReportMetricChange["unit"];
  needs?: keyof MetricsReported;
}> = [
  { metric: "spend", label: "Spend", unit: "currency" },
  { metric: "impressions", label: "Impressions", unit: "count" },
  { metric: "clicks", label: "Clicks", unit: "count" },
  { metric: "ctr", label: "Click-through rate", unit: "percent" },
  { metric: "cpc", label: "Cost per click", unit: "currency" },
  { metric: "cpm", label: "Cost per 1,000 impressions", unit: "currency" },
  { metric: "conversions", label: "Conversions", unit: "count", needs: "conversions" },
  { metric: "cpa", label: "Cost per conversion", unit: "currency", needs: "conversions" },
  { metric: "roas", label: "Return on ad spend", unit: "ratio", needs: "revenue" },
];

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function changesBetween(
  current: { kpis: CalculatedKPIs; reported: MetricsReported },
  previous: { kpis: CalculatedKPIs; reported: MetricsReported } | null
): ReportMetricChange[] {
  return CHANGE_METRICS.map(({ metric, label, unit, needs }) => {
    const currentKnown = needs === undefined || current.reported[needs];
    const now = currentKnown ? (current.kpis[metric] as number | null) : null;

    const previousKnown = previous !== null && (needs === undefined || previous.reported[needs]);
    const before = previousKnown ? (previous!.kpis[metric] as number | null) : null;

    const comparable = now !== null && before !== null;
    return {
      metric,
      label,
      unit,
      current: now,
      previous: before,
      absolute: comparable ? round(now - before, 4) : null,
      // A change from nothing is not a percentage; it is "new".
      relativePct: comparable && before > 0 ? round(((now - before) / before) * 100, 1) : null,
    };
  });
}

function contentRow(item: ContentItemView): ReportContentRow {
  return {
    title: item.title,
    channel: item.channel,
    date: item.publication?.publishedAt.slice(0, 10) ?? item.scheduledDate,
    status: item.status,
    publication: item.publication?.mode ?? null,
    url: item.publication?.url ?? null,
  };
}

export interface ReportProviderData {
  source: Omit<ReportDataSource, "rowCount">;
  /** The rows the period's totals are summed from. */
  totalRows: ReportMetricRow[];
  /** Whether `reach` may be added across `totalRows`. */
  reachAdditive: boolean;
  /** The same shape for the period before. Null: no comparison was read. */
  previousRows: ReportMetricRow[] | null;
  /** Per-campaign rows for the breakdown table. */
  campaignRows: ReportMetricRow[];
}

export interface ReportInputs {
  kind: MarketingReportKind;
  title: string;
  campaign: { name: string; objective: string | null; status: CampaignStatus } | null;
  /** YYYY-MM-DD, inclusive. */
  periodStart: string;
  periodEnd: string;
  /** The period compared against. Null: none. */
  previousPeriod: { start: string; end: string } | null;
  generatedAt: string;
  currency: string | null;
  /**
   * The provider whose rows are the report's figures, when one was read.
   * Its `source` is listed first among the data sources.
   */
  performance: ReportProviderData | null;
  /** Sources that contributed no rows — recorded so their absence is stated. */
  otherSources: ReportDataSource[];
  /** The workspace's content relevant to the period. */
  content: ContentItemView[];
}

const MAX_CAMPAIGN_ROWS = 50;
const MAX_CONTENT_ROWS = 60;

/**
 * Build the report document.
 *
 * Pure: the same inputs always produce the same document, including its notes.
 */
export function buildMarketingReport(input: ReportInputs): MarketingReportDocument {
  const notes: string[] = [];
  const dataSources: ReportDataSource[] = [];

  const performance = input.performance;
  const included = performance !== null && performance.source.status === "INCLUDED" && performance.totalRows.length > 0;

  if (performance) {
    dataSources.push({ ...performance.source, rowCount: performance.totalRows.length });
  }
  dataSources.push(...input.otherSources);

  let totals: CalculatedKPIs | null = null;
  let previousTotals: CalculatedKPIs | null = null;
  let reported: MetricsReported = { conversions: false, revenue: false, reach: false };
  let changes: ReportMetricChange[] = [];
  let campaigns: ReportCampaignRow[] = [];

  if (included && performance) {
    const current = totalsFor(performance.totalRows, { reachAdditive: performance.reachAdditive });
    totals = current.kpis;
    reported = current.reported;

    const hasPrevious = performance.previousRows !== null && performance.previousRows.length > 0;
    const previous = hasPrevious
      ? totalsFor(performance.previousRows!, { reachAdditive: performance.reachAdditive })
      : null;
    previousTotals = previous?.kpis ?? null;
    changes = changesBetween(current, previous);

    campaigns = performance.campaignRows
      .filter((row) => typeof row.campaignId === "string")
      .map((row) => ({
        id: row.campaignId!,
        name: row.campaignName ?? null,
        kpis: totalsFor([row], { reachAdditive: true }).kpis,
      }))
      .sort((a, b) => b.kpis.spend - a.kpis.spend || a.id.localeCompare(b.id))
      .slice(0, MAX_CAMPAIGN_ROWS);

    if (!reported.conversions) {
      notes.push(
        "The provider reported no conversion counts for this period, so conversions, cost per conversion and conversion rate are not shown."
      );
    } else if (current.kpis.conversions < 10) {
      notes.push(
        `Only ${current.kpis.conversions} conversion${current.kpis.conversions === 1 ? "" : "s"} were reported in the period. Cost per conversion rests on very few results and should be read with caution.`
      );
    }
    if (!reported.revenue) {
      notes.push("The provider reported no purchase value for this period, so return on ad spend is not shown.");
    }
    if (!performance.reachAdditive) {
      notes.push(
        "Reach and frequency are not totalled across campaigns: one person reached by two campaigns is still one person."
      );
    }
    if (input.previousPeriod) {
      notes.push(
        previous
          ? `Changes compare this period with the ${inclusiveDays(input.previousPeriod.start, input.previousPeriod.end)} days before it (${input.previousPeriod.start} to ${input.previousPeriod.end}).`
          : `No data was returned for the comparison period (${input.previousPeriod.start} to ${input.previousPeriod.end}), so changes are not shown.`
      );
    }
    if (performance.campaignRows.length > MAX_CAMPAIGN_ROWS) {
      notes.push(`The campaign table shows the ${MAX_CAMPAIGN_ROWS} campaigns with the highest spend.`);
    }
  } else {
    notes.push("No advertising data is included in this report.");
  }

  for (const source of dataSources) {
    if (source.status === "INCLUDED") continue;
    notes.push(
      source.status === "EMPTY"
        ? `${source.label} returned no data for this period.`
        : `${source.label} is not in this report: ${source.detail}`
    );
  }

  const published = input.content
    .filter((item) => item.publication !== null)
    .map(contentRow)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.title.localeCompare(b.title));
  const planned = input.content
    .filter((item) => item.publication === null && item.status !== "ARCHIVED")
    .map(contentRow)
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.title.localeCompare(b.title));

  const verified = published.filter((row) => row.publication === "VERIFIED").length;
  const reportedByUser = published.length - verified;
  if (reportedByUser > 0) {
    notes.push(
      `${reportedByUser} published item${reportedByUser === 1 ? " was" : "s were"} marked as posted by you. JARVIS did not publish ${reportedByUser === 1 ? "it" : "them"} and has not checked ${reportedByUser === 1 ? "it" : "them"}.`
    );
  }
  if (published.length > MAX_CONTENT_ROWS || planned.length > MAX_CONTENT_ROWS) {
    notes.push(`Content lists show at most ${MAX_CONTENT_ROWS} items each.`);
  }

  return {
    schemaVersion: 1,
    kind: input.kind,
    title: input.title,
    campaign: input.campaign,
    period: { start: input.periodStart, end: input.periodEnd, days: inclusiveDays(input.periodStart, input.periodEnd) },
    previousPeriod: input.previousPeriod
      ? {
          start: input.previousPeriod.start,
          end: input.previousPeriod.end,
          days: inclusiveDays(input.previousPeriod.start, input.previousPeriod.end),
        }
      : null,
    generatedAt: input.generatedAt,
    currency: input.currency,
    dataSources,
    totals,
    previousTotals,
    metricsReported: reported,
    changes,
    campaigns,
    content: {
      published: published.slice(0, MAX_CONTENT_ROWS),
      planned: planned.slice(0, MAX_CONTENT_ROWS),
      counts: { published: published.length, verified, reportedByUser, planned: planned.length },
    },
    notes,
    disclaimer: `This report is a read-only summary of data fetched on ${input.generatedAt.slice(0, 10)}. Generating it changed nothing in any advertising account and published nothing.`,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const NOT_AVAILABLE = "n/a";

function formatCurrency(value: number, currency: string | null): string {
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
    } catch {
      // An unknown code falls through to the plain number.
    }
  }
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatReportValue(
  value: number | null,
  unit: ReportMetricChange["unit"],
  currency: string | null
): string {
  if (value === null) return NOT_AVAILABLE;
  switch (unit) {
    case "currency":
      return formatCurrency(value, currency);
    case "percent":
      return `${value.toFixed(2)}%`;
    case "ratio":
      return `${value.toFixed(2)}x`;
    default:
      return Math.round(value).toLocaleString("en-US");
  }
}

/** A metric's change against the previous period, as a report prints it. */
export function formatReportChange(change: ReportMetricChange): string {
  if (change.relativePct === null) return change.current !== null && change.previous === 0 ? "new" : NOT_AVAILABLE;
  const sign = change.relativePct > 0 ? "+" : "";
  return `${sign}${change.relativePct.toFixed(1)}%`;
}

/** What each data-source status is called, in a report and on the screen that shows one. */
export const REPORT_SOURCE_STATUS_LABELS: Readonly<Record<ReportDataSource["status"], string>> = Object.freeze({
  INCLUDED: "Included",
  EMPTY: "No data for this period",
  NOT_CONFIGURED: "Not set up",
  NOT_CONNECTED: "Not connected",
  SCOPE_NOT_GRANTED: "Access not granted",
  NOT_INCLUDED: "Not included",
  FAILED: "Could not be read",
});

/** How a content row's publication is known, in words. */
export function reportPublicationLabel(row: ReportContentRow): string {
  if (row.publication === "VERIFIED") return "Published by JARVIS, verified";
  if (row.publication === "REPORTED_BY_USER") return "Reported as posted by you";
  return row.status === "READY" ? "Ready" : row.status === "DRAFT" ? "Draft" : "Idea";
}

function kindLabel(kind: MarketingReportKind): string {
  return kind === "CLIENT" ? "Client report" : "Performance report";
}

/** A Markdown table cell: pipes and line breaks would break the row. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/** The report as Markdown. Deterministic; contains nothing the document does not. */
export function renderReportMarkdown(doc: MarketingReportDocument): string {
  const lines: string[] = [];
  lines.push(`# ${doc.title}`, "");
  lines.push(`${kindLabel(doc.kind)} · ${doc.period.start} to ${doc.period.end} (${doc.period.days} days)`);
  if (doc.campaign) {
    lines.push(`Campaign: ${doc.campaign.name}${doc.campaign.objective ? ` — ${doc.campaign.objective}` : ""}`);
  }
  lines.push(`Generated ${doc.generatedAt.slice(0, 10)}`, "");

  lines.push("## Summary", "");
  if (doc.totals) {
    const compared = doc.previousTotals !== null;
    lines.push(compared ? "| Metric | This period | Previous period | Change |" : "| Metric | This period |");
    lines.push(compared ? "|---|---:|---:|---:|" : "|---|---:|");
    for (const change of doc.changes) {
      const current = formatReportValue(change.current, change.unit, doc.currency);
      lines.push(
        compared
          ? `| ${cell(change.label)} | ${current} | ${formatReportValue(change.previous, change.unit, doc.currency)} | ${formatReportChange(change)} |`
          : `| ${cell(change.label)} | ${current} |`
      );
    }
  } else {
    lines.push("No advertising data is included in this report.");
  }
  lines.push("");

  if (doc.campaigns.length > 0) {
    lines.push("## Campaigns", "");
    lines.push("| Campaign | Spend | Impressions | Clicks | CTR | Cost per click |");
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const row of doc.campaigns) {
      lines.push(
        `| ${cell(row.name ?? row.id)} | ${formatReportValue(row.kpis.spend, "currency", doc.currency)} | ${formatReportValue(row.kpis.impressions, "count", doc.currency)} | ${formatReportValue(row.kpis.clicks, "count", doc.currency)} | ${formatReportValue(row.kpis.ctr, "percent", doc.currency)} | ${formatReportValue(row.kpis.cpc, "currency", doc.currency)} |`
      );
    }
    lines.push("");
  }

  lines.push("## Content", "");
  if (doc.content.published.length === 0 && doc.content.planned.length === 0) {
    lines.push("No content items fall in this period.", "");
  } else {
    if (doc.content.published.length > 0) {
      lines.push("### Published", "", "| Date | Channel | Title | How it is known |", "|---|---|---|---|");
      for (const row of doc.content.published) {
        lines.push(`| ${row.date ?? NOT_AVAILABLE} | ${channelLabel(row.channel)} | ${cell(row.title)} | ${reportPublicationLabel(row)} |`);
      }
      lines.push("");
    }
    if (doc.content.planned.length > 0) {
      lines.push("### Planned, not published", "", "| Date | Channel | Title | Status |", "|---|---|---|---|");
      for (const row of doc.content.planned) {
        lines.push(`| ${row.date ?? "no date"} | ${channelLabel(row.channel)} | ${cell(row.title)} | ${reportPublicationLabel(row)} |`);
      }
      lines.push("");
    }
  }

  lines.push("## Where the data came from", "");
  for (const source of doc.dataSources) {
    lines.push(
      `- ${source.label}: ${REPORT_SOURCE_STATUS_LABELS[source.status]}${source.account ? ` (${source.account})` : ""}. ${source.detail}`
    );
  }
  lines.push("");

  if (doc.notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of doc.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  lines.push("---", "", doc.disclaimer, "");
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const REPORT_CSS = [
  "*{box-sizing:border-box}",
  "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16181d;margin:0;padding:32px;line-height:1.5;background:#fff}",
  "main{max-width:860px;margin:0 auto}",
  "h1{font-size:26px;margin:0 0 4px}",
  "h2{font-size:17px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #d9dde3}",
  "h3{font-size:14px;margin:18px 0 8px}",
  ".meta{color:#5b6472;font-size:13px;margin:0}",
  "table{width:100%;border-collapse:collapse;font-size:13px}",
  "th,td{padding:7px 10px;border-bottom:1px solid #e6e9ee;text-align:left;vertical-align:top}",
  "th{font-weight:600;color:#3a4250;background:#f5f6f8}",
  "td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}",
  "ul{padding-left:18px;margin:8px 0}",
  "li{margin:4px 0;font-size:13px}",
  ".disclaimer{margin-top:28px;padding-top:12px;border-top:1px solid #d9dde3;color:#5b6472;font-size:12px}",
  "@media print{body{padding:0}h2{break-after:avoid}tr{break-inside:avoid}}",
].join("");

/**
 * The report as one self-contained HTML document.
 *
 * Every value is escaped: titles, campaign names and content titles come from
 * users and providers, and this file is opened in a browser. It loads nothing
 * — no script, no remote font, no image — so opening it sends nothing anywhere.
 */
export function renderReportHtml(doc: MarketingReportDocument): string {
  const e = escapeHtml;
  const parts: string[] = [];
  parts.push(
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${e(doc.title)}</title>`,
    `<style>${REPORT_CSS}</style>`,
    "</head>",
    "<body><main>"
  );

  parts.push(`<h1>${e(doc.title)}</h1>`);
  parts.push(
    `<p class="meta">${e(kindLabel(doc.kind))} · ${e(doc.period.start)} to ${e(doc.period.end)} (${doc.period.days} days)</p>`
  );
  if (doc.campaign) {
    parts.push(
      `<p class="meta">Campaign: ${e(doc.campaign.name)}${doc.campaign.objective ? ` — ${e(doc.campaign.objective)}` : ""}</p>`
    );
  }
  parts.push(`<p class="meta">Generated ${e(doc.generatedAt.slice(0, 10))}</p>`);

  parts.push("<h2>Summary</h2>");
  if (doc.totals) {
    const compared = doc.previousTotals !== null;
    parts.push("<table><thead><tr><th>Metric</th><th class=\"num\">This period</th>");
    if (compared) parts.push('<th class="num">Previous period</th><th class="num">Change</th>');
    parts.push("</tr></thead><tbody>");
    for (const change of doc.changes) {
      parts.push(`<tr><td>${e(change.label)}</td><td class="num">${e(formatReportValue(change.current, change.unit, doc.currency))}</td>`);
      if (compared) {
        parts.push(
          `<td class="num">${e(formatReportValue(change.previous, change.unit, doc.currency))}</td><td class="num">${e(formatReportChange(change))}</td>`
        );
      }
      parts.push("</tr>");
    }
    parts.push("</tbody></table>");
  } else {
    parts.push("<p>No advertising data is included in this report.</p>");
  }

  if (doc.campaigns.length > 0) {
    parts.push(
      "<h2>Campaigns</h2>",
      '<table><thead><tr><th>Campaign</th><th class="num">Spend</th><th class="num">Impressions</th><th class="num">Clicks</th><th class="num">CTR</th><th class="num">Cost per click</th></tr></thead><tbody>'
    );
    for (const row of doc.campaigns) {
      parts.push(
        `<tr><td>${e(row.name ?? row.id)}</td>` +
          `<td class="num">${e(formatReportValue(row.kpis.spend, "currency", doc.currency))}</td>` +
          `<td class="num">${e(formatReportValue(row.kpis.impressions, "count", doc.currency))}</td>` +
          `<td class="num">${e(formatReportValue(row.kpis.clicks, "count", doc.currency))}</td>` +
          `<td class="num">${e(formatReportValue(row.kpis.ctr, "percent", doc.currency))}</td>` +
          `<td class="num">${e(formatReportValue(row.kpis.cpc, "currency", doc.currency))}</td></tr>`
      );
    }
    parts.push("</tbody></table>");
  }

  parts.push("<h2>Content</h2>");
  if (doc.content.published.length === 0 && doc.content.planned.length === 0) {
    parts.push("<p>No content items fall in this period.</p>");
  } else {
    if (doc.content.published.length > 0) {
      parts.push(
        "<h3>Published</h3>",
        "<table><thead><tr><th>Date</th><th>Channel</th><th>Title</th><th>How it is known</th></tr></thead><tbody>"
      );
      for (const row of doc.content.published) {
        parts.push(
          `<tr><td>${e(row.date ?? NOT_AVAILABLE)}</td><td>${e(channelLabel(row.channel))}</td><td>${e(row.title)}</td><td>${e(reportPublicationLabel(row))}</td></tr>`
        );
      }
      parts.push("</tbody></table>");
    }
    if (doc.content.planned.length > 0) {
      parts.push(
        "<h3>Planned, not published</h3>",
        "<table><thead><tr><th>Date</th><th>Channel</th><th>Title</th><th>Status</th></tr></thead><tbody>"
      );
      for (const row of doc.content.planned) {
        parts.push(
          `<tr><td>${e(row.date ?? "no date")}</td><td>${e(channelLabel(row.channel))}</td><td>${e(row.title)}</td><td>${e(reportPublicationLabel(row))}</td></tr>`
        );
      }
      parts.push("</tbody></table>");
    }
  }

  parts.push("<h2>Where the data came from</h2><ul>");
  for (const source of doc.dataSources) {
    parts.push(
      `<li><strong>${e(source.label)}:</strong> ${e(REPORT_SOURCE_STATUS_LABELS[source.status])}${source.account ? ` (${e(source.account)})` : ""}. ${e(source.detail)}</li>`
    );
  }
  parts.push("</ul>");

  if (doc.notes.length > 0) {
    parts.push("<h2>Notes</h2><ul>");
    for (const note of doc.notes) parts.push(`<li>${e(note)}</li>`);
    parts.push("</ul>");
  }

  parts.push(`<p class="disclaimer">${e(doc.disclaimer)}</p>`, "</main></body></html>");
  return parts.join("\n");
}

/** A file name for an exported report. Letters, digits and dashes only. */
export function reportFileName(doc: Pick<MarketingReportDocument, "title" | "period">, extension: "html" | "md"): string {
  const slug = doc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "report"}-${doc.period.start}-to-${doc.period.end}.${extension}`;
}
