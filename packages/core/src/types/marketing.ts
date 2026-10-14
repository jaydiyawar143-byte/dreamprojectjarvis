// ---------------------------------------------------------------------------
// Phase 15 — the Marketing Operating System contracts.
//
// WHAT THIS FILE IS. The vocabulary every layer of the marketing workspace
// speaks: campaigns, content items, the calendar, research, reports and
// publishing. Types, Zod schemas and constants only — no I/O, like the rest of
// `packages/core`.
//
// FOUR THINGS THE SHAPES THEMSELVES GUARANTEE.
//
//   1. A VIEW NEVER CARRIES AN OWNER. No `userId` appears in anything a client
//      or a model is shown. The caller already is that user.
//
//   2. PLANNED IS NOT PUBLISHED. A content item has a date it is planned for
//      and, separately, a `publication` record. Nothing sets `publication`
//      except a publish that was read back from the provider (VERIFIED) or the
//      user saying they posted it themselves (REPORTED_BY_USER) — and the two
//      are never the same value, so a screen can never show one as the other.
//
//   3. A DATE ON THE CALENDAR IS A PLAN, NOT A TRIGGER. `scheduledDate` is a
//      calendar date and `scheduledTime` a wall-clock label. Neither is an
//      instant, on purpose: this application has no user-timezone system, and
//      nothing here runs at that time. Publishing is always a person's
//      decision, taken when they take it.
//
//   4. NOTHING HERE IS A NUMBER JARVIS MADE UP. Research and report shapes
//      carry where each fact came from (`fetchedAt`, `httpStatus`, a provider
//      section's `status`), and a source that could not be read is recorded as
//      not read rather than left out.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { CalculatedKPIs } from "../kpi-engine.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const MARKETING_CHANNELS = [
  "FACEBOOK",
  "INSTAGRAM",
  "LINKEDIN",
  "X",
  "YOUTUBE",
  "WHATSAPP",
  "EMAIL",
  "BLOG",
  "OTHER",
] as const;
export const MarketingChannelSchema = z.enum(MARKETING_CHANNELS);
export type MarketingChannel = z.infer<typeof MarketingChannelSchema>;

export const CONTENT_FORMATS = [
  "POST",
  "IMAGE",
  "CAROUSEL",
  "REEL",
  "STORY",
  "VIDEO",
  "ARTICLE",
  "EMAIL",
  "OTHER",
] as const;
export const ContentFormatSchema = z.enum(CONTENT_FORMATS);
export type ContentFormat = z.infer<typeof ContentFormatSchema>;

/**
 * Where a content item is in its life.
 *
 *   IDEA       a thought worth keeping
 *   DRAFT      copy exists and is still being worked on
 *   READY      the copy is final; it may be published
 *   PUBLISHED  it is out — see `ContentPublication` for how that is known
 *   ARCHIVED   set aside; kept, never shown on the calendar
 *
 * READY exists so that publishing has something to refuse: an item that is
 * still a draft cannot even be proposed for publishing.
 */
export const CONTENT_STATUSES = ["IDEA", "DRAFT", "READY", "PUBLISHED", "ARCHIVED"] as const;
export const ContentStatusSchema = z.enum(CONTENT_STATUSES);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

/** The statuses a person or an agent may set directly. PUBLISHED is never one. */
export const SETTABLE_CONTENT_STATUSES = ["IDEA", "DRAFT", "READY", "ARCHIVED"] as const;
export type SettableContentStatus = (typeof SETTABLE_CONTENT_STATUSES)[number];

