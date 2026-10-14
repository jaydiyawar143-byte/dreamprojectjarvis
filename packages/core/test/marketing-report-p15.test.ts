// Phase 15 — the report builder and its renderers. Pure: rows in, a document
// out. No provider, no model, no clock.
import { describe, it, expect } from "vitest";
import {
  buildMarketingReport,
  formatReportValue,
  metricRowFromMetaInsight,
  renderReportHtml,
  renderReportMarkdown,
  reportFileName,
  totalsFor,
  type ReportInputs,
  type ReportMetricRow,
  type ReportProviderData,
} from "../src/marketing-report.js";
import type { ContentItemView, ReportDataSource } from "../src/types/marketing.js";

const row = (overrides: Partial<ReportMetricRow> = {}): ReportMetricRow => ({
  spend: 100,
  impressions: 10_000,
  clicks: 200,
  reach: 8000,
  conversions: 20,
  revenue: 400,
  ...overrides,
});

const META_SOURCE: Omit<ReportDataSource, "rowCount"> = {
  provider: "meta-ads",
  label: "Meta Ads",
  status: "INCLUDED",
  detail: "Read from the connected ad account.",
  executionIds: ["exec-1", "exec-2"],
  account: "act_123••••789",
};

const GOOGLE_BLOCKED: ReportDataSource = {
  provider: "google-ads",
  label: "Google Ads",
  status: "SCOPE_NOT_GRANTED",
  detail: "Your Google account is connected, but read access to Google Ads was not granted.",
  rowCount: 0,
  executionIds: [],
  account: null,
};

const performance = (overrides: Partial<ReportProviderData> = {}): ReportProviderData => ({
  source: META_SOURCE,
  totalRows: [row()],
  reachAdditive: true,
  previousRows: [row({ spend: 80, impressions: 9000, clicks: 225, conversions: 18, revenue: 360 })],
  campaignRows: [
    row({ campaignId: "111", campaignName: "Diwali Prospecting", spend: 70, clicks: 150 }),
    row({ campaignId: "222", campaignName: "Diwali Retargeting", spend: 30, clicks: 50 }),
  ],
  ...overrides,
});

