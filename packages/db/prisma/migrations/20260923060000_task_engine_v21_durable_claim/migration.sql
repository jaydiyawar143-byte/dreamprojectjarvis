-- Task Engine V2.1 — durable scheduler claim.
--
-- TWO nullable columns. Additive: every existing row gets NULL, and NULL is
-- the correct value for all of them.
--
--   claimed_at    NULL = "not claimed". True of every historical row, including
--                 the stale PENDING ones, so none of them changes behaviour.
--   execution_id  NULL = "has not executed, or executed before V2.1". Never
--                 backfilled: the id of a past execution is not recoverable
--                 from the task row, and guessing one would be a lie.
--
-- WHY. Before V2.1 the scheduler claimed a task by clearing `scheduled_at`.
-- A crash between that claim and the start of execution left the task PENDING
-- with no schedule — indistinguishable from work that was never scheduled, and
-- silently never run again. The claim now sets `claimed_at` and LEAVES
-- `scheduled_at` intact, so the claim is durable and the intended run time
-- survives.
--
-- The exactly-once guarantee is UNCHANGED. The compare-and-set simply moves
-- column: `claimed_at IS NULL` in the WHERE is the compare, `SET claimed_at`
-- is the set, and it remains a single conditional UPDATE with exactly one
-- winner across any number of replicas.
--
-- NO recovery sweep is introduced here. Nothing re-arms a stale claim yet;
-- that is V2.3. This migration only makes the claim observable and durable.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "claimed_at" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "execution_id" TEXT;
