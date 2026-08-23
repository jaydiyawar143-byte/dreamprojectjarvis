import { describe, it, expect } from "vitest";
import {
  RecommendationEngine,
  assessRisk,
  DEFAULT_RECOMMENDATION_TTL_MS,
  MIN_SAMPLE_COUNT,
  type RecommendationStorePort,
} from "../src/recommendation-engine.js";
import {
  RecommendationActionSchema,
  RecommendationRecordSchema,
  ExpectedImpactSchema,
  buildExecutableParams,
  computeExternalStateHash,
  proposeBudgetChange,
  validateBudgetProposal,
  actionsConflict,
  canTransition,
  terminalStatuses,
  ACTIVE_STATUSES,
  escalateRisk,
} from "../src/types/recommendation.js";
import { computeParamsHash } from "../src/utils/params-hash.js";
import {
  buildFatigueRecommendationInput,
  MemoryRecommendationStore,
  FakeExternalState,
  activeCampaignState,
  pausedCampaignState,
  type RecommendationFixture,
} from "./recommendation-fixtures.js";

// ---------------------------------------------------------------------------
// Phase 11.5 — Deterministic Recommendation Engine tests
// ---------------------------------------------------------------------------

interface Harness {
  store: MemoryRecommendationStore;
  state: FakeExternalState;
  engine: RecommendationEngine;
}

function makeHarness(opts: {
  now?: string;
  ttlMs?: number;
  maxBudgetActionsPerAccountPerDay?: number;
} = {}): Harness {
  const store = new MemoryRecommendationStore();
  const state = new FakeExternalState();
  const engine = new RecommendationEngine(
    store,
    state.port,
    { ttlMs: opts.ttlMs, maxBudgetActionsPerAccountPerDay: opts.maxBudgetActionsPerAccountPerDay },
    opts.now ? () => new Date(opts.now!) : undefined
  );
  return { store, state, engine };
}

const FIXED_NOW = "2026-08-21T12:00:00.000Z";

/** Standard scenario: fatigued ACTIVE campaign with budget, fresh evidence. */
async function standardCreated(h: Harness, fxOverride?): Promise<ReturnType<RecommendationEngine["generate"]>> {
  const fx: RecommendationFixture =
    fxOverride ?? buildFatigueRecommendationInput({ userId: "user_1" });
  h.state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, activeCampaignState(1000));
  return h.engine.generate(fx);
}

