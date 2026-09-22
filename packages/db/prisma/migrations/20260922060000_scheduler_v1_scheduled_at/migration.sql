-- Scheduler V1 — one-time scheduled execution for JARVIS work tasks.
--
-- ONE nullable column. Additive: nothing reads it yet, every existing row gets
-- NULL, and NULL means "not scheduled", which is the correct state for every
-- task that exists today.
--
-- Not `due_at`: that column belongs to the todo surface (user-writable through
-- the dashboard PATCH, and the key `dueForReminder()` filters on). Reusing it
-- would let a due-date edit silently reschedule a real execution.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "scheduled_at" TIMESTAMP(3);

-- CreateIndex
-- The sweep's only query: WHERE scheduled_at <= now AND status = 'PENDING'.
CREATE INDEX "Task_scheduled_at_status_idx" ON "Task"("scheduled_at", "status");
