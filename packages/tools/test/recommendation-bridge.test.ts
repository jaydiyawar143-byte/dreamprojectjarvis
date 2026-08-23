// =============================================================================
// Phase 11.6A — Recommendation → Safe Execution Bridge
//
// Unit + architectural tests. The bridge MUST:
//   1. route EVERY side effect through the existing Phase 10 ToolExecutor,
//   2. never import or touch MetaGraphClient / network transport directly,
//   3. enforce the explicit action→tool allowlist,
//   4. re-derive paramsHash/stateHash server-side and block on any mismatch,
//   5. stop dry-runs exactly at the ToolExecutor boundary,
//   6. classify outcomes deterministically (incl. AMBIGUOUS_OUTCOME).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ACTION_CATALOG,
  ShutdownLifecycle,
  buildExecutableParams,
  computeExternalStateHash,
  computeParamsHash,
  isBudgetAction,
  SERVICE_SHUTTING_DOWN_ERROR,
  type ApprovalStatus,
  type AuditLogger,
  type EvidencePackage,
  type ExternalEntityState,
  type IApprovalManager,
  type IPermissionChecker,
  type RecommendationAction,
  type RecommendationRecord,
  type RecommendationStatus,
  type Role,
} from "@jarvis/core";

import {
  MetaGetAdSetsTool,
  MetaGetAdsTool,
  MetaGetCampaignsTool,
} from "../src/tools/meta-ads-tools.js";
import {
  MetaPauseCampaignTool,
  MetaResumeCampaignTool,
  MetaUpdateCampaignBudgetTool,
  clearExecutionStore,
} from "../src/tools/meta-ads-write-tools.js";
import { createMockMetaProvider } from "../src/tools/meta-ads-mock.js";
import type {
  MetaAccountAuthorizer,
  MetaAdsProvider,
} from "../src/tools/meta-ads-provider.js";
import { ToolRegistry } from "../src/registry.js";
import { ToolExecutor } from "../src/executor.js";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import {
  RecommendationExecutionService,
  createExecutorBackedExternalStatePort,
  resolveToolForAction,
  type RecommendationExecutionOutcome,
  type RecommendationExecutionStorePort,
} from "../src/recommendation-bridge.js";

type FullProvider = MetaAdsProvider;

const ACCOUNT = "act_111111111"; // mock default account (USD)
const CAMPAIGN_ID = "100000001"; // mock default ACTIVE campaign, dailyBudget "100.00"
const USER = "user-1";
const ROLE: Role = "owner";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function createAuthorizer(authorized: string[] = [ACCOUNT]): MetaAccountAuthorizer {
  return {
    getAuthorizedAccountIds: vi.fn().mockResolvedValue(authorized),
    isAuthorized: vi
      .fn()
      .mockImplementation(async (_userId: string, accountId: string) =>
        authorized.includes(accountId)
      ),
  };
}

const allowAllPerms: IPermissionChecker = { hasPermission: () => true };
const denyWritePerms: IPermissionChecker = {
  hasPermission: (_r: Role, _res: string, action: string) => action === "read",
};

interface FakeApproval {
  id: string;
  userId: string;
  agentId?: string;
  toolId: string;
  action: string;
  params: Record<string, unknown>;
  paramsHash: string;
  status: ApprovalStatus;
  expiresAt: string;
  createdAt: string;
  consumed?: boolean;
}

