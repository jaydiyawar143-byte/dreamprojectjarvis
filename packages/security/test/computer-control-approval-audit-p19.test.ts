// ---------------------------------------------------------------------------
// Phase 19.1 — the second audit writer.
//
// `ToolApprovalService` writes straight to the audit repository, not through
// `AuditLogger`. These tests drive the service itself — its permission
// refusal, its approval request and `recordExecution` — and read what reached
// the repository, so a browser action's typed text, submitted values, secrets
// or cookies can be shown never to arrive there by any of its paths, while the
// metadata an auditor needs (action, site, field names and counts, outcome,
// user) does.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { Approval, AuditEntry, IApprovalRepository, IAuditRepository, IPermissionChecker, ITool } from "@jarvis/core";
import { ToolApprovalService } from "../src/tool-approval.js";

const SECRETS = ["hunter2-TYPED", "Summer2026!", "sk-live-abcdefghijklmnopqrstuv", "session=COOKIE-VALUE", "Bearer abc.def.ghijklmnopqrstuvwxyz"];

function tool(id: string, overrides: Partial<ITool> = {}): ITool {
  return {
    id,
    name: id,
    description: `Tool ${id}`,
    category: "research",
    risk: "LOW_IMPACT",
    parameters: [],
    requiresApproval: true,
    requiredPermissions: ["read", "write"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
    ...overrides,
  };
}

function harness(allow: boolean) {
  const rows: Array<Omit<AuditEntry, "id" | "timestamp">> = [];
  const audit: IAuditRepository = {
    create: vi.fn(async (entry) => {
      rows.push(entry);
      return { ...entry, id: `audit-${rows.length}`, timestamp: new Date().toISOString() } as AuditEntry;
    }),
    query: vi.fn(async () => []),
  } as unknown as IAuditRepository;
  let seq = 0;
  const approvals: IApprovalRepository = {
    create: vi.fn(async (data) => ({ ...data, id: `ap-${++seq}`, status: "pending", createdAt: new Date().toISOString() }) as Approval),
    findById: vi.fn(async () => null),
    updateStatus: vi.fn(async () => null),
    findPending: vi.fn(async () => []),
    findExistingForTool: vi.fn(async () => null),
  } as unknown as IApprovalRepository;
  const permissions: IPermissionChecker = { hasPermission: () => allow };
  const service = new ToolApprovalService(approvals, audit, permissions, { autoApproveReadOnly: true });
  return { service, rows, consoleSpy: vi.spyOn(console, "log").mockImplementation(() => undefined) };
}

const request = { userId: "user-1", role: "member" as const, traceId: "trace-1", executionId: "exec-1", stepIndex: 0 };

const TYPE = { url: "https://shop.example/login?next=%2Fcart", selector: "#password", text: "hunter2-TYPED" };
const SUBMIT = {
  url: "https://shop.example/checkout",
  selector: "#pay",
  fields: { "#card": "Summer2026!", "#note": "sk-live-abcdefghijklmnopqrstuv", "#cookie": "session=COOKIE-VALUE" },
};

const noSecret = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
};

describe("ToolApprovalService's own audit rows hold only the value-free projection", () => {
  it("on a permission refusal", async () => {
    const { service, rows, consoleSpy } = harness(false);
    const check = await service.checkPreExecution(tool("browser.type"), TYPE, request);
    expect(check).toMatchObject({ allowed: false, requiresApproval: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolId: "browser.type", userId: "user-1", result: "rejected" });
    expect(rows[0]!.parameters).toMatchObject({ action: "browser.type", targetResource: "https://shop.example" });
    noSecret(rows);
    noSecret(consoleSpy.mock.calls);
    consoleSpy.mockRestore();
  });

  it("on an approval request — the path that persisted typed text before", async () => {
    const { service, rows } = harness(true);
    const check = await service.checkPreExecution(tool("browser.submit", { risk: "EXTERNAL_SIDE_EFFECT" }), SUBMIT, request);
    expect(check).toMatchObject({ allowed: false, requiresApproval: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolId: "browser.submit", result: "pending" });
    const parameters = rows[0]!.parameters as Record<string, unknown>;
    expect(parameters.action).toBe("browser.submit");
    expect(parameters.targetResource).toBe("https://shop.example");
    // Field NAMES and counts may be recorded; their values never are.
    expect(JSON.stringify(parameters)).toMatch(/card|3 field/);
    noSecret(rows);
  });

  it("on recordExecution, including a secret inside its error", async () => {
    const { service, rows } = harness(true);
    await service.recordExecution({
      executionId: "exec-1",
      stepIndex: 0,
      userId: "user-1",
      tool: "browser.submit",
      action: "Fill And Submit Form",
      risk: "EXTERNAL_SIDE_EFFECT",
      arguments: SUBMIT,
      traceId: "trace-1",
      timestamp: new Date(),
      status: "failure",
      durationMs: 5,
      error: { code: "TOOL_EXECUTION_FAILED", message: "upstream said Bearer abc.def.ghijklmnopqrstuvwxyz" },
    } as never);
    expect(rows[0]).toMatchObject({ toolId: "browser.submit", result: "failure" });
    expect((rows[0]!.metadata as Record<string, unknown>).error).toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
    noSecret(rows);
  });

  it("records an invalid browser request as refused, with its code and nothing it carried", async () => {
    const { service, rows } = harness(false);
    await service.checkPreExecution(tool("browser.type"), { ...TYPE, cdp: "Runtime.evaluate", script: "steal()" }, request);
    expect(rows[0]!.parameters).toEqual({ action: "browser.type", refused: true, reason: "INVALID_REQUEST" });
    noSecret(rows);
  });

  it("fails closed when the projection itself throws", async () => {
    const { service, rows } = harness(false);
    const hostile: Record<string, unknown> = { url: "https://shop.example/", selector: "#q" };
    Object.defineProperty(hostile, "text", {
      enumerable: true,
      get() {
        throw new Error("hunter2-TYPED");
      },
    });
    await service.checkPreExecution(tool("browser.type"), hostile, request);
    expect(rows[0]!.parameters).toEqual({ action: "browser.type", redacted: true, reason: "REDACTION_FAILED" });
    noSecret(rows);
  });

  it("still gives an ordinary tool the generic key/shape redaction", async () => {
    const { service, rows } = harness(true);
    await service.checkPreExecution(
      tool("meta.campaign.create", { risk: "FINANCIAL" }),
      { name: "Diwali sale", dailyBudget: 500, password: "Summer2026!" },
      request
    );
    expect(rows[0]!.parameters).toMatchObject({ name: "Diwali sale", dailyBudget: 500, password: "[REDACTED]" });
    noSecret(rows);
  });
});
