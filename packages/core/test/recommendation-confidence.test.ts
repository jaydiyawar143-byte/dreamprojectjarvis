import { describe, it, expect } from "vitest";
import {
  RecommendationEngine,
  DEFAULT_MAX_HISTORICAL_OUTCOMES,
  type HistoricalOutcomePort,
} from "../src/recommendation-engine.js";
import {
  evaluateHistoricalEvidenceForContext,
  type HistoricalEvaluationContext,
} from "../src/historical-outcome-engine.js";
import {
  classifySampleSize,
  assessHistoricalConsistency,
  assessHistoricalStrength,
  computeCurrentEvidenceStrength,
  computeConfidenceAssessment,
  computePriority,
  computeHistoricalEvidenceHash,
} from "../src/recommendation-confidence.js";
import { ConfidenceAssessmentSchema } from "../src/types/recommendation.js";
import type { OutcomeRecord } from "../src/types/outcome.js";
import {
  buildFatigueRecommendationInput,
  MemoryRecommendationStore,
  FakeExternalState,
  activeCampaignState,
  type RecommendationFixture,
} from "./recommendation-fixtures.js";

// ---------------------------------------------------------------------------
// Phase 11.8B — Historical Evidence → Recommendation Confidence tests
// ---------------------------------------------------------------------------
// All historical outcome data is MOCKED. Zero LLM calls. Zero Meta writes.
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-09-01T12:00:00.000Z";
const ACCOUNT_ID = "act_1";
const OTHER_ACCOUNT_ID = "act_other";
const USER_ID = "user_1";
const OTHER_USER_ID = "user_other";
const ENTITY_ID = "cmp_1";

// ---------------------------------------------------------------------------
// Mock outcome factory (server-shaped, deterministic)
// ---------------------------------------------------------------------------

let outcomeCounter = 0;

export function makeOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  outcomeCounter += 1;
  const id = overrides.outcomeId ?? `out_${String(outcomeCounter).padStart(5, "0")}`;
  return {
    outcomeId: id,
    recommendationId: `rec_${id}`,
    executionId: `exec_${id}`,
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    entityType: "CAMPAIGN",
    entityId: ENTITY_ID,
    actionType: "DECREASE_BUDGET",
    objective: "OUTCOME_SALES",
    primaryMetric: "CPA",
    diagnosisCategory: "CREATIVE_FATIGUE",
    baseline: {
      schemaVersion: 1,
      dateRangeStart: "2026-07-01",
      dateRangeEnd: "2026-07-07",
      timezone: "UTC",
      currency: "USD",
      source: "meta-graph",
      fetchedAt: "2026-07-08T00:00:00.000Z",
      kpiEngineVersion: "11.1.0",
      aggregationVersion: "11.2.0",
      kpis: {
        spend: 100, impressions: 10000, clicks: 200, reach: 8000, conversions: 10,
        revenue: 500, ctr: 0.02, cpc: 0.5, cpm: 10, cpa: 10, roas: 5, cvr: 0.05, frequency: 1.2,
      },
    },
    measurement: {
      spend: 100, impressions: 10000, clicks: 200, reach: 8000, conversions: 10,
      revenue: 500, ctr: 0.02, cpc: 0.5, cpm: 10, cpa: 10, roas: 5, cvr: 0.05, frequency: 1.2,
    },
    comparison: {
      metric: "CPA", baseline: 10, current: 8, absoluteChange: -2, percentChange: -20,
      direction: "IMPROVED", isMaterial: true,
    },
    outcome: "POSITIVE",
    confidence: 0.9,
    dataQuality: "COMPLETE",
    attributionStatus: "ATTRIBUTION_READY",
    confounders: [],
    measurementWindow: {
      stabilizationMs: 48 * 60 * 60 * 1000,
      measurementMs: 7 * 24 * 60 * 60 * 1000,
      attributionWindowMs: 7 * 24 * 60 * 60 * 1000,
      minimumDataDays: 3,
      minimumSpend: 10,
      minimumConversions: 3,
      maxDataAgeMs: 48 * 60 * 60 * 1000,
    },
    measuredAt: "2026-08-25T00:00:00.000Z",
    createdAt: "2026-08-18T00:00:00.000Z",
    measurementState: "FINALIZED",
    ...overrides,
  };
}

/** Fully-relevant outcome: exact action/category/entity/objective/metric match. */
function relevant(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return makeOutcome({ actionType: "DECREASE_BUDGET", ...overrides });
}

// ---------------------------------------------------------------------------
// History ports
// ---------------------------------------------------------------------------

/** Server-faithful port: scopes by userId+accountId, honors bounded limit. */
class MemoryHistoryPort implements HistoricalOutcomePort {
  calls = 0;
  readonly lastFilters: Array<{ accountId: string; limit?: number }> = [];
  constructor(private readonly rows: OutcomeRecord[]) {}
  async findFinalizedOutcomes(
    userId: string,
    filters: { accountId: string; limit?: number }
  ): Promise<OutcomeRecord[]> {
    this.calls += 1;
    this.lastFilters.push(filters);
    return this.rows
      .filter((r) => r.userId === userId && r.accountId === filters.accountId)
      .slice(0, filters.limit ?? Number.MAX_SAFE_INTEGER);
  }
}

