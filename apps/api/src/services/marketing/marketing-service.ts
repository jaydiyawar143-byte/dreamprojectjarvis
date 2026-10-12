// ---------------------------------------------------------------------------
// Phase 15 — MarketingService.
//
// THE ONE PLACE the marketing workspace is implemented. The JARVIS marketing
// tools hold this object as their port, and the dashboard's REST router runs
// those same tools through `ToolExecutor` — so a sentence in chat and a button
// on the Marketing page arrive here by one road, past one permission check,
// one approval gate and one audit trail. There is no second implementation
// for the screen to drift from.
//
// WHAT IT MAY TOUCH, AND HOW.
//
//   JARVIS's own store   through the marketing repository, always with the
//                        caller's user id and a scope beside it.
//   The ad account       ONLY by executing the registered READ tools through
//                        `ToolExecutor` — the same reads a person could ask
//                        for, with their own audit rows. This service holds no
//                        provider and no credential.
//   A public web page    ONLY through the page fetcher, which applies the
//                        navigation policy to every hop. Absent when the
//                        operator has not switched page reads on.
//   A publisher          ONLY inside `publish`, which is reached only from the
//                        approval-gated tool after its approval was consumed.
//
// THREE RULES THE CODE BELOW IS ARRANGED AROUND.
//
//   1. VALIDATION LIVES HERE, not in a route and not in a tool, so both ways
//      in get the same answer to the same input.
//
//   2. NOTHING IS REPORTED THAT WAS NOT READ. A report is built from rows a
//      tool returned; a source that could not be read is listed as not read.
//      An audit is computed from a page that was fetched. No model is called
//      anywhere in this file.
//
//   3. PUBLISHED MEANS READ BACK. `publish` posts, then reads the post from
//      the provider by its id, and only then writes PUBLISHED. Anything short
//      of that — a refusal, a lost response, a post that cannot be read back —
//      is reported as exactly what it is, and the item is not published.
//
// Messages returned from here are shown to people and relayed by a model.
// They are fixed sentences: no provider's own error text, no identifier in
// full, no credential.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import {
  CampaignCreateSchema,
  CampaignUpdateSchema,
  CONTENT_STATUSES,
  COPY_FIELDS,
  ContentPlanSchema,
  ContentUpdateSchema,
  JarvisError,
  MARKETING_LIMITS,
  REPORT_KINDS,
  RESEARCH_KINDS,
  auditPage,
  buildCompetitorAnalysis,
  buildContentCalendar,
  buildMarketingRecommendations,
  buildMarketingReport,
  canSetContentStatus,
  channelLabel,
  competitorHeadline,
  describeMarketingIssues,
  effectivePublishState,
  extractPageFacts,
  inclusiveDays,
  isCalendarDate,
  isEditableContent,
  marketingFail,
  marketingOk,
  maskIdentifier,
  metricRowFromMetaInsight,
  normalizeChannel,
  normalizeCopy,
  normalizeLink,
  publishBlockers,
  seoAuditHeadline,
  shiftCalendarDate,
  statusAfterEdit,
  type CampaignWorkspaceView,
  type ContentCalendarView,
  type ContentItemView,
  type ContentPublishAttempt,
  type ContentStatus,
  type IToolExecutor,
  type MarketingCampaignView,
  type MarketingChannel,
  type MarketingRecommendationSet,
  type MarketingReportKind,
  type MarketingReportSummary,
  type MarketingReportView,
  type MarketingResearchKind,
  type MarketingResearchSummary,
  type MarketingResearchView,
  type MarketingResult,
  type MarketingScope,
  type PageFetchProvenance,
  type PublishOutcome,
  type PublishParams,
  type PublishPreparation,
  type PublishTarget,
  type ReportDataSource,
  type ReportMetricRow,
  type ReportProviderData,
  type ReportSourceStatus,
} from "@jarvis/core";
import {
  PublisherError,
  classifyWriteOutcome,
  isAmbiguousPublisherError,
  type ContentPublisher,
  type MarketingCallContext,
  type MarketingPort,
  type PublishedPost,
} from "@jarvis/tools";
import type { PrismaMarketingRepository } from "@jarvis/db";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A page that was read. Structurally the page fetcher's own result. */
export interface ReadPage {
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string | null;
  html: string;
  bytes: number;
  truncated: boolean;
  redirects: number;
  fetchedAt: string;
}

/** Reads one public page. Rejects with an Error whose message is fit to show. */
export interface PageReader {
  fetch(url: unknown, options?: { signal?: AbortSignal }): Promise<ReadPage>;
}

