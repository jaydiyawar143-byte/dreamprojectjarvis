-- CreateTable
CREATE TABLE "WhatsAppAccount" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "wa_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "status" TEXT,
    "provider_timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_phone_number_id_key" ON "WhatsAppAccount"("phone_number_id");

-- CreateIndex
CREATE INDEX "WhatsAppAccount_user_id_idx" ON "WhatsAppAccount"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_provider_message_id_key" ON "WhatsAppMessage"("provider_message_id");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_user_id_created_at_idx" ON "WhatsAppMessage"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_user_id_wa_id_idx" ON "WhatsAppMessage"("user_id", "wa_id");

-- AddForeignKey
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

