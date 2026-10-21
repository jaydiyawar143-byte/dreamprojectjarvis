// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — the planning tools, this package's half.
//
//   • five tools: match, get and list are READ_ONLY; create and revise write
//     JARVIS's own store (LOW_IMPACT). None needs an approval and each takes
//     only the platform's `read` — the Organization's role is the service's;
//   • each hands its parameters, unchanged, to the one AutomationPlanningPort
//     (core's rules check them there, for the page and the tools alike), and
//     reports a refusal with the service's status, code and issues;
//   • an id that is not a draft id, or a stray field on get/list, is refused
//     before the port is asked;
//   • through ToolExecutor they run for a spoken turn too — a match or a draft
//     is a proposal — and nothing they return can carry an approval.
// The service is tested in apps/api. Named `automation-library*`, the slice
// CI runs for this package.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_PLANNING_TOOL_IDS,
  type AuditLogger,
  type AutomationPlanningPort,
  type IApprovalManager,
  type IPermissionChecker,
  type ITool,
} from "@jarvis/core";
import { ToolExecutor } from "../src/executor.js";
import { createAutomationPlanningTools } from "../src/tools/automation-planning-tools.js";

const DRAFT_ID = "draft-0001abcd";

function fakePort() {
  const view = {
    draftId: DRAFT_ID,
    title: "Leads",
    status: "unverified",
    version: { number: 2 },
    latestVersion: 2,
    requirements: [],
  };
  return {
    match: vi.fn(async () => ({
      ok: true as const,
      value: { explanation: "No suitable workflow found.", request: { openQuestions: [{ key: "outcome", question: "What should have happened?" }] } },
    })),
    createDraft: vi.fn(async () => ({
      ok: false as const,
      status: 422,
      code: "DRAFT_INVALID",
      message: "nodes[0].type: not supported",
      issues: [{ code: "UNSUPPORTED_NODE_TYPE", path: "nodes[0].type", message: "not supported" }],
    })),
    reviseDraft: vi.fn(async () => ({ ok: true as const, value: { draft: view, unchanged: false } })),
    getDraft: vi.fn(async () => ({ ok: true as const, value: view })),
    listDrafts: vi.fn(async () => ({ ok: true as const, value: { items: [], page: 1, limit: 20, total: 0, totalPages: 1 } })),
  } as unknown as AutomationPlanningPort & Record<keyof AutomationPlanningPort, ReturnType<typeof vi.fn>>;
}

const ctx = { userId: "u1", traceId: "t" };

