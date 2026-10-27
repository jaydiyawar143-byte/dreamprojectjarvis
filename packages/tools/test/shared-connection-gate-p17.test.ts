// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening (review finding H2) — the tool layer.
//
//   • The executor's access gate (`ToolAccessGate`) is asked before ANY
//     approval is looked up or created; a refusal — or a gate that cannot
//     answer — ends the request with nothing approved, nothing run.
//   • A Meta write asks its authorizer for the WRITE as it runs
//     (`authorizeWrite`), refuses on its answer before touching the provider,
//     and hands the scope it was given to the approval store's consumption.
//   • A write that carries an Organization's scope never runs without an
//     approval — not even through the old no-approval test seam.
//   • Phase 19.1 — and a Meta write runs only with the executor's grant for
//     that exact call (src/execution-grant.ts). The calls below carry one,
//     as the executor's would; a call with none is refused before the
//     authorizer is asked (meta-ads-write-boundary-p19 covers the rest).
//
// No provider is real: the Meta provider is the in-memory mock, spied on, and
// every test asserts what reached it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeParamsHash } from "@jarvis/core";
import type {
  Approval,
  ApprovalConsumptionInput,
  AuditLogger,
  IApprovalConsumptionPort,
  IApprovalManager,
  IPermissionChecker,
  ITool,
  Role,
  SharedConnectionScope,
  ToolAccessGate,
  ToolContext,
} from "@jarvis/core";
import { ToolExecutor } from "../src/executor.js";
import { MetaPauseCampaignTool, clearExecutionStore } from "../src/tools/meta-ads-write-tools.js";
import { createMockMetaProvider } from "../src/tools/meta-ads-mock.js";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import { issueExecutionGrant } from "../src/execution-grant.js";
import type { MetaAccountAuthorizer } from "../src/tools/meta-ads-provider.js";

const ACCOUNT = "act_111111111";
const CAMPAIGN = "100000001";
const PARAMS = { accountId: ACCOUNT, campaignId: CAMPAIGN };

const SCOPE: SharedConnectionScope = {
  tenantId: "org-a",
  providerId: "meta",
  connector: "ads",
  requesterRoles: ["owner", "admin"],
  approverRoles: ["owner", "admin"],
};

beforeEach(() => clearExecutionStore());

// ---------------------------------------------------------------------------
// The executor's gate
// ---------------------------------------------------------------------------

function writeTool(): ITool {
  return {
    id: "meta.campaign.pause",
    name: "Pause",
    description: "write",
    category: "marketing",
    risk: "EXTERNAL_SIDE_EFFECT",
    parameters: [],
    requiresApproval: true,
    requiredPermissions: ["read", "write"],
    version: "1",
    enabled: true,
    execute: vi.fn(async () => ({ success: true, data: { ran: true } })),
    validate: () => true,
  };
}

function executorWith(gate: ToolAccessGate | undefined, tool: ITool = writeTool(), registryKey = tool.id) {
  const approvals: IApprovalManager = {
    requestApproval: vi.fn(async (req) => ({
      ...req,
      id: "apr-1",
      status: "pending" as const,
      paramsHash: computeParamsHash(req.params),
      createdAt: new Date().toISOString(),
    })),
    findExistingForTool: vi.fn(async () => null),
    findApprovalsForTool: vi.fn(async () => [] as Approval[]),
  };
  const perms: IPermissionChecker = { hasPermission: () => true };
  const audit = { log: vi.fn(async () => {}) } as unknown as AuditLogger;
  const executor = new ToolExecutor(
    { get: (id) => (id === registryKey ? tool : undefined) },
    perms,
    approvals,
    audit,
    gate ? { accessGate: gate } : undefined
  );
  return { executor, approvals, audit, tool };
}

const request = (toolId = "meta.campaign.pause") => ({
  toolId,
  params: PARAMS,
  userId: "user-1",
  role: "owner" as Role,
  traceId: "t-1",
});

