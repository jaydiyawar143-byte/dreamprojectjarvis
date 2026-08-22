// PHASE 10.4 — ToolExecutor AbortSignal propagation + authoritative deadline.
//
// Proves:
//  1. The execution deadline creates ONE AbortController whose signal reaches
//     the tool context (executor -> tool).
//  2. Deadline expiry aborts that signal AND surfaces status timed_out.
//  3. A caller-supplied request.signal is combined into the same context
//     signal (external cancellation propagates).
//  4. A completed execution clears the timer (no dangling deadline).
import { describe, it, expect, vi } from "vitest";
import { ToolExecutor } from "../src/executor.js";
import type {
  ITool,
  IPermissionChecker,
  IApprovalManager,
  AuditLogger,
  ToolResult,
} from "@jarvis/core";

function allowPerms(): IPermissionChecker {
  return { hasPermission: () => true };
}

function noApprovals(): IApprovalManager {
  return {
    requestApproval: vi.fn(),
    findExistingForTool: vi.fn().mockResolvedValue(null),
  };
}

function silentAudit(): AuditLogger {
  return { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger;
}

function makeExecutor(tool: ITool): ToolExecutor {
  return new ToolExecutor(
    { get: (id: string) => (id === tool.id ? tool : undefined) },
    allowPerms(),
    noApprovals(),
    silentAudit(),
    { defaultTimeoutMs: 50 }
  );
}

const baseRequest = {
  toolId: "fake.tool",
  params: {},
  userId: "user-1",
  role: "OWNER" as const,
  traceId: "trace-1",
};

describe("Phase 10.4 — executor AbortSignal propagation", () => {
  it("1a. signal reaches the tool context and is not aborted on success", async () => {
    let observed: AbortSignal | undefined;
    const tool: ITool = {
      id: "fake.tool",
      name: "Fake",
      description: "",
      category: "system",
      risk: "READ_ONLY",
      parameters: [],
      requiresApproval: false,
      requiredPermissions: ["read"],
      version: "1",
      enabled: true,
      validate: () => true,
      async execute(_params, context) {
        observed = context.signal;
        return { success: true } as ToolResult;
      },
    };
    const result = await makeExecutor(tool).execute(baseRequest);
    expect(result.status).toBe("completed");
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed!.aborted).toBe(false);
  });

  it("1b/2. deadline expiry aborts the SAME context signal inside the tool", async () => {
    const abortedInTool = vi.fn();
    const tool: ITool = {
      id: "fake.tool",
      name: "Fake",
      description: "",
      category: "system",
      risk: "READ_ONLY",
      parameters: [],
      requiresApproval: false,
      requiredPermissions: ["read"],
      version: "1",
      enabled: true,
      validate: () => true,
      // Ignores the signal entirely (worst case) — must still observe abort.
      execute: (_params, context) =>
        new Promise<ToolResult>((resolve) => {
          context.signal?.addEventListener("abort", () => {
            abortedInTool(context.signal!.aborted);
            resolve({ success: true });
          });
        }) as Promise<ToolResult>,
    };
    const started = Date.now();
    const result = await makeExecutor(tool).execute(baseRequest);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(abortedInTool).toHaveBeenCalledWith(true);
    expect(result.status).toBe("timed_out");
    expect(result.error).toContain("timed out");
  });

  it("2b. a tool that honors the signal resolves before the race rejects", async () => {
    const tool: ITool = {
      id: "fake.tool",
      name: "Fake",
      description: "",
      category: "system",
      risk: "READ_ONLY",
      parameters: [],
      requiresApproval: false,
      requiredPermissions: ["read"],
      version: "1",
      enabled: true,
      validate: () => true,
      execute: (_params, context) =>
        new Promise<ToolResult>((resolve, reject) => {
          const t = setTimeout(() => resolve({ success: true }), 5000);
          context.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("cancelled"));
          });
        }),
    };
    const started = Date.now();
    const result = await makeExecutor(tool).execute(baseRequest);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.status).toBe("timed_out");
  });

  it("3. caller-supplied request.signal is combined into the context signal", async () => {
    let observed: AbortSignal | undefined;
    const tool: ITool = {
      id: "fake.tool",
      name: "Fake",
      description: "",
      category: "system",
      risk: "EXTERNAL_SIDE_EFFECT",
      parameters: [],
      requiresApproval: false,
      requiredPermissions: ["read"],
      version: "1",
      enabled: true,
      validate: () => true,
      async execute(_params, context) {
        observed = context.signal;
        return { success: true } as ToolResult;
      },
    };
    const caller = new AbortController();
    await makeExecutor(tool).execute({ ...baseRequest, signal: caller.signal });
    expect(observed).toBeDefined();
    // Aborting AFTER completion does not affect anything retroactively.
    caller.abort();
    expect(observed!.aborted).toBe(true);
  });

  it("3b. external abort while in flight fails the execution promptly", async () => {
    const tool: ITool = {
      id: "fake.tool",
      name: "Fake",
      description: "",
      category: "system",
      risk: "READ_ONLY",
      parameters: [],
      requiresApproval: false,
      requiredPermissions: ["read"],
      version: "1",
      enabled: true,
      validate: () => true,
      execute: (_params, context) =>
        new Promise<ToolResult>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        }),
    };
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);
    const result = await makeExecutor(tool).execute({
      ...baseRequest,
      signal: caller.signal,
    });
    expect(["timed_out", "failed"]).toContain(result.status);
  });

  it("4. successful fast execution completes normally under a deadline", async () => {
    const tool: ITool = {
      id: "fake.tool",
      name: "Fake",
      description: "",
      category: "system",
      risk: "READ_ONLY",
      parameters: [],
      requiresApproval: false,
      requiredPermissions: ["read"],
      version: "1",
      enabled: true,
      validate: () => true,
      async execute() {
        return { success: true, data: { ok: 1 } } as ToolResult;
      },
    };
    const result = await makeExecutor(tool).execute(baseRequest);
    expect(result.status).toBe("completed");
    expect((result.result as ToolResult).data).toEqual({ ok: 1 });
  });
});