function createApprovalHarness(journal: MemoryExecutionJournal) {
  const approvals = new Map<string, FakeApproval>();
  let counter = 0;

  const mgr = {
    requestApproval: vi.fn(
      async (
        req: Omit<FakeApproval, "id" | "status" | "createdAt" | "consumed">
      ): Promise<FakeApproval> => {
        counter++;
        const a: FakeApproval = {
          ...req,
          paramsHash: computeParamsHash(req.params),
          id: `appr-${counter}`,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        approvals.set(a.id, a);
        return a;
      }
    ),
    findExistingForTool: vi.fn(async (toolId: string, userId: string) => {
      for (const a of approvals.values()) {
        if (a.toolId === toolId && a.userId === userId) return a;
      }
      return null;
    }),
  } as unknown as IApprovalManager;

  const consumption = {
    calls: [] as string[],
    consumeForExecution: vi.fn(
      async (input: {
        approvalId: string;
        toolId: string;
        userId: string;
        paramsHash: string;
        executionId: string;
      }) => {
        consumption.calls.push(input.approvalId);
        const a = approvals.get(input.approvalId);
        if (!a) return { ok: false as const, reason: "approval not found" };
        if (a.status === "expired")
          return { ok: false as const, reason: "approval is expired" };
        if (a.status !== "approved")
          return { ok: false as const, reason: `approval is ${a.status}` };
        if (a.consumed)
          return { ok: false as const, reason: "approval already consumed" };
        a.consumed = true;
        // Phase 10.3 contract: one-time consumption is PAIRED with the
        // durable execution claim in the same atomic step (the real
        // PrismaApprovalRepository does both in one transaction).
        await journal.claimForExecution(input.executionId, {
          ownerId: "fake-consumer",
          leaseMs: 60_000,
        });
        return { ok: true as const };
      }
    ),
  };

  return {
    mgr,
    approvals,
    consumption,
    approve: (id: string) => {
      const a = approvals.get(id);
      if (a) a.status = "approved";
    },
    reject: (id: string) => {
      const a = approvals.get(id);
      if (a) a.status = "rejected";
    },
  };
}

class MemoryRecommendationStore implements RecommendationExecutionStorePort {
  rows = new Map<string, RecommendationRecord>();
  history: Array<{
    id: string;
    from: readonly RecommendationStatus[];
    to: RecommendationStatus;
  }> = [];

  async getForUser(id: string, userId: string): Promise<RecommendationRecord | null> {
    const r = this.rows.get(id);
    return r && r.userId === userId ? r : null;
  }

  async transition(
    id: string,
    userId: string,
    fromStatuses: readonly RecommendationStatus[],
    to: RecommendationStatus,
    patch?: { approvalId?: string; executionId?: string; staleReasons?: string[] }
  ): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.userId !== userId || !fromStatuses.includes(r.status)) return false;
    this.history.push({ id, from: [...fromStatuses], to });
    this.rows.set(id, {
      ...r,
      status: to,
      updatedAt: new Date().toISOString(),
      ...(patch?.approvalId !== undefined ? { approvalId: patch.approvalId } : {}),
      ...(patch?.executionId !== undefined ? { executionId: patch.executionId } : {}),
      ...(patch?.staleReasons ? { staleReasons: patch.staleReasons } : {}),
    });
    return true;
  }

  async linkExecution(
    id: string,
    userId: string,
    approvalId: string,
    executionId: string
  ): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.userId !== userId) return false;
    this.rows.set(id, { ...r, approvalId, executionId });
    return true;
  }

  transitionsOf(id: string): string[] {
    return this.history.filter((h) => h.id === id).map((h) => h.to);
  }
}

