-- Phase 18, Stage 18.3B — the trigger allow-list remembers which Automation
-- Library entry a row was added from.
--
-- ADDITIVE: two nullable columns on "N8nWorkflow" and one index. No column is
-- changed and no row is read or written; every existing row keeps NULL in
-- both, and a release from before this stage never reads them.
--
--   library_entry_ref   "<instance key>:<n8n workflow id>" — the catalog entry an
--                       approved proposal added this row from. The instance
--                       key is a hash of the base URL; no URL is stored.
--   library_version_id  the n8n versionId that proposal was bound to.
--
-- Generated with `prisma migrate diff` from the schema before and after.

-- AlterTable
ALTER TABLE "N8nWorkflow" ADD COLUMN     "library_entry_ref" TEXT,
ADD COLUMN     "library_version_id" TEXT;

-- CreateIndex
CREATE INDEX "N8nWorkflow_user_id_library_entry_ref_idx" ON "N8nWorkflow"("user_id", "library_entry_ref");