describe("the planning tools", () => {
  it("are five, none approval-gated, reads READ_ONLY and the store writes LOW_IMPACT, on the platform's read alone", () => {
    const tools = createAutomationPlanningTools(fakePort());
    expect(tools.map((t) => [t.id, t.risk, t.requiresApproval, t.requiredPermissions])).toEqual([
      [AUTOMATION_PLANNING_TOOL_IDS.match, "READ_ONLY", false, ["read"]],
      [AUTOMATION_PLANNING_TOOL_IDS.draftCreate, "LOW_IMPACT", false, ["read"]],
      [AUTOMATION_PLANNING_TOOL_IDS.draftRevise, "LOW_IMPACT", false, ["read"]],
      [AUTOMATION_PLANNING_TOOL_IDS.draftGet, "READ_ONLY", false, ["read"]],
      [AUTOMATION_PLANNING_TOOL_IDS.draftList, "READ_ONLY", false, ["read"]],
    ]);
  });

  it("hand their parameters, unchanged, to the one port — the draft id apart from the revision", async () => {
    const port = fakePort();
    const [match, create, revise, get, list] = createAutomationPlanningTools(port);
    const request = { goal: "x to Slack", tenantId: "org-2", nodes: [{ parameters: { token: "x" } }] };
    await match!.execute(request, ctx);
    await create!.execute({ ...request, kind: "new" }, ctx);
    await revise!.execute({ draftId: DRAFT_ID, baseVersion: 1, answers: { "question.outcome": "x" } }, ctx);
    await get!.execute({ draftId: DRAFT_ID, version: 1 }, ctx);
    await list!.execute({}, ctx);
    expect(port.match).toHaveBeenCalledWith("u1", request, { via: "jarvis" });
    expect(port.createDraft).toHaveBeenCalledWith("u1", { ...request, kind: "new" }, { via: "jarvis" });
    expect(port.reviseDraft).toHaveBeenCalledWith("u1", DRAFT_ID, { baseVersion: 1, answers: { "question.outcome": "x" } }, { via: "jarvis" });
    expect(port.getDraft).toHaveBeenCalledWith("u1", DRAFT_ID, 1);
    expect(port.listDrafts).toHaveBeenCalledWith("u1", { page: 1, limit: 20 });
  });

  it("report the service's refusal with its status, code and issues", async () => {
    const [, create] = createAutomationPlanningTools(fakePort());
    const result = await create!.execute({ goal: "x", kind: "new" }, ctx);
    expect(result).toEqual({
      success: false,
      error: "nodes[0].type: not supported",
      metadata: {
        toolId: AUTOMATION_PLANNING_TOOL_IDS.draftCreate,
        code: "DRAFT_INVALID",
        status: 422,
        issues: [{ code: "UNSUPPORTED_NODE_TYPE", path: "nodes[0].type", message: "not supported" }],
      },
    });
  });

  it("refuse a non-draft id and stray fields before the port is asked", async () => {
    const port = fakePort();
    const [, , revise, get, list] = createAutomationPlanningTools(port);
    expect((await revise!.execute({ draftId: "../x", baseVersion: 1 }, ctx)).metadata).toMatchObject({ code: "INVALID_DRAFT", status: 400 });
    expect((await get!.execute({ draftId: "x" }, ctx)).metadata).toMatchObject({ code: "INVALID_DRAFT" });
    expect((await get!.execute({ draftId: DRAFT_ID, tenantId: "org-2" }, ctx)).metadata).toMatchObject({ code: "INVALID_REQUEST" });
    expect((await list!.execute({ limit: 500 }, ctx)).metadata).toMatchObject({ code: "INVALID_REQUEST" });
    expect(port.reviseDraft).not.toHaveBeenCalled();
    expect(port.getDraft).not.toHaveBeenCalled();
    expect(port.listDrafts).not.toHaveBeenCalled();
  });

  it("never claim more than the draft is", async () => {
    const [, , revise] = createAutomationPlanningTools(fakePort());
    const result = await revise!.execute({ draftId: DRAFT_ID, baseVersion: 1, answers: { "question.x": "y" } }, ctx);
    expect(result.metadata?.message).toBe(
      "Saved version 2 of \"Leads\". Earlier versions are unchanged. Its structure is checked; its settings are not validated against n8n's node schemas, which JARVIS does not have."
    );
  });

  it("run through ToolExecutor for a spoken turn too, asking for no approval", async () => {
    const port = fakePort();
    const tools = new Map<string, ITool>(createAutomationPlanningTools(port).map((t) => [t.id, t]));
    const approvals = { requestApproval: vi.fn(), checkApproval: vi.fn() } as unknown as IApprovalManager;
    const executor = new ToolExecutor(
      { get: (id: string) => tools.get(id) },
      { hasPermission: () => true } as IPermissionChecker,
      approvals,
      { log: async () => undefined } as unknown as AuditLogger
    );
    const result = await executor.execute({
      toolId: AUTOMATION_PLANNING_TOOL_IDS.match,
      params: { goal: "When a form is submitted, post to Slack" },
      userId: "u1",
      role: "member",
      traceId: "t",
      inputMode: "voice",
    });
    expect(result.status).toBe("completed");
    expect(port.match).toHaveBeenCalledTimes(1);
    expect(approvals.requestApproval).not.toHaveBeenCalled();
  });
});
