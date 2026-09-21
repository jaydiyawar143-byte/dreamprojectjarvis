-- Core V1 — task lifecycle columns.
--
-- Additive only. Existing rows keep every value they had; the backfill below
-- is what stops `status` and `completed_at` disagreeing on day one.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Task" ADD COLUMN "started_at" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "error" TEXT;

-- Backfill: a todo that was already finished is COMPLETED, not PENDING.
-- Without this every historical completed task would read as outstanding to
-- any code that trusts `status`.
UPDATE "Task" SET "status" = 'COMPLETED' WHERE "completed_at" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Task_user_id_status_idx" ON "Task"("user_id", "status");
