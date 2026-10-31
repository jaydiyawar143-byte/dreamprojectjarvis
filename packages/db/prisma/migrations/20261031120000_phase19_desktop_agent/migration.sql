-- Phase 19, Stage 19.6 — the Windows desktop agent.
--
-- ADDITIVE: three enums, seven new tables, their indexes and foreign keys. No
-- existing table is altered and no row is written; a release from before this
-- stage never reads them. The feature is off unless DESKTOP_AGENT_ENABLED=true.
--
--   DesktopPairingCode     a one-time pairing code: its SHA-256, never the code.
--   DesktopDevice          a paired device: its public key, never a private one;
--                          one user in one Organization; pending until its user
--                          confirms the fingerprint.
--   DesktopGrant           consent given at the device, for a bounded time and
--                          scope, with the hash of the exact text shown.
--   DesktopCommand         one approved command and how it ended — no values.
--   DesktopCommandPayload  a command's parameters, sealed, deleted on delivery.
--   DesktopRequestNonce    agent request nonces, each spent by one INSERT.
--   DesktopPairingAttempt  the durable window that rate-limits redemption.
--
-- Generated with `prisma migrate diff` from the schema before and after.

-- CreateEnum
CREATE TYPE "DesktopDeviceStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "DesktopGrantStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "DesktopCommandStatus" AS ENUM ('ISSUED', 'DELIVERED', 'SUCCEEDED', 'NOT_EXECUTED', 'UNKNOWN', 'EXPIRED');

-- CreateTable
CREATE TABLE "DesktopPairingCode" (
    "id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "device_id" TEXT,

    CONSTRAINT "DesktopPairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesktopDevice" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "user_label" TEXT NOT NULL,
    "organization_label" TEXT NOT NULL,
    "agent_version" TEXT NOT NULL,
    "windows_build" INTEGER NOT NULL,
    "status" "DesktopDeviceStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" TEXT,
    "last_seen_at" TIMESTAMP(3),

    CONSTRAINT "DesktopDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesktopGrant" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "agent_instance_id" TEXT NOT NULL,
    "scope" TEXT[],
    "duration_minutes" INTEGER NOT NULL,
    "consent_text_version" TEXT NOT NULL,
    "consent_text_sha256" TEXT NOT NULL,
    "status" "DesktopGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_contact_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "end_reason" TEXT,

    CONSTRAINT "DesktopGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesktopCommand" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params_hash" TEXT NOT NULL,
    "requires_hello" BOOLEAN NOT NULL,
    "approval_id" TEXT,
    "execution_id" TEXT,
    "status" "DesktopCommandStatus" NOT NULL DEFAULT 'ISSUED',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "delivered_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "result_code" TEXT,

    CONSTRAINT "DesktopCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesktopCommandPayload" (
    "command_id" TEXT NOT NULL,
    "sealed" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesktopCommandPayload_pkey" PRIMARY KEY ("command_id")
);

-- CreateTable
CREATE TABLE "DesktopRequestNonce" (
    "scope" TEXT NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesktopRequestNonce_pkey" PRIMARY KEY ("scope","nonce_hash")
);

-- CreateTable
CREATE TABLE "DesktopPairingAttempt" (
    "id" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopPairingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DesktopPairingCode_code_hash_key" ON "DesktopPairingCode"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "DesktopPairingCode_device_id_key" ON "DesktopPairingCode"("device_id");

-- CreateIndex
CREATE INDEX "DesktopPairingCode_expires_at_idx" ON "DesktopPairingCode"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "DesktopDevice_fingerprint_key" ON "DesktopDevice"("fingerprint");

-- CreateIndex
CREATE INDEX "DesktopDevice_user_id_idx" ON "DesktopDevice"("user_id");

-- CreateIndex
CREATE INDEX "DesktopDevice_tenant_id_status_idx" ON "DesktopDevice"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "DesktopGrant_device_id_status_idx" ON "DesktopGrant"("device_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DesktopCommand_approval_id_key" ON "DesktopCommand"("approval_id");

-- CreateIndex
CREATE INDEX "DesktopCommand_device_id_status_idx" ON "DesktopCommand"("device_id", "status");

-- CreateIndex
CREATE INDEX "DesktopCommand_status_expires_at_idx" ON "DesktopCommand"("status", "expires_at");

-- CreateIndex
CREATE INDEX "DesktopCommandPayload_expires_at_idx" ON "DesktopCommandPayload"("expires_at");

-- CreateIndex
CREATE INDEX "DesktopRequestNonce_expires_at_idx" ON "DesktopRequestNonce"("expires_at");

-- CreateIndex
CREATE INDEX "DesktopPairingAttempt_source_hash_created_at_idx" ON "DesktopPairingAttempt"("source_hash", "created_at");

-- AddForeignKey
ALTER TABLE "DesktopPairingCode" ADD CONSTRAINT "DesktopPairingCode_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopPairingCode" ADD CONSTRAINT "DesktopPairingCode_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopDevice" ADD CONSTRAINT "DesktopDevice_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopDevice" ADD CONSTRAINT "DesktopDevice_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopDevice" ADD CONSTRAINT "DesktopDevice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopGrant" ADD CONSTRAINT "DesktopGrant_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "DesktopDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopCommand" ADD CONSTRAINT "DesktopCommand_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "DesktopDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopCommand" ADD CONSTRAINT "DesktopCommand_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "DesktopGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopCommandPayload" ADD CONSTRAINT "DesktopCommandPayload_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "DesktopCommand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

