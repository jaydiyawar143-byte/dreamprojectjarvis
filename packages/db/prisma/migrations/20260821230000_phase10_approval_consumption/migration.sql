-- PHASE 10.3 — Atomic approval consumption + one-time execution (additive only)

-- CONSUMED is terminal: an approval can never leave this state.
ALTER TYPE "ApprovalStatus" ADD VALUE 'CONSUMED';

-- Durable approval <-> execution audit linkage. Stamped at begin() and
-- re-stamped by atomic consumption.
ALTER TABLE "ToolExecution" ADD COLUMN "approval_id" TEXT;
