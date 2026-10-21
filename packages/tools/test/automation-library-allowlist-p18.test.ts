// ---------------------------------------------------------------------------
// Phase 18, Stage 18.3B — this package's half of the inspection and the
// approval-gated allow-list change.
//
//   • inspect and propose accept the entry id and nothing else — no scope,
//     no workflow data — and refuse before the port is asked;
//   • the add tool never runs for a spoken turn, without an approval, or with
//     parameters other than exactly { entryId, versionId };
//   • it consumes the approval only inside the service's `consume` step —
//     journal first, then the store, with the Organization's scope the service
//     resolved — so a refusal before that step spends nothing, and one
//     approval makes one change.
// The service behind the port is tested in apps/api. Named
// `automation-library*`, the slice CI runs for this package.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_LIBRARY_TOOL_IDS,
  VOICE_CONFIRMATION_REFUSED_MESSAGE,
  computeParamsHash,
  type ApprovalConsumptionInput,
  type AutomationLibraryPort,
  type LibraryAllowlistApplyPort,
  type SharedConnectionScope,
  type ToolContext,
} from "@jarvis/core";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import { AllowlistAddTool, createAutomationLibraryTools } from "../src/tools/automation-library-tools.js";

const PARAMS = { entryId: "wf-1", versionId: "v-1" };
const SCOPE: SharedConnectionScope = {
  tenantId: "org-1",
  providerId: "n8n",
  connector: "rest",
  requesterRoles: ["owner", "admin"],
  approverRoles: ["owner", "admin"],
};
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ userId: "u1", traceId: "t", approvalId: "ap-1", ...over });

function libraryPort() {
  return {
    list: vi.fn(),
    status: vi.fn(),
    startSync: vi.fn(),
    inspect: vi.fn(async () => ({ ok: false as const, status: 404, code: "ENTRY_NOT_FOUND", message: "none" })),
    proposeAllowlist: vi.fn(async () => ({ ok: false as const, status: 403, code: "PERMISSION_DENIED", message: "no" })),
  } as unknown as AutomationLibraryPort & { inspect: ReturnType<typeof vi.fn>; proposeAllowlist: ReturnType<typeof vi.fn> };
}

/** A service that, like the real one, consumes only once it has checked everything. */
function applyPort(behaviour: "consume" | "refuse-before" = "consume") {
  return {
    applyAllowlist: vi.fn<LibraryAllowlistApplyPort["applyAllowlist"]>(async (_userId, params, consume) => {
      if (behaviour === "refuse-before") return { ok: false, status: 409, code: "VERSION_CHANGED", message: "changed" };
      const spent = await consume(SCOPE);
      if (!spent.ok) return { ok: false, status: 409, code: "APPROVAL_REFUSED", message: "refused" };
      return { ok: true, value: { entryId: params.entryId, versionId: params.versionId, outcome: "created" } };
    }),
  };
}

/** The store consumes the approval and claims the journal record together, as the real repository does in one transaction. */
function approvalStore(journal: MemoryExecutionJournal) {
  const spent = new Set<string>();
  const calls: ApprovalConsumptionInput[] = [];
  return {
    calls,
    consumeForExecution: vi.fn(async (input: ApprovalConsumptionInput) => {
      calls.push(input);
      if (!input.tenantScope) return { ok: false as const, reason: "scope_required" };
      if (spent.has(input.approvalId)) return { ok: false as const, reason: "already_consumed" };
      spent.add(input.approvalId);
      await journal.claimForExecution(input.executionId);
      return { ok: true as const };
    }),
  };
}

describe("inspect and propose — the entry id, and nothing else", () => {
  const tools = () => {
    const port = libraryPort();
    const byId = new Map(createAutomationLibraryTools(port).map((t) => [t.id, t]));
    return { port, inspect: byId.get(AUTOMATION_LIBRARY_TOOL_IDS.inspect)!, propose: byId.get(AUTOMATION_LIBRARY_TOOL_IDS.propose)! };
  };

  it("is read-only to inspect, low-impact to propose, and neither needs an approval", () => {
    const { inspect, propose } = tools();
    expect(inspect.risk).toBe("READ_ONLY");
    expect(propose.risk).toBe("LOW_IMPACT");
    expect(inspect.requiresApproval).toBe(false);
    expect(propose.requiresApproval).toBe(false);
  });

  it("refuses a scope field, workflow data, any other key or a bad id — before the port is asked", async () => {
    const { port, inspect, propose } = tools();
    for (const tool of [inspect, propose]) {
      for (const params of [
        { entryId: "wf-1", tenantId: "org-2" },
        { entryId: "wf-1", baseUrl: "https://evil.example" },
        { entryId: "wf-1", nodes: [{ parameters: { token: "x" } }] },
        { entryId: "wf-1", versionId: "v-1" },
        { entryId: "../wf" },
        {},
      ]) {
        const result = await tool.execute(params, ctx({ approvalId: undefined }));
        expect(result.success, `${tool.id} ${JSON.stringify(params)}`).toBe(false);
        expect(["INVALID_REQUEST", "INVALID_ENTRY", "REQUEST_SCOPE_REFUSED"]).toContain(result.metadata?.code);
      }
    }
    expect(port.inspect).not.toHaveBeenCalled();
    expect(port.proposeAllowlist).not.toHaveBeenCalled();
  });

  it("passes only the entry id on", async () => {
    const { port, inspect, propose } = tools();
    await inspect.execute({ entryId: "wf-1" }, ctx());
    await propose.execute({ entryId: "wf-1" }, ctx());
    expect(port.inspect).toHaveBeenCalledWith("u1", "wf-1");
    expect(port.proposeAllowlist.mock.calls[0]?.slice(0, 2)).toEqual(["u1", "wf-1"]);
  });
});