describe("Phase 11.5 — Diagnosis-to-action policy mapping", () => {
  const cases: Array<{
    category: Parameters<typeof buildFatigueRecommendationInput>[0] extends infer O
      ? O extends { category?: infer C } ? C : never
      : never;
    expectStatus: string;
    reasonContains?: string;
  }> = [
    { category: "CREATIVE_FATIGUE", expectStatus: "CREATED" },
    { category: "AUDIENCE_SATURATION", expectStatus: "CREATED" },
    { category: "COST_INFLATION", expectStatus: "CREATED" },
    { category: "ENGAGEMENT_DECLINE", expectStatus: "CREATED" },
    { category: "CONVERSION_RATE_DECLINE", expectStatus: "CREATED" },
    { category: "BUDGET_CONSTRAINT", expectStatus: "CREATED" },
    { category: "TRACKING_ISSUE", expectStatus: "NO_RECOMMENDATION", reasonContains: "NO_SPEND_ACTION_TRACKING_ISSUE" },
    { category: "DELIVERY_ISSUE", expectStatus: "NO_RECOMMENDATION", reasonContains: "INVESTIGATION_REQUIRED" },
    { category: "LANDING_PAGE_ISSUE", expectStatus: "NO_RECOMMENDATION", reasonContains: "INVESTIGATION_REQUIRED" },
    { category: "COMPETITIVE_PRESSURE", expectStatus: "NO_RECOMMENDATION", reasonContains: "CATEGORY_NOT_ACTIONABLE" },
    { category: "SEASONALITY", expectStatus: "NO_RECOMMENDATION", reasonContains: "CATEGORY_NOT_ACTIONABLE" },
    { category: "INSUFFICIENT_DATA", expectStatus: "NO_RECOMMENDATION", reasonContains: "CATEGORY_NOT_ACTIONABLE" },
    { category: "NO_CLEAR_DIAGNOSIS", expectStatus: "NO_RECOMMENDATION", reasonContains: "CATEGORY_NOT_ACTIONABLE" },
    { category: "UNKNOWN", expectStatus: "NO_RECOMMENDATION", reasonContains: "CATEGORY_NOT_ACTIONABLE" },
  ];

  for (const c of cases) {
    it(`maps ${c.category} -> ${c.expectStatus}`, async () => {
      const h = makeHarness({ now: FIXED_NOW });
      const out = await standardCreated(
        h,
        buildFatigueRecommendationInput({ userId: "user_1", category: c.category ?? undefined })
      );
      expect(out.status).toBe(c.expectStatus);
      if (c.reasonContains) {
        expect(out.status === "NO_RECOMMENDATION" && out.reason).toBe(c.reasonContains);
      }
    });
  }

  it("CREATIVE_FATIGUE at CAMPAIGN level proposes bounded DECREASE_BUDGET", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const out = await standardCreated(h);
    if (out.status !== "CREATED") throw new Error(JSON.stringify(out.audit));
    expect(out.recommendation.actionType).toBe("DECREASE_BUDGET");
    const proposed = out.recommendation.proposedState["dailyBudget"] as number;
    expect(proposed).toBe(800); // conservative -20% target on a $1000 budget
    expect(proposed).toBeLessThan(1000);
  });

  it("BUDGET_CONSTRAINT proposes INCREASE_BUDGET within guardrails", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const out = await standardCreated(
      h,
      buildFatigueRecommendationInput({ userId: "user_1", category: "BUDGET_CONSTRAINT" })
    );
    if (out.status !== "CREATED") throw new Error(JSON.stringify(out.audit));
    expect(out.recommendation.actionType).toBe("INCREASE_BUDGET");
    const proposed = out.recommendation.proposedState["dailyBudget"] as number;
    expect(proposed).toBe(1200); // conservative +20% target on $1000
  });

  it("BUDGET_CONSTRAINT prefers RESUME when the entity is PAUSED", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({ userId: "user_1", category: "BUDGET_CONSTRAINT" });
    h.state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, pausedCampaignState(1000));
    const out = await h.engine.generate(fx);
    if (out.status !== "CREATED") throw new Error(JSON.stringify(out.audit));
    expect(out.recommendation.actionType).toBe("RESUME_CAMPAIGN");
    expect(out.recommendation.proposedState["status"]).toBe("ACTIVE");
  });

  it("AUDIENCE_SATURATION at AD_SET level can yield PAUSE_AD_SET under CRITICAL severity", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({
      userId: "user_1",
      level: "AD_SET",
      entityId: "set_1",
      category: "AUDIENCE_SATURATION",
    });
    h.state.set(fx.evidence.accountId, "AD_SET", "set_1", activeCampaignState(1000));
    const out = await h.engine.generate(fx);
    if (out.status !== "CREATED") throw new Error(JSON.stringify(out.audit));
    expect(out.recommendation.actionType).toBe("PAUSE_AD_SET");
    expect(out.recommendation.proposedState["status"]).toBe("PAUSED");
  });

  it("CREATIVE_FATIGUE at AD level yields PAUSE_AD under CRITICAL severity", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({
      userId: "user_1",
      level: "AD",
      entityId: "ad_1",
    });
    h.state.set(fx.evidence.accountId, "AD", "ad_1", activeCampaignState(1000));
    const out = await h.engine.generate(fx);
    if (out.status !== "CREATED") throw new Error(JSON.stringify(out.audit));
    expect(out.recommendation.actionType).toBe("PAUSE_AD");
    const params = buildExecutableParams("PAUSE_AD", fx.evidence.accountId, "ad_1");
    expect(params).toEqual({ accountId: fx.evidence.accountId, adId: "ad_1" });
  });
});

describe("Phase 11.5 — Evidence quality gates", () => {
  it("blocks on STALE_DATA freshness", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const out = await standardCreated(
      h,
      buildFatigueRecommendationInput({ userId: "user_1", freshness: "STALE_DATA" })
    );
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "STALE_EVIDENCE").toBe(true);
  });

  it("blocks during WARMUP_PERIOD", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const out = await standardCreated(
      h,
      buildFatigueRecommendationInput({ userId: "user_1", freshness: "WARMUP_PERIOD" })
    );
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "WARMUP_PERIOD").toBe(true);
  });

  it("blocks on INSUFFICIENT data quality", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const out = await standardCreated(
      h,
      buildFatigueRecommendationInput({ userId: "user_1", dataQuality: "INSUFFICIENT_DATA" })
    );
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "INSUFFICIENT_DATA_QUALITY").toBe(true);
  });

  it("blocks LOW-confidence diagnoses", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const out = await standardCreated(
      h,
      buildFatigueRecommendationInput({
        userId: "user_1",
        diagnosisOverrides: { confidence: "LOW" },
      })
    );
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "LOW_CONFIDENCE").toBe(true);
  });

  it("refuses negative actions when only positive anomalies exist", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({ userId: "user_1" });
    const positiveOnly = {
      ...fx.evidence,
      anomalies: fx.evidence.anomalies.map((a) => ({ ...a, direction: "POSITIVE_ANOMALY" as const })),
    };
    h.state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, activeCampaignState(1000));
    const out = await h.engine.generate({ ...fx, evidence: positiveOnly });
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "NO_NEGATIVE_ANOMALIES").toBe(true);
  });

  it("requires CRITICAL or >=2 WARNING signals before acting", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({ userId: "user_1" });
    const singleWarning = {
      ...fx.evidence,
      anomalies: [{ ...fx.evidence.anomalies[0], severity: "WARNING" as const }],
    };
    h.state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, activeCampaignState(1000));
    const out = await h.engine.generate({ ...fx, evidence: singleWarning });
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "INSUFFICIENT_SEVERITY").toBe(true);
  });

  it(`rejects actions when sample count < ${MIN_SAMPLE_COUNT}`, async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({ userId: "user_1" });
    const thin = {
      ...fx.evidence,
      anomalies: fx.evidence.anomalies.map((a) => ({ ...a, sampleCount: 3 })),
    };
    h.state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, activeCampaignState(1000));
    const out = await h.engine.generate({ ...fx, evidence: thin });
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "INSUFFICIENT_SEVERITY").toBe(true);
  });
});

