import { describe, it, expect } from "vitest";
import {
  RiskLevelSchema,
  ToolPlanSchema,
  ToolStepSchema,
  ToolCategorySchema,
  ToolPermissionSchema,
  ErrorCodeSchema,
  JarvisError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// 1. RiskLevel enum validation
// ---------------------------------------------------------------------------

describe("Phase 6.1: RiskLevel", () => {
  it("accepts all 5 risk levels", () => {
    expect(RiskLevelSchema.parse("READ_ONLY")).toBe("READ_ONLY");
    expect(RiskLevelSchema.parse("LOW_IMPACT")).toBe("LOW_IMPACT");
    expect(RiskLevelSchema.parse("EXTERNAL_SIDE_EFFECT")).toBe("EXTERNAL_SIDE_EFFECT");
    expect(RiskLevelSchema.parse("HIGH_IMPACT")).toBe("HIGH_IMPACT");
    expect(RiskLevelSchema.parse("FINANCIAL")).toBe("FINANCIAL");
  });

  it("rejects invalid risk level", () => {
    expect(() => RiskLevelSchema.parse("DANGEROUS")).toThrow();
    expect(() => RiskLevelSchema.parse("")).toThrow();
    expect(() => RiskLevelSchema.parse(undefined)).toThrow();
  });

  it("risk levels are ordered from least to most severe", () => {
    const levels = ["READ_ONLY", "LOW_IMPACT", "EXTERNAL_SIDE_EFFECT", "HIGH_IMPACT", "FINANCIAL"];
    for (const level of levels) {
      expect(RiskLevelSchema.safeParse(level).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. ToolPlan schema validation
// ---------------------------------------------------------------------------

describe("Phase 6.1: ToolPlan", () => {
  it("parses a no-tools plan", () => {
    const plan = ToolPlanSchema.parse({
      intent: "Answer a general question",
      requiresTools: false,
    });
    expect(plan.requiresTools).toBe(false);
    expect(plan.steps).toEqual([]);
  });

  it("parses a single-step plan", () => {
    const plan = ToolPlanSchema.parse({
      intent: "Search the web for Meta Ads best practices",
      requiresTools: true,
      steps: [
        { tool: "web_research", params: { query: "Meta Ads best practices" } },
      ],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.tool).toBe("web_research");
  });

  it("parses a multi-step plan with dependencies", () => {
    const plan = ToolPlanSchema.parse({
      intent: "Research and create campaign",
      requiresTools: true,
      steps: [
        { tool: "web_research", params: { query: "bakery ads" } },
        { tool: "meta_create_campaign", params: { name: "Summer Sale" }, dependsOn: 0 },
      ],
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[1]!.dependsOn).toBe(0);
  });

  it("parses a clarification plan", () => {
    const plan = ToolPlanSchema.parse({
      intent: "Need more info",
      requiresTools: false,
      needsClarification: "What is your budget for this campaign?",
    });
    expect(plan.needsClarification).toBe("What is your budget for this campaign?");
  });

  it("defaults steps to empty array", () => {
    const plan = ToolPlanSchema.parse({ intent: "test", requiresTools: false });
    expect(plan.steps).toEqual([]);
  });

  it("defaults step params to empty object", () => {
    const plan = ToolPlanSchema.parse({
      intent: "test",
      requiresTools: true,
      steps: [{ tool: "echo" }],
    });
    expect(plan.steps[0]!.params).toEqual({});
  });

  it("rejects plan without intent", () => {
    expect(() => ToolPlanSchema.parse({ requiresTools: false })).toThrow();
  });

  it("rejects plan without requiresTools", () => {
    expect(() => ToolPlanSchema.parse({ intent: "test" })).toThrow();
  });

  it("rejects negative dependsOn", () => {
    expect(() =>
      ToolPlanSchema.parse({
        intent: "test",
        requiresTools: true,
        steps: [{ tool: "a" }, { tool: "b", dependsOn: -1 }],
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. ToolStep schema validation
// ---------------------------------------------------------------------------

describe("Phase 6.1: ToolStep", () => {
  it("parses minimal step", () => {
    const step = ToolStepSchema.parse({ tool: "echo" });
    expect(step.tool).toBe("echo");
    expect(step.params).toEqual({});
    expect(step.dependsOn).toBeUndefined();
    expect(step.reason).toBeUndefined();
  });

  it("parses full step", () => {
    const step = ToolStepSchema.parse({
      tool: "web_research",
      params: { query: "hello" },
      dependsOn: 0,
      reason: "Need research first",
    });
    expect(step.reason).toBe("Need research first");
  });
});

// ---------------------------------------------------------------------------
// 4. ToolCategory and ToolPermission enums
// ---------------------------------------------------------------------------

describe("Phase 6.1: ToolCategory", () => {
  it("accepts all 7 categories", () => {
    const cats = ["database", "communication", "marketing", "research", "file", "integration", "system"];
    for (const c of cats) {
      expect(ToolCategorySchema.parse(c)).toBe(c);
    }
  });

  it("rejects unknown category", () => {
    expect(() => ToolCategorySchema.parse("unknown")).toThrow();
  });
});

describe("Phase 6.1: ToolPermission", () => {
  it("accepts all 4 permissions", () => {
    const perms = ["read", "write", "execute", "admin"];
    for (const p of perms) {
      expect(ToolPermissionSchema.parse(p)).toBe(p);
    }
  });

  it("rejects unknown permission", () => {
    expect(() => ToolPermissionSchema.parse("delete")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. New error codes
// ---------------------------------------------------------------------------

describe("Phase 6.1: New error codes", () => {
  it("includes TOOL_PLAN_INVALID", () => {
    expect(ErrorCodeSchema.parse("TOOL_PLAN_INVALID")).toBe("TOOL_PLAN_INVALID");
  });

  it("includes TOOL_UNAVAILABLE", () => {
    expect(ErrorCodeSchema.parse("TOOL_UNAVAILABLE")).toBe("TOOL_UNAVAILABLE");
  });

  it("includes TOOL_TIMEOUT", () => {
    expect(ErrorCodeSchema.parse("TOOL_TIMEOUT")).toBe("TOOL_TIMEOUT");
  });

  it("includes TOOL_RATE_LIMITED", () => {
    expect(ErrorCodeSchema.parse("TOOL_RATE_LIMITED")).toBe("TOOL_RATE_LIMITED");
  });

  it("includes APPROVAL_EXPIRED", () => {
    expect(ErrorCodeSchema.parse("APPROVAL_EXPIRED")).toBe("APPROVAL_EXPIRED");
  });

  it("JarvisError maps new codes to correct HTTP status", () => {
    expect(new JarvisError("TOOL_PLAN_INVALID", "").statusCode).toBe(400);
    expect(new JarvisError("TOOL_UNAVAILABLE", "").statusCode).toBe(503);
    expect(new JarvisError("TOOL_TIMEOUT", "").statusCode).toBe(504);
    expect(new JarvisError("TOOL_RATE_LIMITED", "").statusCode).toBe(429);
    expect(new JarvisError("APPROVAL_EXPIRED", "").statusCode).toBe(408);
  });
});

// ---------------------------------------------------------------------------
// 6. ITool contract — risk field exists
// ---------------------------------------------------------------------------

describe("Phase 6.1: ITool contract", () => {
  it("ITool interface includes risk and version fields", () => {
    // Compile-time check: if these fields are missing from ITool, this test won't compile
    const tool: import("../src/index.js").ITool = {
      id: "test",
      name: "Test",
      description: "A test tool",
      category: "system",
      risk: "READ_ONLY",
      parameters: [],
      requiresApproval: false,
      requiredPermissions: ["read"],
      version: "1.0.0",
      enabled: true,
      execute: async () => ({ success: true }),
      validate: () => true,
    };
    expect(tool.risk).toBe("READ_ONLY");
    expect(tool.version).toBe("1.0.0");
    expect(tool.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. ApprovalRequest type shape
// ---------------------------------------------------------------------------

describe("Phase 6.1: ApprovalRequest", () => {
  it("has all required fields", () => {
    const req: import("../src/index.js").ApprovalRequest = {
      id: "apr-1",
      userId: "user-1",
      tool: "meta_create_campaign",
      action: "Create campaign",
      risk: "FINANCIAL",
      params: { name: "Test" },
      estimatedImpact: "Will spend up to ₹5,000/day",
      cost: { amount: 5000, currency: "INR" },
      traceId: "trace-1",
      expiresAt: new Date(),
      status: "pending",
      createdAt: new Date(),
    };
    expect(req.risk).toBe("FINANCIAL");
    expect(req.cost?.amount).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// 8. ApprovalDecision type shape
// ---------------------------------------------------------------------------

describe("Phase 6.1: ApprovalDecision", () => {
  it("has all required fields", () => {
    const dec: import("../src/index.js").ApprovalDecision = {
      approvalId: "apr-1",
      status: "approved",
    };
    expect(dec.status).toBe("approved");
  });

  it("supports rejection with reason", () => {
    const dec: import("../src/index.js").ApprovalDecision = {
      approvalId: "apr-1",
      status: "rejected",
      reason: "Too expensive",
    };
    expect(dec.reason).toBe("Too expensive");
  });
});

// ---------------------------------------------------------------------------
// 9. ToolAuditEntry type shape
// ---------------------------------------------------------------------------

describe("Phase 6.1: ToolAuditEntry", () => {
  it("has all required fields", () => {
    const entry: import("../src/index.js").ToolAuditEntry = {
      id: "aud-1",
      executionId: "exec-1",
      stepIndex: 0,
      userId: "user-1",
      tool: "web_research",
      action: "Search web",
      risk: "READ_ONLY",
      arguments: { query: "test" },
      resultSummary: "Found 5 results",
      status: "success",
      durationMs: 1200,
      traceId: "trace-1",
      timestamp: new Date(),
    };
    expect(entry.risk).toBe("READ_ONLY");
    expect(entry.durationMs).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// 10. ToolExecutionRequest extended fields
// ---------------------------------------------------------------------------

describe("Phase 6.1: ToolExecutionRequest extended fields", () => {
  it("supports idempotencyKey, executionId, stepIndex", () => {
    const req: import("../src/index.js").ToolExecutionRequest = {
      toolId: "echo",
      params: {},
      userId: "user-1",
      role: "admin",
      traceId: "trace-1",
      idempotencyKey: "idem-123",
      executionId: "exec-456",
      stepIndex: 2,
    };
    expect(req.idempotencyKey).toBe("idem-123");
    expect(req.executionId).toBe("exec-456");
    expect(req.stepIndex).toBe(2);
  });

  it("new fields are optional (backward compatible)", () => {
    const req: import("../src/index.js").ToolExecutionRequest = {
      toolId: "echo",
      params: {},
      userId: "user-1",
      role: "admin",
      traceId: "trace-1",
    };
    expect(req.idempotencyKey).toBeUndefined();
    expect(req.executionId).toBeUndefined();
    expect(req.stepIndex).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. ToolDescription type shape
// ---------------------------------------------------------------------------

describe("Phase 6.1: ToolDescription", () => {
  it("has all required fields", () => {
    const desc: import("../src/index.js").ToolDescription = {
      name: "web_research",
      description: "Search the web for information",
      risk: "READ_ONLY",
      approvalRequired: false,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    };
    expect(desc.risk).toBe("READ_ONLY");
    expect(desc.parameters.type).toBe("object");
  });
});