const content = (overrides: Partial<ContentItemView> = {}): ContentItemView => ({
  id: "c1",
  campaignId: "camp1",
  projectId: null,
  title: "Offer post",
  channel: "FACEBOOK",
  format: "POST",
  body: "Offer",
  link: null,
  notes: null,
  status: "DRAFT",
  scheduledDate: "2026-10-05",
  scheduledTime: null,
  publication: null,
  publishAttempt: null,
  publishUnconfirmed: false,
  createdBy: "user",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const inputs = (overrides: Partial<ReportInputs> = {}): ReportInputs => ({
  kind: "PERFORMANCE",
  title: "Diwali Sale — October",
  campaign: { name: "Diwali Sale", objective: "Festive revenue", status: "ACTIVE" },
  periodStart: "2026-10-01",
  periodEnd: "2026-10-10",
  previousPeriod: { start: "2026-09-21", end: "2026-09-30" },
  generatedAt: "2026-10-12T09:00:00.000Z",
  currency: "INR",
  performance: performance(),
  otherSources: [GOOGLE_BLOCKED],
  content: [],
  ...overrides,
});

describe("reading a provider row", () => {
  it("turns Meta's strings into numbers and derives revenue from ROAS and spend", () => {
    const parsed = metricRowFromMetaInsight(
      { spend: "120.50", impressions: "15000", clicks: "300", reach: "9000", conversions: "12", roas: "2.5", campaignId: "999" },
      "Launch"
    );
    expect(parsed).toEqual({
      campaignId: "999",
      campaignName: "Launch",
      spend: 120.5,
      impressions: 15000,
      clicks: 300,
      reach: 9000,
      conversions: 12,
      revenue: 301.25,
    });
  });

  it("keeps what Meta left off as null — unknown, not zero", () => {
    const parsed = metricRowFromMetaInsight({ spend: "50", impressions: "1000", clicks: "10" });
    expect(parsed.conversions).toBeNull();
    expect(parsed.revenue).toBeNull();
    expect(parsed.reach).toBeNull();
  });

  it.each(["abc", "-5", "", null, undefined, "NaN"])("does not turn the junk value %s into a number", (junk) => {
    expect(metricRowFromMetaInsight({ spend: "10", conversions: junk, roas: junk }).conversions).toBeNull();
  });
});

describe("totals", () => {
  it("adds rows and computes the derived figures", () => {
    const { kpis, reported } = totalsFor([row(), row()], { reachAdditive: true });
    expect(kpis.spend).toBe(200);
    expect(kpis.clicks).toBe(400);
    expect(kpis.ctr).toBe(2);
    expect(kpis.cpc).toBe(0.5);
    expect(kpis.cpa).toBe(5);
    expect(kpis.roas).toBe(4);
    expect(reported).toEqual({ conversions: true, revenue: true, reach: true });
  });

  it("does not compute cost per conversion from conversions nobody reported", () => {
    const { kpis, reported } = totalsFor([row({ conversions: null })], { reachAdditive: true });
    expect(reported.conversions).toBe(false);
    expect(kpis.cpa).toBeNull();
    expect(kpis.cvr).toBeNull();
    expect(kpis.isDefined.cpa).toBe(false);
  });

  it("does not compute ROAS from revenue nobody reported", () => {
    const { kpis, reported } = totalsFor([row({ revenue: null })], { reachAdditive: true });
    expect(reported.revenue).toBe(false);
    expect(kpis.roas).toBeNull();
  });

  it("a genuinely reported zero stays a zero, and is still reported", () => {
    const { kpis, reported } = totalsFor([row({ conversions: 0 })], { reachAdditive: true });
    expect(reported.conversions).toBe(true);
    expect(kpis.conversions).toBe(0);
  });

  it("withholds reach and frequency when reach cannot be added across the rows", () => {
    const { kpis, reported } = totalsFor([row(), row()], { reachAdditive: false });
    expect(reported.reach).toBe(false);
    expect(kpis.frequency).toBeNull();
  });

  it("one row reporting a metric is enough for the total to carry it", () => {
    const { kpis, reported } = totalsFor([row({ conversions: null }), row({ conversions: 5 })], { reachAdditive: true });
    expect(reported.conversions).toBe(true);
    expect(kpis.conversions).toBe(5);
  });
});

describe("the report document", () => {
  const doc = buildMarketingReport(inputs());

  it("carries the period, its length and the comparison period", () => {
    expect(doc.period).toEqual({ start: "2026-10-01", end: "2026-10-10", days: 10 });
    expect(doc.previousPeriod).toEqual({ start: "2026-09-21", end: "2026-09-30", days: 10 });
    expect(doc.schemaVersion).toBe(1);
  });

  it("puts the provider that was read first and keeps the one that was not", () => {
    expect(doc.dataSources.map((s) => [s.provider, s.status])).toEqual([
      ["meta-ads", "INCLUDED"],
      ["google-ads", "SCOPE_NOT_GRANTED"],
    ]);
    expect(doc.dataSources[0]!.rowCount).toBe(1);
    expect(doc.dataSources[0]!.executionIds).toEqual(["exec-1", "exec-2"]);
  });

  it("states in the notes why Google Ads is not in the report", () => {
    expect(doc.notes.join("\n")).toContain("Google Ads is not in this report: Your Google account is connected, but read access to Google Ads was not granted.");
  });

  it("computes the change against the previous period", () => {
    const spend = doc.changes.find((c) => c.metric === "spend")!;
    expect(spend).toMatchObject({ current: 100, previous: 80, absolute: 20, relativePct: 25, unit: "currency" });
    const ctr = doc.changes.find((c) => c.metric === "ctr")!;
    expect(ctr.current).toBe(2);
    expect(ctr.previous).toBe(2.5);
    expect(ctr.relativePct).toBe(-20);
  });

  it("breaks the period down by campaign, highest spend first", () => {
    expect(doc.campaigns.map((c) => [c.id, c.name, c.kpis.spend])).toEqual([
      ["111", "Diwali Prospecting", 70],
      ["222", "Diwali Retargeting", 30],
    ]);
  });

  it("always says what the document is and what producing it did not do", () => {
    expect(doc.disclaimer).toBe(
      "This report is a read-only summary of data fetched on 2026-10-12. Generating it changed nothing in any advertising account and published nothing."
    );
  });

  it("the same inputs always produce the same document", () => {
    expect(buildMarketingReport(inputs())).toEqual(buildMarketingReport(inputs()));
  });
});

describe("a report says what it does not know", () => {
  it("with no provider data, totals are null — not zeros — and the note says so", () => {
    const failed: ReportDataSource = { ...GOOGLE_BLOCKED, provider: "meta-ads", label: "Meta Ads", status: "FAILED", detail: "The read did not succeed." };
    const doc = buildMarketingReport(inputs({ performance: null, otherSources: [failed, GOOGLE_BLOCKED] }));
    expect(doc.totals).toBeNull();
    expect(doc.previousTotals).toBeNull();
    expect(doc.changes).toEqual([]);
    expect(doc.campaigns).toEqual([]);
    expect(doc.notes[0]).toBe("No advertising data is included in this report.");
    expect(doc.notes.join("\n")).toContain("Meta Ads is not in this report: The read did not succeed.");
  });

  it("a provider that answered with nothing is reported as empty, not as failed", () => {
    const doc = buildMarketingReport(
      inputs({ performance: performance({ source: { ...META_SOURCE, status: "EMPTY", detail: "No rows." }, totalRows: [], campaignRows: [] }) })
    );
    expect(doc.totals).toBeNull();
    expect(doc.notes.join("\n")).toContain("Meta Ads returned no data for this period.");
  });

  it("when conversions were not reported, they are shown as not available and the note says why", () => {
    const doc = buildMarketingReport(
      inputs({ performance: performance({ totalRows: [row({ conversions: null })], previousRows: [row({ conversions: null })] }) })
    );
    expect(doc.metricsReported.conversions).toBe(false);
    expect(doc.changes.find((c) => c.metric === "conversions")).toMatchObject({ current: null, previous: null, relativePct: null });
    expect(doc.changes.find((c) => c.metric === "cpa")!.current).toBeNull();
    expect(doc.notes.join("\n")).toContain("reported no conversion counts");
  });

  it("warns when cost per conversion rests on very few conversions", () => {
    const doc = buildMarketingReport(inputs({ performance: performance({ totalRows: [row({ conversions: 3 })] }) }));
    expect(doc.notes.join("\n")).toContain("Only 3 conversions were reported");
  });

  it("with no data for the comparison period, shows no change rather than a change from zero", () => {
    const doc = buildMarketingReport(inputs({ performance: performance({ previousRows: [] }) }));
    expect(doc.previousTotals).toBeNull();
    expect(doc.changes.every((c) => c.previous === null && c.relativePct === null)).toBe(true);
    expect(doc.notes.join("\n")).toContain("No data was returned for the comparison period");
  });

  it("a rise from zero is 'new', never an infinite percentage", () => {
    const doc = buildMarketingReport(
      inputs({ performance: performance({ previousRows: [row({ spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0 })] }) })
    );
    const spend = doc.changes.find((c) => c.metric === "spend")!;
    expect(spend.relativePct).toBeNull();
    expect(renderReportMarkdown(doc)).toContain("| Spend | ₹100.00 | ₹0.00 | new |");
  });

  it("says reach is not totalled across campaigns", () => {
    const doc = buildMarketingReport(inputs({ performance: performance({ reachAdditive: false }) }));
    expect(doc.metricsReported.reach).toBe(false);
    expect(doc.notes.join("\n")).toContain("Reach and frequency are not totalled across campaigns");
  });
});

describe("content in a report", () => {
  const published = content({
    id: "p1",
    title: "Verified post",
    status: "PUBLISHED",
    publication: {
      mode: "VERIFIED",
      publishedAt: "2026-10-03T10:00:00.000Z",
      provider: "meta-graph",
      targetName: "Shop Page",
      externalId: "1_2",
      url: "https://facebook.com/1/posts/2",
      verifiedAt: "2026-10-03T10:00:05.000Z",
    },
  });
  const selfReported = content({
    id: "p2",
    title: "Posted by hand",
    channel: "INSTAGRAM",
    status: "PUBLISHED",
    publication: { mode: "REPORTED_BY_USER", publishedAt: "2026-10-04T10:00:00.000Z", provider: null, targetName: null, externalId: null, url: null, verifiedAt: null },
  });
  const doc = buildMarketingReport(inputs({ content: [content(), published, selfReported, content({ id: "x", status: "ARCHIVED" })] }));

  it("separates what was published from what was only planned", () => {
    expect(doc.content.published.map((r) => r.title)).toEqual(["Verified post", "Posted by hand"]);
    expect(doc.content.planned.map((r) => r.title)).toEqual(["Offer post"]);
    expect(doc.content.counts).toEqual({ published: 2, verified: 1, reportedByUser: 1, planned: 1 });
  });

  it("never shows a post the user reported as one JARVIS verified", () => {
    expect(doc.content.published.find((r) => r.title === "Posted by hand")!.publication).toBe("REPORTED_BY_USER");
    expect(doc.notes.join("\n")).toContain("1 published item was marked as posted by you. JARVIS did not publish it and has not checked it.");
    const markdown = renderReportMarkdown(doc);
    expect(markdown).toContain("| 2026-10-04 | Instagram | Posted by hand | Reported as posted by you |");
    expect(markdown).toContain("| 2026-10-03 | Facebook | Verified post | Published by JARVIS, verified |");
  });

  it("leaves archived items out", () => {
    expect([...doc.content.published, ...doc.content.planned].some((r) => r.status === "ARCHIVED")).toBe(false);
  });
});

describe("rendering", () => {
  it("formats each unit, and shows a missing value as n/a rather than 0", () => {
    expect(formatReportValue(1234.5, "currency", "INR")).toBe("₹1,234.50");
    expect(formatReportValue(1234.5, "currency", null)).toBe("1,234.50");
    expect(formatReportValue(1234.5, "currency", "not-a-code")).toBe("1,234.50");
    expect(formatReportValue(2.345, "percent", null)).toBe("2.35%");
    expect(formatReportValue(3.2, "ratio", null)).toBe("3.20x");
    expect(formatReportValue(15000, "count", null)).toBe("15,000");
    expect(formatReportValue(null, "currency", "INR")).toBe("n/a");
  });

  it("the Markdown carries the summary, the sources and the disclaimer", () => {
    const markdown = renderReportMarkdown(buildMarketingReport(inputs()));
    expect(markdown).toContain("# Diwali Sale — October");
    expect(markdown).toContain("| Spend | ₹100.00 | ₹80.00 | +25.0% |");
    expect(markdown).toContain("- Meta Ads: Included (act_123••••789).");
    expect(markdown).toContain("- Google Ads: Access not granted.");
    expect(markdown.trimEnd().endsWith("published nothing.")).toBe(true);
  });

  it("a title cannot break out of a Markdown table cell", () => {
    const doc = buildMarketingReport(
      inputs({ performance: performance({ campaignRows: [row({ campaignId: "1", campaignName: "A | B\nC" })] }) })
    );
    expect(renderReportMarkdown(doc)).toContain("| A \\| B C |");
  });

  it("the HTML escapes everything a user or a provider wrote", () => {
    const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const doc = buildMarketingReport(
      inputs({
        title: hostile,
        campaign: { name: hostile, objective: hostile, status: "ACTIVE" },
        performance: performance({ campaignRows: [row({ campaignId: "1", campaignName: hostile })] }),
        content: [content({ title: hostile })],
      })
    );
    const html = renderReportHtml(doc);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("the HTML is self-contained: it loads nothing and runs nothing", () => {
    const html = renderReportHtml(buildMarketingReport(inputs()));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\bsrc=/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("the HTML and the Markdown say the same things about the sources", () => {
    const doc = buildMarketingReport(inputs());
    const html = renderReportHtml(doc);
    expect(html).toContain("Access not granted");
    expect(html).toContain(doc.disclaimer);
  });

  it("builds a safe file name", () => {
    const doc = buildMarketingReport(inputs({ title: "../../Diwali Sale: <Oct>!" }));
    expect(reportFileName(doc, "html")).toBe("diwali-sale-oct-2026-10-01-to-2026-10-10.html");
    expect(reportFileName({ title: "???", period: doc.period }, "md")).toBe("report-2026-10-01-to-2026-10-10.md");
  });
});
