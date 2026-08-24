-- Add priority, historical_evidence_ids, and confidence_explanation columns
ALTER TABLE "PerformanceRecommendation" 
ADD COLUMN IF NOT EXISTS "priority" VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN IF NOT EXISTS "historical_evidence_ids" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN IF NOT EXISTS "confidence_explanation" JSONB;
