import type { ITool } from "@jarvis/core";

export class ToolRegistry {
  private tools: Map<string, ITool> = new Map();

  register(tool: ITool): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool with id "${tool.id}" is already registered`);
    }
    this.tools.set(tool.id, tool);
  }

  unregister(toolId: string): void {
    this.tools.delete(toolId);
  }

  get(toolId: string): ITool | undefined {
    return this.tools.get(toolId);
  }

  getAll(): ITool[] {
    return Array.from(this.tools.values());
  }

  getByCategory(category: string): ITool[] {
    return this.getAll().filter((tool) => tool.category === category);
  }

  getRequiringApproval(): ITool[] {
    return this.getAll().filter((tool) => tool.requiresApproval);
  }
}

export const toolRegistry = new ToolRegistry();
