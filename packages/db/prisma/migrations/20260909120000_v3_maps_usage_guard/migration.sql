-- CreateTable
CREATE TABLE "MapsUsage" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MapsUsage_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "maps_usage_period_user_service_unique" ON "MapsUsage"("period", "user_id", "service");
-- CreateIndex
CREATE INDEX "maps_usage_period_idx" ON "MapsUsage"("period");
-- CreateIndex
CREATE INDEX "maps_usage_period_user_idx" ON "MapsUsage"("period", "user_id");