function trackingAudit(): { logger: AuditLogger; entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  return {
    logger: {
      log: vi.fn().mockImplementation(async (e: unknown) => {
        entries.push(e as Record<string, unknown>);
      }),
    } as AuditLogger,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Record factory — a valid INCREASE_BUDGET CAMPAIGN 100 -> 120 proposal bound
// to the live mock state (ACTIVE, dailyBudget 100).
// ---------------------------------------------------------------------------

function makeEvidence(accountId = ACCOUNT, entityId = CAMPAIGN_ID): EvidencePackage {
  return {
    schemaVersion: 1,
    accountId,
    entityLevel: "CAMPAIGN",
    entityId,
    currency: "USD",
    timezone: "UTC",
    performanceWindow: { startDate: "2026-08-16", endDate: "2026-08-22" },
    currentMetrics: {},
    metricDetails: [],
    anomalies: [],
    dataQuality: "COMPLETE",
    freshness: "FRESH",
    relevantContext: {},
    evidenceHash: "e".repeat(32),
    builtAt: new Date().toISOString(),
  };
}

interface RecordOverrides {
  actionType?: RecommendationAction;
  entityLevel?: "CAMPAIGN" | "AD_SET";
  currentBudget?: number;
  requestedDailyBudget?: number;
  status?: RecommendationStatus;
  expiresInMs?: number;
  userId?: string;
  accountId?: string;
  entityId?: string;
}

function makeRecord(o: RecordOverrides = {}): RecommendationRecord {
  const actionType = o.actionType ?? "INCREASE_BUDGET";
  const level = o.entityLevel ?? "CAMPAIGN";
  const accountId = o.accountId ?? ACCOUNT;
  const entityId = o.entityId ?? CAMPAIGN_ID;
  const userId = o.userId ?? USER;
  const currentBudget = o.currentBudget ?? 100;
  const requested = o.requestedDailyBudget ?? 120;
  const nowMs = Date.now();

  const state: ExternalEntityState = {
    status: "ACTIVE",
    // Must mirror the LIVE mock fixture (campaign 100000001) so the state
    // hash binds to what the executor-backed state port will observe.
    objective: "BRAND_AWARENESS",
    dailyBudget: isBudgetAction(actionType) ? currentBudget : null,
    lifetimeBudget: null,
    targetingFingerprint: null,
  };
  const params = buildExecutableParams(
    actionType,
    accountId,
    entityId,
    isBudgetAction(actionType) ? requested : undefined,
    isBudgetAction(actionType) ? level : undefined
  );

  return {
    schemaVersion: 1,
    recommendationId: `rec-${Math.random().toString(36).slice(2, 10)}`,
    userId,
    accountId,
    entityLevel: level,
    entityId,
    diagnosisId: "diag-test",
    anomalyIds: [],
    actionType,
    currentState: {},
    proposedState: isBudgetAction(actionType)
      ? { dailyBudget: requested }
      : { status: "PAUSED" },
    reason: "unit test fixture",
    evidence: makeEvidence(accountId, entityId),
    expectedImpact: {
      metric: "SPEND",
      direction: "INCREASE",
      estimatedRange: "NOT_ESTIMATED",
      rationale: "unit test",
    },
    risk: "MEDIUM",
    confidence: "HIGH",
    preconditions: [],
    paramsHash: computeParamsHash(params),
    stateHash: computeExternalStateHash(accountId, entityId, state),
    identityHash: "i".repeat(32),
    status: o.status ?? "PROPOSED",
    requiresApproval: true,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + (o.expiresInMs ?? 60 * 60 * 1000)).toISOString(),
    staleReasons: [],
  };
}

// ---------------------------------------------------------------------------
// Harness — REAL ToolExecutor + REAL tools + mock provider.
// ---------------------------------------------------------------------------

async function buildHarness(opts: {
  perms?: IPermissionChecker;
  lifecycle?: ShutdownLifecycle;
  authorizer?: MetaAccountAuthorizer;
  budgetGuardrails?: {
    maxDailyBudget: number;
    maxIncreasePercent: number;
    maxIncreaseAbsolute: number;
    maxDecreasePercent: number;
    maxDecreaseAbsolute: number;
  };
} = {}) {
  clearExecutionStore();
  const provider = createMockMetaProvider();
  const budgetWrites: string[] = [];
  const rawUpdate = provider.updateCampaignBudget.bind(provider);
  provider.updateCampaignBudget = ((accountId: string, campaignId: string, dailyBudget: string) => {
    budgetWrites.push(`${campaignId}->${dailyBudget}`);
    return rawUpdate(accountId, campaignId, dailyBudget);
  }) as typeof provider.updateCampaignBudget;

  const authorizer = opts.authorizer ?? createAuthorizer();
  const journal = new MemoryExecutionJournal();
  const approvalHarness = createApprovalHarness(journal);
  const audit = trackingAudit();

  const registry = new ToolRegistry();
  registry.register(new MetaGetCampaignsTool(provider, authorizer));
  registry.register(new MetaGetAdSetsTool(provider, authorizer));
  registry.register(new MetaGetAdsTool(provider, authorizer));
  registry.register(new MetaPauseCampaignTool(provider, authorizer, journal, approvalHarness.consumption));
  registry.register(new MetaResumeCampaignTool(provider, authorizer, journal, approvalHarness.consumption));
  registry.register(
    new MetaUpdateCampaignBudgetTool(
      provider,
      authorizer,
      opts.budgetGuardrails,
      journal,
      approvalHarness.consumption
    )
  );

  const executorCallCounts = new Map<string, number>();
  const executor = new ToolExecutor(
    registry,
    opts.perms ?? allowAllPerms,
    approvalHarness.mgr,
    audit.logger,
    { lifecycle: opts.lifecycle }
  );
  const rawExecutorExecute = executor.execute.bind(executor);
  executor.execute = (async (req: Parameters<typeof executor.execute>[0]) => {
    executorCallCounts.set(req.toolId, (executorCallCounts.get(req.toolId) ?? 0) + 1);
    return rawExecutorExecute(req);
  }) as typeof executor.execute;

  const store = new MemoryRecommendationStore();
  const stateOf = (
    accountId: string,
    entityId: string,
    input: { userId: string; role: string }
  ) =>
    createExecutorBackedExternalStatePort({
      executor,
      userId: input.userId,
      role: input.role as Role,
    })(accountId, entityId);

  const service = new RecommendationExecutionService({
    executor,
    recommendations: store,
    journal: {
      getById: (id) => journal.getById(id),
      findRecentByTool: (userId, toolId, limit) =>
        journal.listByUserTool(userId, toolId, limit),
    },
    approvals: approvalHarness.mgr as unknown as Pick<
      IApprovalManager,
      "findExistingForTool"
    >,
    stateOf,
    authorizer,
    audit: audit.logger,
  });

  return {
    service,
    store,
    journal,
    provider,
    executor,
    executorCallCounts,
    writeToolCalls: () => executorCallCounts.get("meta.campaign.budget.update") ?? 0,
    registry,
    budgetWrites,
    approvals: approvalHarness.approvals,
    approve: approvalHarness.approve,
    reject: approvalHarness.reject,
    requestApprovalCalls: approvalHarness.mgr.requestApproval as ReturnType<typeof vi.fn>,
    consumptionCalls: approvalHarness.consumption.calls,
    auditEntries: audit.entries,
    addRecord: (r: RecommendationRecord) => store.rows.set(r.recommendationId, r),
  };
}

type Harness = Awaited<ReturnType<typeof buildHarness>>;

beforeEach(() => {
  clearExecutionStore();
});

// ===========================================================================
// 1. Allowlist mapping (spec §2)
// ===========================================================================

describe("allowlist mapping", () => {
  it("maps the six static actions to their exact Phase 9/10 tool ids", () => {
    expect(resolveToolForAction("PAUSE_CAMPAIGN", "CAMPAIGN")).toEqual({
      ok: true,
      toolId: "meta.campaign.pause",
    });
    expect(resolveToolForAction("RESUME_CAMPAIGN", "CAMPAIGN")).toEqual({
      ok: true,
      toolId: "meta.campaign.resume",
    });
    expect(resolveToolForAction("PAUSE_AD_SET", "AD_SET")).toEqual({
      ok: true,
      toolId: "meta.adset.pause",
    });
    expect(resolveToolForAction("RESUME_AD_SET", "AD_SET")).toEqual({
      ok: true,
      toolId: "meta.adset.resume",
    });
    expect(resolveToolForAction("PAUSE_AD", "AD")).toEqual({ ok: true, toolId: "meta.ad.pause" });
    expect(resolveToolForAction("RESUME_AD", "AD")).toEqual({ ok: true, toolId: "meta.ad.resume" });
  });

  it("routes budget actions per entity level", () => {
    expect(resolveToolForAction("INCREASE_BUDGET", "CAMPAIGN")).toEqual({
      ok: true,
      toolId: "meta.campaign.budget.update",
    });
    expect(resolveToolForAction("DECREASE_BUDGET", "CAMPAIGN")).toEqual({
      ok: true,
      toolId: "meta.campaign.budget.update",
    });
    expect(resolveToolForAction("INCREASE_BUDGET", "AD_SET")).toEqual({
      ok: true,
      toolId: "meta.adset.budget.update",
    });
    expect(resolveToolForAction("DECREASE_BUDGET", "AD_SET")).toEqual({
      ok: true,
      toolId: "meta.adset.budget.update",
    });
  });

  it("stays in parity with the core ACTION_CATALOG across all actions x levels", () => {
    const actions = Object.keys(ACTION_CATALOG) as RecommendationAction[];
    expect(actions).toHaveLength(8);
    for (const action of actions) {
      const levels = ["ACCOUNT", "CAMPAIGN", "AD_SET", "AD"] as const;
      for (const level of levels) {
        const expected = ACTION_CATALOG[action].allowedLevels.includes(level)
          ? { ok: true, toolId: ACTION_CATALOG[action].toolIdFor(level) }
          : null;
        const actual = resolveToolForAction(action, level);
        if (expected === null) {
          expect(actual.ok).toBe(false);
        } else {
          expect(actual).toEqual(expected);
        }
      }
    }
  });

  it("rejects unknown actions without ever deriving a tool name from data", () => {
    const result = resolveToolForAction("PAUSE_EVERYTHING" as RecommendationAction, "CAMPAIGN");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNKNOWN_ACTION");
  });

  it("rejects budget actions at AD level (no ad-level budget tool exists)", () => {
    const result = resolveToolForAction("INCREASE_BUDGET", "AD");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNSUPPORTED_LEVEL");
  });
});

// ===========================================================================
// 2. Architectural guarantees (spec §21/§25/§26/§27)
// ===========================================================================

describe("architectural guarantees", () => {
  const sourcePath = fileURLToPath(new URL("../src/recommendation-bridge.ts", import.meta.url));

  it("never imports a Meta client or HTTP transport directly", () => {
    const src = readFileSync(sourcePath, "utf8");
    expect(src).not.toMatch(/MetaGraphClient/);
    expect(src).not.toMatch(/@jarvis\/meta-graph/);
    expect(src).not.toMatch(/\baxios\b/);
    expect(src).not.toMatch(/node-fetch/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/require\(/);
  });

  it("depends only on @jarvis/core and relative modules", () => {
    const src = readFileSync(sourcePath, "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec.startsWith("@jarvis/core") || spec.startsWith(".")).toBe(true);
    }
  });

  it("routes every side effect through ToolExecutor.execute (counted)", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(first.status).toBe("APPROVAL_PENDING");
    expect(h.writeToolCalls()).toBe(1); // read tools (state port) excluded

    h.approve((first as { approvalId?: string }).approvalId!);
    const second = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(second.status).toBe("EXECUTED");
    expect(h.writeToolCalls()).toBe(2); // exactly one write attempt per execution
  });

  it("records the durable journal row as SUCCEEDED after EXECUTED", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    h.approve((first as { approvalId?: string }).approvalId!);
    const second = (await h.service.execute({
      recommendationId: rec.recommendationId,
      userId: USER,
      role: ROLE,
    })) as Extract<RecommendationExecutionOutcome, { status: "EXECUTED" }>;

    const row = await h.journal.getById(second.executionId);
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.externalResourceId).toBe(CAMPAIGN_ID);
  });
});