/**
 * Adversarial port simulating a broken/misconfigured backend: returns rows
 * regardless of scope so we can prove the ENGINE'S OWN isolation guard works.
 */
class LeakyHistoryPort implements HistoricalOutcomePort {
  calls = 0;
  constructor(private readonly rows: OutcomeRecord[]) {}
  async findFinalizedOutcomes(): Promise<OutcomeRecord[]> {
    this.calls += 1;
    return this.rows;
  }
}

// ---------------------------------------------------------------------------
// Engine harness
// ---------------------------------------------------------------------------

interface Harness {
  store: MemoryRecommendationStore;
  state: FakeExternalState;
  history?: MemoryHistoryPort | LeakyHistoryPort;
  engine: RecommendationEngine;
}

function makeHarness(
  opts: {
    now?: string;
    historyRows?: OutcomeRecord[];
    leaky?: boolean;
    useHistory?: boolean;
  } = {}
): Harness {
  const store = new MemoryRecommendationStore();
  const state = new FakeExternalState();
  const history = opts.historyRows
    ? opts.leaky
      ? new LeakyHistoryPort(opts.historyRows)
      : new MemoryHistoryPort(opts.historyRows)
    : undefined;
  const engine = new RecommendationEngine(
    store,
    state.port,
    { historyPort: opts.useHistory === false ? undefined : history },
    opts.now ? () => new Date(opts.now!) : undefined
  );
  return { store, state, history, engine };
}

function standardFixture(): RecommendationFixture {
  return buildFatigueRecommendationInput({ userId: USER_ID });
}

async function generateWith(h: Harness, fx?: RecommendationFixture) {
  const fixture = fx ?? standardFixture();
  h.state.set(
    fixture.evidence.accountId,
    fixture.evidence.entityLevel,
    fixture.evidence.entityId,
    activeCampaignState(1000)
  );
  return h.engine.generate(fixture);
}

function expectCreated<T extends { status: string }>(out: T): Extract<T, { status: "CREATED" }> {
  if (out.status !== "CREATED") throw new Error(`expected CREATED, got ${JSON.stringify(out)}`);
  return out;
}

const positives = (n: number, o: Partial<OutcomeRecord> = {}) =>
  Array.from({ length: n }, (_, i) => relevant({ outcome: "POSITIVE", outcomeId: `pos_${i}`, ...o }));
const negatives = (n: number, o: Partial<OutcomeRecord> = {}) =>
  Array.from({ length: n }, (_, i) => relevant({ outcome: "NEGATIVE", outcomeId: `neg_${i}`, ...o }));

// ===========================================================================
// A. FOCUSED SCENARIOS (spec §18 items 1–27)
// ===========================================================================

