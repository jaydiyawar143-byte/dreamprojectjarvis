// ---------------------------------------------------------------------------
// Phase 15 — the marketing workspace store.
//
// Campaigns, content items, reports and page research. EVERY method takes the
// owner's id and filters on it, so an id is only ever a way to choose among
// the caller's own rows — another user's id finds nothing, exactly as an
// unknown one does. Nothing here returns a `userId`.
//
// SCOPE BESIDE OWNERSHIP. A `MarketingScope` narrows the caller's own rows to
// one project, to the personal ones, or not at all. It is always written
// beside the user filter (`scoped()` below is the one place that happens) and
// never instead of it.
//
// THE THREE WRITES THAT ARE CONDITIONAL, and why they are one statement each:
//
//   claimForPublish     NONE/UNCONFIRMED -> PUBLISHING, only while the saved
//                       copy is still exactly what was approved. Two
//                       executions racing for one item: the affected-row
//                       count picks one, the other publishes nothing.
//   finalizePublished   PUBLISHING -> PUBLISHED with its evidence, in the same
//                       statement that clears the claim.
//   releasePublish      PUBLISHING -> NONE or UNCONFIRMED.
//
// A read followed by a write would let two requests both pass the check.
//
// There is no delete. A campaign is archived, a content item is archived, and
// a report is a record.
// ---------------------------------------------------------------------------

