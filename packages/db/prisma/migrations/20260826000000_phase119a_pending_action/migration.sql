-- AlterTable: Add conversationId and riskLevel to Approval
ALTER TABLE "Approval" ADD COLUMN "conversationId" TEXT;
ALTER TABLE "Approval" ADD COLUMN "riskLevel" TEXT;

-- CreateIndex for conversation-scoped pending action lookups
CREATE INDEX "Approval_conversationId_idx" ON "Approval"("conversationId");
CREATE INDEX "Approval_conversationId_status_idx" ON "Approval"("conversationId", "status");
