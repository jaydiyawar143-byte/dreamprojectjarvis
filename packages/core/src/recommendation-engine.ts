import {
  DiagnosisResultSchema,
  EvidencePackageSchema,
  type DiagnosisResult,
  type EvidencePackage,
} from "./types/diagnosis.js";
import {
  ACTION_CATALOG,
  DIAGNOSIS_ACTION_POLICY,
  RECOMMENDATION_SCHEMA_VERSION,
  RecommendationRecordSchema,
  actionsConflict,
  buildExecutableParams,
  computeExternalStateHash,
  escalateRisk,
  familyOf,
  isBudgetAction,
  proposeBudgetChange,
  round2,
  validateBudgetProposal,
  type ExternalEntityState,
  type ExpectedImpact,
  type RecommendationAction,
  type RecommendationRecord,
  type RecommendationRisk,
} from "./types/recommendation.js";
import { computeParamsHash } from "./utils/params-hash.js";
import { redactSecrets } from "./utils/redact-secrets.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Phase 11.5 — Deterministic Recommendation Engine
// ---------------------------------------------------------------------------
// Pure decision logic. NO LLM calls, NO provider calls of its own: external
// state arrives through the injected ExternalStatePort and durability through
// the RecommendationStorePort. Every branch is deterministic and auditable.
// Fail-closed everywhere: any contract mismatch ⇒ INVALID_INPUT, never a
// guessed recommendation.
// ---------------------------------------------------------------------------

export const DEFAULT_RECOMMENDATION_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const MIN_SAMPLE_COUNT = 5;

export interface RecommendationEngineConfig {
  /** Single configurable TTL for PROPOSED recommendations. */
  ttlMs?: number;
  /** Max budget-changing recommendations created per account per rolling day. */
  maxBudgetActionsPerAccountPerDay?: number;
}

const DEFAULT_MAX_BUDGET_ACTIONS_PER_DAY = 4;

/** Live external state lookup — the ONLY way the engine observes reality. */
export interface ExternalStatePort {
  loadState(
    accountId: string,
    entityLevel: string,
    entityId: string
  ): Promise<ExternalEntityState | null>;
}

export interface RecentActionRow {
  actionType: RecommendationAction;
  createdAt: string;
}

export interface RecommendationStorePort {
  findActiveByIdentity(identityHash: string): Promise<RecommendationRecord | null>;
  findActiveByEntity(accountId: string, entityId: string): Promise<RecommendationRecord[]>;
  findMostRecentByActions(
    accountId: string,
    entityId: string,
    actionTypes: readonly RecommendationAction[]
  ): Promise<RecentActionRow | null>;
  countBudgetActionsSince(accountId: string, sinceIso: string): Promise<number>;
  save(record: RecommendationRecord): Promise<void>;
  get(id: string): Promise<RecommendationRecord | null>;
}

export interface RecommendationAuditRecord {
  at: string;
  outcome:
    | "CREATED"
    | "DUPLICATE"
    | "NO_RECOMMENDATION"
    | "COOLDOWN_ACTIVE"
    | "CONFLICT_BLOCKED"
    | "RATE_LIMITED"
    | "INVALID_INPUT"
    | "STALE_BLOCKED"
    | "FRESH_OK";
  recommendationId?: string;
  identityHash?: string;
  userId?: string;
  accountId?: string;
  entityLevel?: string;
  entityId?: string;
  diagnosisId?: string;
  actionType?: RecommendationAction;
  risk?: RecommendationRisk;
  confidence?: string;
  reason?: string;
  detail?: string;
  conflictingIds?: string[];
}

export type NoRecommendationReason =
  | "CATEGORY_NOT_ACTIONABLE"
  | "NO_SPEND_ACTION_TRACKING_ISSUE"
  | "INVESTIGATION_REQUIRED"
  | "STALE_EVIDENCE"
  | "WARMUP_PERIOD"
  | "INSUFFICIENT_DATA_QUALITY"
  | "LOW_CONFIDENCE"
  | "NO_NEGATIVE_ANOMALIES"
  | "INSUFFICIENT_SEVERITY"
  | "ENTITY_NOT_FOUND"
  | "ENTITY_DELETED"
  | "GUARDRAIL_EXCEEDED"
  | "INVALID_INPUT"
  | "PRECONDITION_FAILED";

