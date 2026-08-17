import type {
  ITool,
  ToolContext,
  ToolResult,
  ToolCategory,
  ToolParameter,
  ToolPermission,
} from "@jarvis/core";

export abstract class BaseTool implements ITool {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  parameters: ToolParameter[];
  requiresApproval: boolean;
  requiredPermissions: ToolPermission[];

  constructor(
    id: string,
    name: string,
    description: string,
    category: ToolCategory,
    parameters: ToolParameter[] = [],
    requiresApproval = false,
    requiredPermissions: ToolPermission[] = ["read"]
  ) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.category = category;
    this.parameters = parameters;
    this.requiresApproval = requiresApproval;
    this.requiredPermissions = requiredPermissions;
  }

  abstract execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult>;

  validate(params: Record<string, unknown>): boolean {
    const required = this.parameters.filter((p) => p.required);
    return required.every((p) => params[p.name] !== undefined);
  }

  protected success(
    data: unknown,
    metadata?: Record<string, unknown>
  ): ToolResult {
    return { success: true, data, metadata };
  }

  protected failure(error: string): ToolResult {
    return { success: false, error };
  }
}
