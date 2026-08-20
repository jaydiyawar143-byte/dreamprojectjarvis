import { describe, it, expect } from "vitest";
import {
  ToolPlanValidator,
  ToolPlanParser,
  ToolDescriptionBuilder,
} from "../src/tool-planner.js";
import type { ITool, ToolPlan, RiskLevel } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Fake tools
// ---------------------------------------------------------------------------

function fakeTool(overrides: Partial<ITool> & { id: string }): ITool {
  return {
    name: overrides.id,
    description: `Tool ${overrides.id}`,
    category: "system",
    risk: "READ_ONLY" as RiskLevel,
    parameters: [],
    requiresApproval: false,
    requiredPermissions: ["read"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
    ...overrides,
  };
}

function toolWithRequiredParam(id: string, paramName: string): ITool {
  return fakeTool({
    id,
    parameters: [
      { name: paramName, type: "string", description: `The ${paramName}`, required: true },
    ],
    validate: (params) => params[paramName] !== undefined && typeof params[paramName] === "string",
  });
}

// ---------------------------------------------------------------------------
// ToolPlanValidator
// ---------------------------------------------------------------------------

describe("Phase 6.3: ToolPlanValidator", () => {
  const validator = new ToolPlanValidator();

  const webResearch = toolWithRequiredParam("web_research", "query");
  const echo = fakeTool({ id: "system.echo" });
  const disabled = fakeTool({ id: "disabled.tool", enabled: false });

  describe("valid plans", () => {
    it("validates a no-tools plan", () => {
      const plan: ToolPlan = { intent: "greet", requiresTools: false, steps: [] };
      const result = validator.validate(plan, []);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("validates a single-step plan", () => {
      const plan: ToolPlan = {
        intent: "search",
        requiresTools: true,
        steps: [{ tool: "web_research", params: { query: "hello" } }],
      };
      const result = validator.validate(plan, [webResearch]);
      expect(result.valid).toBe(true);
    });

    it("validates a multi-step plan with dependencies", () => {
      const plan: ToolPlan = {
        intent: "research and echo",
        requiresTools: true,
        steps: [
          { tool: "web_research", params: { query: "test" } },
          { tool: "system.echo", params: {}, dependsOn: 0 },
        ],
      };
      const result = validator.validate(plan, [webResearch, echo]);
      expect(result.valid).toBe(true);
    });
  });

  describe("invalid plans", () => {
    it("rejects plan requiring tools with no steps", () => {
      const plan: ToolPlan = { intent: "search", requiresTools: true, steps: [] };
      const result = validator.validate(plan, []);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("no steps");
    });

    it("rejects plan with requiresTools false but has steps", () => {
      const plan: ToolPlan = {
        intent: "test",
        requiresTools: false,
        steps: [{ tool: "system.echo", params: {} }],
      };
      const result = validator.validate(plan, [echo]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("requiresTools is false");
    });

    it("rejects unknown tool", () => {
      const plan: ToolPlan = {
        intent: "test",
        requiresTools: true,
        steps: [{ tool: "nonexistent", params: {} }],
      };
      const result = validator.validate(plan, [echo]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("not found in registry");
    });

    it("rejects disabled tool", () => {
      const plan: ToolPlan = {
        intent: "test",
        requiresTools: true,
        steps: [{ tool: "disabled.tool", params: {} }],
      };
      const result = validator.validate(plan, [disabled]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("disabled");
    });

    it("rejects invalid parameters", () => {
      const plan: ToolPlan = {
        intent: "test",
        requiresTools: true,
        steps: [{ tool: "web_research", params: {} }],
      };
      const result = validator.validate(plan, [webResearch]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("validation");
    });

    it("rejects dependsOn referencing future step", () => {
      const plan: ToolPlan = {
        intent: "test",
        requiresTools: true,
        steps: [
          { tool: "system.echo", params: {}, dependsOn: 1 },
          { tool: "system.echo", params: {} },
        ],
      };
      const result = validator.validate(plan, [echo]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("future or self");
    });

    it("rejects dependsOn referencing invalid step", () => {
      const plan: ToolPlan = {
        intent: "test",
        requiresTools: true,
        steps: [
          { tool: "system.echo", params: {}, dependsOn: -1 },
        ],
      };
      const result = validator.validate(plan, [echo]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("negative");
    });

    it("rejects circular dependencies", () => {
      const plan: ToolPlan = {
        intent: "test",
        requiresTools: true,
        steps: [
          { tool: "a", params: {}, dependsOn: 2 },
          { tool: "b", params: {}, dependsOn: 0 },
          { tool: "c", params: {}, dependsOn: 1 },
        ],
      };
      const result = validator.validate(plan, [
        fakeTool({ id: "a" }),
        fakeTool({ id: "b" }),
        fakeTool({ id: "c" }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toContain("future or self");
    });

    it("rejects duplicate tool in plan", () => {
      const plan: ToolPlan = {
        intent: "test",
        requiresTools: true,
        steps: [
          { tool: "system.echo", params: {} },
          { tool: "system.echo", params: {} },
        ],
      };
      const result = validator.validate(plan, [echo]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Duplicate");
    });
  });

  describe("topologicalSort", () => {
    it("sorts steps with dependencies", () => {
      const steps = [
        { tool: "a", params: {} },
        { tool: "b", params: {}, dependsOn: 0 },
      ];
      const sorted = validator.topologicalSort(steps);
      expect(sorted.map((s) => s.tool)).toEqual(["a", "b"]);
    });

    it("handles independent steps", () => {
      const steps = [
        { tool: "x", params: {} },
        { tool: "y", params: {} },
      ];
      const sorted = validator.topologicalSort(steps);
      expect(sorted).toHaveLength(2);
    });

    it("handles single step", () => {
      const sorted = validator.topologicalSort([{ tool: "only", params: {} }]);
      expect(sorted).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// ToolPlanParser
// ---------------------------------------------------------------------------

describe("Phase 6.3: ToolPlanParser", () => {
  const parser = new ToolPlanParser();

  it("parses JSON from markdown code block", () => {
    const input = 'Here is my plan:\n```json\n{"intent":"search","requiresTools":true,"steps":[{"tool":"web_research","params":{"query":"hello"}}]}\n```';
    const plan = parser.parse(input);
    expect(plan).not.toBeNull();
    expect(plan!.intent).toBe("search");
    expect(plan!.steps).toHaveLength(1);
  });

  it("parses bare JSON", () => {
    const input = '{"intent":"test","requiresTools":false,"steps":[]}';
    const plan = parser.parse(input);
    expect(plan).not.toBeNull();
    expect(plan!.requiresTools).toBe(false);
  });

  it("parses JSON embedded in text", () => {
    const input = 'I will use a tool. {"intent":"echo","requiresTools":true,"steps":[{"tool":"system.echo","params":{"message":"hi"}}]} Done.';
    const plan = parser.parse(input);
    expect(plan).not.toBeNull();
    expect(plan!.steps[0]!.tool).toBe("system.echo");
  });

  it("returns null for non-JSON text", () => {
    expect(parser.parse("Hello, I can help with that!")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parser.parse("{not valid json}")).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    expect(parser.parse('{"foo":"bar"}')).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parser.parse("")).toBeNull();
  });

  it("handles needsClarification", () => {
    const input = '{"intent":"clarify","requiresTools":false,"steps":[],"needsClarification":"What is your budget?"}';
    const plan = parser.parse(input);
    expect(plan!.needsClarification).toBe("What is your budget?");
  });

  it("defaults step params to empty object", () => {
    const input = '{"intent":"test","requiresTools":true,"steps":[{"tool":"echo"}]}';
    const plan = parser.parse(input);
    expect(plan!.steps[0]!.params).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// ToolDescriptionBuilder
// ---------------------------------------------------------------------------

describe("Phase 6.3: ToolDescriptionBuilder", () => {
  const builder = new ToolDescriptionBuilder();

  it("builds descriptions from tools", () => {
    const tools = [
      fakeTool({
        id: "echo",
        description: "Echo input",
        risk: "READ_ONLY",
        parameters: [
          { name: "message", type: "string", description: "The message", required: true },
        ],
      }),
    ];
    const descs = builder.buildDescriptions(tools);
    expect(descs).toHaveLength(1);
    expect(descs[0]!.name).toBe("echo");
    expect(descs[0]!.parameters.required).toEqual(["message"]);
  });

  it("excludes disabled tools", () => {
    const tools = [
      fakeTool({ id: "on" }),
      fakeTool({ id: "off", enabled: false }),
    ];
    expect(builder.buildDescriptions(tools)).toHaveLength(1);
  });

  it("formats for system prompt", () => {
    const tools = [
      fakeTool({
        id: "web_research",
        description: "Search the web",
        risk: "READ_ONLY",
        parameters: [
          { name: "query", type: "string", description: "Search query", required: true },
        ],
      }),
      fakeTool({
        id: "meta_create",
        description: "Create campaign",
        risk: "FINANCIAL",
        requiresApproval: true,
      }),
    ];
    const prompt = builder.formatForSystemPrompt(tools);
    expect(prompt).toContain("web_research");
    expect(prompt).toContain("meta_create");
    expect(prompt).toContain("risk: READ_ONLY");
    expect(prompt).toContain("risk: FINANCIAL");
    expect(prompt).toContain("approval required");
    expect(prompt).toContain("Required: query");
    expect(prompt).toContain("tool plan");
  });

  it("returns empty string for no tools", () => {
    expect(builder.formatForSystemPrompt([])).toBe("");
  });
});
