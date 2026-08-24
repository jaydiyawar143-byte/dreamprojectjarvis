-- Phase 11.7A — Outcome Measurement Foundation Migration
-- Creates OutcomeRecord table and supporting enums.
-- DecisionRecord is kept INTACT (backward compat).
-- OutcomeRecord is the authoritative Phase 11.7A+ measurement table.
-- Idempotent: all CREATE statements use IF NOT EXISTS.

-- ---------------------------------------------------------------------------
-- 1. New enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "OutcomeEnum" AS ENUM (
    'POSITIVE',
    'NEGATIVE',
    'NEUTRAL',
    'INCONCLUSIVE',
    'NOT_MEASURABLE',
    'FAILED_ACTION'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MeasurementState" AS ENUM (
    'WAITING_FOR_DATA',
    'WAITING_FOR_ATTRIBUTION',
    'READY',
    'FINALIZED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. OutcomeRecord table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "OutcomeRecord" (
  -- Core identifiers
  "outcome_id"          TEXT          NOT NULL DEFAULT gen_random_uuid()::text,
  "recommendation_id"   TEXT          NOT NULL,
  "execution_id"        TEXT          NOT NULL,
  "user_id"             TEXT          NOT NULL,
  "account_id"          TEXT          NOT NULL,

  -- Entity context
  "entity_type"         "PerformanceLevel"     NOT NULL,
  "entity_id"           TEXT          NOT NULL,
  "action_type"         "OptimizationActionType" NOT NULL,
  "objective"           TEXT,
  "primary_metric"      TEXT          NOT NULL,

  -- Immutable baseline snapshot (written once, NEVER updated)
  "baseline_snapshot"   JSONB         NOT NULL,

  -- Current measurement (null until data arrives)
  "measurement_kpis"    JSONB,
  "comparison"          JSONB,

  -- Outcome verdict (null until FINALIZED)
  "outcome_enum"        "OutcomeEnum",
  "confidence"          DOUBLE PRECISION,
  "data_quality"        TEXT,

  -- Attribution & confounders
  "attribution_status"  TEXT          NOT NULL,
  "confounders"         JSONB         NOT NULL DEFAULT '[]',
  "measurement_window"  JSONB         NOT NULL,

  -- Lifecycle
  "measurement_state"   "MeasurementState"  NOT NULL DEFAULT 'WAITING_FOR_DATA',
  "is_final"            BOOLEAN       NOT NULL DEFAULT FALSE,
  "measured_at"         TIMESTAMPTZ,
  "created_at"          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT "OutcomeRecord_pkey" PRIMARY KEY ("outcome_id")
);

-- ---------------------------------------------------------------------------
-- 3. Constraints
-- ---------------------------------------------------------------------------

-- One outcome per recommendation (unique)
DO $$ BEGIN
  ALTER TABLE "OutcomeRecord"
    ADD CONSTRAINT "OutcomeRecord_recommendation_id_key" UNIQUE ("recommendation_id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- FK → PerformanceRecommendation (cascade delete)
DO $$ BEGIN
  ALTER TABLE "OutcomeRecord"
    ADD CONSTRAINT "OutcomeRecord_recommendation_fk"
    FOREIGN KEY ("recommendation_id")
    REFERENCES "PerformanceRecommendation"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- FK → MarketingAccount (cascade delete)
DO $$ BEGIN
  ALTER TABLE "OutcomeRecord"
    ADD CONSTRAINT "OutcomeRecord_account_fk"
    FOREIGN KEY ("account_id")
    REFERENCES "MarketingAccount"("account_id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "outcome_records_user_account_idx"
  ON "OutcomeRecord" ("user_id", "account_id");

CREATE INDEX IF NOT EXISTS "outcome_records_account_state_idx"
  ON "OutcomeRecord" ("account_id", "measurement_state");

CREATE INDEX IF NOT EXISTS "outcome_records_recommendation_idx"
  ON "OutcomeRecord" ("recommendation_id");

CREATE INDEX IF NOT EXISTS "outcome_records_created_at_idx"
  ON "OutcomeRecord" ("created_at");

-- ---------------------------------------------------------------------------
-- 5. Row-level immutability guard (function + trigger)
-- Prevents ANY update to a finalized outcome record.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION outcome_record_immutability_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_final = TRUE THEN
    RAISE EXCEPTION
      'OutcomeRecord % is FINALIZED and immutable. No updates allowed.',
      OLD.outcome_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outcome_record_immutability ON "OutcomeRecord";
CREATE TRIGGER outcome_record_immutability
  BEFORE UPDATE ON "OutcomeRecord"
  FOR EACH ROW
  EXECUTE FUNCTION outcome_record_immutability_guard();

-- ---------------------------------------------------------------------------
-- 6. updated_at auto-refresh trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_outcome_record_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outcome_record_updated_at ON "OutcomeRecord";
CREATE TRIGGER outcome_record_updated_at
  BEFORE UPDATE ON "OutcomeRecord"
  FOR EACH ROW
  EXECUTE FUNCTION update_outcome_record_updated_at();
