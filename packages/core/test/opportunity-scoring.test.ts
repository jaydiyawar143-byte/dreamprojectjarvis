import { describe, it, expect } from "vitest";
import {
  scoreOpportunity,
  rankOpportunities,
  evaluateEligibility,
  classifyReversibility,
  bandOf,
  compareOpportunities,
  detectConflicts,
  OpportunityScoreSchema,
  type OpportunityScore,
  type OpportunityWeights,
} from "../src/opportunity-scoring.js";
import type { RecommendationRecord, ConfidenceAssessment } from "../src/types/recommendation.js";

// ---------------------------------------------------------------------------
// Phase 11.9A — Controlled Optimization Opportunity Scoring
// 32 spec scenarios (§20) + adversarial + performance.
// Pure-function suite: NO database, NO network, NO LLM, NO Meta calls.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-24T12:00:00.000Z");
const USER = "user-1";
const ACCOUNT = "act_111";

function makeAnomaly(overrides: Record<string, unknown> = {}) {
  return {
    anomalyId: "an-1",
    accountId: ACCOUNT,
    entityLevel: "CAMPAIGN",
    entityId: "camp-1",
    metric: "ctr",
    currentValue: 0.8,
    baselineValue: 2.0,
    absoluteDeviation: -1.2,
    percentDeviation: -60,
    modifiedZScore: -4.0,
    direction: "NEGATIVE_ANOMALY" as const,
    severity: "CRITICAL" as const,
    confidence: "HIGH" as const,
    baselineMethod: "ROLLING_MEDIAN_MAD" as const,
    sampleCount: 30,
    dataQuality: "COMPLETE" as const,
    freshness: "FRESH" as const,
    evidence: {
      metric: "ctr",
      currentValue: 0.8,
      baselineValue: 2.0,
      absoluteDeviation: -1.2,
      percentDeviation: -60,
      modifiedZScore: -4.0,
      sampleCount: 30,
      baselineMethod: "ROLLING_MEDIAN_MAD" as const,
      economicSignificanceMet: true,
    },
    detectedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), // 1h ago
    ...overrides,
  };
}

function makeEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    accountId: ACCOUNT,
    entityLevel: "CAMPAIGN" as const,
    entityId: "camp-1",
    currency: "USD",
    timezone: "UTC",
    performanceWindow: { startDate: "2026-08-17", endDate: "2026-08-24" },
    currentMetrics: { spend: 1200 } as Record<string, number | null>,
    metricDetails: [],
    anomalies: [makeAnomaly()],
    dataQuality: "COMPLETE" as const,
    freshness: "FRESH" as const,
    relevantContext: { labels: [], notes: [] },
    evidenceHash: "e".repeat(16),
    builtAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeAssessment(overrides: Partial<ConfidenceAssessment> = {}): ConfidenceAssessment {
  return {
    level: "MEDIUM",
    currentEvidence: "HIGH",
    historicalEvidence: "NONE",
    sampleQuality: "NO_HISTORY",
    historicalSampleSize: 0,
    historicalConsistency: "NONE",
    contradictoryEvidence: [],
    limitations: [],
    ...overrides,
  };
}

let seq = 0;
function makeRecord(overrides: Record<string, unknown> = {}): RecommendationRecord {
  seq += 1;
  return {
    schemaVersion: 1 as const,
    recommendationId: `rec-${String(seq).padStart(4, "0")}`,
    userId: USER,
    accountId: ACCOUNT,
    entityLevel: "CAMPAIGN",
    entityId: "camp-1",
    diagnosisId: `diag-${seq}`,
    diagnosisCategory: "AUDIENCE_FATIGUE",
    anomalyIds: ["an-1"],
    actionType: "PAUSE_AD_SET",
    currentState: { status: "ACTIVE" },
    proposedState: { status: "PAUSED" },
    reason: "Fatigue pattern detected on campaign.",
    evidence: makeEvidence(),
    expectedImpact: {
      metric: "SPEND" as const,
      direction: "DECREASE" as const,
      estimatedRange: "NOT_ESTIMATED",
      rationale: "Pausing stops ongoing spend exposure.",
    },
    risk: "LOW",
    confidence: "MEDIUM",
    priority: "MEDIUM",
    historicalEvidenceIds: [],
    confidenceExplanation: null,
    preconditions: [],
    paramsHash: "p".repeat(16),
    stateHash: "s".repeat(16),
    identityHash: "i".repeat(16),
    status: "PROPOSED" as const,
    requiresApproval: true as const,
    createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
    staleReasons: [],
    ...overrides,
  };
}

