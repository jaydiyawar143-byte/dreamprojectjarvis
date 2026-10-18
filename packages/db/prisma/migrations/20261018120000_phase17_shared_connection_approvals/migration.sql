-- Phase 17 multi-business hardening (review finding H2) — approvals for writes
-- through a connection the deployment configures for everyone.
--
-- TWO new nullable columns on "Approval", one index and two foreign keys.
-- Additive: nothing existing is altered, renamed or dropped, and no row is
-- read or written — every existing approval keeps NULL in both, and behaves
-- exactly as before. Generated with `prisma migrate diff` from the schema
-- before and after.
--
-- WHAT THEY HOLD.
--   tenantId     the Organization a shared-connection write acts for, set by
--                the approval store alone, from the owner record, when the
--                approval is created. Such an approval is decided by one of
--                that Organization's owners or admins who is not the
--                requester. ON DELETE RESTRICT: an Organization with approvals
--                on record is not deleted out from under them.
--   decidedById  who decided it, when someone other than the requester did.
--                ON DELETE SET NULL: an approval whose approver no longer
--                exists can never be consumed — consumption requires one.
--
-- A previous release ignores both columns, so it can run against this schema;
-- rolling back never undoes this migration.

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "tenantId" TEXT;

-- CreateIndex
CREATE INDEX "Approval_tenantId_status_idx" ON "Approval"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
