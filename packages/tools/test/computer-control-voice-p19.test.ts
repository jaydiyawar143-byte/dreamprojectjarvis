// ---------------------------------------------------------------------------
// Phase 19, Stage 19.1 — the executor's half of the computer-control policy.
//
// A spoken turn is refused a sensitive browser or desktop action BEFORE the
// tool runs, under the registry id, whatever the caller's role. A read-only
// browser action still runs spoken, and a spoken turn never spends an approval
// for a browser write even when a matching approved approval exists.
//
// Nothing here starts a browser or a desktop agent; the tools are probes and
// the approval store is a stand-in.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_TOOL_IDS,
  COMPUTER_CONTROL_VOICE_REFUSED_TOOLS,
  VOICE_REFUSED_TOOLS,
  VOICE_TOOL_REFUSED_CODE,
  computeParamsHash,
  type Approval,
  type AuditLogger,
  type IApprovalManager,
  type IPermissionChecker,
  type ITool,
  type Role,
} from "@jarvis/core";
import { ToolExecutor } from "../src/executor.js";

const allowAll: IPermissionChecker = { hasPermission: () => true };
const audit = { log: async () => undefined } as unknown as AuditLogger;

function probe(id: string, requiresApproval = false): ITool {
  return {
    id,
    name: id,
    description: id,
    category: "system",
    risk: requiresApproval ? "LOW_IMPACT" : "READ_ONLY",
    parameters: [],
    requiresApproval,
    requiredPermissions: requiresApproval ? ["read", "write"] : ["read"],
    version: "1.0.0",
    enabled: true,
    validate: () => true,
    execute: vi.fn(async () => ({ success: true as const })),
  };
}

function executorFor(tool: ITool, approvals?: IApprovalManager): ToolExecutor {
  return new ToolExecutor(
    { get: (id: string) => (id === tool.id ? tool : undefined) },
    allowAll,
    approvals ?? ({} as IApprovalManager),
    audit
  );
}

function run(executor: ToolExecutor, toolId: string, inputMode?: "voice" | "text") {
  return executor.execute({
    toolId,
    params: {},
    userId: "owner-1",
    role: "owner" as Role,
    traceId: "trace-1",
    ...(inputMode ? { inputMode } : {}),
  });
}

function approvedFor(toolId: string, params: Record<string, unknown>): Approval {
  return {
    id: "apr-browser-1",
    userId: "owner-1",
    toolId,
    action: "execute",
    params,
    paramsHash: computeParamsHash(params),
    status: "approved",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

describe("Phase 19.1 — a spoken turn cannot start a sensitive computer action", () => {
  const sensitive = Object.keys(COMPUTER_CONTROL_VOICE_REFUSED_TOOLS);

  it.each(sensitive)("refuses %s before the tool runs", async (toolId) => {
    const tool = probe(toolId);
    const execute = vi.mocked(tool.execute);
    const refused = await run(executorFor(tool), toolId, "voice");

    expect(refused).toMatchObject({
      status: "permission_denied",
      error: VOICE_REFUSED_TOOLS[toolId],
      result: { success: false, metadata: { code: VOICE_TOOL_REFUSED_CODE, status: 403, toolId } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("lets the same sensitive action run typed, and read-only browser actions run spoken", async () => {
    const typed = probe(BROWSER_TOOL_IDS.submit);
    expect((await run(executorFor(typed), BROWSER_TOOL_IDS.submit, "text")).status).toBe(
      "completed"
    );
    expect(vi.mocked(typed.execute)).toHaveBeenCalledTimes(1);

    for (const readOnly of [
      BROWSER_TOOL_IDS.navigate,
      BROWSER_TOOL_IDS.inspect,
      BROWSER_TOOL_IDS.extract,
      BROWSER_TOOL_IDS.screenshot,
    ]) {
      const tool = probe(readOnly);
      expect((await run(executorFor(tool), readOnly, "voice")).status).toBe("completed");
      expect(vi.mocked(tool.execute)).toHaveBeenCalledTimes(1);
    }
  });

  it("still lets a desktop session be ended by voice", async () => {
    const tool = probe("desktop.session.end");
    expect((await run(executorFor(tool), "desktop.session.end", "voice")).status).toBe("completed");
    expect(vi.mocked(tool.execute)).toHaveBeenCalledTimes(1);
  });

  it("never spends an approval for a browser write on a spoken turn", async () => {
    const tool = probe(BROWSER_TOOL_IDS.submit, true);
    const params = { url: "https://example.com/", selector: "#submit" };
    const approvals: IApprovalManager = {
      requestApproval: vi.fn(),
      findExistingForTool: vi.fn(async () => approvedFor(BROWSER_TOOL_IDS.submit, params)),
      findApprovalsForTool: vi.fn(async () => [approvedFor(BROWSER_TOOL_IDS.submit, params)]),
    };
    const executor = executorFor(tool, approvals);

    const refused = await executor.execute({
      toolId: BROWSER_TOOL_IDS.submit,
      params,
      userId: "owner-1",
      role: "owner" as Role,
      traceId: "trace-1",
      approvalId: "apr-browser-1",
      inputMode: "voice",
    });

    // The sensitive-action list refuses this turn even before the executor
    // reaches the approval. What matters is that the refusal happens first and
    // the approved row is neither run nor spent.
    expect(refused).toMatchObject({
      status: "permission_denied",
      error: VOICE_REFUSED_TOOLS[BROWSER_TOOL_IDS.submit],
    });
    expect(refused.approvalId).toBeUndefined();
    expect(vi.mocked(tool.execute)).not.toHaveBeenCalled();
    expect(approvals.requestApproval).not.toHaveBeenCalled();
  });
});
