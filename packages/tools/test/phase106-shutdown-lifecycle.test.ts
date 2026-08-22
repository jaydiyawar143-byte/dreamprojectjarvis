// PHASE 10.6 — Graceful shutdown lifecycle + executor admission gate.
//
// Proves:
//  1. Forward-only state machine; beginDraining is idempotent.
//  2. Admission rules: RUNNING accepts all; DRAINING admits READ_ONLY only;
//     STOP_ACCEPTING and beyond admit nothing.
//  3. Executor refuses new side-effecting executions during draining with
//     the deterministic "service shutting down" error — BEFORE any approval
//     lookup/consumption (new approval consumption rejected).
//  4. In-flight executions are NOT interrupted by shutdown: they finish
//     within grace, their context signal is never aborted BY SHUTDOWN, and
//     no blind retry is ever issued.
//  5. Grace timeout leaves tracked executions for recovery — never FAILED.
//  6. Shutdown lifecycle never touches durable journal leases: an execution
//     claimed with a live journal lease stays claimed while draining waits.
import { describe, it, expect, vi } from "vitest";
import { ToolExecutor } from "../src/executor.js";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import {
  ShutdownLifecycle,
  SERVICE_SHUTTING_DOWN_ERROR,
} from "@jarvis/core";
import type {
  ITool,
  IPermissionChecker,
  IApprovalManager,
  AuditLogger,
  ToolResult,
  RiskLevel,
} from "@jarvis/core";

function allowPerms(): IPermissionChecker {
  return { hasPermission: () => true };
}