// ===========================================================================
// 3. Zero real Meta writes (spec §23/§24)
// ===========================================================================

describe("zero-network guarantee", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never invokes fetch on the happy path nor on any blocked path", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // Blocked paths (fresh harness each time keeps assertions independent).
    {
      const h = await buildHarness();
      const missing = makeRecord();
      const out1 = await h.service.execute({ recommendationId: missing.recommendationId, userId: USER, role: ROLE });
      expect(out1.status).toBe("RECOMMENDATION_NOT_FOUND");
    }
    {
      const h = await buildHarness();
      const tampered = makeRecord();
      tampered.proposedState = { dailyBudget: 500 };
      await h.addRecord(tampered);
      const out2 = await h.service.execute({ recommendationId: tampered.recommendationId, userId: USER, role: ROLE });
      expect(out2.status).toBe("PARAMS_HASH_MISMATCH");
    }
    {
      const h = await buildHarness();
      const drift = makeRecord();
      await h.addRecord(drift);
      // Simulate an external actor changing the budget behind our back.
      await h.provider.updateCampaignBudget(ACCOUNT, CAMPAIGN_ID, "150.00");
      const out3 = await h.service.execute({ recommendationId: drift.recommendationId, userId: USER, role: ROLE });
      expect(out3.status).toBe("STALE_RECOMMENDATION");
    }

    // Happy path.
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);
    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    h.approve((first as { approvalId?: string }).approvalId!);
    const second = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(second.status).toBe("EXECUTED");

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. Validation chain
// ===========================================================================

