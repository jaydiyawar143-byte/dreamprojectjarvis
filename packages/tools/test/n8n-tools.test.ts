import { describe, it, expect } from "vitest";
import type {
  ToolContext,
  IN8nRepository,
  N8nWorkflowRecord,
  N8nExecutionRecord,
  N8nCallbackEvent,
  RecordCallbackResult,
} from "@jarvis/core";
import { N8nTriggerWorkflowTool, validateTriggerPayload } from "../src/tools/n8n-tools.js";
import { MockN8nProvider, mockKeyDeriver } from "../src/tools/n8n-mock.js";

const ctx = (userId = "user-1", traceId: string | undefined = "trace-1"): ToolContext =>
  ({ userId, traceId, role: "member" }) as unknown as ToolContext;

// ---------------------------------------------------------------------------
// In-memory repository enforcing the same constraints as the Prisma one
// ---------------------------------------------------------------------------

class MemoryN8nRepo implements IN8nRepository {
  workflows: N8nWorkflowRecord[] = [
    {
      id: "wf-1",
      userId: "user-1",
      name: "Daily report",
      webhookPath: "daily-report",
      isActive: true,
      createdAt: new Date(),
    },
    {
      id: "wf-2",
      userId: "user-2",
      name: "Other tenant workflow",
      webhookPath: "other",
      isActive: true,
      createdAt: new Date(),
    },
  ];
  executions: N8nExecutionRecord[] = [];
  private seq = 0;

  async findWorkflowForUser(userId: string, workflowId: string) {
    return (
      this.workflows.find((w) => w.id === workflowId && w.userId === userId && w.isActive) ?? null
    );
  }
  async listWorkflowsForUser(userId: string) {
    return this.workflows.filter((w) => w.userId === userId);
  }
  async beginExecution(input: {
    userId: string;
    workflowId: string;
    idempotencyKey: string;
    payloadHash: string;
    traceId: string;
  }) {
    // Mirrors the unique constraint on idempotency_key.
    const existing = this.executions.find((e) => e.idempotencyKey === input.idempotencyKey);
    if (existing) return { record: existing, created: false };

    const record: N8nExecutionRecord = {
      id: `exec-${++this.seq}`,
      userId: input.userId,
      workflowId: input.workflowId,
      idempotencyKey: input.idempotencyKey,
      remoteExecutionId: null,
      status: "TRIGGERED",
      payloadHash: input.payloadHash,
      callbackEventId: null,
      resultSummary: null,
      errorCode: null,
      traceId: input.traceId,
      triggeredAt: new Date(),
      completedAt: null,
    };
    this.executions.push(record);
    return { record, created: true };
  }
  async markTriggered(executionId: string, remoteExecutionId: string | null, summary: string | null) {
    const e = this.executions.find((x) => x.id === executionId);
    if (e) {
      e.remoteExecutionId = remoteExecutionId;
      e.resultSummary = summary;
    }
  }
  async markFailed(executionId: string, errorCode: string, message: string) {
    const e = this.executions.find((x) => x.id === executionId);
    if (e) {
      e.status = "FAILED";
      e.errorCode = errorCode;
      e.resultSummary = message;
      e.completedAt = new Date();
    }
  }
  async applyCallback(_event: N8nCallbackEvent): Promise<RecordCallbackResult> {
    return { applied: false, duplicate: false, notFound: true };
  }
  async listExecutionsForUser(userId: string) {
    return this.executions.filter((e) => e.userId === userId);
  }
  async findExecutionForUser(userId: string, executionId: string) {
    return this.executions.find((e) => e.id === executionId && e.userId === userId) ?? null;
  }
}

function makeTool(provider = new MockN8nProvider(), repo = new MemoryN8nRepo()) {
  return { tool: new N8nTriggerWorkflowTool(provider, repo, mockKeyDeriver), provider, repo };
}