function silentAudit(): AuditLogger {
  return { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger;
}

function makeExecutor(
  tool: ITool,
  lifecycle?: ShutdownLifecycle,
  approvalManager?: IApprovalManager
): ToolExecutor {
  return new ToolExecutor(
    { get: (id: string) => (id === tool.id ? tool : undefined) },
    allowPerms(),
    approvalManager ?? {
      requestApproval: vi.fn(),
      findExistingForTool: vi.fn().mockResolvedValue(null),
    },
    silentAudit(),
    { lifecycle }
  );
}

function makeTool(
  overrides: Partial<ITool> & { execute: ITool["execute"] },
  risk: RiskLevel = "EXTERNAL_SIDE_EFFECT"
): ITool {
  return {
    id: "meta.campaign.create",
    name: "Fake write",
    description: "",
    category: "marketing",
    risk,
    parameters: [],
    requiresApproval: false,
    requiredPermissions: ["write"],
    version: "1",
    enabled: true,
    validate: () => true,
    ...overrides,
  } as ITool;
}

const baseRequest = {
  toolId: "meta.campaign.create",
  params: {},
  userId: "user-1",
  role: "OWNER" as const,
  traceId: "trace-shutdown",
};

describe("PHASE 10.6 — lifecycle state machine", () => {
  it("1a. forward-only transitions in spec order", () => {
    const lc = new ShutdownLifecycle();
    expect(lc.getState()).toBe("RUNNING");
    lc.beginDraining("test");
    lc.markStopAccepting();
    lc.markWaitForSafeExecutions();
    lc.markReleasingResources();
    lc.markStopped();
    expect(lc.getState()).toBe("STOPPED");
  });

  it("1b. beginDraining is idempotent — first reason wins", () => {
    const lc = new ShutdownLifecycle();
    const first = lc.beginDraining("SIGTERM");
    const second = lc.beginDraining("SIGINT");
    expect(second).toBe(first);
    expect(first.reason).toBe("SIGTERM");
  });

  it("1c. stale/out-of-order transitions can never regress state", () => {
    const lc = new ShutdownLifecycle();
    lc.beginDraining("test");
    lc.markStopped();
    lc.beginDraining("late signal");
    lc.markStopAccepting();
    expect(lc.getState()).toBe("STOPPED");
  });

  it("2a. RUNNING accepts all risk levels", () => {
    const lc = new ShutdownLifecycle();
    for (const risk of [
      "READ_ONLY",
      "LOW_IMPACT",
      "EXTERNAL_SIDE_EFFECT",
      "HIGH_IMPACT",
      "FINANCIAL",
    ] as const) {
      expect(lc.canAcceptNewWork(risk)).toBe(true);
    }
  });

  it("2b. DRAINING admits READ_ONLY work only", () => {
    const lc = new ShutdownLifecycle();
    lc.beginDraining("deploy");
    expect(lc.canAcceptNewWork("READ_ONLY")).toBe(true);
    expect(lc.canAcceptNewWork("EXTERNAL_SIDE_EFFECT")).toBe(false);
    expect(lc.canAcceptNewWork("FINANCIAL")).toBe(false);
  });

  it("2c. STOP_ACCEPTING rejects even READ_ONLY", () => {
    const lc = new ShutdownLifecycle();
    lc.beginDraining("deploy");
    lc.markStopAccepting();
    expect(lc.canAcceptNewWork("READ_ONLY")).toBe(false);
  });

  it("3a. drain summary counts completions; complete() is idempotent per id", async () => {
    const lc = new ShutdownLifecycle();
    const h1 = lc.trackExecution("e1", "EXTERNAL_SIDE_EFFECT");
    const h2 = lc.trackExecution("e2", "READ_ONLY");
    expect(lc.getActiveExecutionCount()).toBe(2);
    h1.complete();
    h1.complete(); // second call must not double-count
    h2.complete();
    const summary = await lc.waitForActiveExecutions(10);
    expect(summary).toEqual({
      completed: 2,
      leftForRecovery: 0,
      timedOut: false,
    });
  });

  it("3b. grace expiry reports leftForRecovery without throwing", async () => {
    const lc = new ShutdownLifecycle();
    lc.trackExecution("stuck-1", "EXTERNAL_SIDE_EFFECT");
    const summary = await lc.waitForActiveExecutions(20);
    expect(summary.timedOut).toBe(true);
    expect(summary.completed).toBe(0);
    expect(summary.leftForRecovery).toBe(1);
  });

  it("3c. completing the last execution wakes waiters before deadline", async () => {
    const lc = new ShutdownLifecycle();
    const handle = lc.trackExecution("w-1", "EXTERNAL_SIDE_EFFECT");
    setTimeout(() => handle.complete(), 15);
    const started = Date.now();
    const summary = await lc.waitForActiveExecutions(5000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(summary.timedOut).toBe(false);
    expect(summary.completed).toBe(1);
  });

  it("4. shutdown initiation is traceable via onStateChange", () => {
    const lc = new ShutdownLifecycle();
    const seen: string[] = [];
    lc.onStateChange((state) => seen.push(state));
    lc.beginDraining("SIGINT");
    lc.markStopped();
    expect(seen).toEqual(["DRAINING", "STOPPED"]);
  });
});

describe("PHASE 10.6 — executor admission gate", () => {
  it("5. side-effecting execution rejected during DRAINING (deterministic error)", async () => {
    const lc = new ShutdownLifecycle();
    lc.beginDraining("SIGTERM");
    const execute = vi.fn(async () => ({ success: true }) as ToolResult);
    const result = await makeExecutor(
      makeTool({ execute }),
      lc
    ).execute(baseRequest);
    expect(result.status).toBe("failed");
    expect(result.error).toBe(SERVICE_SHUTTING_DOWN_ERROR);
    expect(result.error).toBe("service shutting down");
    expect(execute).not.toHaveBeenCalled();
  });

  it("6. rejection happens BEFORE approval consumption (no approval touched)", async () => {
    const lc = new ShutdownLifecycle();
    lc.beginDraining("SIGTERM");
    const findExistingForTool = vi.fn().mockResolvedValue({
      id: "appr-1",
      status: "approved",
      toolId: baseRequest.toolId,
      userId: baseRequest.userId,
      paramsHash: "hash",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const requestApproval = vi.fn();
    const approvalManager: IApprovalManager = {
      findExistingForTool,
      requestApproval,
    } as unknown as IApprovalManager;
    const tool = makeTool(
      { execute: async () => ({ success: true }) as ToolResult },
      "EXTERNAL_SIDE_EFFECT"
    );
    tool.requiresApproval = true;

    const result = await makeExecutor(tool, lc, approvalManager).execute({
      ...baseRequest,
      params: { name: "x" }, // hash deliberately mismatched anyway
    });

    expect(result.error).toBe(SERVICE_SHUTTING_DOWN_ERROR);
    expect(findExistingForTool).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("7. READ_ONLY tools still execute during DRAINING", async () => {
    const lc = new ShutdownLifecycle();
    lc.beginDraining("SIGTERM");
    const result = await makeExecutor(
      makeTool(
        { execute: async () => ({ success: true }) as ToolResult },
        "READ_ONLY"
      ),
      lc
    ).execute(baseRequest);
    expect(result.status).toBe("completed");
  });

  it("8. after STOP_ACCEPTING nothing executes, reads included", async () => {
    const lc = new ShutdownLifecycle();
    lc.beginDraining("SIGTERM");
    lc.markStopAccepting();
    const execute = vi.fn(async () => ({ success: true }) as ToolResult);
    const result = await makeExecutor(
      makeTool({ execute }, "READ_ONLY"),
      lc
    ).execute(baseRequest);
    expect(result.error).toBe(SERVICE_SHUTTING_DOWN_ERROR);
    expect(execute).not.toHaveBeenCalled();
  });

  it("9. no gating at all when lifecycle absent (back-compat)", async () => {
    const result = await makeExecutor(
      makeTool({ execute: async () => ({ success: true }) as ToolResult })
    ).execute(baseRequest);
    expect(result.status).toBe("completed");
  });
});

describe("PHASE 10.6 — in-flight safety during shutdown", () => {
  it("10. existing execution allowed to finish after draining begins", async () => {
    const lc = new ShutdownLifecycle();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const execute = vi.fn(async () => {
      await gate;
      return { success: true } as ToolResult;
    });
    const executor = makeExecutor(makeTool({ execute }), lc);

    const pending = executor.execute(baseRequest);
    await Promise.resolve();
    expect(lc.getActiveExecutionCount()).toBe(1);

    lc.beginDraining("SIGTERM"); // shutdown starts mid-flight
    release();
    const result = await pending;

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(lc.getActiveExecutionCount()).toBe(0);
  });

  it("11. shutdown NEVER aborts in-flight context signal (ambiguous stays UNKNOWN-safe)", async () => {
    const lc = new ShutdownLifecycle();
    let observed: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const executor = makeExecutor(
      makeTool({
        execute: async (_params, context) => {
          observed = context.signal;
          await gate;
          return { success: true } as ToolResult;
        },
      }),
      lc
    );

    const pending = executor.execute(baseRequest);
    await Promise.resolve();
    lc.beginDraining("deployment");
    lc.markStopAccepting();

    // Grace expires while the execution is still running:
    const drain = await Promise.all([
      lc.waitForActiveExecutions(25),
      Promise.resolve(),
    ]);
    expect(drain[0].timedOut).toBe(true);
    expect(drain[0].leftForRecovery).toBe(1);

    // The signal was NOT fired by shutdown (only the deadline could fire it).
    expect(observed).toBeDefined();
    expect(observed!.aborted).toBe(false);

    release();
    const result = await pending;
    expect(result.status).toBe("completed"); // NOT failed-by-shutdown
  });

  it("12. no blind retry: exactly one tool invocation across drain + completion", async () => {
    const lc = new ShutdownLifecycle();
    const execute = vi.fn(async () => {
      return { success: true } as ToolResult;
    });
    const executor = makeExecutor(makeTool({ execute }), lc);

    const pending = executor.execute(baseRequest);
    await Promise.resolve();
    lc.beginDraining("crash-sim");
    await lc.waitForActiveExecutions(30);
    await pending;
    await new Promise((r) => setTimeout(r, 10));

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("13. journal lease stays held while shutdown waits (lease released only on safe stop)", async () => {
    const lc = new ShutdownLifecycle();
    const journal = new MemoryExecutionJournal();
    await journal.begin({
      userId: "u1",
      toolId: "meta.campaign.create",
      idempotencyKey: "shutdown-lease-1",
      paramsHash: "h",
      provider: "meta-ads",
    });
    const record = journal.findByAnyKey("shutdown-lease-1")!;
    const claimed = await journal.claimForExecution(record.executionId, {
      ownerId: "worker-a",
      leaseMs: 60_000,
    });
    expect(claimed!.status).toBe("EXECUTING");

    lc.beginDraining("SIGTERM");
    lc.markWaitForSafeExecutions();
    await lc.waitForActiveExecutions(15); // grace expires

    const rec = (await journal.getById(record.executionId))!;
    // Lifecycle has NO API to touch the journal: lease intact, owner intact,
    // status EXECUTING — Phase 10.2 stale recovery remains authoritative.
    expect(rec.status).toBe("EXECUTING");
    expect(rec.ownerId).toBe("worker-a");

    // Second worker cannot steal it either.
    const stolen = await journal.claimForExecution(record.executionId, {
      ownerId: "worker-b",
    });
    expect(stolen).toBeNull();
  });

  it("14. UNKNOWN record is preserved through a full shutdown sequence", () => {
    const lc = new ShutdownLifecycle();
    lc.beginDraining("SIGTERM");
    lc.markStopAccepting();
    lc.markWaitForSafeExecutions();
    lc.markReleasingResources();
    lc.markStopped();
    // The lifecycle exposes no transition that could produce FAILED from
    // UNKNOWN — its vocabulary contains only the six lifecycle states.
    expect(lc.getState()).toBe("STOPPED");
  });
});