export interface MarketingAudit {
  log(entry: {
    userId: string;
    toolId?: string;
    action: string;
    parameters?: Record<string, unknown>;
    result: "success" | "failure" | "rejected" | "pending";
    traceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface MarketingServiceDeps {
  store: PrismaMarketingRepository;
  projects: { findOwned(userId: string, projectId: string): Promise<{ id: string } | null> };
  conversations: { findByIdAndUserId(conversationId: string, userId: string): Promise<{ projectId?: string | null } | null> };
  /**
   * The one execution authority, for reading the ad account. Late-bound: the
   * executor is built after the tools that hold this service are registered.
   */
  executor: () => Pick<IToolExecutor, "execute"> | null;
  /**
   * The ad account this deployment reads, or null when the Meta read tools are
   * not registered. An identifier, not a credential: the reads are given it as
   * a parameter and check for themselves that the caller may read it — the
   * same arrangement the account analysis uses. Named explicitly so that a
   * token which can see several ad accounts still reads exactly one.
   */
  metaAccount: () => string | null;
  /** Whether this user's Google Ads data could be read, and if not, why. */
  googleAds: (userId: string) => Promise<{ status: ReportSourceStatus; detail: string }>;
  /** Null: reading web pages is switched off on this deployment. */
  pages: PageReader | null;
  /** The providers that can publish. Empty: publishing is unavailable here. */
  publishers: readonly ContentPublisher[];
  audit: MarketingAudit;
  /** Counts page reads per user. Absent: unmetered (tests). */
  researchLimiter?: { check(userId: string, bucket: string, limit: number, windowMs: number): Promise<{ allowed: boolean }> };
  now?: () => Date;
  /** How long to wait before the second attempt to read a new post back. */
  verifyRetryDelayMs?: number;
}

/** Page reads one user may make in a window. Sized for a person, hostile to a loop. */
export const RESEARCH_RATE_LIMIT = Object.freeze({ limit: 20, windowMs: 10 * 60 * 1000 });

const ID = /^[A-Za-z0-9_-]{1,64}$/;

type Scoped = { scope: MarketingScope; projectId: string | null };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function provenanceOf(page: ReadPage): PageFetchProvenance {
  return {
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    httpStatus: page.httpStatus,
    fetchedAt: page.fetchedAt,
    contentType: page.contentType,
    bytes: page.bytes,
    truncated: page.truncated,
    redirects: page.redirects,
  };
}

function sameText(a: string, b: string): boolean {
  return normalizeCopy(a) === normalizeCopy(b);
}

function publishOutcome(
  status: PublishOutcome["status"],
  code: string,
  message: string,
  content: ContentItemView | null = null
): PublishOutcome {
  return { status, code, message, content };
}

/** The repository refuses with a JarvisError whose message is written to be shown. */
function fromStoreError<T>(error: unknown): MarketingResult<T> {
  if (error instanceof JarvisError) {
    const message = error.message;
    if (/^At most /.test(message)) return marketingFail("LIMIT", message);
    if (/already have/.test(message)) return marketingFail("CONFLICT", message);
    if (/not found/.test(message)) return marketingFail("NOT_FOUND", message);
    return marketingFail("INVALID", message);
  }
  throw error;
}

// ---------------------------------------------------------------------------

export class MarketingService implements MarketingPort {
  private readonly now: () => Date;

  constructor(private readonly deps: MarketingServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** The channels this deployment has a real publisher for. */
  publishableChannels(): MarketingChannel[] {
    return [...new Set(this.deps.publishers.map((publisher) => publisher.channel))];
  }

  /** Whether reading public pages is switched on here. */
  researchAvailable(): boolean {
    return this.deps.pages !== null;
  }

  // -------------------------------------------------------------------------
  // Scope
  // -------------------------------------------------------------------------

  /**
   * Which of the caller's rows this call may see.
   *
   * A call made IN A CONVERSATION takes that conversation's project, read
   * from the conversation row by (conversation, user) — a model has no way to
   * name one, and a project named beside it that is not the conversation's is
   * refused rather than obeyed. A call with no conversation (the dashboard)
   * may name one of the user's own projects, or none.
   */
  private async scope(userId: string, ctx: MarketingCallContext): Promise<MarketingResult<Scoped>> {
    if (ctx.conversationId) {
      const conversation = await this.deps.conversations.findByIdAndUserId(ctx.conversationId, userId);
      const projectId = conversation?.projectId ?? null;
      if (ctx.projectId && ctx.projectId !== projectId) {
        return marketingFail("OUT_OF_SCOPE", "This conversation belongs to a different project, so that project's marketing work is not available here.");
      }
      return marketingOk(projectId ? { scope: { kind: "PROJECT", projectId }, projectId } : { scope: { kind: "PERSONAL" }, projectId: null });
    }
    if (ctx.projectId) {
      if (!ID.test(ctx.projectId) || !(await this.deps.projects.findOwned(userId, ctx.projectId))) {
        return marketingFail("NOT_FOUND", "That project was not found.");
      }
      return marketingOk({ scope: { kind: "PROJECT", projectId: ctx.projectId }, projectId: ctx.projectId });
    }
    return marketingOk({ scope: { kind: "ALL" }, projectId: null });
  }

  /** A campaign by its id or its exact name, within the scope. */
  private async campaign(userId: string, scoped: Scoped, reference: string): Promise<MarketingResult<MarketingCampaignView>> {
    const ref = reference.trim();
    if (ref.length === 0 || ref.length > MARKETING_LIMITS.campaignNameMax) {
      return marketingFail("INVALID", "Say which campaign, by its name or its id.");
    }
    if (ID.test(ref)) {
      const byId = await this.deps.store.findCampaign(userId, scoped.scope, ref);
      if (byId) return marketingOk(byId);
    }
    const byName = await this.deps.store.findCampaignsByName(userId, scoped.scope, ref);
    if (byName.length === 1) return marketingOk(byName[0]!);
    if (byName.length > 1) {
      return marketingFail("INVALID", `More than one campaign is called "${ref}". Open the one you mean from the Marketing page, or use its id.`);
    }
    const elsewhere = scoped.scope.kind === "ALL" ? 0 : await this.deps.store.countCampaignsOutside(userId, scoped.scope);
    return marketingFail(
      "NOT_FOUND",
      elsewhere > 0
        ? `No campaign called "${ref}" was found here. ${elsewhere} campaign${elsewhere === 1 ? " belongs" : "s belong"} to other projects and cannot be reached from this conversation.`
        : `No campaign called "${ref}" was found.`
    );
  }

  // -------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------

  async createCampaign(userId: string, input: Record<string, unknown>, ctx: MarketingCallContext): Promise<MarketingResult<MarketingCampaignView>> {
    const parsed = CampaignCreateSchema.safeParse(input);
    if (!parsed.success) return marketingFail("INVALID", describeMarketingIssues(parsed.error));
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;

    try {
      const created = await this.deps.store.createCampaign(userId, scoped.value.projectId, {
        name: parsed.data.name.replace(/\s+/g, " "),
        objective: parsed.data.objective ?? null,
        brief: parsed.data.brief ?? null,
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        channels: [...new Set(parsed.data.channels ?? [])],
        startDate: parsed.data.startDate ?? null,
        endDate: parsed.data.endDate ?? null,
        metaCampaignIds: [...new Set(parsed.data.metaCampaignIds ?? [])],
      });
      return marketingOk(created);
    } catch (error) {
      return fromStoreError(error);
    }
  }

  async updateCampaign(
    userId: string,
    campaign: string,
    patch: Record<string, unknown>,
    ctx: MarketingCallContext
  ): Promise<MarketingResult<MarketingCampaignView>> {
    const parsed = CampaignUpdateSchema.safeParse(patch);
    if (!parsed.success) return marketingFail("INVALID", describeMarketingIssues(parsed.error));
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    const found = await this.campaign(userId, scoped.value, campaign);
    if (!found.ok) return found;

    // The dates are checked as they will be AFTER the change: moving only the
    // start must not leave it past an end that is not in this patch.
    const startDate = parsed.data.startDate !== undefined ? parsed.data.startDate : found.value.startDate;
    const endDate = parsed.data.endDate !== undefined ? parsed.data.endDate : found.value.endDate;
    if (startDate && endDate && startDate > endDate) {
      return marketingFail("INVALID", "The start date must not be after the end date.");
    }

    try {
      const updated = await this.deps.store.updateCampaign(userId, scoped.value.scope, found.value.id, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name.replace(/\s+/g, " ") } : {}),
        ...(parsed.data.objective !== undefined ? { objective: parsed.data.objective } : {}),
        ...(parsed.data.brief !== undefined ? { brief: parsed.data.brief } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.channels !== undefined ? { channels: [...new Set(parsed.data.channels)] } : {}),
        ...(parsed.data.startDate !== undefined ? { startDate: parsed.data.startDate } : {}),
        ...(parsed.data.endDate !== undefined ? { endDate: parsed.data.endDate } : {}),
        ...(parsed.data.metaCampaignIds !== undefined ? { metaCampaignIds: [...new Set(parsed.data.metaCampaignIds)] } : {}),
      });
      return updated ? marketingOk(updated) : marketingFail("NOT_FOUND", "That campaign was not found.");
    } catch (error) {
      return fromStoreError(error);
    }
  }

  async listCampaigns(
    userId: string,
    options: { includeArchived: boolean },
    ctx: MarketingCallContext
  ): Promise<MarketingResult<{ campaigns: MarketingCampaignView[]; inOtherProjects: number }>> {
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    const [campaigns, inOtherProjects] = await Promise.all([
      this.deps.store.listCampaigns(userId, scoped.value.scope, { includeArchived: options.includeArchived }),
      this.deps.store.countCampaignsOutside(userId, scoped.value.scope),
    ]);
    return marketingOk({ campaigns, inOtherProjects });
  }

  async campaignWorkspace(userId: string, campaign: string, ctx: MarketingCallContext): Promise<MarketingResult<CampaignWorkspaceView>> {
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    const found = await this.campaign(userId, scoped.value, campaign);
    if (!found.ok) return found;
    const { scope } = scoped.value;
    const campaignId = found.value.id;

    const [byStatus, upcoming, ready, reports, research] = await Promise.all([
      this.deps.store.countContentByStatus(userId, scope, campaignId),
      this.deps.store.listContent(userId, scope, { campaignId, from: this.today(), statuses: ["IDEA", "DRAFT", "READY"], limit: 8 }),
      this.deps.store.listContent(userId, scope, { campaignId, statuses: ["READY"], limit: 200 }),
      this.deps.store.listReports(userId, scope, { campaignId, limit: 1 }),
      this.deps.store.listResearch(userId, scope, { campaignId, limit: 5 }),
    ]);

    return marketingOk({
      campaign: found.value,
      content: {
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        byStatus,
        upcoming: upcoming.items,
        unconfirmed: ready.items.filter((item) => item.publishUnconfirmed).length,
      },
      latestReport: reports[0] ?? null,
      latestResearch: research,
    });
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  async planContent(
    userId: string,
    input: { campaign?: string; items: unknown },
    ctx: MarketingCallContext
  ): Promise<MarketingResult<{ campaign: { id: string; name: string } | null; items: ContentItemView[] }>> {
    const parsed = ContentPlanSchema.safeParse({ items: input.items });
    if (!parsed.success) return marketingFail("INVALID", describeMarketingIssues(parsed.error));
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;

    let campaign: MarketingCampaignView | null = null;
    if (input.campaign) {
      const found = await this.campaign(userId, scoped.value, input.campaign);
      if (!found.ok) return found;
      if (found.value.status === "ARCHIVED") return marketingFail("CONFLICT", "That campaign is archived. Restore it before adding content to it.");
      campaign = found.value;
    }

    const items = [];
    for (const [index, draft] of parsed.data.items.entries()) {
      const body = normalizeCopy(draft.body);
      // A plan saves ideas and drafts. "Ready" is a statement about finished
      // copy, made separately and on purpose — it is what allows a publish to
      // be proposed at all — so it is never something a plan can assert.
      if (draft.status === "READY" || draft.status === "ARCHIVED") {
        return marketingFail("INVALID", `items.${index}.status: a planned item is saved as IDEA or DRAFT. Mark it ready afterwards.`);
      }
      items.push({
        title: draft.title.replace(/\s+/g, " "),
        channel: draft.channel,
        ...(draft.format ? { format: draft.format } : {}),
        body,
        link: draft.link ? normalizeLink(draft.link) : null,
        notes: draft.notes ?? null,
        status: draft.status ?? (body.length === 0 ? ("IDEA" as const) : ("DRAFT" as const)),
        scheduledDate: draft.scheduledDate ?? null,
        scheduledTime: draft.scheduledTime ?? null,
      });
    }

    try {
      const saved = await this.deps.store.createContent(
        userId,
        // The campaign's project when there is one — never a second opinion.
        { campaignId: campaign?.id ?? null, projectId: campaign ? campaign.projectId : scoped.value.projectId },
        items,
        ctx.actor
      );
      return marketingOk({ campaign: campaign ? { id: campaign.id, name: campaign.name } : null, items: saved });
    } catch (error) {
      return fromStoreError(error);
    }
  }

  async updateContent(userId: string, contentId: string, patch: Record<string, unknown>, ctx: MarketingCallContext): Promise<MarketingResult<ContentItemView>> {
    if (!ID.test(contentId)) return marketingFail("NOT_FOUND", "That content item was not found.");
    const parsed = ContentUpdateSchema.safeParse(patch);
    if (!parsed.success) return marketingFail("INVALID", describeMarketingIssues(parsed.error));
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;

    const current = await this.deps.store.findContent(userId, scoped.value.scope, contentId);
    if (!current) return marketingFail("NOT_FOUND", "That content item was not found.");
    if (!isEditableContent(current.status)) {
      return marketingFail("CONFLICT", "This item is published. It is a record of what went out and can no longer be changed.");
    }

    const next = {
      title: parsed.data.title !== undefined ? parsed.data.title.replace(/\s+/g, " ") : current.title,
      channel: parsed.data.channel ?? current.channel,
      format: parsed.data.format ?? current.format,
      body: parsed.data.body !== undefined ? normalizeCopy(parsed.data.body) : current.body,
      link: parsed.data.link !== undefined ? (parsed.data.link === null ? null : normalizeLink(parsed.data.link)) : current.link,
    };
    const copyChanged = COPY_FIELDS.some((field) => next[field] !== current[field]);

    if (parsed.data.status !== undefined) {
      const allowed = canSetContentStatus(current.status, parsed.data.status, next.body.length > 0);
      if (!allowed.ok) return marketingFail("CONFLICT", allowed.reason);
    }
    const status = statusAfterEdit(current.status, copyChanged, parsed.data.status);
    if (status === "READY" && next.body.length === 0) {
      return marketingFail("CONFLICT", "An item with no text cannot be ready.");
    }

    const scheduledDate = parsed.data.scheduledDate !== undefined ? parsed.data.scheduledDate : current.scheduledDate;
    // A time is a label on a date. Taking the date away takes the time with it.
    const scheduledTime = scheduledDate === null ? null : parsed.data.scheduledTime !== undefined ? parsed.data.scheduledTime : current.scheduledTime;
    if (parsed.data.scheduledTime && scheduledDate === null) {
      return marketingFail("INVALID", "scheduledTime: a time needs a date.");
    }

    const updated = await this.deps.store.updateContent(userId, scoped.value.scope, contentId, {
      ...next,
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      status: status as Exclude<ContentStatus, "PUBLISHED">,
      scheduledDate,
      scheduledTime,
    });
    if (!updated) {
      return marketingFail("CONFLICT", "This item is being published or was just published, so it was not changed.");
    }
    return marketingOk(updated);
  }

  async calendar(
    userId: string,
    filter: { campaign?: string; from?: string; to?: string; status?: string; channel?: string; contentId?: string; limit?: number },
    ctx: MarketingCallContext
  ): Promise<MarketingResult<ContentCalendarView>> {
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    const { scope } = scoped.value;

    if (filter.contentId) {
      const item = ID.test(filter.contentId) ? await this.deps.store.findContent(userId, scope, filter.contentId) : null;
      if (!item) return marketingFail("NOT_FOUND", "That content item was not found.");
      const day = item.scheduledDate ?? this.today();
      return marketingOk(buildContentCalendar([item], day, day, { total: 1 }));
    }

    const from = filter.from ?? (filter.to ? shiftCalendarDate(filter.to, -29) : this.today());
    const to = filter.to ?? shiftCalendarDate(from, 29);
    if (!isCalendarDate(from) || !isCalendarDate(to)) return marketingFail("INVALID", "Dates must be real dates in the form YYYY-MM-DD.");
    if (from > to) return marketingFail("INVALID", "The first day must not be after the last day.");
    if (inclusiveDays(from, to) > MARKETING_LIMITS.calendarRangeDaysMax) {
      return marketingFail("INVALID", `The calendar shows at most ${MARKETING_LIMITS.calendarRangeDaysMax} days at a time.`);
    }

    let statuses: ContentStatus[] = ["IDEA", "DRAFT", "READY", "PUBLISHED"];
    if (filter.status) {
      const wanted = filter.status.trim().toUpperCase();
      if (!(CONTENT_STATUSES as readonly string[]).includes(wanted)) {
        return marketingFail("INVALID", `"${filter.status}" is not a content status. Use IDEA, DRAFT, READY, PUBLISHED or ARCHIVED.`);
      }
      statuses = [wanted as ContentStatus];
    }

    let channel: MarketingChannel | undefined;
    if (filter.channel) {
      const normalized = normalizeChannel(filter.channel);
      if (!normalized) return marketingFail("INVALID", `"${filter.channel}" is not a channel JARVIS knows.`);
      channel = normalized;
    }

    let campaignId: string | undefined;
    if (filter.campaign) {
      const found = await this.campaign(userId, scoped.value, filter.campaign);
      if (!found.ok) return found;
      campaignId = found.value.id;
    }

    const limit = Math.min(Math.max(filter.limit ?? 40, 1), MARKETING_LIMITS.listMax);
    const { items, total } = await this.deps.store.listContent(userId, scope, {
      ...(campaignId ? { campaignId } : {}),
      from,
      to,
      // An undated item is part of the plan; it is returned apart from the days.
      includeUnscheduled: true,
      statuses,
      ...(channel ? { channel } : {}),
      limit,
    });
    return marketingOk(buildContentCalendar(items, from, to, { total, truncated: total > items.length }));
  }

  async markPublished(
    userId: string,
    contentId: string,
    input: { url?: string; publishedOn?: string },
    ctx: MarketingCallContext
  ): Promise<MarketingResult<ContentItemView>> {
    if (!ID.test(contentId)) return marketingFail("NOT_FOUND", "That content item was not found.");
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;

    let url: string | null = null;
    if (input.url) {
      url = normalizeLink(input.url);
      if (!url) return marketingFail("INVALID", "url: must be an http(s) link.");
    }
    let publishedAt = this.now();
    if (input.publishedOn) {
      if (!isCalendarDate(input.publishedOn)) return marketingFail("INVALID", "publishedOn: must be a real date, YYYY-MM-DD.");
      if (input.publishedOn > this.today()) return marketingFail("INVALID", "publishedOn: that date has not happened yet.");
      // Noon, so the calendar date survives any timezone a reader is in.
      if (input.publishedOn !== this.today()) publishedAt = new Date(`${input.publishedOn}T12:00:00.000Z`);
    }

    const current = await this.deps.store.findContent(userId, scoped.value.scope, contentId);
    if (!current) return marketingFail("NOT_FOUND", "That content item was not found.");
    if (current.status === "PUBLISHED") return marketingFail("CONFLICT", "This item is already recorded as published.");
    if (current.status === "ARCHIVED") return marketingFail("CONFLICT", "This item is archived. Restore it first.");

    const marked = await this.deps.store.markPublishedByUser(userId, scoped.value.scope, contentId, { publishedAt, url });
    if (!marked) return marketingFail("CONFLICT", "This item is being published or was just published, so it was not changed.");

    await this.audit(userId, ctx, "marketing.content.reported_published", "success", { contentId });
    return marketingOk(marked);
  }

  // -------------------------------------------------------------------------
  // Research
  // -------------------------------------------------------------------------

  private static readonly RESEARCH_OFF =
    "Reading web pages is switched off on this server, so SEO audits and competitor comparisons are not available. An administrator can switch it on by setting BROWSER_ENABLED=true and restarting.";

  /** One page read, metered and audited. The failure message is fit to show. */
  private async readPage(
    userId: string,
    url: string,
    ctx: MarketingCallContext
  ): Promise<{ ok: true; page: ReadPage } | { ok: false; code: "UNAVAILABLE" | "RATE_LIMITED" | "INVALID" | "PROVIDER_FAILED"; message: string }> {
    if (!this.deps.pages) return { ok: false, code: "UNAVAILABLE", message: MarketingService.RESEARCH_OFF };

    if (this.deps.researchLimiter) {
      const decision = await this.deps.researchLimiter.check(userId, "research", RESEARCH_RATE_LIMIT.limit, RESEARCH_RATE_LIMIT.windowMs);
      if (!decision.allowed) {
        await this.audit(userId, ctx, "marketing.research.throttled", "rejected", {});
        return { ok: false, code: "RATE_LIMITED", message: "Too many pages have been read in the last few minutes. Wait a little and try again." };
      }
    }

    try {
      const page = await this.deps.pages.fetch(url, ctx.signal ? { signal: ctx.signal } : {});
      // The host only: an address can carry things in its path or its query.
      await this.audit(userId, ctx, "marketing.research.fetch", "success", { host: hostOf(page.finalUrl), httpStatus: page.httpStatus });
      return { ok: true, page };
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "FETCH_FAILED";
      await this.audit(userId, ctx, "marketing.research.fetch", "failure", { code });
      // The fetcher's messages are fixed sentences written for a person. An
      // error from anywhere else is not shown.
      const known = (error as { name?: string })?.name === "PageFetchError" && error instanceof Error;
      // An address the policy will not open is the caller's input being
      // refused, not a provider failing: it is answered as invalid input, so
      // a monitor counting failed upstream reads does not count a typo.
      const refusedByPolicy = known && code === "URL_NOT_ALLOWED";
      return { ok: false, code: refusedByPolicy ? "INVALID" : "PROVIDER_FAILED", message: known ? error.message : "The page could not be read." };
    }
  }

  async seoAudit(userId: string, input: { url: string; campaign?: string }, ctx: MarketingCallContext): Promise<MarketingResult<MarketingResearchView>> {
    if (!this.deps.pages) return marketingFail("UNAVAILABLE", MarketingService.RESEARCH_OFF);
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;

    let campaign: MarketingCampaignView | null = null;
    if (input.campaign) {
      const found = await this.campaign(userId, scoped.value, input.campaign);
      if (!found.ok) return found;
      campaign = found.value;
    }

    const read = await this.readPage(userId, input.url, ctx);
    if (!read.ok) return marketingFail(read.code, read.message);
    const { page } = read;

    const audit = auditPage(extractPageFacts(page.html, page.finalUrl), {
      finalUrl: page.finalUrl,
      requestedUrl: page.requestedUrl,
      httpStatus: page.httpStatus,
      truncated: page.truncated,
    });

    try {
      const saved = await this.deps.store.createResearch(userId, {
        kind: "SEO_AUDIT",
        campaignId: campaign?.id ?? null,
        projectId: campaign ? campaign.projectId : scoped.value.projectId,
        host: hostOf(page.finalUrl),
        url: page.finalUrl,
        headline: seoAuditHeadline(audit),
        provenance: provenanceOf(page),
        audit,
        fetchedAt: new Date(page.fetchedAt),
      });
      return marketingOk(saved);
    } catch (error) {
      return fromStoreError(error);
    }
  }

  async competitorAnalyze(
    userId: string,
    input: { competitorUrl: string; ownUrl?: string; campaign?: string },
    ctx: MarketingCallContext
  ): Promise<MarketingResult<MarketingResearchView>> {
    if (!this.deps.pages) return marketingFail("UNAVAILABLE", MarketingService.RESEARCH_OFF);
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;

    let campaign: MarketingCampaignView | null = null;
    if (input.campaign) {
      const found = await this.campaign(userId, scoped.value, input.campaign);
      if (!found.ok) return found;
      campaign = found.value;
    }

    const competitor = await this.readPage(userId, input.competitorUrl, ctx);
    if (!competitor.ok) return marketingFail(competitor.code, competitor.message);

    // The user's own page is optional, and its failure is not the
    // comparison's: the competitor was read, and that is reported — with a
    // plain statement that the other half is missing and why.
    let own: ReadPage | null = null;
    let ownPageError: string | null = null;
    if (input.ownUrl) {
      const read = await this.readPage(userId, input.ownUrl, ctx);
      if (read.ok) own = read.page;
      else ownPageError = read.message;
    }

    const competitorFacts = extractPageFacts(competitor.page.html, competitor.page.finalUrl);
    const previous = await this.deps.store.latestResearchForUrl(userId, scoped.value.scope, "COMPETITOR_SNAPSHOT", competitor.page.finalUrl);

    const analysis = buildCompetitorAnalysis({
      competitor: competitorFacts,
      own: own ? extractPageFacts(own.html, own.finalUrl) : null,
      previous: previous?.competitor ? { facts: previous.competitor.competitor, fetchedAt: previous.fetchedAt } : null,
      ownPageError,
    });

    try {
      const saved = await this.deps.store.createResearch(userId, {
        kind: "COMPETITOR_SNAPSHOT",
        campaignId: campaign?.id ?? null,
        projectId: campaign ? campaign.projectId : scoped.value.projectId,
        host: hostOf(competitor.page.finalUrl),
        url: competitor.page.finalUrl,
        headline: competitorHeadline(analysis),
        provenance: provenanceOf(competitor.page),
        competitor: analysis,
        ...(own ? { ownProvenance: provenanceOf(own) } : {}),
        fetchedAt: new Date(competitor.page.fetchedAt),
      });
      return marketingOk(saved);
    } catch (error) {
      return fromStoreError(error);
    }
  }

  async listResearch(
    userId: string,
    filter: { campaign?: string; kind?: string; researchId?: string },
    ctx: MarketingCallContext
  ): Promise<MarketingResult<{ research: MarketingResearchSummary[]; detail: MarketingResearchView | null }>> {
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    const { scope } = scoped.value;

    if (filter.researchId) {
      const detail = ID.test(filter.researchId) ? await this.deps.store.findResearch(userId, scope, filter.researchId) : null;
      if (!detail) return marketingFail("NOT_FOUND", "That research result was not found.");
      return marketingOk({ research: [], detail });
    }

    let kind: MarketingResearchKind | undefined;
    if (filter.kind) {
      const wanted = filter.kind.trim().toUpperCase();
      if (!(RESEARCH_KINDS as readonly string[]).includes(wanted)) return marketingFail("INVALID", "kind: use SEO_AUDIT or COMPETITOR_SNAPSHOT.");
      kind = wanted as MarketingResearchKind;
    }
    let campaignId: string | undefined;
    if (filter.campaign) {
      const found = await this.campaign(userId, scoped.value, filter.campaign);
      if (!found.ok) return found;
      campaignId = found.value.id;
    }
    const research = await this.deps.store.listResearch(userId, scope, { ...(campaignId ? { campaignId } : {}), ...(kind ? { kind } : {}), limit: 30 });
    return marketingOk({ research, detail: null });
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /**
   * One read of the ad account, through the one execution authority.
   *
   * Run as `viewer` — the least a role can be and still read. Whatever role
   * asked for the report, the reads made on its behalf can do nothing a
   * read-only user could not, so this path can never be a way to widen one.
   */
  private async readTool(
    userId: string,
    toolId: string,
    params: Record<string, unknown>,
    ctx: MarketingCallContext
  ): Promise<{ ok: true; data: Record<string, unknown>; executionId: string } | { ok: false }> {
    const executor = this.deps.executor();
    if (!executor) return { ok: false };
    try {
      const run = await executor.execute({
        toolId,
        params,
        userId,
        role: "viewer",
        traceId: ctx.traceId ?? randomUUID(),
        timeoutMs: 20_000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (run.status !== "completed" || !run.result?.success) return { ok: false };
      const data = run.result.data;
      return { ok: true, data: data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {}, executionId: run.executionId };
    } catch {
      return { ok: false };
    }
  }

  private static rows(data: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
    const list = data[key];
    return Array.isArray(list) ? (list.filter((row) => row !== null && typeof row === "object") as Array<Record<string, unknown>>) : [];
  }

  /** The ad account's figures for the period, or the reason there are none. */
  private async readMetaPerformance(
    userId: string,
    period: { start: string; end: string },
    previous: { start: string; end: string } | null,
    metaCampaignIds: string[],
    ctx: MarketingCallContext
  ): Promise<{ performance: ReportProviderData | null; source: ReportDataSource | null; currency: string | null }> {
    const notRead = (status: ReportSourceStatus, detail: string): ReportDataSource => ({
      provider: "meta-ads",
      label: "Meta Ads",
      status,
      detail,
      rowCount: 0,
      executionIds: [],
      account: null,
    });

    const account = this.deps.metaAccount();
    if (!account || !this.deps.executor()) {
      return { performance: null, source: notRead("NOT_CONFIGURED", "Meta Ads is not set up on this server."), currency: null };
    }

    const scopedToCampaigns = metaCampaignIds.length > 0;
    const range = (p: { start: string; end: string }) => ({ accountId: account, startDate: p.start, endDate: p.end });
    const campaignFilter = scopedToCampaigns ? { campaignIds: metaCampaignIds } : {};

    // Every read at once: five sequential provider calls would not fit inside
    // the deadline the report's own execution runs under.
    const [accounts, totals, before, breakdown, names] = await Promise.all([
      this.readTool(userId, "meta.accounts", { limit: 500 }, ctx),
      scopedToCampaigns
        ? this.readTool(userId, "meta.insights", { ...range(period), level: "campaign", limit: 500, ...campaignFilter }, ctx)
        : this.readTool(userId, "meta.insights", { ...range(period), level: "account" }, ctx),
      previous
        ? scopedToCampaigns
          ? this.readTool(userId, "meta.insights", { ...range(previous), level: "campaign", limit: 500, ...campaignFilter }, ctx)
          : this.readTool(userId, "meta.insights", { ...range(previous), level: "account" }, ctx)
        : Promise.resolve(null),
      scopedToCampaigns ? Promise.resolve(null) : this.readTool(userId, "meta.insights", { ...range(period), level: "campaign", limit: 500 }, ctx),
      this.readTool(userId, "meta.campaigns", { accountId: account, limit: 500 }, ctx),
    ]);

    if (!totals.ok) {
      return { performance: null, source: notRead("FAILED", "The ad account could not be read. Nothing from it is in this report."), currency: null };
    }

    const nameOf = new Map<string, string>();
    if (names.ok) {
      for (const row of MarketingService.rows(names.data, "campaigns")) {
        // `campaignId` is what the read tool returns; that is the contract.
        if (typeof row.campaignId === "string" && typeof row.name === "string") nameOf.set(row.campaignId, row.name);
      }
    }
    const toRow = (row: Record<string, unknown>): ReportMetricRow =>
      metricRowFromMetaInsight(row, typeof row.campaignId === "string" ? (nameOf.get(row.campaignId) ?? null) : undefined);

    const totalRows = MarketingService.rows(totals.data, "insights").map(toRow);
    const campaignRows = scopedToCampaigns ? totalRows : breakdown && breakdown.ok ? MarketingService.rows(breakdown.data, "insights").map(toRow) : [];

    // The account the read says it ran against — which is the one it was
    // given, or the read would have been refused.
    const accountId = typeof totals.data.accountId === "string" ? totals.data.accountId : account;
    const bare = (id: unknown): string | null => (typeof id === "string" ? id.replace(/^act_/, "") : null);
    let currency: string | null = null;
    if (accounts.ok) {
      const listed = MarketingService.rows(accounts.data, "accounts").find((row) => bare(row.accountId) === bare(accountId));
      if (listed && typeof listed.currency === "string" && listed.currency.length > 0) currency = listed.currency;
    }

    const partial: string[] = [];
    if (previous && before !== null && !before.ok) partial.push("The comparison period could not be read.");
    if (!scopedToCampaigns && breakdown !== null && !breakdown.ok) partial.push("The per-campaign breakdown could not be read.");
    // A page of rows with more behind it is said to be a page.
    const more = (read: Awaited<ReturnType<MarketingService["readTool"]>> | null): boolean =>
      read !== null && read.ok && typeof read.data.nextPage === "string" && read.data.nextPage.length > 0;
    if (!scopedToCampaigns && more(breakdown)) partial.push("The per-campaign breakdown shows the first 500 campaigns; there are more.");
    if (scopedToCampaigns && more(totals)) partial.push("More rows exist than were read, so these totals are incomplete.");
    if (!names.ok) partial.push("Campaign names could not be read, so campaigns are shown by id.");
    if (!currency) partial.push("The account's currency could not be read, so amounts are shown without one.");

    const executionIds = [totals, before, breakdown, names, accounts].flatMap((read) => (read && read.ok ? [read.executionId] : []));
    const base = {
      provider: "meta-ads" as const,
      label: "Meta Ads",
      executionIds,
      account: maskIdentifier(accountId),
    };

    if (totalRows.length === 0) {
      return {
        performance: {
          source: { ...base, status: "EMPTY", detail: "The ad account was read and returned no data for this period." },
          totalRows: [],
          reachAdditive: true,
          previousRows: null,
          campaignRows: [],
        },
        source: null,
        currency,
      };
    }

    const scopeNote = scopedToCampaigns
      ? `Read for the ${metaCampaignIds.length} Meta campaign${metaCampaignIds.length === 1 ? "" : "s"} linked to this workspace.`
      : "Read for the whole connected ad account.";

    return {
      performance: {
        source: { ...base, status: "INCLUDED", detail: [scopeNote, ...partial].join(" ") },
        totalRows,
        // One account-level row carries reach as Meta counted it. Rows per
        // campaign cannot be added: the same person may be in several.
        reachAdditive: !scopedToCampaigns || totalRows.length <= 1,
        previousRows: before && before.ok ? MarketingService.rows(before.data, "insights").map(toRow) : previous ? [] : null,
        campaignRows,
      },
      source: null,
      currency,
    };
  }

  async generateReport(
    userId: string,
    input: { kind?: string; campaign?: string; from?: string; to?: string; title?: string; compare?: boolean },
    ctx: MarketingCallContext
  ): Promise<MarketingResult<MarketingReportView>> {
    let kind: MarketingReportKind = "PERFORMANCE";
    if (input.kind) {
      const wanted = input.kind.trim().toUpperCase();
      if (!(REPORT_KINDS as readonly string[]).includes(wanted)) return marketingFail("INVALID", "kind: use PERFORMANCE or CLIENT.");
      kind = wanted as MarketingReportKind;
    }

    // Complete days only by default: today is still being counted by the
    // provider, and a period that ends on it compares a part with a whole.
    const today = this.today();
    const end = input.to ?? shiftCalendarDate(today, -1);
    const start = input.from ?? shiftCalendarDate(end, -29);
    if (!isCalendarDate(start) || !isCalendarDate(end)) return marketingFail("INVALID", "Dates must be real dates in the form YYYY-MM-DD.");
    if (start > end) return marketingFail("INVALID", "The first day must not be after the last day.");
    if (end > today) return marketingFail("INVALID", "A report cannot cover days that have not happened yet.");
    const days = inclusiveDays(start, end);
    if (days > MARKETING_LIMITS.reportPeriodDaysMax) {
      return marketingFail("INVALID", `A report covers at most ${MARKETING_LIMITS.reportPeriodDaysMax} days.`);
    }

    const title = input.title?.replace(/\s+/g, " ").trim();
    if (title && title.length > MARKETING_LIMITS.reportTitleMax) {
      return marketingFail("INVALID", `title: at most ${MARKETING_LIMITS.reportTitleMax} characters.`);
    }

    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    const { scope } = scoped.value;

    let campaign: MarketingCampaignView | null = null;
    if (input.campaign) {
      const found = await this.campaign(userId, scoped.value, input.campaign);
      if (!found.ok) return found;
      campaign = found.value;
    }

    const previous = input.compare === false ? null : { start: shiftCalendarDate(start, -days), end: shiftCalendarDate(start, -1) };

    const [meta, google, content] = await Promise.all([
      this.readMetaPerformance(userId, { start, end }, previous, campaign?.metaCampaignIds ?? [], ctx),
      this.googleAdsSource(userId),
      this.contentForPeriod(userId, scope, campaign?.id, start, end),
    ]);

    const generatedAt = this.now();
    const document = buildMarketingReport({
      kind,
      title: title && title.length > 0 ? title : `${campaign?.name ?? "Marketing"} — ${kind === "CLIENT" ? "client report" : "performance report"}`,
      campaign: campaign ? { name: campaign.name, objective: campaign.objective, status: campaign.status } : null,
      periodStart: start,
      periodEnd: end,
      previousPeriod: previous,
      generatedAt: generatedAt.toISOString(),
      currency: meta.currency,
      performance: meta.performance,
      otherSources: [...(meta.source ? [meta.source] : []), google],
      content,
    });

    try {
      const saved = await this.deps.store.createReport(userId, {
        kind,
        title: document.title,
        campaignId: campaign?.id ?? null,
        projectId: campaign ? campaign.projectId : scoped.value.projectId,
        periodStart: start,
        periodEnd: end,
        document,
        sourcesIncluded: document.dataSources.filter((source) => source.status === "INCLUDED").length,
        sourcesTotal: document.dataSources.length,
        generatedAt,
      });
      await this.audit(userId, ctx, "marketing.report.generated", "success", {
        reportId: saved.id,
        kind,
        sourcesIncluded: saved.sourcesIncluded,
        sourcesTotal: saved.sourcesTotal,
      });
      return marketingOk(saved);
    } catch (error) {
      return fromStoreError(error);
    }
  }

  /**
   * Google Ads, as a report source.
   *
   * Phase 15 puts NO Google Ads figure in a report. What it does is ask the
   * capability layer — which reads the scopes Google actually GRANTED — whether
   * this user's Google Ads could be read, and record the answer, so a report
   * never passes over Google Ads in silence. Including its data is a later
   * step, to be taken once a grant with the Ads scope exists to verify
   * against.
   */
  private async googleAdsSource(userId: string): Promise<ReportDataSource> {
    let status: ReportSourceStatus = "NOT_CONFIGURED";
    let detail = "Google Ads is not set up on this server.";
    try {
      const answer = await this.deps.googleAds(userId);
      // Whatever the layer says, this build includes nothing.
      status = answer.status === "INCLUDED" ? "NOT_INCLUDED" : answer.status;
      detail = answer.detail;
    } catch {
      status = "FAILED";
      detail = "Whether Google Ads can be read could not be determined.";
    }
    return { provider: "google-ads", label: "Google Ads", status, detail, rowCount: 0, executionIds: [], account: null };
  }

  /** The workspace's content that falls in a period: planned for it, or published in it. */
  private async contentForPeriod(userId: string, scope: MarketingScope, campaignId: string | undefined, start: string, end: string): Promise<ContentItemView[]> {
    const [planned, published] = await Promise.all([
      this.deps.store.listContent(userId, scope, { ...(campaignId ? { campaignId } : {}), from: start, to: end, statuses: ["IDEA", "DRAFT", "READY", "PUBLISHED"], limit: 300 }),
      this.deps.store.listContent(userId, scope, { ...(campaignId ? { campaignId } : {}), statuses: ["PUBLISHED"], limit: 300 }),
    ]);
    const byId = new Map<string, ContentItemView>();
    for (const item of planned.items) byId.set(item.id, item);
    for (const item of published.items) {
      const day = item.publication?.publishedAt.slice(0, 10);
      if (day && day >= start && day <= end) byId.set(item.id, item);
    }
    // A published item belongs to the period it was published in, wherever it
    // had been planned.
    return [...byId.values()].filter((item) => {
      if (!item.publication) return true;
      const day = item.publication.publishedAt.slice(0, 10);
      return day >= start && day <= end;
    });
  }

  async listReports(userId: string, filter: { campaign?: string }, ctx: MarketingCallContext): Promise<MarketingResult<MarketingReportSummary[]>> {
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    let campaignId: string | undefined;
    if (filter.campaign) {
      const found = await this.campaign(userId, scoped.value, filter.campaign);
      if (!found.ok) return found;
      campaignId = found.value.id;
    }
    return marketingOk(await this.deps.store.listReports(userId, scoped.value.scope, { ...(campaignId ? { campaignId } : {}), limit: 30 }));
  }

  async getReport(userId: string, reportId: string, ctx: MarketingCallContext): Promise<MarketingResult<MarketingReportView>> {
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    const report = ID.test(reportId) ? await this.deps.store.findReport(userId, scoped.value.scope, reportId) : null;
    return report ? marketingOk(report) : marketingFail("NOT_FOUND", "That report was not found.");
  }

  // -------------------------------------------------------------------------
  // Recommendations
  // -------------------------------------------------------------------------

  async recommendations(userId: string, input: { campaign?: string }, ctx: MarketingCallContext): Promise<MarketingResult<MarketingRecommendationSet>> {
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    const { scope } = scoped.value;

    let campaign: MarketingCampaignView | null = null;
    if (input.campaign) {
      const found = await this.campaign(userId, scoped.value, input.campaign);
      if (!found.ok) return found;
      campaign = found.value;
    }
    const campaignId = campaign?.id;

    const [content, report, audits] = await Promise.all([
      this.deps.store.listContent(userId, scope, { ...(campaignId ? { campaignId } : {}), statuses: ["IDEA", "DRAFT", "READY", "PUBLISHED"], limit: 500 }),
      this.deps.store.latestReport(userId, scope, campaignId),
      this.deps.store.recentAudits(userId, scope, campaignId, 10),
    ]);

    return marketingOk(
      buildMarketingRecommendations({
        today: this.today(),
        campaign,
        content: content.items,
        publishableChannels: this.publishableChannels(),
        latestReport: report?.document ?? null,
        seoAudits: audits.flatMap((entry) => (entry.audit ? [{ host: entry.host, url: entry.url, fetchedAt: entry.fetchedAt, audit: entry.audit }] : [])),
      })
    );
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  private publisherFor(channel: MarketingChannel): ContentPublisher | undefined {
    return this.deps.publishers.find((publisher) => publisher.channel === channel);
  }

  /**
   * Can this item be published, where, and with exactly which parameters?
   *
   * A read. It builds `publishParams` from the SAVED item and the provider's
   * own list of targets — the text and the place a person will be shown, and
   * the only parameters `publish` will accept.
   */
  async preparePublish(userId: string, contentId: string, targetId: string | undefined, ctx: MarketingCallContext): Promise<MarketingResult<PublishPreparation>> {
    if (!ID.test(contentId)) return marketingFail("NOT_FOUND", "That content item was not found.");
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    const item = await this.deps.store.findContent(userId, scoped.value.scope, contentId);
    if (!item) return marketingFail("NOT_FOUND", "That content item was not found.");

    const raw = await this.deps.store.publishStateOf(userId, contentId);
    const state = raw ? effectivePublishState(raw.state, raw.claimedAt, this.now()) : "NONE";
    const blockers = publishBlockers(item, state, this.publishableChannels());

    const publisher = this.publisherFor(item.channel);
    let targets: PublishTarget[] = [];
    if (publisher) {
      try {
        targets = await publisher.listTargets(ctx.signal ? { signal: ctx.signal } : {});
        if (targets.length === 0) blockers.push(`The ${channelLabel(item.channel)} connection has no Page it is allowed to post to.`);
      } catch (error) {
        blockers.push(error instanceof PublisherError ? error.message : `The ${channelLabel(item.channel)} connection could not be reached.`);
      }
    }

    let target: PublishTarget | undefined;
    if (targets.length > 0) {
      if (targetId) {
        target = targets.find((candidate) => candidate.id === targetId);
        if (!target) blockers.push("That is not a place this item can be published to.");
      } else if (targets.length === 1) {
        target = targets[0];
      } else {
        blockers.push(`Choose where to publish it: ${targets.map((candidate) => candidate.name).join(", ")}.`);
      }
    }

    const ready = blockers.length === 0 && target !== undefined;
    return marketingOk({
      ready,
      blockers,
      channel: item.channel,
      targets,
      publishParams: ready
        ? { contentId: item.id, targetId: target!.id, targetName: target!.name, message: item.body, ...(item.link ? { link: item.link } : {}) }
        : null,
      warning:
        state === "UNCONFIRMED"
          ? "An earlier attempt to publish this item was sent and its outcome is not known. Publishing again first looks for that post on the Page, and will not post it a second time if it is found."
          : null,
    });
  }

  /**
   * Publish an item whose approval has just been consumed.
   *
   * Called ONLY by the approval-gated tool. Every parameter is checked again
   * here against the saved item and the provider before anything is sent:
   * an approval says a person agreed to these words going to this place, and
   * this is where that is made true or refused.
   *
   * It returns what happened as a value. It throws only for something it did
   * not foresee — and the tool treats a throw as an unknown outcome, never as
   * nothing having happened.
   */
  async publish(userId: string, params: PublishParams, ctx: MarketingCallContext): Promise<PublishOutcome> {
    // --- before anything is sent: every exit here is "nothing was published" --
    let taken: Awaited<ReturnType<MarketingService["takeForPublish"]>>;
    try {
      taken = await this.takeForPublish(userId, params, ctx);
    } catch {
      return publishOutcome("FAILED", "PUBLISH_NOT_STARTED", "The publish could not be started. Nothing was sent and nothing was published.");
    }
    if (!taken.ok) return taken.outcome;
    const { item, publisher, target, wasUnconfirmed, previousAttempt, claimedSince } = taken;
    const none = publishOutcome;

    const options = ctx.signal ? { signal: ctx.signal } : {};
    const attempt = (state: ContentPublishAttempt["state"], code: string, externalId: string | null): ContentPublishAttempt => ({
      state,
      at: this.now().toISOString(),
      code,
      targetId: target.id,
      targetName: target.name,
      externalId,
    });
    const finalize = async (post: PublishedPost, status: "PUBLISHED" | "ALREADY_PUBLISHED"): Promise<PublishOutcome> => {
      const verifiedAt = this.now();
      let recorded: ContentItemView | null = null;
      try {
        recorded = await this.deps.store.finalizePublished(userId, item.id, {
          provider: publisher.provider,
          targetName: target.name,
          externalId: post.externalId,
          url: post.url,
          publishedAt: post.createdAt ? new Date(post.createdAt) : verifiedAt,
          verifiedAt,
        });
      } catch {
        recorded = null;
      }
      if (!recorded) {
        // The post is on the Page and was read back — but the record that says
        // so could not be written. It stays unpublished HERE, honestly; the
        // next attempt finds the post and records it without posting again.
        await this.auditPublish(userId, ctx, params, "failure", "RECORD_FAILED", post.externalId);
        return none(
          "UNCONFIRMED",
          "RECORD_FAILED",
          "The post is on the Page, but JARVIS could not record that. It is not marked as published yet. Publishing again will find the post and record it, without posting twice."
        );
      }
      await this.auditPublish(userId, ctx, params, "success", status, post.externalId);
      return {
        status,
        code: status,
        message:
          status === "PUBLISHED"
            ? `Published to ${target.name} and read back from the Page.`
            : `An earlier attempt had already published this to ${target.name}. It was found on the Page and is now recorded as published. Nothing new was posted.`,
        content: recorded,
      };
    };

    return this.sendAndVerify({ userId, params, ctx, item, publisher, target, wasUnconfirmed, previousAttempt, claimedSince, options, attempt, finalize });
  }

  /**
   * Everything that is checked BEFORE a publish is sent, ending in the claim.
   *
   * Every refusal from here means nothing was transmitted: the item, the
   * publisher, the approved words against the saved words, the target against
   * the provider's own list — and then the one conditional write that gives
   * exactly one execution the item.
   */
  private async takeForPublish(
    userId: string,
    params: PublishParams,
    ctx: MarketingCallContext
  ): Promise<
    | { ok: false; outcome: PublishOutcome }
    | {
        ok: true;
        item: ContentItemView;
        publisher: ContentPublisher;
        target: PublishTarget;
        wasUnconfirmed: boolean;
        previousAttempt: ContentPublishAttempt | null;
        claimedSince: Date;
      }
  > {
    const none = (status: PublishOutcome["status"], code: string, message: string, content: ContentItemView | null = null) => ({
      ok: false as const,
      outcome: publishOutcome(status, code, message, content),
    });

    {
      const scoped = await this.scope(userId, ctx);
      if (!scoped.ok) return none("NOT_READY", "OUT_OF_SCOPE", `${scoped.message} Nothing was published.`);

      const item = ID.test(params.contentId) ? await this.deps.store.findContent(userId, scoped.value.scope, params.contentId) : null;
      if (!item) return none("NOT_READY", "NOT_FOUND", "That content item was not found. Nothing was published.");

      if (item.status === "PUBLISHED" || item.publication) {
        return none("NOT_READY", "ALREADY_PUBLISHED", "This item is already published. Nothing new was posted.", item);
      }
      if (item.status !== "READY") {
        return none("NOT_READY", "NOT_READY", "This item is not marked ready, so it was not published.", item);
      }

      const publisher = this.publisherFor(item.channel);
      if (!publisher) {
        return none("NOT_READY", "NO_PUBLISHER", `JARVIS has no publishing connection for ${channelLabel(item.channel)}. Nothing was published.`, item);
      }

      // The approved words against the saved words. The approval summary
      // showed `params.message`; if the item was edited since, they differ,
      // and what was approved is no longer what would go out.
      if (!sameText(params.message, item.body) || (params.link ?? null) !== item.link) {
        await this.auditPublish(userId, ctx, params, "rejected", "STALE");
        return none("STALE", "STALE", "The saved text is no longer the text that was approved, so nothing was published. Check the item and ask again.", item);
      }

      let targets: PublishTarget[];
      try {
        targets = await publisher.listTargets(ctx.signal ? { signal: ctx.signal } : {});
      } catch (error) {
        await this.auditPublish(userId, ctx, params, "failure", "TARGET_CHECK_FAILED");
        const why = error instanceof PublisherError ? error.message : "The publishing connection could not be reached.";
        return none("FAILED", "TARGET_CHECK_FAILED", `${why} Nothing was published.`, item);
      }
      const target = targets.find((candidate) => candidate.id === params.targetId);
      if (!target) {
        await this.auditPublish(userId, ctx, params, "rejected", "TARGET_REFUSED");
        return none("TARGET_REFUSED", "TARGET_REFUSED", "That Page is not one this connection can publish to. Nothing was published.", item);
      }
      // The name a person approved must be the name of the place it goes to.
      if (target.name !== params.targetName) {
        await this.auditPublish(userId, ctx, params, "rejected", "TARGET_RENAMED");
        return none("TARGET_REFUSED", "TARGET_RENAMED", "The Page's name is not the one that was approved, so nothing was published. Ask again to see it as it is now.", item);
      }

      const raw = await this.deps.store.publishStateOf(userId, item.id);
      const state = raw ? effectivePublishState(raw.state, raw.claimedAt, this.now()) : "NONE";
      if (state === "PUBLISHING") {
        return none("IN_PROGRESS", "IN_PROGRESS", "Another publish of this item is already running. Nothing was published by this request.", item);
      }
      const wasUnconfirmed = state === "UNCONFIRMED";
      const previousAttempt = item.publishAttempt;
      const claimedSince = raw?.claimedAt ?? this.now();

      // ONE conditional write: exactly one execution takes the item, and only
      // while its copy is still the approved copy.
      const claimed = await this.deps.store.claimForPublish(userId, item.id, { channel: item.channel, body: item.body, link: item.link });
      if (!claimed) {
        const after = await this.deps.store.publishStateOf(userId, item.id);
        return after?.state === "PUBLISHING"
          ? none("IN_PROGRESS", "IN_PROGRESS", "Another publish of this item is already running. Nothing was published by this request.", item)
          : none("STALE", "STALE", "The item changed while it was being published, so nothing was published. Check it and ask again.", item);
      }

      return { ok: true, item, publisher, target, wasUnconfirmed, previousAttempt, claimedSince };
    }
  }

  /**
   * The part of a publish that talks to the provider, entered only by the one
   * execution that holds the claim: look for an earlier attempt's post, send,
   * read back, record.
   */
  private async sendAndVerify(input: {
    userId: string;
    params: PublishParams;
    ctx: MarketingCallContext;
    item: ContentItemView;
    publisher: ContentPublisher;
    target: PublishTarget;
    wasUnconfirmed: boolean;
    previousAttempt: ContentPublishAttempt | null;
    claimedSince: Date;
    options: { signal?: AbortSignal };
    attempt: (state: ContentPublishAttempt["state"], code: string, externalId: string | null) => ContentPublishAttempt;
    finalize: (post: PublishedPost, status: "PUBLISHED" | "ALREADY_PUBLISHED") => Promise<PublishOutcome>;
  }): Promise<PublishOutcome> {
    const { userId, params, ctx, item, publisher, target, wasUnconfirmed, previousAttempt, claimedSince, options, attempt, finalize } = input;
    const none = publishOutcome;

    // --- an earlier attempt whose outcome was never learned ------------------
    //
    // Before sending anything again, ask the provider what is actually there.
    if (wasUnconfirmed) {
      const where = previousAttempt?.targetId ?? target.id;
      const sinceMs = Math.min(previousAttempt ? Date.parse(previousAttempt.at) : Number.POSITIVE_INFINITY, claimedSince.getTime());
      const since = new Date((Number.isFinite(sinceMs) ? sinceMs : this.now().getTime()) - 10 * 60 * 1000);
      try {
        let found: PublishedPost | null = null;
        if (previousAttempt?.externalId) found = await publisher.read({ targetId: where, externalId: previousAttempt.externalId }, options);
        // "No such post" by id can also mean "not readable right now", so the
        // Page's own recent posts are looked through as well before concluding
        // that nothing went out.
        if (!found) found = await publisher.findByMessage({ targetId: where, message: item.body, since }, options);
        if (found) return await finalize(found, "ALREADY_PUBLISHED");
      } catch {
        await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", previousAttempt ?? attempt("UNCONFIRMED", "AMBIGUOUS_OUTCOME", null));
        await this.auditPublish(userId, ctx, params, "failure", "RECONCILE_FAILED");
        return none(
          "FAILED",
          "RECONCILE_FAILED",
          "An earlier attempt may have published this item, and the Page could not be checked to find out. Nothing new was posted. Try again once the connection is working.",
          item
        );
      }
    }

    // --- the write ------------------------------------------------------------
    let externalId: string;
    try {
      ({ externalId } = await publisher.publish({ targetId: target.id, message: item.body, ...(item.link ? { link: item.link } : {}) }, options));
    } catch (error) {
      const ambiguous = isAmbiguousPublisherError(error) || classifyWriteOutcome(error).status === "UNKNOWN";
      if (ambiguous) {
        const content = await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", attempt("UNCONFIRMED", "AMBIGUOUS_OUTCOME", null));
        await this.auditPublish(userId, ctx, params, "failure", "AMBIGUOUS_OUTCOME");
        return none(
          "UNCONFIRMED",
          "AMBIGUOUS_OUTCOME",
          `The post was sent to ${target.name}, but the answer never arrived, so it is not known whether it was published. It is NOT marked as published. Check the Page before trying again — publishing again will look for the post first.`,
          content ?? item
        );
      }
      const code = error instanceof PublisherError ? error.code : "PUBLISH_FAILED";
      const why = error instanceof PublisherError ? error.message : "The post could not be sent.";
      const content = await this.deps.store.releasePublish(userId, item.id, "NONE", attempt("FAILED", code, null));
      await this.auditPublish(userId, ctx, params, "failure", code);
      return none("FAILED", code, `${why} Nothing was published.`, content ?? item);
    }

    // --- read it back ---------------------------------------------------------
    //
    // The provider accepted the post. That is not yet "published": it is
    // published when the post can be read from the provider by its id.
    let post: PublishedPost | null = null;
    for (let tries = 0; tries < 2 && !post; tries += 1) {
      if (tries > 0) await new Promise((resolve) => setTimeout(resolve, this.deps.verifyRetryDelayMs ?? 1000));
      try {
        post = await publisher.read({ targetId: target.id, externalId }, options);
      } catch {
        post = null;
      }
    }

    if (!post || (post.message !== null && !sameText(post.message, item.body))) {
      const code = post ? "VERIFY_MISMATCH" : "VERIFY_FAILED";
      const content = await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", attempt("UNCONFIRMED", code, externalId));
      await this.auditPublish(userId, ctx, params, "failure", code, externalId);
      return none(
        "UNCONFIRMED",
        code,
        post
          ? `${target.name} accepted the post, but what was read back is not the text that was sent. It is NOT marked as published. Check the Page.`
          : `${target.name} accepted the post, but JARVIS could not read it back to confirm it. It is NOT marked as published. Check the Page before trying again.`,
        content ?? item
      );
    }

    return finalize(post, "PUBLISHED");
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  /** One domain audit row. Never throws: a log that fails must not fail the work. */
  private async audit(
    userId: string,
    ctx: MarketingCallContext,
    action: string,
    result: "success" | "failure" | "rejected",
    parameters: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.deps.audit.log({ userId, action, parameters, result, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    } catch {
      // Deliberately swallowed.
    }
  }

  /**
   * What a publish attempt came to. Ids, the outcome and the provider's id for
   * the post — never the text. The text is in the approval the user decided,
   * and in the item.
   */
  private auditPublish(
    userId: string,
    ctx: MarketingCallContext,
    params: PublishParams,
    result: "success" | "failure" | "rejected",
    outcome: string,
    externalId?: string
  ): Promise<void> {
    return this.audit(userId, ctx, "marketing.publish", result, {
      contentId: params.contentId,
      targetId: params.targetId,
      outcome,
      ...(externalId ? { externalId } : {}),
    });
  }
}