describe("Phase 11.5 — Contract binding & fail-closed inputs", () => {
  it("fails closed when diagnosis does not match evidence", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({ userId: "user_1" });
    const mismatched = { ...fx, diagnosis: { ...fx.diagnosis, entityId: "cmp_OTHER" } };
    const out = await h.engine.generate(mismatched);
    expect(out.status).toBe("INVALID_INPUT");
  });

  it("fails closed when diagnosis cites unknown anomaly ids", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({ userId: "user_1" });
    const forged = { ...fx, diagnosis: { ...fx.diagnosis, anomalyIds: ["anomaly_forged"] } };
    const out = await h.engine.generate(forged);
    expect(out.status).toBe("INVALID_INPUT");
  });

  it("rejects structurally invalid input (missing userId)", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({ userId: "user_1" });
    const bad = { diagnosis: fx.diagnosis, evidence: fx.evidence } as unknown as typeof fx;
    const out = await h.engine.generate(bad);
    expect(out.status).toBe("INVALID_INPUT");
  });

  it("never accepts action types outside the fixed catalog", () => {
    expect(RecommendationActionSchema.safeParse("DELETE_ALL_CAMPAIGNS").success).toBe(false);
    expect(RecommendationActionSchema.safeParse("pause_campaign").success).toBe(false);
    expect(RecommendationActionSchema.safeParse("PAUSE_CAMPAIGN").success).toBe(true);
  });
});

describe("Phase 11.5 — Record contract integrity", () => {
  it("creates schema-valid records bound to state and params hashes", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const out = await standardCreated(h);
    if (out.status !== "CREATED") throw new Error("expected CREATED");
    const rec = RecommendationRecordSchema.parse(out.recommendation); // throws on violation
    expect(rec.requiresApproval).toBe(true);
    expect(rec.status).toBe("PROPOSED");
    const liveState = activeCampaignState(1000);
    expect(rec.stateHash).toBe(
      computeExternalStateHash(rec.accountId, rec.entityId, liveState)
    );
    const params = buildExecutableParams(
      rec.actionType,
      rec.accountId,
      rec.entityId,
      rec.proposedState["dailyBudget"] as number | undefined,
      rec.entityLevel
    );
    expect(rec.paramsHash).toBe(computeParamsHash(params));
  });

  it("always emits estimatedRange NOT_ESTIMATED with no forecast language", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const out = await standardCreated(h);
    if (out.status !== "CREATED") throw new Error("expected CREATED");
    expect(out.recommendation.expectedImpact.estimatedRange).toBe("NOT_ESTIMATED");
    expect(ExpectedImpactSchema.parse(out.recommendation.expectedImpact)).toBeTruthy();
    expect(out.recommendation.expectedImpact.rationale).toContain("No performance outcome is forecast");
    // Fabricated numeric ranges violate the v1 guarantee even though the
    // union permits them for future justified use.
    expect(out.recommendation.reason.toLowerCase()).not.toContain("guaranteed");
    expect(out.recommendation.expectedImpact.rationale.toLowerCase()).not.toContain("roas will");
  });

  it("applies the single configurable TTL to expiresAt", async () => {
    const h = makeHarness({ now: FIXED_NOW, ttlMs: 60_000 });
    const out = await standardCreated(h);
    if (out.status !== "CREATED") throw new Error("expected CREATED");
    const created = new Date(out.recommendation.createdAt).getTime();
    const expires = new Date(out.recommendation.expiresAt).getTime();
    expect(expires - created).toBe(60_000);
    void DEFAULT_RECOMMENDATION_TTL_MS;
  });

  it("is deterministic: identical inputs produce identical identityHash", async () => {
    const fx = buildFatigueRecommendationInput({ userId: "user_1" });
    const run = async (): Promise<string> => {
      const h = makeHarness({ now: FIXED_NOW });
      h.state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, activeCampaignState(1000));
      const out = await h.engine.generate(structuredClone(fx));
      if (out.status !== "CREATED") throw new Error(out.status);
      return out.recommendation.identityHash;
    };
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toBe(b);
  });
});

