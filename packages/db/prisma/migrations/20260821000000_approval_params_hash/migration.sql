-- Bind approvals to the exact approved parameters (SHA-256 of canonical form).
-- Nullable: legacy rows have no hash and must never authorize
-- approval-gated (write) tool execution.
ALTER TABLE "Approval" ADD COLUMN "paramsHash" TEXT;
