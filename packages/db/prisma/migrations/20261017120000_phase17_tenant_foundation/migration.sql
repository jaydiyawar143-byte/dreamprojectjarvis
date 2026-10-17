-- Phase 17, Stage 3A — the tenant foundation (Organizations in the product).
--
-- ONE new enum and THREE new tables. Additive: nothing existing is altered,
-- renamed or dropped, and no row is read or written — there is no backfill.
-- Generated with `prisma migrate diff` from the schema before and after.
--
-- WHAT THEY HOLD (docs/tenant-model-design.md).
--   Tenant                    a business: the ownership and data boundary for
--                             tenant-owned resources.
--   TenantMembership          one account's role in one tenant — the only
--                             source of a tenant role. UNIQUE (tenant_id,
--                             user_id): one role per account per tenant, and
--                             the key every membership read uses.
--   AutomationConnectorOwner  which tenant owns a connection the deployment
--                             configures for everyone. UNIQUE (provider_id,
--                             connector): at most one owner. ON DELETE
--                             RESTRICT: the owning tenant cannot be deleted
--                             while it owns the connection.
--
-- Rows are written only by the operator command
-- (packages/db/src/maintenance/tenant-admin.ts), each change in one
-- transaction with its audit row. Until an operator assigns an owner, every
-- request for a tenant-owned connection is refused.
--
-- ROLLING BACK THE APPLICATION DOES NOT NEED THIS UNDONE. A previous release
-- never reads or writes these tables, so they are left in place; no rollback
-- step drops them. See docs/DEPLOYMENT.md.

-- CreateEnum
CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantMembership" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationConnectorOwner" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationConnectorOwner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantMembership_user_id_idx" ON "TenantMembership"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "TenantMembership_tenant_id_user_id_key" ON "TenantMembership"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "AutomationConnectorOwner_tenant_id_idx" ON "AutomationConnectorOwner"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationConnectorOwner_provider_id_connector_key" ON "AutomationConnectorOwner"("provider_id", "connector");

-- AddForeignKey
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationConnectorOwner" ADD CONSTRAINT "AutomationConnectorOwner_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
