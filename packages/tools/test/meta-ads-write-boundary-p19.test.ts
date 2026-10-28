// ---------------------------------------------------------------------------
// Phase 19.1 — a Meta Ads write runs only behind the executor.
//
// Before this stage a Meta write tool's `execute` trusted its context: a call
// with no `approvalId` claimed the journal row and ran whenever the account
// check named no Organization, and a caller-supplied `approvalId` went straight
// to the approval store — around the executor's permission check, its
// spoken-turn refusal, its shared-connection gate and its approval binding.
//
// Now every one of the nine writes asks first for the executor's grant for
// that exact call (execution-grant.ts), before the account check, the journal,
// any Meta read or the approval, and refuses without it. This suite shows, for
// all nine:
//
//   * a direct call — with no approval, a real approval's id, forged fields or
//     a copy of a context the executor really authorized — is refused with
//     nothing asked, read, journaled or spent;
//   * a grant fits only its own call, and only once;
//   * through the real executor, a missing, expired, replayed, changed,
//     self-approved or cross-Organization approval fails closed, and a valid
//     one runs once;
//   * a spoken turn neither runs a write nor spends its approval;
//   * the five reads are unchanged.
//
// Fakes only: the in-memory Meta provider, no network, no database. Named
// `meta-ads*`, the slice CI runs for these tools.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Approval,
  ApprovalConsumptionInput,
  AuditLogger,
  BeginExecutionInput,
  CampaignProposal,
  IApprovalConsumptionPort,
  IApprovalManager,
  IPermissionChecker,
  ITool,
  Role,
  SharedConnectionScope,
  ToolAccessGate,
  ToolContext,
  ToolExecutionRecord,
} from "@jarvis/core";
import { computeParamsHash, voiceConfirmationRefusal } from "@jarvis/core";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import { issueExecutionGrant, verifyExecutionGrant } from "../src/execution-grant.js";
import { ToolExecutor } from "../src/executor.js";
import { createMockMetaProvider } from "../src/tools/meta-ads-mock.js";
import type { MetaAccountAuthorizer } from "../src/tools/meta-ads-provider.js";
import {
  MetaGetAccountsTool,
  MetaGetAdSetsTool,
  MetaGetAdsTool,
  MetaGetCampaignsTool,
  MetaGetInsightsTool,
} from "../src/tools/meta-ads-tools.js";
import {
  MetaCreateCampaignTool,
  MetaPauseAdSetTool,
  MetaPauseAdTool,
  MetaPauseCampaignTool,
  MetaResumeAdSetTool,
  MetaResumeAdTool,
  MetaResumeCampaignTool,
  MetaUpdateAdSetBudgetTool,
  MetaUpdateCampaignBudgetTool,
} from "../src/tools/meta-ads-write-tools.js";

const NOT_AUTHORIZED = "Meta Ads changes run only after an approval is checked, so nothing was changed.";
const SPOKEN = voiceConfirmationRefusal("voice")!;
const ACCOUNT = "act_111111111";
const USER = "admin-1";
const APPROVER = "admin-2";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type FullProvider = ReturnType<typeof createMockMetaProvider>;

const READ_METHODS = ["getAdAccounts", "getCampaigns", "getAdSets", "getAds", "getInsights"] as const;
const WRITE_METHODS = [
  "updateCampaignStatus",
  "updateAdSetStatus",
  "updateAdStatus",
  "updateCampaignBudget",
  "updateAdSetBudget",
  "createCampaign",
] as const;

/**
 * The mock Meta provider, counting every read and every write it is asked
 * for. `failNextWrite` makes the next write a definite refusal by Meta, so
 * nothing changed there and the journal row stays retryable.
 */
