// PHASE 11.5 — REAL PostgreSQL durability for recommendations.
// Proves: identity dedup under races (partial unique index), single-winner
// lifecycle transitions, TTL sweep, stale marking, cooldown/cooldown-family
// queries, per-account budget rate-limit counting, cross-user IDOR safety,
// audit rows without secrets, and full lifecycle persistence.
// Uses a dedicated test user removed afterwards (FK cascade).
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  computeParamsHash,
  computeExternalStateHash,
  buildExecutableParams,
} from "@jarvis/core";
import type { ExternalEntityState, RecommendationRecord } from "@jarvis/core";

function activeCampaignState(dailyBudget = 100): ExternalEntityState {
  return {
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    dailyBudget,
    lifetimeBudget: null,
    targetingFingerprint: "fp_default",
  };
}
import {
  PrismaRecommendationRepository,
  DuplicateRecommendationError,
} from "../src/repositories/recommendation-repository.js";

const prisma = new PrismaClient();

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

let testUserId: string | null = null;
let otherUserId: string | null = null;
let repo: PrismaRecommendationRepository;

const ACCOUNT_ID = `act_115_pgtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const ENTITY_ID = "cmp_115_pgtest";
const NOW_ISO = "2026-08-23T10:00:00.000Z";

function makeEvidence(accountId: string, entityId: string) {
  const window = { startDate: "2026-08-22", endDate: "2026-08-22" };
  return {
    schemaVersion: 1 as const,
    accountId,
    entityLevel: "CAMPAIGN" as const,
    entityId,
    currency: "USD",
    timezone: "UTC",
    performanceWindow: window,
    comparisonWindow: window,
    currentMetrics: { ctr: 1 },
    previousMetrics: { ctr: 4 },
    metricDetails: [],
    anomalies: [],
    dataQuality: "COMPLETE" as const,
    freshness: "FRESH" as const,
    relevantContext: { labels: [], notes: [] },
    evidenceHash: computeParamsHash({ accountId, entityId, salt: "ev" }),
    builtAt: NOW_ISO,
  };
}

/** Internally consistent PROPOSED DECREASE_BUDGET record. */
function makeRecord(overrides: Partial<RecommendationRecord> & { entityId?: string; userId?: string; diagnosisId?: string }): RecommendationRecord {
  const accountId = overrides.accountId ?? ACCOUNT_ID;
  const entityId = overrides.entityId ?? ENTITY_ID;
  const userId = overrides.userId ?? testUserId!;
  const state: ExternalEntityState = activeCampaignState(1000);
  const proposed = 800;
  const params = buildExecutableParams("DECREASE_BUDGET", accountId, entityId, proposed, "CAMPAIGN");
  const base: RecommendationRecord = {
    schemaVersion: 1,
    recommendationId: `rec_${crypto.randomUUID()}`,
    userId,
    accountId,
    entityLevel: "CAMPAIGN",
    entityId,
    diagnosisId: overrides.diagnosisId ?? "diag_115",
    anomalyIds: [],
    actionType: "DECREASE_BUDGET",
    currentState: { status: state.status, dailyBudget: state.dailyBudget ?? null },
    proposedState: { dailyBudget: proposed },
    reason: "CREATIVE_FATIGUE test case",
    evidence: makeEvidence(accountId, entityId),
    expectedImpact: {
      metric: "SPEND",
      direction: "DECREASE",
      estimatedRange: "NOT_ESTIMATED",
      rationale: "Test rationale.",
    },
    risk: "LOW",
    confidence: "HIGH",
    preconditions: ["state unchanged"],
    paramsHash: computeParamsHash(params),
    stateHash: computeExternalStateHash(accountId, entityId, state),
    identityHash: "",
    status: "PROPOSED",
    requiresApproval: true,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    // Relative to REAL wall-clock time: expireOverdue sweeps globally, so a
    // hardcoded same-day timestamp becomes stale as soon as the clock passes.
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    staleReasons: [],
  };
  const merged = { ...base, ...overrides };
  merged.identityHash =
    overrides.identityHash ??
    computeParamsHash({
      k: "identity",
      accountId: merged.accountId,
      entityId: merged.entityId,
      diagnosisId: merged.diagnosisId,
      actionType: merged.actionType,
      paramsHash: merged.paramsHash,
      evidenceHash: merged.evidence.evidenceHash,
    });
  return merged as RecommendationRecord;
}

beforeAll(async () => {
  if (!dbUp) return;
  repo = new PrismaRecommendationRepository(prisma);
  const user = await prisma.user.create({
    data: {
      email: `phase115-pgtest-${Date.now()}@jarvis-test.local`,
      name: "Phase 11.5 Recommendation Store Test",
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  testUserId = user.id;
  const other = await prisma.user.create({
    data: {
      email: `phase115-pgtest-other-${Date.now()}@jarvis-test.local`,
      name: "Phase 11.5 Other User",
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  otherUserId = other.id;
  await prisma.marketingAccount.create({
    data: {
      userId: testUserId,
      accountId: ACCOUNT_ID,
      name: "PG Test Account",
    },
  });
});
afterAll(async () => {
  if (testUserId) {
    await prisma.decisionRecord.deleteMany({ where: { accountId: ACCOUNT_ID } }).catch(() => {});
    await prisma.performanceRecommendation.deleteMany({ where: { userId: testUserId } }).catch(() => {});
    await prisma.marketingAccount.deleteMany({ where: { userId: testUserId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { userId: testUserId } }).catch(() => {});
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  }
  if (otherUserId) {
    await prisma.user.delete({ where: { id: otherUserId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe.skipIf(!dbUp)("PHASE 11.5 — real PostgreSQL recommendation store", () => {
  it("persists and reloads a bound record losslessly", async () => {
    if (!dbUp || !testUserId) return;
    const rec = makeRecord({});
    await repo.save(rec);
    const loaded = await repo.get(rec.recommendationId);
    expect(loaded).not.toBeNull();
    expect(loaded!.paramsHash).toBe(rec.paramsHash);
    expect(loaded!.stateHash).toBe(rec.stateHash);
    expect(loaded!.identityHash).toBe(rec.identityHash);
    expect(loaded!.status).toBe("PROPOSED");
    expect(loaded!.requiresApproval).toBe(true);
    expect(loaded!.actionType).toBe("DECREASE_BUDGET");
    expect((loaded!.proposedState["dailyBudget"] as number)).toBe(800);
    expect(loaded!.evidence.evidenceHash).toBe(rec.evidence.evidenceHash);
  });

  it("enforces ONE active row per identityHash under x2 insert race", async () => {
    if (!dbUp || !testUserId) return;
    const rec = makeRecord({ diagnosisId: "diag_race_1" });
    const results = await Promise.allSettled([
      repo.save(structuredClone(rec)),
      repo.save(structuredClone(rec)),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateRecommendationError);

    // Terminal status frees the identity for a NEW proposal.
    await repo.transition(rec.recommendationId, testUserId, ["PROPOSED"], "REJECTED");
    await expect(repo.save(makeRecord({ diagnosisId: "diag_race_1" }))).resolves.toBeUndefined();
  });

  it("findActiveByIdentity ignores terminal rows", async () => {
    if (!dbUp || !testUserId) return;
    const rec = makeRecord({ diagnosisId: "diag_active_lookup" });
    await repo.save(rec);
    expect(await repo.findActiveByIdentity(rec.identityHash)).not.toBeNull();
    await repo.transition(rec.recommendationId, testUserId!, ["PROPOSED"], "REJECTED");
    expect(await repo.findActiveByIdentity(rec.identityHash)).toBeNull();
  });

  it("x5 concurrent approve attempts produce exactly one winner", async () => {
    if (!dbUp || !testUserId) return;
    const rec = makeRecord({ diagnosisId: "diag_race_approve" });
    await repo.save(rec);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repo.transition(rec.recommendationId, testUserId!, ["PROPOSED"], "APPROVED")
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await repo.get(rec.recommendationId);
    expect(after!.status).toBe("APPROVED");
  });

  it("sweeps expired proposals to EXPIRED and keeps fresh ones", async () => {
    if (!dbUp || !testUserId) return;
    const overdue = makeRecord({
      diagnosisId: "diag_expired",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const fresh = makeRecord({ diagnosisId: "diag_fresh" });
    await repo.save(overdue);
    await repo.save(fresh);
    const changed = await repo.expireOverdue(new Date());
    expect(changed).toBeGreaterThanOrEqual(1);
    expect((await repo.get(overdue.recommendationId))!.status).toBe("EXPIRED");
    expect((await repo.get(fresh.recommendationId))!.status).toBe("PROPOSED");
  });

  it("marks STALE with machine-readable reasons", async () => {
    if (!dbUp || !testUserId) return;
    const rec = makeRecord({ diagnosisId: "diag_stale" });
    await repo.save(rec);
    const ok = await repo.markStale(rec.recommendationId, testUserId!, [
      "BUDGET_CHANGED",
      "STATUS_CHANGED",
    ]);
    expect(ok).toBe(true);
    const after = await repo.get(rec.recommendationId);
    expect(after!.status).toBe("STALE");
    expect(after!.staleReasons).toEqual(["BUDGET_CHANGED", "STATUS_CHANGED"]);
  });

  it("cooldown lookup returns the most recent related action regardless of status", async () => {
    if (!dbUp || !testUserId) return;
    const entity = `${ENTITY_ID}_cool_${Date.now()}`;
    const a = makeRecord({
      entityId: entity,
      diagnosisId: "diag_cool_a",
      createdAt: "2026-08-23T09:00:00.000Z",
    });
    const b = makeRecord({
      entityId: entity,
      diagnosisId: "diag_cool_b",
      createdAt: "2026-08-23T09:30:00.000Z",
      actionType: "INCREASE_BUDGET",
    });
    await repo.save(a);
    await repo.save(b);
    const hit = await repo.findMostRecentByActions(ACCOUNT_ID, entity, [
      "DECREASE_BUDGET",
      "INCREASE_BUDGET",
    ]);
    expect(hit?.actionType).toBe("INCREASE_BUDGET");
    // createdAt is persisted verbatim, so the explicit fixture timestamps win.
    const bPersisted = (await repo.get(b.recommendationId))!;
    expect(hit?.createdAt).toBe(bPersisted.createdAt);
    expect(new Date(hit!.createdAt).getTime()).toBeGreaterThan(
      new Date("2026-08-23T09:00:00.000Z").getTime()
    );
  });

  it("counts budget actions per account inside the window only", async () => {
    if (!dbUp || !testUserId) return;
    // Dedicated account: isolates this count from sibling tests in the run.
    const budgetAccount = `act_115_budget_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await prisma.marketingAccount.create({
      data: { userId: testUserId, accountId: budgetAccount, name: "Budget Count Account" },
    });
    try {
      const old = makeRecord({
        accountId: budgetAccount,
        diagnosisId: "diag_budget_old",
        entityId: "cmp_budget_old",
        createdAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      });
      // R-4 — relative to the real clock. The shared fixture's `createdAt` is
      // the fixed `NOW_ISO` (2026-08-23), and the query counts the last 24
      // hours against the real clock, so this row stopped being "recent" on
      // 2026-08-24 and the count has been 0 ever since.
      const recent = makeRecord({
        accountId: budgetAccount,
        diagnosisId: "diag_budget_new",
        createdAt: new Date().toISOString(),
      });
      await repo.save(old);
      await repo.save(recent);
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      expect(await repo.countBudgetActionsSince(budgetAccount, since)).toBe(1);
    } finally {
      await prisma.marketingAccount.deleteMany({ where: { accountId: budgetAccount } }).catch(() => {});
    }
  });

  it("blocks cross-user reads (IDOR) while owner passes", async () => {
    if (!dbUp || !testUserId || !otherUserId) return;
    const rec = makeRecord({ diagnosisId: "diag_idor" });
    await repo.save(rec);
    expect(await repo.getForUser(rec.recommendationId, testUserId!)).not.toBeNull();
    expect(await repo.getForUser(rec.recommendationId, otherUserId)).toBeNull();
    const stolen = await repo.transition(
      rec.recommendationId,
      otherUserId,
      ["PROPOSED"],
      "APPROVED"
    );
    expect(stolen).toBe(false);
  });

  it("writes secret-free audit rows for created/approved transitions", async () => {
    if (!dbUp || !testUserId) return;
    const rec = makeRecord({ diagnosisId: "diag_audit" });
    await repo.save(rec);
    await repo.transition(rec.recommendationId, testUserId!, ["PROPOSED"], "APPROVED");
    const logs = await prisma.auditLog.findMany({
      where: {
        userId: testUserId!,
        action: { in: ["recommendation.created", "recommendation.approved"] },
        parameters: { path: ["recommendationId"], equals: rec.recommendationId },
      },
    });
    const actions = logs.map((l) => l.action).sort();
    expect(actions).toEqual(["recommendation.approved", "recommendation.created"]);
    for (const log of logs) {
      const serialized = JSON.stringify(log.parameters);
      expect(serialized.toLowerCase()).not.toContain("password");
      expect(serialized.toLowerCase()).not.toContain("secret");
    }
  });

  it("runs the full lifecycle with execution linkage", async () => {
    if (!dbUp || !testUserId) return;
    const rec = makeRecord({ diagnosisId: "diag_lifecycle" });
    await repo.save(rec);
    expect(await repo.transition(rec.recommendationId, testUserId!, ["PROPOSED"], "APPROVED")).toBe(true);
    expect(await repo.transition(rec.recommendationId, testUserId!, ["APPROVED"], "EXECUTING")).toBe(true);
    await expect(
      repo.linkExecution(rec.recommendationId, testUserId!, "appr_1", "exec_1")
    ).resolves.toBe(true);
    expect(await repo.transition(rec.recommendationId, testUserId!, ["EXECUTING"], "EXECUTED")).toBe(true);
    const done = await repo.get(rec.recommendationId);
    expect(done!.status).toBe("EXECUTED");
    expect(done!.approvalId).toBe("appr_1");
    expect(done!.executionId).toBe("exec_1");
    // Illegal resurrection is rejected by the conditional update.
    expect(
      await repo.transition(rec.recommendationId, testUserId!, ["EXECUTED"], "PROPOSED")
    ).toBe(false);
  });

  it("scopes listings by user and maps PROPOSED onto the legacy alias", async () => {
    if (!dbUp || !testUserId) return;
    const rec = makeRecord({ diagnosisId: "diag_listing" });
    await repo.save(rec);
    const mine = await repo.listByUser(testUserId!, { accountId: ACCOUNT_ID, status: "PROPOSED" });
    expect(mine.items.some((r) => r.recommendationId === rec.recommendationId)).toBe(true);
    const theirs = await repo.listByUser(otherUserId!, { accountId: ACCOUNT_ID });
    expect(theirs.total).toBe(0);
  });

  it("state binding survives the round trip (verify inputs intact)", async () => {
    if (!dbUp || !testUserId) return;
    const rec = makeRecord({ diagnosisId: "diag_binding" });
    await repo.save(rec);
    const loaded = (await repo.get(rec.recommendationId))!;
    // Reconstruct the live state EXACTLY as makeRecord snapshotted it.
    const liveState: ExternalEntityState = {
      status: "ACTIVE",
      objective: "OUTCOME_SALES",
      dailyBudget: 1000,
      lifetimeBudget: null,
      targetingFingerprint: "fp_default",
    };
    expect(loaded.currentState["dailyBudget"]).toBe(liveState.dailyBudget);
    expect(computeExternalStateHash(loaded.accountId, loaded.entityId, liveState)).toBe(
      loaded.stateHash
    );
    const params = buildExecutableParams(
      loaded.actionType,
      loaded.accountId,
      loaded.entityId,
      loaded.proposedState["dailyBudget"] as number,
      loaded.entityLevel
    );
    expect(computeParamsHash(params)).toBe(loaded.paramsHash);
  });
});