export const CAMPAIGN_STATUSES = ["PLANNING", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"] as const;
export const CampaignStatusSchema = z.enum(CAMPAIGN_STATUSES);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

/**
 * The durable state of an attempt to publish, kept on the content row.
 *
 *   NONE         nothing is in flight
 *   PUBLISHING   one execution holds the item; no second one may start
 *   UNCONFIRMED  a request was sent and its outcome is not known. The item is
 *                NOT published, cannot be edited, and NOTHING is sent for it
 *                again while it is in this state: a retry only looks for the
 *                earlier post. It leaves this state when that post is found
 *                and read back, or when a person settles it.
 */
export const CONTENT_PUBLISH_STATES = ["NONE", "PUBLISHING", "UNCONFIRMED"] as const;
export type ContentPublishState = (typeof CONTENT_PUBLISH_STATES)[number];

export const RESEARCH_KINDS = ["SEO_AUDIT", "COMPETITOR_SNAPSHOT"] as const;
export type MarketingResearchKind = (typeof RESEARCH_KINDS)[number];

export const REPORT_KINDS = ["PERFORMANCE", "CLIENT"] as const;
export const ReportKindSchema = z.enum(REPORT_KINDS);
export type MarketingReportKind = z.infer<typeof ReportKindSchema>;

// ---------------------------------------------------------------------------
// Limits — one table, read by the schemas below, the repository and the tools
// ---------------------------------------------------------------------------

export const MARKETING_LIMITS = Object.freeze({
  campaignsPerUser: 200,
  campaignNameMax: 120,
  campaignObjectiveMax: 300,
  campaignBriefMax: 4000,
  linkedMetaCampaignsMax: 25,
  contentPerUser: 5000,
  contentTitleMax: 160,
  contentBodyMax: 5000,
  contentNotesMax: 2000,
  linkMax: 2048,
  /** How many items one planning call may save. */
  planBatchMax: 30,
  /** The widest calendar window one read may ask for. */
  calendarRangeDaysMax: 366,
  listMax: 100,
  reportsPerUser: 500,
  reportTitleMax: 160,
  /**
   * The longest period one report may cover, in days, first and last included.
   * It is the widest window the ad-account read accepts in one call, so a
   * report can never ask for a period its own data source would refuse.
   */
  reportPeriodDaysMax: 90,
  researchPerUser: 1000,
});

/** How long a PUBLISHING claim may be held before it is treated as abandoned. */
export const CONTENT_PUBLISH_CLAIM_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tool ids
// ---------------------------------------------------------------------------

export const MARKETING_TOOL_IDS = Object.freeze({
  campaignCreate: "marketing.campaign.create",
  campaignUpdate: "marketing.campaign.update",
  campaignList: "marketing.campaign.list",
  campaignGet: "marketing.campaign.get",
  contentPlan: "marketing.content.plan",
  contentUpdate: "marketing.content.update",
  contentList: "marketing.content.list",
  contentMarkPublished: "marketing.content.mark_published",
  publishPrepare: "marketing.publish.prepare",
  contentPublish: "marketing.content.publish",
  publishResolve: "marketing.publish.resolve",
  seoAudit: "marketing.seo.audit",
  competitorAnalyze: "marketing.competitor.analyze",
  researchList: "marketing.research.list",
  reportGenerate: "marketing.report.generate",
  reportList: "marketing.report.list",
  reportGet: "marketing.report.get",
  recommendations: "marketing.recommendations",
} as const);

export type MarketingToolId = (typeof MARKETING_TOOL_IDS)[keyof typeof MARKETING_TOOL_IDS];

/**
 * Reads: of JARVIS's own marketing store, and — for `report.generate` — of the
 * connected ad account.
 *
 * `report.generate` is here and not with the writes for the reason
 * `meta.analyze` is granted with the Meta reads: it changes nothing anywhere
 * outside JARVIS, and what it saves is a bounded record of its own analysis.
 * It matters in practice. A report is asked for as a question at least as
 * often as an order ("can I get last month's report?"), and a tool that
 * counted as a write would be refused on every one of those by the gate that
 * stops unrequested writes.
 */
export const MARKETING_READ_TOOL_IDS: readonly string[] = Object.freeze([
  MARKETING_TOOL_IDS.campaignList,
  MARKETING_TOOL_IDS.campaignGet,
  MARKETING_TOOL_IDS.contentList,
  MARKETING_TOOL_IDS.researchList,
  MARKETING_TOOL_IDS.reportGenerate,
  MARKETING_TOOL_IDS.reportList,
  MARKETING_TOOL_IDS.reportGet,
  MARKETING_TOOL_IDS.recommendations,
]);

/**
 * Writes to JARVIS's own marketing store: a campaign workspace, a content
 * item, a date, a status. Nothing leaves JARVIS — no provider is changed,
 * nothing is sent, nothing is spent — and saving is never publishing.
 */
export const MARKETING_WORKSPACE_TOOL_IDS: readonly string[] = Object.freeze([
  MARKETING_TOOL_IDS.campaignCreate,
  MARKETING_TOOL_IDS.campaignUpdate,
  MARKETING_TOOL_IDS.contentPlan,
  MARKETING_TOOL_IDS.contentUpdate,
  MARKETING_TOOL_IDS.contentMarkPublished,
]);

/** Reads of public web pages. Registered only where page research is switched on. */
export const MARKETING_RESEARCH_TOOL_IDS: readonly string[] = Object.freeze([
  MARKETING_TOOL_IDS.seoAudit,
  MARKETING_TOOL_IDS.competitorAnalyze,
]);

/**
 * Publishing. `publish.prepare` is a read; `content.publish` changes something
 * outside JARVIS and is approval-gated. Registered only where a publisher exists.
 */
export const MARKETING_PUBLISH_TOOL_IDS: readonly string[] = Object.freeze([
  MARKETING_TOOL_IDS.publishPrepare,
  MARKETING_TOOL_IDS.contentPublish,
]);

/**
 * A person's decision about an unconfirmed publish.
 *
 * `publish.resolve` is how an item leaves UNCONFIRMED when the earlier post
 * could not be found: a person says it is not on the Page, JARVIS looks once
 * more, and only then is the attempt cleared. It is on NO agent's allowlist —
 * a model can ask for a publish, never decide that an earlier one did not
 * happen — and is reached from the Marketing page alone. Registered with the
 * publish tools.
 */
export const MARKETING_DECISION_TOOL_IDS: readonly string[] = Object.freeze([
  MARKETING_TOOL_IDS.publishResolve,
]);

export const ALL_MARKETING_TOOL_IDS: readonly string[] = Object.freeze([
  ...MARKETING_READ_TOOL_IDS,
  ...MARKETING_WORKSPACE_TOOL_IDS,
  ...MARKETING_RESEARCH_TOOL_IDS,
  ...MARKETING_PUBLISH_TOOL_IDS,
  ...MARKETING_DECISION_TOOL_IDS,
]);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Why a marketing operation did not happen.
 *
 *   NOT_FOUND        no such thing in the caller's scope. Another user's row,
 *                    another project's row and an unknown id are one answer.
 *   INVALID          the input cannot be used as given
 *   LIMIT            a bound in MARKETING_LIMITS was reached
 *   CONFLICT         the thing is not in a state that allows this
 *   OUT_OF_SCOPE     the conversation belongs to a different project
 *   UNAVAILABLE      this deployment cannot do it, and why
 *   PROVIDER_FAILED  a provider or a page could not be read
 *   RATE_LIMITED     the caller has done this too often for now. Nothing was
 *                    attempted; trying again later is the only remedy.
 */
export type MarketingErrorCode =
  | "NOT_FOUND"
  | "INVALID"
  | "LIMIT"
  | "CONFLICT"
  | "OUT_OF_SCOPE"
  | "UNAVAILABLE"
  | "PROVIDER_FAILED"
  | "RATE_LIMITED";

export type MarketingResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: MarketingErrorCode; message: string };

