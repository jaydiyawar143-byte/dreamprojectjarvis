import { z } from "zod";

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