async function countingProvider(): Promise<{
  provider: FullProvider;
  reads: () => number;
  writes: () => number;
  failNextWrite: (message: string) => void;
}> {
  const provider = createMockMetaProvider();
  // One ad set and one ad paused first, so each resume has something to do.
  await provider.updateAdSetStatus(ACCOUNT, "200000002", "PAUSED");
  await provider.updateAdStatus(ACCOUNT, "300000002", "PAUSED");
  let reads = 0;
  let writes = 0;
  let failure: string | null = null;
  const target = provider as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of READ_METHODS) {
    const original = target[method]!.bind(provider);
    target[method] = async (...args) => {
      reads += 1;
      return original(...args);
    };
  }
  for (const method of WRITE_METHODS) {
    const original = target[method]!.bind(provider);
    target[method] = async (...args) => {
      writes += 1;
      if (failure) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
      return original(...args);
    };
  }
  return {
    provider,
    reads: () => reads,
    writes: () => writes,
    failNextWrite: (message) => {
      failure = message;
    },
  };
}

/** Counts every journal row a write starts. */
class CountingJournal extends MemoryExecutionJournal {
  begins = 0;
  override async begin(input: BeginExecutionInput): Promise<ToolExecutionRecord> {
    this.begins += 1;
    return super.begin(input);
  }
}

const scope = (tenantId: string): SharedConnectionScope => ({
  tenantId,
  providerId: "meta",
  connector: "ads",
  requesterRoles: ["owner", "admin"],
  approverRoles: ["owner", "admin"],
});

interface Row {
  userId: string;
  toolId: string;
  params: Record<string, unknown>;
  paramsHash: string;
  expiresAt: number;
  tenantId: string;
  decidedById: string;
  consumed: boolean;
}

/**
 * The approval store as PrismaApprovalRepository behaves (Phase 10.3 / 17):
 * an Organization's approval is spent only when it exists, is unspent,
 * unexpired, bound to this user, tool and parameters, was decided by someone
 * other than its requester, and belongs to the Organization the server just
 * resolved — and spending it claims the journal row in the same step.
 */
class Store implements IApprovalConsumptionPort {
  rows = new Map<string, Row>();
  consumeCalls = 0;
  constructor(private readonly journal: MemoryExecutionJournal) {}

  approve(id: string, toolId: string, params: Record<string, unknown>, extra: Partial<Row> = {}): void {
    this.rows.set(id, {
      userId: USER,
      toolId,
      params,
      paramsHash: computeParamsHash(params),
      expiresAt: Date.now() + 10 * 60 * 1000,
      tenantId: "org-1",
      decidedById: APPROVER,
      consumed: false,
      ...extra,
    });
  }

  async consumeForExecution(input: ApprovalConsumptionInput) {
    this.consumeCalls += 1;
    const row = this.rows.get(input.approvalId);
    if (!row) return { ok: false as const, reason: "approval not found" };
    if (row.consumed) return { ok: false as const, reason: "approval already consumed" };
    if (row.expiresAt <= Date.now()) return { ok: false as const, reason: "approval has expired" };
    if (row.userId !== input.userId || row.toolId !== input.toolId) return { ok: false as const, reason: "not bound" };
    if (row.paramsHash !== input.paramsHash) return { ok: false as const, reason: "params hash mismatch" };
    if (!input.tenantScope || input.tenantScope.tenantId !== row.tenantId) {
      return { ok: false as const, reason: "approval does not belong to this organization" };
    }
    if (row.decidedById === input.userId) {
      return { ok: false as const, reason: "approval was not given by an independent approver" };
    }
    const claimed = await this.journal.claimForExecution(input.executionId, { ownerId: "store", leaseMs: 60_000 });
    if (!claimed) return { ok: false as const, reason: "execution is not in a claimable state" };
    row.consumed = true;
    return { ok: true as const };
  }
}

/**
 * What the executor reads approvals through. `stale` keeps reporting a spent
 * approval as approved — a cache or a race — so the store's own single-use
 * check is what is under test. `afterRead` runs after each read.
 */