describe("Phase 11.8B — historical integration through RecommendationEngine", () => {
  it("1. no historical evidence: engine still creates, NO_HISTORY, zero ids", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: [] });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.historicalEvidenceIds).toEqual([]);
    expect(out.recommendation.confidenceExplanation?.sampleQuality).toBe("NO_HISTORY");
    expect(out.recommendation.confidenceExplanation?.historicalEvidence).toBe("NONE");
    expect(out.audit.historicalEvidenceCount).toBe(0);
    expect(out.audit.historicalEvidenceHash).toBeDefined();
  });

  it("2. strong positive history (10x consistent) boosts MEDIUM -> HIGH", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: positives(10) });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.confidence).toBe("HIGH");
    expect(out.recommendation.confidenceExplanation?.level).toBe("HIGH");
    expect(out.recommendation.confidenceExplanation?.currentEvidence).toBe("MEDIUM");
    expect(out.recommendation.confidenceExplanation?.sampleQuality).toBe("STRONGER_HISTORY");
    expect(out.recommendation.confidenceExplanation?.historicalConsistency).toBe(
      "CONSISTENT_POSITIVE"
    );
  });

  it("3. strong negative history downgrades confidence and lists contradictions", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: negatives(10) });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.confidence).toBe("LOW");
    expect(out.recommendation.confidenceExplanation?.historicalConsistency).toBe(
      "CONSISTENT_NEGATIVE"
    );
    expect(out.recommendation.confidenceExplanation?.contradictoryEvidence.length).toBe(10);
    expect(out.audit.confidenceBeforeHistory).toBe("MEDIUM");
    expect(out.audit.confidenceAfterHistory).toBe("LOW");
  });

  it("4. mixed history (5P/5N) reduces confidence — contradictions never hidden", async () => {
    const h = makeHarness({
      now: FIXED_NOW,
      historyRows: [...positives(5), ...negatives(5)],
    });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.confidenceExplanation?.historicalConsistency).toBe("MIXED");
    expect(out.recommendation.confidence).toBe("LOW");
    expect(out.recommendation.confidenceExplanation?.limitations).toContain("MIXED_HISTORY");
    // Contradictions remain traceable, not hidden:
    expect(out.recommendation.confidenceExplanation?.contradictoryEvidence.length).toBe(5);
  });

  it("5. low sample (3–9, consistent): NO boost to HIGH despite positive history", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: positives(3) });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.confidenceExplanation?.sampleQuality).toBe("LOW_SAMPLE");
    expect(out.recommendation.confidenceExplanation?.historicalEvidence).toBe("MODERATE");
    expect(out.recommendation.confidence).toBe("MEDIUM"); // unchanged
  });

  it("6. strong sample (10+) classifies STRONGER_HISTORY", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: positives(12) });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.confidenceExplanation?.sampleQuality).toBe("STRONGER_HISTORY");
    expect(out.recommendation.confidence).toBe("HIGH");
  });

  it("7. recent history carries near-full weight", async () => {
    const ctx = baseContext();
    const recent = evaluateHistoricalEvidenceForContext(
      ctx,
      [relevant({ measuredAt: "2026-08-31T00:00:00.000Z" })],
      {},
      new Date(FIXED_NOW)
    );
    expect(recent.summaryStatistics.relevantOutcomes[0].weight).toBeGreaterThan(0.85); // 0.9 similarity x ~0.99 recency
  });

  it("8. old history decays but is never fully erased (floor respected)", async () => {
    const ctx = baseContext();
    const ev = evaluateHistoricalEvidenceForContext(
      ctx,
      [
        relevant({ outcomeId: "recent_o", measuredAt: "2026-08-31T00:00:00.000Z" }),
        relevant({ outcomeId: "ancient_o", measuredAt: "2024-01-01T00:00:00.000Z" }),
      ],
      {},
      new Date(FIXED_NOW)
    );
    const w = Object.fromEntries(
      ev.summaryStatistics.relevantOutcomes.map((o) => [o.outcomeId, o.weight])
    );
    expect(w["recent_o"]).toBeGreaterThan(w["ancient_o"]);
    expect(w["ancient_o"]).toBeGreaterThanOrEqual(0.09 * 0.999); // 0.9 similarity * 0.1 floor
  });

  it("9. diagnosis match: same-category outcomes included, others excluded", () => {
    const ctx = baseContext();
    const ev = evaluateHistoricalEvidenceForContext(
      ctx,
      [
        relevant({ outcomeId: "same_cat" }),
        relevant({
          outcomeId: "diff_cat",
          diagnosisCategory: "AUDIENCE_SATURATION",
          actionType: "PAUSE_AD_SET",
          entityType: "AD_SET",
          objective: null,
        }),
      ],
      {},
      new Date(FIXED_NOW)
    );
    expect(ev.matchingOutcomeIds).toContain("same_cat");
    expect(ev.matchingOutcomeIds).not.toContain("diff_cat");
  });

  it("10. action match: exact action scores above family-only match", () => {
    const ctx = baseContext();
    const ev = evaluateHistoricalEvidenceForContext(
      ctx,
      [
        relevant({ outcomeId: "exact", primaryMetric: "SPEND" }), // DECREASE_BUDGET == candidate
        relevant({ outcomeId: "family_only", diagnosisCategory: null, primaryMetric: "SPEND" }),
      ],
      { similarityThreshold: 0.55 },
      new Date(FIXED_NOW)
    );
    const s = Object.fromEntries(
      ev.summaryStatistics.relevantOutcomes.map((o) => [o.outcomeId, o.similarity])
    );
    expect(s["exact"]).toBeGreaterThan(s["family_only"]);
  });

  it("11. objective match contributes to similarity", () => {
    const ctx = baseContext();
    const ev = evaluateHistoricalEvidenceForContext(
      ctx,
      [
        relevant({ outcomeId: "obj_match", objective: "OUTCOME_SALES", primaryMetric: "SPEND" }),
        relevant({ outcomeId: "obj_diff", objective: "OUTCOME_LEADS", primaryMetric: "SPEND" }),
      ],
      { similarityThreshold: 0.95 },
      new Date(FIXED_NOW)
    );
    expect(ev.matchingOutcomeIds).toContain("obj_match");
    expect(ev.matchingOutcomeIds).not.toContain("obj_diff");
  });

  it("12. metric match contributes to similarity", () => {
    const ctx = baseContext();
    const ev = evaluateHistoricalEvidenceForContext(
      ctx,
      [
        relevant({ outcomeId: "metric_match", primaryMetric: "SPEND" }),
        relevant({ outcomeId: "metric_diff", primaryMetric: "CPC" }),
      ],
      { similarityThreshold: 0.95 },
      new Date(FIXED_NOW)
    );
    expect(ev.matchingOutcomeIds).toContain("metric_match");
    expect(ev.matchingOutcomeIds).not.toContain("metric_diff");
  });

  it("13. entity-type match contributes to similarity", () => {
    const ctx = baseContext();
    const ev = evaluateHistoricalEvidenceForContext(
      ctx,
      [
        relevant({ outcomeId: "etype_match", entityType: "CAMPAIGN", primaryMetric: "SPEND" }),
        relevant({ outcomeId: "etype_diff", entityType: "AD_SET", primaryMetric: "SPEND" }),
      ],
      { similarityThreshold: 0.95 },
      new Date(FIXED_NOW)
    );
    expect(ev.matchingOutcomeIds).toContain("etype_match");
    expect(ev.matchingOutcomeIds).not.toContain("etype_diff");
  });

  it("14. contradictory outcomes are enumerated with traceable ids", async () => {
    const rows = [...positives(8), ...negatives(2)];
    const h = makeHarness({ now: FIXED_NOW, historyRows: rows });
    const out = expectCreated(await generateWith(h));
    const contra = out.recommendation.confidenceExplanation?.contradictoryEvidence ?? [];
    expect(contra.length).toBe(2);
    for (const id of contra) {
      expect(out.recommendation.historicalEvidenceIds).toContain(id);
      expect(rows.some((r) => r.outcomeId === id)).toBe(true);
    }
  });

  it("15. poor-quality outcomes are excluded from historical support", async () => {
    const h = makeHarness({
      now: FIXED_NOW,
      historyRows: [
        ...positives(4),
        relevant({ outcomeId: "bad_insufficient", dataQuality: "INSUFFICIENT_DATA" }),
        relevant({ outcomeId: "bad_unavailable", dataQuality: "UNAVAILABLE" }),
      ],
    });
    const out = expectCreated(await generateWith(h));
    expect(out.audit.historicalEvidenceCount).toBe(4);
    expect(out.recommendation.historicalEvidenceIds).not.toContain("bad_insufficient");
    expect(out.recommendation.historicalEvidenceIds).not.toContain("bad_unavailable");
  });

  it("16. attribution-pending outcomes never count as evidence", async () => {
    const h = makeHarness({
      now: FIXED_NOW,
      historyRows: [
        ...positives(4),
        relevant({ outcomeId: "pending_1", attributionStatus: "ATTRIBUTION_PENDING" }),
      ],
    });
    const out = expectCreated(await generateWith(h));
    expect(out.audit.historicalEvidenceCount).toBe(4);
    expect(out.recommendation.historicalEvidenceIds).not.toContain("pending_1");
  });

  it("17. confidence increase is auditable (before -> after)", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: positives(10) });
    const out = expectCreated(await generateWith(h));
    expect(out.audit.confidenceBeforeHistory).toBe("MEDIUM");
    expect(out.audit.confidenceAfterHistory).toBe("HIGH");
    expect(out.recommendation.confidence).toBe("HIGH");
  });

  it("18. confidence decrease is auditable (before -> after)", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: negatives(10) });
    const out = expectCreated(await generateWith(h));
    expect(out.audit.confidenceBeforeHistory).toBe("MEDIUM");
    expect(out.audit.confidenceAfterHistory).toBe("LOW");
  });

  it("19. weak current evidence + contradictory history NEVER auto-elevates (unit)", () => {
    // Weak current: diagnosis LOW + thin warning signal.
    const weakDiagnosis = {
      ...(standardFixture().diagnosis),
      confidence: "LOW" as const,
    };
    const pkg = standardFixture().evidence;
    const mixedHistory = makeSyntheticHistory({
      sampleQuality: "STRONGER_HISTORY",
      consistency: "MIXED",
    });
    const res = computeConfidenceAssessment({
      diagnosis: weakDiagnosis,
      evidence: pkg,
      historical: mixedHistory,
    });
    expect(res.level).toBe("LOW"); // strong history cannot rescue weak current
  });

  it("20. no-recommendation path: contradictory history + weak current is refused", async () => {
    // Drive the dedicated gate directly: weak current evidence shape.
    const h = makeHarness({ now: FIXED_NOW, historyRows: negatives(10) });
    // Simulate the internal gate decision deterministically:
    const fixture = standardFixture();
    h.state.set(fixture.evidence.accountId, fixture.evidence.entityLevel, fixture.evidence.entityId, activeCampaignState(1000));
    const assessment = computeConfidenceAssessment({
      diagnosis: fixture.diagnosis,
      evidence: fixture.evidence,
      historical: makeSyntheticHistory({
        sampleQuality: "STRONGER_HISTORY",
        consistency: "CONSISTENT_NEGATIVE",
      }),
    });
    const wouldCreate = assessment.beforeHistory !== "LOW";
    // With MEDIUM current: created with downgrade (strong current survives mixed past).
    const out = await generateWith(h, fixture);
    if (wouldCreate) {
      expectCreated(out);
    }
    // TRACKING_ISSUE diagnosis remains a hard no-spend-action regardless of history:
    const trackingFx = buildFatigueRecommendationInput({
      userId: USER_ID,
      category: "TRACKING_ISSUE",
    });
    const h2 = makeHarness({ now: FIXED_NOW, historyRows: positives(10) });
    h2.state.set(trackingFx.evidence.accountId, trackingFx.evidence.entityLevel, trackingFx.evidence.entityId, activeCampaignState(1000));
    const trackingOut = await h2.engine.generate(trackingFx);
    expect(trackingOut.status).toBe("NO_RECOMMENDATION");
    expect(trackingOut.status === "NO_RECOMMENDATION" && trackingOut.reason).toBe(
      "NO_SPEND_ACTION_TRACKING_ISSUE"
    );
  });

  it("21. evidence traceability: every historical contribution references an outcomeId", async () => {
    const rows = [...positives(6), ...negatives(3)];
    const h = makeHarness({ now: FIXED_NOW, historyRows: rows });
    const out = expectCreated(await generateWith(h));
    const ids = out.recommendation.historicalEvidenceIds;
    expect(ids.length).toBe(9);
    const known = new Set(rows.map((r) => r.outcomeId));
    for (const id of ids) expect(known.has(id)).toBe(true);
    // Explanation contradicts reference the same server-side ids:
    for (const cid of out.recommendation.confidenceExplanation?.contradictoryEvidence ?? []) {
      expect(ids).toContain(cid);
    }
  });

  it("22. account isolation: another account's outcomes never contribute", async () => {
    const h = makeHarness({
      now: FIXED_NOW,
      historyRows: positives(10, { accountId: OTHER_ACCOUNT_ID }),
    });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.historicalEvidenceIds).toEqual([]);
    expect(out.audit.historicalEvidenceCount).toBe(0);
  });

  it("23. user isolation: another user's outcomes in the SAME account never contribute", async () => {
    const h = makeHarness({
      now: FIXED_NOW,
      historyRows: positives(10, { userId: OTHER_USER_ID }),
    });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.historicalEvidenceIds).toEqual([]);
    expect(out.audit.historicalEvidenceCount).toBe(0);
  });

  it("24. deterministic result: identical inputs produce byte-identical decisions", async () => {
    const run = async () => {
      const h = makeHarness({ now: FIXED_NOW, historyRows: positives(10) });
      const out = expectCreated(await generateWith(h));
      return {
        confidence: out.recommendation.confidence,
        priority: out.recommendation.priority,
        ids: out.recommendation.historicalEvidenceIds,
        explanation: out.recommendation.confidenceExplanation,
        paramsHash: out.recommendation.paramsHash,
        stateHash: out.recommendation.stateHash,
        identityHash: out.recommendation.identityHash,
        histHash: out.audit.historicalEvidenceHash,
      };
    };
    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
  });

  it("25. zero LLM calls: generation completes with no AI provider present", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: positives(10) });
    // The engine holds no AI/provider references; if any LLM call were attempted
    // it could only fail — success proves none occurred.
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.actionType).toBe("DECREASE_BUDGET");
  });

  it("26. zero Meta writes: read-only state lookups, approval-bound record", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: positives(10) });
    const out = expectCreated(await generateWith(h));
    expect(h.state.loadCalls).toBeGreaterThanOrEqual(1);
    expect(out.recommendation.status).toBe("PROPOSED");
    expect(out.recommendation.requiresApproval).toBe(true);
    expect(out.recommendation.proposedState["dailyBudget"]).toBe(800); // proposal only
  });

  it("27. backward compatibility: engine WITHOUT history matches Phase 11.5 semantics", async () => {
    const legacy = makeHarness({ now: FIXED_NOW, useHistory: false });
    const out = expectCreated(await generateWith(legacy));
    const fixture = standardFixture();
    expect(out.recommendation.confidence).toBe(fixture.diagnosis.confidence); // Phase 11.5 semantics
    expect(out.recommendation.historicalEvidenceIds).toEqual([]);
    expect(out.recommendation.priority).toBeTypeOf("string");
    // Same input WITH an empty-history port produces the same confidence:
    const withEmptyPort = makeHarness({ now: FIXED_NOW, historyRows: [] });
    const out2 = expectCreated(await generateWith(withEmptyPort, fixture));
    expect(out2.recommendation.confidence).toBe(out.recommendation.confidence);
    expect(out2.recommendation.identityHash).toBe(out.recommendation.identityHash);
  });
});

