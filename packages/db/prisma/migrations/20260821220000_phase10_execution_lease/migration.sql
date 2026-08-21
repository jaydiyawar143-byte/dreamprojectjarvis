-- Phase 10.2 — Durable execution ownership (lease)
-- Additive migration: three nullable columns + one index. No data is modified.
-- The lease makes crash detection deterministic: a live worker renews
-- (owner_id, lease_until, heartbeat_at) via heartbeat(); an expired lease
-- makes the record eligible for STALE RECOVERY (EXECUTING -> UNKNOWN),
-- never for takeover or automatic re-execution.

ALTER TABLE "ToolExecution" ADD COLUMN "owner_id" TEXT;
ALTER TABLE "ToolExecution" ADD COLUMN "lease_until" TIMESTAMP(3);
ALTER TABLE "ToolExecution" ADD COLUMN "heartbeat_at" TIMESTAMP(3);

-- Stale-scan index: WHERE status = 'EXECUTING' AND lease_until < now()
CREATE INDEX "tool_executions_stale_idx" ON "ToolExecution"("status", "lease_until");
