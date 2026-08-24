import { describe, it, expect } from "vitest";
import { evaluateHistoricalEvidence } from "../src/historical-outcome-engine.js";
import type { OutcomeRecord } from "../src/types/outcome.js";
import type { RecommendationRecord } from "../src/types/recommendation.js";

const ACCOUNT_ID = "act_118a_test";
const OTHER_ACCOUNT_ID = "act_118a_other";
const USER_ID = "user_118a_test";
const OTHER_USER_ID = "user_118a_other";

function makeMockCandidate(overrides?: Partial<RecommendationRecord>): RecommendationRecord {
  return {
    schemaVersion: 1,
    recommendationId: "rec_candidate_123",
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    entityLevel: "CAMPAIGN",
    entityId: "cmp_test_123",
    diagnosisId: "diag_test_123",
    diagnosisCategory: "CREATIVE_FATIGUE",
    anomalyIds: ["anom_123"],
    actionType: "PAUSE_CAMPAIGN",
    currentState: { status: "ACTIVE" },
    proposedState: { status: "PAUSED" },
    reason: "Test creative fatigue reason",
    evidence: {
      schemaVersion: 1,
      accountId: ACCOUNT_ID,
      entityLevel: "CAMPAIGN",
      entityId: "cmp_test_123",
      currency: "USD",
      timezone: "UTC",
      performanceWindow: { startDate: "2026-08-01", endDate: "2026-08-07" },
      currentMetrics: {},
      metricDetails: [],
      anomalies: [],
      dataQuality: "COMPLETE",
      freshness: "FRESH",
      evidenceHash: "ev_hash_123",
      builtAt: new Date().toISOString(),
      objective: "OUTCOME_SALES",
    },
    expectedImpact: {
      metric: "CPA",
      direction: "DECREASE",
      estimatedRange: "NOT_ESTIMATED",
      rationale: "Decrease CPA",
    },
    risk: "MEDIUM",
    confidence: "HIGH",
    preconditions: [],
    paramsHash: "params_hash_123",
    stateHash: "state_hash_123",
    identityHash: "identity_hash_123",
    status: "PROPOSED",
    requiresApproval: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeMockOutcome(overrides?: Partial<OutcomeRecord>): OutcomeRecord {
  return {
    outcomeId: `outcome_test_${Math.random()}`,
    recommendationId: `rec_test_${Math.random()}`,
    executionId: `exec_test_${Math.random()}`,
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    entityType: "CAMPAIGN",
    entityId: "cmp_test_123",
    actionType: "PAUSE_CAMPAIGN",
    objective: "OUTCOME_SALES",
    primaryMetric: "CPA",
    baseline: {
      schemaVersion: 1,
      dateRangeStart: "2026-08-01",
      dateRangeEnd: "2026-08-07",
      timezone: "UTC",
      currency: "USD",
      source: "meta-graph",
      fetchedAt: new Date().toISOString(),
      kpiEngineVersion: "1.0",
      aggregationVersion: "1.0",
      kpis: {
        spend: 100,
        impressions: 10000,
        clicks: 200,
        reach: 8000,
        conversions: 10,
        revenue: 500,
        ctr: 0.02,
        cpc: 0.5,
        cpm: 10,
        cpa: 10,
        roas: 5,
        cvr: 0.05,
        frequency: 1.2,
      },
    },
    measurement: {
      spend: 100,
      impressions: 10000,
      clicks: 200,
      reach: 8000,
      conversions: 10,
      revenue: 500,
      ctr: 0.02,
      cpc: 0.5,
      cpm: 10,
      cpa: 10,
      roas: 5,
      cvr: 0.05,
      frequency: 1.2,
    },
    comparison: {
      metric: "CPA",
      baseline: 10,
      current: 8,
      absoluteChange: -2,
      percentChange: -20,
      direction: "IMPROVED",
      isMaterial: true,
    },
    outcome: "POSITIVE",
    confidence: 0.9,
    dataQuality: "COMPLETE",
    attributionStatus: "ATTRIBUTION_READY",
    confounders: [],
    measurementWindow: {
      stabilizationMs: 24 * 60 * 60 * 1000,
      measurementMs: 7 * 24 * 60 * 60 * 1000,
      attributionWindowMs: 7 * 24 * 60 * 60 * 1000,
      minimumDataDays: 3,
      minimumSpend: 10,
      minimumConversions: 3,
      maxDataAgeMs: 48 * 60 * 60 * 1000,
    },
    measuredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    measurementState: "FINALIZED",
    diagnosisCategory: "CREATIVE_FATIGUE",
    ...overrides,
  };
}

describe("Phase 11.8A — Historical Outcome Intelligence Engine", () => {
  it("1 — basic query history & filtering", () => {
    const candidate = makeMockCandidate();
    const outcomes = [
      makeMockOutcome({ outcomeId: "o1", outcome: "POSITIVE" }),
      makeMockOutcome({ outcomeId: "o2", outcome: "NEGATIVE" }),
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes);
    expect(result.sampleSize).toBe(2);
    expect(result.matchingOutcomeIds).toContain("o1");
    expect(result.matchingOutcomeIds).toContain("o2");
    expect(result.summaryStatistics.positiveCount).toBe(1);
    expect(result.summaryStatistics.negativeCount).toBe(1);
  });

  it("2 — account filtering", () => {
    const candidate = makeMockCandidate();
    const outcomes = [
      makeMockOutcome({ outcomeId: "o1", accountId: ACCOUNT_ID }),
      makeMockOutcome({ outcomeId: "o2", accountId: OTHER_ACCOUNT_ID }), // Should be excluded
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes);
    expect(result.sampleSize).toBe(1);
    expect(result.matchingOutcomeIds).toContain("o1");
    expect(result.matchingOutcomeIds).not.toContain("o2");
  });

  it("3 — user filtering (IDOR isolation)", () => {
    const candidate = makeMockCandidate();
    const outcomes = [
      makeMockOutcome({ outcomeId: "o1", userId: USER_ID }),
      makeMockOutcome({ outcomeId: "o2", userId: OTHER_USER_ID }), // Should be excluded
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes);
    expect(result.sampleSize).toBe(1);
    expect(result.matchingOutcomeIds).toContain("o1");
    expect(result.matchingOutcomeIds).not.toContain("o2");
  });

  it("4 — action matching", () => {
    const candidate = makeMockCandidate({ actionType: "PAUSE_CAMPAIGN" });
    const outcomes = [
      makeMockOutcome({ outcomeId: "o1", actionType: "PAUSE_CAMPAIGN" }), // exact match
      makeMockOutcome({ outcomeId: "o2", actionType: "RESUME_CAMPAIGN", diagnosisCategory: "AUDIENCE_SATURATION" }), // family match (pause vs resume differ) but entityType/objective/metric match -> score = 0 + 0 + 0.15 + 0.15 + 0.1 = 0.4 >= 0.2
      makeMockOutcome({
        outcomeId: "o3",
        actionType: "DECREASE_BUDGET",
        diagnosisCategory: "AUDIENCE_SATURATION",
        objective: "OUTCOME_LEADS",
        entityType: "AD_SET",
        primaryMetric: "CPC"
      }), // completely different family & mismatch other signals -> score = 0
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes, { similarityThreshold: 0.2 });
    expect(result.matchingOutcomeIds).toContain("o1");
    expect(result.matchingOutcomeIds).toContain("o2");
    expect(result.matchingOutcomeIds).not.toContain("o3");
  });

  it("5 — diagnosis matching", () => {
    const candidate = makeMockCandidate({ diagnosisCategory: "CREATIVE_FATIGUE" });
    const outcomes = [
      makeMockOutcome({ outcomeId: "o1", diagnosisCategory: "CREATIVE_FATIGUE" }),
      makeMockOutcome({
        outcomeId: "o2",
        diagnosisCategory: "AUDIENCE_SATURATION",
        objective: "OUTCOME_LEADS",
        entityType: "AD_SET",
        primaryMetric: "CPC"
      }), // action match (0.3) + diagnosis mismatch (0) + objective/entityType/metric mismatch (0) = 0.3 < 0.6
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes, { similarityThreshold: 0.6 });
    expect(result.matchingOutcomeIds).toContain("o1");
    expect(result.matchingOutcomeIds).not.toContain("o2");
  });

  it("6 — objective matching", () => {
    const candidate = makeMockCandidate();
    const outcomes = [
      makeMockOutcome({ outcomeId: "o1", objective: "OUTCOME_SALES" }),
      makeMockOutcome({ outcomeId: "o2", objective: "OUTCOME_LEADS" }),
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes, { similarityThreshold: 0.9 });
    expect(result.matchingOutcomeIds).toContain("o1");
    expect(result.matchingOutcomeIds).not.toContain("o2");
  });

  it("7 — primary metric matching", () => {
    const candidate = makeMockCandidate();
    const outcomes = [
      makeMockOutcome({ outcomeId: "o1", primaryMetric: "CPA" }),
      makeMockOutcome({ outcomeId: "o2", primaryMetric: "CPC" }),
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes, { similarityThreshold: 0.95 });
    expect(result.matchingOutcomeIds).toContain("o1");
    expect(result.matchingOutcomeIds).not.toContain("o2");
  });

  it("8 — entity-type matching", () => {
    const candidate = makeMockCandidate({ entityLevel: "CAMPAIGN" });
    const outcomes = [
      makeMockOutcome({ outcomeId: "o1", entityType: "CAMPAIGN" }),
      makeMockOutcome({ outcomeId: "o2", entityType: "AD_SET" }),
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes, { similarityThreshold: 0.9 });
    expect(result.matchingOutcomeIds).toContain("o1");
    expect(result.matchingOutcomeIds).not.toContain("o2");
  });

  it("9 — recency weighting", () => {
    const candidate = makeMockCandidate();
    const referenceNow = new Date("2026-09-01T00:00:00.000Z");

    const outcomes = [
      makeMockOutcome({
        outcomeId: "recent",
        measuredAt: "2026-08-31T00:00:00.000Z", // 1 day old
      }),
      makeMockOutcome({
        outcomeId: "old",
        measuredAt: "2026-06-01T00:00:00.000Z", // 92 days old (~1 half-life)
      }),
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes, { halfLifeDays: 90 }, referenceNow);
    const recentOut = result.summaryStatistics.relevantOutcomes.find((o) => o.outcomeId === "recent");
    const oldOut = result.summaryStatistics.relevantOutcomes.find((o) => o.outcomeId === "old");

    expect(recentOut).toBeDefined();
    expect(oldOut).toBeDefined();
    expect(recentOut!.weight).toBeGreaterThan(oldOut!.weight);
  });

  it("10 — data-quality weighting & exclusions", () => {
    const candidate = makeMockCandidate();
    const outcomes = [
      makeMockOutcome({ outcomeId: "complete", dataQuality: "COMPLETE" }),
      makeMockOutcome({ outcomeId: "partial", dataQuality: "PARTIAL" }), // downgraded weight
      makeMockOutcome({ outcomeId: "insufficient", dataQuality: "INSUFFICIENT_DATA" }), // excluded
      makeMockOutcome({ outcomeId: "unavailable", dataQuality: "UNAVAILABLE" }), // excluded
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes);
    expect(result.sampleSize).toBe(2);
    expect(result.matchingOutcomeIds).toContain("complete");
    expect(result.matchingOutcomeIds).toContain("partial");
    expect(result.matchingOutcomeIds).not.toContain("insufficient");

    const completeOut = result.summaryStatistics.relevantOutcomes.find((o) => o.outcomeId === "complete");
    const partialOut = result.summaryStatistics.relevantOutcomes.find((o) => o.outcomeId === "partial");
    expect(completeOut!.weight).toBeGreaterThan(partialOut!.weight);
  });

  it("11 — inconclusive exclusion", () => {
    const candidate = makeMockCandidate();
    const outcomes = [
      makeMockOutcome({ outcomeId: "positive", outcome: "POSITIVE" }),
      makeMockOutcome({ outcomeId: "inconclusive", outcome: "INCONCLUSIVE" }), // excluded from stats
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes);
    expect(result.sampleSize).toBe(1); // inconclusive doesn't increment sampleSize
    expect(result.summaryStatistics.inconclusiveCount).toBe(1);
    expect(result.summaryStatistics.positiveCount).toBe(1);
  });

  it("12 — confounded outcome exclusion", () => {
    const candidate = makeMockCandidate();
    const outcomes = [
      makeMockOutcome({
        outcomeId: "confounded",
        confounders: [{ type: "EXTERNAL_BUDGET_CHANGE", detectedAt: new Date().toISOString(), description: "Confounder", makesAttributionUnreliable: true }],
      }),
      makeMockOutcome({ outcomeId: "clean", confounders: [] }),
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes);
    expect(result.sampleSize).toBe(1);
    expect(result.matchingOutcomeIds).toContain("clean");
    expect(result.matchingOutcomeIds).not.toContain("confounded");
  });

  it("13 — sample size thresholds (LIMITED, LOW_SAMPLE, STRONG)", () => {
    const candidate = makeMockCandidate();

    // 1 result -> LIMITED_HISTORY
    const res1 = evaluateHistoricalEvidence(candidate, [makeMockOutcome()]);
    expect(res1.limitations).toContain("LIMITED_HISTORY");

    // 3 results -> LOW_SAMPLE
    const res3 = evaluateHistoricalEvidence(candidate, [makeMockOutcome(), makeMockOutcome(), makeMockOutcome()]);
    expect(res3.limitations).toContain("LOW_SAMPLE");

    // 10 results -> Strong
    const outcomes10 = Array.from({ length: 10 }, () => makeMockOutcome());
    const res10 = evaluateHistoricalEvidence(candidate, outcomes10);
    expect(res10.limitations).not.toContain("LOW_SAMPLE");
    expect(res10.limitations).not.toContain("LIMITED_HISTORY");
  });

  it("14 — mixed history detection", () => {
    const candidate = makeMockCandidate();
    const outcomes = [
      makeMockOutcome({ outcome: "POSITIVE" }),
      makeMockOutcome({ outcome: "POSITIVE" }),
      makeMockOutcome({ outcome: "NEGATIVE" }),
      makeMockOutcome({ outcome: "NEGATIVE" }),
    ];

    const result = evaluateHistoricalEvidence(candidate, outcomes);
    expect(result.limitations).toContain("MIXED_HISTORY");
  });

  it("15 — no history path", () => {
    const candidate = makeMockCandidate();
    const result = evaluateHistoricalEvidence(candidate, []);
    expect(result.sampleSize).toBe(0);
    expect(result.limitations).toContain("NO_RELEVANT_HISTORY");
  });

  it("16 — no causal claims verification", () => {
    const candidate = makeMockCandidate();
    const outcomes = [makeMockOutcome({ outcome: "POSITIVE" })];

    const result = evaluateHistoricalEvidence(candidate, outcomes);
    const desc = result.weighting.parameters.traceableDescription as string;
    expect(desc).not.toContain("will improve");
    expect(desc).not.toContain("will decrease");
    expect(desc).not.toContain("guarantees");
    expect(desc).toContain("similar historical recommendations");
  });

  it("17 — SCALE: processes 10,000 outcomes in under 100ms", () => {
    const candidate = makeMockCandidate();
    
    // Generate 10,000 mock outcomes (some matching, some mismatching)
    const outcomes: OutcomeRecord[] = [];
    for (let i = 0; i < 10000; i++) {
      const match = i % 2 === 0;
      outcomes.push(
        makeMockOutcome({
          outcomeId: `out_${i}`,
          accountId: match ? ACCOUNT_ID : OTHER_ACCOUNT_ID,
          userId: match ? USER_ID : OTHER_USER_ID,
          outcome: i % 3 === 0 ? "POSITIVE" : i % 3 === 1 ? "NEGATIVE" : "NEUTRAL",
        })
      );
    }

    const start = performance.now();
    const result = evaluateHistoricalEvidence(candidate, outcomes);
    const elapsed = performance.now() - start;

    expect(result.sampleSize).toBe(5000); // 50 % match account / user isolation
    expect(elapsed).toBeLessThan(100); // Should run in <100ms (usually <15ms)
  });
});
