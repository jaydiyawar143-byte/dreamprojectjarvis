/**
 * Phase 11.7B — PostgreSQL Integration Tests for Revisions, Immutability & Concurrency
 *
 * Real PostgreSQL integration tests validating:
 *  1. Revision creation (createRevision + getRevisions)
 *  2. Pagination on revision history
 *  3. Immutability validation (trigger blocks updates to finalized outcome records)
 *  4. Learning history queries (getLearningHistory)
 *  5. Concurrency / lease claiming (claimOutcome / releaseOutcome)
 *
 * R-4: each test that stores an outcome owns its recommendation, and the
 * states the repository controls — FINALIZED, SCHEDULED — are reached through
 * the repository instead of being asserted into the record. Before that, every
 * test after the first died on the unique `recommendation_id`.
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

/**
 * R-4 — a recommendation this test alone owns.
 *
 * `OutcomeRecord.recommendation_id` is unique: one recommendation carries one
 * outcome. Sharing the suite's recommendation made every later `create` throw
 * `DuplicateOutcomeError` before the test reached what it was written to check.
 */
async function createRecommendation(label: string): Promise<string> {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const rec = await prisma.performanceRecommendation.create({
    data: {
      userId: testUserId!,
      accountId: ACCOUNT_ID,
      targetLevel: "CAMPAIGN",
      targetId: "cmp_pg_test_117b",
      actionType: "PAUSE_CAMPAIGN",
      status: "EXECUTED",
      reason: `Phase 11.7B test recommendation (${label})`,
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
      paramsHash: `test_hash_117b_${unique}`,
      identityHash: `id_hash_117b_${unique}`,
      stateHash: `state_hash_117b_${unique}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return rec.id;
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

  // The recommendation the first test's outcome is linked to
  recId = await createRecommendation("suite");
});

afterAll(async () => {
  if (!dbUp || !testUserId) return;

  // R-4 — the repository writes an audit row for every outcome it creates,
  // finalizes or revises, and `AuditLog.userId` is ON DELETE RESTRICT, so the
  // cascade below never reaches them. They go first, or the user delete fails
  // with a foreign key violation and the test data is left behind.
  await prisma.auditLog.deleteMany({ where: { userId: testUserId } });

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
    const outcome = makeTestOutcomeRecord({
      recommendationId: await createRecommendation("pagination"),
    });
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
      recommendationId: await createRecommendation("immutability"),
    });
    await repo.create(outcome);

    // R-4 — the trigger fires only when the stored row is already final, and
    // `create` always stores WAITING_FOR_DATA, so the row is finalized through
    // the repository first. Asserting FINALIZED into the record changed nothing.
    const finalized = await repo.finalize(
      outcome.outcomeId,
      testUserId!,
      "POSITIVE",
      0.9,
      new Date().toISOString()
    );
    expect(finalized).toBe(true);

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
    const measuredAt1 = new Date().toISOString();
    const outcome1 = makeTestOutcomeRecord({
      recommendationId: await createRecommendation("learning_final"),
    });
    const outcome2 = makeTestOutcomeRecord({
      recommendationId: await createRecommendation("learning_open"),
      measurementState: "READY",
      isFinal: false,
      outcome: null,
      confidence: null,
      measuredAt: null,
    });

    await repo.create(outcome1);
    await repo.create(outcome2);

    // R-4 — learning history reads FINALIZED rows, and only `finalize` writes
    // that state; `create` stores WAITING_FOR_DATA for every record it is given.
    expect(
      await repo.finalize(outcome1.outcomeId, testUserId!, "POSITIVE", 0.95, measuredAt1)
    ).toBe(true);

    const history = await repo.getLearningHistory(ACCOUNT_ID, testUserId!);
    expect(history.length).toBeGreaterThanOrEqual(1);

    // Only the finalized one is in learning history
    const found = history.find((h) => h.measuredAt === measuredAt1);
    expect(found).toBeDefined();
    expect(found?.outcome).toBe("POSITIVE");

    const notFound = history.find((h) => h.measuredAt === outcome2.measuredAt);
    expect(notFound).toBeUndefined();
  });

  it("should handle concurrency leases correctly", async () => {
    const outcome = makeTestOutcomeRecord({
      recommendationId: await createRecommendation("lease"),
      measurementState: "SCHEDULED",
      isFinal: false,
    });
    await repo.create(outcome);

    // R-4 — only a SCHEDULED or READY row can be claimed, and `create` stores
    // WAITING_FOR_DATA whatever the record says. The worker moves the row with
    // this same call; the test does not write the column itself.
    expect(
      await repo.updateMeasurementState(outcome.outcomeId, testUserId!, "SCHEDULED")
    ).toBe(true);

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
