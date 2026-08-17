import { z } from "zod";

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

export const ToolPermissionSchema = z.enum([
  "read",
  "write",
  "execute",
  "admin",
]);

export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

export const ToolParameterSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
});

export type ToolParameter = z.infer<typeof ToolParameterSchema>;

export const ToolResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

export interface ToolContext {
  userId: string;
  agentId?: string;
  conversationId?: string;
}

export interface ITool {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  parameters: ToolParameter[];
  requiresApproval: boolean;
  requiredPermissions: ToolPermission[];

  execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult>;
  validate(params: Record<string, unknown>): boolean;
}