describe("validation chain", () => {
  it("returns RECOMMENDATION_NOT_FOUND for an unknown id", async () => {
    const h = await buildHarness();
    const out = await h.service.execute({ recommendationId: "rec-missing", userId: USER, role: ROLE });
    expect(out.status).toBe("RECOMMENDATION_NOT_FOUND");
  });

  it("enforces ownership (IDOR): another user cannot see or execute a record", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: "user-2", role: ROLE });
    expect(out.status).toBe("RECOMMENDATION_NOT_FOUND");
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("PROPOSED");
    expect(h.budgetWrites).toHaveLength(0);
  });

  it("is idempotent: executing an already-executed recommendation is refused", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    h.approve((first as { approvalId?: string }).approvalId!);
    const second = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(second.status).toBe("EXECUTED");

    const third = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(third.status).toBe("ALREADY_EXECUTED");
    expect(h.budgetWrites).toHaveLength(1); // no additional mutation
  });

  it("refuses terminal REJECTED records as NOT_EXECUTABLE", async () => {
    const h = await buildHarness();
    const rec = makeRecord({ status: "REJECTED" });
    await h.addRecord(rec);
    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out).toMatchObject({ status: "NOT_EXECUTABLE", recStatus: "REJECTED" });
  });

  it("quarantines expired recommendations durably", async () => {
    const h = await buildHarness();
    const rec = makeRecord({ expiresInMs: -1000 });
    await h.addRecord(rec);

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out.status).toBe("RECOMMENDATION_EXPIRED");
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("EXPIRED");
    expect(h.requestApprovalCalls).not.toHaveBeenCalled();
  });

  it("blocks mutated proposed params (100 approved vs 500 stored) via paramsHash", async () => {
    const h = await buildHarness();
    const rec = makeRecord(); // hash binds 120
    await h.addRecord(rec);

    // Attacker edits the stored record AFTER hash creation.
    const stored = h.store.rows.get(rec.recommendationId)!;
    stored.proposedState = { dailyBudget: 500 };

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out).toMatchObject({ status: "PARAMS_HASH_MISMATCH" });
    expect(JSON.stringify(h.store.rows.get(rec.recommendationId))).toBe(
      JSON.stringify(stored)
    ); // bridge did not mutate the record
    expect(h.budgetWrites).toHaveLength(0);
    expect(h.consumptionCalls).toHaveLength(0);
  });

  it("rejects a forged-but-well-formed paramsHash", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    rec.paramsHash = "f".repeat(64);
    await h.addRecord(rec);

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out.status).toBe("PARAMS_HASH_MISMATCH");
    expect(h.writeToolCalls()).toBe(0);
  });

  it("fails closed when the entity no longer exists (STALE quarantine)", async () => {
    const h = await buildHarness();
    const rec = makeRecord({ entityId: "999999999" }); // not in mock data
    await h.addRecord(rec);

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out.status).toBe("STALE_RECOMMENDATION");
    expect(out).toHaveProperty("reasons");
    expect((out as { reasons: string[] }).reasons.join(",")).toContain("ENTITY_NOT_FOUND");
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("STALE");
    expect(h.budgetWrites).toHaveLength(0);
  });

  it("hard-blocks on live state drift (spec §11 scenario: approved 120, live became 150)", async () => {
    const h = await buildHarness();
    const rec = makeRecord(); // bound to live 100
    await h.addRecord(rec);

    // Human approves; THEN someone else changes the external budget.
    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    h.approve((first as { approvalId?: string }).approvalId!);
    await h.provider.updateCampaignBudget(ACCOUNT, CAMPAIGN_ID, "150.00");
    h.budgetWrites.length = 0; // only the bridge-driven write counter matters below

    const second = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(second.status).toBe("STALE_RECOMMENDATION");
    expect((second as { reasons: string[] }).reasons.join(",")).toContain("BUDGET_CHANGED");
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("STALE");
    expect(h.budgetWrites).toHaveLength(0); // the burned approval wrote NOTHING
    expect(h.consumptionCalls).toHaveLength(0); // attempt #2 blocked BEFORE consumption
  });

  it("detects status drift between proposal and execution", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);
    await h.provider.updateCampaignStatus(ACCOUNT, CAMPAIGN_ID, "PAUSED");

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out.status).toBe("STALE_RECOMMENDATION");
    expect((out as { reasons: string[] }).reasons.join(",")).toContain("STATUS_CHANGED");
    expect(h.budgetWrites).toHaveLength(0);
  });

  it("denies accounts the user is not authorized for BEFORE any executor work", async () => {
    const h = await buildHarness({ authorizer: createAuthorizer([]) });
    const rec = makeRecord();
    await h.addRecord(rec);

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out.status).toBe("AUTHORIZATION_DENIED");
    expect(h.writeToolCalls()).toBe(0);
    expect(h.requestApprovalCalls).not.toHaveBeenCalled();
  });

  it("surfaces permission_denied from the executor without touching lifecycle state", async () => {
    const h = await buildHarness({ perms: denyWritePerms });
    const rec = makeRecord();
    await h.addRecord(rec);

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out.status).toBe("PERMISSION_DENIED");
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("PROPOSED");
  });

  it("treats schema-invalid action payloads as INVALID_RECOMMENDATION (fail closed)", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    (rec as { actionType: string }).actionType = "NUKE_FROM_ORBIT";
    await h.addRecord(rec);

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out.status).toBe("INVALID_RECOMMENDATION");
    expect(h.writeToolCalls()).toBe(0);
  });
});