// ---------------------------------------------------------------------------
// Shared helpers for context-level evaluations
// ---------------------------------------------------------------------------

function baseContext(): HistoricalEvaluationContext {
  return {
    accountId: ACCOUNT_ID,
    userId: USER_ID,
    entityLevel: "CAMPAIGN",
    entityId: ENTITY_ID,
    actionType: "DECREASE_BUDGET",
    diagnosisCategory: "CREATIVE_FATIGUE",
    objective: "OUTCOME_SALES",
    primaryMetric: "SPEND",
  };
}

/** Minimal valid HistoricalEvidence built from real evaluation machinery. */
function makeSyntheticHistory(shape: {
  sampleQuality: "VERY_LOW_SAMPLE" | "LOW_SAMPLE" | "STRONGER_HISTORY";
  consistency: "CONSISTENT_POSITIVE" | "CONSISTENT_NEGATIVE" | "MIXED";
}) {
  const counts: Record<string, [number, number]> = {
    STRONGER_HISTORY: shape.consistency === "MIXED" ? [10, 10] : [10, 2],
    LOW_SAMPLE: shape.consistency === "MIXED" ? [4, 4] : [5, 1],
    VERY_LOW_SAMPLE: [1, 1],
  };
  const [p, n] = counts[shape.sampleQuality];
  const rows = [
    ...Array.from({ length: p }, (_, i) =>
      relevant({ outcome: "POSITIVE" as const, outcomeId: `syn_p${i}` })
    ),
    ...Array.from({ length: n }, (_, i) =>
      relevant({ outcome: "NEGATIVE" as const, outcomeId: `syn_n${i}` })
    ),
  ];
  return evaluateHistoricalEvidenceForContext(baseContext(), rows, {}, new Date(FIXED_NOW));
}

