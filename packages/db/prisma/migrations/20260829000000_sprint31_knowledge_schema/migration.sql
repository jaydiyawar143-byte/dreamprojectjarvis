-- AlterTable
ALTER TABLE "KnowledgeDocument" ADD COLUMN "userId" TEXT NOT NULL,
ADD COLUMN "documentType" TEXT,
ADD COLUMN "mimeType" TEXT,
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'UPLOADED';

-- CreateIndex
CREATE INDEX "KnowledgeDocument_userId_idx" ON "KnowledgeDocument"("userId");

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Redefine foreign key for KnowledgeChunk
ALTER TABLE "KnowledgeChunk" DROP CONSTRAINT "KnowledgeChunk_documentId_fkey";
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
