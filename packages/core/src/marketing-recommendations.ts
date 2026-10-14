// ---------------------------------------------------------------------------
// Phase 15 — marketing recommendations, as pure rules.
//
// A RECOMMENDATION IS ADVICE WITH ITS REASONS ATTACHED. Every one produced
// here names the facts it rests on (`evidence`), each read from the workspace
// or from a saved report or audit, and carries `executed: false` — the literal
// type — because producing a recommendation changes nothing anywhere.
//
// RULES, NOT A MODEL. The same workspace always yields the same advice, and
// every threshold is a named constant below that a person can read and argue
// with. A model may explain these to the user; it does not get to invent one.
//
// This is NOT the Meta optimisation pipeline. That one (Phase 11: anomaly →
// diagnosis → PROPOSED recommendation → approval → execution) proposes
// specific changes to specific ads and is reached through `meta.analyze`. The
// rules here look at the workspace — the calendar, the content, the campaign's
// own dates, the last report, the last audits — and point at what deserves
// attention. Where the advice is "change an ad", it says an approval is needed
// and sends the user to that pipeline; it never performs the change.
// ---------------------------------------------------------------------------

import { channelLabel } from "./marketing-content.js";
import {
  inclusiveDays,
  shiftCalendarDate,
  type ContentItemView,
  type MarketingCampaignView,
  type MarketingChannel,
  type MarketingRecommendation,
  type MarketingRecommendationArea,
  type MarketingRecommendationPriority,
  type MarketingRecommendationSet,
  type MarketingReportDocument,
  type SeoAudit,
} from "./types/marketing.js";

/** The thresholds every rule below reads. Change one here, with a test. */
export const RECOMMENDATION_THRESHOLDS = Object.freeze({
  /** How far ahead the calendar is checked for content. */
  planningHorizonDays: 14,
  /** How soon a dated item with no text becomes worth flagging. */
  emptyCopyWarningDays: 7,
  /** A report older than this is worth refreshing. */
  staleReportDays: 30,
  /** An audit older than this is worth repeating. */
  staleAuditDays: 90,
  /** Below this many impressions in either period, a rate change is noise. */
  minImpressionsForRateChange: 1000,
  /** A click-through-rate fall of at least this much, relative, is flagged. */
  ctrDropPct: 20,
  /** A cost-per-click rise of at least this much, relative, is flagged. */
  cpcRisePct: 25,
  /** A spend rise of at least this much, with conversions not rising, is flagged. */
  spendRisePct: 20,
  /** Fewer conversions than this cannot support a conclusion about cost. */
  minConversionsForConclusion: 10,
  maxRecommendations: 12,
});

export interface RecommendationInputs {
  /** YYYY-MM-DD, the server's date. */
  today: string;
  /** The campaign the advice is about. Null: everything in scope. */
  campaign: MarketingCampaignView | null;
  content: readonly ContentItemView[];
  /** Channels this deployment has a real publisher for. */
  publishableChannels: readonly MarketingChannel[];
  latestReport: MarketingReportDocument | null;
  /** The most recent audit of each host, newest first. */
  seoAudits: ReadonlyArray<{ host: string; url: string; fetchedAt: string; audit: SeoAudit }>;
}