export function marketingOk<T>(value: T): MarketingResult<T> {
  return { ok: true, value };
}

export function marketingFail<T = never>(code: MarketingErrorCode, message: string): MarketingResult<T> {
  return { ok: false, code, message };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Which of the caller's own marketing rows an operation may see.
 *
 *   ALL       every row the user owns — the dashboard with no project chosen
 *   PROJECT   the rows of ONE of the user's projects
 *   PERSONAL  the rows that belong to no project
 *
 * It is always written BESIDE the user filter, never instead of it. A
 * conversation decides its own scope (its project, or PERSONAL), so a model
 * cannot name another one.
 */
export type MarketingScope =
  | { kind: "ALL" }
  | { kind: "PROJECT"; projectId: string }
  | { kind: "PERSONAL" };

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface MarketingCampaignView {
  id: string;
  name: string;
  objective: string | null;
  brief: string | null;
  status: CampaignStatus;
  channels: MarketingChannel[];
  /** YYYY-MM-DD, or null. */
  startDate: string | null;
  /** YYYY-MM-DD, or null. */
  endDate: string | null;
  /** The project this campaign belongs to, fixed when it was created. */
  projectId: string | null;
  /** Meta campaign ids this workspace reports on. Empty: the whole ad account. */
  metaCampaignIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** How it is known that a content item is out. */
export interface ContentPublication {
  /**
   * VERIFIED: JARVIS published it and read the post back from the provider.
   * REPORTED_BY_USER: the user said they posted it. JARVIS did not publish it
   * and has not checked.
   */
  mode: "VERIFIED" | "REPORTED_BY_USER";
  publishedAt: string;
  /** The provider that published it. Null when the user reported it. */
  provider: string | null;
  /** Where it was published, by name. Null when the user reported it. */
  targetName: string | null;
  /** The provider's id for the post. Null when the user reported it. */
  externalId: string | null;
  /** A link to the post, when one is known. */
  url: string | null;
  /** When the provider last confirmed the post exists. Null when the user reported it. */
  verifiedAt: string | null;
}

/** What JARVIS found the last time it looked for an unconfirmed attempt's post. */
export interface ContentPublishLookup {
  at: string;
  /**
   * NOT_FOUND: the Page was read and the post was not on it.
   * TEXT_MISMATCH: a post from the attempt is there, with different text.
   */
  result: "NOT_FOUND" | "TEXT_MISMATCH";
}

/**
 * The last attempt to publish that did not end in a verified post.
 *
 * While an attempt is UNCONFIRMED this record is the ORIGINAL attempt and is
 * kept as it is across retries: where it was sent, and a hash of exactly what
 * was sent. A retry is held to both — it may not name another Page, and it may
 * not be for other words.
 */
export interface ContentPublishAttempt {
  /**
   * UNCONFIRMED: the request went out and its outcome is not known.
   * FAILED: the provider refused, nothing was sent, or a person settled an
   * unconfirmed attempt as not published. Nothing was published.
   */
  state: "UNCONFIRMED" | "FAILED";
  at: string;
  /** A fixed code. Never a provider's own text. */
  code: string;
  targetId: string | null;
  targetName: string | null;
  /** Set when the provider accepted the post but it could not be read back. */
  externalId: string | null;
  /** A hash of the text and link that were sent. Never the text. Absent on records written before it existed. */
  textHash?: string | null;
  /** The last time JARVIS looked for this attempt's post and did not confirm it. */
  lastLookup?: ContentPublishLookup | null;
}

export interface ContentItemView {
  id: string;
  campaignId: string | null;
  projectId: string | null;
  title: string;
  channel: MarketingChannel;
  format: ContentFormat;
  /** The copy. This, and `link`, are exactly what a publish would send. */
  body: string;
  link: string | null;
  notes: string | null;
  status: ContentStatus;
  /** YYYY-MM-DD the item is planned for, or null when it is not on the calendar. */
  scheduledDate: string | null;
  /** HH:MM, a wall-clock label only. Nothing runs at this time. */
  scheduledTime: string | null;
  publication: ContentPublication | null;
  publishAttempt: ContentPublishAttempt | null;
  /** True while an earlier attempt's outcome is still unknown. */
  publishUnconfirmed: boolean;
  createdBy: "user" | "jarvis";
  createdAt: string;
  updatedAt: string;
}

/** One day on the calendar. */
export interface ContentCalendarDay {
  /** YYYY-MM-DD */
  date: string;
  items: ContentItemView[];
}

export interface ContentCalendarView {
  from: string;
  to: string;
  days: ContentCalendarDay[];
  /** Items in the same filter that have no date yet. */
  unscheduled: ContentItemView[];
  total: number;
  /** True when more items matched than were returned. */
  truncated: boolean;
}

export interface CampaignWorkspaceView {
  campaign: MarketingCampaignView;
  content: {
    total: number;
    byStatus: Record<ContentStatus, number>;
    /** The next dated items that are not yet published, soonest first. */
    upcoming: ContentItemView[];
    /** Items whose earlier publish attempt is still unconfirmed. */
    unconfirmed: number;
  };
  latestReport: MarketingReportSummary | null;
  latestResearch: MarketingResearchSummary[];
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

/** How a page was fetched. Every research fact traces back to one of these. */
export interface PageFetchProvenance {
  /** The address that was asked for. */
  requestedUrl: string;
  /** The address the content actually came from, after redirects. */
  finalUrl: string;
  httpStatus: number;
  fetchedAt: string;
  contentType: string | null;
  /** Bytes read. */
  bytes: number;
  /** True when the page was larger than the read limit and was cut short. */
  truncated: boolean;
  /** How many redirects were followed. */
  redirects: number;
}

export type SeoCheckSeverity = "pass" | "info" | "warning" | "critical";

/** One thing the audit looked at, and what it found. */
export interface SeoCheck {
  id: string;
  label: string;
  severity: SeoCheckSeverity;
  /** What was found on the page — a fact, quoted or counted. */
  finding: string;
  /** What to do about it. Advice, and absent when nothing needs doing. */
  recommendation?: string;
}

/** What a page says about itself. Facts read from the HTML, nothing inferred. */
export interface PageFacts {
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  canonical: string | null;
  robotsMeta: string | null;
  lang: string | null;
  viewport: boolean;
  charset: string | null;
  h1: string[];
  h2: string[];
  headingCounts: Record<"h1" | "h2" | "h3" | "h4" | "h5" | "h6", number>;
  wordCount: number;
  images: { total: number; missingAlt: number };
  links: { internal: number; external: number; nofollow: number };
  openGraph: Record<string, string>;
  twitterCard: string | null;
  structuredDataTypes: string[];
  hreflang: string[];
  /** The most frequent meaningful words in the visible text, most frequent first. */
  topTerms: Array<{ term: string; count: number }>;
}

export interface SeoAudit {
  facts: PageFacts;
  checks: SeoCheck[];
  counts: Record<SeoCheckSeverity, number>;
  /**
   * What this audit does NOT contain, stated so it is never mistaken for
   * something that was measured.
   */
  notMeasured: string[];
}

/** A difference between two pages, or between two reads of one page. */
export interface PageDifference {
  field: string;
  /** The first page (the user's own, or the earlier read). */
  left: string;
  /** The second page (the competitor's, or the later read). */
  right: string;
  note: string;
}

export interface CompetitorAnalysis {
  /** Facts read from the competitor's page. */
  competitor: PageFacts;
  /** Facts read from the user's own page, when one was given. */
  own: PageFacts | null;
  /** Competitor compared with the user's own page. Empty when none was given. */
  comparedWithOwn: PageDifference[];
  /** What changed on the competitor's page since the last saved read of it. */
  changesSinceLast: PageDifference[];
  /** When that earlier read was taken. Null when this is the first. */
  previousFetchedAt: string | null;
  /**
   * Set when the user's own page was asked for and could not be read. The
   * competitor's page was still read; the comparison with the user's page is
   * simply absent, and this says why rather than leaving an empty list to be
   * mistaken for "no differences".
   */
  ownPageError: string | null;
  notMeasured: string[];
}

export interface MarketingResearchSummary {
  id: string;
  kind: MarketingResearchKind;
  campaignId: string | null;
  projectId: string | null;
  /** The host that was read, e.g. "example.com". */
  host: string;
  url: string;
  fetchedAt: string;
  /** A one-line, deterministic summary of what was found. */
  headline: string;
  createdAt: string;
}

export interface MarketingResearchView extends MarketingResearchSummary {
  provenance: PageFetchProvenance;
  /** Present for SEO_AUDIT. */
  audit: SeoAudit | null;
  /** Present for COMPETITOR_SNAPSHOT. */
  competitor: CompetitorAnalysis | null;
  /** The user's own page, when a comparison read one. */
  ownProvenance: PageFetchProvenance | null;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Whether one provider's data is in a report, and if not, exactly why.
 *
 *   INCLUDED            read successfully; the rows are in the report
 *   EMPTY               read successfully; the provider returned no rows
 *   NOT_CONFIGURED      this deployment has no connection to that provider
 *   NOT_CONNECTED       the deployment could connect; this user has not
 *   SCOPE_NOT_GRANTED   connected, but the provider has not granted the access
 *   NOT_INCLUDED        usable, but this build does not put its data in reports
 *   FAILED              the read was attempted and did not succeed
 */
export type ReportSourceStatus =
  | "INCLUDED"
  | "EMPTY"
  | "NOT_CONFIGURED"
  | "NOT_CONNECTED"
  | "SCOPE_NOT_GRANTED"
  | "NOT_INCLUDED"
  | "FAILED";

export interface ReportDataSource {
  provider: "meta-ads" | "google-ads";
  label: string;
  status: ReportSourceStatus;
  /** Plain English. Never a provider's own error text, never a credential. */
  detail: string;
  rowCount: number;
  /** The tool executions that produced the rows — the audit trail's handle on them. */
  executionIds: string[];
  /** A masked account label, e.g. "act_123••••789". Never a full identifier. */
  account: string | null;
}

/** One metric, this period against the one before it. */
export interface ReportMetricChange {
  metric: string;
  label: string;
  current: number | null;
  previous: number | null;
  absolute: number | null;
  /** Percent change. Null when it cannot be computed honestly. */
  relativePct: number | null;
  unit: "currency" | "count" | "percent" | "ratio";
}

export interface ReportCampaignRow {
  /** The provider's campaign id. */
  id: string;
  name: string | null;
  kpis: CalculatedKPIs;
}

export interface ReportContentRow {
  title: string;
  channel: MarketingChannel;
  date: string | null;
  status: ContentStatus;
  /** How publication is known. Null: not published. */
  publication: "VERIFIED" | "REPORTED_BY_USER" | null;
  url: string | null;
}

export interface MarketingReportDocument {
  schemaVersion: 1;
  kind: MarketingReportKind;
  title: string;
  /** The campaign workspace the report is about, when there is one. */
  campaign: { name: string; objective: string | null; status: CampaignStatus } | null;
  period: { start: string; end: string; days: number };
  /** The period compared against. Null when no comparison was made. */
  previousPeriod: { start: string; end: string; days: number } | null;
  generatedAt: string;
  /** The currency amounts are in, when the provider said. */
  currency: string | null;
  dataSources: ReportDataSource[];
  /** Totals for the period. Null when no provider data is in the report. */
  totals: CalculatedKPIs | null;
  previousTotals: CalculatedKPIs | null;
  /**
   * Which inputs the provider actually reported. A metric the provider never
   * sent is NOT zero — it is unknown, and everything derived from it is shown
   * as not available rather than computed from a zero nobody measured.
   */
  metricsReported: { conversions: boolean; revenue: boolean; reach: boolean };
  changes: ReportMetricChange[];
  campaigns: ReportCampaignRow[];
  content: {
    published: ReportContentRow[];
    planned: ReportContentRow[];
    counts: { published: number; verified: number; reportedByUser: number; planned: number };
  };
  /** Deterministic caveats about the data. Facts about the report, not advice. */
  notes: string[];
  /** Always present: what this document is and what it did not do. */
  disclaimer: string;
}

export interface MarketingReportSummary {
  id: string;
  kind: MarketingReportKind;
  title: string;
  campaignId: string | null;
  projectId: string | null;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  /** How many of the report's data sources actually contributed rows. */
  sourcesIncluded: number;
  sourcesTotal: number;
}

export interface MarketingReportView extends MarketingReportSummary {
  document: MarketingReportDocument;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export type MarketingRecommendationPriority = "HIGH" | "MEDIUM" | "LOW";

export type MarketingRecommendationArea =
  | "CALENDAR"
  | "CONTENT"
  | "CAMPAIGN"
  | "PUBLISHING"
  | "SEO"
  | "PERFORMANCE"
  | "REPORTING";

/**
 * One piece of advice, with the facts it rests on.
 *
 * `executed` is the literal `false` on every recommendation there will ever
 * be: producing one changes nothing anywhere. It is in the shape so that a
 * recommendation can never be rendered, relayed or stored as an action taken.
 */
export interface MarketingRecommendation {
  id: string;
  area: MarketingRecommendationArea;
  priority: MarketingRecommendationPriority;
  title: string;
  /** Why — in terms of the evidence below. */
  rationale: string;
  /** The facts this rests on, each one read from the workspace or a saved report. */
  evidence: string[];
  /** What the user could do next. Advice. */
  suggestedAction: string;
  /** Whether acting on it would need an approval. */
  needsApproval: boolean;
  executed: false;
}

export interface MarketingRecommendationSet {
  generatedAt: string;
  /** What the recommendations were derived from. */
  basis: {
    campaign: string | null;
    contentItems: number;
    hasReport: boolean;
    seoAudits: number;
  };
  recommendations: MarketingRecommendation[];
  /** Said once, for the whole set. */
  note: string;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** Somewhere a publisher can post to — a Facebook Page, for example. */
export interface PublishTarget {
  id: string;
  name: string;
  channel: MarketingChannel;
  provider: string;
}

/**
 * The exact parameters a publish would run with, built by the SERVER from the
 * saved content and the provider's own list of targets.
 *
 * These are what an approval is bound to and what the person approving sees.
 * At execution every one of them is checked again against the saved content
 * and the provider, so text a model wrote can never be published in place of
 * the text that was approved.
 *
 * They also say WHICH of two things was approved. An item with no publish
 * outstanding is sent; an item whose earlier publish has an outcome that is
 * not known is only looked for. `earlierAttempt` is how the parameters say so,
 * and at execution the item must still be in the state the approval was made
 * for — an approval to look can never send, and an approval to send never
 * runs against an item that has since become unconfirmed.
 */
export interface PublishParams {
  contentId: string;
  targetId: string;
  targetName: string;
  message: string;
  link?: string;
  /**
   * Present only when the approval is for a LOOK: the identity of the earlier
   * attempt whose post is to be looked for — when it was recorded, where it
   * went and a hash of what it sent, as one opaque value. Never the text.
   * Absent: the approval is for a send.
   */
  earlierAttempt?: string;
}

export interface PublishPreparation {
  /** True when a publish could be proposed right now. */
  ready: boolean;
  /** Why not, when it could not. Plain English, one reason per entry. */
  blockers: string[];
  channel: MarketingChannel;
  /** Where this item's channel can be published to. Empty when nowhere. */
  targets: PublishTarget[];
  /** Present only when `ready` — pass these, unchanged, to the publish tool. */
  publishParams: PublishParams | null;
  /** Set when an earlier attempt's outcome is unknown. */
  warning: string | null;
}

/**
 * How a person's decision about an unconfirmed publish came out.
 *
 *   FOUND_PUBLISHED  JARVIS looked once more and the post IS on the Page, with
 *                    the item's text. It is recorded as published and verified.
 *   CLEARED          the Page was read, the post was not on it, and the person
 *                    said it was not published. The attempt is cleared; the
 *                    item can be edited and published again.
 */
export interface PublishResolution {
  resolution: "FOUND_PUBLISHED" | "CLEARED";
  /** A fixed, plain-English sentence. */
  message: string;
  item: ContentItemView;
}

export type PublishOutcomeStatus =
  /** Posted and read back from the provider. */
  | "PUBLISHED"
  /** An earlier attempt had in fact posted it; found on the provider, nothing new was sent. */
  | "ALREADY_PUBLISHED"
  /** The saved content no longer matches what was approved. Nothing was sent. */
  | "STALE"
  /** The item is not in a state that can be published. Nothing was sent. */
  | "NOT_READY"
  /** The target is not one this deployment may publish to, or its name changed. Nothing was sent. */
  | "TARGET_REFUSED"
  /** Another publish of this item is running. Nothing was sent by this one. */
  | "IN_PROGRESS"
  /** The provider refused, or nothing was transmitted. Nothing was published. */
  | "FAILED"
  /**
   * A request was sent — now or in an earlier attempt — and its outcome is not
   * known. NOT published, and nothing further is sent while it stays so.
   */
  | "UNCONFIRMED";

/**
 * UNCONFIRMED outcomes of a retry that only LOOKED for an earlier attempt's
 * post. The item is still unconfirmed, but THIS execution sent nothing — which
 * is what its own journal record must say.
 */
export const PUBLISH_LOOK_ONLY_CODES: readonly string[] = Object.freeze(["NOT_FOUND_ON_PAGE", "RECONCILE_MISMATCH"]);

export interface PublishOutcome {
  status: PublishOutcomeStatus;
  /** A fixed, plain-English sentence. Never a provider's own text. */
  message: string;
  /** A fixed code for the journal. */
  code: string;
  content: ContentItemView | null;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real calendar date, YYYY-MM-DD. 2026-02-30 is refused, not rolled over. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isWallClockTime(value: unknown): value is string {
  return typeof value === "string" && TIME_ONLY.test(value);
}

/** Whole days from `start` to `end`, inclusive of both. Both must be calendar dates. */
export function inclusiveDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00.000Z`);
  const to = Date.parse(`${end}T00:00:00.000Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

/** `date` moved by `days` (negative: earlier). */
export function shiftCalendarDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CHANNEL_ALIASES: Readonly<Record<string, MarketingChannel>> = Object.freeze({
  FB: "FACEBOOK",
  "FACEBOOK PAGE": "FACEBOOK",
  META: "FACEBOOK",
  IG: "INSTAGRAM",
  INSTA: "INSTAGRAM",
  "LINKED IN": "LINKEDIN",
  TWITTER: "X",
  "X (TWITTER)": "X",
  YT: "YOUTUBE",
  WA: "WHATSAPP",
  NEWSLETTER: "EMAIL",
  MAIL: "EMAIL",
  WEBSITE: "BLOG",
  ARTICLE: "BLOG",
});

/**
 * A channel as a person would name it — "instagram", "fb", "Twitter" — as the
 * one this system stores. Null when it names nothing known: the caller asks,
 * rather than filing it under OTHER and losing what was meant.
 */
export function normalizeChannel(input: unknown): MarketingChannel | null {
  if (typeof input !== "string") return null;
  const key = input.trim().toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (key.length === 0) return null;
  if ((MARKETING_CHANNELS as readonly string[]).includes(key)) return key as MarketingChannel;
  return CHANNEL_ALIASES[key] ?? null;
}

export function normalizeFormat(input: unknown): ContentFormat | null {
  if (typeof input !== "string") return null;
  const key = input.trim().toUpperCase();
  if ((CONTENT_FORMATS as readonly string[]).includes(key)) return key as ContentFormat;
  if (key === "REELS") return "REEL";
  if (key === "STORIES") return "STORY";
  if (key === "PHOTO" || key === "PICTURE") return "IMAGE";
  if (key === "TEXT") return "POST";
  return null;
}

/** Line endings made one kind and the ends trimmed. What is stored is what is compared. */
export function normalizeCopy(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** An http(s) link with no credentials in it, or null. */
export function normalizeLink(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (text.length === 0 || text.length > MARKETING_LIMITS.linkMax) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  return url.toString();
}

/** "" and null from a model both mean "not given". */
const blankToUndefined = (value: unknown): unknown =>
  value === null || (typeof value === "string" && value.trim().length === 0) ? undefined : value;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

/** A field that may be cleared: a string sets it, null or "" clears it, absent leaves it. */
const clearableText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? null : value),
    z.string().trim().max(max).nullable().optional()
  );

const dateOnly = z.string().refine(isCalendarDate, "must be a real date, YYYY-MM-DD");
const optionalDate = z.preprocess(blankToUndefined, dateOnly.optional());
const clearableDate = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? null : value),
  dateOnly.nullable().optional()
);
const clearableTime = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? null : value),
  z.string().refine(isWallClockTime, "must be a time, HH:MM (24-hour)").nullable().optional()
);

const channelField = z.preprocess(
  (value) => normalizeChannel(value) ?? value,
  MarketingChannelSchema
);
const formatField = z.preprocess(
  (value) => (value === undefined || value === null || value === "" ? undefined : normalizeFormat(value) ?? value),
  ContentFormatSchema.optional()
);
const channelList = z.preprocess(
  (value) => (Array.isArray(value) ? value.map((entry) => normalizeChannel(entry) ?? entry) : value),
  z.array(MarketingChannelSchema).max(MARKETING_CHANNELS.length)
);

/** A Meta campaign id as the provider issues them: digits only. */
const metaCampaignId = z.string().regex(/^\d{5,25}$/, "a Meta campaign id is digits only");

const settableStatus = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(SETTABLE_CONTENT_STATUSES)
);

const campaignStatus = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  CampaignStatusSchema
);