// ===========================================================================
// 5. Dry-run (spec §9)
// ===========================================================================

describe("dry-run", () => {
  it("performs every validation then stops exactly at the executor boundary", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const out = (await h.service.execute({
      recommendationId: rec.recommendationId,
      userId: USER,
      role: ROLE,
      dryRun: true,
    })) as Extract<RecommendationExecutionOutcome, { status: "DRY_RUN_OK" }>;

    expect(out.status).toBe("DRY_RUN_OK");
    expect(out.toolId).toBe("meta.campaign.budget.update");
    expect(out.params).toEqual({
      accountId: ACCOUNT,
      campaignId: CAMPAIGN_ID,
      requestedDailyBudget: 120,
    });
    expect(out.stateHashVerified).toBe(true);
    expect(h.writeToolCalls()).toBe(0); // stopped BEFORE the write tool
    expect(h.requestApprovalCalls).not.toHaveBeenCalled();
    expect(h.budgetWrites).toHaveLength(0);
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("PROPOSED");
  });

  it("still refuses stale state in dry-run mode", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);
    await h.provider.updateCampaignBudget(ACCOUNT, CAMPAIGN_ID, "130.00");

    const out = await h.service.execute({
      recommendationId: rec.recommendationId,
      userId: USER,
      role: ROLE,
      dryRun: true,
    });
    expect(out.status).toBe("STALE_RECOMMENDATION");
  });
});

