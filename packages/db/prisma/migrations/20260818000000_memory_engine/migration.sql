-- Safe Memory Engine Migration
-- Strategy: preserve existing data, transform, validate, then remove obsolete structures
-- Backup table _Memory_v1_backup is retained until manual cleanup confirms data integrity.

-- Step 0: Ensure pgvector extension exists
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 1: Create MemoryType enum
CREATE TYPE "MemoryType" AS ENUM ('FACT', 'PREFERENCE', 'GOAL', 'PROJECT', 'DECISION', 'WORKFLOW');

-- Step 2: Rename old Memory table to backup (preserves all data)
ALTER TABLE "Memory" RENAME TO "Memory_v1";

-- Step 2b: Drop old constraints from renamed table to free up names
ALTER TABLE "Memory_v1" DROP CONSTRAINT "Memory_pkey";
ALTER TABLE "Memory_v1" DROP CONSTRAINT IF EXISTS "Memory_conversationId_fkey";

-- Step 3: Create new Memory table with user-scoped schema
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "MemoryType" NOT NULL DEFAULT 'FACT',
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "embedding" vector(1536),
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "sourceType" TEXT,
    "sourceConversationId" TEXT,
    "sourceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- Step 4: Backfill existing Memory rows
-- Preserves data: gets userId from Conversation, defaults type to FACT,
-- records sourceType='conversation' and sourceConversationId for traceability.
INSERT INTO "Memory" ("id", "userId", "type", "content", "embedding", "metadata", "sourceType", "sourceConversationId", "createdAt", "updatedAt")
SELECT
    mv."id",
    c."userId",
    'FACT'::"MemoryType",
    mv."content",
    mv."embedding",
    mv."metadata",
    'conversation',
    mv."conversationId",
    mv."createdAt",
    mv."createdAt"
FROM "Memory_v1" mv
INNER JOIN "Conversation" c ON c."id" = mv."conversationId";

-- Step 5: Drop the old conversation-scoped index (on renamed table)
DROP INDEX IF EXISTS "Memory_conversationId_idx";

-- Step 6: Create new indexes for user-scoped queries
CREATE INDEX "Memory_userId_idx" ON "Memory"("userId");
CREATE INDEX "Memory_userId_type_idx" ON "Memory"("userId", "type");
CREATE INDEX "Memory_userId_createdAt_idx" ON "Memory"("userId", "createdAt");

-- Step 7: Add foreign key to User
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 8: Remove old foreign key from Conversation (on renamed table)
ALTER TABLE "Memory_v1" DROP CONSTRAINT IF EXISTS "Memory_conversationId_fkey";

-- Step 9: Validation — verify backfill integrity before any cleanup
-- Compare row counts between old and new tables. If counts mismatch,
-- investigate orphaned records before proceeding.
DO $$
DECLARE
    old_count BIGINT;
    new_count BIGINT;
    orphan_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO old_count FROM "Memory_v1";
    SELECT COUNT(*) INTO new_count FROM "Memory";
    SELECT COUNT(*) INTO orphan_count FROM "Memory_v1" mv
        LEFT JOIN "Conversation" c ON c."id" = mv."conversationId"
        WHERE c."id" IS NULL;

    RAISE NOTICE 'Migration validation: old_table=%, new_table=%, orphans=% (orphaned by deleted conversation)',
        old_count, new_count, orphan_count;

    IF new_count + orphan_count < old_count THEN
        RAISE EXCEPTION 'Migration validation FAILED: new_table(%) + orphans(%) < old_table(%)',
            new_count, orphan_count, old_count;
    END IF;

    RAISE NOTICE 'Migration validation PASSED';
END $$;

-- Step 10: Rename backup table for manual cleanup
-- DO NOT DROP: allows manual verification of data integrity.
-- Drop _Memory_v1_backup after confirming all data was correctly migrated.
ALTER TABLE "Memory_v1" RENAME TO "_Memory_v1_backup";