function managerFor(store: Store, options: { stale?: boolean; afterRead?: () => void } = {}) {
  const list = (toolId: string, userId: string): Approval[] => {
    const found = [...store.rows.entries()]
      .filter(([, row]) => row.toolId === toolId && row.userId === userId)
      .map(([id, row]) => ({
        id,
        userId: row.userId,
        toolId: row.toolId,
        action: "execute",
        params: row.params,
        paramsHash: row.paramsHash,
        status: row.consumed && !options.stale ? ("consumed" as const) : ("approved" as const),
        expiresAt: new Date(row.expiresAt).toISOString(),
        createdAt: new Date().toISOString(),
        tenantId: row.tenantId,
        decidedById: row.decidedById,
      }));
    options.afterRead?.();
    return found;
  };
  const manager = {
    requestApproval: vi.fn(async (request: Omit<Approval, "id" | "status" | "createdAt">) => ({
      ...request,
      id: "apr-new",
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    })),
    findExistingForTool: vi.fn(async (toolId: string, userId: string) => list(toolId, userId)[0] ?? null),
    findApprovalsForTool: vi.fn(async (toolId: string, userId: string) => list(toolId, userId)),
  };
  return manager satisfies IApprovalManager;
}

const allowAll: IPermissionChecker = { hasPermission: () => true };
const audit = { log: async () => undefined } as unknown as AuditLogger;
const allowGate: ToolAccessGate = { check: async () => ({ allowed: true }) };

// ---------------------------------------------------------------------------
// The nine writes, each with parameters that change something and a changed copy.
// ---------------------------------------------------------------------------

function proposal(name: string): CampaignProposal {
  return {
    name,
    objective: "OUTCOME_AWARENESS",
    buyingType: "AUCTION",
    status: "PAUSED",
    dailyBudget: 100,
    specialAdCategories: [],
    adSets: [{ name: "AdSet 1", optimizationGoal: "REACH", dailyBudget: 50 }],
    confidence: 0.85,
    assumptions: [],
    warnings: [],
  };
}

const WRITES: Array<{ id: string; params: Record<string, unknown>; changed: Record<string, unknown> }> = [
  {
    id: "meta.campaign.pause",
    params: { accountId: ACCOUNT, campaignId: "100000001" },
    changed: { accountId: ACCOUNT, campaignId: "100000002" },
  },
  {
    id: "meta.campaign.resume",
    params: { accountId: ACCOUNT, campaignId: "100000003" },
    changed: { accountId: ACCOUNT, campaignId: "100000001" },
  },
  {
    id: "meta.adset.pause",
    params: { accountId: ACCOUNT, adSetId: "200000001" },
    changed: { accountId: ACCOUNT, adSetId: "200000003" },
  },
  {
    id: "meta.adset.resume",
    params: { accountId: ACCOUNT, adSetId: "200000002" },
    changed: { accountId: ACCOUNT, adSetId: "200000001" },
  },
  {
    id: "meta.ad.pause",
    params: { accountId: ACCOUNT, adId: "300000001" },
    changed: { accountId: ACCOUNT, adId: "300000003" },
  },
  {
    id: "meta.ad.resume",
    params: { accountId: ACCOUNT, adId: "300000002" },
    changed: { accountId: ACCOUNT, adId: "300000001" },
  },
  {
    id: "meta.campaign.budget.update",
    params: { accountId: ACCOUNT, campaignId: "100000001", requestedDailyBudget: 110 },
    changed: { accountId: ACCOUNT, campaignId: "100000001", requestedDailyBudget: 120 },
  },
  {
    id: "meta.adset.budget.update",
    params: { accountId: ACCOUNT, adSetId: "200000001", requestedDailyBudget: 55 },
    changed: { accountId: ACCOUNT, adSetId: "200000001", requestedDailyBudget: 60 },
  },
  {
    id: "meta.campaign.create",
    params: { accountId: ACCOUNT, proposal: proposal("Q1 Brand Awareness") },
    changed: { accountId: ACCOUNT, proposal: proposal("Q2 Brand Awareness") },
  },
];

