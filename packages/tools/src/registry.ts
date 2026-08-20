import type { ITool, RiskLevel, ToolDescription, Role } from "@jarvis/core";

export interface ToolHealth {
  healthy: boolean;
  lastChecked: Date;
  error?: string;
}

export interface ToolFilter {
  category?: string;
  risk?: RiskLevel;
  enabled?: boolean;
  requiresApproval?: boolean;
}

export class ToolRegistry {
  private tools: Map<string, ITool> = new Map();
  private healthCache: Map<string, ToolHealth> = new Map();
  private healthCheckFn: Map<string, () => Promise<boolean>> = new Map();

  register(tool: ITool, healthCheck?: () => Promise<boolean>): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool with id "${tool.id}" is already registered`);
    }
    this.tools.set(tool.id, tool);
    if (healthCheck) {
      this.healthCheckFn.set(tool.id, healthCheck);
    }
    this.healthCache.set(tool.id, { healthy: true, lastChecked: new Date() });
  }

  unregister(toolId: string): void {
    this.tools.delete(toolId);
    this.healthCache.delete(toolId);
    this.healthCheckFn.delete(toolId);
  }

  get(toolId: string): ITool | undefined {
    return this.tools.get(toolId);
  }

  getAll(): ITool[] {
    return Array.from(this.tools.values());
  }

  getEnabled(): ITool[] {
    return this.getAll().filter((t) => t.enabled);
  }

  getByCategory(category: string): ITool[] {
    return this.getAll().filter((tool) => tool.category === category);
  }

  getByRisk(risk: RiskLevel): ITool[] {
    return this.getAll().filter((tool) => tool.risk === risk);
  }

  getRequiringApproval(): ITool[] {
    return this.getAll().filter((tool) => tool.requiresApproval);
  }

  list(filter?: ToolFilter): ITool[] {
    let tools = this.getAll();
    if (filter?.category) tools = tools.filter((t) => t.category === filter.category);
    if (filter?.risk) tools = tools.filter((t) => t.risk === filter.risk);
    if (filter?.enabled !== undefined) tools = tools.filter((t) => t.enabled === filter.enabled);
    if (filter?.requiresApproval !== undefined) tools = tools.filter((t) => t.requiresApproval === filter.requiresApproval);
    return tools;
  }

  async isAvailable(toolId: string, _userId: string, _role: Role): Promise<boolean> {
    const tool = this.tools.get(toolId);
    if (!tool) return false;
    if (!tool.enabled) return false;

    const checkFn = this.healthCheckFn.get(toolId);
    if (checkFn) {
      try {
        const healthy = await checkFn();
        if (!healthy) return false;
      } catch {
        return false;
      }
    }

    return true;
  }

  async getHealth(toolId: string): Promise<ToolHealth> {
    const cached = this.healthCache.get(toolId);
    if (!cached) return { healthy: false, lastChecked: new Date(), error: "Tool not registered" };

    const checkFn = this.healthCheckFn.get(toolId);
    if (checkFn) {
      try {
        const healthy = await checkFn();
        const result: ToolHealth = { healthy, lastChecked: new Date() };
        this.healthCache.set(toolId, result);
        return result;
      } catch (err) {
        const result: ToolHealth = {
          healthy: false,
          lastChecked: new Date(),
          error: err instanceof Error ? err.message : "Health check failed",
        };
        this.healthCache.set(toolId, result);
        return result;
      }
    }

    return cached;
  }

  async runHealthChecks(): Promise<Map<string, ToolHealth>> {
    const results = new Map<string, ToolHealth>();
    for (const toolId of this.tools.keys()) {
      results.set(toolId, await this.getHealth(toolId));
    }
    return results;
  }

  getToolDescriptions(_userId: string, _role: Role): ToolDescription[] {
    return this.getEnabled().map((tool) => ({
      name: tool.id,
      description: tool.description,
      risk: tool.risk,
      approvalRequired: tool.requiresApproval,
      parameters: {
        type: "object" as const,
        properties: Object.fromEntries(
          tool.parameters.map((p) => [
            p.name,
            {
              type: p.type,
              description: p.description,
              ...(p.defaultValue !== undefined && p.type === "string"
                ? { enum: [String(p.defaultValue)] }
                : {}),
            },
          ])
        ),
        required: tool.parameters.filter((p) => p.required).map((p) => p.name),
      },
    }));
  }

  count(): number {
    return this.tools.size;
  }
}