// ===========================================================================
// 6. Outcome classification through the REAL executor
// ===========================================================================

describe("outcome classification", () => {
  it("runs PROPOSED -> APPROVAL_PENDING -> (approve) -> EXECUTED end-to-end", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(first.status).toBe("APPROVAL_PENDING");
    expect(h.budgetWrites).toHaveLength(0);
    expect(h.consumptionCalls).toHaveLength(0);
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("PROPOSED");

    const approvalId = (first as { approvalId?: string }).approvalId!;
    h.approve(approvalId);

    const second = (await h.service.execute({
      recommendationId: rec.recommendationId,
      userId: USER,
      role: ROLE,
    })) as Extract<RecommendationExecutionOutcome, { status: "EXECUTED" }>;

    expect(second.status).toBe("EXECUTED");
    expect(second.approvalId).toBe(approvalId);
    expect(h.budgetWrites).toEqual([`${CAMPAIGN_ID}->120.00`]); // EXACT single write

    // Verify through the same public read path the state port uses.
    const live = await h.provider.getCampaigns(ACCOUNT, undefined);
    expect(live.data.find((c) => c.campaignId === CAMPAIGN_ID)?.dailyBudget).toBe("120.00");

    const stored = h.store.rows.get(rec.recommendationId)!;
    expect(stored.status).toBe("EXECUTED");
    expect(stored.approvalId).toBe(approvalId);
    expect(stored.executionId).toBe(second.executionId);
    expect(h.store.transitionsOf(rec.recommendationId)).toEqual([
      "APPROVED",
      "EXECUTING",
      "EXECUTED",
    ]);
  });

  it("keeps the recommendation recoverable when a human rejects the approval", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    const approvalId = (first as { approvalId?: string }).approvalId!;
    h.reject(approvalId);

    const second = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(second).toMatchObject({ status: "APPROVAL_DENIED" });
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("PROPOSED");
    expect(h.budgetWrites).toHaveLength(0);
  });

  it("requests a fresh approval when the approved one expired (old one untouched)", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    const oldId = (first as { approvalId?: string }).approvalId!;
    h.approve(oldId);
    const old = h.approvals.get(oldId)!;
    old.expiresAt = new Date(Date.now() - 1000).toISOString(); // silently age it

    const second = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(second.status).toBe("APPROVAL_PENDING");
    const newId = (second as { approvalId?: string }).approvalId!;
    expect(newId).not.toBe(oldId);
    expect(old.consumed).toBeFalsy();
    expect(h.budgetWrites).toHaveLength(0);
  });

  it("refuses NEW work while draining WITHOUT burning an approval (spec §17)", async () => {
    const lifecycle = new ShutdownLifecycle();
    const h = await buildHarness({ lifecycle });
    const rec = makeRecord();
    await h.addRecord(rec);

    lifecycle.beginDraining("unit-test");

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out.status).toBe("DRAINING");
    expect(h.requestApprovalCalls).not.toHaveBeenCalled();
    expect(h.consumptionCalls).toHaveLength(0);
    expect(h.budgetWrites).toHaveLength(0);
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("PROPOSED");
    void SERVICE_SHUTTING_DOWN_ERROR;
  });

  it("classifies pre-claim tool refusals as EXECUTION_BLOCKED (recoverable)", async () => {
    // Strict execution-layer guardrails (+10% cap) reject the same +20%
    // proposal the CORE guardrails accept — proving layered defense.
    const h = await buildHarness({
      budgetGuardrails: {
        maxDailyBudget: 500,
        maxIncreasePercent: 10,
        maxIncreaseAbsolute: 100,
        maxDecreasePercent: 20,
        maxDecreaseAbsolute: 200,
      },
    });
    const rec = makeRecord(); // +20% passes core guardrails
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(first.status).toBe("APPROVAL_PENDING");
    h.approve((first as { approvalId?: string }).approvalId!);

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(out.status).toBe("EXECUTION_BLOCKED");
    expect((out as { detail: string }).detail).toContain("Budget limit exceeded");
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("PROPOSED"); // recoverable
    expect(h.budgetWrites).toHaveLength(0);
  });

  it("maps post-claim UNKNOWN transport outcomes to AMBIGUOUS_OUTCOME and leaves the rec EXECUTING", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    const approvalId = (first as { approvalId?: string }).approvalId!;
    h.approve(approvalId);

    // Break ONLY the write call AFTER the claim/consume happened.
    h.provider.updateCampaignBudget = (async () => {
      throw new Error("socket hang up"); // ambiguous transport error
    }) as typeof h.provider.updateCampaignBudget;

    const second = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(second.status).toBe("AMBIGUOUS_OUTCOME");
    expect(second).toHaveProperty("executionId");

    const stored = h.store.rows.get(rec.recommendationId)!;
    expect(stored.status).toBe("EXECUTING"); // NEVER FAILED, NEVER EXECUTED

    const journalRow = await h.journal.getById((second as { executionId: string }).executionId);
    expect(journalRow?.status).toBe("UNKNOWN"); // reconciliation owns resolution
  });

  it("allows exactly ONE winner under concurrent duplicate execution", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    h.approve((first as { approvalId?: string }).approvalId!);

    const input = { recommendationId: rec.recommendationId, userId: USER, role: ROLE };
    const results = await Promise.all([h.service.execute(input), h.service.execute(input)]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toContain("EXECUTED");
    expect(results.filter((r) => r.status === "EXECUTED")).toHaveLength(1);
    for (const r of results) {
      if (r.status !== "EXECUTED") {
        expect(["DUPLICATE_EXECUTION_BLOCKED", "APPROVAL_ALREADY_CONSUMED"]).toContain(r.status);
      }
    }
    expect(h.budgetWrites).toHaveLength(1); // exactly one provider mutation
    expect(h.store.rows.get(rec.recommendationId)?.status).toBe("EXECUTED");
  });

  it("neutralizes conflicting recommendations via stale-state protection (spec §15)", async () => {
    const h = await buildHarness();
    const increase = makeRecord({ requestedDailyBudget: 120 });
    const decrease = makeRecord({ requestedDailyBudget: 80 }); // both valid vs 100
    await h.addRecord(increase);
    await h.addRecord(decrease);

    const p1 = await h.service.execute({ recommendationId: increase.recommendationId, userId: USER, role: ROLE });
    const p2 = await h.service.execute({ recommendationId: decrease.recommendationId, userId: USER, role: ROLE });
    h.approve((p1 as { approvalId?: string }).approvalId!);
    h.approve((p2 as { approvalId?: string }).approvalId!);

    const r1 = await h.service.execute({ recommendationId: increase.recommendationId, userId: USER, role: ROLE });
    expect(r1.status).toBe("EXECUTED"); // live budget now 120

    const r2 = await h.service.execute({ recommendationId: decrease.recommendationId, userId: USER, role: ROLE });
    expect(r2.status).toBe("STALE_RECOMMENDATION"); // recorded state (100) no longer matches live (120)

    expect(h.budgetWrites).toEqual([`${CAMPAIGN_ID}->120.00`]); // exactly ONE mutation total
  });
});