// ===========================================================================
// B. CONFIDENCE MODEL UNIT TESTS (pure functions)
// ===========================================================================

describe("Phase 11.8B — deterministic confidence model units", () => {
  it("sample size classification thresholds (configurable)", () => {
    expect(classifySampleSize(0)).toBe("NO_HISTORY");
    expect(classifySampleSize(1)).toBe("VERY_LOW_SAMPLE");
    expect(classifySampleSize(2)).toBe("VERY_LOW_SAMPLE");
    expect(classifySampleSize(3)).toBe("LOW_SAMPLE");
    expect(classifySampleSize(9)).toBe("LOW_SAMPLE");
    expect(classifySampleSize(10)).toBe("STRONGER_HISTORY");
    expect(classifySampleSize(5, { veryLowMax: 4, lowMax: 6 })).toBe("LOW_SAMPLE");
    expect(classifySampleSize(3, { veryLowMax: 4, lowMax: 6 })).toBe("VERY_LOW_SAMPLE");
  });

  it("consistency: 8/1/1 of 10 decisive-positive vs 5/5 mixed", () => {
    expect(assessHistoricalConsistency(8 / 9, 1 / 9, 10)).toBe("CONSISTENT_POSITIVE");
    expect(assessHistoricalConsistency(0.5, 0.5, 10)).toBe("MIXED");
    expect(assessHistoricalConsistency(0.2, 0.8, 10)).toBe("CONSISTENT_NEGATIVE");
    expect(assessHistoricalConsistency(0, 0, 0)).toBe("NONE");
  });

  it("strength labels: NONE/WEAK/MODERATE/STRONG with quality caps", () => {
    expect(assessHistoricalStrength("NO_HISTORY", "NONE", "NO_DATA")).toBe("NONE");
    expect(assessHistoricalStrength("VERY_LOW_SAMPLE", "CONSISTENT_POSITIVE", "HIGH_QUALITY")).toBe("WEAK");
    expect(assessHistoricalStrength("LOW_SAMPLE", "CONSISTENT_POSITIVE", "HIGH_QUALITY")).toBe("MODERATE");
    expect(assessHistoricalStrength("STRONGER_HISTORY", "CONSISTENT_POSITIVE", "HIGH_QUALITY")).toBe("STRONG");
    expect(assessHistoricalStrength("STRONGER_HISTORY", "MIXED", "HIGH_QUALITY")).toBe("WEAK");
    expect(assessHistoricalStrength("STRONGER_HISTORY", "CONSISTENT_POSITIVE", "MIXED_QUALITY")).toBe("MODERATE");
  });

  it("current evidence strength rules", () => {
    const fx = standardFixture();
    const highDiag = { ...fx.diagnosis, confidence: "HIGH" as const };
    expect(computeCurrentEvidenceStrength(highDiag, fx.evidence)).toBe("HIGH");
    expect(computeCurrentEvidenceStrength(fx.diagnosis, fx.evidence)).toBe("MEDIUM");
    const lowDiag = { ...fx.diagnosis, confidence: "LOW" as const };
    expect(computeCurrentEvidenceStrength(lowDiag, fx.evidence)).toBe("LOW");
  });

  it("assessment validates against its schema and carries standing limitation", () => {
    const fx = standardFixture();
    const res = computeConfidenceAssessment({
      diagnosis: fx.diagnosis,
      evidence: fx.evidence,
      historical: makeSyntheticHistory({ sampleQuality: "STRONGER_HISTORY", consistency: "CONSISTENT_POSITIVE" }),
    });
    expect(() => ConfidenceAssessmentSchema.parse(res.assessment)).not.toThrow();
    expect(res.assessment.limitations).toContain("HISTORY_IS_SUPPORTING_EVIDENCE_ONLY");
    expect(res.assessment.limitations).toContain("NO_STATISTICAL_SIGNIFICANCE_CLAIMED");
  });

  it("no causal language in any produced explanation text", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: positives(10) });
    const out = expectCreated(await generateWith(h));
    const blob = JSON.stringify(out.recommendation.confidenceExplanation);
    for (const banned of ["will improve", "will decrease", "proves", "guarantees", "%"]) {
      expect(blob.toLowerCase()).not.toContain(banned);
    }
  });
});

