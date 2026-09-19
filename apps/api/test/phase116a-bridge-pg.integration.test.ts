// =============================================================================
// PHASE 11.6A — REAL PostgreSQL durability for the recommendation bridge.
//
// Proves, against the actual database (not in-memory fakes):
//   - end-to-end PROPOSED -> APPROVAL_PENDING -> (human approve) -> EXECUTED
//     with approval consumption + journal claim + rec linkage persisted,
//   - concurrent duplicate execution is single-winner under REAL row locks,
//   - stale-state protection quarantines durably (§11),
//   - TTL expiry quarantines durably (§16),
//   - conflicting recommendations neutralize via stale state (§15),
//   - draining refuses BEFORE burning an approval (§17),
//   - cross-user IDOR safety,
//   - audit rows persist with bindings and WITHOUT secrets/evidence blobs.
//
// Every side effect flows through the REAL ToolExecutor + REAL Prisma
// approval/journal repositories against the mock Meta provider — no network
// is possible by construction. Dedicated test users are removed afterwards.
// =============================================================================

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@jarvis/db";
import {
  ShutdownLifecycle,
  buildExecutableParams,
  computeExternalStateHash,
  computeParamsHash,
  type ExternalEntityState,
  type IPermissionChecker,
  type RecommendationRecord,
  type Role,
} from "@jarvis/core";
import {
  MetaGetAdSetsTool,
  MetaGetAdsTool,
  MetaGetCampaignsTool,
  MetaUpdateCampaignBudgetTool,
  RecommendationExecutionService,
  ToolExecutor,
  ToolRegistry,
  createExecutorBackedExternalStatePort,
  createMockMetaProvider,
} from "@jarvis/tools";
import type { MetaAccountAuthorizer } from "@jarvis/tools";
import {
  PrismaApprovalRepository,
  PrismaAuditRepository,
  PrismaRecommendationRepository,
  PrismaToolExecutionRepository,
} from "@jarvis/db";
import { ApprovalService, AuditLogger } from "@jarvis/security";

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

const ACCOUNT = "act_111111111"; // mock default account (USD)
const CAMPAIGN_ID = "100000001"; // mock default ACTIVE campaign, dailyBudget "100.00"
const ROLE: Role = "owner";

const allowAllPerms: IPermissionChecker = { hasPermission: () => true };

function createAuthorizer(authorized: string[] = [ACCOUNT]): MetaAccountAuthorizer {
  return {
    getAuthorizedAccountIds: async () => authorized,
    isAuthorized: async (_userId: string, accountId: string) =>
      authorized.includes(accountId),
  };
}

interface PgHarness {
  userId: string;
  service: RecommendationExecutionService;
  repo: PrismaRecommendationRepository;
  provider: ReturnType<typeof createMockMetaProvider>;
  budgetWrites: string[];
}

const createdUserIds: string[] = [];
// MarketingAccount.accountId is GLOBALLY unique — create/share a single row
// for the whole run regardless of how many harness users participate.
let accountEnsured = false;

async function ensureMarketingAccount(userId: string): Promise<void> {
  if (accountEnsured) return;
  const existing = await prisma.marketingAccount.findUnique({ where: { accountId: ACCOUNT } });
  if (!existing) {
    await prisma.marketingAccount
      .create({ data: { userId, accountId: ACCOUNT, name: "PG Bridge Test Account" } })
      .catch(() => {}); // lost a race against a parallel file — fine
  }
  accountEnsured = true;
}

