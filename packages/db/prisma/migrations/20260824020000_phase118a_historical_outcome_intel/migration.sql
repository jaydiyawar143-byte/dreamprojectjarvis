-- AlterTable: Add diagnosis_category to PerformanceRecommendation
ALTER TABLE "PerformanceRecommendation" ADD COLUMN "diagnosis_category" TEXT;

-- AlterTable: Add diagnosis_category to OutcomeRecord
ALTER TABLE "OutcomeRecord" ADD COLUMN "diagnosis_category" TEXT;

-- CreateIndex: Add index for user/account/category query optimization on OutcomeRecord
CREATE INDEX "outcome_records_user_account_category_idx" ON "OutcomeRecord"("user_id", "account_id", "diagnosis_category");