const PRIORITY_ORDER: Readonly<Record<MarketingRecommendationPriority, number>> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const AREA_ORDER: Readonly<Record<MarketingRecommendationArea, number>> = {
  PUBLISHING: 0,
  CALENDAR: 1,
  CONTENT: 2,
  CAMPAIGN: 3,
  PERFORMANCE: 4,
  SEO: 5,
  REPORTING: 6,
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function titles(items: readonly ContentItemView[], max = 3): string[] {
  const shown = items.slice(0, max).map((item) => `"${item.title}"${item.scheduledDate ? ` (${item.scheduledDate})` : ""}`);
  if (items.length > max) shown.push(`and ${items.length - max} more`);
  return shown;
}

function channelNames(channels: readonly MarketingChannel[]): string {
  return [...new Set(channels)].map(channelLabel).join(", ");
}

/**
 * Derive the recommendations for a workspace.
 *
 * Pure and deterministic. Nothing here reads a clock, a database or a
 * provider: `today` and every fact arrive as arguments.
 */
export function buildMarketingRecommendations(input: RecommendationInputs): MarketingRecommendationSet {
  const T = RECOMMENDATION_THRESHOLDS;
  const out: MarketingRecommendation[] = [];
  const add = (rec: Omit<MarketingRecommendation, "executed">): void => {
    out.push({ ...rec, executed: false });
  };

  const live = input.content.filter((item) => item.status !== "ARCHIVED");
  const unpublished = live.filter((item) => item.publication === null && item.status !== "PUBLISHED");
  const campaignActive = input.campaign?.status === "ACTIVE";

  // --- publishing -----------------------------------------------------------
  const unconfirmed = unpublished.filter((item) => item.publishUnconfirmed);
  if (unconfirmed.length > 0) {
    add({
      id: "publish-unconfirmed",
      area: "PUBLISHING",
      priority: "HIGH",
      title: `${plural(unconfirmed.length, "publish attempt has", "publish attempts have")} an unknown outcome`,
      rationale:
        "A publish request was sent and JARVIS could not confirm whether the post went out. Until that is settled the item is not marked as published.",
      evidence: titles(unconfirmed),
      suggestedAction:
        "Look at the Page to see whether the post is there. Publishing again first checks the Page for the post and will not post it a second time if it is found.",
      needsApproval: true,
    });
  }

  const readyUnpublished = unpublished.filter((item) => item.status === "READY" && !item.publishUnconfirmed);
  const dueAndPublishable = readyUnpublished.filter(
    (item) =>
      input.publishableChannels.includes(item.channel) &&
      item.scheduledDate !== null &&
      item.scheduledDate <= input.today
  );
  if (dueAndPublishable.length > 0) {
    add({
      id: "publish-due",
      area: "PUBLISHING",
      priority: "MEDIUM",
      title: `${plural(dueAndPublishable.length, "ready item is", "ready items are")} due and can be published`,
      rationale: "These items are marked ready, their planned date has arrived, and JARVIS has a publishing connection for their channel.",
      evidence: titles(dueAndPublishable),
      suggestedAction: "Ask to publish one. JARVIS will show you exactly what will be posted and where, and posts only after you approve.",
      needsApproval: true,
    });
  }

  const readyNoPublisher = readyUnpublished.filter((item) => !input.publishableChannels.includes(item.channel));
  if (readyNoPublisher.length > 0) {
    add({
      id: "publish-manual",
      area: "PUBLISHING",
      priority: "LOW",
      title: `${plural(readyNoPublisher.length, "ready item is", "ready items are")} for a channel JARVIS cannot publish to`,
      rationale: `JARVIS has no publishing connection for ${channelNames(readyNoPublisher.map((item) => item.channel))}.`,
      evidence: titles(readyNoPublisher),
      suggestedAction: "Post these yourself, then mark them as published so the calendar and reports reflect it.",
      needsApproval: false,
    });
  }

  // --- calendar -------------------------------------------------------------
  const horizonEnd = shiftCalendarDate(input.today, T.planningHorizonDays - 1);
  const upcoming = unpublished.filter(
    (item) => item.scheduledDate !== null && item.scheduledDate >= input.today && item.scheduledDate <= horizonEnd
  );
  const campaignRunsInHorizon =
    input.campaign === null ||
    ((input.campaign.endDate === null || input.campaign.endDate >= input.today) &&
      input.campaign.status !== "COMPLETED" &&
      input.campaign.status !== "ARCHIVED" &&
      input.campaign.status !== "PAUSED");
  if (upcoming.length === 0 && campaignRunsInHorizon) {
    const lastDated = unpublished
      .filter((item) => item.scheduledDate !== null)
      .map((item) => item.scheduledDate!)
      .sort()
      .pop();
    add({
      id: "calendar-gap",
      area: "CALENDAR",
      priority: campaignActive ? "HIGH" : "MEDIUM",
      title: `Nothing is planned for the next ${T.planningHorizonDays} days`,
      rationale: "The calendar has no unpublished content dated in the coming two weeks.",
      evidence: [
        `0 items dated ${input.today} to ${horizonEnd}`,
        lastDated ? `The latest dated item is on ${lastDated}` : "No unpublished item has a date at all",
      ],
      suggestedAction: "Ask for a content plan for the period, review it, and save the posts you want onto the calendar.",
      needsApproval: false,
    });
  }

  const overdue = unpublished.filter((item) => item.scheduledDate !== null && item.scheduledDate < input.today);
  if (overdue.length > 0) {
    add({
      id: "calendar-overdue",
      area: "CALENDAR",
      priority: overdue.length >= 3 ? "HIGH" : "MEDIUM",
      title: `${plural(overdue.length, "item is", "items are")} past the planned date and not published`,
      rationale: "A planned date that has passed with nothing published leaves the calendar describing a plan that did not happen.",
      evidence: titles([...overdue].sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""))),
      suggestedAction: "For each one: publish it, move it to a new date, or archive it. If you already posted it yourself, mark it as published.",
      needsApproval: false,
    });
  }

  // --- content --------------------------------------------------------------
  const readyUndated = readyUnpublished.filter((item) => item.scheduledDate === null);
  if (readyUndated.length > 0) {
    add({
      id: "content-ready-undated",
      area: "CONTENT",
      priority: "LOW",
      title: `${plural(readyUndated.length, "ready item has", "ready items have")} no date`,
      rationale: "Finished copy that is not on the calendar is easy to lose track of.",
      evidence: titles(readyUndated),
      suggestedAction: "Give each one a date, or publish it now.",
      needsApproval: false,
    });
  }

  const copyDeadline = shiftCalendarDate(input.today, T.emptyCopyWarningDays - 1);
  const emptySoon = unpublished.filter(
    (item) =>
      item.body.trim().length === 0 &&
      item.scheduledDate !== null &&
      item.scheduledDate >= input.today &&
      item.scheduledDate <= copyDeadline
  );
  if (emptySoon.length > 0) {
    add({
      id: "content-empty-soon",
      area: "CONTENT",
      priority: "MEDIUM",
      title: `${plural(emptySoon.length, "item planned", "items planned")} for the next ${T.emptyCopyWarningDays} days ${emptySoon.length === 1 ? "has" : "have"} no text yet`,
      rationale: "These are on the calendar for this week and still have nothing written.",
      evidence: titles(emptySoon),
      suggestedAction: "Write the copy, or ask JARVIS to draft it for you to review.",
      needsApproval: false,
    });
  }

  // --- campaign -------------------------------------------------------------
  const campaign = input.campaign;
  if (campaign) {
    if (campaign.status === "ACTIVE" && campaign.endDate !== null && campaign.endDate < input.today) {
      add({
        id: "campaign-ended",
        area: "CAMPAIGN",
        priority: "MEDIUM",
        title: "The campaign's end date has passed and it is still marked active",
        rationale: "A campaign that is over but still active keeps appearing as current work.",
        evidence: [`End date: ${campaign.endDate}`, `Status: ${campaign.status}`, `Today: ${input.today}`],
        suggestedAction: "Mark the campaign completed, or move its end date if it is still running.",
        needsApproval: false,
      });
    }
    if (campaign.status === "PLANNING" && campaign.startDate !== null && campaign.startDate <= input.today) {
      add({
        id: "campaign-started",
        area: "CAMPAIGN",
        priority: "MEDIUM",
        title: "The campaign's start date has arrived and it is still in planning",
        rationale: "The dates say the campaign should be running; the status says it has not begun.",
        evidence: [`Start date: ${campaign.startDate}`, `Status: ${campaign.status}`, `Today: ${input.today}`],
        suggestedAction: "Mark the campaign active, or move its start date.",
        needsApproval: false,
      });
    }
    if (campaign.objective === null) {
      add({
        id: "campaign-no-objective",
        area: "CAMPAIGN",
        priority: "LOW",
        title: "The campaign has no objective recorded",
        rationale: "Without a stated objective there is nothing to judge the content plan or the results against.",
        evidence: ["The objective field is empty"],
        suggestedAction: "Add a one-sentence objective — what this campaign is meant to achieve.",
        needsApproval: false,
      });
    }
    const planned = new Set(live.map((item) => item.channel));
    const silent = campaign.channels.filter((channel) => !planned.has(channel));
    if (silent.length > 0 && campaign.status !== "COMPLETED" && campaign.status !== "ARCHIVED") {
      add({
        id: "campaign-channel-gap",
        area: "CAMPAIGN",
        priority: "LOW",
        title: `No content exists for ${channelNames(silent)}`,
        rationale: "These are listed as the campaign's channels, but nothing has been planned for them.",
        evidence: [`Campaign channels: ${channelNames(campaign.channels)}`, `Channels with content: ${channelNames([...planned]) || "none"}`],
        suggestedAction: "Plan content for the missing channels, or remove them from the campaign.",
        needsApproval: false,
      });
    }
  }

  // --- performance, from the saved report -----------------------------------
  const report = input.latestReport;
  if (report && report.totals) {
    const change = (metric: string) => report.changes.find((entry) => entry.metric === metric);
    const impressions = change("impressions");
    const enoughVolume =
      impressions !== undefined &&
      impressions.current !== null &&
      impressions.previous !== null &&
      impressions.current >= T.minImpressionsForRateChange &&
      impressions.previous >= T.minImpressionsForRateChange;
    const period = `${report.period.start} to ${report.period.end}`;

    const ctr = change("ctr");
    if (enoughVolume && ctr && ctr.relativePct !== null && ctr.relativePct <= -T.ctrDropPct) {
      add({
        id: "performance-ctr-drop",
        area: "PERFORMANCE",
        priority: "MEDIUM",
        title: `Click-through rate fell ${Math.abs(ctr.relativePct).toFixed(1)}% against the previous period`,
        rationale: "Fewer of the people who saw the ads clicked them. That can point to creative or audience fatigue; it is a hypothesis to check, not a proven cause.",
        evidence: [
          `CTR ${ctr.previous!.toFixed(2)}% → ${ctr.current!.toFixed(2)}% (${period})`,
          `Impressions ${Math.round(impressions!.previous!)} → ${Math.round(impressions!.current!)}`,
        ],
        suggestedAction: "Ask for an analysis of the ad account to find which campaign moved. Any change to an ad is proposed for your approval first.",
        needsApproval: true,
      });
    }

    const cpc = change("cpc");
    if (enoughVolume && cpc && cpc.relativePct !== null && cpc.relativePct >= T.cpcRisePct) {
      add({
        id: "performance-cpc-rise",
        area: "PERFORMANCE",
        priority: "MEDIUM",
        title: `Cost per click rose ${cpc.relativePct.toFixed(1)}% against the previous period`,
        rationale: "Each click cost more than it did in the period before.",
        evidence: [`Cost per click ${cpc.previous!.toFixed(2)} → ${cpc.current!.toFixed(2)} (${period})`],
        suggestedAction: "Ask for an analysis of the ad account before changing any budget. A budget or status change is proposed for your approval first.",
        needsApproval: true,
      });
    }

    const spend = change("spend");
    const conversions = change("conversions");
    if (
      spend &&
      spend.relativePct !== null &&
      spend.relativePct >= T.spendRisePct &&
      conversions &&
      conversions.current !== null &&
      conversions.previous !== null &&
      conversions.previous >= T.minConversionsForConclusion &&
      conversions.current <= conversions.previous
    ) {
      add({
        id: "performance-spend-up-conversions-flat",
        area: "PERFORMANCE",
        priority: "HIGH",
        title: `Spend rose ${spend.relativePct.toFixed(1)}% while conversions did not rise`,
        rationale: "More was spent for the same or fewer results than in the period before.",
        evidence: [
          `Spend ${spend.previous!.toFixed(2)} → ${spend.current!.toFixed(2)} (${period})`,
          `Conversions ${conversions.previous} → ${conversions.current}`,
        ],
        suggestedAction: "Ask for an analysis of the ad account to find where the extra spend went. Any budget change is proposed for your approval first.",
        needsApproval: true,
      });
    }

    if (
      report.metricsReported.conversions &&
      report.totals.conversions < T.minConversionsForConclusion &&
      report.totals.spend > 0
    ) {
      add({
        id: "performance-low-volume",
        area: "PERFORMANCE",
        priority: "LOW",
        title: "Too few conversions to judge cost per conversion",
        rationale: `With fewer than ${T.minConversionsForConclusion} conversions, one result more or less moves the cost figure a great deal.`,
        evidence: [`${report.totals.conversions} conversions reported for ${period}`],
        suggestedAction: "Look at a longer period before drawing a conclusion about cost per conversion.",
        needsApproval: false,
      });
    }
  }

  // --- SEO, from saved audits -----------------------------------------------
  const seenHosts = new Set<string>();
  for (const entry of input.seoAudits) {
    if (seenHosts.has(entry.host)) continue;
    seenHosts.add(entry.host);
    const failing = entry.audit.checks.filter((check) => check.severity === "critical" || check.severity === "warning");
    const critical = entry.audit.counts.critical;
    if (failing.length > 0) {
      add({
        id: `seo-issues-${entry.host}`,
        area: "SEO",
        priority: critical > 0 ? "HIGH" : "MEDIUM",
        title: `The audit of ${entry.host} found ${plural(failing.length, "issue", "issues")} to fix`,
        rationale:
          critical > 0
            ? "At least one of them can keep the page out of search results altogether."
            : "These are on-page basics that are missing or outside the usual guidance.",
        evidence: failing.slice(0, 4).map((check) => `${check.label}: ${check.finding}`),
        suggestedAction: "Fix these on the page, then run the audit again to confirm.",
        needsApproval: false,
      });
    }
    const age = inclusiveDays(entry.fetchedAt.slice(0, 10), input.today) - 1;
    if (age > T.staleAuditDays) {
      add({
        id: `seo-stale-${entry.host}`,
        area: "SEO",
        priority: "LOW",
        title: `The audit of ${entry.host} is ${age} days old`,
        rationale: "The page may have changed since it was read.",
        evidence: [`Last audited ${entry.fetchedAt.slice(0, 10)}`],
        suggestedAction: "Run the audit again.",
        needsApproval: false,
      });
    }
  }

  // --- reporting ------------------------------------------------------------
  if (report === null) {
    if (campaignActive || live.length > 0) {
      add({
        id: "report-none",
        area: "REPORTING",
        priority: "LOW",
        title: "No report has been generated yet",
        rationale: "A report records what the data said at a point in time, so later periods have something to be compared with.",
        evidence: ["0 saved reports in this scope"],
        suggestedAction: "Ask for a performance report for the last 30 days.",
        needsApproval: false,
      });
    }
  } else {
    const age = inclusiveDays(report.generatedAt.slice(0, 10), input.today) - 1;
    if (age > T.staleReportDays) {
      add({
        id: "report-stale",
        area: "REPORTING",
        priority: "LOW",
        title: `The latest report is ${age} days old`,
        rationale: "Recommendations about performance here are based on that report, so they describe an old period.",
        evidence: [`Generated ${report.generatedAt.slice(0, 10)} for ${report.period.start} to ${report.period.end}`],
        suggestedAction: "Generate a new report for a recent period.",
        needsApproval: false,
      });
    }
  }

  out.sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      AREA_ORDER[a.area] - AREA_ORDER[b.area] ||
      a.id.localeCompare(b.id)
  );

  return {
    generatedAt: input.today,
    basis: {
      campaign: input.campaign?.name ?? null,
      contentItems: input.content.length,
      hasReport: report !== null,
      seoAudits: seenHosts.size,
    },
    recommendations: out.slice(0, T.maxRecommendations),
    note:
      "These are recommendations based on what is in the workspace. Nothing was changed, published or sent by producing them.",
  };
}