const READS: Array<[string, Record<string, unknown>]> = [
  ["meta.accounts", {}],
  ["meta.campaigns", { accountId: ACCOUNT }],
  ["meta.adsets", { accountId: ACCOUNT }],
  ["meta.ads", { accountId: ACCOUNT }],
  ["meta.insights", { accountId: ACCOUNT }],
];

let counted: Awaited<ReturnType<typeof countingProvider>>;
let journal: CountingJournal;
let store: Store;
let accessChecks: number;
let ownerTenant: string;
let tools: Map<string, ITool>;

beforeEach(async () => {
  counted = await countingProvider();
  journal = new CountingJournal();
  store = new Store(journal);
  accessChecks = 0;
  ownerTenant = "org-1";
  // Production-shaped (meta-ads-access.ts): the write names its Organization.
  const authorizer: MetaAccountAuthorizer = {
    getAuthorizedAccountIds: async () => {
      accessChecks += 1;
      return [ACCOUNT];
    },
    isAuthorized: async () => {
      accessChecks += 1;
      return true;
    },
    authorizeWrite: async () => {
      accessChecks += 1;
      return { allowed: true as const, tenantScope: scope(ownerTenant) };
    },
  };
  const p = counted.provider;
  const all: ITool[] = [
    new MetaPauseCampaignTool(p, authorizer, journal, store),
    new MetaResumeCampaignTool(p, authorizer, journal, store),
    new MetaPauseAdSetTool(p, authorizer, journal, store),
    new MetaResumeAdSetTool(p, authorizer, journal, store),
    new MetaPauseAdTool(p, authorizer, journal, store),
    new MetaResumeAdTool(p, authorizer, journal, store),
    new MetaUpdateCampaignBudgetTool(p, authorizer, undefined, journal, store),
    new MetaUpdateAdSetBudgetTool(p, authorizer, undefined, journal, store),
    new MetaCreateCampaignTool(p, authorizer, undefined, journal, store),
    new MetaGetAccountsTool(p, authorizer),
    new MetaGetCampaignsTool(p, authorizer),
    new MetaGetAdSetsTool(p, authorizer),
    new MetaGetAdsTool(p, authorizer),
    new MetaGetInsightsTool(p, authorizer),
  ];
  tools = new Map(all.map((tool) => [tool.id, tool]));
});

const tool = (id: string): ITool => tools.get(id)!;

/** `gate: null` builds an executor that asks no shared-connection gate. */
function executor(manager: IApprovalManager, gate: ToolAccessGate | null = allowGate): ToolExecutor {
  return new ToolExecutor({ get: (id: string) => tools.get(id) }, allowAll, manager, audit, gate ? { accessGate: gate } : undefined);
}

function run(
  ex: ToolExecutor,
  toolId: string,
  params: Record<string, unknown>,
  extra: { approvalId?: string; inputMode?: "voice" | "text" } = {}
) {
  return ex.execute({ toolId, params, userId: USER, role: "admin" as Role, traceId: "trace-1", ...extra });
}

/** A context as the executor builds it, with the grant it would issue. */
function grantedContext(
  toolId: string,
  params: Record<string, unknown>,
  overrides: {
    grantUser?: string;
    grantApproval?: string;
    sharedAccessChecked?: boolean;
    inputMode?: "voice" | "text";
    contextInputMode?: "voice" | "text";
  } = {}
): ToolContext {
  const context: ToolContext = {
    userId: USER,
    traceId: "trace-1",
    approvalId: "apr-1",
    ...(overrides.contextInputMode ? { inputMode: overrides.contextInputMode } : {}),
  };
  issueExecutionGrant(context, {
    toolId,
    userId: overrides.grantUser ?? USER,
    paramsHash: computeParamsHash(params),
    approvalId: overrides.grantApproval ?? "apr-1",
    ...(overrides.inputMode ? { inputMode: overrides.inputMode } : {}),
    sharedAccessChecked: overrides.sharedAccessChecked ?? true,
  });
  return context;
}

