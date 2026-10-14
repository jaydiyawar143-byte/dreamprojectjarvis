// Phase 15 — marketing recommendations. Pure rules: workspace facts in,
// advice with its evidence out. No model, no clock.
import { describe, it, expect } from "vitest";
import {
  RECOMMENDATION_THRESHOLDS,
  buildMarketingRecommendations,
  type RecommendationInputs,
} from "../src/marketing-recommendations.js";
import { buildMarketingReport, type ReportMetricRow } from "../src/marketing-report.js";
import { auditPage, extractPageFacts } from "../src/seo-audit.js";
import type { ContentItemView, MarketingCampaignView } from "../src/types/marketing.js";

const TODAY = "2026-10-12";

const campaign = (overrides: Partial<MarketingCampaignView> = {}): MarketingCampaignView => ({
  id: "camp1",
  name: "Diwali Sale",
  objective: "Festive revenue",
  brief: null,
  status: "ACTIVE",
  channels: ["FACEBOOK"],
  startDate: "2026-10-01",
  endDate: "2026-11-15",
  projectId: null,
  metaCampaignIds: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const item = (overrides: Partial<ContentItemView> = {}): ContentItemView => ({
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
  scheduledDate: "2026-10-15",
  scheduledTime: null,
  publication: null,
  publishAttempt: null,
  publishUnconfirmed: false,
  createdBy: "user",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const base = (overrides: Partial<RecommendationInputs> = {}): RecommendationInputs => ({
  today: TODAY,
  campaign: campaign(),
  content: [item()],
  publishableChannels: ["FACEBOOK"],
  latestReport: null,
  seoAudits: [],
  ...overrides,
});

const ids = (input: RecommendationInputs): string[] =>
  buildMarketingRecommendations(input).recommendations.map((r) => r.id);

const row = (overrides: Partial<ReportMetricRow> = {}): ReportMetricRow => ({
  spend: 100,
  impressions: 10_000,
  clicks: 200,
  reach: 8000,
  conversions: 20,
  revenue: 400,
  ...overrides,
});

function report(current: ReportMetricRow, previous: ReportMetricRow, generatedAt = `${TODAY}T08:00:00.000Z`) {
  return buildMarketingReport({
    kind: "PERFORMANCE",
    title: "Report",
    campaign: null,
    periodStart: "2026-10-01",
    periodEnd: "2026-10-10",
    previousPeriod: { start: "2026-09-21", end: "2026-09-30" },
    generatedAt,
    currency: "INR",
    performance: {
      source: { provider: "meta-ads", label: "Meta Ads", status: "INCLUDED", detail: "ok", executionIds: ["e1"], account: null },
      totalRows: [current],
      reachAdditive: true,
      previousRows: [previous],
      campaignRows: [],
    },
    otherSources: [],
    content: [],
  });
}

describe("every recommendation", () => {
  const set = buildMarketingRecommendations(
    base({
      content: [
        item({ id: "a", status: "READY", scheduledDate: "2026-10-10" }),
        item({ id: "b", publishUnconfirmed: true, status: "READY" }),
        item({ id: "c", status: "READY", channel: "INSTAGRAM", scheduledDate: null }),
      ],
    })
  );

  it("is marked as not executed, carries evidence and says what to do", () => {
    expect(set.recommendations.length).toBeGreaterThan(0);
    for (const rec of set.recommendations) {
      expect(rec.executed).toBe(false);
      expect(rec.evidence.length).toBeGreaterThan(0);
      expect(rec.rationale.length).toBeGreaterThan(0);
      expect(rec.suggestedAction.length).toBeGreaterThan(0);
    }
  });

  it("the set says once that nothing was changed", () => {
    expect(set.note).toContain("Nothing was changed, published or sent");
  });

  it("is ordered by priority", () => {
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    const ranks = set.recommendations.map((r) => order[r.priority]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it("the same workspace always yields the same advice", () => {
    expect(buildMarketingRecommendations(base())).toEqual(buildMarketingRecommendations(base()));
  });

  it("never returns more than the cap", () => {
    expect(set.recommendations.length).toBeLessThanOrEqual(RECOMMENDATION_THRESHOLDS.maxRecommendations);
  });
});

describe("publishing advice", () => {
  it("an unconfirmed publish is the first thing raised, and needs approval to retry", () => {
    const set = buildMarketingRecommendations(base({ content: [item({ status: "READY", publishUnconfirmed: true })] }));
    expect(set.recommendations[0]).toMatchObject({ id: "publish-unconfirmed", priority: "HIGH", needsApproval: true });
    expect(set.recommendations[0]!.evidence[0]).toContain("Offer post");
  });

  it("a ready, due item on a channel with a publisher can be published — with approval", () => {
    const set = buildMarketingRecommendations(base({ content: [item({ status: "READY", scheduledDate: TODAY })] }));
    const due = set.recommendations.find((r) => r.id === "publish-due")!;
    expect(due.needsApproval).toBe(true);
    expect(due.suggestedAction).toContain("only after you approve");
  });

  it("does not suggest publishing an item whose date has not arrived", () => {
    expect(ids(base({ content: [item({ status: "READY", scheduledDate: "2026-10-20" })] }))).not.toContain("publish-due");
  });

  it("does not suggest publishing where there is no publisher; says to post it by hand", () => {
    const input = base({ content: [item({ status: "READY", channel: "LINKEDIN", scheduledDate: TODAY })] });
    expect(ids(input)).not.toContain("publish-due");
    const manual = buildMarketingRecommendations(input).recommendations.find((r) => r.id === "publish-manual")!;
    expect(manual.rationale).toContain("LinkedIn");
    expect(manual.needsApproval).toBe(false);
  });

  it("with no publisher at all, nothing is offered for publishing", () => {
    const input = base({ publishableChannels: [], content: [item({ status: "READY", scheduledDate: TODAY })] });
    expect(ids(input)).not.toContain("publish-due");
  });

  it("a draft is never offered for publishing", () => {
    expect(ids(base({ content: [item({ status: "DRAFT", scheduledDate: TODAY })] }))).not.toContain("publish-due");
  });
});

describe("calendar advice", () => {
  it("flags an empty fortnight, HIGH for an active campaign", () => {
    const set = buildMarketingRecommendations(base({ content: [] }));
    const gap = set.recommendations.find((r) => r.id === "calendar-gap")!;
    expect(gap.priority).toBe("HIGH");
    expect(gap.evidence[0]).toBe("0 items dated 2026-10-12 to 2026-10-25");
  });

  it("is MEDIUM when the campaign is not active", () => {
    const set = buildMarketingRecommendations(base({ content: [], campaign: campaign({ status: "PLANNING", startDate: "2026-11-01" }) }));
    expect(set.recommendations.find((r) => r.id === "calendar-gap")!.priority).toBe("MEDIUM");
  });

  it("stays quiet when something is planned in the window", () => {
    expect(ids(base())).not.toContain("calendar-gap");
  });

  it("stays quiet for a campaign that is over, paused or archived", () => {
    for (const status of ["COMPLETED", "PAUSED", "ARCHIVED"] as const) {
      expect(ids(base({ content: [], campaign: campaign({ status }) }))).not.toContain("calendar-gap");
    }
    expect(ids(base({ content: [], campaign: campaign({ endDate: "2026-10-01", status: "ACTIVE" }) }))).not.toContain("calendar-gap");
  });

  it("an archived or already published item does not fill the calendar", () => {
    const published = item({
      status: "PUBLISHED",
      publication: { mode: "REPORTED_BY_USER", publishedAt: `${TODAY}T00:00:00.000Z`, provider: null, targetName: null, externalId: null, url: null, verifiedAt: null },
    });
    expect(ids(base({ content: [item({ status: "ARCHIVED" }), published] }))).toContain("calendar-gap");
  });

  it("flags items past their date, oldest first, and escalates at three", () => {
    const one = buildMarketingRecommendations(base({ content: [item({ scheduledDate: "2026-10-05" }), item({ id: "n", scheduledDate: "2026-10-14" })] }));
    expect(one.recommendations.find((r) => r.id === "calendar-overdue")!.priority).toBe("MEDIUM");

    const three = buildMarketingRecommendations(
      base({
        content: [
          item({ id: "a", title: "Third", scheduledDate: "2026-10-09" }),
          item({ id: "b", title: "First", scheduledDate: "2026-10-01" }),
          item({ id: "c", title: "Second", scheduledDate: "2026-10-05" }),
        ],
      })
    );
    const overdue = three.recommendations.find((r) => r.id === "calendar-overdue")!;
    expect(overdue.priority).toBe("HIGH");
    expect(overdue.evidence[0]).toContain("First");
  });

  it("an item dated today is not overdue", () => {
    expect(ids(base({ content: [item({ scheduledDate: TODAY })] }))).not.toContain("calendar-overdue");
  });
});

describe("content advice", () => {
  it("flags ready copy with no date", () => {
    expect(ids(base({ content: [item({ status: "READY", scheduledDate: null }), item({ id: "k" })] }))).toContain("content-ready-undated");
  });

  it("flags items planned this week that have no text", () => {
    const input = base({ content: [item({ body: "  ", scheduledDate: "2026-10-14" })] });
    expect(ids(input)).toContain("content-empty-soon");
  });

  it("does not flag an empty item that is weeks away", () => {
    const input = base({ content: [item({ body: "", scheduledDate: "2026-10-24" })] });
    expect(ids(input)).not.toContain("content-empty-soon");
  });
});

describe("campaign advice", () => {
  it("flags an active campaign whose end date has passed, with the dates as evidence", () => {
    const set = buildMarketingRecommendations(base({ campaign: campaign({ endDate: "2026-10-05" }) }));
    const ended = set.recommendations.find((r) => r.id === "campaign-ended")!;
    expect(ended.evidence).toEqual(["End date: 2026-10-05", "Status: ACTIVE", "Today: 2026-10-12"]);
  });

  it("flags a campaign still in planning after its start date", () => {
    expect(ids(base({ campaign: campaign({ status: "PLANNING" }) }))).toContain("campaign-started");
  });

  it("flags a missing objective and a channel with no content", () => {
    const input = base({ campaign: campaign({ objective: null, channels: ["FACEBOOK", "LINKEDIN"] }) });
    const found = ids(input);
    expect(found).toContain("campaign-no-objective");
    const gap = buildMarketingRecommendations(input).recommendations.find((r) => r.id === "campaign-channel-gap")!;
    expect(gap.title).toBe("No content exists for LinkedIn");
  });

  it("gives no campaign advice when there is no campaign", () => {
    const found = ids(base({ campaign: null }));
    expect(found.filter((id) => id.startsWith("campaign-"))).toEqual([]);
  });
});

describe("performance advice comes only from a saved report", () => {
  it("says nothing about performance without one", () => {
    expect(ids(base()).filter((id) => id.startsWith("performance-"))).toEqual([]);
  });

  it("flags a click-through-rate fall, quoting both periods, as a hypothesis that needs approval to act on", () => {
    const set = buildMarketingRecommendations(base({ latestReport: report(row({ clicks: 140 }), row({ clicks: 200 })) }));
    const ctr = set.recommendations.find((r) => r.id === "performance-ctr-drop")!;
    expect(ctr.title).toBe("Click-through rate fell 30.0% against the previous period");
    expect(ctr.evidence[0]).toContain("2.00% → 1.40%");
    expect(ctr.rationale).toContain("hypothesis");
    expect(ctr.needsApproval).toBe(true);
  });

  it("does not flag a rate change on too few impressions", () => {
    const tiny = report(row({ impressions: 500, clicks: 5 }), row({ impressions: 500, clicks: 20 }));
    expect(ids(base({ latestReport: tiny }))).not.toContain("performance-ctr-drop");
  });

  it("does not flag a fall below the threshold", () => {
    expect(ids(base({ latestReport: report(row({ clicks: 180 }), row({ clicks: 200 })) }))).not.toContain("performance-ctr-drop");
  });

  it("flags a cost-per-click rise", () => {
    expect(ids(base({ latestReport: report(row({ spend: 140 }), row({ spend: 100 })) }))).toContain("performance-cpc-rise");
  });

  it("flags spend rising while conversions do not, as HIGH", () => {
    const set = buildMarketingRecommendations(base({ latestReport: report(row({ spend: 150, conversions: 20 }), row({ spend: 100, conversions: 20 })) }));
    expect(set.recommendations.find((r) => r.id === "performance-spend-up-conversions-flat")!.priority).toBe("HIGH");
  });

  it("does not flag spend rising when conversions rose too", () => {
    const input = base({ latestReport: report(row({ spend: 150, conversions: 35 }), row({ spend: 100, conversions: 20 })) });
    expect(ids(input)).not.toContain("performance-spend-up-conversions-flat");
  });

  it("draws no conclusion about conversions the provider never reported", () => {
    const input = base({ latestReport: report(row({ spend: 150, conversions: null }), row({ spend: 100, conversions: null })) });
    const found = ids(input);
    expect(found).not.toContain("performance-spend-up-conversions-flat");
    expect(found).not.toContain("performance-low-volume");
  });

  it("says when there are too few conversions to judge cost", () => {
    expect(ids(base({ latestReport: report(row({ conversions: 4 }), row({ conversions: 4 })) }))).toContain("performance-low-volume");
  });

  it("says when the report itself is old", () => {
    const old = report(row(), row(), "2026-08-01T00:00:00.000Z");
    const stale = buildMarketingRecommendations(base({ latestReport: old })).recommendations.find((r) => r.id === "report-stale")!;
    expect(stale.title).toBe("The latest report is 72 days old");
  });

  it("suggests a first report when there is none", () => {
    expect(ids(base())).toContain("report-none");
  });
});

describe("SEO advice comes only from saved audits", () => {
  const audit = (html: string) =>
    auditPage(extractPageFacts(html, "https://shop.example/"), {
      finalUrl: "https://shop.example/",
      requestedUrl: "https://shop.example/",
      httpStatus: 200,
      truncated: false,
    });

  it("says nothing about SEO without one", () => {
    expect(ids(base()).filter((id) => id.startsWith("seo-"))).toEqual([]);
  });

  it("raises a critical finding as HIGH and quotes what the audit found", () => {
    const input = base({
      seoAudits: [{ host: "shop.example", url: "https://shop.example/", fetchedAt: `${TODAY}T00:00:00.000Z`, audit: audit('<meta name="robots" content="noindex"><h1>Shop</h1>') }],
    });
    const seo = buildMarketingRecommendations(input).recommendations.find((r) => r.id === "seo-issues-shop.example")!;
    expect(seo.priority).toBe("HIGH");
    expect(seo.evidence.join("\n")).toContain("noindex");
  });

  it("uses only the newest audit of each host", () => {
    const newest = audit("<title>A perfectly reasonable title for this page</title>");
    const older = audit('<meta name="robots" content="noindex">');
    const input = base({
      seoAudits: [
        { host: "shop.example", url: "https://shop.example/", fetchedAt: `${TODAY}T00:00:00.000Z`, audit: newest },
        { host: "shop.example", url: "https://shop.example/", fetchedAt: "2026-09-01T00:00:00.000Z", audit: older },
      ],
    });
    const seo = buildMarketingRecommendations(input).recommendations.filter((r) => r.id === "seo-issues-shop.example");
    expect(seo).toHaveLength(1);
    expect(seo[0]!.evidence.join("\n")).not.toContain("noindex");
  });

  it("says when an audit is old enough to repeat", () => {
    const input = base({
      seoAudits: [{ host: "shop.example", url: "https://shop.example/", fetchedAt: "2026-06-01T00:00:00.000Z", audit: audit("<p>x</p>") }],
    });
    expect(ids(input)).toContain("seo-stale-shop.example");
  });
});

describe("what the advice was based on", () => {
  it("is stated with the set", () => {
    const set = buildMarketingRecommendations(base({ content: [item(), item({ id: "2" })] }));
    expect(set.basis).toEqual({ campaign: "Diwali Sale", contentItems: 2, hasReport: false, seoAudits: 0 });
    expect(set.generatedAt).toBe(TODAY);
  });
});