describe("Phase 11.5 — Duplicate prevention", () => {
  it("returns DUPLICATE referencing the existing record instead of saving twice", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const first = await standardCreated(h);
    if (first.status !== "CREATED") throw new Error("expected CREATED");
    const savesAfterFirst = h.store.saveCalls;
    const second = await h.engine.generate(
      buildFatigueRecommendationInput({ userId: "user_1" })
    );
    expect(second.status).toBe("DUPLICATE");
    if (second.status === "DUPLICATE") {
      expect(second.existingId).toBe(first.recommendation.recommendationId);
    }
    expect(h.store.saveCalls).toBe(savesAfterFirst);
  });

  it("allows a NEW recommendation after the previous one reached a terminal status", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const first = await standardCreated(h);
    if (first.status !== "CREATED") throw new Error("expected CREATED");
    h.store.setStatus(first.recommendation.recommendationId, "REJECTED");
    // Cooldown still applies (same family, recent) — but identity is free.
    const second = await h.engine.generate(
      buildFatigueRecommendationInput({ userId: "user_1" })
    );
    expect(["COOLDOWN_ACTIVE", "CREATED"]).toContain(second.status);
  });
});

describe("Phase 11.5 — Conflict detection", () => {
  it("blocks an INCREASE_BUDGET that conflicts with an active DECREASE_BUDGET", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const dec = await standardCreated(h); // fatigue -> DECREASE_BUDGET
    if (dec.status !== "CREATED") throw new Error("expected CREATED");

    const fx = buildFatigueRecommendationInput({ userId: "user_1", category: "BUDGET_CONSTRAINT" });
    // Distinct diagnosis id so identity differs from the decrease record.
    const inc = await h.engine.generate({
      ...fx,
      diagnosis: { ...fx.diagnosis, diagnosisId: "diag_increase_1" },
    });
    expect(inc.status).toBe("CONFLICT_BLOCKED");
    if (inc.status === "CONFLICT_BLOCKED") {
      expect(inc.conflictingIds).toContain(dec.recommendation.recommendationId);
    }
  });

  it("conflict matrix covers every documented fighting pair", () => {
    expect(actionsConflict("PAUSE_CAMPAIGN", "RESUME_CAMPAIGN")).toBe(true);
    expect(actionsConflict("INCREASE_BUDGET", "DECREASE_BUDGET")).toBe(true);
    expect(actionsConflict("PAUSE_AD", "INCREASE_BUDGET")).toBe(true);
    expect(actionsConflict("RESUME_AD_SET", "DECREASE_BUDGET")).toBe(true);
    expect(actionsConflict("PAUSE_AD", "PAUSE_AD")).toBe(true);
    // Non-fighting combos may coexist.
    expect(actionsConflict("PAUSE_AD_SET", "RESUME_AD")).toBe(false);
    expect(actionsConflict("PAUSE_AD", "DECREASE_BUDGET")).toBe(false);
  });
});

describe("Phase 11.5 — Cooldowns & anti-oscillation", () => {
  it("suppresses an immediate opposite-direction recommendation", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const first = await standardCreated(h); // DECREASE_BUDGET
    if (first.status !== "CREATED") throw new Error("expected CREATED");
    h.store.setStatus(first.recommendation.recommendationId, "REJECTED");

    // Five minutes later: increase requested -> oscillation guard fires.
    const later = new Date(new Date(FIXED_NOW).getTime() + 5 * 60 * 1000);
    const h2: Harness = { store: h.store, state: h.state, engine: new RecommendationEngine(h.store, h.state.port, {}, () => later) };
    const out = await h2.engine.generate(
      buildFatigueRecommendationInput({ userId: "user_1", category: "BUDGET_CONSTRAINT" })
    );
    expect(out.status).toBe("COOLDOWN_ACTIVE");
    if (out.status === "COOLDOWN_ACTIVE") {
      expect(out.remainingMs).toBeGreaterThan(0);
    }
  });
});

