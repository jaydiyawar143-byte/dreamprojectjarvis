import type {
  ITool,
  ToolContext,
  ToolResult,
  ToolCategory,
  ToolParameter,
  ToolPermission,
  RiskLevel,
} from "@jarvis/core";

export abstract class BaseTool implements ITool {
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

  constructor(
    id: string,
    name: string,
    description: string,
    category: ToolCategory,
    parameters: ToolParameter[] = [],
    requiresApproval = false,
    requiredPermissions: ToolPermission[] = ["read"],
    risk: RiskLevel = "READ_ONLY",
    version = "1.0.0",
    enabled = true,
  ) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.category = category;
    this.risk = risk;
    this.parameters = parameters;
    this.requiresApproval = requiresApproval;
    this.requiredPermissions = requiredPermissions;
    this.version = version;
    this.enabled = enabled;
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
