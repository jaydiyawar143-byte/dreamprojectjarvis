-- CreateTable
CREATE TABLE "N8nWorkflow" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "webhook_path" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "N8nWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "N8nExecution" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "remote_execution_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'TRIGGERED',
    "payload_hash" TEXT NOT NULL,
    "callback_event_id" TEXT,
    "result_summary" TEXT,
    "error_code" TEXT,
    "trace_id" TEXT NOT NULL,
    "triggered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "N8nExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "N8nWorkflow_user_id_idx" ON "N8nWorkflow"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "N8nWorkflow_user_id_webhook_path_key" ON "N8nWorkflow"("user_id", "webhook_path");

-- CreateIndex
CREATE UNIQUE INDEX "N8nExecution_idempotency_key_key" ON "N8nExecution"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "N8nExecution_callback_event_id_key" ON "N8nExecution"("callback_event_id");

-- CreateIndex
CREATE INDEX "N8nExecution_user_id_triggered_at_idx" ON "N8nExecution"("user_id", "triggered_at");

-- CreateIndex
CREATE INDEX "N8nExecution_workflow_id_idx" ON "N8nExecution"("workflow_id");

-- AddForeignKey
ALTER TABLE "N8nWorkflow" ADD CONSTRAINT "N8nWorkflow_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "N8nExecution" ADD CONSTRAINT "N8nExecution_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "N8nExecution" ADD CONSTRAINT "N8nExecution_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "N8nWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