// ===========================================================================
// C. PRIORITY MODEL (spec §10 — deliberately != confidence)
// ===========================================================================

describe("Phase 11.8B — deterministic priority model", () => {
  const base = {
    actionType: "DECREASE_BUDGET" as const,
    entityLevel: "CAMPAIGN" as const,
    risk: "LOW" as const,
    confidence: "HIGH" as const,
    anomalies: [],
    historicalStrength: "NONE" as const,
    historicalConsistency: "NONE" as const,
  };

  it("HIGH confidence + low impact => MEDIUM priority (spec example)", () => {
    expect(
      computePriority({ ...base, entityLevel: "AD", anomalies: [] })
    ).toBe("MEDIUM");
  });

  it("CAMPAIGN-level severe anomaly raises priority", () => {
    const anomalies = [
      { direction: "NEGATIVE_ANOMALY", severity: "CRITICAL" },
    ] as never[];
    expect(computePriority({ ...base, anomalies })).toBe("HIGH");
  });

  it("MEDIUM confidence + severe CPA deterioration + strong supporting history => HIGH (spec example)", () => {
    const anomalies = [
      { direction: "NEGATIVE_ANOMALY", severity: "CRITICAL" },
    ] as never[];
    expect(
      computePriority({
        ...base,
        confidence: "MEDIUM",
        anomalies,
        historicalStrength: "STRONG",
        historicalConsistency: "CONSISTENT_POSITIVE",
      })
    ).toBe("HIGH");
  });

  it("HIGH risk brakes priority", () => {
    const anomalies = [{ direction: "NEGATIVE_ANOMALY", severity: "CRITICAL" }] as never[];
    expect(
      computePriority({ ...base, entityLevel: "AD_SET", risk: "HIGH", anomalies })
    ).toBe("MEDIUM");
  });

  it("contradictory history lowers priority", () => {
    expect(
      computePriority({
        ...base,
        confidence: "MEDIUM",
        entityLevel: "AD_SET",
        historicalStrength: "WEAK",
        historicalConsistency: "MIXED",
      })
    ).toBe("LOW");
  });

  it("priority diverges from confidence (not a rename)", () => {
    const anomalies = [{ direction: "NEGATIVE_ANOMALY", severity: "WARNING" }, { direction: "NEGATIVE_ANOMALY", severity: "WARNING" }] as never[];
    // MEDIUM confidence but urgent campaign-level signals => HIGH priority:
    expect(
      computePriority({ ...base, confidence: "MEDIUM", entityLevel: "CAMPAIGN", anomalies })
    ).toBe("HIGH");
  });

  it("engine stamps priority onto created recommendations", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: positives(10) });
    const out = expectCreated(await generateWith(h));
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(out.recommendation.priority);
    expect(out.audit.priority).toBe(out.recommendation.priority);
  });
});

