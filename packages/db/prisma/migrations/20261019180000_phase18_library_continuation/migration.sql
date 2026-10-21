-- Phase 18, Stage 18.2 — continue-until-complete for the Automation Library.
--
-- ADDITIVE: one enum, one new table, three new nullable columns, their indexes
-- and foreign keys. No existing column is changed and no row is read or
-- written. A previous release never reads the new columns or the new table, so
-- it runs against this schema; rolling back never undoes this migration.
-- Generated with `prisma migrate diff` from the schema before and after.
--
-- WHAT THEY HOLD (docs/phases/phase-18.md, Stage 18.2).
--   AutomationLibrarySyncChain   one continue-until-complete request: its
--                                limits, its progress counters, and a stable
--                                stop or failure code. No provider text, no
--                                cursor, no address.
--   AutomationLibrarySync.active_chain_id / chain_heartbeat_at
--                                the chain that holds the catalog and its last
--                                sign of life — what keeps a second chain, or a
--                                stray single run, off the catalog, and what
--                                lets a chain whose process died be recognised
--                                and closed as interrupted.
--   AutomationLibrarySyncRun.chain_id
--                                the chain a run belonged to; null for a
--                                single run.
--
-- Chains cascade with their catalog; a chain's requester is set null when the
-- account is deleted (and a chain without its requester stops at its next
-- authorization check).

-- CreateEnum
CREATE TYPE "AutomationLibraryChainStatus" AS ENUM ('RUNNING', 'COMPLETE', 'STOPPED', 'INTERRUPTED');

-- AlterTable
ALTER TABLE "AutomationLibrarySync" ADD COLUMN     "active_chain_id" TEXT,
ADD COLUMN     "chain_heartbeat_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AutomationLibrarySyncRun" ADD COLUMN     "chain_id" TEXT;

-- CreateTable
CREATE TABLE "AutomationLibrarySyncChain" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "requested_by_id" TEXT,
    "idempotency_key" TEXT,
    "status" "AutomationLibraryChainStatus" NOT NULL,
    "stop_code" TEXT,
    "failure_code" TEXT,
    "runs_started" INTEGER NOT NULL DEFAULT 0,
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "records_observed" INTEGER NOT NULL DEFAULT 0,
    "max_runs" INTEGER NOT NULL,
    "max_pages" INTEGER NOT NULL,
    "deadline_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "AutomationLibrarySyncChain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationLibrarySyncChain_sync_id_started_at_idx" ON "AutomationLibrarySyncChain"("sync_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationLibrarySyncChain_sync_id_requested_by_id_idempote_key" ON "AutomationLibrarySyncChain"("sync_id", "requested_by_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "AutomationLibrarySyncRun_chain_id_idx" ON "AutomationLibrarySyncRun"("chain_id");

-- AddForeignKey
ALTER TABLE "AutomationLibrarySyncChain" ADD CONSTRAINT "AutomationLibrarySyncChain_sync_id_fkey" FOREIGN KEY ("sync_id") REFERENCES "AutomationLibrarySync"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationLibrarySyncChain" ADD CONSTRAINT "AutomationLibrarySyncChain_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationLibrarySyncRun" ADD CONSTRAINT "AutomationLibrarySyncRun_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "AutomationLibrarySyncChain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