function onlyWeights(key: keyof OpportunityWeights): OpportunityWeights {
  return { severity: 0, impact: 0, urgency: 0, confidence: 0, historical: 0, reversibility: 0, [key]: 1 };
}

const CTX = { requestingUserId: USER, now: NOW };

// ===========================================================================
// §20 scenarios
// ===========================================================================

describe("11.9A opportunity scoring", () => {
  it("01 — scores a valid recommendation inside the contract (score 0–100, full shape)", () => {
    const rec = makeRecord();
    const res = scoreOpportunity(rec, CTX);
    expect(res.eligible).toBe(true);
    if (!res.eligible) return;
    const parsed = OpportunityScoreSchema.safeParse(res.score);
    expect(parsed.success).toBe(true);
    // Hand-computed default: .25*1 + .2*1 + .15*1 + .15*.6 + .1*.4 + .05*.7
    // = .765 -> 76.5 -> round 77, LOW risk penalty 0.
    expect(res.score.score).toBe(77);
    expect(res.score.priority).toBe("HIGH");
  });

  it("02 — priority bands have exact inclusive boundaries", () => {
    expect(bandOf(100)).toBe("CRITICAL");
    expect(bandOf(80)).toBe("CRITICAL");
    expect(bandOf(79)).toBe("HIGH");
    expect(bandOf(60)).toBe("HIGH");
    expect(bandOf(59)).toBe("MEDIUM");
    expect(bandOf(40)).toBe("MEDIUM");
    expect(bandOf(39)).toBe("LOW");
    expect(bandOf(20)).toBe("LOW");
    expect(bandOf(19)).toBe("IGNORE");
    expect(bandOf(0)).toBe("IGNORE");
  });

  it("03 — severity component mirrors Phase 11.3 severities (critical > warning-only)", () => {
    const critical = scoreOpportunity(makeRecord(), { ...CTX, weights: onlyWeights("severity") });
    const warningOnly = scoreOpportunity(
      makeRecord({ evidence: makeEvidence({ anomalies: [makeAnomaly({ severity: "WARNING", percentDeviation: -22 })] }) }),
      { ...CTX, weights: onlyWeights("severity") }
    );
    const none = scoreOpportunity(
      makeRecord({
        evidence: makeEvidence({
          anomalies: [makeAnomaly({ direction: "POSITIVE_ANOMALY", percentDeviation: 40 })],
        }),
      }),
      { ...CTX, weights: onlyWeights("severity") }
    );
    if (!critical.eligible || !warningOnly.eligible || !none.eligible) throw new Error("unexpected");
    expect(critical.score.severity).toBe("CRITICAL");
    expect(warningOnly.score.severity).toBe("MEDIUM");
    expect(none.score.severity).toBe("LOW");
    expect(critical.score.score).toBeGreaterThan(warningOnly.score.score);
    expect(warningOnly.score.score).toBeGreaterThan(none.score.score);
  });

  it("04 — impact uses spend-exposure buckets; tiny spend stays low", () => {
    const big = scoreOpportunity(makeRecord(), { ...CTX, weights: onlyWeights("impact") });
    const small = scoreOpportunity(
      makeRecord({ evidence: makeEvidence({ currentMetrics: { spend: 50 } }) }),
      { ...CTX, weights: onlyWeights("impact") }
    );
    if (!big.eligible || !small.eligible) throw new Error("unexpected");
    expect(big.score.expectedImpact).toBe("HIGH"); // spend >= 1000 -> bucket 1.0
    expect(small.score.expectedImpact).toBe("LOW"); // spend > 0 -> bucket 0.4
    expect(big.score.score).toBe(100);
    expect(small.score.score).toBe(40);
  });

  it("05 — adverse metric changes raise impact even without spend signal", () => {
    const res = scoreOpportunity(
      makeRecord({
        evidence: makeEvidence({
          currentMetrics: {},
          metricDetails: [
            {
              metric: "cpa",
              current: 30,
              previous: 20,
              changeAbsolute: 10,
              changePercent: 50,
              unit: "CURRENCY",
              window: { startDate: "2026-08-17", endDate: "2026-08-24" },
              provenance: { source: "META_INSIGHTS", aggregationLevel: "CAMPAIGN" },
            },
          ],
        }),
      }),
      { ...CTX, weights: onlyWeights("impact") }
    );
    if (!res.eligible) throw new Error("unexpected");
    expect(res.score.score).toBe(50); // neutral-no-spend base replaced by adverse bump 0.5
  });

  it("06 — urgency combines anomaly age and deterioration velocity", () => {
    const fresh = scoreOpportunity(makeRecord(), { ...CTX, weights: onlyWeights("urgency") });
    const old = scoreOpportunity(
      makeRecord({
        evidence: makeEvidence({
          anomalies: [
            makeAnomaly({
              detectedAt: new Date(NOW.getTime() - 10 * 86_400_000).toISOString(),
              percentDeviation: -5,
            }),
          ],
        }),
      }),
      { ...CTX, weights: onlyWeights("urgency") }
    );
    if (!fresh.eligible || !old.eligible) throw new Error("unexpected");
    expect(fresh.score.urgency).toBe("IMMEDIATE"); // <24h & |pct|>=50 -> 1.0
    expect(old.score.urgency).toBe("LOW"); // >7d & small pct -> ~0.34
    expect(fresh.score.score).toBe(100);
    expect(Math.round((0.6 * 0.3 + 0.4 * 0.4) * 100)).toBe(old.score.score); // 34
  });

  it("07 — confidence is consumed from the record (never recalculated)", () => {
    for (const [level, expected] of [
      ["HIGH", 100],
      ["MEDIUM", 60],
      ["LOW", 30],
    ] as const) {
      const res = scoreOpportunity(makeRecord({ confidence: level }), {
        ...CTX,
        weights: onlyWeights("confidence"),
      });
      if (!res.eligible) throw new Error("unexpected");
      expect(res.score.confidence).toBe(level);
      expect(res.score.score).toBe(expected);
    }
  });

  it("08 — historical contribution comes from the 11.8B assessment with hard caps", () => {
    const strongPos = scoreOpportunity(
      makeRecord({
        confidenceExplanation: makeAssessment({
          historicalEvidence: "STRONG",
          historicalConsistency: "CONSISTENT_POSITIVE",
          historicalSampleSize: 12,
          sampleQuality: "STRONGER_HISTORY",
        }),
      }),
      { ...CTX, weights: onlyWeights("historical") }
    );
    const mixed = scoreOpportunity(
      makeRecord({
        confidenceExplanation: makeAssessment({
          historicalEvidence: "STRONG",
          historicalConsistency: "MIXED",
          historicalSampleSize: 8,
          sampleQuality: "LOW_SAMPLE",
          contradictoryEvidence: ["oc-1"],
        }),
      }),
      { ...CTX, weights: onlyWeights("historical") }
    );
    const negConsistent = scoreOpportunity(
      makeRecord({
        confidenceExplanation: makeAssessment({
          historicalEvidence: "STRONG",
          historicalConsistency: "CONSISTENT_NEGATIVE",
          historicalSampleSize: 5,
          sampleQuality: "LOW_SAMPLE",
          contradictoryEvidence: ["oc-1", "oc-2"],
        }),
      }),
      { ...CTX, weights: onlyWeights("historical") }
    );
    const noHistory = scoreOpportunity(makeRecord(), { ...CTX, weights: onlyWeights("historical") });
    if (!strongPos.eligible || !mixed.eligible || !negConsistent.eligible || !noHistory.eligible)
      throw new Error("unexpected");
    expect(strongPos.score.historicalEvidenceStrength).toBe("STRONG");
    expect(strongPos.score.score).toBe(100);
    expect(mixed.score.score).toBeLessThanOrEqual(30); // MIXED caps at 0.3
    expect(negConsistent.score.score).toBeLessThanOrEqual(20); // CONSISTENT_NEGATIVE caps at 0.2
    expect(noHistory.score.score).toBe(40); // absent history is NEUTRAL (not punitive)
  });

  it("09 — HIGH risk applies a −12 penalty and can never go below zero", () => {
    const highRisk = scoreOpportunity(makeRecord({ risk: "HIGH" }), {
      ...CTX,
      weights: onlyWeights("severity"),
    });
    const lowRisk = scoreOpportunity(makeRecord({ risk: "LOW" }), {
      ...CTX,
      weights: onlyWeights("severity"),
    });
    if (!highRisk.eligible || !lowRisk.eligible) throw new Error("unexpected");
    expect(lowRisk.score.score).toBe(100);
    expect(highRisk.score.score).toBe(88); // 100 − 12
    const floor = scoreOpportunity(
      makeRecord({
        risk: "HIGH",
        evidence: makeEvidence({
          anomalies: [makeAnomaly({ direction: "POSITIVE_ANOMALY", percentDeviation: null })],
        }),
      }),
      CTX
    );
    if (!floor.eligible) throw new Error("unexpected");
    expect(floor.score.score).toBeGreaterThanOrEqual(0);
    expect(floor.score.score).toBeLessThanOrEqual(100);
  });

  it("10 — reversibility follows the fixed action table", () => {
    expect(classifyReversibility("PAUSE_AD")).toEqual({ label: "HIGHLY_REVERSIBLE", component: 1.0 });
    expect(classifyReversibility("RESUME_AD")).toEqual({ label: "HIGHLY_REVERSIBLE", component: 1.0 });
    expect(classifyReversibility("PAUSE_AD_SET")).toEqual({
      label: "MODERATELY_REVERSIBLE",
      component: 0.7,
    });
    expect(classifyReversibility("RESUME_AD_SET")).toEqual({
      label: "MODERATELY_REVERSIBLE",
      component: 0.7,
    });
    expect(classifyReversibility("INCREASE_BUDGET")).toEqual({
      label: "HIGHER_IMPACT",
      component: 0.4,
    });
    expect(classifyReversibility("DECREASE_BUDGET")).toEqual({
      label: "HIGHER_IMPACT",
      component: 0.4,
    });
    expect(classifyReversibility("PAUSE_CAMPAIGN")).toEqual({
      label: "HIGHER_IMPACT",
      component: 0.4,
    });
    expect(classifyReversibility("RESUME_CAMPAIGN")).toEqual({
      label: "HIGHER_IMPACT",
      component: 0.4,
    });
    const pauseAd = scoreOpportunity(makeRecord({ actionType: "PAUSE_AD" }), {
      ...CTX,
      weights: onlyWeights("reversibility"),
    });
    if (!pauseAd.eligible) throw new Error("unexpected");
    expect(pauseAd.score.reversibility).toBe("HIGHLY_REVERSIBLE");
    expect(pauseAd.score.score).toBe(100);
  });

  it("11 — expired records are NOT_ELIGIBLE(EXPIRED)", () => {
    const byStatus = evaluateEligibility(makeRecord({ status: "EXPIRED" }), USER, NOW);
    const byTime = evaluateEligibility(
      makeRecord({ expiresAt: new Date(NOW.getTime() - 1000).toISOString() }),
      USER,
      NOW
    );
    expect(byStatus).toBe("EXPIRED");
    expect(byTime).toBe("EXPIRED");
  });

  it("12 — stale/rejected/executed/executing/failed are NOT_ELIGIBLE with precise reasons", () => {
    expect(evaluateEligibility(makeRecord({ status: "STALE" }), USER, NOW)).toBe("STALE");
    expect(evaluateEligibility(makeRecord({ status: "REJECTED" }), USER, NOW)).toBe("REJECTED");
    expect(evaluateEligibility(makeRecord({ status: "EXECUTED" }), USER, NOW)).toBe("ALREADY_EXECUTED");
    expect(evaluateEligibility(makeRecord({ status: "EXECUTING" }), USER, NOW)).toBe("ALREADY_EXECUTING");
    expect(evaluateEligibility(makeRecord({ status: "FAILED" }), USER, NOW)).toBe("STALE");
  });

  it("13 — tampered/partial records are INVALID_RECORD; lost anomaly binding is MISSING_EVIDENCE", () => {
    expect(evaluateEligibility({} as RecommendationRecord, USER, NOW)).toBe("INVALID_RECORD");
    expect(
      evaluateEligibility(
        makeRecord({ evidence: makeEvidence({ anomalies: [] }) }),
        USER,
        NOW
      )
    ).toBe("MISSING_EVIDENCE");
  });

  it("14 — another user's record is UNAUTHORIZED (IDOR defense)", () => {
    const res = scoreOpportunity(makeRecord({ userId: "user-evil" }), CTX);
    expect(res).toEqual({
      eligible: false,
      reason: "UNAUTHORIZED",
      recommendationId: res.eligible ? undefined : (res as { recommendationId?: string }).recommendationId,
    });
    expect(evaluateEligibility(makeRecord({ userId: "user-evil" }), USER, NOW)).toBe("UNAUTHORIZED");
  });

  it("15 — duplicate recommendationIds are deduplicated to one scored item", () => {
    const dup = makeRecord();
    const ranking = rankOpportunities({
      accountId: ACCOUNT,
      records: [dup, { ...dup }],
      context: CTX,
    });
    expect(ranking.items).toHaveLength(1);
  });

  it("16 — conflicting actions on the same entity are flagged CONFLICTED, never resolved silently", () => {
    const pause = makeRecord({ actionType: "PAUSE_AD_SET", entityId: "camp-9" });
    const increase = makeRecord({
      actionType: "INCREASE_BUDGET",
      entityId: "camp-9",
      currentState: { dailyBudget: 100 },
      proposedState: { dailyBudget: 125 },
      expectedImpact: {
        metric: "SPEND" as const,
        direction: "INCREASE" as const,
        estimatedRange: "NOT_ESTIMATED",
        rationale: "Scaling proven winner.",
      },
    });
    const ranking = rankOpportunities({ accountId: ACCOUNT, records: [pause, increase], context: CTX });
    expect(ranking.items).toHaveLength(2);
    for (const item of ranking.items) {
      expect(item.conflicted).toBe(true);
      expect(item.conflictWith.length).toBe(1);
    }
  });

  it("16b — non-conflicting actions on different entities stay unflagged", () => {
    const a = makeRecord({ actionType: "PAUSE_AD_SET", entityId: "camp-a" });
    const b = makeRecord({ actionType: "INCREASE_BUDGET", entityId: "camp-b" });
    const ranking = rankOpportunities({ accountId: ACCOUNT, records: [a, b], context: CTX });
    expect(ranking.items.every((i) => !i.conflicted && i.conflictWith.length === 0)).toBe(true);
  });

  it("17 — ranking is fully deterministic across repeated runs", () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      makeRecord({
        entityId: `camp-${i % 3}`,
        risk: i % 3 === 0 ? "HIGH" : i % 3 === 1 ? "MEDIUM" : "LOW",
      })
    );
    const run1 = rankOpportunities({ accountId: ACCOUNT, records, context: CTX });
    const run2 = rankOpportunities({ accountId: ACCOUNT, records, context: CTX });
    expect(run1.items.map((i) => [i.recommendationId, i.score, i.priority])).toEqual(
      run2.items.map((i) => [i.recommendationId, i.score, i.priority])
    );
  });

  it("18 — tie-breaks: severity → urgency → confidence → createdAt(newer) → id asc", () => {
    const base = {
      recommendationId: "rec-x",
      accountId: ACCOUNT,
      entityId: "e",
      actionType: "PAUSE_AD_SET",
      score: 50,
      priority: "MEDIUM" as const,
      severity: "MEDIUM" as const,
      confidence: "MEDIUM" as const,
      expectedImpact: "MODERATE" as const,
      risk: "LOW" as const,
      urgency: "NORMAL" as const,
      historicalEvidenceStrength: "NONE" as const,
      reversibility: "MODERATELY_REVERSIBLE" as const,
      rationale: {
        positiveFactors: [],
        negativeFactors: [],
        riskNote: "",
        historicalNote: null,
        limitations: [],
      },
      conflicted: false,
      conflictWith: [],
      scoringVersion: 1 as const,
      calculatedAt: NOW.toISOString(),
    };
    const mk = (over: Partial<OpportunityScore>): OpportunityScore =>
      OpportunityScoreSchema.parse({ ...base, ...over });
    const hiSev = mk({ recommendationId: "a", severity: "HIGH" });
    const loSev = mk({ recommendationId: "b", severity: "LOW" });
    expect(compareOpportunities(hiSev, loSev)).toBeLessThan(0);
    expect(compareOpportunities(loSev, hiSev)).toBeGreaterThan(0);

    const hiUrg = mk({ recommendationId: "a", urgency: "IMMEDIATE" });
    const loUrg = mk({ recommendationId: "b", urgency: "LOW" });
    expect(compareOpportunities(hiUrg, loUrg)).toBeLessThan(0);
    expect(compareOpportunities(loUrg, hiUrg)).toBeGreaterThan(0);

    const hiConf = mk({ recommendationId: "a", confidence: "HIGH" });
    const loConf = mk({ recommendationId: "b", confidence: "LOW" });
    expect(compareOpportunities(hiConf, loConf)).toBeLessThan(0);
    expect(compareOpportunities(loConf, hiConf)).toBeGreaterThan(0);

    const newer = mk({ recommendationId: "b", calculatedAt: new Date(NOW.getTime() + 1000).toISOString() });
    const older = mk({ recommendationId: "a", calculatedAt: NOW.toISOString() });
    expect(compareOpportunities(older, newer)).toBeGreaterThan(0); // newer first
    expect(compareOpportunities(newer, older)).toBeLessThan(0);

    const idA = mk({ recommendationId: "rec-a" });
    const idB = mk({ recommendationId: "rec-b" });
    expect(compareOpportunities(idA, idB)).toBe(-1); // lexicographic asc
    expect(compareOpportunities(idB, idA)).toBe(1);
  });

  it("19 — account isolation: foreign-account rows never influence the ranking", () => {
    const mine = makeRecord({ entityId: "mine" });
    const theirs = makeRecord({
      accountId: "act_999",
      entityId: "theirs",
      evidence: makeEvidence({ accountId: "act_999", entityId: "theirs" }),
    });
    const ranking = rankOpportunities({ accountId: ACCOUNT, records: [mine, theirs], context: CTX });
    expect(ranking.items.map((i) => i.entityId)).toEqual(["mine"]);
    expect(ranking.ineligible).toHaveLength(0);
  });

  it("20 — user isolation inside the account: foreign-owned rows are ineligible", () => {
    const mine = makeRecord();
    const foreignOwned = makeRecord({ userId: "user-evil", entityId: "camp-2" });
    const ranking = rankOpportunities({
      accountId: ACCOUNT,
      records: [mine, foreignOwned],
      context: CTX,
    });
    expect(ranking.items).toHaveLength(1);
    expect(ranking.ineligible).toEqual([
      { recommendationId: foreignOwned.recommendationId, reason: "UNAUTHORIZED" },
    ]);
  });

  it("21 — IDOR probe: ranking an account the user owns nothing of yields empty output", () => {
    const ranking = rankOpportunities({
      accountId: "act_other",
      records: [makeRecord()],
      context: CTX,
    });
    expect(ranking.items).toHaveLength(0);
    expect(ranking.ineligible).toHaveLength(0);
  });

  it("22 — unestimable impact degrades gracefully: IMPACT_UNKNOWN + still ranked", () => {
    const res = scoreOpportunity(
      makeRecord({
        evidence: makeEvidence({
          currentMetrics: {},
          metricDetails: [],
          anomalies: [makeAnomaly({ percentDeviation: null })],
        }),
      }),
      CTX
    );
    if (!res.eligible) throw new Error("unexpected");
    expect(res.score.expectedImpact).toBe("IMPACT_UNKNOWN");
    expect(res.score.rationale.limitations).toContain("IMPACT_UNKNOWN_NO_RELIABLE_IMPACT_ESTIMATE");
    expect(res.score.rationale.negativeFactors).toContain("business impact cannot be estimated");
    expect(res.score.score).toBeGreaterThanOrEqual(0);
  });

  it("23 — explainability: positive/negative factors, risk note, historical note populated deterministically", () => {
    const res = scoreOpportunity(
      makeRecord({
        risk: "HIGH",
        confidenceExplanation: makeAssessment({
          historicalEvidence: "MODERATE",
          historicalConsistency: "CONSISTENT_POSITIVE",
          historicalSampleSize: 6,
          sampleQuality: "LOW_SAMPLE",
          limitations: ["LOW_SAMPLE_HISTORY"],
        }),
      }),
      CTX
    );
    if (!res.eligible) throw new Error("unexpected");
    const r = res.score.rationale;
    expect(r.positiveFactors).toContain("severe ctr deterioration");
    expect(r.positiveFactors).toContain("high spend exposure (1200 USD window)");
    expect(r.negativeFactors).toContain("action risk HIGH");
    expect(r.riskNote).toContain("HIGH");
    expect(r.historicalNote).toContain("6 relevant historical outcome(s)");
    expect(r.limitations).toContain("LOW_SAMPLE_HISTORY");
    expect(r.limitations).toContain("SCORE_IS_RELATIVE_OPPORTUNITY_PRIORITY_NOT_SUCCESS_PROBABILITY");
    // Deterministic templates: identical input -> identical strings.
    const again = scoreOpportunity(
      makeRecord({
        risk: "HIGH",
        confidenceExplanation: makeAssessment({
          historicalEvidence: "MODERATE",
          historicalConsistency: "CONSISTENT_POSITIVE",
          historicalSampleSize: 6,
          sampleQuality: "LOW_SAMPLE",
          limitations: ["LOW_SAMPLE_HISTORY"],
        }),
      }),
      CTX
    );
    if (!again.eligible) throw new Error("unexpected");
    expect(again.score.rationale).toEqual(r);
  });

  it("24 — custom weights are honored (configurable model)", () => {
    const res = scoreOpportunity(makeRecord(), { ...CTX, weights: onlyWeights("confidence") });
    const blended = scoreOpportunity(makeRecord(), {
      ...CTX,
      weights: { ...onlyWeights("confidence"), urgency: 1 },
    });
    if (!res.eligible || !blended.eligible) throw new Error("unexpected");
    expect(blended.score.score).toBe(100); // .6 + 1.0 raw clamps at the 100 ceiling
    void res;
  });

  it("25 — every emitted priority matches its score band", () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      makeRecord({
        entityId: `camp-${i}`,
        risk: (["LOW", "MEDIUM", "HIGH"] as const)[i % 3],
        confidence: (["LOW", "MEDIUM", "HIGH"] as const)[i % 3],
        actionType: (["PAUSE_AD", "PAUSE_AD_SET", "INCREASE_BUDGET"] as const)[i % 3],
      })
    );
    const ranking = rankOpportunities({ accountId: ACCOUNT, records, context: CTX });
    expect(ranking.items.length).toBeGreaterThan(0);
    for (const item of ranking.items) {
      expect(item.priority).toBe(bandOf(item.score));
    }
  });

  it("26 — items come back sorted strictly by the documented comparator", () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      makeRecord({
        entityId: `camp-${i % 5}`,
        risk: (["LOW", "MEDIUM", "HIGH"] as const)[i % 3],
      })
    );
    const ranking = rankOpportunities({ accountId: ACCOUNT, records, context: CTX });
    for (let i = 1; i < ranking.items.length; i++) {
      expect(compareOpportunities(ranking.items[i - 1], ranking.items[i])).toBeLessThanOrEqual(0);
    }
  });

  it("27 — rapid deterioration surfaces IMMEDIATE urgency end-to-end", () => {
    const res = scoreOpportunity(makeRecord(), CTX);
    if (!res.eligible) throw new Error("unexpected");
    expect(res.score.urgency).toBe("IMMEDIATE");
    expect(res.score.rationale.positiveFactors).toContain("rapid recent deterioration");
  });

  it("28 — high-confidence + strong history outranks identical low-confidence record", () => {
    const strong = scoreOpportunity(
      makeRecord({
        confidence: "HIGH",
        confidenceExplanation: makeAssessment({
          level: "HIGH",
          historicalEvidence: "STRONG",
          historicalConsistency: "CONSISTENT_POSITIVE",
          historicalSampleSize: 14,
          sampleQuality: "STRONGER_HISTORY",
        }),
      }),
      CTX
    );
    const weak = scoreOpportunity(makeRecord({ confidence: "LOW" }), CTX);
    if (!strong.eligible || !weak.eligible) throw new Error("unexpected");
    expect(strong.score.score).toBeGreaterThan(weak.score.score);
    expect(strong.score.priority === "HIGH" || strong.score.priority === "CRITICAL").toBe(true);
  });

  it("29 — legacy records without 11.8B explanation still score with neutral history", () => {
    const res = scoreOpportunity(makeRecord({ confidenceExplanation: undefined }), CTX);
    if (!res.eligible) throw new Error("unexpected");
    expect(res.score.historicalEvidenceStrength).toBe("NONE");
    expect(res.score.rationale.historicalNote).toBe("No relevant historical evidence.");
    expect(res.score.rationale.limitations).toContain("NO_PHASE_118B_CONFIDENCE_ASSESSMENT_ON_RECORD");
  });

  it("30 — scoring is pure/deterministic: same inputs -> byte-identical contract output", () => {
    const rec = makeRecord();
    const a = scoreOpportunity(rec, CTX);
    const b = scoreOpportunity(rec, CTX);
    expect(a).toEqual(b);
  });

  it("31 — no provider surface: ranking works with plain arrays, no ports/clients passed", () => {
    const records = Array.from({ length: 8 }, () => makeRecord({ entityId: `c-${Math.random()}` }));
    const ranking = rankOpportunities({ accountId: ACCOUNT, records, context: CTX });
    expect(Array.isArray(ranking.items)).toBe(true);
    expect(ranking.items.every((i) => typeof i.score === "number")).toBe(true);
  });

  it("32 — performance: 1000 recommendations ranked well under interactive latency, no N+1", async () => {
    const records = Array.from({ length: 1000 }, (_, i) =>
      makeRecord({ entityId: `camp-${i % 200}`, risk: (["LOW", "MEDIUM", "HIGH"] as const)[i % 3] })
    );
    const t0 = Date.now();
    const ranking = rankOpportunities({ accountId: ACCOUNT, records, context: CTX });
    const elapsed = Date.now() - t0;
    expect(ranking.items.length).toBe(1000);
    expect(elapsed).toBeLessThan(5000);
  });
});