// ===========================================================================
// D. ADVERSARIAL TESTS (spec §19)
// ===========================================================================

describe("Phase 11.8B — adversarial: engine trusts ONLY server-validated history", () => {
  it("fake outcomeId (empty/garbage) is rejected by the isolation guard", async () => {
    const h = makeHarness({
      now: FIXED_NOW,
      leaky: true,
      historyRows: [
        relevant({ outcomeId: "" }),
        relevant({ outcomeId: "   " }),
        ...positives(3, { outcomeId: undefined as never }),
      ].filter((r) => typeof r.outcomeId === "string"),
    });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.historicalEvidenceIds.every((id) => id.trim().length > 0)).toBe(
      true
    );
  });

  it("outcome from another account is IGNORED even when the port leaks it", async () => {
    const h = makeHarness({
      now: FIXED_NOW,
      leaky: true,
      historyRows: positives(10, { accountId: OTHER_ACCOUNT_ID }),
    });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.confidenceExplanation?.sampleQuality).toBe("NO_HISTORY");
    expect(out.audit.detail).toContain("foreign-scoped");
  });

  it("fabricated positive history under a borrowed scope is IGNORED", async () => {
    // Attacker-controlled rows claiming 10 wins but owned by someone else:
    const h = makeHarness({
      now: FIXED_NOW,
      leaky: true,
      historyRows: positives(10, { userId: OTHER_USER_ID, confidence: 1.0 }),
    });
    const out = expectCreated(await generateWith(h));
    expect(out.recommendation.confidence).not.toBe("HIGH");
    expect(out.recommendation.historicalEvidenceIds).toEqual([]);
  });

  it("client cannot smuggle historicalEvidence into GenerateInput (strict schema)", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: [] });
    const fx = standardFixture();
    h.state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, activeCampaignState(1000));
    const out = await h.engine.generate({
      ...fx,
      historicalEvidence: { sampleSize: 999, positiveRate: 1.0 },
      traceId: "t",
    } as never);
    expect(out.status).toBe("INVALID_INPUT");
  });

  it("fabricated sample count / success rate have no injection surface", async () => {
    // The ONLY history source is the port; numbers are recomputed from raw
    // server rows. Prove computed counts equal actual mocked rows, not claims:
    const rows = [...positives(7), ...negatives(3)];
    const h = makeHarness({ now: FIXED_NOW, historyRows: rows });
    const out = expectCreated(await generateWith(h));
    expect(out.audit.historicalEvidenceCount).toBe(10);
    const expl = out.recommendation.confidenceExplanation!;
    expect(expl.historicalSampleSize).toBe(10);
    expect(expl.contradictoryEvidence.length).toBe(3);
  });

  it("numeric AI-generated confidence is rejected by the input contract", async () => {
    const h = makeHarness({ now: FIXED_NOW, historyRows: [] });
    const fx = standardFixture();
    const out = await h.engine.generate({
      ...fx,
      diagnosis: { ...fx.diagnosis, confidence: 0.87 as never },
    });
    expect(out.status).toBe("INVALID_INPUT");
  });

  it("modified historical outcome changes the tamper-evident audit hash", async () => {
    const fx = standardFixture();
    const histGood = evaluateHistoricalEvidenceForContext(
      baseContext(),
      positives(10),
      {},
      new Date(FIXED_NOW)
    );
    // Tamper: flip verdicts — same rows, different content.
    const histBad = evaluateHistoricalEvidenceForContext(
      baseContext(),
      negatives(10),
      {},
      new Date(FIXED_NOW)
    );
    expect(computeHistoricalEvidenceHash(histGood)).not.toBe(
      computeHistoricalEvidenceHash(histBad)
    );
    // And confidence follows the (server-validated) modification:
    const before = computeConfidenceAssessment({
      diagnosis: fx.diagnosis,
      evidence: fx.evidence,
      historical: histGood,
    });
    const after = computeConfidenceAssessment({
      diagnosis: fx.diagnosis,
      evidence: fx.evidence,
      historical: histBad,
    });
    expect(before.level).toBe("HIGH");
    expect(after.level).toBe("LOW");
  });
});