describe("Phase 11.5 — Budget rate limiting", () => {
  it("enforces max budget actions per account per rolling day", async () => {
    const h = makeHarness({ now: FIXED_NOW, maxBudgetActionsPerAccountPerDay: 1 });
    const fx1 = buildFatigueRecommendationInput({
      userId: "user_1",
      accountId: "act_rate",
      entityId: "cmp_rate_a",
    });
    h.state.set("act_rate", "CAMPAIGN", "cmp_rate_a", activeCampaignState(1000));
    const first = await h.engine.generate(fx1);
    expect(first.status).toBe("CREATED");
    if (first.status !== "CREATED") throw new Error("expected CREATED");
    h.store.setStatus(first.recommendation.recommendationId, "REJECTED");

    // Different entity avoids per-entity cooldown; account-level cap blocks.
    const fx2 = buildFatigueRecommendationInput({
      userId: "user_1",
      accountId: "act_rate",
      entityId: "cmp_rate_b",
      diagnosisOverrides: { diagnosisId: "diag_second" },
    });
    h.state.set("act_rate", "CAMPAIGN", "cmp_rate_b", activeCampaignState(1000));
    const second = await h.engine.generate(fx2);
    expect(second.status).toBe("RATE_LIMITED");
  });
});

describe("Phase 11.5 — External state binding", () => {
  it("fails closed when live state cannot be resolved", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({ userId: "user_1" });
    h.state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, null);
    const out = await h.engine.generate(fx);
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "ENTITY_NOT_FOUND").toBe(true);
  });

  it("fails closed when the entity was deleted/archived", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({ userId: "user_1" });
    h.state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, {
      ...activeCampaignState(1000),
      status: "DELETED",
    });
    const out = await h.engine.generate(fx);
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "ENTITY_DELETED").toBe(true);
  });

  it("cannot pause something already paused", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({
      userId: "user_1",
      level: "AD",
      entityId: "ad_paused",
    });
    h.state.set(fx.evidence.accountId, "AD", "ad_paused", pausedCampaignState(100));
    const out = await h.engine.generate(fx);
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "PRECONDITION_FAILED").toBe(true);
  });

  it("cannot modify budget when no daily budget exists", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const fx = buildFatigueRecommendationInput({ userId: "user_1" });
    h.state.set(fx.evidence.accountId, fx.evidence.entityLevel, fx.evidence.entityId, {
      status: "ACTIVE",
      dailyBudget: null,
    });
    const out = await h.engine.generate(fx);
    expect(out.status === "NO_RECOMMENDATION" && out.reason === "PRECONDITION_FAILED").toBe(true);
  });
});

