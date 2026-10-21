-- Phase 18, Stage 18.1 — the Automation Library: a durable catalog of an n8n
-- instance's workflows, its synchronization checkpoint and its run history.
--
-- ADDITIVE: one enum and three new tables, with their indexes and foreign keys.
-- No existing table or column is altered, and no row is read or written. A
-- previous release never reads these tables, so it runs against this schema;
-- rolling back never undoes this migration. Generated with
-- `prisma migrate diff` from the schema before and after.
--
-- WHAT THEY HOLD (docs/phases/phase-18.md).
--   AutomationLibraryEntry    one observed workflow per Organization, provider
--                             instance and external id — listing metadata only:
--                             no node parameters, credentials, settings, static
--                             or pinned data. Marked removed, never deleted.
--   AutomationLibrarySync     one per catalog: the open scan's checkpoint (the
--                             provider cursor to resume from, the hashes of the
--                             cursors already requested), the last complete scan,
--                             and the lease that keeps two runs apart.
--   AutomationLibrarySyncRun  one bounded run: its status, counters and a stable
--                             failure code. No provider error text is stored.
--
-- `instance_key` is a hash of the configured base URL; the URL is not stored.
-- Rows cascade with their Organization; a run's requester is set null when the
-- account is deleted.

-- CreateEnum
CREATE TYPE "AutomationLibraryRunStatus" AS ENUM ('RUNNING', 'PARTIAL', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "AutomationLibraryEntry" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "instance_key" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "search_text" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "remote_created_at" TIMESTAMP(3),
    "remote_updated_at" TIMESTAMP(3),
    "version_id" TEXT,
    "tags" JSONB,
    "node_types" JSONB,
    "node_count" INTEGER,
    "fingerprint" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'rest',
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_scan_id" TEXT NOT NULL,
    "content_changed_at" TIMESTAMP(3) NOT NULL,
    "missed_scans" INTEGER NOT NULL DEFAULT 0,
    "missing_since" TIMESTAMP(3),
    "removed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationLibraryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationLibrarySync" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "instance_key" TEXT NOT NULL,
    "scan_id" TEXT,
    "scan_cursor" TEXT,
    "scan_page_size" INTEGER,
    "scan_pages" INTEGER NOT NULL DEFAULT 0,
    "scan_records" INTEGER NOT NULL DEFAULT 0,
    "scan_cursor_trail" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scan_started_at" TIMESTAMP(3),
    "last_complete_scan_id" TEXT,
    "last_complete_at" TIMESTAMP(3),
    "last_complete_records" INTEGER,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationLibrarySync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationLibrarySyncRun" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "scan_id" TEXT NOT NULL,
    "requested_by_id" TEXT,
    "status" "AutomationLibraryRunStatus" NOT NULL,
    "resumed" BOOLEAN NOT NULL DEFAULT false,
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "records_observed" INTEGER NOT NULL DEFAULT 0,
    "records_created" INTEGER NOT NULL DEFAULT 0,
    "records_updated" INTEGER NOT NULL DEFAULT 0,
    "records_unchanged" INTEGER NOT NULL DEFAULT 0,
    "records_rejected" INTEGER NOT NULL DEFAULT 0,
    "marked_missing" INTEGER NOT NULL DEFAULT 0,
    "marked_removed" INTEGER NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "AutomationLibrarySyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationLibraryEntry_tenant_id_provider_id_instance_key_n_idx" ON "AutomationLibraryEntry"("tenant_id", "provider_id", "instance_key", "name");

-- CreateIndex
CREATE INDEX "AutomationLibraryEntry_tenant_id_provider_id_instance_key_l_idx" ON "AutomationLibraryEntry"("tenant_id", "provider_id", "instance_key", "last_seen_scan_id");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationLibraryEntry_tenant_id_provider_id_instance_key_e_key" ON "AutomationLibraryEntry"("tenant_id", "provider_id", "instance_key", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationLibrarySync_tenant_id_provider_id_instance_key_key" ON "AutomationLibrarySync"("tenant_id", "provider_id", "instance_key");

-- CreateIndex
CREATE INDEX "AutomationLibrarySyncRun_sync_id_started_at_idx" ON "AutomationLibrarySyncRun"("sync_id", "started_at");

-- AddForeignKey
ALTER TABLE "AutomationLibraryEntry" ADD CONSTRAINT "AutomationLibraryEntry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationLibrarySync" ADD CONSTRAINT "AutomationLibrarySync_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationLibrarySyncRun" ADD CONSTRAINT "AutomationLibrarySyncRun_sync_id_fkey" FOREIGN KEY ("sync_id") REFERENCES "AutomationLibrarySync"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationLibrarySyncRun" ADD CONSTRAINT "AutomationLibrarySyncRun_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
