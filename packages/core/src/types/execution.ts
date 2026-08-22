import { z } from "zod";
import type { Role } from "./common.js";
import type { ToolResult } from "./tool.js";

export const ToolInvocationSchema = z.object({
  toolId: z.string(),
  params: z.record(z.unknown()),
  requiresApproval: z.boolean(),
});

export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;

export const ExecutionStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "awaiting_approval",
]);

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const AgentExecutionSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string(),
  userId: z.string(),
  conversationId: z.string(),
  traceId: z.string().uuid(),
  status: ExecutionStatusSchema,
  input: z.string(),
  output: z.string().optional(),
  toolCalls: z.array(ToolInvocationSchema).optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export type AgentExecution = z.infer<typeof AgentExecutionSchema>;

export type ToolExecutionStatus =
  | "pending"
  | "validating"
  | "executing"
  | "completed"
  | "failed"
  | "timed_out"
  | "permission_denied"
  | "approval_required"
  | "approval_pending"
  | "approval_denied";

export interface ToolExecutionRequest {
  toolId: string;
  params: Record<string, unknown>;
  userId: string;
  role: Role;
  agentId?: string;
  conversationId?: string;
  traceId: string;
  ipAddress?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
  executionId?: string;
  stepIndex?: number;
  /**
   * Caller-side cancellation signal (Phase 10.4). Combined with the
   * executor's authoritative deadline; when either fires the tool's
   * context signal aborts and the underlying HTTP request is cancelled.
   * NOTE: aborting does NOT prove an external write did not happen —
   * journal classification (FAILED vs UNKNOWN) is decided by the tool.
   */
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  executionId: string;
  toolId: string;
  status: ToolExecutionStatus;
  result?: ToolResult;
  approvalId?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
}

export interface IToolExecutor {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}