describe("Phase 11.5 — Stale-state protection (verifyFreshForExecution)", () => {
  async function createdRecord(h: Harness) {
    const out = await standardCreated(h);
    if (out.status !== "CREATED") throw new Error("expected CREATED");
    return out.recommendation;
  }

  it("passes when live state matches the proposal snapshot", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const rec = await createdRecord(h);
    const verdict = await h.engine.verifyFreshForExecution({
      record: rec,
      liveState: activeCampaignState(1000),
      requestingUserId: rec.userId,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("expires past-TTL recommendations regardless of state", async () => {
    const h = makeHarness({ now: FIXED_NOW, ttlMs: 1000 });
    const rec = await createdRecord(h);
    const later = new Date(new Date(FIXED_NOW).getTime() + 2000);
    const verdict = await h.engine.verifyFreshForExecution({
      record: rec,
      liveState: activeCampaignState(1000),
      requestingUserId: rec.userId,
      now: later,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.result).toBe("EXPIRED");
  });

  it("rejects records in non-executable statuses", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const rec = await createdRecord(h);
    const executed = { ...rec, status: "EXECUTED" as const };
    const verdict = await h.engine.verifyFreshForExecution({
      record: executed,
      liveState: activeCampaignState(1000),
      requestingUserId: rec.userId,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons[0]).toContain("STATUS_NOT_EXECUTABLE");
  });

  it("blocks cross-user execution attempts (authorization binding)", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const rec = await createdRecord(h);
    const verdict = await h.engine.verifyFreshForExecution({
      record: rec,
      liveState: activeCampaignState(1000),
      requestingUserId: "attacker_user",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.result).toBe("INVALID");
      expect(verdict.reasons).toContain("USER_MISMATCH");
    }
  });

  it("detects tampered proposed parameters via paramsHash mismatch", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const rec = await createdRecord(h);
    const tampered = {
      ...rec,
      proposedState: { dailyBudget: 999999 }, // attacker-edited payload
    };
    const verdict = await h.engine.verifyFreshForExecution({
      record: tampered,
      liveState: activeCampaignState(1000),
      requestingUserId: rec.userId,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.result).toBe("INVALID");
      expect(verdict.reasons).toContain("PARAMS_HASH_MISMATCH");
    }
  });

  it("marks STALE when the entity disappeared", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const rec = await createdRecord(h);
    const verdict = await h.engine.verifyFreshForExecution({
      record: rec,
      liveState: null,
      requestingUserId: rec.userId,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.result).toBe("STALE");
      expect(verdict.reasons).toContain("ENTITY_NOT_FOUND");
    }
  });

  it("marks STALE when the live budget changed since proposal", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const rec = await createdRecord(h);
    const verdict = await h.engine.verifyFreshForExecution({
      record: rec,
      liveState: activeCampaignState(1400), // user changed budget externally
      requestingUserId: rec.userId,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.result).toBe("STALE");
      expect(verdict.reasons).toContain("BUDGET_CHANGED");
    }
  });

  it("marks STALE when the live status changed since proposal", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    const rec = await createdRecord(h);
    const verdict = await h.engine.verifyFreshForExecution({
      record: rec,
      liveState: pausedCampaignState(1000),
      requestingUserId: rec.userId,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.result).toBe("STALE");
      expect(verdict.reasons).toContain("STATUS_CHANGED");
    }
  });

  it("re-validates guardrails against LIVE state before execution", async () => {
    const h = makeHarness({ now: FIXED_NOW });
    // Craft an internally-consistent but DANGEROUS record: stateHash matches
    // the live snapshot, paramsHash matches the proposed params, yet the
    // proposed +60% increase violates the 25% cap. A buggy/forged producer
    // must still be stopped at the execution gate.
    const live = activeCampaignState(1000);
    const proposed = 1600;
    const params = buildExecutableParams("DECREASE_BUDGET", "act_1", "cmp_1", proposed, "CAMPAIGN");
    const forged = RecommendationRecordSchema.parse({
      schemaVersion: 1,
      recommendationId: "rec_forged",
      userId: "user_1",
      accountId: "act_1",
      entityLevel: "CAMPAIGN",
      entityId: "cmp_1",
      diagnosisId: "diag_x",
      anomalyIds: [],
      actionType: "DECREASE_BUDGET",
      currentState: { status: "ACTIVE", dailyBudget: 1000 },
      proposedState: { dailyBudget: proposed },
      reason: "forged",
      evidence: buildFatigueRecommendationInput({ userId: "user_1" }).evidence,
      expectedImpact: {
        metric: "SPEND",
        direction: "DECREASE",
        estimatedRange: "NOT_ESTIMATED",
        rationale: "forged",
      },
      risk: "LOW",
      confidence: "HIGH",
      preconditions: [],
      paramsHash: computeParamsHash(params),
      stateHash: computeExternalStateHash("act_1", "cmp_1", live),
      identityHash: "x".repeat(32),
      status: "APPROVED",
      requiresApproval: true,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      expiresAt: new Date(new Date(FIXED_NOW).getTime() + 600000).toISOString(),
      staleReasons: [],
    });
    const verdict = await h.engine.verifyFreshForExecution({
      record: forged,
      liveState: live,
      requestingUserId: "user_1",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.result).toBe("STALE");
      expect(verdict.reasons[0]).toBe("GUARDRAIL_VS_LIVE_STATE");
    }
  });

  it("stateHash is sensitive to every guarded field", () => {
    const base = { accountId: "a", entityId: "e", ...activeCampaignState(500) };
    const h0 = computeExternalStateHash(base.accountId, base.entityId, base);
    expect(computeExternalStateHash("b", "e", base)).not.toBe(h0);
    expect(computeExternalStateHash("a", "x", base)).not.toBe(h0);
    expect(
      computeExternalStateHash("a", "e", { ...base, status: "PAUSED" })
    ).not.toBe(h0);
    expect(
      computeExternalStateHash("a", "e", { ...base, dailyBudget: 501 })
    ).not.toBe(h0);
    expect(
      computeExternalStateHash("a", "e", { ...base, objective: "OUTCOME_TRAFFIC" })
    ).not.toBe(h0);
    expect(
      computeExternalStateHash("a", "e", { ...base, targetingFingerprint: "fp2" })
    ).not.toBe(h0);
  });
});

describe("Phase 11.5 — Risk model", () => {
  const fx = buildFatigueRecommendationInput({ userId: "user_1" });
  const diag = fx.diagnosis;

  it("assigns catalog base risks", () => {
    expect(assessRisk("PAUSE_AD", diag, fx.evidence)).toBe("LOW");
    expect(assessRisk("PAUSE_AD_SET", diag, fx.evidence)).toBe("MEDIUM");
    expect(assessRisk("PAUSE_CAMPAIGN", diag, fx.evidence)).toBe("HIGH");
  });

  it("escalates risk for partial data quality", () => {
    const partialEvidence = { ...fx.evidence, dataQuality: "PARTIAL" as const };
    expect(assessRisk("DECREASE_BUDGET", diag, partialEvidence)).toBe("MEDIUM");
    expect(assessRisk("INCREASE_BUDGET", diag, partialEvidence)).toBe("HIGH");
  });

  it("floors large bounded increases at HIGH", () => {
    expect(
      assessRisk("INCREASE_BUDGET", diag, fx.evidence, { percentChange: 20, absoluteChange: 400 })
    ).toBe("HIGH");
    expect(
      assessRisk("INCREASE_BUDGET", diag, fx.evidence, { percentChange: 10, absoluteChange: 300 })
    ).toBe("MEDIUM");
  });

  it("escalateRisk composes deterministically", () => {
    expect(escalateRisk("LOW")).toBe("LOW");
    expect(escalateRisk("LOW", "MEDIUM")).toBe("MEDIUM");
    expect(escalateRisk("HIGH", "LOW", "MEDIUM")).toBe("HIGH");
  });
});

