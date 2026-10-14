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
//   3. PUBLISHED MEANS READ BACK, WITH ITS TEXT. `publish` posts, then reads
//      the post from the provider by its id, and only when the text that comes
//      back is the item's text does it write PUBLISHED. Anything short of that
//      — a refusal, a lost response, a post that cannot be read back, a post
//      whose text is different or absent — is reported as exactly what it is,
//      and the item is not published.
//
//   4. NOTHING IS SENT FOR AN ITEM WHOSE EARLIER PUBLISH IS UNCONFIRMED. A
//      retry only LOOKS — on the Page the earlier attempt went to, for the
//      words that attempt sent. Found: recorded. Not found: the item stays
//      unconfirmed and nothing is posted, until a person settles it
//      (`resolveUnconfirmed`). A second post is never the system's own guess.
//
//   5. WORK THAT REACHES OUTSIDE JARVIS TAKES A SLOT FIRST. A page read, a
//      report's reads of the ad account and a publish check each reserve a
//      place in a per-user window BEFORE the provider is called — atomically,
//      so requests that arrive together cannot all be let through.
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
  computeParamsHash,
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
  type PublishResolution,
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
  /**
   * Takes one slot in a per-user window — atomically, before the work it
   * meters starts: a page read, a report's reads of the ad account, a publish
   * check. Absent: unmetered (unit tests only; the container always wires it).
   */
  limiter?: {
    reserve(
      userId: string,
      bucket: string,
      limit: number,
      windowMs: number,
      options?: { traceId?: string }
    ): Promise<{ allowed: boolean; reason?: "LIMIT" | "UNAVAILABLE" }>;
  };
  now?: () => Date;
  /** How long to wait before the second attempt to read a new post back. */
  verifyRetryDelayMs?: number;
}

/**
 * The three per-user windows. Each is sized for a person and hostile to a loop,
 * and each is counted by the reservation row `marketing.<bucket>` — written
 * before the work starts, and the only row that counts.
 */

/** Page reads, attempted. A competitor comparison with the user's own page takes two. */
export const RESEARCH_RATE_LIMIT = Object.freeze({ bucket: "limit.research", limit: 20, windowMs: 10 * 60 * 1000 });

/** Reports generated. Each reads the shared ad account up to five times. */
export const REPORT_RATE_LIMIT = Object.freeze({ bucket: "limit.report", limit: 10, windowMs: 10 * 60 * 1000 });

/** Publish checks, and the look a person asks for when settling an unconfirmed publish. Each reads the provider. */
export const PUBLISH_CHECK_RATE_LIMIT = Object.freeze({ bucket: "limit.publish_check", limit: 60, windowMs: 10 * 60 * 1000 });

type SlotPolicy = { readonly bucket: string; readonly limit: number; readonly windowMs: number };

/**
 * Why an SEO audit or a competitor comparison cannot be run on a server whose
 * operator has not switched page reads on. Said by the service when it is
 * asked, and — in a conversation — by the orchestrator, when a model names one
 * of the two tools on a server that did not register them.
 */
export const PAGE_RESEARCH_OFF =
  "Reading web pages is switched off on this server, so SEO audits and competitor comparisons are not available. An administrator can switch it on by setting BROWSER_ENABLED=true and restarting.";

/** What looking for an earlier attempt's post came to. */
type EarlierPost = { kind: "FOUND"; post: PublishedPost } | { kind: "TEXT_MISMATCH" } | { kind: "NOT_FOUND" };

/**
 * How many posts with an item's exact words, each already recorded as another
 * item's, are passed over before the look gives up. Giving up is not "not
 * found": it is "could not tell", and nothing changes.
 */
const EARLIER_POST_MAX_PASSED_OVER = 5;

/**
 * What an approval to LOOK is bound to when the item is unconfirmed and holds
 * no record of the attempt (no such row is written by this code; one may exist
 * from before the record was kept). It names "the unrecorded attempt", so that
 * the state is still bound.
 */
const UNRECORDED_ATTEMPT = "unrecorded";

