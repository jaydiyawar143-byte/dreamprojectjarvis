import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../src/registry.js";
import { SystemEchoTool } from "../src/tools/system-echo.js";
import type { ITool, RiskLevel } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Fake tools for testing
// ---------------------------------------------------------------------------

function fakeTool(overrides: Partial<ITool> & { id: string }): ITool {
  return {
    name: overrides.id,
    description: `Fake tool ${overrides.id}`,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 6.2: ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // --- Basic CRUD ---

  describe("register / unregister / get", () => {
    it("registers and retrieves a tool", () => {
      const tool = fakeTool({ id: "tool-a" });
      registry.register(tool);
      expect(registry.get("tool-a")).toBe(tool);
    });

    it("throws on duplicate registration", () => {
      registry.register(fakeTool({ id: "dup" }));
      expect(() => registry.register(fakeTool({ id: "dup" }))).toThrow('already registered');
    });

    it("unregisters a tool", () => {
      registry.register(fakeTool({ id: "removable" }));
      registry.unregister("removable");
      expect(registry.get("removable")).toBeUndefined();
    });

    it("unregister is idempotent", () => {
      registry.unregister("nonexistent");
    });

    it("returns all registered tools", () => {
      registry.register(fakeTool({ id: "a" }));
      registry.register(fakeTool({ id: "b" }));
      expect(registry.getAll()).toHaveLength(2);
    });

    it("count returns correct count", () => {
      expect(registry.count()).toBe(0);
      registry.register(fakeTool({ id: "a" }));
      expect(registry.count()).toBe(1);
    });
  });

  // --- Filtering ---

  describe("list / filter", () => {
    beforeEach(() => {
      registry.register(fakeTool({ id: "ro", risk: "READ_ONLY", category: "research" }));
      registry.register(fakeTool({ id: "li", risk: "LOW_IMPACT", category: "file" }));
      registry.register(fakeTool({ id: "hi", risk: "HIGH_IMPACT", category: "marketing", requiresApproval: true }));
      registry.register(fakeTool({ id: "fi", risk: "FINANCIAL", category: "marketing", requiresApproval: true }));
      registry.register(fakeTool({ id: "off", enabled: false, category: "integration", risk: "EXTERNAL_SIDE_EFFECT" }));
    });

    it("filters by category", () => {
      const results = registry.list({ category: "marketing" });
      expect(results).toHaveLength(2);
    });

    it("filters by risk", () => {
      const results = registry.list({ risk: "FINANCIAL" });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("fi");
    });

    it("filters by enabled", () => {
      const results = registry.list({ enabled: false });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("off");
    });

    it("filters by requiresApproval", () => {
      const results = registry.list({ requiresApproval: true });
      expect(results).toHaveLength(2);
    });

    it("combines filters", () => {
      const results = registry.list({ category: "marketing", requiresApproval: true });
      expect(results).toHaveLength(2);
    });

    it("getEnabled excludes disabled tools", () => {
      expect(registry.getEnabled()).toHaveLength(4);
    });

    it("getByRisk filters correctly", () => {
      expect(registry.getByRisk("READ_ONLY")).toHaveLength(1);
      expect(registry.getByRisk("HIGH_IMPACT")).toHaveLength(1);
    });

    it("getByCategory filters correctly", () => {
      expect(registry.getByCategory("marketing")).toHaveLength(2);
      expect(registry.getByCategory("system")).toHaveLength(0);
    });

    it("getRequiringApproval returns only approval tools", () => {
      expect(registry.getRequiringApproval()).toHaveLength(2);
    });
  });

  // --- Health ---

  describe("health", () => {
    it("default health is healthy", async () => {
      registry.register(fakeTool({ id: "healthy" }));
      const health = await registry.getHealth("healthy");
      expect(health.healthy).toBe(true);
    });

    it("unregistered tool has unhealthy health", async () => {
      const health = await registry.getHealth("nonexistent");
      expect(health.healthy).toBe(false);
    });

    it("custom health check is used", async () => {
      let healthy = true;
      registry.register(fakeTool({ id: "custom" }), async () => healthy);

      expect((await registry.getHealth("custom")).healthy).toBe(true);
      healthy = false;
      expect((await registry.getHealth("custom")).healthy).toBe(false);
    });

    it("health check throwing marks tool unhealthy", async () => {
      registry.register(fakeTool({ id: "crasher" }), async () => {
        throw new Error("check failed");
      });
      const health = await registry.getHealth("crasher");
      expect(health.healthy).toBe(false);
      expect(health.error).toBe("check failed");
    });

    it("runHealthChecks checks all tools", async () => {
      registry.register(fakeTool({ id: "a" }));
      registry.register(fakeTool({ id: "b" }));
      const results = await registry.runHealthChecks();
      expect(results.size).toBe(2);
    });
  });

  // --- Availability ---

  describe("isAvailable", () => {
    it("returns true for registered enabled healthy tool", async () => {
      registry.register(fakeTool({ id: "ok" }));
      expect(await registry.isAvailable("ok", "user-1", "admin")).toBe(true);
    });

    it("returns false for unregistered tool", async () => {
      expect(await registry.isAvailable("ghost", "user-1", "admin")).toBe(false);
    });

    it("returns false for disabled tool", async () => {
      registry.register(fakeTool({ id: "disabled", enabled: false }));
      expect(await registry.isAvailable("disabled", "user-1", "admin")).toBe(false);
    });

    it("returns false for unhealthy tool", async () => {
      registry.register(fakeTool({ id: "sick" }), async () => false);
      expect(await registry.isAvailable("sick", "user-1", "admin")).toBe(false);
    });
  });

  // --- Tool Descriptions (for model context) ---

  describe("getToolDescriptions", () => {
    it("generates descriptions for all enabled tools", () => {
      registry.register(fakeTool({
        id: "echo",
        description: "Echo input",
        risk: "READ_ONLY",
        requiresApproval: false,
        parameters: [
          { name: "message", type: "string", description: "The message", required: true },
        ],
      }));

      const descs = registry.getToolDescriptions("user-1", "admin");
      expect(descs).toHaveLength(1);
      expect(descs[0]!.name).toBe("echo");
      expect(descs[0]!.description).toBe("Echo input");
      expect(descs[0]!.risk).toBe("READ_ONLY");
      expect(descs[0]!.approvalRequired).toBe(false);
      expect(descs[0]!.parameters.required).toEqual(["message"]);
      expect(descs[0]!.parameters.properties.message.type).toBe("string");
    });

    it("excludes disabled tools", () => {
      registry.register(fakeTool({ id: "on" }));
      registry.register(fakeTool({ id: "off", enabled: false }));

      const descs = registry.getToolDescriptions("user-1", "admin");
      expect(descs).toHaveLength(1);
      expect(descs[0]!.name).toBe("on");
    });

    it("returns empty array for empty registry", () => {
      expect(registry.getToolDescriptions("user-1", "admin")).toEqual([]);
    });
  });

  // --- SystemEchoTool integration ---

  describe("SystemEchoTool in registry", () => {
    it("registers and works", async () => {
      registry.register(new SystemEchoTool());
      const tool = registry.get("system.echo");
      expect(tool).toBeDefined();
      expect(tool!.risk).toBe("READ_ONLY");
      expect(tool!.version).toBe("1.0.0");

      const result = await tool!.execute({ message: "hello" }, { userId: "user-1" });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ message: "hello" });
    });
  });
});