/** Start must not be after end, when both are given. */
function datesInOrder(value: { startDate?: string | null; endDate?: string | null }): boolean {
  return !value.startDate || !value.endDate || value.startDate <= value.endDate;
}

export const CampaignCreateSchema = z
  .object({
    name: z.string().trim().min(1, "a campaign needs a name").max(MARKETING_LIMITS.campaignNameMax),
    objective: optionalText(MARKETING_LIMITS.campaignObjectiveMax),
    brief: optionalText(MARKETING_LIMITS.campaignBriefMax),
    channels: channelList.optional(),
    startDate: optionalDate,
    endDate: optionalDate,
    status: campaignStatus.optional(),
    metaCampaignIds: z.array(metaCampaignId).max(MARKETING_LIMITS.linkedMetaCampaignsMax).optional(),
  })
  .strict()
  .refine(datesInOrder, { message: "startDate must not be after endDate", path: ["endDate"] });
export type CampaignCreateInput = z.infer<typeof CampaignCreateSchema>;

export const CampaignUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(MARKETING_LIMITS.campaignNameMax).optional(),
    objective: clearableText(MARKETING_LIMITS.campaignObjectiveMax),
    brief: clearableText(MARKETING_LIMITS.campaignBriefMax),
    channels: channelList.optional(),
    startDate: clearableDate,
    endDate: clearableDate,
    status: campaignStatus.optional(),
    metaCampaignIds: z.array(metaCampaignId).max(MARKETING_LIMITS.linkedMetaCampaignsMax).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "nothing to change",
  })
  .refine(datesInOrder, { message: "startDate must not be after endDate", path: ["endDate"] });