describe("Sprint 5.4 — n8n trigger tool", () => {
  describe("payload validation", () => {
    it("accepts an object or nothing", () => {
      expect(validateTriggerPayload({ a: 1 })).toEqual({ a: 1 });
      expect(validateTriggerPayload(undefined)).toEqual({});
      expect(validateTriggerPayload(null)).toEqual({});
    });

    it.each([["array", []], ["string", "x"], ["number", 5]])("rejects %s", (_l, bad) => {
      expect(validateTriggerPayload(bad)).toBeNull();
    });

    it("rejects an oversized payload", () => {
      expect(validateTriggerPayload({ blob: "x".repeat(70_000) })).toBeNull();
    });

    it("rejects a circular structure rather than throwing", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(validateTriggerPayload(circular)).toBeNull();
    });
  });

  describe("approval boundary", () => {
    it("is EXTERNAL_SIDE_EFFECT and requires approval", () => {
      // An n8n workflow can do anything its author wired up, so this is the
      // broadest side effect in JARVIS and must be gated.
      const { tool } = makeTool();
      expect(tool.risk).toBe("EXTERNAL_SIDE_EFFECT");
      expect(tool.requiresApproval).toBe(true);
      expect(tool.requiredPermissions).toEqual(["read", "write"]);
      expect(tool.category).toBe("integration");
    });

    it("warns the approving human that effects are not undoable", () => {
      const { tool } = makeTool();
      expect(tool.description).toMatch(/approval/i);
      expect(tool.description).toMatch(/cannot be undone/i);
    });
  });

  describe("successful trigger", () => {
    it("triggers and records an execution", async () => {
      const { tool, provider, repo } = makeTool();
      const result = await tool.execute({ workflowId: "wf-1", payload: { x: 1 } }, ctx());

      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe("TRIGGERED");
      expect((result.data as any).remoteExecutionId).toBe("n8n-exec-1");
      expect(provider.triggered).toHaveLength(1);
      expect(repo.executions).toHaveLength(1);
    });

    it("resolves the webhook path server-side from the allow-list", async () => {
      // The caller never supplies a path or URL.
      const { tool, provider } = makeTool();
      await tool.execute({ workflowId: "wf-1" }, ctx());
      expect(provider.triggered[0].webhookPath).toBe("daily-report");
    });

    it("passes correlation ids so the workflow can call back", async () => {
      const { tool, provider, repo } = makeTool();
      await tool.execute({ workflowId: "wf-1" }, ctx());
      expect(provider.triggered[0].correlation.executionId).toBe(repo.executions[0].id);
      expect(provider.triggered[0].correlation.traceId).toBe("trace-1");
    });

    it("derives a traceId when the context has none, so the run stays auditable", async () => {
      const { tool, repo } = makeTool();
      // ToolContext.traceId is optional; a row without one would not be
      // correlatable in the audit log, so the tool must supply a fallback.
      const noTrace = { userId: "user-1", role: "member" } as unknown as ToolContext;
      await tool.execute({ workflowId: "wf-1" }, noTrace);
      expect(repo.executions[0].traceId).toMatch(/^n8n-user-1-/);
    });

    it("records the payload HASH, never the payload", async () => {
      const { tool, repo } = makeTool();
      await tool.execute({ workflowId: "wf-1", payload: { secret: "hunter2" } }, ctx());
      expect(repo.executions[0].payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(repo.executions[0])).not.toContain("hunter2");
    });
  });

  describe("idempotency", () => {
    it("does NOT re-trigger for an identical repeated request", async () => {
      const { tool, provider } = makeTool();
      const first = await tool.execute({ workflowId: "wf-1", payload: { x: 1 } }, ctx());
      const second = await tool.execute({ workflowId: "wf-1", payload: { x: 1 } }, ctx());

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect((second.data as any).idempotent).toBe(true);
      // The critical assertion: the workflow ran once.
      expect(provider.triggered).toHaveLength(1);
      expect((second.data as any).executionId).toBe((first.data as any).executionId);
    });

    it("DOES trigger again for a different payload", async () => {
      const { tool, provider } = makeTool();
      await tool.execute({ workflowId: "wf-1", payload: { x: 1 } }, ctx());
      await tool.execute({ workflowId: "wf-1", payload: { x: 2 } }, ctx());
      expect(provider.triggered).toHaveLength(2);
    });

    it("scopes idempotency per user", async () => {
      const repo = new MemoryN8nRepo();
      repo.workflows.push({
        id: "wf-shared",
        userId: "user-2",
        name: "Shared name",
        webhookPath: "shared",
        isActive: true,
        createdAt: new Date(),
      });
      const provider = new MockN8nProvider();
      const tool = new N8nTriggerWorkflowTool(provider, repo, mockKeyDeriver);

      await tool.execute({ workflowId: "wf-1", payload: { x: 1 } }, ctx("user-1"));
      await tool.execute({ workflowId: "wf-shared", payload: { x: 1 } }, ctx("user-2"));
      // Same payload, different tenants — both must run.
      expect(provider.triggered).toHaveLength(2);
    });
  });

  describe("tenant isolation and authorization", () => {
    it("REFUSES a workflow belonging to another user", async () => {
      const { tool, provider } = makeTool();
      const result = await tool.execute({ workflowId: "wf-2" }, ctx("user-1"));

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found or not available/i);
      expect(provider.triggered).toHaveLength(0);
    });

    it("uses the SAME message for unknown and unauthorized ids", async () => {
      // Otherwise the tool becomes a workflow-id oracle.
      const { tool } = makeTool();
      const unknown = await tool.execute({ workflowId: "wf-does-not-exist" }, ctx("user-1"));
      const foreign = await tool.execute({ workflowId: "wf-2" }, ctx("user-1"));
      expect(unknown.error).toBe(foreign.error);
    });

    it("refuses an inactive workflow", async () => {
      const { tool, repo, provider } = makeTool();
      repo.workflows[0].isActive = false;
      const result = await tool.execute({ workflowId: "wf-1" }, ctx("user-1"));
      expect(result.success).toBe(false);
      expect(provider.triggered).toHaveLength(0);
    });

    it("rejects a missing workflowId before touching the repository", async () => {
      const { tool, provider } = makeTool();
      expect((await tool.execute({}, ctx())).success).toBe(false);
      expect(provider.triggered).toHaveLength(0);
    });
  });

  describe("failure handling", () => {
    it("marks a pre-transmission failure as FAILED", async () => {
      const err = Object.assign(new Error("connection refused"), {
        classified: { code: "NETWORK_ERROR", sideEffectPossible: false },
      });
      const { tool, repo } = makeTool(new MockN8nProvider({ throwOnTrigger: err }));

      const result = await tool.execute({ workflowId: "wf-1" }, ctx());

      expect(result.success).toBe(false);
      expect(repo.executions[0].status).toBe("FAILED");
      expect(repo.executions[0].errorCode).toBe("NETWORK_ERROR");
    });

    it("leaves an AMBIGUOUS failure as TRIGGERED and warns the caller", async () => {
      // A transmitted request may have started the workflow. Marking it FAILED
      // would invite a retry that double-fires.
      const err = Object.assign(new Error("gateway timeout"), {
        classified: { code: "TOOL_TIMEOUT", sideEffectPossible: true },
      });
      const { tool, repo } = makeTool(new MockN8nProvider({ throwOnTrigger: err }));

      const result = await tool.execute({ workflowId: "wf-1" }, ctx());

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/may have started/i);
      expect(repo.executions[0].status).toBe("TRIGGERED");
      expect(repo.executions[0].completedAt).toBeNull();
    });

    it("still reports success when bookkeeping fails after the trigger", async () => {
      const { tool, repo, provider } = makeTool();
      repo.markTriggered = async () => {
        throw new Error("database down");
      };
      const result = await tool.execute({ workflowId: "wf-1" }, ctx());
      expect(result.success).toBe(true);
      expect(provider.triggered).toHaveLength(1);
    });

    it("honours a cancellation signal", async () => {
      const controller = new AbortController();
      const { tool } = makeTool(new MockN8nProvider({ delayMs: 5000 }));
      const context = { userId: "user-1", traceId: "t", signal: controller.signal } as ToolContext;

      const pending = tool.execute({ workflowId: "wf-1" }, context);
      controller.abort();
      const result = await pending;
      expect(result.success).toBe(false);
    });
  });

  describe("result hygiene", () => {
    it("never carries credential material or a webhook path", async () => {
      const { tool } = makeTool();
      const result = await tool.execute({ workflowId: "wf-1" }, ctx());
      const blob = JSON.stringify(result);
      for (const forbidden of ["apiKey", "api_key", "callbackSecret", "webhookPath", "daily-report"]) {
        expect(blob).not.toContain(forbidden);
      }
    });
  });
});