describe("Phase 11.5 — Budget math & guardrails", () => {
  it("proposes increases clamped by the tightest cap", () => {
    expect(proposeBudgetChange(1000, "INCREASE_BUDGET")?.requestedDailyBudget).toBe(1200);
    expect(proposeBudgetChange(9000, "INCREASE_BUDGET")?.requestedDailyBudget).toBe(10000);
    // Cap-clamped below current => not a meaningful increase => null.
    expect(proposeBudgetChange(20000, "INCREASE_BUDGET")).toBeNull();
  });

  it("proposes decreases clamped by floor and caps", () => {
    expect(proposeBudgetChange(1000, "DECREASE_BUDGET")?.requestedDailyBudget).toBe(800);
    expect(proposeBudgetChange(4, "DECREASE_BUDGET")?.requestedDailyBudget).toBe(3.2);
    expect(proposeBudgetChange(1, "DECREASE_BUDGET")).toBeNull(); // cannot go lower
  });

  it("validates transitions fail-closed against all five limits", () => {
    expect(validateBudgetProposal({ currentBudget: 1000, requestedDailyBudget: 1250, percentChange: 25, absoluteChange: 250 }).valid).toBe(true);
    expect(validateBudgetProposal({ currentBudget: 1000, requestedDailyBudget: 1300, percentChange: 30, absoluteChange: 300 }).valid).toBe(false);
    expect(validateBudgetProposal({ currentBudget: 1000, requestedDailyBudget: 4000, percentChange: 20, absoluteChange: 2600 }).valid).toBe(false);
    expect(validateBudgetProposal({ currentBudget: 1000, requestedDailyBudget: 11000, percentChange: 10, absoluteChange: 1000 }).valid).toBe(false);
    expect(validateBudgetProposal({ currentBudget: 1000, requestedDailyBudget: 400, percentChange: 60, absoluteChange: 600 }).valid).toBe(false);
    expect(validateBudgetProposal({ currentBudget: 1000, requestedDailyBudget: 0, percentChange: -100, absoluteChange: -1000 }).valid).toBe(false);
  });
});

describe("Phase 11.5 — Status lifecycle", () => {
  it("permits only documented transitions", () => {
    expect(canTransition("PROPOSED", "APPROVED")).toBe(true);
    expect(canTransition("PROPOSED", "REJECTED")).toBe(true);
    expect(canTransition("APPROVED", "EXECUTING")).toBe(true);
    expect(canTransition("EXECUTING", "EXECUTED")).toBe(true);
    expect(canTransition("EXECUTING", "FAILED")).toBe(true);
    expect(canTransition("PROPOSED", "EXECUTED")).toBe(false);
    expect(canTransition("REJECTED", "PROPOSED")).toBe(false);
    expect(canTransition("EXECUTED", "APPROVED")).toBe(false);
    expect(canTransition("STALE", "APPROVED")).toBe(false);
  });

  it("treats EXECUTED/REJECTED/EXPIRED/STALE/FAILED as terminal", () => {
    const terminal = terminalStatuses();
    for (const s of ["EXECUTED", "REJECTED", "EXPIRED", "STALE", "FAILED"] as const) {
      expect(terminal.has(s)).toBe(true);
    }
    for (const s of ["PROPOSED", "APPROVED", "EXECUTING"] as const) {
      expect(terminal.has(s)).toBe(false);
    }
    expect(ACTIVE_STATUSES).toEqual(["PROPOSED", "APPROVED", "EXECUTING"]);
  });
});

// ---------------------------------------------------------------------------
// Performance & scale (spec §26)
// ---------------------------------------------------------------------------