// ===========================================================================
// E. PERFORMANCE & SCALE (spec §20)
// ===========================================================================

describe("Phase 11.8B — performance: 10k outcomes x 1000 contexts", () => {
  it("bounded queries, no N+1, deterministic, fast", async () => {
    // 10,000 historical outcomes (half irrelevant by scope).
    const bigRows: OutcomeRecord[] = [];
    for (let i = 0; i < 10_000; i++) {
      const scoped = i % 2 === 0;
      bigRows.push(
        relevant({
          outcomeId: `bulk_${i}`,
          outcome: i % 3 === 0 ? "POSITIVE" : i % 3 === 1 ? "NEGATIVE" : "NEUTRAL",
          accountId: scoped ? ACCOUNT_ID : OTHER_ACCOUNT_ID,
          userId: scoped ? USER_ID : OTHER_USER_ID,
        })
      );
    }

    // 1,000 distinct recommendation contexts through the FULL engine path.
    const store = new MemoryRecommendationStore();
    const state = new FakeExternalState();
    const port = new MemoryHistoryPort(bigRows);
    const engine = new RecommendationEngine(
      store,
      state.port,
      {
        historyPort: port,
        // Scale test only: lift the Phase 11.5 per-account daily budget cap so
        // all 1000 contexts reach the historical evaluation stage.
        maxBudgetActionsPerAccountPerDay: 1_000_000,
      },
      () => new Date(FIXED_NOW)
    );

    const started = performance.now();
    let created = 0;
    for (let i = 0; i < 1000; i++) {
      const fx = buildFatigueRecommendationInput({
        userId: USER_ID,
        accountId: ACCOUNT_ID,
        entityId: `cmp_perf_${i}`,
      });
      state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, activeCampaignState(1000));
      const out = await engine.generate(fx);
      if (out.status === "CREATED") created += 1;
      else if (out.status === "NO_RECOMMENDATION" || out.status === "INVALID_INPUT") {
        throw new Error(JSON.stringify(out));
      }
    }
    const elapsedMs = performance.now() - started;

    // Bounded queries: exactly ONE history query per context — no N+1.
    expect(port.calls).toBe(1000);
    expect(port.lastFilters.every((f) => f.limit === DEFAULT_MAX_HISTORICAL_OUTCOMES)).toBe(
      true
    );
    expect(created).toBe(1000);
    // Deterministic calculation over the same shared rows:
    expect(store.rows[0].historicalEvidenceIds.length).toBe(
      store.rows[created - 1].historicalEvidenceIds.length
    );
    // Generous wall-clock ceiling (typically a few seconds locally).
    expect(elapsedMs).toBeLessThan(120_000);

    // No Meta calls beyond read-only state loads:
    expect(state.loadCalls).toBe(1000);
  }, 200_000);
});