export type CampaignUpdateInput = z.infer<typeof CampaignUpdateSchema>;

const linkField = z.preprocess(
  blankToUndefined,
  z
    .string()
    .max(MARKETING_LIMITS.linkMax)
    .refine((value) => normalizeLink(value) !== null, "must be an http(s) link with no credentials in it")
    .optional()
);
const clearableLink = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? null : value),
  z
    .string()
    .max(MARKETING_LIMITS.linkMax)
    .refine((value) => normalizeLink(value) !== null, "must be an http(s) link with no credentials in it")
    .nullable()
    .optional()
);

/** One item of a content plan, as a model or a form supplies it. */
export const ContentDraftSchema = z
  .object({
    title: z.string().trim().min(1, "a content item needs a title").max(MARKETING_LIMITS.contentTitleMax),
    channel: channelField,
    format: formatField,
    body: z.preprocess(
      (value) => (value === null || value === undefined ? "" : value),
      z.string().max(MARKETING_LIMITS.contentBodyMax)
    ),
    link: linkField,
    notes: optionalText(MARKETING_LIMITS.contentNotesMax),
    scheduledDate: optionalDate,
    scheduledTime: z.preprocess(
      blankToUndefined,
      z.string().refine(isWallClockTime, "must be a time, HH:MM (24-hour)").optional()
    ),
    status: settableStatus.optional(),
  })
  .strict()
  .refine((value) => value.scheduledTime === undefined || value.scheduledDate !== undefined, {
    message: "a time needs a date",
    path: ["scheduledTime"],
  });
export type ContentDraftInput = z.infer<typeof ContentDraftSchema>;

export const ContentPlanSchema = z
  .object({
    items: z
      .array(ContentDraftSchema)
      .min(1, "a plan needs at least one item")
      .max(MARKETING_LIMITS.planBatchMax, `at most ${MARKETING_LIMITS.planBatchMax} items per plan`),
  })
  .strict();
export type ContentPlanInput = z.infer<typeof ContentPlanSchema>;

export const ContentUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(MARKETING_LIMITS.contentTitleMax).optional(),
    channel: z.preprocess((value) => normalizeChannel(value) ?? value, MarketingChannelSchema.optional()),
    format: formatField,
    body: z.string().max(MARKETING_LIMITS.contentBodyMax).optional(),
    link: clearableLink,
    notes: clearableText(MARKETING_LIMITS.contentNotesMax),
    scheduledDate: clearableDate,
    scheduledTime: clearableTime,
    status: settableStatus.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "nothing to change",
  });
export type ContentUpdateInput = z.infer<typeof ContentUpdateSchema>;

/** One issue, as a sentence a model or a person can act on. */
export function describeMarketingIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