/** Nothing about the write was started: no account check, no journal row, no Meta call, no approval spent. */
function expectNothingSpent(approvalId = "apr-1") {
  expect(accessChecks).toBe(0);
  expect(journal.begins).toBe(0);
  expect(counted.reads()).toBe(0);
  expect(counted.writes()).toBe(0);
  expect(store.consumeCalls).toBe(0);
  const row = store.rows.get(approvalId);
  if (row) expect(row.consumed).toBe(false);
}

// ---------------------------------------------------------------------------

describe("Phase 19.1 — a Meta Ads write called directly is refused before anything is asked", () => {
  it.each(WRITES)("$id with no approval at all", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await tool(id).execute(params, { userId: USER, traceId: "trace-1" });

    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });

  it.each(WRITES)("$id with a caller-supplied id of a real, approved, bound approval", async ({ id, params }) => {
    // The store would accept this approval. The tool never asks it: an id in
    // the context is a claim, not proof that the executor checked anything.
    store.approve("apr-1", id, params);

    const result = await tool(id).execute(params, { userId: USER, traceId: "trace-1", approvalId: "apr-1" });

    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });

  it.each(WRITES)("$id with forged authorization fields in the context", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const forged = {
      userId: USER,
      traceId: "trace-1",
      approvalId: "apr-1",
      grant: { toolId: id, userId: USER, paramsHash: computeParamsHash(params), approvalId: "apr-1", sharedAccessChecked: true },
      executorAuthorized: true,
      sharedAccessChecked: true,
      tenantScope: scope("org-1"),
    } as ToolContext;

    const result = await tool(id).execute(params, forged);

    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });

  it.each(WRITES)("$id with a copy of a context the executor really authorized", async ({ id, params }) => {
    // A probe stands in for the tool inside a real executor, to capture the
    // context the executor hands over after its checks.
    store.approve("apr-1", id, params);
    let captured: ToolContext | undefined;
    const probe: ITool = {
      ...tool(id),
      id,
      validate: () => true,
      execute: async (_p, context) => {
        captured = context;
        return { success: true };
      },
    };
    const ex = new ToolExecutor({ get: () => probe }, allowAll, managerFor(store), audit, { accessGate: allowGate });
    expect((await run(ex, id, params, { approvalId: "apr-1" })).status).toBe("completed");
    expect(captured?.approvalId).toBe("apr-1");

    const result = await tool(id).execute(params, { ...captured! });

    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });

  it.each(WRITES)("$id refuses before validating its own parameters", async ({ id }) => {
    // Even a call the tool would refuse as invalid is refused for its missing
    // grant first: the check is the very first step.
    const result = await tool(id).execute({ accountId: "not-an-account" }, { userId: USER, approvalId: "apr-1" });
    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });
});