describe("the add tool — one approval, one change, never by voice", () => {
  const setup = (behaviour?: "consume" | "refuse-before") => {
    const port = applyPort(behaviour);
    const journal = new MemoryExecutionJournal();
    const approvals = approvalStore(journal);
    return { port, journal, approvals, tool: new AllowlistAddTool(port, journal, approvals) };
  };

  it("is HIGH_IMPACT and approval-gated", () => {
    const { tool } = setup();
    expect(tool.risk).toBe("HIGH_IMPACT");
    expect(tool.requiresApproval).toBe(true);
  });

  it("refuses a spoken turn, a missing approval and anything but { entryId, versionId } — reaching nothing", async () => {
    const { tool, port, approvals } = setup();
    const spoken = await tool.execute(PARAMS, ctx({ inputMode: "voice" }));
    expect(spoken).toMatchObject({ success: false, error: VOICE_CONFIRMATION_REFUSED_MESSAGE, metadata: { code: "VOICE_NOT_ALLOWED", status: 403 } });
    expect((await tool.execute(PARAMS, ctx({ approvalId: undefined }))).metadata).toMatchObject({ code: "APPROVAL_REQUIRED" });
    for (const params of [{ entryId: "wf-1" }, { ...PARAMS, tenantId: "org-2" }, { ...PARAMS, webhookPath: "x" }, { entryId: "wf-1", versionId: "v 1" }]) {
      expect((await tool.execute(params, ctx())).metadata, JSON.stringify(params)).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(port.applyAllowlist).not.toHaveBeenCalled();
    expect(approvals.consumeForExecution).not.toHaveBeenCalled();
  });

  it("refuses without an approval store rather than run unverified", async () => {
    const result = await new AllowlistAddTool(applyPort(), new MemoryExecutionJournal()).execute(PARAMS, ctx());
    expect(result.metadata).toMatchObject({ code: "APPROVAL_UNAVAILABLE", status: 503 });
  });

  it("consumes with the scope the service resolved, the exact params hash, and a journal record — then marks it", async () => {
    const { tool, approvals, journal } = setup();
    const result = await tool.execute(PARAMS, ctx());
    expect(result.success).toBe(true);
    expect(approvals.calls).toHaveLength(1);
    expect(approvals.calls[0]).toMatchObject({
      approvalId: "ap-1",
      userId: "u1",
      toolId: AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd,
      paramsHash: computeParamsHash(PARAMS),
      tenantScope: SCOPE,
    });
    const record = await journal.getById(approvals.calls[0]!.executionId);
    expect(record?.status).toBe("SUCCEEDED");
    expect(record?.approvalId).toBe("ap-1");
  });

  it("spends nothing when the service refuses before its consume step", async () => {
    const { tool, approvals } = setup("refuse-before");
    expect((await tool.execute(PARAMS, ctx())).metadata).toMatchObject({ code: "VERSION_CHANGED", status: 409 });
    expect(approvals.consumeForExecution).not.toHaveBeenCalled();
  });

  it("makes one change for one approval — a retry and a duplicate are refused", async () => {
    const { tool, port, approvals } = setup();
    const [a, b] = await Promise.all([tool.execute(PARAMS, ctx()), tool.execute(PARAMS, ctx())]);
    const again = await tool.execute(PARAMS, ctx());
    expect([a, b, again].filter((r) => r.success)).toHaveLength(1);
    // The service was asked three times; only one consume was granted, so only one change was made.
    expect(port.applyAllowlist).toHaveBeenCalledTimes(3);
    const granted = await Promise.all(approvals.consumeForExecution.mock.results.map((r) => r.value));
    expect(granted.filter((g) => g.ok)).toHaveLength(1);
  });
});
