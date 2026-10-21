-- Phase 18, Stage 18.4 — workflow drafts: plans held in JARVIS, never sent to
-- n8n.
--
-- ADDITIVE: two new tables, their indexes and foreign keys, and one trigger
-- on the new version table. No existing table is altered and no row is
-- written; a release from before this stage never reads them.
--
--   AutomationDraft         one draft, owned by the Organization that owns
--                           the n8n connection, for one instance (the same
--                           tenant / provider / instance key as the library
--                           catalog). latest_version is advanced by ONE
--                           conditional UPDATE per revision.
--   AutomationDraftVersion  one immutable version: its content (structure and
--                           plain answers only — no n8n parameter,
--                           credential, expression or URL), the SHA-256 of
--                           that content, and its status when saved.
--
-- IMMUTABLE VERSIONS. The trigger at the end refuses any UPDATE that changes a
-- stored version. The one change it lets through is the foreign key's own ON
-- DELETE SET NULL: deleting an author's account clears created_by_id.
--
-- Generated with `prisma migrate diff` from the schema before and after; the
-- trigger follows the OutcomeRecord immutability guard
-- (20260824000000_phase117a_outcome_foundation).

-- CreateTable
CREATE TABLE "AutomationDraft" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "instance_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source_entry_id" TEXT,
    "source_version_id" TEXT,
    "latest_version" INTEGER NOT NULL DEFAULT 1,
    "create_key" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationDraftVersion" (
    "id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationDraftVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationDraft_tenant_id_provider_id_instance_key_updated__idx" ON "AutomationDraft"("tenant_id", "provider_id", "instance_key", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationDraft_tenant_id_provider_id_instance_key_create_k_key" ON "AutomationDraft"("tenant_id", "provider_id", "instance_key", "create_key");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationDraftVersion_draft_id_version_key" ON "AutomationDraftVersion"("draft_id", "version");

-- AddForeignKey
ALTER TABLE "AutomationDraft" ADD CONSTRAINT "AutomationDraft_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationDraft" ADD CONSTRAINT "AutomationDraft_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationDraftVersion" ADD CONSTRAINT "AutomationDraftVersion_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "AutomationDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationDraftVersion" ADD CONSTRAINT "AutomationDraftVersion_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Immutable versions
CREATE OR REPLACE FUNCTION automation_draft_version_immutability_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.created_by_id IS NOT NULL AND NEW.created_by_id IS DISTINCT FROM OLD.created_by_id)
  THEN
    RAISE EXCEPTION
      'AutomationDraftVersion % is immutable. A revision is a new version.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automation_draft_version_immutability ON "AutomationDraftVersion";
CREATE TRIGGER automation_draft_version_immutability
  BEFORE UPDATE ON "AutomationDraftVersion"
  FOR EACH ROW
  EXECUTE FUNCTION automation_draft_version_immutability_guard();
