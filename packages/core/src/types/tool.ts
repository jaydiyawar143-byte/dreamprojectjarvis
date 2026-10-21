import { z } from "zod";
import type { InputMode } from "./voice.js";

// ---------------------------------------------------------------------------
// Risk Level
// ---------------------------------------------------------------------------

export const RiskLevelSchema = z.enum([
  "READ_ONLY",
  "LOW_IMPACT",
  "EXTERNAL_SIDE_EFFECT",
  "HIGH_IMPACT",
  "FINANCIAL",
]);

export type RiskLevel = z.infer<typeof RiskLevelSchema>;

// ---------------------------------------------------------------------------
// Tool Category
// ---------------------------------------------------------------------------

export const ToolCategorySchema = z.enum([
  "database",
  "communication",
  "marketing",
  "research",
  "file",
  "integration",
  "system",
]);

export type ToolCategory = z.infer<typeof ToolCategorySchema>;

// ---------------------------------------------------------------------------
// Tool Permission
// ---------------------------------------------------------------------------

export const ToolPermissionSchema = z.enum([
  "read",
  "write",
  "execute",
  "admin",
]);

export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

// ---------------------------------------------------------------------------
// Tool Parameter
// ---------------------------------------------------------------------------

export const ToolParameterSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
});

export type ToolParameter = z.infer<typeof ToolParameterSchema>;

// ---------------------------------------------------------------------------
// Tool Result
// ---------------------------------------------------------------------------

export const ToolResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

// ---------------------------------------------------------------------------
// Tool Context (passed to tool.execute)
// ---------------------------------------------------------------------------

export interface ToolContext {
  userId: string;
  agentId?: string;
  conversationId?: string;
  traceId?: string;
  /**
   * One-time approval authorizing THIS execution (Phase 10.3). When present,
   * approval-gated tools atomically consume it (verifying user, tool,
   * paramsHash, state and expiry) together with the execution claim before
   * any external side effect. A consumed approval can never be reused.
   */
  approvalId?: string;
  /**
   * Cancellation signal for THIS execution (Phase 10.4). Owned by the
   * ToolExecutor's single authoritative deadline controller; fires when the
   * execution deadline expires or the caller aborts. Tools MUST forward it
   * to their provider so the underlying HTTP request is actually cancelled.
   * A timeout/abort NEVER proves an external write did not happen — tools
   * classify the outcome into the journal (FAILED vs UNKNOWN).
   */
  signal?: AbortSignal;
  /**
   * Phase 18.2 — "voice" when the turn that asked for this was spoken. Set by
   * the executor from the request; a tool speech may not start refuses on it
   * too, behind the executor's own refusal.
   */
  inputMode?: InputMode;
}

// ---------------------------------------------------------------------------
// ToolAccessGate — Phase 17, who may use a tool at all
// ---------------------------------------------------------------------------

/**
 * Asked about a tool BEFORE an approval is looked up or created — by the
 * executor and by the orchestrator's pending-action path — so a request the
 * caller could never be allowed to make is refused at once instead of being
 * put in front of an approver. For a tool that acts through a shared
 * connection it answers from the caller's membership in the Organization
 * that owns the connection; for every other tool it allows.
 *
 * An early answer, not the enforcement: the tool checks again as it runs, and
 * the approval store again as it consumes the approval. `reason` is shown to
 * the caller, so it is a fixed sentence that names no Organization.
 */
export interface ToolAccessGate {
  check(input: { toolId: string; userId: string }): Promise<{ allowed: true } | { allowed: false; reason: string }>;
}

// ---------------------------------------------------------------------------
// ITool — Core tool contract
// ---------------------------------------------------------------------------

export interface ITool {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  risk: RiskLevel;
  parameters: ToolParameter[];
  requiresApproval: boolean;
  requiredPermissions: ToolPermission[];
  version: string;
  enabled: boolean;

  execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult>;
  validate(params: Record<string, unknown>): boolean;
}

// ---------------------------------------------------------------------------
// ToolPlan — Structured output from model
// ---------------------------------------------------------------------------

export const ToolStepSchema = z.object({
  tool: z.string(),
  params: z.record(z.unknown()).default({}),
  dependsOn: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

export type ToolStep = z.infer<typeof ToolStepSchema>;

export const ToolPlanSchema = z.object({
  intent: z.string(),
  requiresTools: z.boolean(),
  steps: z.array(ToolStepSchema).default([]),
  needsClarification: z.string().optional(),
});

export type ToolPlan = z.infer<typeof ToolPlanSchema>;

// ---------------------------------------------------------------------------
// ToolDescription — Sent to model (compact)
// ---------------------------------------------------------------------------

export interface ToolDescription {
  name: string;
  description: string;
  risk: RiskLevel;
  approvalRequired: boolean;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}
