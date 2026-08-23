-- ---------------------------------------------------------------------------
-- Phase 11 (11.1 + 11.5): Marketing Intelligence data models.
--
-- Creates MarketingAccount, MetricSnapshot, PerformanceRecommendation (with
-- evidence/state binding columns) and DecisionRecord. Purely additive:
-- no existing tables or rows are touched.
-- ---------------------------------------------------------------------------

CREATE TYPE "PerformanceLevel" AS ENUM ('ACCOUNT', 'CAMPAIGN', 'AD_SET', 'AD');

-- PROPOSED -> APPROVED -> EXECUTING -> EXECUTED (+ REJECTED/EXPIRED/STALE/FAILED).
-- PENDING_APPROVAL retained as a legacy value for compatibility.
CREATE TYPE "RecommendationStatus" AS ENUM ('PROPOSED', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'EXECUTED', 'REJECTED', 'EXPIRED', 'STALE', 'FAILED');

CREATE TYPE "OptimizationActionType" AS ENUM ('PAUSE_CAMPAIGN', 'RESUME_CAMPAIGN', 'PAUSE_ADSET', 'RESUME_ADSET', 'PAUSE_AD', 'RESUME_AD', 'INCREASE_BUDGET', 'DECREASE_BUDGET');

-- --------------------------------------------------------------- MarketingAccount

CREATE TABLE "MarketingAccount" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone_name" TEXT NOT NULL DEFAULT 'UTC',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketingAccount_account_id_key" ON "MarketingAccount"("account_id");
CREATE INDEX "MarketingAccount_user_id_idx" ON "MarketingAccount"("user_id");

ALTER TABLE "MarketingAccount" ADD CONSTRAINT "MarketingAccount_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --------------------------------------------------------------- MetricSnapshot

CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "level" "PerformanceLevel" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "entity_name" TEXT,
    "date_start" TIMESTAMP(3) NOT NULL,
    "date_stop" TIMESTAMP(3) NOT NULL,
    "period_type" TEXT NOT NULL,
    "spend" DECIMAL(12,2) NOT NULL,
    "impressions" BIGINT NOT NULL,
    "clicks" BIGINT NOT NULL,
    "reach" BIGINT NOT NULL DEFAULT 0,
    "conversions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "ctr" DOUBLE PRECISION,
    "cpc" DECIMAL(10,4),
    "cpm" DECIMAL(10,4),
    "cpa" DECIMAL(10,4),
    "roas" DOUBLE PRECISION,
    "cvr" DOUBLE PRECISION,
    "frequency" DOUBLE PRECISION,
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "metric_snapshot_unique_key" ON "MetricSnapshot"("account_id", "level", "entity_id", "date_start", "date_stop", "period_type");
CREATE INDEX "MetricSnapshot_account_id_level_entity_id_date_start_idx" ON "MetricSnapshot"("account_id", "level", "entity_id", "date_start");
CREATE INDEX "MetricSnapshot_date_start_date_stop_idx" ON "MetricSnapshot"("date_start", "date_stop");

ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "MarketingAccount"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------- PerformanceRecommendation

CREATE TABLE "PerformanceRecommendation" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "target_level" "PerformanceLevel" NOT NULL,
    "target_id" TEXT NOT NULL,
    "action_type" "OptimizationActionType" NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',

    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "expected_impact" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "risk_level" TEXT NOT NULL,
    "proposed_change" JSONB NOT NULL,
    "params_hash" TEXT NOT NULL,

    -- Phase 11.5 evidence/state binding
    "diagnosis_id" TEXT,
    "anomaly_ids" JSONB NOT NULL DEFAULT '[]',
    "current_state" JSONB,
    "proposed_state" JSONB,
    "preconditions" JSONB NOT NULL DEFAULT '[]',
    "evidence_hash" TEXT,
    "state_hash" TEXT,
    "identity_hash" TEXT,
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "stale_reasons" JSONB,

    "approval_id" TEXT,
    "execution_id" TEXT,

    "expires_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerformanceRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PerformanceRecommendation_user_id_status_idx" ON "PerformanceRecommendation"("user_id", "status");
CREATE INDEX "PerformanceRecommendation_account_id_target_id_idx" ON "PerformanceRecommendation"("account_id", "target_id");
CREATE INDEX "PerformanceRecommendation_account_id_target_id_status_idx" ON "PerformanceRecommendation"("account_id", "target_id", "status");
CREATE INDEX "PerformanceRecommendation_params_hash_idx" ON "PerformanceRecommendation"("params_hash");

-- Active-duplicate prevention: at most ONE active recommendation may exist
-- per deterministic identity (account+entity+diagnosis+action+state+params+
-- evidence). Terminal rows are excluded so history remains appendable.
CREATE UNIQUE INDEX "perf_rec_active_identity_unique"
    ON "PerformanceRecommendation"("identity_hash")
    WHERE "identity_hash" IS NOT NULL
      AND status IN ('PROPOSED', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING');

ALTER TABLE "PerformanceRecommendation" ADD CONSTRAINT "PerformanceRecommendation_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "MarketingAccount"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --------------------------------------------------------------- DecisionRecord

CREATE TABLE "DecisionRecord" (
    "id" TEXT NOT NULL,
    "recommendation_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "baseline_metrics" JSONB NOT NULL,
    "post_metrics" JSONB,
    "measured_at" TIMESTAMP(3),
    "outcome_rating" TEXT,
    "kpi_delta_percent" DOUBLE PRECISION,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DecisionRecord_recommendation_id_key" ON "DecisionRecord"("recommendation_id");
CREATE INDEX "DecisionRecord_account_id_idx" ON "DecisionRecord"("account_id");

ALTER TABLE "DecisionRecord" ADD CONSTRAINT "DecisionRecord_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "PerformanceRecommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionRecord" ADD CONSTRAINT "DecisionRecord_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "MarketingAccount"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
