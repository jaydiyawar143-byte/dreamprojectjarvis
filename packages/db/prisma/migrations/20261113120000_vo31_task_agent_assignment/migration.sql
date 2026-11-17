-- VO-3.1 — the agent a task is assigned to.
--
-- ADDITIVE: three nullable columns on "Task" and one index. No row is
-- written, no column is altered or dropped, so a release from before this
-- stage starts against this database unchanged (it never reads the columns).
--
--   agent_id     the agent the work is assigned to, decided from the tool the
--                run uses (assignAgentForTool, packages/agents). Attribution,
--                not authority: the executor still runs with the caller's role.
--   assigned_at  when agent_id was first set.
--   tool_id      the tool the run executes, written with PENDING -> RUNNING.
--
-- The index serves the office's per-agent read, which is always scoped to one
-- user first.
--
-- Generated with `prisma migrate diff` from the schema before and after.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "agent_id" TEXT,
ADD COLUMN     "assigned_at" TIMESTAMP(3),
ADD COLUMN     "tool_id" TEXT;

-- CreateIndex
CREATE INDEX "Task_user_id_agent_id_status_idx" ON "Task"("user_id", "agent_id", "status");
