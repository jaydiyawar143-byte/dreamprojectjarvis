-- PHASE 10.5 — Meta reconciliation + ambiguous write recovery.
-- Strictly additive and reversible: one new enum value, three nullable /
-- defaulted columns. No existing data is mutated; historical UNKNOWN records
-- are NOT reconciled or reclassified by this migration (explicit backfill
-- plan required for that, per phase spec §14).

-- New journal state: authoritative NOT_FOUND after reconciliation.
-- (RECONCILING already exists since phase10_execution_journal; IF NOT EXISTS
-- keeps this migration idempotent.)
ALTER TYPE "ToolExecutionStatus" ADD VALUE IF NOT EXISTS 'SAFE_TO_RETRY';

ALTER TABLE "ToolExecution" ADD COLUMN IF NOT EXISTS "reconciliation_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ToolExecution" ADD COLUMN IF NOT EXISTS "last_reconciliation_at" TIMESTAMP(3);
ALTER TABLE "ToolExecution" ADD COLUMN IF NOT EXISTS "last_reconciliation_result" TEXT;
