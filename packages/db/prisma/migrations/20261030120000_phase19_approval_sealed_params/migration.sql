-- Phase 19, Stage 19.5 — value-free approval records (S3).
--
-- ADDITIVE: one new table, its index and its foreign key. No existing table is
-- altered and no row is written. A release from before this stage never reads
-- it; an approval such a release finds for a browser or desktop action holds
-- only the value-free record, whose hash never matches, so it is refused,
-- never run.
--
--   ApprovalSealedParams  a browser or desktop approval's exact parameters,
--                         sealed (AES-256-GCM) apart from the approval, whose
--                         `params` keep only the value-free record. Deleted
--                         when the approval is rejected, consumed or expired,
--                         and with the approval (ON DELETE CASCADE).
--
-- Generated with `prisma migrate diff` from the schema before and after.

-- CreateTable
CREATE TABLE "ApprovalSealedParams" (
    "approval_id" TEXT NOT NULL,
    "sealed" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalSealedParams_pkey" PRIMARY KEY ("approval_id")
);

-- CreateIndex
CREATE INDEX "ApprovalSealedParams_expires_at_idx" ON "ApprovalSealedParams"("expires_at");

-- AddForeignKey
ALTER TABLE "ApprovalSealedParams" ADD CONSTRAINT "ApprovalSealedParams_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "Approval"("id") ON DELETE CASCADE ON UPDATE CASCADE;
