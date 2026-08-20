import type {
  ToolPlan,
  ToolStep,
  ToolDescription,
  ITool,
} from "@jarvis/core";

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
}

export class ToolPlanValidator {
  validate(
    plan: ToolPlan,
    availableTools: ITool[]
  ): PlanValidationResult {
    const errors: string[] = [];
    const toolMap = new Map(availableTools.map((t) => [t.id, t]));

    if (plan.requiresTools && plan.steps.length === 0) {
      errors.push("Plan requires tools but has no steps");
    }

    if (!plan.requiresTools && plan.steps.length > 0) {
      errors.push("Plan has steps but requiresTools is false");
    }

    if (plan.steps.length === 0) {
      return { valid: errors.length === 0, errors };
    }

    const stepIndices = new Set<number>();
    const seen = new Set<string>();

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      const prefix = `Step ${i}`;

      if (seen.has(step.tool)) {
        errors.push(`${prefix}: Duplicate tool "${step.tool}" in plan`);
      }
      seen.add(step.tool);

      const tool = toolMap.get(step.tool);
      if (!tool) {
        errors.push(`${prefix}: Tool "${step.tool}" not found in registry`);
        continue;
      }

      if (!tool.enabled) {
        errors.push(`${prefix}: Tool "${step.tool}" is disabled`);
      }

      if (step.dependsOn !== undefined) {
        if (step.dependsOn >= i) {
          errors.push(`${prefix}: dependsOn (${step.dependsOn}) references future or self step`);
        }
        if (step.dependsOn < 0) {
          errors.push(`${prefix}: dependsOn (${step.dependsOn}) is negative`);
        }
        if (!stepIndices.has(step.dependsOn)) {
          errors.push(`${prefix}: dependsOn (${step.dependsOn}) references invalid step`);
        }
      }

      if (!tool.validate(step.params)) {
        errors.push(`${prefix}: Parameters failed validation for "${step.tool}"`);
      }

      stepIndices.add(i);
    }

    if (this.hasCycle(plan.steps)) {
      errors.push("Plan has circular dependencies");
    }

    return { valid: errors.length === 0, errors };
  }

  private hasCycle(steps: ToolStep[]): boolean {
    const n = steps.length;
    if (n <= 1) return false;

    const adj: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      if (steps[i]!.dependsOn !== undefined) {
        adj[steps[i]!.dependsOn!]!.push(i);
      }
    }

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Array(n).fill(WHITE);

    const dfs = (u: number): boolean => {
      color[u] = GRAY;
      for (const v of adj[u]) {
        if (color[v] === GRAY) return true;
        if (color[v] === WHITE && dfs(v)) return true;
      }
      color[u] = BLACK;
      return false;
    };

    for (let i = 0; i < n; i++) {
      if (color[i] === WHITE && dfs(i)) return true;
    }
    return false;
  }

  topologicalSort(steps: ToolStep[]): ToolStep[] {
    const n = steps.length;
    if (n <= 1) return [...steps];

    const adj: number[][] = Array.from({ length: n }, () => []);
    const inDeg = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (steps[i]!.dependsOn !== undefined) {
        adj[steps[i]!.dependsOn!]!.push(i);
        inDeg[i]++;
      }
    }

    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
      if (inDeg[i] === 0) queue.push(i);
    }

    const sorted: ToolStep[] = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      sorted.push(steps[u]!);
      for (const v of adj[u]) {
        inDeg[v]--;
        if (inDeg[v] === 0) queue.push(v);
      }
    }

    return sorted;
  }
}

export class ToolPlanParser {
  parse(rawOutput: string): ToolPlan | null {
    const jsonMatch = this.extractJson(rawOutput);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch);
      if (typeof parsed !== "object" || parsed === null) return null;
      if (typeof parsed.intent !== "string") return null;
      if (typeof parsed.requiresTools !== "boolean") return null;
      if (!Array.isArray(parsed.steps)) return null;

      return {
        intent: parsed.intent,
        requiresTools: parsed.requiresTools,
        steps: parsed.steps.map((s: Record<string, unknown>) => ({
          tool: String(s.tool ?? ""),
          params: (typeof s.params === "object" && s.params !== null ? s.params : {}) as Record<string, unknown>,
          dependsOn: typeof s.dependsOn === "number" ? s.dependsOn : undefined,
          reason: typeof s.reason === "string" ? s.reason : undefined,
        })),
        needsClarification: typeof parsed.needsClarification === "string"
          ? parsed.needsClarification
          : undefined,
      };
    } catch {
      return null;
    }
  }

  private extractJson(text: string): string | null {
    const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonBlock?.[1]) return jsonBlock[1].trim();

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return text.substring(firstBrace, lastBrace + 1);
    }

    return null;
  }
}

export class ToolDescriptionBuilder {
  buildDescriptions(tools: ITool[]): ToolDescription[] {
    return tools
      .filter((t) => t.enabled)
      .map((t) => ({
        name: t.id,
        description: t.description,
        risk: t.risk,
        approvalRequired: t.requiresApproval,
        parameters: {
          type: "object" as const,
          properties: Object.fromEntries(
            t.parameters.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ])
          ),
          required: t.parameters.filter((p) => p.required).map((p) => p.name),
        },
      }));
  }

  formatForSystemPrompt(tools: ITool[]): string {
    const descriptions = this.buildDescriptions(tools);
    if (descriptions.length === 0) return "";

    const lines = ["Available tools:", ""];
    for (const desc of descriptions) {
      lines.push(`- ${desc.name}: ${desc.description} [risk: ${desc.risk}${desc.approvalRequired ? ", approval required" : ""}]`);
      if (desc.parameters.required.length > 0) {
        lines.push(`  Required: ${desc.parameters.required.join(", ")}`);
      }
    }
    lines.push("");
    lines.push("To use a tool, respond with a JSON tool plan:");
    lines.push('{"intent":"...","requiresTools":true,"steps":[{"tool":"tool_name","params":{...}}]}');
    lines.push("If no tool is needed, respond normally.");

    return lines.join("\n");
  }
}