export type RecommendationOutcome =
  | { status: "CREATED"; recommendation: RecommendationRecord; audit: RecommendationAuditRecord }
  | { status: "DUPLICATE"; existingId: string; audit: RecommendationAuditRecord }
  | { status: "NO_RECOMMENDATION"; reason: NoRecommendationReason; detail: string; audit: RecommendationAuditRecord }
  | { status: "COOLDOWN_ACTIVE"; remainingMs: number; audit: RecommendationAuditRecord }
  | { status: "CONFLICT_BLOCKED"; conflictingIds: string[]; audit: RecommendationAuditRecord }
  | { status: "RATE_LIMITED"; detail: string; audit: RecommendationAuditRecord }
  | { status: "INVALID_INPUT"; detail: string; audit: RecommendationAuditRecord };

const GenerateInputSchema = z
  .object({
    userId: z.string().min(1),
    diagnosis: DiagnosisResultSchema,
    evidence: EvidencePackageSchema,
  })
  .strict();

export type GenerateInput = z.infer<typeof GenerateInputSchema>;

// ---------------------------------------------------------------------------
// Module-level deterministic helpers
// ---------------------------------------------------------------------------

function significantNegativeAnomalies(evidence: EvidencePackage) {
  return evidence.anomalies.filter(
    (a) => a.direction === "NEGATIVE_ANOMALY" && a.severity !== "NORMAL"
  );
}

function stepUp(r: RecommendationRisk): RecommendationRisk {
  return r === "LOW" ? "MEDIUM" : "HIGH";
}

/**
 * Deterministic risk model. Base risk comes from the catalog; escalators are
 * objective and ordered: LOW confidence ⇒ +1 step, dataQuality PARTIAL ⇒ +1
 * step, large bounded increase (>15% or >1000 absolute) ⇒ HIGH floor.
 */
export function assessRisk(
  actionType: RecommendationAction,
  diagnosis: DiagnosisResult,
  evidence: EvidencePackage,
  proposal?: { percentChange: number; absoluteChange: number }
): RecommendationRisk {
  let risk = ACTION_CATALOG[actionType].baseRisk;
  if (diagnosis.confidence === "LOW") risk = escalateRisk(risk, stepUp(risk));
  if (evidence.dataQuality === "PARTIAL") risk = escalateRisk(risk, stepUp(risk));
  if (actionType === "INCREASE_BUDGET" && proposal) {
    if (proposal.percentChange > 15 || proposal.absoluteChange > 1000) risk = "HIGH";
  }
  return risk;
}

/** Opposite-direction actions that share this action's cooldown window. */
function cooldownFamilyFor(a: RecommendationAction): RecommendationAction[] {
  const fam = familyOf(a);
  if (fam === "PAUSE") return ALL_ACTIONS.filter((x) => x !== a && familyOf(x) === "RESUME");
  if (fam === "RESUME") return ALL_ACTIONS.filter((x) => x !== a && familyOf(x) === "PAUSE");
  if (fam === "BUDGET_INCREASE") return ["DECREASE_BUDGET"];
  return ["INCREASE_BUDGET"];
}
const ALL_ACTIONS: RecommendationAction[] = [
  "PAUSE_CAMPAIGN",
  "RESUME_CAMPAIGN",
  "PAUSE_AD_SET",
  "RESUME_AD_SET",
  "PAUSE_AD",
  "RESUME_AD",
  "INCREASE_BUDGET",
  "DECREASE_BUDGET",
];

function spendDirectionOf(a: RecommendationAction): ExpectedImpact["direction"] {
  const fam = familyOf(a);
  if (fam === "BUDGET_INCREASE") return "INCREASE";
  if (fam === "BUDGET_DECREASE") return "DECREASE";
  return fam === "PAUSE" ? "DECREASE" : "INCREASE";
}

