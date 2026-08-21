-- Phase 10.1 — Durable execution journal
-- Additive migration: creates enum + table + indexes. No data is modified.

-- CreateEnum
CREATE TYPE "ToolExecutionStatus" AS ENUM ('PENDING', 'APPROVED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'RECONCILING', 'CANCELLED');

-- CreateTable
CREATE TABLE "ToolExecution" (
    "execution_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "params_hash" TEXT,
    "status" "ToolExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "external_resource_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "trace_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("execution_id")
);

-- Unique constraint enforcing idempotency at the database level:
-- the same (userId, toolId, idempotencyKey) can never create two executions.
CREATE UNIQUE INDEX "tool_executions_idempotency_unique" ON "ToolExecution"("user_id", "tool_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "tool_executions_user_idx" ON "ToolExecution"("user_id");
CREATE INDEX "tool_executions_status_idx" ON "ToolExecution"("status");
CREATE INDEX "tool_executions_idem_key_idx" ON "ToolExecution"("idempotency_key");
CREATE INDEX "tool_executions_trace_idx" ON "ToolExecution"("trace_id");
CREATE INDEX "tool_executions_created_at_idx" ON "ToolExecution"("created_at");

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