import type {
  ContentItem as ContentRow,
  MarketingCampaign as CampaignRow,
  MarketingReport as ReportRow,
  MarketingResearch as ResearchRow,
  PrismaClient,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  CONTENT_PUBLISH_CLAIM_TTL_MS,
  CONTENT_STATUSES,
  JarvisError,
  MARKETING_LIMITS,
  effectivePublishState,
  emptyStatusCounts,
  type CampaignStatus,
  type CompetitorAnalysis,
  type ContentFormat,
  type ContentItemView,
  type ContentPublication,
  type ContentPublishAttempt,
  type ContentPublishState,
  type ContentStatus,
  type MarketingCampaignView,
  type MarketingChannel,
  type MarketingReportDocument,
  type MarketingReportKind,
  type MarketingReportSummary,
  type MarketingReportView,
  type MarketingResearchKind,
  type MarketingResearchSummary,
  type MarketingResearchView,
  type MarketingScope,
  type PageFetchProvenance,
  type SeoAudit,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

/** A calendar date as the database holds it: midnight UTC of that day. */
function toDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function toDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function scoped(userId: string, scope: MarketingScope): { userId: string; projectId?: string | null } {
  if (scope.kind === "PROJECT") return { userId, projectId: scope.projectId };
  if (scope.kind === "PERSONAL") return { userId, projectId: null };
  return { userId };
}

function toCampaign(row: CampaignRow): MarketingCampaignView {
  return {
    id: row.id,
    name: row.name,
    objective: row.objective,
    brief: row.brief,
    status: row.status as CampaignStatus,
    channels: row.channels as MarketingChannel[],
    startDate: toDay(row.startDate),
    endDate: toDay(row.endDate),
    projectId: row.projectId,
    metaCampaignIds: row.metaCampaignIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAttempt(value: Prisma.JsonValue | null): ContentPublishAttempt | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.state !== "UNCONFIRMED" && record.state !== "FAILED") return null;
  const text = (key: string): string | null => (typeof record[key] === "string" ? (record[key] as string) : null);
  return {
    state: record.state,
    at: text("at") ?? new Date(0).toISOString(),
    code: text("code") ?? "UNKNOWN",
    targetId: text("targetId"),
    targetName: text("targetName"),
    externalId: text("externalId"),
  };
}

function toPublication(row: ContentRow): ContentPublication | null {
  if (row.publicationMode !== "VERIFIED" && row.publicationMode !== "REPORTED_BY_USER") return null;
  if (row.publishedAt === null) return null;
  return {
    mode: row.publicationMode,
    publishedAt: row.publishedAt.toISOString(),
    provider: row.publishedVia,
    targetName: row.publishedTarget,
    externalId: row.externalId,
    url: row.externalUrl,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
  };
}

function toContent(row: ContentRow, now: Date): ContentItemView {
  const state = effectivePublishState(row.publishState as ContentPublishState, row.publishClaimedAt, now);
  return {
    id: row.id,
    campaignId: row.campaignId,
    projectId: row.projectId,
    title: row.title,
    channel: row.channel as MarketingChannel,
    format: row.format as ContentFormat,
    body: row.body,
    link: row.link,
    notes: row.notes,
    status: row.status as ContentStatus,
    scheduledDate: toDay(row.scheduledDate),
    scheduledTime: row.scheduledTime,
    publication: toPublication(row),
    publishAttempt: toAttempt(row.publishAttempt),
    publishUnconfirmed: state === "UNCONFIRMED",
    createdBy: row.createdBy === "jarvis" ? "jarvis" : "user",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toReportSummary(row: Omit<ReportRow, "document">): MarketingReportSummary {
  return {
    id: row.id,
    kind: row.kind as MarketingReportKind,
    title: row.title,
    campaignId: row.campaignId,
    projectId: row.projectId,
    periodStart: toDay(row.periodStart)!,
    periodEnd: toDay(row.periodEnd)!,
    generatedAt: row.generatedAt.toISOString(),
    sourcesIncluded: row.sourcesIncluded,
    sourcesTotal: row.sourcesTotal,
  };
}

function toReport(row: ReportRow): MarketingReportView {
  return { ...toReportSummary(row), document: row.document as unknown as MarketingReportDocument };
}

function toResearchSummary(row: Omit<ResearchRow, "provenance" | "result">): MarketingResearchSummary {
  return {
    id: row.id,
    kind: row.kind as MarketingResearchKind,
    campaignId: row.campaignId,
    projectId: row.projectId,
    host: row.host,
    url: row.url,
    fetchedAt: row.fetchedAt.toISOString(),
    headline: row.headline,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What the `result` column holds. One of the two is present, by `kind`. */
interface ResearchResult {
  audit?: SeoAudit;
  competitor?: CompetitorAnalysis;
  ownProvenance?: PageFetchProvenance;
}

function toResearch(row: ResearchRow): MarketingResearchView {
  const result = (row.result ?? {}) as unknown as ResearchResult;
  return {
    ...toResearchSummary(row),
    provenance: row.provenance as unknown as PageFetchProvenance,
    audit: result.audit ?? null,
    competitor: result.competitor ?? null,
    ownProvenance: result.ownProvenance ?? null,
  };
}

const REPORT_SUMMARY_SELECT = {
  id: true,
  userId: true,
  campaignId: true,
  projectId: true,
  kind: true,
  title: true,
  periodStart: true,
  periodEnd: true,
  sourcesIncluded: true,
  sourcesTotal: true,
  generatedAt: true,
} as const;

const RESEARCH_SUMMARY_SELECT = {
  id: true,
  userId: true,
  campaignId: true,
  projectId: true,
  kind: true,
  host: true,
  url: true,
  headline: true,
  fetchedAt: true,
  createdAt: true,
} as const;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** The database refused a row in a project (or a campaign) its owner does not own. */
function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CampaignWrite {
  name: string;
  objective?: string | null;
  brief?: string | null;
  status?: CampaignStatus;
  channels?: MarketingChannel[];
  startDate?: string | null;
  endDate?: string | null;
  metaCampaignIds?: string[];
}

export interface ContentWrite {
  title: string;
  channel: MarketingChannel;
  format?: ContentFormat;
  body: string;
  link?: string | null;
  notes?: string | null;
  status?: Exclude<ContentStatus, "PUBLISHED">;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
}

export type ContentPatch = Partial<ContentWrite>;

export interface ContentFilter {
  campaignId?: string;
  /** Inclusive calendar window, YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** With a window: also return items that have no date. */
  includeUnscheduled?: boolean;
  statuses?: ContentStatus[];
  channel?: MarketingChannel;
  limit?: number;
}

export interface VerifiedPublication {
  provider: string;
  targetName: string;
  externalId: string;
  url: string | null;
  publishedAt: Date;
  verifiedAt: Date;
}

export interface ResearchWrite {
  kind: MarketingResearchKind;
  campaignId: string | null;
  projectId: string | null;
  host: string;
  url: string;
  headline: string;
  provenance: PageFetchProvenance;
  audit?: SeoAudit;
  competitor?: CompetitorAnalysis;
  ownProvenance?: PageFetchProvenance;
  fetchedAt: Date;
}

export interface ReportWrite {
  kind: MarketingReportKind;
  title: string;
  campaignId: string | null;
  projectId: string | null;
  periodStart: string;
  periodEnd: string;
  document: MarketingReportDocument;
  sourcesIncluded: number;
  sourcesTotal: number;
  generatedAt: Date;
}

// ---------------------------------------------------------------------------

export class PrismaMarketingRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  // -------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------

  /**
   * Create a campaign in one scope: a project of the owner, or personal.
   *
   * The project is not checked here — the database checks it, by the
   * two-column key, and refuses a project the user does not own.
   */
  async createCampaign(userId: string, projectId: string | null, input: CampaignWrite): Promise<MarketingCampaignView> {
    if ((await this.prisma.marketingCampaign.count({ where: { userId } })) >= MARKETING_LIMITS.campaignsPerUser) {
      throw new JarvisError("INVALID_REQUEST", `At most ${MARKETING_LIMITS.campaignsPerUser} campaigns are allowed`);
    }
    try {
      const row = await this.prisma.marketingCampaign.create({
        data: {
          userId,
          projectId,
          name: input.name,
          objective: input.objective ?? null,
          brief: input.brief ?? null,
          status: input.status ?? "PLANNING",
          channels: input.channels ?? [],
          startDate: input.startDate ? toDate(input.startDate) : null,
          endDate: input.endDate ? toDate(input.endDate) : null,
          metaCampaignIds: input.metaCampaignIds ?? [],
        },
      });
      return toCampaign(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new JarvisError("INVALID_REQUEST", "You already have a campaign with that name");
      }
      if (isForeignKeyViolation(error)) {
        throw new JarvisError("INVALID_REQUEST", "That project was not found");
      }
      throw error;
    }
  }

  /** The campaign, only if this user owns it and it is in scope. Otherwise null. */
  async findCampaign(userId: string, scope: MarketingScope, campaignId: string): Promise<MarketingCampaignView | null> {
    const row = await this.prisma.marketingCampaign.findFirst({ where: { ...scoped(userId, scope), id: campaignId } });
    return row ? toCampaign(row) : null;
  }

  /** The campaigns in scope whose name matches, ignoring capitals. Usually one. */
  async findCampaignsByName(userId: string, scope: MarketingScope, name: string): Promise<MarketingCampaignView[]> {
    const rows = await this.prisma.marketingCampaign.findMany({
      where: { ...scoped(userId, scope), name: { equals: name.trim(), mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    return rows.map(toCampaign);
  }

  async listCampaigns(
    userId: string,
    scope: MarketingScope,
    options: { includeArchived?: boolean } = {}
  ): Promise<MarketingCampaignView[]> {
    const rows = await this.prisma.marketingCampaign.findMany({
      where: {
        ...scoped(userId, scope),
        ...(options.includeArchived ? {} : { status: { not: "ARCHIVED" } }),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: MARKETING_LIMITS.campaignsPerUser,
    });
    return rows.map(toCampaign);
  }

  /** How many of the user's campaigns exist outside `scope` — a number, never the rows. */
  async countCampaignsOutside(userId: string, scope: MarketingScope): Promise<number> {
    if (scope.kind === "ALL") return 0;
    const [all, inScope] = await Promise.all([
      this.prisma.marketingCampaign.count({ where: { userId, status: { not: "ARCHIVED" } } }),
      this.prisma.marketingCampaign.count({ where: { ...scoped(userId, scope), status: { not: "ARCHIVED" } } }),
    ]);
    return Math.max(0, all - inScope);
  }

  async updateCampaign(
    userId: string,
    scope: MarketingScope,
    campaignId: string,
    patch: Partial<CampaignWrite>
  ): Promise<MarketingCampaignView | null> {
    const data: Prisma.MarketingCampaignUpdateManyMutationInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.objective !== undefined) data.objective = patch.objective;
    if (patch.brief !== undefined) data.brief = patch.brief;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.channels !== undefined) data.channels = patch.channels;
    if (patch.startDate !== undefined) data.startDate = patch.startDate ? toDate(patch.startDate) : null;
    if (patch.endDate !== undefined) data.endDate = patch.endDate ? toDate(patch.endDate) : null;
    if (patch.metaCampaignIds !== undefined) data.metaCampaignIds = patch.metaCampaignIds;

    try {
      // `updateMany` so the owner and the scope are in the WHERE of the write
      // itself, not in a read before it.
      const changed = await this.prisma.marketingCampaign.updateMany({
        where: { ...scoped(userId, scope), id: campaignId },
        data: { ...data, updatedAt: this.now() },
      });
      if (changed.count === 0) return null;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new JarvisError("INVALID_REQUEST", "You already have a campaign with that name");
      }
      throw error;
    }
    return this.findCampaign(userId, scope, campaignId);
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  /**
   * Save a batch of content items, all or none.
   *
   * `campaign` is the campaign they belong to — already resolved for this
   * user and scope by the caller — or null for items with no campaign, which
   * then take `projectId` as their scope.
   */
  async createContent(
    userId: string,
    target: { campaignId: string | null; projectId: string | null },
    items: ContentWrite[],
    createdBy: "user" | "jarvis"
  ): Promise<ContentItemView[]> {
    const existing = await this.prisma.contentItem.count({ where: { userId } });
    if (existing + items.length > MARKETING_LIMITS.contentPerUser) {
      throw new JarvisError("INVALID_REQUEST", `At most ${MARKETING_LIMITS.contentPerUser} content items are allowed`);
    }
    try {
      const rows = await this.prisma.$transaction(
        items.map((item) =>
          this.prisma.contentItem.create({
            data: {
              userId,
              campaignId: target.campaignId,
              projectId: target.projectId,
              title: item.title,
              channel: item.channel,
              format: item.format ?? "POST",
              body: item.body,
              link: item.link ?? null,
              notes: item.notes ?? null,
              status: item.status ?? "DRAFT",
              scheduledDate: item.scheduledDate ? toDate(item.scheduledDate) : null,
              scheduledTime: item.scheduledDate ? (item.scheduledTime ?? null) : null,
              createdBy,
            },
          })
        )
      );
      const now = this.now();
      return rows.map((row) => toContent(row, now));
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new JarvisError("INVALID_REQUEST", "That campaign or project was not found");
      }
      throw error;
    }
  }

  async findContent(userId: string, scope: MarketingScope, contentId: string): Promise<ContentItemView | null> {
    const row = await this.prisma.contentItem.findFirst({ where: { ...scoped(userId, scope), id: contentId } });
    return row ? toContent(row, this.now()) : null;
  }

  /**
   * Content in scope, soonest date first, undated last.
   *
   * Returns the total that matched as well as the page, read in one
   * transaction so the two describe the same rows.
   */
  async listContent(
    userId: string,
    scope: MarketingScope,
    filter: ContentFilter = {}
  ): Promise<{ items: ContentItemView[]; total: number }> {
    const limit = Math.min(Math.max(filter.limit ?? MARKETING_LIMITS.listMax, 1), 500);

    const dateWindow: Prisma.ContentItemWhereInput | undefined =
      filter.from !== undefined || filter.to !== undefined
        ? {
            scheduledDate: {
              ...(filter.from !== undefined ? { gte: toDate(filter.from) } : {}),
              ...(filter.to !== undefined ? { lte: toDate(filter.to) } : {}),
            },
          }
        : undefined;

    const where: Prisma.ContentItemWhereInput = {
      ...scoped(userId, scope),
      ...(filter.campaignId !== undefined ? { campaignId: filter.campaignId } : {}),
      ...(filter.statuses && filter.statuses.length > 0 ? { status: { in: filter.statuses } } : {}),
      ...(filter.channel !== undefined ? { channel: filter.channel } : {}),
      ...(dateWindow
        ? filter.includeUnscheduled
          ? { OR: [dateWindow, { scheduledDate: null }] }
          : dateWindow
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.contentItem.findMany({
          where,
          orderBy: [{ scheduledDate: { sort: "asc", nulls: "last" } }, { scheduledTime: { sort: "asc", nulls: "last" } }, { id: "asc" }],
          take: limit,
        }),
        this.prisma.contentItem.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
    const now = this.now();
    return { items: rows.map((row) => toContent(row, now)), total };
  }

  /** How many items a campaign holds, by status. Every status is present, zero included. */
  async countContentByStatus(userId: string, scope: MarketingScope, campaignId: string): Promise<Record<ContentStatus, number>> {
    const groups = await this.prisma.contentItem.groupBy({
      by: ["status"],
      where: { ...scoped(userId, scope), campaignId },
      _count: { _all: true },
    });
    const counts = emptyStatusCounts();
    for (const group of groups) {
      if ((CONTENT_STATUSES as readonly string[]).includes(group.status)) {
        counts[group.status as ContentStatus] = group._count._all;
      }
    }
    return counts;
  }

  /**
   * Change an item that is not published.
   *
   * The WHERE refuses a published item and an item with a publish running, so
   * the copy cannot be changed underneath an execution that has already
   * checked it. Returns null when nothing matched.
   */
  async updateContent(
    userId: string,
    scope: MarketingScope,
    contentId: string,
    patch: ContentPatch
  ): Promise<ContentItemView | null> {
    const data: Prisma.ContentItemUpdateManyMutationInput = {};
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.channel !== undefined) data.channel = patch.channel;
    if (patch.format !== undefined) data.format = patch.format;
    if (patch.body !== undefined) data.body = patch.body;
    if (patch.link !== undefined) data.link = patch.link;
    if (patch.notes !== undefined) data.notes = patch.notes;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.scheduledDate !== undefined) data.scheduledDate = patch.scheduledDate ? toDate(patch.scheduledDate) : null;
    if (patch.scheduledTime !== undefined) data.scheduledTime = patch.scheduledTime;

    const staleBefore = new Date(this.now().getTime() - CONTENT_PUBLISH_CLAIM_TTL_MS);
    const changed = await this.prisma.contentItem.updateMany({
      where: {
        ...scoped(userId, scope),
        id: contentId,
        status: { not: "PUBLISHED" },
        publicationMode: null,
        OR: [{ publishState: { not: "PUBLISHING" } }, { publishClaimedAt: { lt: staleBefore } }],
      },
      data: { ...data, updatedAt: this.now() },
    });
    if (changed.count === 0) return null;
    return this.findContent(userId, scope, contentId);
  }

  /**
   * Record that the USER published an item themselves.
   *
   * One conditional statement: it applies only to an item that is not already
   * published and has no publish running. The mode is REPORTED_BY_USER and
   * can be nothing else from here.
   */
  async markPublishedByUser(
    userId: string,
    scope: MarketingScope,
    contentId: string,
    input: { publishedAt: Date; url: string | null }
  ): Promise<ContentItemView | null> {
    const staleBefore = new Date(this.now().getTime() - CONTENT_PUBLISH_CLAIM_TTL_MS);
    const changed = await this.prisma.contentItem.updateMany({
      where: {
        ...scoped(userId, scope),
        id: contentId,
        status: { notIn: ["PUBLISHED", "ARCHIVED"] },
        publicationMode: null,
        OR: [{ publishState: { not: "PUBLISHING" } }, { publishClaimedAt: { lt: staleBefore } }],
      },
      data: {
        status: "PUBLISHED",
        publicationMode: "REPORTED_BY_USER",
        publishedAt: input.publishedAt,
        externalUrl: input.url,
        publishedVia: null,
        publishedTarget: null,
        externalId: null,
        verifiedAt: null,
        publishState: "NONE",
        publishClaimedAt: null,
        publishAttempt: Prisma.DbNull,
        updatedAt: this.now(),
      },
    });
    if (changed.count === 0) return null;
    return this.findContent(userId, scope, contentId);
  }

  // -------------------------------------------------------------------------
  // Publishing — the three conditional writes
  // -------------------------------------------------------------------------

  /**
   * Take the item for one publish.
   *
   * Succeeds for exactly one caller, and only while the item is READY, not
   * published, on the expected channel, and its copy and link are still
   * exactly the approved ones. A claim older than the TTL was abandoned and
   * may be taken over — by an execution that must first find out what the
   * abandoned one did.
   */
  async claimForPublish(
    userId: string,
    contentId: string,
    expected: { channel: MarketingChannel; body: string; link: string | null }
  ): Promise<boolean> {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - CONTENT_PUBLISH_CLAIM_TTL_MS);
    const changed = await this.prisma.contentItem.updateMany({
      where: {
        userId,
        id: contentId,
        status: "READY",
        publicationMode: null,
        channel: expected.channel,
        body: expected.body,
        link: expected.link,
        OR: [
          { publishState: { in: ["NONE", "UNCONFIRMED"] } },
          { publishState: "PUBLISHING", publishClaimedAt: { lt: staleBefore } },
        ],
      },
      data: { publishState: "PUBLISHING", publishClaimedAt: now },
    });
    return changed.count === 1;
  }

  /**
   * PUBLISHING -> PUBLISHED, with the evidence, in one statement.
   *
   * VERIFIED and nothing else: this is the only method that writes that mode,
   * and it cannot be called without the provider's post id and the time the
   * post was read back (the database checks both as well).
   */
  async finalizePublished(userId: string, contentId: string, publication: VerifiedPublication): Promise<ContentItemView | null> {
    const changed = await this.prisma.contentItem.updateMany({
      where: { userId, id: contentId, publishState: "PUBLISHING", publicationMode: null },
      data: {
        status: "PUBLISHED",
        publicationMode: "VERIFIED",
        publishedAt: publication.publishedAt,
        publishedVia: publication.provider,
        publishedTarget: publication.targetName,
        externalId: publication.externalId,
        externalUrl: publication.url,
        verifiedAt: publication.verifiedAt,
        publishState: "NONE",
        publishClaimedAt: null,
        publishAttempt: Prisma.DbNull,
        updatedAt: this.now(),
      },
    });
    if (changed.count === 0) return null;
    return this.findContent(userId, { kind: "ALL" }, contentId);
  }

  /**
   * Give the claim back without publishing.
   *
   * `to` NONE: nothing was sent, or the provider refused. UNCONFIRMED: a
   * request went out and its outcome is not known. Either way the attempt is
   * recorded, and the item is NOT published.
   */
  async releasePublish(
    userId: string,
    contentId: string,
    to: "NONE" | "UNCONFIRMED",
    attempt: ContentPublishAttempt
  ): Promise<ContentItemView | null> {
    const changed = await this.prisma.contentItem.updateMany({
      where: { userId, id: contentId, publishState: "PUBLISHING" },
      data: {
        publishState: to,
        publishClaimedAt: null,
        publishAttempt: attempt as unknown as Prisma.InputJsonValue,
        updatedAt: this.now(),
      },
    });
    if (changed.count === 0) return null;
    return this.findContent(userId, { kind: "ALL" }, contentId);
  }

  /** The raw publish state of one item, for the execution that is deciding what to do. */
  async publishStateOf(
    userId: string,
    contentId: string
  ): Promise<{ state: ContentPublishState; claimedAt: Date | null } | null> {
    const row = await this.prisma.contentItem.findFirst({
      where: { userId, id: contentId },
      select: { publishState: true, publishClaimedAt: true },
    });
    return row ? { state: row.publishState as ContentPublishState, claimedAt: row.publishClaimedAt } : null;
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  async createReport(userId: string, input: ReportWrite): Promise<MarketingReportView> {
    if ((await this.prisma.marketingReport.count({ where: { userId } })) >= MARKETING_LIMITS.reportsPerUser) {
      throw new JarvisError("INVALID_REQUEST", `At most ${MARKETING_LIMITS.reportsPerUser} reports are kept. Older ones are not removed automatically.`);
    }
    try {
      const row = await this.prisma.marketingReport.create({
        data: {
          userId,
          campaignId: input.campaignId,
          projectId: input.projectId,
          kind: input.kind,
          title: input.title,
          periodStart: toDate(input.periodStart),
          periodEnd: toDate(input.periodEnd),
          document: input.document as unknown as Prisma.InputJsonValue,
          sourcesIncluded: input.sourcesIncluded,
          sourcesTotal: input.sourcesTotal,
          generatedAt: input.generatedAt,
        },
      });
      return toReport(row);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new JarvisError("INVALID_REQUEST", "That campaign or project was not found");
      }
      throw error;
    }
  }

  async findReport(userId: string, scope: MarketingScope, reportId: string): Promise<MarketingReportView | null> {
    const row = await this.prisma.marketingReport.findFirst({ where: { ...scoped(userId, scope), id: reportId } });
    return row ? toReport(row) : null;
  }

  async listReports(
    userId: string,
    scope: MarketingScope,
    filter: { campaignId?: string; limit?: number } = {}
  ): Promise<MarketingReportSummary[]> {
    const rows = await this.prisma.marketingReport.findMany({
      where: { ...scoped(userId, scope), ...(filter.campaignId !== undefined ? { campaignId: filter.campaignId } : {}) },
      orderBy: [{ generatedAt: "desc" }, { id: "asc" }],
      take: Math.min(Math.max(filter.limit ?? 20, 1), MARKETING_LIMITS.listMax),
      select: REPORT_SUMMARY_SELECT,
    });
    return rows.map(toReportSummary);
  }

  /** The newest report in scope, for a campaign when one is given. */
  async latestReport(userId: string, scope: MarketingScope, campaignId?: string): Promise<MarketingReportView | null> {
    const row = await this.prisma.marketingReport.findFirst({
      where: { ...scoped(userId, scope), ...(campaignId !== undefined ? { campaignId } : {}) },
      orderBy: [{ generatedAt: "desc" }, { id: "asc" }],
    });
    return row ? toReport(row) : null;
  }

  // -------------------------------------------------------------------------
  // Research
  // -------------------------------------------------------------------------

  async createResearch(userId: string, input: ResearchWrite): Promise<MarketingResearchView> {
    if ((await this.prisma.marketingResearch.count({ where: { userId } })) >= MARKETING_LIMITS.researchPerUser) {
      throw new JarvisError("INVALID_REQUEST", `At most ${MARKETING_LIMITS.researchPerUser} research results are kept.`);
    }
    const result: ResearchResult = {
      ...(input.audit ? { audit: input.audit } : {}),
      ...(input.competitor ? { competitor: input.competitor } : {}),
      ...(input.ownProvenance ? { ownProvenance: input.ownProvenance } : {}),
    };
    try {
      const row = await this.prisma.marketingResearch.create({
        data: {
          userId,
          campaignId: input.campaignId,
          projectId: input.projectId,
          kind: input.kind,
          host: input.host,
          url: input.url,
          headline: input.headline,
          provenance: input.provenance as unknown as Prisma.InputJsonValue,
          result: result as unknown as Prisma.InputJsonValue,
          fetchedAt: input.fetchedAt,
        },
      });
      return toResearch(row);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new JarvisError("INVALID_REQUEST", "That campaign or project was not found");
      }
      throw error;
    }
  }

  async findResearch(userId: string, scope: MarketingScope, researchId: string): Promise<MarketingResearchView | null> {
    const row = await this.prisma.marketingResearch.findFirst({ where: { ...scoped(userId, scope), id: researchId } });
    return row ? toResearch(row) : null;
  }

  async listResearch(
    userId: string,
    scope: MarketingScope,
    filter: { campaignId?: string; kind?: MarketingResearchKind; limit?: number } = {}
  ): Promise<MarketingResearchSummary[]> {
    const rows = await this.prisma.marketingResearch.findMany({
      where: {
        ...scoped(userId, scope),
        ...(filter.campaignId !== undefined ? { campaignId: filter.campaignId } : {}),
        ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
      },
      orderBy: [{ fetchedAt: "desc" }, { id: "asc" }],
      take: Math.min(Math.max(filter.limit ?? 20, 1), MARKETING_LIMITS.listMax),
      select: RESEARCH_SUMMARY_SELECT,
    });
    return rows.map(toResearchSummary);
  }

  /** The last saved read of one address, in scope — what a new read is compared against. */
  async latestResearchForUrl(
    userId: string,
    scope: MarketingScope,
    kind: MarketingResearchKind,
    url: string
  ): Promise<MarketingResearchView | null> {
    const row = await this.prisma.marketingResearch.findFirst({
      where: { ...scoped(userId, scope), kind, url },
      orderBy: [{ fetchedAt: "desc" }, { id: "asc" }],
    });
    return row ? toResearch(row) : null;
  }

  /** Recent SEO audits in scope, newest first, with their findings. */
  async recentAudits(userId: string, scope: MarketingScope, campaignId?: string, limit = 10): Promise<MarketingResearchView[]> {
    const rows = await this.prisma.marketingResearch.findMany({
      where: { ...scoped(userId, scope), kind: "SEO_AUDIT", ...(campaignId !== undefined ? { campaignId } : {}) },
      orderBy: [{ fetchedAt: "desc" }, { id: "asc" }],
      take: Math.min(Math.max(limit, 1), 50),
    });
    return rows.map(toResearch);
  }
}