async function buildPgHarness(opts: { lifecycle?: ShutdownLifecycle } = {}): Promise<PgHarness> {
  const user = await prisma.user.create({
    data: {
      email: `phase116a-pgtest-${Date.now()}-${Math.floor(Math.random() * 1e6)}@jarvis-test.local`,
      name: "Phase 11.6A Bridge PG Test",
      password: "not-a-real-password-hash",
      role: "OWNER",
    },
  });
  createdUserIds.push(user.id);
  const userId = user.id;

  await ensureMarketingAccount(userId);

  const provider = createMockMetaProvider();
  const budgetWrites: string[] = [];
  const rawUpdate = provider.updateCampaignBudget.bind(provider);
  provider.updateCampaignBudget = ((accountId: string, campaignId: string, dailyBudget: string) => {
    budgetWrites.push(`${campaignId}->${dailyBudget}`);
    return rawUpdate(accountId, campaignId, dailyBudget);
  }) as typeof provider.updateCampaignBudget;

  const authorizer = createAuthorizer();

  // Real Phase 10/11 infrastructure.
  const repo = new PrismaRecommendationRepository(prisma);
  const approvalRepo = new PrismaApprovalRepository(prisma);
  const approvalService = new ApprovalService(approvalRepo);
  const toolExecRepo = new PrismaToolExecutionRepository(prisma);
  const auditLogger = new AuditLogger(new PrismaAuditRepository(prisma));

  const registry = new ToolRegistry();
  registry.register(new MetaGetCampaignsTool(provider, authorizer));
  registry.register(new MetaGetAdSetsTool(provider, authorizer));
  registry.register(new MetaGetAdsTool(provider, authorizer));
  // The REAL PrismaApprovalRepository performs the PAIRED one-time
  // consumption + journal claim inside a single transaction.
  registry.register(
    new MetaUpdateCampaignBudgetTool(provider, authorizer, undefined, toolExecRepo, approvalRepo)
  );

  const executor = new ToolExecutor(registry, allowAllPerms, approvalService, auditLogger, {
    lifecycle: opts.lifecycle,
  });

  const service = new RecommendationExecutionService({
    executor,
    recommendations: repo,
    journal: {
      getById: (id) => toolExecRepo.getById(id),
      findRecentByTool: async (uid, toolId) => {
        const approval = await approvalService.findExistingForTool(toolId, uid);
        if (!approval) return [];
        const row = await toolExecRepo.findLatestByApprovalId(approval.id);
        return row ? [row] : [];
      },
    },
    approvals: approvalService,
    // `input` is threaded BOTH into the factory context (which is where this
    // port actually reads identity from) and through as the third argument the
    // contract declares — the same shape production uses in AnalysisGenerator.
    stateOf: (accountId, entityId, input) =>
      createExecutorBackedExternalStatePort({
        executor,
        userId: input.userId,
        role: input.role as Role,
      })(accountId, entityId, input),
    authorizer,
    audit: auditLogger,
  });

  return { userId, service, repo, provider, budgetWrites };
}

function makeEvidence(accountId = ACCOUNT, entityId = CAMPAIGN_ID) {
  return {
    schemaVersion: 1 as const,
    accountId,
    entityLevel: "CAMPAIGN" as const,
    entityId,
    currency: "USD",
    timezone: "UTC",
    performanceWindow: { startDate: "2026-08-16", endDate: "2026-08-22" },
    currentMetrics: {},
    metricDetails: [],
    anomalies: [],
    dataQuality: "COMPLETE" as const,
    freshness: "FRESH" as const,
    relevantContext: { labels: [], notes: [] },
    evidenceHash: computeParamsHash({ accountId, entityId, salt: "ev116a" }),
    builtAt: new Date().toISOString(),
  };
}

/** Internally consistent INCREASE_BUDGET proposal bound to live mock state. */
function makeRecord(
  userId: string,
  overrides: Partial<RecommendationRecord> & { requestedDailyBudget?: number } = {}
): RecommendationRecord {
  const requested = overrides.requestedDailyBudget ?? 120;
  const nowMs = Date.now();
  const state: ExternalEntityState = {
    status: "ACTIVE",
    objective: "BRAND_AWARENESS", // mirrors mock fixture for campaign 100000001
    dailyBudget: 100,
    lifetimeBudget: null,
    targetingFingerprint: null,
  };
  const params = buildExecutableParams("INCREASE_BUDGET", ACCOUNT, CAMPAIGN_ID, requested, "CAMPAIGN");
  const base: RecommendationRecord = {
    schemaVersion: 1,
    recommendationId: `rec_${crypto.randomUUID()}`,
    userId,
    accountId: ACCOUNT,
    entityLevel: "CAMPAIGN",
    entityId: CAMPAIGN_ID,
    diagnosisId: `diag_${crypto.randomUUID()}`,
    anomalyIds: [],
    actionType: "INCREASE_BUDGET",
    currentState: { status: "ACTIVE", dailyBudget: 100 },
    proposedState: { dailyBudget: requested },
    reason: "PG bridge test case",
    evidence: makeEvidence(),
    expectedImpact: {
      metric: "SPEND",
      direction: "INCREASE",
      estimatedRange: "NOT_ESTIMATED",
      rationale: "Test rationale.",
    },
    risk: "LOW",
    confidence: "HIGH",
    // Both carry a schema default (priority "MEDIUM", historicalEvidenceIds
    // []), so these are the values a parsed record would hold. Required by
    // RecommendationRecord; previously masked by the evidence-shape error.
    priority: "MEDIUM",
    historicalEvidenceIds: [],
    preconditions: ["state unchanged"],
    paramsHash: computeParamsHash(params),
    stateHash: computeExternalStateHash(ACCOUNT, CAMPAIGN_ID, state),
    identityHash: "",
    status: "PROPOSED",
    requiresApproval: true,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 30 * 60_000).toISOString(),
    staleReasons: [],
    ...overrides,
  };
  // Random identity salt dodges the active-identity unique index between
  // records/tests that would otherwise be deduplicated as identical intent.
  base.identityHash = computeParamsHash({
    k: "identity",
    salt: crypto.randomUUID(),
    accountId: base.accountId,
    entityId: base.entityId,
    diagnosisId: base.diagnosisId,
    actionType: base.actionType,
    paramsHash: base.paramsHash,
    evidenceHash: base.evidence.evidenceHash,
  });
  return base;
}