describe("Phase 19.1 — a Meta Ads grant fits only the call it was issued for", () => {
  const otherTool = (id: string) => (id === "meta.campaign.pause" ? "meta.campaign.resume" : "meta.campaign.pause");
  const MISMATCHES: Array<[string, (id: string, params: Record<string, unknown>, changed: Record<string, unknown>) => { context: ToolContext; params: Record<string, unknown> }]> = [
    ["another tool", (id, params) => ({ context: grantedContext(otherTool(id), params), params })],
    ["another user", (id, params) => ({ context: grantedContext(id, params, { grantUser: "intruder-1" }), params })],
    ["other parameters", (id, params, changed) => ({ context: grantedContext(id, params), params: changed })],
    ["another approval", (id, params) => ({ context: grantedContext(id, params, { grantApproval: "apr-other" }), params })],
    ["an executor that asked no shared-connection gate", (id, params) => ({ context: grantedContext(id, params, { sharedAccessChecked: false }), params })],
  ];
  const CASES = WRITES.flatMap((write) => MISMATCHES.map(([label, build]) => ({ ...write, label, build })));

  it.each(CASES)("$id refuses a grant for $label", async ({ id, params, changed, build }) => {
    store.approve("apr-1", id, params);
    store.approve("apr-1-changed", id, changed);
    const call = build(id, params, changed);

    const result = await tool(id).execute(call.params, call.context);

    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });

  it.each(WRITES)("$id runs once with its own grant, and spends it", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const context = grantedContext(id, params);

    const first = await tool(id).execute(params, context);
    expect(first.success, first.error).toBe(true);
    expect(store.consumeCalls).toBe(1);
    expect(counted.writes()).toBe(1);
    const checks = accessChecks;
    const begins = journal.begins;
    const reads = counted.reads();

    const again = await tool(id).execute(params, context);
    expect(again).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    // Refused by the spent grant: nothing more was asked, read, journaled or spent.
    expect(accessChecks).toBe(checks);
    expect(journal.begins).toBe(begins);
    expect(counted.reads()).toBe(reads);
    expect(counted.writes()).toBe(1);
    expect(store.consumeCalls).toBe(1);
  });
});