// ===========================================================================
// 7. Audit linkage (spec §18/§19)
// ===========================================================================

describe("audit linkage", () => {
  it("emits exactly one recommendation.execute entry per attempt with bindings and hashes", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    const bridgeEntries = () =>
      h.auditEntries.filter((e) => e["toolId"] === "recommendation.execute");
    expect(bridgeEntries()).toHaveLength(1);
    const e1 = JSON.stringify(bridgeEntries()[0]);
    expect(e1).toContain("recommendation.execute");
    expect(e1).toContain("APPROVAL_PENDING");
    expect(e1).toContain(rec.recommendationId);
    expect(e1).toContain(rec.paramsHash.slice(0, 12));

    h.approve((first as { approvalId?: string }).approvalId!);
    await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    expect(bridgeEntries()).toHaveLength(2);
    expect(JSON.stringify(bridgeEntries()[1])).toContain("EXECUTED");
  });

  it("audits EXECUTED with success severity and never leaks provider payloads", async () => {
    const h = await buildHarness();
    const rec = makeRecord();
    await h.addRecord(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });
    h.approve((first as { approvalId?: string }).approvalId!);
    await h.service.execute({ recommendationId: rec.recommendationId, userId: USER, role: ROLE });

    const executedEntry = h.auditEntries
      .filter((e) => e["toolId"] === "recommendation.execute")
      .at(-1);
    expect(executedEntry).toBeDefined();
    const serialized = JSON.stringify(executedEntry);
    expect(serialized).toContain("EXECUTED");
    expect(serialized).toContain('"success"');
    // Raw provider response fields must NOT be duplicated into the audit trail.
    expect(serialized).not.toContain("BRAND_AWARENESS");
    expect(serialized).not.toContain("campaignName");
  });
});
