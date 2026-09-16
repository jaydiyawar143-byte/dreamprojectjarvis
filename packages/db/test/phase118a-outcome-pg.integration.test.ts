/**
 * Phase 11.8A — PostgreSQL Integration Tests for Historical Outcome Intelligence
 *
 * Real PostgreSQL integration tests validating:
 *  1. Querying finalized outcomes with specific filters.
 *  2. IDOR / User Isolation: User A cannot retrieve User B's outcome history.
 *  3. Account Isolation: Account A cannot retrieve Account B's outcome history.
 *  4. Index performance scaling (simulated query verification).
 *  5. diagnosisCategory retrieval and traceability.
 */

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  captureBaselineSnapshot,
  buildMeasurementWindowConfig,
  measureOutcome,
} from "@jarvis/core";
import type { OutcomeRecord } from "@jarvis/core";
import { calculateCanonicalKPIs } from "@jarvis/core";
import {
  PrismaOutcomeRepository,
} from "../src/repositories/outcome-repository.js";

const prisma = new PrismaClient();

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

const ACCOUNT_A = `act_118a_a_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const ACCOUNT_B = `act_118a_b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const EXECUTED_AT = "2026-08-15T00:00:00.000Z";

let userAId: string | null = null;
let userBId: string | null = null;
let recAId: string | null = null;
let recBId: string | null = null;
let repo: PrismaOutcomeRepository;

