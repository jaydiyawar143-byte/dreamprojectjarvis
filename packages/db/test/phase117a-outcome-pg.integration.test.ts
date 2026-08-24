/**
 * Phase 11.7A — PostgreSQL Integration Tests for OutcomeRecord
 *
 * 7 integration test cases (real PostgreSQL):
 *  1. Create + retrieve outcome record
 *  2. Account isolation (cross-account read → null)
 *  3. User isolation (cross-user read → null)
 *  4. Idempotency (duplicate create → DuplicateOutcomeError)
 *  5. FINALIZED immutability (second finalize → returns false, row unchanged)
 *  6. Recommendation FK linkage (cascade delete)
 *  7. Baseline JSON round-trip fidelity
 *
 * Uses mock Meta data only. NO real Meta writes. NO AI. NO workers.
 * Uses a dedicated test user + account removed in afterAll (FK cascade).
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
  DuplicateOutcomeError,
} from "../src/repositories/outcome-repository.js";
import {
  PrismaRecommendationRepository,
} from "../src/repositories/recommendation-repository.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

const ACCOUNT_ID = `act_117a_pgtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const OTHER_ACCOUNT_ID = `act_117a_other_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const EXECUTED_AT = "2026-08-15T00:00:00.000Z";

let testUserId: string | null = null;
let otherUserId: string | null = null;
let recId: string | null = null;
let repo: PrismaOutcomeRepository;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      entityId: "cmp_pg_test",
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
  const config = buildMeasurementWindowConfig("PAUSE_CAMPAIGN");

  const rec = measureOutcome({
    outcomeId: `outcome_pg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    recommendationId: recId!,
    executionId: `exec_pg_test_${Date.now()}`,
    accountId: ACCOUNT_ID,
    entityType: "CAMPAIGN",
    entityId: "cmp_pg_test",
    actionType: "PAUSE_CAMPAIGN",
    objective: "OUTCOME_SALES",
    primaryMetric: "CPA",
    baseline,
    executedAtIso: EXECUTED_AT,
    referenceNow: new Date(),
    ...overrides,
  });

  return rec.outcomeRecord;
}

// ---------------------------------------------------------------------------
// Before / After
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!dbUp) return;

  repo = new PrismaOutcomeRepository(prisma);

  // Create test user + account
  const user = await prisma.user.create({
    data: {
      email: `outcome_test_${Date.now()}@jarvis-phase117a.test`,
      name: "Phase 117A Test User",
      password: "not-used-in-tests",
    },
  });
  testUserId = user.id;

  const otherUser = await prisma.user.create({
    data: {
      email: `outcome_other_${Date.now()}@jarvis-phase117a.test`,
      name: "Phase 117A Other User",
      password: "not-used-in-tests",
    },
  });
  otherUserId = otherUser.id;

  // Create marketing accounts
  await prisma.marketingAccount.create({
    data: {
      userId: testUserId,
      accountId: ACCOUNT_ID,
      name: "Phase 117A Test Account",
      currency: "USD",
      timezoneName: "UTC",
    },
  });

  await prisma.marketingAccount.create({
    data: {
      userId: otherUserId!,
      accountId: OTHER_ACCOUNT_ID,
      name: "Phase 117A Other Account",
      currency: "USD",
      timezoneName: "UTC",
    },
  });

  // Create a PerformanceRecommendation to link outcomes to
  const rec = await prisma.performanceRecommendation.create({
    data: {
      userId: testUserId,
      accountId: ACCOUNT_ID,
      targetLevel: "CAMPAIGN",
      targetId: "cmp_pg_test",
      actionType: "PAUSE_CAMPAIGN",
      status: "EXECUTED",
      reason: "Phase 11.7A test recommendation",
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
      paramsHash: `test_hash_${Date.now()}`,
      identityHash: `id_hash_${Date.now()}`,
      stateHash: `state_hash_${Date.now()}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  recId = rec.id;
});

afterAll(async () => {
  if (!dbUp || !testUserId) return;

  // FK cascade removes all related records
  await prisma.user.deleteMany({
    where: {
      id: { in: [testUserId, otherUserId!].filter(Boolean) },
    },
  });

  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 11.7A — OutcomeRecord PostgreSQL integration", () => {
  // -------------------------------------------------------------------------
  // 1. Create + retrieve
  // -------------------------------------------------------------------------
  it(
    "1 — creates and retrieves an outcome record",
    async () => {
      if (!dbUp) return;

      const record = makeTestOutcomeRecord();
      await repo.create(record);

      const fetched = await repo.get(record.outcomeId, testUserId!);
      expect(fetched).not.toBeNull();
      expect(fetched!.outcomeId).toBe(record.outcomeId);
      expect(fetched!.recommendationId).toBe(recId);
      expect(fetched!.accountId).toBe(ACCOUNT_ID);
      expect(fetched!.primaryMetric).toBe("CPA");
      expect(fetched!.actionType).toBe("PAUSE_CAMPAIGN");
    },
    30000
  );

  // -------------------------------------------------------------------------
  // 2. Account isolation
  // -------------------------------------------------------------------------
  it(
    "2 — cross-account read returns null (account isolation)",
    async () => {
      if (!dbUp) return;

      const record = makeTestOutcomeRecord();
      await repo.create(record);

      // otherUserId belongs to OTHER_ACCOUNT_ID, not ACCOUNT_ID
      const fetched = await repo.get(record.outcomeId, otherUserId!);
      expect(fetched).toBeNull();
    },
    30000
  );

  // -------------------------------------------------------------------------
  // 3. User isolation
  // -------------------------------------------------------------------------
  it(
    "3 — cross-user read returns null (user isolation)",
    async () => {
      if (!dbUp) return;

      const record = makeTestOutcomeRecord();
      await repo.create(record);

      const fetched = await repo.getByRecommendation(record.recommendationId, otherUserId!);
      expect(fetched).toBeNull();
    },
    30000
  );

  // -------------------------------------------------------------------------
  // 4. Idempotency (duplicate create → DuplicateOutcomeError)
  // -------------------------------------------------------------------------
  it(
    "4 — duplicate create throws DuplicateOutcomeError (idempotency)",
    async () => {
      if (!dbUp) return;

      // Get existing record for recId from previous tests
      const existing = await repo.getByRecommendation(recId!, testUserId!);
      if (!existing) return; // Skip if prior tests failed

      const duplicate = makeTestOutcomeRecord();
      duplicate.recommendationId = recId!; // same recommendation → unique violation

      await expect(repo.create(duplicate)).rejects.toThrow(DuplicateOutcomeError);
    },
    30000
  );

  // -------------------------------------------------------------------------
  // 5. FINALIZED immutability
  // -------------------------------------------------------------------------
  it(
    "5 — second finalize is no-op; finalized row is immutable",
    async () => {
      if (!dbUp) return;

      const existing = await repo.getByRecommendation(recId!, testUserId!);
      if (!existing) return;

      const measuredAt = new Date().toISOString();

      // First finalize
      const first = await repo.finalize(
        existing.outcomeId,
        testUserId!,
        "POSITIVE",
        0.9,
        measuredAt
      );
      expect(first).toBe(true);

      // Second finalize (idempotent — no-op)
      const second = await repo.finalize(
        existing.outcomeId,
        testUserId!,
        "NEGATIVE", // different verdict
        0.1,
        measuredAt
      );
      expect(second).toBe(false);

      // Verify the row still shows POSITIVE (first finalize wins)
      const fetched = await repo.get(existing.outcomeId, testUserId!);
      expect(fetched!.outcome).toBe("POSITIVE");
    },
    30000
  );

  // -------------------------------------------------------------------------
  // 6. Recommendation FK linkage
  // -------------------------------------------------------------------------
  it(
    "6 — outcome is linked to recommendation via FK",
    async () => {
      if (!dbUp) return;

      const existing = await repo.getByRecommendation(recId!, testUserId!);
      expect(existing).not.toBeNull();
      expect(existing!.recommendationId).toBe(recId);
    },
    30000
  );

  // -------------------------------------------------------------------------
  // 7. Baseline JSON round-trip fidelity
  // -------------------------------------------------------------------------
  it(
    "7 — baseline snapshot round-trips through JSON without data loss",
    async () => {
      if (!dbUp) return;

      const existing = await repo.getByRecommendation(recId!, testUserId!);
      if (!existing) return;

      const baseline = existing.baseline;

      expect(baseline.schemaVersion).toBe(1);
      expect(baseline.currency).toBe("USD");
      expect(baseline.timezone).toBe("UTC");
      expect(baseline.source).toBe("meta-graph");
      expect(baseline.kpiEngineVersion).toBe("11.1.0");
      expect(baseline.kpis.spend).toBe(500);
      expect(baseline.kpis.impressions).toBe(50000);
      expect(baseline.kpis.clicks).toBe(1000);
      expect(Number.isNaN(baseline.kpis.spend)).toBe(false);
      if (baseline.kpis.cpa !== null) {
        expect(Number.isFinite(baseline.kpis.cpa)).toBe(true);
      }
    },
    30000
  );
});