function impactRationale(a: RecommendationAction, significantCount: number): string {
  const fam = familyOf(a);
  const basis = `${significantCount} significant negative anomal${significantCount === 1 ? "y" : "ies"}`;
  switch (fam) {
    case "PAUSE":
      return `Pausing will stop this entity's spend. Based on ${basis}. No performance outcome is forecast.`;
    case "RESUME":
      return `Resuming will restart this entity's spend at its current budget. Based on ${basis}. No performance outcome is forecast.`;
    case "BUDGET_INCREASE":
      return `Increase raises daily spend ceiling within server-side guardrails. Based on ${basis}. No performance outcome is forecast.`;
    case "BUDGET_DECREASE":
      return `Decrease lowers daily spend ceiling within server-side guardrails. Based on ${basis}. No performance outcome is forecast.`;
  }
}

function buildReason(diagnosis: DiagnosisResult, detail: string, significantCount: number): string {
  return `${diagnosis.category}: ${detail} Based on ${significantCount} significant negative anomal${
    significantCount === 1 ? "y" : "ies"
  } (verified against evidence ${diagnosis.evidenceHash.slice(0, 12)}).`;
}

function buildPreconditions(a: RecommendationAction): string[] {
  const pre: string[] = [
    "External entity state unchanged since proposal (stateHash match)",
    "Human approval granted through the approval system",
  ];
  const fam = familyOf(a);
  if (fam === "PAUSE") pre.push("Entity currently ACTIVE");
  if (fam === "RESUME") pre.push("Entity currently PAUSED");
  if (fam === "BUDGET_INCREASE" || fam === "BUDGET_DECREASE")
    pre.push("Current daily budget present and transition within guardrails");
  return pre;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class RecommendationEngine {
  private readonly ttlMs: number;
  private readonly maxBudgetPerDay: number;

  constructor(
    private readonly store: RecommendationStorePort,
    private readonly statePort: ExternalStatePort,
    config: RecommendationEngineConfig = {},
    private readonly nowFn: () => Date = () => new Date()
  ) {
    this.ttlMs = config.ttlMs ?? DEFAULT_RECOMMENDATION_TTL_MS;
    this.maxBudgetPerDay =
      config.maxBudgetActionsPerAccountPerDay ?? DEFAULT_MAX_BUDGET_ACTIONS_PER_DAY;
  }

  /**
   * Convert a validated diagnosis + its evidence into zero or one
   * approval-bound recommendation. Deterministic given identical inputs and
   * identical port contents (timestamps aside).
   */
  async generate(input: GenerateInput): Promise<RecommendationOutcome> {
    const parsed = GenerateInputSchema.safeParse(input);
    if (!parsed.success) {
      return this.invalid(`Contract violation: ${parsed.error.issues[0]?.message ?? "invalid input"}`);
    }
    const { userId, diagnosis, evidence } = parsed.data;
    const now = this.nowFn();
    const at = now.toISOString();

    // --- Cross-consistency: the diagnosis MUST describe THIS evidence -----
    if (
      diagnosis.accountId !== evidence.accountId ||
      diagnosis.entityId !== evidence.entityId ||
      diagnosis.entityLevel !== evidence.entityLevel ||
      diagnosis.evidenceHash !== evidence.evidenceHash
    ) {
      return this.invalid("Diagnosis does not match evidence package");
    }

    // --- Category policy ----------------------------------------------------
    const policy = DIAGNOSIS_ACTION_POLICY[diagnosis.category];
    if (!policy) return this.noRec("INVALID_INPUT", "Unknown diagnosis category", at, input);
    if (policy.outcome === "NO_SPEND_ACTION") {
      return this.noRec("NO_SPEND_ACTION_TRACKING_ISSUE", policy.detail, at, input, diagnosis);
    }
    if (policy.outcome === "INVESTIGATION_REQUIRED") {
      return this.noRec("INVESTIGATION_REQUIRED", policy.detail, at, input, diagnosis);
    }
    if (policy.outcome === "NO_RECOMMENDATION") {
      return this.noRec("CATEGORY_NOT_ACTIONABLE", policy.detail, at, input, diagnosis);
    }

    // --- Quality gates --------------------------------------------------------
    if (evidence.freshness === "WARMUP_PERIOD") {
      return this.noRec("WARMUP_PERIOD", "Entity is in warmup; no action.", at, input, diagnosis);
    }
    if (evidence.freshness === "STALE_DATA") {
      return this.noRec("STALE_EVIDENCE", "Evidence window is stale; refresh before acting.", at, input, diagnosis);
    }
    if (evidence.dataQuality === "INSUFFICIENT_DATA") {
      return this.noRec("INSUFFICIENT_DATA_QUALITY", "Data quality insufficient.", at, input, diagnosis);
    }
    if (diagnosis.confidence === "LOW") {
      return this.noRec("LOW_CONFIDENCE", "Diagnosis confidence too low to act.", at, input, diagnosis);
    }
    if (evidence.anomalies.length === 0) {
      return this.noRec("NO_NEGATIVE_ANOMALIES", "No anomalies backing an action.", at, input, diagnosis);
    }
    const sigNeg = significantNegativeAnomalies(evidence);
    if (sigNeg.length === 0) {
      return this.noRec(
        "NO_NEGATIVE_ANOMALIES",
        "No significant negative anomalies; refusing negative action.",
        at,
        input,
        diagnosis
      );
    }
    const criticals = sigNeg.filter((a) => a.severity === "CRITICAL");
    const warnings = sigNeg.filter((a) => a.severity === "WARNING");
    if (criticals.length === 0 && warnings.length < 2) {
      return this.noRec(
        "INSUFFICIENT_SEVERITY",
        "Anomalies not severe enough to justify an action.",
        at,
        input,
        diagnosis
      );
    }
    const thin = sigNeg.find((a) => a.sampleCount < MIN_SAMPLE_COUNT);
    if (thin) {
      return this.noRec(
        "INSUFFICIENT_SEVERITY",
        `Sample size ${thin.sampleCount} below minimum ${MIN_SAMPLE_COUNT}.`,
        at,
        input,
        diagnosis
      );
    }
    const knownIds = new Set(evidence.anomalies.map((a) => a.anomalyId));
    const unknownCited = diagnosis.anomalyIds.filter((id) => !knownIds.has(id));
    if (unknownCited.length > 0) {
      return this.invalid(`Diagnosis cites unknown anomalies: ${unknownCited.join(",")}`);
    }

    // --- Candidate action selection (deterministic) ----------------------------
    const level = evidence.entityLevel;
    const allowed = policy.allowedActions ?? [];
    const levelCompatible = allowed.filter((a) => ACTION_CATALOG[a].allowedLevels.includes(level));
    if (levelCompatible.length === 0) {
      return this.noRec(
        "CATEGORY_NOT_ACTIONABLE",
        `Category offers no action compatible with level ${level}.`,
        at,
        input,
        diagnosis
      );
    }

    // --- Live external state -----------------------------------------------------
    const external = await this.statePort.loadState(evidence.accountId, level, evidence.entityId);
    if (!external) {
      return this.noRec("ENTITY_NOT_FOUND", "External entity no longer resolvable.", at, input, diagnosis);
    }
    if (external.status === "DELETED" || external.status === "ARCHIVED") {
      return this.noRec("ENTITY_DELETED", `Entity is ${external.status}.`, at, input, diagnosis);
    }

    // Severity-aware pick: prefer pause only when a CRITICAL exists; otherwise
    // take the least-destructive listed action for this level. When the entity
    // is PAUSED and a resume for this level is allowed, resume wins (e.g.
    // budget-constrained delivery on a paused entity).
    const hasCritical = criticals.length > 0;
    let candidates = levelCompatible.filter((a) =>
      familyOf(a) === "PAUSE" ? hasCritical : true
    );
    if (external.status === "PAUSED") {
      const resumeForLevel = candidates.find(
        (a) => familyOf(a) === "RESUME" && a.endsWith(`_${level}`)
      );
      if (resumeForLevel) candidates = [resumeForLevel];
    }
    if (candidates.length === 0) {
      return this.noRec(
        "INSUFFICIENT_SEVERITY",
        "Pause requires a CRITICAL signal; none present.",
        at,
        input,
        diagnosis
      );
    }
    const actionType = candidates[0];

    // --- Proposed/current state + hashes ------------------------------------------
    const currentState: Record<string, unknown> = {
      status: external.status,
      dailyBudget: external.dailyBudget ?? null,
    };
    let proposedState: Record<string, unknown>;
    let executableParams: Record<string, unknown>;

    if (isBudgetAction(actionType)) {
      const currentBudget = external.dailyBudget ?? null;
      if (currentBudget === null || currentBudget <= 0) {
        return this.noRec(
          "PRECONDITION_FAILED",
          "Entity has no daily budget set; cannot modify budget.",
          at,
          input,
          diagnosis
        );
      }
      const proposal = proposeBudgetChange(currentBudget, actionType);
      if (!proposal) {
        return this.noRec("PRECONDITION_FAILED", "No meaningful bounded change available.", at, input, diagnosis);
      }
      const check = validateBudgetProposal(proposal);
      if (!check.valid) {
        return this.noRec("GUARDRAIL_EXCEEDED", check.errors.join("; "), at, input, diagnosis);
      }
      proposedState = { dailyBudget: proposal.requestedDailyBudget };
      executableParams = buildExecutableParams(
        actionType,
        evidence.accountId,
        evidence.entityId,
        proposal.requestedDailyBudget
      );
    } else {
      const wantsPause = familyOf(actionType) === "PAUSE";
      if (wantsPause && external.status !== "ACTIVE") {
        return this.noRec(
          "PRECONDITION_FAILED",
          `Entity already ${external.status}; cannot pause.`,
          at,
          input,
          diagnosis
        );
      }
      if (!wantsPause && external.status !== "PAUSED") {
        return this.noRec(
          "PRECONDITION_FAILED",
          `Entity is ${external.status}; cannot resume.`,
          at,
          input,
          diagnosis
        );
      }
      proposedState = { status: wantsPause ? "PAUSED" : "ACTIVE" };
      executableParams = buildExecutableParams(actionType, evidence.accountId, evidence.entityId);
    }

    const stateHash = computeExternalStateHash(evidence.accountId, evidence.entityId, external);
    const paramsHash = computeParamsHash(executableParams);
    const identityHash = computeParamsHash({
      accountId: evidence.accountId,
      entityId: evidence.entityId,
      diagnosisId: diagnosis.diagnosisId,
      actionType,
      stateHash,
      paramsHash,
      evidenceHash: evidence.evidenceHash,
    });

    // --- Duplicate prevention -------------------------------------------------------
    const dup = await this.store.findActiveByIdentity(identityHash);
    if (dup) {
      return {
        status: "DUPLICATE",
        existingId: dup.recommendationId,
        audit: {
          at,
          outcome: "DUPLICATE",
          identityHash,
          recommendationId: dup.recommendationId,
          accountId: evidence.accountId,
          entityId: evidence.entityId,
          actionType,
        },
      };
    }

    // --- Conflict detection ------------------------------------------------------------
    const activeOnEntity = await this.store.findActiveByEntity(evidence.accountId, evidence.entityId);
    const conflictingIds = activeOnEntity
      .filter((r) => actionsConflict(r.actionType, actionType))
      .map((r) => r.recommendationId);
    if (conflictingIds.length > 0) {
      return {
        status: "CONFLICT_BLOCKED",
        conflictingIds,
        audit: {
          at,
          outcome: "CONFLICT_BLOCKED",
          conflictingIds,
          accountId: evidence.accountId,
          entityId: evidence.entityId,
          actionType,
        },
      };
    }

    // --- Cooldown / anti-oscillation ------------------------------------------------------
    const cooldownActions = [actionType, ...cooldownFamilyFor(actionType)];
    const recent = await this.store.findMostRecentByActions(
      evidence.accountId,
      evidence.entityId,
      cooldownActions
    );
    if (recent) {
      const elapsedMs = now.getTime() - new Date(recent.createdAt).getTime();
      if (elapsedMs >= 0 && elapsedMs < ACTION_CATALOG[actionType].cooldownMs) {
        return {
          status: "COOLDOWN_ACTIVE",
          remainingMs: ACTION_CATALOG[actionType].cooldownMs - elapsedMs,
          audit: {
            at,
            outcome: "COOLDOWN_ACTIVE",
            accountId: evidence.accountId,
            entityId: evidence.entityId,
            actionType,
            detail: `Last related action ${Math.round(elapsedMs / 60000)}m ago`,
          },
        };
      }
    }

    // --- Account-level budget rate limit -----------------------------------------------------
    if (isBudgetAction(actionType)) {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const count = await this.store.countBudgetActionsSince(evidence.accountId, since);
      if (count >= this.maxBudgetPerDay) {
        return {
          status: "RATE_LIMITED",
          detail: `Budget action limit (${this.maxBudgetPerDay}/day) reached for account`,
          audit: { at, outcome: "RATE_LIMITED", accountId: evidence.accountId },
        };
      }
    }

    // --- Assemble record -------------------------------------------------------------------------
    const risk = assessRisk(actionType, diagnosis, evidence, budgetRiskInputs(currentState, proposedState));
    const createdAt = now.toISOString();
    const record = RecommendationRecordSchema.parse({
      schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
      recommendationId: crypto.randomUUID(),
      userId,
      accountId: evidence.accountId,
      entityLevel: level,
      entityId: evidence.entityId,
      diagnosisId: diagnosis.diagnosisId,
      anomalyIds: [...diagnosis.anomalyIds],
      actionType,
      currentState,
      proposedState,
      reason: buildReason(diagnosis, policy.detail, sigNeg.length),
      evidence,
      expectedImpact: {
        metric: "SPEND",
        direction: spendDirectionOf(actionType),
        estimatedRange: "NOT_ESTIMATED",
        rationale: impactRationale(actionType, sigNeg.length),
      },
      risk,
      confidence: diagnosis.confidence,
      preconditions: buildPreconditions(actionType),
      paramsHash,
      stateHash,
      identityHash,
      status: "PROPOSED",
      requiresApproval: true,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      staleReasons: [],
    });

    await this.store.save(record);
    return {
      status: "CREATED",
      recommendation: record,
      audit: {
        at,
        outcome: "CREATED",
        recommendationId: record.recommendationId,
        identityHash,
        userId,
        accountId: record.accountId,
        entityLevel: record.entityLevel,
        entityId: record.entityId,
        diagnosisId: diagnosis.diagnosisId,
        actionType,
        risk,
        confidence: record.confidence,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Stale-state protection — the last gate before any execution (spec §5)
  // ---------------------------------------------------------------------------

  /**
   * Re-check a recommendation immediately before execution:
   *   1. status must still be PROPOSED or APPROVED,
   *   2. not expired (single TTL),
   *   3. requesting user + account must match (authorization binding),
   *   4. stored paramsHash must still match recomputed params (tamper check),
   *   5. live external state must hash identically (STATE_CHANGED otherwise),
   *   6. budget transitions must STILL satisfy guardrails against live budget.
   * Any failure ⇒ block with STALE/EXPIRED/INVALID. Never mutates Meta.
   */
  async verifyFreshForExecution(args: {
    record: RecommendationRecord;
    liveState: ExternalEntityState | null;
    requestingUserId: string;
    now?: Date;
  }): Promise<
    | { ok: true }
    | { ok: false; result: "EXPIRED" | "STALE" | "INVALID"; reasons: string[] }
  > {
    const { record, liveState, requestingUserId } = args;
    const now = args.now ?? this.nowFn();
    const reasons: string[] = [];

    if (record.status !== "PROPOSED" && record.status !== "APPROVED") {
      reasons.push(`STATUS_NOT_EXECUTABLE:${record.status}`);
      return { ok: false, result: "INVALID", reasons };
    }
    if (new Date(record.expiresAt).getTime() <= now.getTime()) {
      return { ok: false, result: "EXPIRED", reasons: ["TTL_EXPIRED"] };
    }
    if (record.userId !== requestingUserId) {
      return { ok: false, result: "INVALID", reasons: ["USER_MISMATCH"] };
    }
    // Tamper check: recompute paramsHash from the bound tool parameters.
    try {
      const budget = typeof record.proposedState["dailyBudget"] === "number"
        ? (record.proposedState["dailyBudget"] as number)
        : undefined;
      const params = buildExecutableParams(
        record.actionType,
        record.accountId,
        record.entityId,
        budget
      );
      if (computeParamsHash(params) !== record.paramsHash) {
        return { ok: false, result: "INVALID", reasons: ["PARAMS_HASH_MISMATCH"] };
      }
    } catch {
      return { ok: false, result: "INVALID", reasons: ["PARAMS_UNBUILDABLE"] };
    }
    if (!liveState) {
      return { ok: false, result: "STALE", reasons: ["ENTITY_NOT_FOUND"] };
    }
    const liveHash = computeExternalStateHash(record.accountId, record.entityId, liveState);
    if (liveHash !== record.stateHash) {
      reasons.push(...diffStateReasons(record, liveState));
      return { ok: false, result: "STALE", reasons };
    }
    if (isBudgetAction(record.actionType)) {
      const currentBudget = liveState.dailyBudget ?? null;
      const requested = record.proposedState["dailyBudget"];
      if (currentBudget === null || currentBudget <= 0 || typeof requested !== "number") {
        return { ok: false, result: "STALE", reasons: ["BUDGET_REMOVED"] };
      }
      const absoluteChange = round2(requested - currentBudget);
      const percentChange =
        Math.round((absoluteChange / currentBudget) * 10000) / 100;
      const check = validateBudgetProposal({
        currentBudget,
        requestedDailyBudget: requested,
        percentChange,
        absoluteChange,
      });
      if (!check.valid) {
        return { ok: false, result: "STALE", reasons: ["GUARDRAIL_VS_LIVE_STATE", ...check.errors] };
      }
    }
    return { ok: true };
  }

  private invalid(detail: string): RecommendationOutcome {
    return {
      status: "INVALID_INPUT",
      detail,
      audit: { at: this.nowFn().toISOString(), outcome: "INVALID_INPUT", detail },
    };
  }

  private noRec(
    reason: NoRecommendationReason,
    detail: string,
    at: string,
    input: GenerateInput,
    diagnosis?: DiagnosisResult
  ): RecommendationOutcome {
    return {
      status: "NO_RECOMMENDATION",
      reason,
      detail,
      audit: {
        at,
        outcome: "NO_RECOMMENDATION",
        reason,
        detail: redactSecrets(detail),
        userId: input.userId,
        accountId: input.evidence?.accountId,
        entityLevel: input.evidence?.entityLevel,
        entityId: input.evidence?.entityId,
        diagnosisId: diagnosis?.diagnosisId,
      },
    };
  }
}

function budgetRiskInputs(
  currentState: Record<string, unknown>,
  proposedState: Record<string, unknown>
): { percentChange: number; absoluteChange: number } | undefined {
  const cur = currentState["dailyBudget"];
  const prop = proposedState["dailyBudget"];
  if (typeof cur !== "number" || typeof prop !== "number" || cur <= 0) return undefined;
  const absoluteChange = Math.abs(round2(prop - cur));
  const percentChange = Math.abs(Math.round(((prop - cur) / cur) * 10000) / 100);
  return { percentChange, absoluteChange };
}

function diffStateReasons(
  record: RecommendationRecord,
  live: ExternalEntityState
): string[] {
  const reasons: string[] = [];
  const prev = record.currentState;
  if (prev["status"] !== live.status) reasons.push("STATUS_CHANGED");
  if ((prev["dailyBudget"] ?? null) !== (live.dailyBudget ?? null)) reasons.push("BUDGET_CHANGED");
  if (
    (live.objective ?? null) !== null &&
    prev["objective"] !== undefined &&
    prev["objective"] !== live.objective
  )
    reasons.push("OBJECTIVE_CHANGED");
  if (reasons.length === 0) reasons.push("TARGETING_OR_OTHER_FIELD_CHANGED");
  return reasons;
}
