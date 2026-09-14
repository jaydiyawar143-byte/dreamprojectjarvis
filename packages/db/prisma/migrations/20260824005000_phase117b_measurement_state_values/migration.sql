-- Commits the MeasurementState values that 20260824010000_phase117b_outcome_worker
-- uses. PostgreSQL rejects a new enum value in the transaction that added it
-- (55P04), and a migration file is applied as one transaction. Adding the values
-- here, one migration earlier, commits them before 117b runs; 117b's own
-- ADD VALUE IF NOT EXISTS then does nothing. No-op where the values exist.
ALTER TYPE "MeasurementState" ADD VALUE IF NOT EXISTS 'SCHEDULED';
ALTER TYPE "MeasurementState" ADD VALUE IF NOT EXISTS 'COLLECTING';
