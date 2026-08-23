import {
  buildFatigueEvidence,
  buildCandidateDiagnosis,
  type FatigueOptions,
} from "./diagnosis-fixtures.js";
import type {
  DiagnosisResult,
  EvidencePackage,
  ModelDiagnosis,
} from "../src/types/diagnosis.js";
import type {
  ExternalEntityState,
  RecentActionRow,
  RecommendationAction,
  RecommendationRecord,
} from "../src/types/recommendation.js";
import { ACTIVE_STATUSES } from "../src/types/recommendation.js";
import type {
  RecommendationStorePort,
} from "../src/recommendation-engine.js";

// ---------------------------------------------------------------------------
// Shared Phase 11.5 test fixtures
// ---------------------------------------------------------------------------

/** Deterministic ModelDiagnosis -> DiagnosisResult conversion. */
export function toDiagnosisResult(
  model: ModelDiagnosis,
  pkg: EvidencePackage,
  overrides: Partial<DiagnosisResult> = {}
): DiagnosisResult {
  return {
    diagnosisId: overrides.diagnosisId ?? `diag_${pkg.evidenceHash.slice(0, 16)}`,
    accountId: pkg.accountId,
    entityLevel: model.entityLevel,
    entityId: model.entityId,
    anomalyIds: [...model.anomalyIds],
    category: model.category,
    summary: model.summary,
    facts: model.facts,
    inferences: model.inferences,
    hypotheses: model.hypotheses,
    confidence: model.confidence,
    dataQuality: pkg.dataQuality,
    evidenceHash: pkg.evidenceHash,
    generatedAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
}

export interface RecommendationFixtureOptions extends FatigueOptions {
  userId?: string;
  /** Override the fatigue category (e.g. TRACKING_ISSUE). */
  category?: DiagnosisResult["category"];
  diagnosisOverrides?: Partial<DiagnosisResult>;
}

export interface RecommendationFixture {
  evidence: EvidencePackage;
  diagnosis: DiagnosisResult;
  userId: string;
}

/** Full generate() input for the default fatigue scenario (CAMPAIGN level). */
export function buildFatigueRecommendationInput(
  opts: RecommendationFixtureOptions = {}
): RecommendationFixture {
  const fx = buildFatigueEvidence(opts);
  const model = buildCandidateDiagnosis(fx, {
    category: (opts.category ?? "CREATIVE_FATIGUE") as ModelDiagnosis["category"],
  });
  const diagnosis = toDiagnosisResult(model, fx.pkg, opts.diagnosisOverrides);
  return { evidence: fx.pkg, diagnosis, userId: opts.userId ?? "user_1" };
}

// ---------------------------------------------------------------------------
// In-memory store/state ports
// ---------------------------------------------------------------------------

export class MemoryRecommendationStore implements RecommendationStorePort {
  readonly rows: RecommendationRecord[] = [];
  saveCalls = 0;

  async findActiveByIdentity(identityHash: string): Promise<RecommendationRecord | null> {
    return (
      this.rows.find(
        (r) => r.identityHash === identityHash && ACTIVE_STATUSES.includes(r.status)
      ) ?? null
    );
  }
  async findActiveByEntity(accountId: string, entityId: string): Promise<RecommendationRecord[]> {
    return this.rows.filter(
      (r) =>
        r.accountId === accountId &&
        r.entityId === entityId &&
        ["PROPOSED", "APPROVED", "EXECUTING"].includes(r.status)
    );
  }
  async findMostRecentByActions(
    accountId: string,
    entityId: string,
    actionTypes: readonly RecommendationAction[]
  ): Promise<RecentActionRow | null> {
    const matches = this.rows
      .filter(
        (r) =>
          r.accountId === accountId &&
          r.entityId === entityId &&
          actionTypes.includes(r.actionType)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const hit = matches[0];
    return hit ? { actionType: hit.actionType, createdAt: hit.createdAt } : null;
  }
  async countBudgetActionsSince(accountId: string, sinceIso: string): Promise<number> {
    return this.rows.filter(
      (r) =>
        r.accountId === accountId &&
        (r.actionType === "INCREASE_BUDGET" || r.actionType === "DECREASE_BUDGET") &&
        r.createdAt >= sinceIso
    ).length;
  }
  async save(record: RecommendationRecord): Promise<void> {
    this.saveCalls += 1;
    this.rows.push(structuredClone(record));
  }
  async get(id: string): Promise<RecommendationRecord | null> {
    return this.rows.find((r) => r.recommendationId === id) ?? null;
  }

  /** Test seam: mutate status directly. */
  setStatus(id: string, status: RecommendationRecord["status"]): void {
    const row = this.rows.find((r) => r.recommendationId === id);
    if (row) row.status = status;
  }
}

export class FakeExternalState {
  private states = new Map<string, ExternalEntityState | null>();
  loadCalls = 0;

  set(
    accountId: string,
    entityLevel: string,
    entityId: string,
    state: ExternalEntityState | null
  ): void {
    this.states.set(`${accountId}|${entityLevel}|${entityId}`, state);
  }

  port = {
    loadState: (
      accountId: string,
      entityLevel: string,
      entityId: string
    ): Promise<ExternalEntityState | null> => {
      this.loadCalls += 1;
      return Promise.resolve(this.states.get(`${accountId}|${entityLevel}|${entityId}`) ?? null);
    },
  };
}

/** Convenience: ACTIVE campaign with daily budget. */
export function activeCampaignState(dailyBudget = 100): ExternalEntityState {
  return {
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    dailyBudget,
    lifetimeBudget: null,
    targetingFingerprint: "fp_default",
  };
}

export function pausedCampaignState(dailyBudget = 100): ExternalEntityState {
  return { ...activeCampaignState(dailyBudget), status: "PAUSED" };
}

/** Fixed clock for deterministic expiry/cooldown math. */
export function clockAt(iso: string): () => Date {
  const t = new Date(iso).getTime();
  return () => new Date(t);
}