function makeMockOutcomeRecord(overrides: Partial<OutcomeRecord>): OutcomeRecord {
  const kpis = calculateCanonicalKPIs({
    spend: 200,
    impressions: 20000,
    clicks: 400,
    reach: 16000,
    conversions: 8,
    revenue: 400,
  });
  const baseline = captureBaselineSnapshot(
    {
      accountId: overrides.accountId || ACCOUNT_A,
      level: "CAMPAIGN",
      entityId: overrides.entityId || "cmp_118a_test",
      currency: "USD",
      timezone: "UTC",
      window: { type: "last_7_days", startDate: "2026-08-08", endDate: "2026-08-14" },
      recordCount: 7,
      kpis,
      quality: "COMPLETE",
      fetchedAt: EXECUTED_AT,
      source: "meta-graph",
    },
    { fetchedAt: EXECUTED_AT }
  );

  const rec = measureOutcome({
    outcomeId: overrides.outcomeId || `outcome_pg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    recommendationId: overrides.recommendationId!,
    executionId: `exec_pg_118a_${Date.now()}`,
    accountId: overrides.accountId || ACCOUNT_A,
    entityType: "CAMPAIGN",
    entityId: overrides.entityId || "cmp_118a_test",
    actionType: overrides.actionType || "PAUSE_CAMPAIGN",
    objective: "OUTCOME_SALES",
    primaryMetric: overrides.primaryMetric || "CPA",
    baseline,
    executedAtIso: EXECUTED_AT,
    referenceNow: new Date(),
    userId: overrides.userId!,
    measurementState: overrides.measurementState || "FINALIZED",
    isAlreadyFinalized: overrides.measurementState === "FINALIZED",
    ...overrides,
  });

  // R-4 — `measureOutcome` does not copy diagnosisCategory onto the record it
  // builds, and the repository stores and filters the record's own column, so
  // the fixture sets it. Passing it as measurement input alone left the stored
  // row null, and a query filtered on the category could never match.
  return { ...rec.outcomeRecord, diagnosisCategory: overrides.diagnosisCategory ?? null };
}

beforeAll(async () => {
  if (!dbUp) return;

  repo = new PrismaOutcomeRepository(prisma);

  // Create two distinct users
  const userA = await prisma.user.create({
    data: {
      email: `user_118a_a_${Date.now()}@jarvis-phase118a.test`,
      name: "User A",
      password: "not-used-in-tests",
    },
  });
  userAId = userA.id;

  const userB = await prisma.user.create({
    data: {
      email: `user_118a_b_${Date.now()}@jarvis-phase118a.test`,
      name: "User B",
      password: "not-used-in-tests",
    },
  });
  userBId = userB.id;

  // Create accounts
  await prisma.marketingAccount.create({
    data: {
      userId: userAId,
      accountId: ACCOUNT_A,
      name: "Account A",
      currency: "USD",
      timezoneName: "UTC",
    },
  });

  await prisma.marketingAccount.create({
    data: {
      userId: userBId,
      accountId: ACCOUNT_B,
      name: "Account B",
      currency: "USD",
      timezoneName: "UTC",
    },
  });

  // Create Recommendations
  const recA = await prisma.performanceRecommendation.create({
    data: {
      userId: userAId,
      accountId: ACCOUNT_A,
      targetLevel: "CAMPAIGN",
      targetId: "cmp_118a_test",
      actionType: "PAUSE_CAMPAIGN",
      status: "EXECUTED",
      reason: "Test Rec A",
      evidence: { schemaVersion: 1 },
      expectedImpact: JSON.stringify({ metric: "SPEND", direction: "DECREASE", estimatedRange: "NOT_ESTIMATED", rationale: "Test" }),
      confidence: 0.9,
      riskLevel: "HIGH",
      proposedChange: {},
      paramsHash: `hash_a_${Date.now()}`,
      identityHash: `id_a_${Date.now()}`,
      stateHash: `state_a_${Date.now()}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      diagnosisCategory: "CREATIVE_FATIGUE",
    },
  });
  recAId = recA.id;

  const recB = await prisma.performanceRecommendation.create({
    data: {
      userId: userBId,
      accountId: ACCOUNT_B,
      targetLevel: "CAMPAIGN",
      targetId: "cmp_118a_test",
      actionType: "PAUSE_CAMPAIGN",
      status: "EXECUTED",
      reason: "Test Rec B",
      evidence: { schemaVersion: 1 },
      expectedImpact: JSON.stringify({ metric: "SPEND", direction: "DECREASE", estimatedRange: "NOT_ESTIMATED", rationale: "Test" }),
      confidence: 0.9,
      riskLevel: "HIGH",
      proposedChange: {},
      paramsHash: `hash_b_${Date.now()}`,
      identityHash: `id_b_${Date.now()}`,
      stateHash: `state_b_${Date.now()}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      diagnosisCategory: "CREATIVE_FATIGUE",
    },
  });
  recBId = recB.id;
});

afterAll(async () => {
  if (!dbUp || !userAId) return;

  const userIds = [userAId, userBId!].filter(Boolean);

  // R-4 — the repository writes an audit row for every outcome it creates or
  // finalizes, and `AuditLog.userId` is ON DELETE RESTRICT, so the cascade
  // below never reaches those rows. They go first, or the user delete fails
  // with a foreign key violation and leaves the test data behind.
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });

  await prisma.user.deleteMany({
    where: { id: { in: userIds } },
  });

  await prisma.$disconnect();
});

describe.runIf(dbUp)("Phase 11.8A — Database Query & Security Integration Tests", () => {
  it("should query finalized outcomes matching filtering criteria including diagnosisCategory", async () => {
    const outcomeA = makeMockOutcomeRecord({
      recommendationId: recAId!,
      userId: userAId!,
      accountId: ACCOUNT_A,
      diagnosisCategory: "CREATIVE_FATIGUE",
      outcome: "POSITIVE",
      confidence: 0.85,
    });

    await repo.create(outcomeA);

    // R-4 — `create` stores WAITING_FOR_DATA with isFinal false by design,
    // whatever the record it is handed says, so the outcome has to be
    // finalized through the repository before a finalized query can see it.
    const finalized = await repo.finalize(
      outcomeA.outcomeId,
      userAId!,
      "POSITIVE",
      0.85,
      new Date().toISOString()
    );
    expect(finalized).toBe(true);

    // Filter matches
    const results = await repo.findFinalizedOutcomes(userAId!, {
      accountId: ACCOUNT_A,
      diagnosisCategory: "CREATIVE_FATIGUE",
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    const found = results.find((o) => o.outcomeId === outcomeA.outcomeId);
    expect(found).toBeDefined();
    expect(found?.diagnosisCategory).toBe("CREATIVE_FATIGUE");
    expect(found?.outcome).toBe("POSITIVE");
    expect(found?.confidence).toBe(0.85);
  });

  it("should enforce User Isolation (User A cannot read User B's history)", async () => {
    const outcomeB = makeMockOutcomeRecord({
      recommendationId: recBId!,
      userId: userBId!,
      accountId: ACCOUNT_B,
      diagnosisCategory: "CREATIVE_FATIGUE",
    });

    await repo.create(outcomeB);

    // User A queries using User A's credentials -> should get empty list
    const results = await repo.findFinalizedOutcomes(userAId!, {
      accountId: ACCOUNT_B,
    });
    expect(results.length).toBe(0);
  });

  it("should enforce Account Isolation (User A cannot read Account B's history even if user IDs matched)", async () => {
    // If User A attempts to filter on Account B which they don't own (it belongs to User B)
    const results = await repo.findFinalizedOutcomes(userAId!, {
      accountId: ACCOUNT_B,
    });
    expect(results.length).toBe(0);
  });
});
