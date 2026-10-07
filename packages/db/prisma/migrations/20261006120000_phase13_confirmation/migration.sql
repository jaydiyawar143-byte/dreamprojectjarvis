-- Phase 13 — durable confirmation state for external writes.
--
-- ONE new table. Additive: nothing existing is altered, renamed or dropped,
-- and no existing row is read or written.
--
-- WHAT IT HOLDS. A pending confirmation of one external write, issued by the
-- integration command service and spent when the write is handed to
-- ToolExecutor. Until now that state was a Map in one API process, so a
-- restart between the question and the answer lost the answer, and a second
-- instance could not honour a confirmation the first one issued.
--
--   token_hash    SHA-256 of the token. The token itself is NEVER stored, so a
--                 copy of this table cannot confirm anything.
--   params_hash   canonical hash of the parameters. No parameter value and no
--                 summary is stored.
--   consumed_at   NULL = pending. Spending is a single conditional UPDATE
--                 (`WHERE token_hash = $1 AND consumed_at IS NULL`), which has
--                 exactly one winner across any number of instances.
--
-- THE INDEXES.
--   token_hash, UNIQUE — it is how a confirmation is found, and two rows for
--                 one token would make "exactly one winner" false.
--   expires_at  — for the clear-out of rows that expired about a day ago.
--
-- ROLLING BACK THE APPLICATION DOES NOT NEED THIS UNDONE. A previous release
-- never reads or writes this table, so it can be left in place; it is not
-- dropped by any rollback step. See docs/DEPLOYMENT.md.

-- CreateTable
CREATE TABLE "Confirmation" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "integration" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "params_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "Confirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Confirmation_token_hash_key" ON "Confirmation"("token_hash");

-- CreateIndex
CREATE INDEX "Confirmation_expires_at_idx" ON "Confirmation"("expires_at");

-- AddForeignKey
ALTER TABLE "Confirmation" ADD CONSTRAINT "Confirmation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