/** Human approve step through the real Phase 10 workflow primitive. */
async function humanApprove(approvalId: string, userId: string): Promise<void> {
  const decider = new PrismaApprovalRepository(prisma);
  const decided = await decider.decideApproval(approvalId, userId, "approve");
  expect(decided).toMatchObject({ outcome: "approved" });
}

afterAll(async () => {
  if (dbUp) {
    await prisma.marketingAccount.deleteMany({ where: { accountId: ACCOUNT } }).catch(() => {});
    for (const userId of createdUserIds) {
      await prisma.toolExecution.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.approval.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.performanceRecommendation.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
  }
  await prisma.$disconnect();
});

describe.skipIf(!dbUp)("PHASE 11.6A — recommendation bridge on real PostgreSQL", () => {
  it("runs the full lifecycle with durable linkage", async () => {
    const h = await buildPgHarness();
    const rec = makeRecord(h.userId);
    await h.repo.save(rec);

    // 1. First attempt stops at the approval boundary; a PENDING approval
    //    row is created bound to the rec's paramsHash; nothing is consumed.
    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: h.userId, role: ROLE });
    expect(first.status).toBe("APPROVAL_PENDING");
    const approvalId = (first as { approvalId?: string }).approvalId!;
    expect(approvalId).toBeTruthy();
    expect(h.budgetWrites).toHaveLength(0);

    let approvalRow = await prisma.approval.findUnique({ where: { id: approvalId } });
    expect(approvalRow?.status).toBe("PENDING");
    expect(approvalRow?.paramsHash).toBe(rec.paramsHash);

    // 2. A human approves through the real approval workflow primitive.
    await humanApprove(approvalId, h.userId);

    // 3. Second attempt executes through the REAL executor chain.
    const second = await h.service.execute({ recommendationId: rec.recommendationId, userId: h.userId, role: ROLE });
    expect(second.status).toBe("EXECUTED");
    expect(h.budgetWrites).toEqual([`${CAMPAIGN_ID}->120.00`]); // EXACT single write

    // Durable linkage on the recommendation row.
    const stored = await h.repo.getForUser(rec.recommendationId, h.userId);
    expect(stored?.status).toBe("EXECUTED");
    expect(stored?.approvalId).toBe(approvalId);
    expect(stored?.executionId).toBeTruthy();

    // The consumed approval row is CONSUMED and hash-bound.
    approvalRow = await prisma.approval.findUnique({ where: { id: approvalId } });
    expect(approvalRow?.status).toBe("CONSUMED");

    // The journal row reached SUCCEEDED with the external resource id.
    const execRow = await prisma.toolExecution.findFirst({
      where: { userId: h.userId, toolId: "meta.campaign.budget.update" },
    });
    expect(execRow?.status).toBe("SUCCEEDED");
    expect(execRow?.externalResourceId).toBe(CAMPAIGN_ID);
    expect(execRow?.approvalId).toBe(approvalId);
    // The journal is bound to THIS budget change, not merely to some execution
    // of this tool. `ToolExecution` persists no result payload by design, so
    // `resultSummary` — a field of N8nExecution, a different subsystem — never
    // existed here: it read as undefined and the `?? execRow` fallback matched
    // "120" anywhere in the serialised row. The value is genuinely carried on
    // the idempotency key, built as `budget:${requestedBudget}` in
    // MetaUpdateCampaignBudgetTool, so that is what this asserts.
    expect(execRow?.idempotencyKey).toContain("budget:120");
  }, 30_000);

  it("is single-winner under x2 concurrent execution (real row locks)", async () => {
    const h = await buildPgHarness();
    const rec = makeRecord(h.userId);
    await h.repo.save(rec);

    const pending = await h.service.execute({ recommendationId: rec.recommendationId, userId: h.userId, role: ROLE });
    expect(pending.status).toBe("APPROVAL_PENDING");
    await humanApprove((pending as { approvalId?: string }).approvalId!, h.userId);

    const input = { recommendationId: rec.recommendationId, userId: h.userId, role: ROLE };
    const results = await Promise.all([h.service.execute(input), h.service.execute(input)]);

    expect(results.filter((r) => r.status === "EXECUTED")).toHaveLength(1);
    for (const r of results) {
      if (r.status !== "EXECUTED") {
        // P1-2: three outcomes are legal for the LOSER of this race, and which
        // one appears depends on how far it got before the winner consumed the
        // approval. `APPROVAL_PENDING` is the case where it got far enough to
        // find no live approval and ask for a new one — the bridge's own branch
        // for it states "Nothing consumed, nothing written", and the invariants
        // below still prove that: one EXECUTED, one provider write, one
        // SUCCEEDED journal row. Listing only the first two made a safe,
        // expected interleaving look like a failure roughly one run in three.
        expect([
          "DUPLICATE_EXECUTION_BLOCKED",
          "APPROVAL_ALREADY_CONSUMED",
          "APPROVAL_PENDING",
        ]).toContain(r.status);
      }
    }
    expect(h.budgetWrites).toHaveLength(1); // exactly ONE provider mutation

    // Exactly ONE SUCCEEDED journal row for this user/tool; rec linked once.
    const rows = await prisma.toolExecution.findMany({
      where: { userId: h.userId, toolId: "meta.campaign.budget.update" },
    });
    expect(rows.filter((r) => r.status === "SUCCEEDED")).toHaveLength(1);
    const stored = await h.repo.getForUser(rec.recommendationId, h.userId);
    expect(stored?.status).toBe("EXECUTED");
  }, 30_000);

  it("quarantines STALE durably when live state drifted after approval (§11)", async () => {
    const h = await buildPgHarness();
    const rec = makeRecord(h.userId);
    await h.repo.save(rec);

    const pending = await h.service.execute({ recommendationId: rec.recommendationId, userId: h.userId, role: ROLE });
    const approvalId = (pending as { approvalId?: string }).approvalId!;
    await humanApprove(approvalId, h.userId);

    // Simulate EXTERNAL drift through the provider's own public method —
    // the recorded state hash (100) no longer matches live (150).
    await h.provider.updateCampaignBudget(ACCOUNT, CAMPAIGN_ID, "150.00");
    h.budgetWrites.length = 0; // the drift write itself is not under test

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: h.userId, role: ROLE });
    expect(out.status).toBe("STALE_RECOMMENDATION");
    expect(h.budgetWrites).toHaveLength(0); // blocked BEFORE the write

    const stored = await h.repo.getForUser(rec.recommendationId, h.userId);
    expect(stored?.status).toBe("STALE");
    expect(stored?.staleReasons?.length).toBeGreaterThan(0);

    // The approval was NOT burned — it stays APPROVED.
    const approvalRow = await prisma.approval.findUnique({ where: { id: approvalId } });
    expect(approvalRow?.status).toBe("APPROVED");
  }, 30_000);

  it("quarantines expired recommendations durably (§16)", async () => {
    const h = await buildPgHarness();
    const rec = makeRecord(h.userId, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await h.repo.save(rec);

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: h.userId, role: ROLE });
    expect(out.status).toBe("RECOMMENDATION_EXPIRED");
    expect(h.budgetWrites).toHaveLength(0);

    const stored = await h.repo.getForUser(rec.recommendationId, h.userId);
    expect(stored?.status).toBe("EXPIRED");
  }, 30_000);

  it("neutralizes conflicting recommendations; exactly one write lands (§15)", async () => {
    const h = await buildPgHarness();
    const increase = makeRecord(h.userId, { requestedDailyBudget: 120 });
    const decrease = makeRecord(h.userId, { requestedDailyBudget: 80 }); // both valid vs 100
    await h.repo.save(increase);
    await h.repo.save(decrease);

    const p1 = await h.service.execute({ recommendationId: increase.recommendationId, userId: h.userId, role: ROLE });
    const p2 = await h.service.execute({ recommendationId: decrease.recommendationId, userId: h.userId, role: ROLE });
    await humanApprove((p1 as { approvalId?: string }).approvalId!, h.userId);
    await humanApprove((p2 as { approvalId?: string }).approvalId!, h.userId);

    const r1 = await h.service.execute({ recommendationId: increase.recommendationId, userId: h.userId, role: ROLE });
    expect(r1.status).toBe("EXECUTED"); // live budget now 120

    const r2 = await h.service.execute({ recommendationId: decrease.recommendationId, userId: h.userId, role: ROLE });
    expect(r2.status).toBe("STALE_RECOMMENDATION"); // recorded state (100) vs live (120)

    expect(h.budgetWrites).toEqual([`${CAMPAIGN_ID}->120.00`]); // exactly ONE mutation total
  }, 30_000);

  it("refuses to execute while draining WITHOUT burning the approval (§17)", async () => {
    const lifecycle = new ShutdownLifecycle();
    const h = await buildPgHarness({ lifecycle });
    const rec = makeRecord(h.userId);
    await h.repo.save(rec);

    const pending = await h.service.execute({ recommendationId: rec.recommendationId, userId: h.userId, role: ROLE });
    expect(pending.status).toBe("APPROVAL_PENDING");
    const approvalId = (pending as { approvalId?: string }).approvalId!;
    await humanApprove(approvalId, h.userId);

    // Begin draining AFTER approval but BEFORE execution.
    lifecycle.beginDraining("pg-test");

    const out = await h.service.execute({ recommendationId: rec.recommendationId, userId: h.userId, role: ROLE });
    expect(out.status).toBe("DRAINING");
    expect(h.budgetWrites).toHaveLength(0);

    const approvalRow = await prisma.approval.findUnique({ where: { id: approvalId } });
    expect(approvalRow?.status).toBe("APPROVED"); // NOT consumed

    // The executor's admission gate fires BEFORE the bridge records any
    // lifecycle edge, so the rec legitimately stays PROPOSED.
    const stored = await h.repo.getForUser(rec.recommendationId, h.userId);
    expect(stored?.status).toBe("PROPOSED");
  }, 30_000);

  it("blocks cross-user access (IDOR) at the durable store layer", async () => {
    const h = await buildPgHarness();
    const attacker = await buildPgHarness(); // separate user + stack
    const rec = makeRecord(h.userId);
    await h.repo.save(rec);

    const out = await attacker.service.execute({
      recommendationId: rec.recommendationId,
      userId: attacker.userId,
      role: ROLE,
    });
    expect(out.status).toBe("RECOMMENDATION_NOT_FOUND");
    expect(h.budgetWrites).toHaveLength(0);
    expect(attacker.budgetWrites).toHaveLength(0);

    const stored = await h.repo.getForUser(rec.recommendationId, h.userId);
    expect(stored?.status).toBe("PROPOSED"); // untouched
  }, 30_000);

  it("persists audit entries with bindings and WITHOUT secrets or evidence blobs (§18/§19)", async () => {
    const h = await buildPgHarness();
    const rec = makeRecord(h.userId);
    await h.repo.save(rec);

    const first = await h.service.execute({ recommendationId: rec.recommendationId, userId: h.userId, role: ROLE });
    await humanApprove((first as { approvalId?: string }).approvalId!, h.userId);
    const second = await h.service.execute({ recommendationId: rec.recommendationId, userId: h.userId, role: ROLE });
    expect(second.status).toBe("EXECUTED");

    const rows = await prisma.auditLog.findMany({
      where: { userId: h.userId, action: "recommendation.execute" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(2); // PENDING + EXECUTED
    const outcomes = rows.map((r) => (r.parameters as { outcome?: string })?.outcome);
    expect(outcomes).toContain("APPROVAL_PENDING");
    expect(outcomes).toContain("EXECUTED");

    for (const row of rows) {
      expect(row.toolId).toBe("recommendation.execute");
      const blob = JSON.stringify(row.parameters ?? {});
      expect(blob).toContain(rec.recommendationId); // bindings present
      // No evidence internals, no hashes-of-secrets, no tokens.
      expect(blob).not.toContain("currentMetrics");
      expect(blob).not.toContain("performanceWindow");
      expect(blob).not.toContain(rec.evidence.evidenceHash);
      expect(blob.toLowerCase()).not.toContain("token");
      const result = String(row.result).toLowerCase();
      expect(result === "success" || result === "pending").toBe(true);
    }
  }, 30_000);
});
