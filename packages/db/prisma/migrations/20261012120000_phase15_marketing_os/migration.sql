-- Phase 15 — the Marketing Operating System.
--
-- ADDITIVE ONLY. Four new tables with their indexes, foreign keys and three
-- constraints. Nothing existing is altered, renamed or dropped, and no
-- existing row is read or written, so a release from before Phase 15 starts
-- against this database unchanged: it never touches any of these tables.
--
-- WHAT THEY HOLD. JARVIS's own records of marketing work — a campaign
-- workspace, the content planned in it, and the reports and page research
-- saved for it. A row here is a plan or a record. None of them causes
-- anything outside JARVIS to change.
--
-- WHAT THE DATABASE ITSELF REFUSES, whatever the application does:
--
--   * A row in a project its owner does not own. Every table references
--     "Project" by ("project_id", "user_id") -> ("id", "userId"), the same
--     two-column key Phase 14 gave "Memory". (MATCH SIMPLE: a personal row,
--     with "project_id" NULL, is not checked.)
--   * A content item, report or research row attached to another user's
--     campaign: the same two-column key, onto "MarketingCampaign".
--   * Two campaigns of one user with the same name in the same scope.
--   * A content item that says PUBLISHED with no record of how that is known,
--     or that carries such a record while saying anything else.
--   * A publication that says VERIFIED without the provider's own id for the
--     post and the time it was read back.
--
-- ROLLING BACK THE APPLICATION DOES NOT NEED THIS UNDONE. A previous release
-- never reads or writes these tables, so they can be left in place; no
-- rollback step drops them. See docs/DEPLOYMENT.md.

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "brief" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNING',
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "start_date" DATE,
    "end_date" DATE,
    "meta_campaign_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentItem" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "project_id" TEXT,
    "title" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'POST',
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduled_date" DATE,
    "scheduled_time" TEXT,
    "publish_state" TEXT NOT NULL DEFAULT 'NONE',
    "publish_claimed_at" TIMESTAMP(3),
    "publish_attempt" JSONB,
    "publication_mode" TEXT,
    "published_at" TIMESTAMP(3),
    "published_via" TEXT,
    "published_target" TEXT,
    "external_id" TEXT,
    "external_url" TEXT,
    "verified_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL DEFAULT 'user',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingReport" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "project_id" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "document" JSONB NOT NULL,
    "sources_included" INTEGER NOT NULL DEFAULT 0,
    "sources_total" INTEGER NOT NULL DEFAULT 0,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingResearch" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "project_id" TEXT,
    "kind" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "provenance" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingResearch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingCampaign_user_id_project_id_idx" ON "MarketingCampaign"("user_id", "project_id");

-- Exists so the three tables below can reference a campaign by (id, owner).
-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaign_id_user_id_key" ON "MarketingCampaign"("id", "user_id");

-- One name per owner per scope, whatever its capitals. NULL "project_id" is
-- the personal scope and must count as ONE scope, which a plain unique index
-- would not give (NULLs never equal each other) — hence the COALESCE.
-- Prisma has no syntax for an expression index, so this one lives here only.
CREATE UNIQUE INDEX "MarketingCampaign_owner_scope_name_key"
    ON "MarketingCampaign"("user_id", (COALESCE("project_id", '')), (lower("name")));

-- CreateIndex
CREATE INDEX "ContentItem_user_id_scheduled_date_idx" ON "ContentItem"("user_id", "scheduled_date");

-- CreateIndex
CREATE INDEX "ContentItem_user_id_campaign_id_idx" ON "ContentItem"("user_id", "campaign_id");

-- CreateIndex
CREATE INDEX "ContentItem_user_id_project_id_idx" ON "ContentItem"("user_id", "project_id");

-- CreateIndex
CREATE INDEX "ContentItem_user_id_status_idx" ON "ContentItem"("user_id", "status");

-- CreateIndex
CREATE INDEX "MarketingReport_user_id_generated_at_idx" ON "MarketingReport"("user_id", "generated_at");

-- CreateIndex
CREATE INDEX "MarketingReport_user_id_campaign_id_idx" ON "MarketingReport"("user_id", "campaign_id");

-- CreateIndex
CREATE INDEX "MarketingReport_user_id_project_id_idx" ON "MarketingReport"("user_id", "project_id");

-- CreateIndex
CREATE INDEX "MarketingResearch_user_id_kind_url_fetched_at_idx" ON "MarketingResearch"("user_id", "kind", "url", "fetched_at");

-- CreateIndex
CREATE INDEX "MarketingResearch_user_id_project_id_idx" ON "MarketingResearch"("user_id", "project_id");

-- CreateIndex
CREATE INDEX "MarketingResearch_user_id_campaign_id_idx" ON "MarketingResearch"("user_id", "campaign_id");

-- PUBLISHED and a publication record go together, both ways. A status change
-- alone can therefore never make an item look published, and a publication
-- can never sit on an item that says it is still a draft.
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_published_has_record_check"
    CHECK (("status" = 'PUBLISHED') = ("publication_mode" IS NOT NULL));

-- VERIFIED means the provider was asked and answered: its id for the post,
-- which provider it was, and when the post was read back, are all required.
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_verified_has_evidence_check"
    CHECK (
        "publication_mode" IS NULL
        OR ("publication_mode" = 'REPORTED_BY_USER' AND "published_at" IS NOT NULL)
        OR (
            "publication_mode" = 'VERIFIED'
            AND "published_at" IS NOT NULL
            AND "external_id" IS NOT NULL
            AND "published_via" IS NOT NULL
            AND "verified_at" IS NOT NULL
        )
    );

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_project_id_user_id_fkey" FOREIGN KEY ("project_id", "user_id") REFERENCES "Project"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_campaign_id_user_id_fkey" FOREIGN KEY ("campaign_id", "user_id") REFERENCES "MarketingCampaign"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_project_id_user_id_fkey" FOREIGN KEY ("project_id", "user_id") REFERENCES "Project"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingReport" ADD CONSTRAINT "MarketingReport_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingReport" ADD CONSTRAINT "MarketingReport_campaign_id_user_id_fkey" FOREIGN KEY ("campaign_id", "user_id") REFERENCES "MarketingCampaign"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingReport" ADD CONSTRAINT "MarketingReport_project_id_user_id_fkey" FOREIGN KEY ("project_id", "user_id") REFERENCES "Project"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingResearch" ADD CONSTRAINT "MarketingResearch_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingResearch" ADD CONSTRAINT "MarketingResearch_campaign_id_user_id_fkey" FOREIGN KEY ("campaign_id", "user_id") REFERENCES "MarketingCampaign"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingResearch" ADD CONSTRAINT "MarketingResearch_project_id_user_id_fkey" FOREIGN KEY ("project_id", "user_id") REFERENCES "Project"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