describe("Phase 19.1 — through the executor: Meta Ads approvals fail closed, a valid one runs once", () => {
  it.each(WRITES)("$id runs once with an approved, unexpired, bound, independently approved approval", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await run(executor(managerFor(store)), id, params, { approvalId: "apr-1" });

    expect(result.status, result.error).toBe("completed");
    expect(result.result?.success).toBe(true);
    expect(store.consumeCalls).toBe(1);
    expect(store.rows.get("apr-1")!.consumed).toBe(true);
    expect(counted.writes()).toBe(1);
  });

  it.each(WRITES)("$id with no approval asks for one and changes nothing", async ({ id, params }) => {
    const manager = managerFor(store);

    const result = await run(executor(manager), id, params);

    expect(result.status).toBe("approval_pending");
    expect(manager.requestApproval).toHaveBeenCalledTimes(1);
    expectNothingSpent();
  });

  it.each(WRITES)("$id with an expired approval changes nothing", async ({ id, params }) => {
    store.approve("apr-1", id, params, { expiresAt: Date.now() - 1000 });

    const result = await run(executor(managerFor(store)), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("approval_pending");
    expect(result.approvalId).not.toBe("apr-1");
    expectNothingSpent();
  });

  it.each(WRITES)("$id whose approval expires after the executor read it is refused by the store", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const manager = managerFor(store, {
      afterRead: () => {
        store.rows.get("apr-1")!.expiresAt = Date.now() - 1;
      },
    });

    const result = await run(executor(manager), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("expired");
    expect(store.rows.get("apr-1")!.consumed).toBe(false);
    expect(counted.writes()).toBe(0);
  });

  it.each(WRITES)("$id cannot replay a spent approval", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const ex = executor(managerFor(store));
    expect((await run(ex, id, params, { approvalId: "apr-1" })).status).toBe("completed");

    const replay = await run(ex, id, params, { approvalId: "apr-1" });

    expect(replay.status).toBe("approval_pending");
    expect(replay.approvalId).not.toBe("apr-1");
    expect(store.consumeCalls).toBe(1);
    expect(counted.writes()).toBe(1);
  });

  it.each(WRITES)("$id cannot replay a spent approval even when the executor's read is stale", async ({ id, params }) => {
    // The first attempt is refused by Meta, so nothing changed there and its
    // journal row is retryable: only the store's single-use check stands in
    // the way of the same approval running again.
    store.approve("apr-1", id, params);
    const ex = executor(managerFor(store, { stale: true }));
    counted.failNextWrite("Invalid parameter: rejected by Meta");
    expect((await run(ex, id, params, { approvalId: "apr-1" })).status).toBe("failed");
    expect(store.rows.get("apr-1")!.consumed).toBe(true);
    const attempts = counted.writes();

    const replay = await run(ex, id, params, { approvalId: "apr-1" });

    expect(replay.status).toBe("failed");
    expect(replay.error).toContain("already consumed");
    expect(store.consumeCalls).toBe(2);
    expect(counted.writes()).toBe(attempts);
  });

  it.each(WRITES)("$id run again after it succeeded changes nothing more", async ({ id, params }) => {
    // With a stale read the executor offers the spent approval again; the
    // tool sees the change is already made (or, for a campaign, already
    // created) and neither writes nor spends anything.
    store.approve("apr-1", id, params);
    const ex = executor(managerFor(store, { stale: true }));
    expect((await run(ex, id, params, { approvalId: "apr-1" })).status).toBe("completed");

    await run(ex, id, params, { approvalId: "apr-1" });

    expect(counted.writes()).toBe(1);
    expect(store.rows.get("apr-1")!.consumed).toBe(true);
    expect(store.consumeCalls).toBeLessThanOrEqual(2);
  });

  it.each(WRITES)("$id refuses an approval for other parameters", async ({ id, params, changed }) => {
    store.approve("apr-1", id, params);
    const manager = managerFor(store);

    const result = await run(executor(manager), id, changed, { approvalId: "apr-1" });

    expect(result.status).toBe("approval_pending");
    expect(result.approvalId).not.toBe("apr-1");
    expectNothingSpent();
  });

  it.each(WRITES)("$id refuses an approval from another Organization", async ({ id, params }) => {
    // The connection moved to org-2 after org-1 approved the change.
    store.approve("apr-1", id, params, { tenantId: "org-1" });
    ownerTenant = "org-2";

    const result = await run(executor(managerFor(store)), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("does not belong to this organization");
    expect(store.rows.get("apr-1")!.consumed).toBe(false);
    expect(counted.writes()).toBe(0);
  });

  it.each(WRITES)("$id refuses an approval its requester gave themselves", async ({ id, params }) => {
    store.approve("apr-1", id, params, { decidedById: USER });

    const result = await run(executor(managerFor(store)), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("independent approver");
    expect(store.rows.get("apr-1")!.consumed).toBe(false);
    expect(counted.writes()).toBe(0);
  });

  it.each(WRITES)("$id is refused to an outsider by the shared-connection gate", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const manager = managerFor(store);
    const deny: ToolAccessGate = { check: async () => ({ allowed: false, reason: "Meta Ads is not available to your account." }) };

    const result = await run(executor(manager, deny), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("permission_denied");
    expect(manager.requestApproval).not.toHaveBeenCalled();
    expectNothingSpent();
  });

  it.each(WRITES)("$id does not run under an executor with no shared-connection gate", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await run(executor(managerFor(store), null), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("failed");
    expect(result.error).toBe(NOT_AUTHORIZED);
    expectNothingSpent();
  });
});

describe("Phase 19.1 — a spoken turn neither runs a Meta Ads write nor spends its approval", () => {
  it.each(WRITES)("$id through the executor, with an approved approval", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const manager = managerFor(store);

    const result = await run(executor(manager), id, params, { approvalId: "apr-1", inputMode: "voice" });

    expect(result).toMatchObject({ status: "permission_denied", error: SPOKEN });
    expect(manager.requestApproval).not.toHaveBeenCalled();
    expectNothingSpent();
  });

  it.each(WRITES)("$id through the executor, asked by voice: a pending approval, nothing run", async ({ id, params }) => {
    // Speech may ask for a Meta change; it is confirmed on screen.
    const manager = managerFor(store);

    const result = await run(executor(manager), id, params, { inputMode: "voice" });

    expect(result.status).toBe("approval_pending");
    expect(manager.requestApproval).toHaveBeenCalledTimes(1);
    expectNothingSpent();
  });

  it.each(WRITES)("$id with a grant that says the turn was spoken", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await tool(id).execute(params, grantedContext(id, params, { inputMode: "voice", contextInputMode: "voice" }));

    expect(result).toMatchObject({ success: false, error: SPOKEN });
    expectNothingSpent();
  });

  it.each(WRITES)("$id when only the context says the turn was spoken", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await tool(id).execute(params, grantedContext(id, params, { contextInputMode: "voice" }));

    expect(result).toMatchObject({ success: false, error: SPOKEN });
    expectNothingSpent();
  });

  it.each(WRITES)("$id when only the grant says the turn was spoken", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await tool(id).execute(params, grantedContext(id, params, { inputMode: "voice" }));

    expect(result).toMatchObject({ success: false, error: SPOKEN });
    expectNothingSpent();
  });
});