/** The store's refusal to record a post another item already holds. Matched by its code, so no class has to be shared. */
function isRecordedElsewhere(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "POST_RECORDED_ELSEWHERE";
}

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

  /**
   * Take a slot for work that reaches outside JARVIS, or say why not.
   *
   * Null: go ahead — the slot is taken, and it stays taken whatever the work
   * comes to. Otherwise nothing has been started.
   */
  private async takeSlot(
    userId: string,
    ctx: MarketingCallContext,
    policy: SlotPolicy,
    throttled: string,
    tooMany: string
  ): Promise<{ code: "RATE_LIMITED" | "UNAVAILABLE"; message: string } | null> {
    if (!this.deps.limiter) return null;
    const decision = await this.deps.limiter.reserve(userId, policy.bucket, policy.limit, policy.windowMs, ctx.traceId ? { traceId: ctx.traceId } : {});
    if (decision.allowed) return null;
    await this.audit(userId, ctx, throttled, "rejected", {});
    return decision.reason === "UNAVAILABLE"
      ? { code: "UNAVAILABLE", message: "The request limit could not be checked just now, so nothing was started. Try again in a moment." }
      : { code: "RATE_LIMITED", message: tooMany };
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
    // A post with these words may be on the Page. Until that is settled the
    // item goes on saying exactly what was sent — nothing about it changes.
    if (current.publishUnconfirmed) {
      return marketingFail(
        "CONFLICT",
        "An earlier attempt to publish this item was sent and its outcome is not known, so it cannot be changed yet. Settle that attempt on the Marketing page first."
      );
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
      return marketingFail("CONFLICT", "This item is being published, was just published, or has a publish whose outcome is not known, so it was not changed.");
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

  private static readonly RESEARCH_OFF = PAGE_RESEARCH_OFF;

  /** One page read, metered and audited. The failure message is fit to show. */
  private async readPage(
    userId: string,
    url: string,
    ctx: MarketingCallContext
  ): Promise<{ ok: true; page: ReadPage } | { ok: false; code: "UNAVAILABLE" | "RATE_LIMITED" | "INVALID" | "PROVIDER_FAILED"; message: string }> {
    if (!this.deps.pages) return { ok: false, code: "UNAVAILABLE", message: MarketingService.RESEARCH_OFF };

    // The slot is taken BEFORE the page is fetched, and it is taken for the
    // attempt: a read that fails or is refused has still used it.
    const refused = await this.takeSlot(
      userId,
      ctx,
      RESEARCH_RATE_LIMIT,
      "marketing.research.throttled",
      "Too many pages have been read in the last few minutes. Wait a little and try again."
    );
    if (refused) return { ok: false, ...refused };

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

    // Both limits are answered BEFORE the ad account is read: a report that
    // could not be saved, or that this user has asked for too often, must not
    // cost the shared account a single call.
    if ((await this.deps.store.countReports(userId)) >= MARKETING_LIMITS.reportsPerUser) {
      return marketingFail("LIMIT", `At most ${MARKETING_LIMITS.reportsPerUser} reports are kept. Older ones are not removed automatically.`);
    }
    const refused = await this.takeSlot(
      userId,
      ctx,
      REPORT_RATE_LIMIT,
      "marketing.report.throttled",
      "Too many reports have been generated in the last few minutes. Wait a little and try again."
    );
    if (refused) return marketingFail(refused.code, refused.message);

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

  /** A hash of exactly what a publish of this item sends. Never the text. */
  private static sentHash(body: string, link: string | null): string {
    return computeParamsHash({ message: normalizeCopy(body), link: link ?? null });
  }

  /** The record of the attempt whose outcome is not known, when the item carries one. */
  private static originalAttempt(item: ContentItemView): ContentPublishAttempt | null {
    return item.publishAttempt?.state === "UNCONFIRMED" ? item.publishAttempt : null;
  }

  /**
   * Is this retry the SAME publish as the attempt whose outcome is not known?
   *
   * It has to be: what a retry does is look for that attempt's post, and a
   * post found on one Page says nothing about another, nor do words found
   * there say anything about different words. So a retry that names another
   * Page, or is for another text, is refused before anything else happens.
   * Null: it is the same publish.
   */
  private static heldToOriginal(
    original: ContentPublishAttempt | null,
    target: PublishTarget,
    sentHash: string
  ): { status: "TARGET_REFUSED" | "STALE"; code: string; message: string } | null {
    if (!original) return null;
    if (original.targetId && original.targetId !== target.id) {
      return {
        status: "TARGET_REFUSED",
        code: "TARGET_CHANGED",
        message: `An earlier attempt to publish this item went to ${original.targetName ?? "another Page"} and its outcome is not known. It cannot be sent to a different Page until that is settled. Nothing was published.`,
      };
    }
    if (original.textHash && original.textHash !== sentHash) {
      return {
        status: "STALE",
        code: "TEXT_CHANGED",
        message: "This item's text is not the text of the earlier attempt whose outcome is not known, so nothing was published. Settle that attempt on the Marketing page first.",
      };
    }
    return null;
  }

  /**
   * Which attempt an approval to LOOK was made for: when the attempt was
   * recorded, where it went and a hash of what it sent, as one opaque value.
   * Never the text. It stays the same for as long as that attempt is the one
   * outstanding — a look that finds nothing keeps all three — and is different
   * for any other attempt.
   */
  private static attemptIdentity(attempt: ContentPublishAttempt | null): string {
    if (!attempt) return UNRECORDED_ATTEMPT;
    // Kept short: in a conversation it reaches the publish tool by way of the
    // model, which has to hand it back character for character.
    return computeParamsHash({ at: attempt.at, targetId: attempt.targetId ?? null, textHash: attempt.textHash ?? null }).slice(0, 32);
  }

  /**
   * Is the item still in the state this approval was made for?
   *
   * An approval is for one of two things, and its parameters say which. A SEND
   * was approved for an item with no publish outstanding. A LOOK was approved
   * for the post of ONE earlier attempt whose outcome is not known, named by
   * its identity — and the person approving was told nothing would be posted.
   *
   * So the two may not be exchanged after the fact. If the attempt was settled
   * as not published while the approval to look waited, running it would POST
   * — what was approved as a look would be a send. And an approval to send
   * does not become a look because another publish went out in between. Either
   * way, and when the outstanding attempt is no longer the one that was named,
   * nothing is sent and the person is asked again.
   *
   * `unconfirmed` is null when the item has no publish outstanding; otherwise
   * it carries the record of the attempt that is. Null result: it is the state
   * the approval was made for.
   */
  private static stateRefusal(
    approvedLook: string | null,
    unconfirmed: { attempt: ContentPublishAttempt | null } | null,
    target: PublishTarget,
    sentHash: string
  ): { status: "TARGET_REFUSED" | "STALE"; code: string; message: string } | null {
    if (approvedLook === null) {
      if (!unconfirmed) return null;
      return {
        status: "STALE",
        code: "STATE_CHANGED",
        message:
          "An earlier publish of this item has an outcome that is not known, and this approval was for sending the post, not for looking for that one. Nothing was sent. Ask again: that only looks for the earlier post.",
      };
    }
    if (!unconfirmed) {
      return {
        status: "STALE",
        code: "STATE_CHANGED",
        message:
          "This approval was only to look for an earlier post, and that attempt has been settled since. Nothing was sent and nothing was published. Ask again to publish the item.",
      };
    }
    const held = MarketingService.heldToOriginal(unconfirmed.attempt, target, sentHash);
    if (held) return held;
    if (MarketingService.attemptIdentity(unconfirmed.attempt) !== approvedLook) {
      return {
        status: "STALE",
        code: "ATTEMPT_CHANGED",
        message:
          "The earlier attempt this approval was made to look for is not the one outstanding now. Nothing was sent and nothing was published. Ask again.",
      };
    }
    return null;
  }

  /**
   * May an unconfirmed attempt be settled against the item as it is saved NOW?
   *
   * Settling looks for the attempt's post by the item's words, and "it is not
   * there" is what clears the attempt and lets the item be sent again. That is
   * only an answer if the words looked for are the words that were sent. An
   * item cannot be edited while its publish is unconfirmed, so its text should
   * be the attempt's — but should is not is: if the row holds other words, or
   * the attempt kept no hash of what it sent, a look proves nothing and the
   * attempt stays exactly as it is. Null: the item still holds what was sent.
   */
  private static settleRefusal(
    original: ContentPublishAttempt | null,
    item: Pick<ContentItemView, "body" | "link">
  ): { code: string; message: string } | null {
    if (!original) return null;
    if (!original.textHash) {
      return {
        code: "NO_RECORD_OF_TEXT",
        message:
          "JARVIS has no record of the text the earlier attempt sent, so it cannot tell whether that post is on the Page. The attempt was not cleared and nothing was changed. If the post is live, record this item as published yourself.",
      };
    }
    if (original.textHash !== MarketingService.sentHash(item.body, item.link)) {
      return {
        code: "TEXT_CHANGED",
        message:
          "This item's text is not the text the earlier attempt sent, so looking for it on the Page would prove nothing. The attempt was not cleared and nothing was changed. If the post is live, record this item as published yourself.",
      };
    }
    return null;
  }

  /**
   * Look for the post an earlier attempt may have left — and say whether it IS
   * this item's post.
   *
   * By the id the provider gave, when there is one; then through the Page's own
   * recent posts. A post is this item's post only if its text, as the provider
   * returns it, is the item's text. A post found by id with other text, or with
   * no text at all, is a post that exists and is NOT confirmed.
   *
   * AND ONLY IF IT IS NOT SOMETHING ELSE'S. Two calendar items can hold the
   * same words. A post already recorded as another item's is that item's post,
   * whatever its text, so it is passed over and the Page is looked through
   * again without it: this item's own post, if there is one, is a different
   * post further down. Passing over more than a handful is "could not tell",
   * which is thrown, not answered as "not found".
   *
   * It throws when the provider cannot be asked. That is not "not found".
   */
  private async lookForEarlierPost(
    publisher: ContentPublisher,
    contentId: string,
    original: ContentPublishAttempt & { targetId: string },
    body: string,
    options: { signal?: AbortSignal }
  ): Promise<EarlierPost> {
    const anotherItems = (post: PublishedPost): Promise<boolean> =>
      this.deps.store.isPostRecordedElsewhere(publisher.provider, post.externalId, contentId);
    const passedOver: string[] = [];

    if (original.externalId) {
      const byId = await publisher.read({ targetId: original.targetId, externalId: original.externalId }, options);
      if (byId) {
        if (!(await anotherItems(byId))) {
          return byId.message !== null && sameText(byId.message, body) ? { kind: "FOUND", post: byId } : { kind: "TEXT_MISMATCH" };
        }
        passedOver.push(byId.externalId);
      }
    }
    // "No such post" by id can also mean "not readable right now", so the
    // Page's own recent posts are looked through as well.
    const attemptedAt = Date.parse(original.at);
    const since = new Date((Number.isFinite(attemptedAt) ? attemptedAt : this.now().getTime()) - 10 * 60 * 1000);
    while (passedOver.length <= EARLIER_POST_MAX_PASSED_OVER) {
      const byText = await publisher.findByMessage(
        { targetId: original.targetId, message: body, since, ...(passedOver.length > 0 ? { excludeIds: [...passedOver] } : {}) },
        options
      );
      if (!byText || byText.message === null || !sameText(byText.message, body)) return { kind: "NOT_FOUND" };
      // A publisher that hands back a post it was told to pass over cannot be
      // looked through any further.
      if (passedOver.includes(byText.externalId)) break;
      if (!(await anotherItems(byText))) return { kind: "FOUND", post: byText };
      passedOver.push(byText.externalId);
    }
    throw new Error("The Page holds more posts with these words, recorded as other items', than can be told apart.");
  }

  /**
   * Can this item be published, where, and with exactly which parameters?
   *
   * A read. It builds `publishParams` from the SAVED item and the provider's
   * own list of targets — the text and the place a person will be shown, and
   * the only parameters `publish` will accept. It takes a slot before it asks
   * the provider anything.
   *
   * While an earlier attempt is unconfirmed, the only place it offers is the
   * Page that attempt went to, and it says what asking again will do: look.
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
    const original = state === "UNCONFIRMED" ? MarketingService.originalAttempt(item) : null;

    const publisher = this.publisherFor(item.channel);
    let targets: PublishTarget[] = [];
    if (publisher) {
      const refused = await this.takeSlot(
        userId,
        ctx,
        PUBLISH_CHECK_RATE_LIMIT,
        "marketing.publish.check_throttled",
        "Too many publish checks have been made in the last few minutes. Wait a little and try again."
      );
      if (refused) return marketingFail(refused.code, refused.message);
      try {
        targets = await publisher.listTargets(ctx.signal ? { signal: ctx.signal } : {});
        if (targets.length === 0) blockers.push(`The ${channelLabel(item.channel)} connection has no Page it is allowed to post to.`);
      } catch (error) {
        blockers.push(error instanceof PublisherError ? error.message : `The ${channelLabel(item.channel)} connection could not be reached.`);
      }
    }

    let target: PublishTarget | undefined;
    if (targets.length > 0) {
      if (original?.targetId) {
        // Held to the Page the earlier attempt went to. No other is offered.
        const held = targets.find((candidate) => candidate.id === original.targetId);
        if (targetId && targetId !== original.targetId) {
          blockers.push(
            `An earlier attempt to publish this item went to ${original.targetName ?? "another Page"} and its outcome is not known. It cannot be sent to a different Page until that is settled.`
          );
        } else if (!held) {
          blockers.push(
            `The earlier attempt to publish this item went to ${original.targetName ?? "a Page"}, which this connection can no longer publish to. Settle that attempt on the Marketing page.`
          );
        } else {
          target = held;
        }
        targets = held ? [held] : [];
      } else if (targetId) {
        target = targets.find((candidate) => candidate.id === targetId);
        if (!target) blockers.push("That is not a place this item can be published to.");
      } else if (targets.length === 1) {
        target = targets[0];
      } else {
        blockers.push(`Choose where to publish it: ${targets.map((candidate) => candidate.name).join(", ")}.`);
      }
    }
    if (original?.textHash && original.textHash !== MarketingService.sentHash(item.body, item.link)) {
      blockers.push("This item's text is not the text of the earlier attempt whose outcome is not known. Settle that attempt on the Marketing page.");
    }

    const ready = blockers.length === 0 && target !== undefined;
    return marketingOk({
      ready,
      blockers,
      channel: item.channel,
      targets,
      // What will be approved is said IN the parameters the approval is bound
      // to: with `earlierAttempt`, a look for that one attempt's post; without
      // it, a send. Whichever it is here is what the execution is held to.
      publishParams: ready
        ? {
            contentId: item.id,
            targetId: target!.id,
            targetName: target!.name,
            message: item.body,
            ...(item.link ? { link: item.link } : {}),
            ...(state === "UNCONFIRMED" ? { earlierAttempt: MarketingService.attemptIdentity(original) } : {}),
          }
        : null,
      warning:
        state === "UNCONFIRMED"
          ? `An earlier attempt to publish this item was sent${original?.targetName ? ` to ${original.targetName}` : ""} and its outcome is not known. Asking again only LOOKS for that post: if it is on the Page with this text it is recorded as published, and if it is not found nothing is posted.`
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
   * WHAT IT DOES IS WHAT WAS APPROVED, and the claim is what holds it to that.
   * An approval to send takes the item only while it has no publish
   * outstanding: it sends, then reads back. An approval to look takes it only
   * while the earlier publish it names is still unconfirmed: it looks for that
   * publish's post, and sends nothing. If the item is in the other state by
   * the time the approval runs, nothing is taken and nothing is sent.
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
    const { item, publisher, target, original, sentHash } = taken;
    const none = publishOutcome;

    const options = ctx.signal ? { signal: ctx.signal } : {};
    const attempt = (state: ContentPublishAttempt["state"], code: string, externalId: string | null): ContentPublishAttempt => ({
      state,
      at: this.now().toISOString(),
      code,
      targetId: target.id,
      targetName: target.name,
      externalId,
      textHash: sentHash,
      lastLookup: null,
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
      } catch (error) {
        // A post another item already holds is not this item's post. That is
        // not a record that failed to be written; whoever asked decides what
        // it means for a send and for a look.
        if (isRecordedElsewhere(error)) throw error;
        recorded = null;
      }
      if (!recorded) {
        // The post is on the Page and was read back — but the record that says
        // so could not be written. It stays unpublished HERE, honestly; asking
        // again looks for the post and, if it is found, records it.
        await this.auditPublish(userId, ctx, params, "failure", "RECORD_FAILED", post.externalId);
        return none(
          "UNCONFIRMED",
          "RECORD_FAILED",
          "The post is on the Page and was read back, but JARVIS could not record that. It is not marked as published yet. Asking to publish again looks for the post and records it if it is found; nothing new is sent."
        );
      }
      await this.auditPublish(userId, ctx, params, "success", status, post.externalId);
      return {
        status,
        code: status,
        message:
          status === "PUBLISHED"
            ? `Published to ${target.name} and read back from the Page.`
            : `An earlier attempt had already published this to ${target.name}. It was found on the Page with this text and is now recorded as published. Nothing new was posted.`,
        content: recorded,
      };
    };

    if (original) {
      return this.lookOnly({ userId, params, ctx, item, publisher, target, original, options, finalize });
    }
    return this.sendAndVerify({ userId, params, ctx, item, publisher, target, options, attempt, finalize });
  }

  /**
   * Everything that is checked BEFORE a publish is sent, ending in the claim.
   *
   * Every refusal from here means nothing was transmitted: the item, the
   * publisher, the approved words against the saved words, the target against
   * the provider's own list, the state the approval was made for against the
   * state the item is in — and then the conditional write that gives exactly
   * one execution the item, from that state and no other.
   *
   * `original` is null when the claim was taken from an item with no publish
   * outstanding: this execution may send, and only an approval to send can
   * take that claim. Otherwise it is the record of the attempt whose outcome
   * is not known — the one the approval named — read UNDER the claim, and this
   * execution may only look.
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
        original: (ContentPublishAttempt & { targetId: string }) | null;
        sentHash: string;
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

      const sentHash = MarketingService.sentHash(item.body, item.link);
      // What this approval was made for: a look for one earlier attempt's
      // post, named by its identity — or, when it names none, a send.
      const approvedLook = params.earlierAttempt ?? null;
      const raw = await this.deps.store.publishStateOf(userId, item.id);
      const state = raw ? effectivePublishState(raw.state, raw.claimedAt, this.now()) : "NONE";
      if (state === "PUBLISHING") {
        return none("IN_PROGRESS", "IN_PROGRESS", "Another publish of this item is already running. Nothing was published by this request.", item);
      }
      // Said early, where it costs nothing. The claim below is what decides.
      const early = MarketingService.stateRefusal(
        approvedLook,
        state === "UNCONFIRMED" ? { attempt: MarketingService.originalAttempt(item) } : null,
        target,
        sentHash
      );
      if (early) {
        await this.auditPublish(userId, ctx, params, "rejected", early.code);
        return none(early.status, early.code, early.message, item);
      }

      // The conditional write: exactly one execution takes the item, only while
      // its copy is still the approved copy — and only from the state the
      // approval was made for. An approval to send takes it from NO publish
      // outstanding, and writes with the claim where this attempt is going and
      // a hash of what it sends, so that an attempt that never reports back
      // still leaves both behind. An approval to look takes it from
      // UNCONFIRMED and writes nothing. Neither can take the other's claim, so
      // an attempt cleared after a look was approved cannot turn it into a send.
      const starting: ContentPublishAttempt = {
        state: "UNCONFIRMED",
        at: this.now().toISOString(),
        code: "SENDING",
        targetId: target.id,
        targetName: target.name,
        externalId: null,
        textHash: sentHash,
        lastLookup: null,
      };
      const claimed = await this.deps.store.claimForPublish(
        userId,
        item.id,
        { channel: item.channel, body: item.body, link: item.link },
        approvedLook === null ? { from: "NONE", attempt: starting } : { from: "UNCONFIRMED" }
      );
      if (!claimed) {
        const after = await this.deps.store.publishStateOf(userId, item.id);
        const stateNow = after ? effectivePublishState(after.state, after.claimedAt, this.now()) : "NONE";
        if (stateNow === "PUBLISHING") {
          return none("IN_PROGRESS", "IN_PROGRESS", "Another publish of this item is already running. Nothing was published by this request.", item);
        }
        // Recorded as published between the read above and the claim — by
        // another retry that found the post, or by its owner. That is what is
        // true now, so it is what is said: not "nothing was published, ask
        // again".
        const latest = await this.deps.store.findContent(userId, { kind: "ALL" }, item.id);
        if (latest && (latest.status === "PUBLISHED" || latest.publication)) {
          return none("NOT_READY", "ALREADY_PUBLISHED", "This item is already published. Nothing new was posted.", latest);
        }
        // Not taken because the item left the state the approval was made for
        // between the read above and the claim — or because its copy changed.
        const moved = MarketingService.stateRefusal(approvedLook, stateNow === "UNCONFIRMED" ? { attempt: null } : null, target, sentHash);
        if (moved?.code === "STATE_CHANGED") {
          await this.auditPublish(userId, ctx, params, "rejected", moved.code);
          return none(moved.status, moved.code, moved.message, item);
        }
        return none("STALE", "STALE", "The item changed while it was being published, so nothing was published. Check it and ask again.", item);
      }
      if (claimed === "FRESH") return { ok: true, item, publisher, target, original: null, sentHash };

      // An earlier publish was outstanding, and a look for it is what was
      // approved. Its record is read now, under the claim, where nothing else
      // can be changing it — and this execution is held to it: the same Page,
      // the same words, and the very attempt the approval named. With no
      // usable record (none is written without one since this rule existed)
      // the approved Page is where the looking is done.
      const held = await this.deps.store.findContent(userId, { kind: "ALL" }, item.id);
      const recorded = held ? MarketingService.originalAttempt(held) : null;
      const refusal = MarketingService.stateRefusal(approvedLook, { attempt: recorded }, target, sentHash);
      if (refusal) {
        await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", recorded ?? { ...starting, code: "AMBIGUOUS_OUTCOME" });
        await this.auditPublish(userId, ctx, params, "rejected", refusal.code);
        return none(refusal.status, refusal.code, refusal.message, held ?? item);
      }
      const original = { ...(recorded ?? { ...starting, code: "AMBIGUOUS_OUTCOME" }), targetId: recorded?.targetId ?? target.id };
      return { ok: true, item, publisher, target, original, sentHash };
    }
  }

  /**
   * A retry of a publish whose outcome is not known. It LOOKS, and that is all.
   *
   *   found, with the item's text   recorded as published — read back, verified
   *   found by id, other text       still unconfirmed; nothing recorded
   *   not found                     still unconfirmed; NOTHING IS SENT. Whether
   *                                 to try again is a person's decision, made
   *                                 through `resolveUnconfirmed`.
   *   the Page cannot be asked      still unconfirmed; nothing is sent
   */
  private async lookOnly(input: {
    userId: string;
    params: PublishParams;
    ctx: MarketingCallContext;
    item: ContentItemView;
    publisher: ContentPublisher;
    target: PublishTarget;
    original: ContentPublishAttempt & { targetId: string };
    options: { signal?: AbortSignal };
    finalize: (post: PublishedPost, status: "PUBLISHED" | "ALREADY_PUBLISHED") => Promise<PublishOutcome>;
  }): Promise<PublishOutcome> {
    const { userId, params, ctx, item, publisher, target, original, options, finalize } = input;
    const none = publishOutcome;

    let look: EarlierPost;
    try {
      look = await this.lookForEarlierPost(publisher, item.id, original, item.body, options);
    } catch {
      await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", original);
      await this.auditPublish(userId, ctx, params, "failure", "RECONCILE_FAILED");
      return none(
        "FAILED",
        "RECONCILE_FAILED",
        "An earlier attempt may have published this item, and the Page could not be checked to find out. Nothing new was posted. Try again once the connection is working.",
        item
      );
    }
    if (look.kind === "FOUND") {
      try {
        return await finalize(look.post, "ALREADY_PUBLISHED");
      } catch (error) {
        if (!isRecordedElsewhere(error)) throw error;
        // Another item recorded that very post between the look and the
        // write. It is that item's post, so this one's was not found.
        look = { kind: "NOT_FOUND" };
      }
    }

    // The original attempt is kept exactly as it was, with what was just learned beside it.
    const kept: ContentPublishAttempt = { ...original, lastLookup: { at: this.now().toISOString(), result: look.kind } };
    const content = await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", kept);

    if (look.kind === "TEXT_MISMATCH") {
      await this.auditPublish(userId, ctx, params, "failure", "RECONCILE_MISMATCH", original.externalId ?? undefined);
      return none(
        "UNCONFIRMED",
        "RECONCILE_MISMATCH",
        `A post from the earlier attempt is on ${target.name}, but its text could not be confirmed as this item's text. It is NOT marked as published, and nothing new was posted. Check the Page.`,
        content ?? item
      );
    }
    await this.auditPublish(userId, ctx, params, "failure", "NOT_FOUND_ON_PAGE");
    return none(
      "UNCONFIRMED",
      "NOT_FOUND_ON_PAGE",
      `JARVIS looked for the earlier post on ${target.name} and did not find it. Nothing new was posted, and the item is still not marked as published. Check the Page yourself: if the post is not there, say so on the Marketing page — only then can it be published again.`,
      content ?? item
    );
  }

  /**
   * The part of a publish that sends, entered only by the one execution whose
   * claim was taken from an item with NO publish outstanding: send, read back,
   * record.
   */
  private async sendAndVerify(input: {
    userId: string;
    params: PublishParams;
    ctx: MarketingCallContext;
    item: ContentItemView;
    publisher: ContentPublisher;
    target: PublishTarget;
    options: { signal?: AbortSignal };
    attempt: (state: ContentPublishAttempt["state"], code: string, externalId: string | null) => ContentPublishAttempt;
    finalize: (post: PublishedPost, status: "PUBLISHED" | "ALREADY_PUBLISHED") => Promise<PublishOutcome>;
  }): Promise<PublishOutcome> {
    const { userId, params, ctx, item, publisher, target, options, attempt, finalize } = input;
    const none = publishOutcome;

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
          `The post was sent to ${target.name}, but the answer never arrived, so it is not known whether it was published. It is NOT marked as published. Check the Page. Asking to publish again will only look for that post — nothing more is sent until this is settled.`,
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
    // published when the post can be read from the provider by its id AND the
    // text that comes back is the text that was sent.
    let post: PublishedPost | null = null;
    for (let tries = 0; tries < 2 && !post; tries += 1) {
      if (tries > 0) await new Promise((resolve) => setTimeout(resolve, this.deps.verifyRetryDelayMs ?? 1000));
      try {
        post = await publisher.read({ targetId: target.id, externalId }, options);
      } catch {
        post = null;
      }
    }

    if (!post || post.message === null || !sameText(post.message, item.body)) {
      const code = !post ? "VERIFY_FAILED" : post.message === null ? "VERIFY_NO_TEXT" : "VERIFY_MISMATCH";
      const content = await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", attempt("UNCONFIRMED", code, externalId));
      await this.auditPublish(userId, ctx, params, "failure", code, externalId);
      const said =
        code === "VERIFY_FAILED"
          ? `${target.name} accepted the post, but JARVIS could not read it back to confirm it.`
          : code === "VERIFY_NO_TEXT"
            ? `${target.name} accepted the post, but its text could not be read back to confirm it.`
            : `${target.name} accepted the post, but what was read back is not the text that was sent.`;
      return none(
        "UNCONFIRMED",
        code,
        `${said} It is NOT marked as published. Check the Page. Asking to publish again will only look for that post — nothing more is sent until this is settled.`,
        content ?? item
      );
    }

    try {
      return await finalize(post, "PUBLISHED");
    } catch (error) {
      if (!isRecordedElsewhere(error)) throw error;
      // The provider answered this send with a post that is already recorded
      // as ANOTHER item's. Whatever it is, it is not evidence that this item
      // was published: one post is one item.
      const content = await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", attempt("UNCONFIRMED", "POST_RECORDED_ELSEWHERE", externalId));
      await this.auditPublish(userId, ctx, params, "failure", "POST_RECORDED_ELSEWHERE", externalId);
      return none(
        "UNCONFIRMED",
        "POST_RECORDED_ELSEWHERE",
        `${target.name} answered with a post that is already recorded as a different calendar item's post, so this item is NOT marked as published. Check the Page. Asking to publish again will only look for this item's own post — nothing more is sent until this is settled.`,
        content ?? item
      );
    }
  }

  /**
   * A person's decision about a publish whose outcome is not known: "it was
   * NOT published".
   *
   * This is the only way an unconfirmed item becomes publishable again, and it
   * is never the system's own conclusion. A person says so; JARVIS then looks
   * once more, on the Page the attempt went to, and:
   *
   *   the post IS there, with the item's text   it is recorded as published.
   *                                             The person was mistaken, and
   *                                             nothing is cleared.
   *   a post from the attempt is there, with    nothing changes. Clearing would
   *   other text                                invite a second post beside it.
   *   the Page cannot be asked                  nothing changes.
   *   the post is not there                     the attempt is cleared — on the
   *                                             person's word, with what JARVIS
   *                                             saw recorded beside it.
   *
   * BEFORE IT LOOKS AT ALL, it is held to the attempt as a retry is: the item
   * must still hold exactly the words that attempt sent, and the Page it went
   * to must still be one this connection can read. Otherwise nothing changes.
   *
   * It sends nothing to the provider but reads. The decision, who made it and
   * what the look found go to the audit log — and the two outcomes that CHANGE
   * the item are written in one transaction with their audit row. An attempt
   * is never cleared, and an item never recorded as published here, without
   * that row: if it cannot be written, the decision is not carried out.
   */
  async resolveUnconfirmed(
    userId: string,
    contentId: string,
    input: { decision: string },
    ctx: MarketingCallContext
  ): Promise<MarketingResult<PublishResolution>> {
    if (!ID.test(contentId)) return marketingFail("NOT_FOUND", "That content item was not found.");
    if (input.decision !== "NOT_PUBLISHED") {
      return marketingFail("INVALID", "decision: the only decision recorded here is NOT_PUBLISHED. If the post is on the Page, record the item as published instead.");
    }
    const scoped = await this.scope(userId, ctx);
    if (!scoped.ok) return scoped;
    const item = await this.deps.store.findContent(userId, scoped.value.scope, contentId);
    if (!item) return marketingFail("NOT_FOUND", "That content item was not found.");
    if (item.status === "PUBLISHED" || item.publication) return marketingFail("CONFLICT", "This item is already recorded as published.");

    const raw = await this.deps.store.publishStateOf(userId, item.id);
    const state = raw ? effectivePublishState(raw.state, raw.claimedAt, this.now()) : "NONE";
    if (state === "PUBLISHING") return marketingFail("CONFLICT", "A publish of this item is running. Wait for it to finish.");
    if (state !== "UNCONFIRMED") return marketingFail("CONFLICT", "This item has no publish whose outcome is unknown, so there is nothing to settle.");

    const publisher = this.publisherFor(item.channel);
    if (!publisher) {
      return marketingFail("UNAVAILABLE", `JARVIS has no publishing connection for ${channelLabel(item.channel)}, so the Page cannot be checked. Nothing was changed.`);
    }

    /** What the audit log is told about this decision. Ids, the decision and what came of it — never the text. */
    const parametersOf = (outcome: string, attempt: ContentPublishAttempt | null, externalId?: string | null): Record<string, unknown> => ({
      contentId: item.id,
      decision: input.decision,
      outcome,
      ...(attempt?.targetId ? { targetId: attempt.targetId } : {}),
      ...(externalId ? { externalId } : {}),
    });

    // Said early, where it costs nothing: no slot is taken and the item is not
    // claimed. The read made under the claim, below, is what decides.
    const first = MarketingService.originalAttempt(item);
    const early = MarketingService.settleRefusal(first, item);
    if (early) {
      await this.audit(userId, ctx, "marketing.publish.resolve", "rejected", parametersOf(early.code, first, first?.externalId));
      return marketingFail("CONFLICT", early.message);
    }

    const refused = await this.takeSlot(
      userId,
      ctx,
      PUBLISH_CHECK_RATE_LIMIT,
      "marketing.publish.check_throttled",
      "Too many publish checks have been made in the last few minutes. Wait a little and try again."
    );
    if (refused) return marketingFail(refused.code, refused.message);

    // One conditional write takes the item, so a publish and this cannot both act on it.
    if (!(await this.deps.store.claimUnconfirmed(userId, item.id))) {
      return marketingFail("CONFLICT", "This item's publish is no longer waiting to be settled. Nothing was changed.");
    }
    const held = await this.deps.store.findContent(userId, { kind: "ALL" }, item.id);
    const recorded = held ? MarketingService.originalAttempt(held) : null;
    const audit = (result: "success" | "failure" | "rejected", outcome: string, externalId?: string | null): Promise<void> =>
      this.audit(userId, ctx, "marketing.publish.resolve", result, parametersOf(outcome, recorded, externalId));

    if (!held || !recorded || !recorded.targetId) {
      // Nothing says where the attempt went, so there is nowhere to look.
      await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", recorded ?? {
        state: "UNCONFIRMED",
        at: this.now().toISOString(),
        code: "AMBIGUOUS_OUTCOME",
        targetId: null,
        targetName: null,
        externalId: null,
        textHash: MarketingService.sentHash(item.body, item.link),
        lastLookup: null,
      });
      await audit("rejected", "NO_RECORD_OF_TARGET");
      return marketingFail("CONFLICT", "JARVIS has no record of where the earlier attempt was sent, so it cannot check the Page. If the post is live, record this item as published yourself.");
    }
    const original = { ...recorded, targetId: recorded.targetId };
    const where = original.targetName ?? "the Page";
    const options = ctx.signal ? { signal: ctx.signal } : {};
    /** Give the item back exactly as it was: still unconfirmed, the original attempt untouched. */
    const keep = async (): Promise<void> => {
      await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", original);
    };

    // THE SAME ATTEMPT THIS DECISION WAS CHECKED AGAINST. The item was read
    // before the claim, and what lies under the claim is read again now. If the
    // attempt was settled and the item sent again in between, this is a NEW
    // attempt — and "it was not published", said about the old one, is not
    // carried out on it. Looking again leaves its identity as it was, so a
    // retry that merely looked in that moment changes nothing here.
    if (MarketingService.attemptIdentity(first) !== MarketingService.attemptIdentity(recorded)) {
      await keep();
      await audit("rejected", "ATTEMPT_CHANGED", original.externalId);
      return marketingFail("CONFLICT", "The earlier attempt changed while it was being settled, so nothing was cleared. Look at the item again and decide again.");
    }

    // HELD TO THE ATTEMPT, as a retry is — its words and its Page — before
    // anything is looked for. Looking for other words, or on a Page that is no
    // longer the one the attempt went to, proves nothing; and "not found" is
    // exactly what such a look would say. Read under the claim, where nothing
    // else can be changing the row.
    const changed = MarketingService.settleRefusal(recorded, held);
    if (changed) {
      await keep();
      await audit("rejected", changed.code, original.externalId);
      return marketingFail("CONFLICT", changed.message);
    }
    let targets: PublishTarget[];
    try {
      targets = await publisher.listTargets(options);
    } catch {
      await keep();
      await audit("failure", "TARGET_CHECK_FAILED");
      return marketingFail("PROVIDER_FAILED", "The Page could not be checked, so nothing was changed. Try again once the connection is working.");
    }
    if (!targets.some((candidate) => candidate.id === original.targetId)) {
      await keep();
      await audit("rejected", "TARGET_CHANGED", original.externalId);
      return marketingFail(
        "CONFLICT",
        `The earlier attempt went to ${where}, which this connection can no longer publish to, so JARVIS cannot check whether the post is there. The attempt was not cleared. If the post is live, record this item as published yourself.`
      );
    }

    let look: EarlierPost;
    try {
      look = await this.lookForEarlierPost(publisher, item.id, original, held.body, options);
    } catch {
      await keep();
      await audit("failure", "LOOKUP_FAILED");
      return marketingFail("PROVIDER_FAILED", "The Page could not be checked, so nothing was changed. Try again once the connection is working.");
    }

    const lookedAt = this.now();
    /** The audit row that is written in the SAME transaction as the change it describes. */
    const decision = (outcome: string, externalId?: string | null) => ({
      action: "marketing.publish.resolve",
      parameters: parametersOf(outcome, recorded, externalId),
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    });

    if (look.kind === "FOUND") {
      let published: ContentItemView | null;
      try {
        published = await this.deps.store.finalizePublished(
          userId,
          item.id,
          {
            provider: publisher.provider,
            targetName: where,
            externalId: look.post.externalId,
            url: look.post.url,
            publishedAt: look.post.createdAt ? new Date(look.post.createdAt) : lookedAt,
            verifiedAt: lookedAt,
          },
          decision("FOUND_PUBLISHED", look.post.externalId)
        );
      } catch (error) {
        // Recorded with its audit row, or not at all. Nothing is cleared either way.
        await keep().catch(() => undefined);
        if (isRecordedElsewhere(error)) {
          await audit("rejected", "POST_RECORDED_ELSEWHERE", look.post.externalId);
          return marketingFail("CONFLICT", `The post found on ${where} has just been recorded as another calendar item's post, so it was not recorded as this one's. Nothing was cleared. Try again.`);
        }
        await audit("failure", "DECISION_NOT_RECORDED", look.post.externalId);
        return marketingFail("UNAVAILABLE", `The post IS on ${where}, but JARVIS could not record that, so nothing was changed. Try again.`);
      }
      if (!published) return marketingFail("CONFLICT", "The item changed while it was being settled. Nothing was cleared.");
      return marketingOk({
        resolution: "FOUND_PUBLISHED",
        message: `The post IS on ${where}, with this item's text. It is recorded as published. Nothing was cleared and nothing new was posted.`,
        item: published,
      });
    }

    if (look.kind === "TEXT_MISMATCH") {
      await this.deps.store.releasePublish(userId, item.id, "UNCONFIRMED", { ...original, lastLookup: { at: lookedAt.toISOString(), result: "TEXT_MISMATCH" } });
      await audit("rejected", "TEXT_MISMATCH", original.externalId);
      return marketingFail(
        "CONFLICT",
        `A post from the earlier attempt is on ${where}, but its text could not be confirmed as this item's text, so the attempt was not cleared. Remove that post on the Page and try again, or record this item as published yourself.`
      );
    }

    // NOT FOUND, and a person said it was not published: the attempt is
    // cleared — which is what makes the item sendable again. So it is cleared
    // ONLY together with the audit row that says who decided it and what was
    // seen: one transaction, both or neither. If the row cannot be written the
    // decision is not carried out, and the item is given back unconfirmed.
    let cleared: ContentItemView | null;
    try {
      cleared = await this.deps.store.clearUnconfirmed(
        userId,
        item.id,
        {
          state: "FAILED",
          at: lookedAt.toISOString(),
          code: "CLEARED_BY_USER",
          targetId: original.targetId,
          targetName: original.targetName,
          externalId: original.externalId,
          textHash: original.textHash ?? null,
          lastLookup: { at: lookedAt.toISOString(), result: "NOT_FOUND" },
        },
        decision("CLEARED", original.externalId)
      );
    } catch {
      await this.deps.store
        .releasePublish(userId, item.id, "UNCONFIRMED", { ...original, lastLookup: { at: lookedAt.toISOString(), result: "NOT_FOUND" } })
        .catch(() => undefined);
      await audit("failure", "DECISION_NOT_RECORDED", original.externalId);
      return marketingFail(
        "UNAVAILABLE",
        "Your decision could not be recorded, so the earlier attempt was NOT cleared and nothing was changed. The item is still waiting to be settled. Try again."
      );
    }
    if (!cleared) return marketingFail("CONFLICT", "The item changed while it was being settled. Nothing was cleared.");
    return marketingOk({
      resolution: "CLEARED",
      message: `JARVIS looked on ${where} and did not find the post, and you said it was not published. The earlier attempt is cleared. The item can be edited and published again — and publishing it again WILL post it.`,
      item: cleared,
    });
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
