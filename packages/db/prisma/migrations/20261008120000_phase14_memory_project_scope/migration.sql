-- Phase 14 — project-scoped memory and the retention sweep's index.
--
-- ADDITIVE ONLY. Two new nullable columns, one new table, three new indexes
-- and three new foreign keys. No existing row is rewritten and no existing
-- column changes, so a release from before Phase 14 starts against this
-- database unchanged: it never reads or writes any of it. Every existing
-- memory and conversation has "projectId" NULL, which is exactly what it
-- always was — personal.

-- A project: a name, owned by one user.
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Project_userId_name_key" ON "Project"("userId", "name");

-- Exists so "Memory" can reference a project by (id, owner) — see below.
CREATE UNIQUE INDEX "Project_id_userId_key" ON "Project"("id", "userId");

ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A memory's project. NULL: personal.
ALTER TABLE "Memory" ADD COLUMN "projectId" TEXT;

CREATE INDEX "Memory_userId_projectId_idx" ON "Memory"("userId", "projectId");

-- The retention sweep looks for expired rows across users.
CREATE INDEX "Memory_expiresAt_idx" ON "Memory"("expiresAt");

-- BOTH columns: a memory can only name a project that its own user owns. The
-- database refuses anything else, whatever the application does. (MATCH
-- SIMPLE: a personal memory, with "projectId" NULL, is not checked.)
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_projectId_userId_fkey"
    FOREIGN KEY ("projectId", "userId") REFERENCES "Project"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- A conversation's project. NULL: personal.
ALTER TABLE "Conversation" ADD COLUMN "projectId" TEXT;

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