describe("Phase 19.1 — the five Meta Ads reads are unchanged", () => {
  it.each(READS)("%s runs when called directly", async (id, params) => {
    const result = await tool(id).execute(params, { userId: USER, traceId: "trace-1" });
    expect(result.success, result.error).toBe(true);
    expect(counted.reads()).toBeGreaterThan(0);
    expect(counted.writes()).toBe(0);
    expect(journal.begins).toBe(0);
  });

  it.each(READS)("%s runs through the executor, spoken or typed, with or without a gate", async (id, params) => {
    const manager = managerFor(store);
    for (const ex of [executor(manager), executor(manager, null)]) {
      for (const inputMode of ["voice", "text"] as const) {
        const result = await run(ex, id, params, { inputMode });
        expect(result.status, result.error).toBe("completed");
      }
    }
    expect(manager.requestApproval).not.toHaveBeenCalled();
    expect(store.consumeCalls).toBe(0);
    expect(counted.writes()).toBe(0);
  });
});

describe("Phase 19.1 — the shared grant check itself", () => {
  const PARAMS = { accountId: ACCOUNT, campaignId: "100000001" };
  const issue = (context: ToolContext, approvalId: string) =>
    issueExecutionGrant(context, {
      toolId: "meta.campaign.pause",
      userId: USER,
      paramsHash: computeParamsHash(PARAMS),
      approvalId,
      sharedAccessChecked: true,
    });

  it("accepts the grant for exactly this call, once", () => {
    const context: ToolContext = { userId: USER, approvalId: "apr-1" };
    issue(context, "apr-1");
    expect(verifyExecutionGrant("meta.campaign.pause", PARAMS, context)).toEqual({ ok: true });
    expect(verifyExecutionGrant("meta.campaign.pause", PARAMS, context)).toEqual({ ok: false, refusal: "not_authorized" });
  });

  it("refuses a grant that names no approval, even when the context names the same empty one", () => {
    const context: ToolContext = { userId: USER, approvalId: "" };
    issue(context, "");
    expect(verifyExecutionGrant("meta.campaign.pause", PARAMS, context)).toEqual({ ok: false, refusal: "not_authorized" });
  });

  it("calls a spoken turn spoken, whatever else is wrong", () => {
    expect(verifyExecutionGrant("meta.campaign.pause", PARAMS, { userId: USER, inputMode: "voice" })).toEqual({
      ok: false,
      refusal: "spoken",
    });
  });
});

describe("Phase 19.1 — every Meta Ads write checks the grant first (source)", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools", "meta-ads-write-tools.ts"),
    "utf8"
  ).replace(/\r\n/g, "\n");

  it("opens each of the nine execute methods with the grant check", () => {
    const signature = "  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {\n";
    const bodies = source.split(signature).slice(1);
    expect(bodies).toHaveLength(9);
    for (const body of bodies) {
      const firstStatement = body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("//"))[0];
      expect(firstStatement).toBe("const refused = executorGrantRefusal(this.id, params, context);");
    }
  });

  it("has no claim of its own: only the approval store claims a Meta write", () => {
    expect(source).not.toContain("claimForExecution(");
    expect(source).not.toContain("claimExecution(");
  });
});