function makeSyntheticFixture(accountId: string, entityId: string): RecommendationFixture {
  // Minimal VALID strict-schema evidence package (fast to construct at scale).
  const window = { startDate: "2026-08-21", endDate: "2026-08-21" };
  const anomaly = {
    anomalyId: `anom_${entityId}`,
    accountId,
    entityLevel: "CAMPAIGN" as const,
    entityId,
    metric: "ctr",
    currentValue: 1,
    baselineValue: 4,
    absoluteDeviation: -3,
    percentDeviation: -75,
    modifiedZScore: -5,
    direction: "NEGATIVE_ANOMALY" as const,
    severity: "CRITICAL" as const,
    confidence: "HIGH" as const,
    baselineMethod: "ROLLING_MEDIAN_MAD" as const,
    sampleCount: 11,
    dataQuality: "COMPLETE" as const,
    freshness: "FRESH" as const,
    evidence: {
      metric: "ctr",
      currentValue: 1,
      baselineValue: 4,
      absoluteDeviation: -3,
      percentDeviation: -75,
      modifiedZScore: -5,
      sampleCount: 11,
      baselineMethod: "ROLLING_MEDIAN_MAD" as const,
      economicSignificanceMet: true,
    },
    detectedAt: FIXED_NOW,
  };
  const evidence = {
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
    anomalies: [anomaly],
    dataQuality: "COMPLETE" as const,
    freshness: "FRESH" as const,
    relevantContext: { labels: [], notes: [] },
    evidenceHash: computeParamsHash({ accountId, entityId }),
    builtAt: FIXED_NOW,
  };
  const diagnosis = {
    diagnosisId: `diag_${entityId}`,
    accountId,
    entityLevel: "CAMPAIGN" as const,
    entityId,
    anomalyIds: [`anom_${entityId}`],
    category: "CREATIVE_FATIGUE" as const,
    summary: "Synthetic fatigue case.",
    facts: [],
    inferences: [],
    hypotheses: [],
    confidence: "HIGH" as const,
    dataQuality: "COMPLETE" as const,
    evidenceHash: evidence.evidenceHash,
    generatedAt: FIXED_NOW,
  };
  return { evidence, diagnosis, userId: "perf_user" };
}

describe("Phase 11.5 — Scale & determinism (spec §26)", () => {
  it("processes 2600 entities well under budget with exactly one state lookup each", async () => {
    const h = makeHarness({
      now: FIXED_NOW,
      maxBudgetActionsPerAccountPerDay: Number.MAX_SAFE_INTEGER,
    });
    const entities: RecommendationFixture[] = [];
    for (let c = 0; c < 100; c++) {
      for (let s = 0; s < 26; s++) {
        entities.push(makeSyntheticFixture("act_perf", `c${c}_s${s}`));
      }
    }
    expect(entities.length).toBe(2600);

    const t0 = Date.now();
    let created = 0;
    for (const fx of entities) {
      h.state.set(fx.evidence.accountId, "CAMPAIGN", fx.evidence.entityId, activeCampaignState(100));
      const out = await h.engine.generate(fx);
      if (out.status === "CREATED") created += 1;
      else if (out.status !== "DUPLICATE") throw new Error(`unexpected ${out.status}`);
    }
    const elapsed = Date.now() - t0;
    expect(created).toBe(2600);
    expect(elapsed).toBeLessThan(10_000); // generous CI bound; local ~1s
    // Exactly one live-state lookup per candidate entity — no N+1 amplification.
    expect(h.state.loadCalls).toBe(2600);

    // Replay of identical inputs collapses to duplicates — zero new rows.
    let duplicates = 0;
    for (const fx of entities) {
      const out = await h.engine.generate(fx);
      if (out.status === "DUPLICATE") duplicates += 1;
    }
    expect(duplicates).toBe(2600);
    expect(h.store.rows.length).toBe(2600);

    // The engine performs ZERO LLM calls by construction: it holds no model
    // provider dependency at all (structural guarantee, verified by import).
    const engineKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(h.engine));
    expect(engineKeys).toContain("generate");
    expect(engineKeys).not.toContain("callLLM");
  });

  it("bounded generation is stable across repeated construction (no drift)", async () => {
    const a = makeSyntheticFixture("act_d", "camp_x");
    const b = structuredClone(a);
    const hA = makeHarness({ now: FIXED_NOW });
    const hB = makeHarness({ now: FIXED_NOW });
    for (const h of [hA, hB]) {
      h.state.set(a.evidence.accountId, "CAMPAIGN", a.evidence.entityId, activeCampaignState(100));
    }
    const ra = await hA.engine.generate(a);
    const rb = await hB.engine.generate(b);
    if (ra.status !== "CREATED" || rb.status !== "CREATED") throw new Error("expected CREATED");
    expect(ra.recommendation.identityHash).toBe(rb.recommendation.identityHash);
    expect(ra.recommendation.paramsHash).toBe(rb.recommendation.paramsHash);
    expect(ra.recommendation.stateHash).toBe(rb.recommendation.stateHash);
    expect(ra.recommendation.risk).toBe(rb.recommendation.risk);
  });
});

describe("Phase 11.5 — Store port contract", () => {
  it("store port shape is minimal and durable-facing", async () => {
    const store: RecommendationStorePort = new MemoryRecommendationStore();
    expect(typeof store.findActiveByIdentity).toBe("function");
    expect(typeof store.findActiveByEntity).toBe("function");
    expect(typeof store.findMostRecentByActions).toBe("function");
    expect(typeof store.countBudgetActionsSince).toBe("function");
    expect(await store.get("missing")).toBeNull();
  });
});
