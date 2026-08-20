-- Supplemental Memory Migration: backfill sourceType and handle backup table
-- For databases where the original migration already ran without sourceType backfill.

-- Backfill sourceType for records migrated from conversation-scoped schema
UPDATE "Memory" SET "sourceType" = 'conversation'
WHERE "sourceConversationId" IS NOT NULL AND "sourceType" IS NULL;

-- Rename backup table if it still exists (original migration may have dropped it)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Memory_v1') THEN
        ALTER TABLE "Memory_v1" RENAME TO "_Memory_v1_backup";
        RAISE NOTICE 'Renamed Memory_v1 to _Memory_v1_backup for manual cleanup';
    END IF;
END $$;
