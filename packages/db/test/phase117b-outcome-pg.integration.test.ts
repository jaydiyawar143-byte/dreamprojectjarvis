/**
 * Phase 11.7B — PostgreSQL Integration Tests for Revisions, Immutability & Concurrency
 *
 * Real PostgreSQL integration tests validating:
 *  1. Revision creation (createRevision + getRevisions)
 *  2. Pagination on revision history
 *  3. Immutability validation (trigger blocks updates to finalized outcome records)
 *  4. Learning history queries (getLearningHistory)
 *  5. Concurrency / lease claiming (claimOutcome / releaseOutcome)
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
import type { OutcomeRecord, OutcomeRevision } from "@jarvis/core";
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

const ACCOUNT_ID = `act_117b_pgtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const EXECUTED_AT = "2026-08-15T00:00:00.000Z";

let testUserId: string | null = null;
let recId: string | null = null;
let repo: PrismaOutcomeRepository;

function makeTestOutcomeRecord(overrides?: Partial<OutcomeRecord>): OutcomeRecord {
  const kpis = calculateCanonicalKPIs({
    spend: 500,
    impressions: 50000,
    clicks: 1000,
    reach: 40000,
    conversions: 20,
    revenue: 2000,
  });
  const baseline = captureBaselineSnapshot(
    {
      accountId: ACCOUNT_ID,
      level: "CAMPAIGN",
      entityId: "cmp_pg_test_117b",
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
    outcomeId: `outcome_pg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    recommendationId: recId!,
    executionId: `exec_pg_test_${Date.now()}`,
    accountId: ACCOUNT_ID,
    entityType: "CAMPAIGN",
    entityId: "cmp_pg_test_117b",
    actionType: "PAUSE_CAMPAIGN",
    objective: "OUTCOME_SALES",
    primaryMetric: "CPA",
    baseline,
    executedAtIso: EXECUTED_AT,
    referenceNow: new Date(),
    userId: testUserId!,
    ...overrides,
  });

  return rec.outcomeRecord;
}

beforeAll(async () => {
  if (!dbUp) return;

  repo = new PrismaOutcomeRepository(prisma);

  // Create test user
  const user = await prisma.user.create({
    data: {
      email: `outcome_117b_${Date.now()}@jarvis-phase117b.test`,
      name: "Phase 117B Test User",
      password: "not-used-in-tests",
    },
  });
  testUserId = user.id;

  // Create marketing account
  await prisma.marketingAccount.create({
    data: {
      userId: testUserId,
      accountId: ACCOUNT_ID,
      name: "Phase 117B Test Account",
      currency: "USD",
      timezoneName: "UTC",
    },
  });

  // Create recommendation
  const rec = await prisma.performanceRecommendation.create({
    data: {
      userId: testUserId,
      accountId: ACCOUNT_ID,
      targetLevel: "CAMPAIGN",
      targetId: "cmp_pg_test_117b",
      actionType: "PAUSE_CAMPAIGN",
      status: "EXECUTED",
      reason: "Phase 11.7B test recommendation",
      evidence: { schemaVersion: 1 },
      expectedImpact: JSON.stringify({
        metric: "SPEND",
        direction: "DECREASE",
        estimatedRange: "NOT_ESTIMATED",
        rationale: "Test",
      }),
      confidence: 0.9,
      riskLevel: "HIGH",
      proposedChange: {},
      paramsHash: `test_hash_117b_${Date.now()}`,
      identityHash: `id_hash_117b_${Date.now()}`,
      stateHash: `state_hash_117b_${Date.now()}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  recId = rec.id;
});

afterAll(async () => {
  if (!dbUp || !testUserId) return;

  // Cleanup will cascade and delete marketing accounts, recommendations, outcome records, and revisions
  await prisma.user.deleteMany({
    where: { id: testUserId },
  });

  await prisma.$disconnect();
});

describe.runIf(dbUp)("Phase 11.7B — Outcome Database Integration Tests", () => {
  it("should create and retrieve revisions", async () => {
    const outcome = makeTestOutcomeRecord();
    await repo.create(outcome);

    // Initial revision creation
    const revision1: OutcomeRevision = {
      id: `rev_1_${Date.now()}`,
      outcomeId: outcome.outcomeId,
      revisionNumber: 1,
      outcomeEnum: "NEUTRAL",
      confidence: 0.9,
      dataQuality: "COMPLETE",
      attributionStatus: "ATTRIBUTION_READY",
      confounders: [],
      measurementKpis: outcome.baseline.kpis,
      comparison: {
        metric: "CPA",
        baseline: 20,
        current: 20,
        absoluteChange: 0,
        percentChange: 0,
        direction: "UNCHANGED",
        isMaterial: false,
      },
      measuredAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    await repo.createRevision(revision1);

    const revisions = await repo.getRevisions(outcome.outcomeId, testUserId!);
    expect(revisions.total).toBe(1);
    expect(revisions.items[0]!.outcomeEnum).toBe("NEUTRAL");
  });

  it("should enforce pagination on revision history", async () => {
    const outcome = makeTestOutcomeRecord();
    await repo.create(outcome);

    // Create 3 revisions
    for (let i = 1; i <= 3; i++) {
      const revision: OutcomeRevision = {
        id: `rev_${i}_pag_${Date.now()}`,
        outcomeId: outcome.outcomeId,
        revisionNumber: i,
        outcomeEnum: i === 1 ? "POSITIVE" : i === 2 ? "NEGATIVE" : "NEUTRAL",
        confidence: 0.8,
        dataQuality: "PARTIAL",
        attributionStatus: "ATTRIBUTION_PENDING",
        confounders: [],
        measurementKpis: outcome.baseline.kpis,
        comparison: {
          metric: "CPA",
          baseline: 20,
          current: 18,
          absoluteChange: -2,
          percentChange: -10,
          direction: "IMPROVED",
          isMaterial: true,
        },
        measuredAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      await repo.createRevision(revision);
    }

    // Verify pagination limit = 2
    const pag1 = await repo.getRevisions(outcome.outcomeId, testUserId!, { limit: 2 });
    expect(pag1.total).toBe(3);
    expect(pag1.items).toHaveLength(2);

    // Verify pagination offset = 2
    const pag2 = await repo.getRevisions(outcome.outcomeId, testUserId!, { offset: 2 });
    expect(pag2.total).toBe(3);
    expect(pag2.items).toHaveLength(1);
  });

  it("should enforce database level immutability via check_outcome_record_immutability trigger", async () => {
    const outcome = makeTestOutcomeRecord({
      measurementState: "FINALIZED",
      isFinal: true,
      outcome: "POSITIVE",
      measuredAt: new Date().toISOString(),
    });
    await repo.create(outcome);

    // Attempting to direct UPDATE a finalized record via prisma should throw an error
    await expect(
      prisma.outcomeRecord.update({
        where: { outcomeId: outcome.outcomeId },
        data: {
          outcomeEnum: "NEGATIVE",
        },
      })
    ).rejects.toThrow();
  });

  it("should retrieve learning history of finalized outcomes", async () => {
    const outcome1 = makeTestOutcomeRecord({
      measurementState: "FINALIZED",
      isFinal: true,
      outcome: "POSITIVE",
      confidence: 0.95,
      measuredAt: new Date().toISOString(),
    });
    const outcome2 = makeTestOutcomeRecord({
      measurementState: "READY",
      isFinal: false,
      outcome: null,
      confidence: null,
      measuredAt: null,
    });

    await repo.create(outcome1);
    await repo.create(outcome2);

    const history = await repo.getLearningHistory(ACCOUNT_ID, testUserId!);
    expect(history.length).toBeGreaterThanOrEqual(1);
    
    // Only the finalized one is in learning history
    const found = history.find((h) => h.measuredAt === outcome1.measuredAt);
    expect(found).toBeDefined();
    expect(found?.outcome).toBe("POSITIVE");
    
    const notFound = history.find((h) => h.measuredAt === outcome2.measuredAt);
    expect(notFound).toBeUndefined();
  });

  it("should handle concurrency leases correctly", async () => {
    const outcome = makeTestOutcomeRecord({
      measurementState: "SCHEDULED",
      isFinal: false,
    });
    await repo.create(outcome);

    const expiredLeaseTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Claim 1: succeeds
    const claimed1 = await repo.claimOutcome(outcome.outcomeId, expiredLeaseTime);
    expect(claimed1).toBe(true);

    // Claim 2: fails because it is now locked in COLLECTING
    const claimed2 = await repo.claimOutcome(outcome.outcomeId, expiredLeaseTime);
    expect(claimed2).toBe(false);

    // Release it back to READY
    const released = await repo.releaseOutcome(outcome.outcomeId, "READY");
    expect(released).toBe(true);

    // Claim again: succeeds
    const claimed3 = await repo.claimOutcome(outcome.outcomeId, expiredLeaseTime);
    expect(claimed3).toBe(true);
  });
});
