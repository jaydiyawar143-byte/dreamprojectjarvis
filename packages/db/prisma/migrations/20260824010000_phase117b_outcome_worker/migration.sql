-- Phase 11.7B — Outcome Worker + Revisions Migration
-- Alters MeasurementState enum to support SCHEDULED and COLLECTING.
-- Creates OutcomeRevision table linked to OutcomeRecord.
-- Idempotent: uses IF NOT EXISTS and DO blocks.

-- ---------------------------------------------------------------------------
-- 1. Alter MeasurementState enum
-- Enums cannot be altered inside a transaction block in PostgreSQL easily.
-- So we add the values best-effort.
-- ---------------------------------------------------------------------------

ALTER TYPE "MeasurementState" ADD VALUE IF NOT EXISTS 'SCHEDULED';
ALTER TYPE "MeasurementState" ADD VALUE IF NOT EXISTS 'COLLECTING';

-- ---------------------------------------------------------------------------
-- 2. Alter OutcomeRecord default state
-- ---------------------------------------------------------------------------

ALTER TABLE "OutcomeRecord" ALTER COLUMN "measurement_state" SET DEFAULT 'SCHEDULED';

-- ---------------------------------------------------------------------------
-- 3. Create OutcomeRevision table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "OutcomeRevision" (
  "id"                  TEXT          NOT NULL DEFAULT gen_random_uuid()::text,
  "outcome_id"          TEXT          NOT NULL,
  "revision_number"     INTEGER       NOT NULL,
  "outcome_enum"        "OutcomeEnum" NOT NULL,
  "confidence"          DOUBLE PRECISION NOT NULL,
  "data_quality"        TEXT          NOT NULL,
  "attribution_status"  TEXT          NOT NULL,
  "confounders"         JSONB         NOT NULL DEFAULT '[]',
  "measurement_kpis"    JSONB         NOT NULL,
  "comparison"          JSONB         NOT NULL,
  "measured_at"         TIMESTAMPTZ   NOT NULL,
  "created_at"          TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT "OutcomeRevision_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 4. Constraints & FK
-- ---------------------------------------------------------------------------

-- Unique combination of outcome_id + revision_number
DO $$ BEGIN
  ALTER TABLE "OutcomeRevision"
    ADD CONSTRAINT "OutcomeRevision_unique_idx" UNIQUE ("outcome_id", "revision_number");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- FK → OutcomeRecord (cascade delete)
DO $$ BEGIN
  ALTER TABLE "OutcomeRevision"
    ADD CONSTRAINT "OutcomeRevision_outcome_fk"
    FOREIGN KEY ("outcome_id")
    REFERENCES "OutcomeRecord"("outcome_id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "outcome_revisions_outcome_idx"
  ON "OutcomeRevision" ("outcome_id");