describe("the executor asks the access gate before any approval exists", () => {
  it("ends a refused request with nothing approved, looked up or run", async () => {
    const gate: ToolAccessGate = { check: vi.fn(async () => ({ allowed: false as const, reason: "Meta Ads is not available to your account." })) };
    const { executor, approvals, audit, tool } = executorWith(gate);

    const result = await executor.execute(request());

    expect(result).toMatchObject({ status: "permission_denied", error: "Meta Ads is not available to your account." });
    expect(approvals.findExistingForTool).not.toHaveBeenCalled();
    expect(approvals.findApprovalsForTool).not.toHaveBeenCalled();
    expect(approvals.requestApproval).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ result: "rejected" }));
  });

  it("refuses when the gate cannot answer", async () => {
    const gate: ToolAccessGate = { check: vi.fn(async () => { throw new Error("tenant store down"); }) };
    const { executor, approvals, tool } = executorWith(gate);
    const result = await executor.execute(request());
    expect(result.status).toBe("permission_denied");
    expect(result.error).toMatch(/could not be verified/);
    expect(approvals.requestApproval).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("continues to the approval flow when the gate allows", async () => {
    const gate: ToolAccessGate = { check: vi.fn(async () => ({ allowed: true as const })) };
    const { executor, approvals } = executorWith(gate);
    const result = await executor.execute(request());
    expect(result.status).toBe("approval_pending");
    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("asks about the registry's own id, whatever spelling reached it", async () => {
    const check = vi.fn(async () => ({ allowed: false as const, reason: "no" }));
    const { executor } = executorWith({ check }, writeTool(), "meta-campaign-pause");
    await executor.execute(request("meta-campaign-pause"));
    expect(check).toHaveBeenCalledWith({ toolId: "meta.campaign.pause", userId: "user-1" });
  });

  it("changes nothing when no gate is wired", async () => {
    const { executor, approvals } = executorWith(undefined);
    expect((await executor.execute(request())).status).toBe("approval_pending");
    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A Meta write, as it runs
// ---------------------------------------------------------------------------

function consumption(result: { ok: true } | { ok: false; reason: string } = { ok: true }) {
  const inputs: ApprovalConsumptionInput[] = [];
  const port: IApprovalConsumptionPort = {
    consumeForExecution: vi.fn(async (input: ApprovalConsumptionInput) => {
      inputs.push(input);
      return result;
    }),
  };
  return { port, inputs };
}

function writeSetup(authorizer: MetaAccountAuthorizer, consumed = consumption()) {
  const provider = createMockMetaProvider();
  const write = vi.spyOn(provider, "updateCampaignStatus");
  const reads = vi.spyOn(provider, "getCampaigns");
  const tool = new MetaPauseCampaignTool(provider, authorizer, new MemoryExecutionJournal(), consumed.port);
  return { tool, write, reads, consumed };
}

/** The context the executor hands a write it authorized, with approval `apr-1`. */
function granted(userId: string): ToolContext {
  const context: ToolContext = { userId, approvalId: "apr-1" };
  issueExecutionGrant(context, {
    toolId: "meta.campaign.pause",
    userId,
    paramsHash: computeParamsHash(PARAMS),
    approvalId: "apr-1",
    sharedAccessChecked: true,
  });
  return context;
}

const tokenReaches: Pick<MetaAccountAuthorizer, "getAuthorizedAccountIds" | "isAuthorized"> = {
  getAuthorizedAccountIds: async () => [ACCOUNT],
  isAuthorized: async () => true,
};

describe("a Meta write asks for the WRITE as it runs", () => {
  it("refuses on the authorizer's answer before the provider is touched", async () => {
    const { tool, write, reads, consumed } = writeSetup({
      ...tokenReaches,
      authorizeWrite: vi.fn(async () => ({
        allowed: false as const,
        reason: "Your organization role does not allow changes through Meta Ads. Ask an owner or admin of your organization.",
      })),
    });
    const result = await tool.execute(PARAMS, granted("viewer-1"));
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/does not allow changes/);
    expect(reads).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(consumed.port.consumeForExecution).not.toHaveBeenCalled();
  });

  it("refuses when the authorizer cannot answer", async () => {
    const { tool, write, reads } = writeSetup({
      ...tokenReaches,
      authorizeWrite: vi.fn(async () => { throw new Error("tenant store down"); }),
    });
    const result = await tool.execute(PARAMS, granted("admin-1"));
    expect(result.error).toMatch(/could not be verified/);
    expect(reads).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("hands the Organization's scope to the consumption, and writes only after it", async () => {
    const order: string[] = [];
    const consumed = consumption();
    (consumed.port.consumeForExecution as ReturnType<typeof vi.fn>).mockImplementation(async (input: ApprovalConsumptionInput) => {
      order.push("consume");
      consumed.inputs.push(input);
      return { ok: true };
    });
    const { tool, write } = writeSetup(
      { ...tokenReaches, authorizeWrite: vi.fn(async () => ({ allowed: true as const, tenantScope: SCOPE })) },
      consumed
    );
    write.mockImplementation(async (...args) => {
      order.push("write");
      return createMockMetaProvider().updateCampaignStatus(...args);
    });

    const result = await tool.execute(PARAMS, granted("admin-1"));

    expect(result.success).toBe(true);
    expect(consumed.inputs).toHaveLength(1);
    expect(consumed.inputs[0]).toMatchObject({
      approvalId: "apr-1",
      userId: "admin-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash(PARAMS),
      tenantScope: SCOPE,
    });
    expect(order).toEqual(["consume", "write"]);
  });

  it("writes nothing when the store refuses the consumption", async () => {
    const { tool, write } = writeSetup(
      { ...tokenReaches, authorizeWrite: vi.fn(async () => ({ allowed: true as const, tenantScope: SCOPE })) },
      consumption({ ok: false, reason: "the requester's organization role no longer allows this change" })
    );
    const result = await tool.execute(PARAMS, granted("admin-1"));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no longer allows/);
    expect(write).not.toHaveBeenCalled();
  });

  it("never runs an Organization's write without an approval — not through the no-approval seam either", async () => {
    // Phase 19.1 — the no-approval seam is gone: a call with no approval
    // carries no executor grant, so it is refused before the authorizer, the
    // provider or the store is asked.
    const authorizeWrite = vi.fn(async () => ({ allowed: true as const, tenantScope: SCOPE }));
    const { tool, write, reads, consumed } = writeSetup({ ...tokenReaches, authorizeWrite });
    const result = await tool.execute(PARAMS, { userId: "admin-1" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/run only after an approval is checked/);
    expect(authorizeWrite).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(consumed.port.consumeForExecution).not.toHaveBeenCalled();
  });

  it("keeps the account check it always had for an authorizer without authorizeWrite", async () => {
    const { tool, write, consumed } = writeSetup({ ...tokenReaches });
    const result = await tool.execute(PARAMS, granted("user-1"));
    expect(result.success).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(consumed.inputs[0]!.tenantScope).toBeUndefined();
  });
});
