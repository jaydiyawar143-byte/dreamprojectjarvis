import { z } from "zod";
import {
  ConfidenceLevelSchema,
  EvidencePackageSchema,
  type DiagnosisCategory,
} from "./diagnosis.js";
import {
  AggregationLevelSchema,
  type AggregationLevel,
} from "./performance-aggregation.js";
import { computeParamsHash } from "../utils/params-hash.js";

// ---------------------------------------------------------------------------
// Phase 11.5 -- Evidence-Based Recommendation Contracts
// ---------------------------------------------------------------------------
// A Recommendation is a DETERMINISTIC, approval-bound proposal to execute one
// existing safe Meta Ads write tool. It is derived exclusively from:
//   1. a validated DiagnosisResult (Phase 11.4), and
//   2. the EvidencePackage that diagnosis consumed.
// The engine NEVER invents actions, never calls an LLM, and never fabricates
// impact forecasts. Every record binds:
//   - stateHash    -> the exact external entity state it was computed against,
//   - paramsHash   -> the exact tool parameters a human will approve, and
//   - identityHash -> deterministic dedup/conflict identity.
// Stale-state protection: before ANY execution the live external state is
// re-fetched and re-hashed; any drift means STALE means hard block.
// ---------------------------------------------------------------------------

export const RECOMMENDATION_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

/** Exactly the eight approved action types. Nothing else is representable. */
export const RecommendationActionSchema = z.enum([
  "PAUSE_CAMPAIGN",
  "RESUME_CAMPAIGN",
  "PAUSE_AD_SET",
  "RESUME_AD_SET",
  "PAUSE_AD",
  "RESUME_AD",
  "INCREASE_BUDGET",
  "DECREASE_BUDGET",
]);
export type RecommendationAction = z.infer<typeof RecommendationActionSchema>;

/**
 * Explicit status lifecycle:
 *   PROPOSED -> APPROVED -> EXECUTING -> EXECUTED
 *      \-> REJECTED / EXPIRED / STALE
 *   EXECUTING -> FAILED (provider error after claim)
 * Terminal: EXECUTED | REJECTED | EXPIRED | STALE | FAILED
 */
export const RecommendationStatusSchema = z.enum([
  "PROPOSED",
  "APPROVED",
  "EXECUTING",
  "EXECUTED",
  "REJECTED",
  "EXPIRED",
  "STALE",
  "FAILED",
]);
export type RecommendationStatus = z.infer<typeof RecommendationStatusSchema>;

/** Risk vocabulary for recommendations (distinct from generic tool risk). */
export const RecommendationRiskSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type RecommendationRisk = z.infer<typeof RecommendationRiskSchema>;

const RISK_ORDER: Record<RecommendationRisk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Deterministic max() over risk levels. */
export function escalateRisk(...levels: RecommendationRisk[]): RecommendationRisk {
  let best: RecommendationRisk = "LOW";
  for (const l of levels) if (RISK_ORDER[l] > RISK_ORDER[best]) best = l;
  return best;
}

// ---------------------------------------------------------------------------
// Expected impact -- deliberately un-forecastable in v1
// ---------------------------------------------------------------------------

/**
 * estimatedRange is ALWAYS "NOT_ESTIMATED" from this engine. The union keeps
 * the contract forward-compatible with a future deterministically-justified
 * range, but nothing in v1 may produce numbers: fabricated ROI projections
 * are prohibited by spec.
 */
export const EstimatedRangeSchema = z.union([
  z.literal("NOT_ESTIMATED"),
  z
    .object({ low: z.number().finite(), high: z.number().finite() })
    .strict(),
]);
export type EstimatedRange = z.infer<typeof EstimatedRangeSchema>;

export const ExpectedImpactSchema = z
  .object({
    metric: z.literal("SPEND"),
    direction: z.enum(["INCREASE", "DECREASE", "STABILIZE"]),
    estimatedRange: EstimatedRangeSchema,
    rationale: z.string().min(1).max(1000),
  })
  .strict();
export type ExpectedImpact = z.infer<typeof ExpectedImpactSchema>;

// ---------------------------------------------------------------------------
// External entity state snapshot + hash
// ---------------------------------------------------------------------------

export const ExternalEntityStateSchema = z
  .object({
    status: z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]),
    objective: z.string().max(64).nullable().optional(),
    dailyBudget: z.number().positive().nullable().optional(),
    lifetimeBudget: z.number().positive().nullable().optional(),
    /** Opaque fingerprint of targeting (audience/geo/placements hash). */
    targetingFingerprint: z.string().max(256).nullable().optional(),
  })
  .strict();
export type ExternalEntityState = z.infer<typeof ExternalEntityStateSchema>;

/**
 * Canonical hash over ONLY the fields that make recommendations stale.
 * Any change in these fields => different hash => STALE.
 */
export function computeExternalStateHash(
  accountId: string,
  entityId: string,
  state: ExternalEntityState
): string {
  return computeParamsHash({
    accountId,
    entityId,
    status: state.status,
    objective: state.objective ?? null,
    dailyBudget: state.dailyBudget ?? null,
    lifetimeBudget: state.lifetimeBudget ?? null,
    targetingFingerprint: state.targetingFingerprint ?? null,
  });
}

// ---------------------------------------------------------------------------
// Action catalog -- maps each action onto an EXISTING safe write tool.
// No new Meta tools are introduced by Phase 11.5.
// ---------------------------------------------------------------------------

export interface ActionCatalogEntry {
  toolIdFor(level: AggregationLevel): string;
  allowedLevels: readonly AggregationLevel[];
  baseRisk: RecommendationRisk;
  /** Minimum time between creations of this/opposite family on one target. */
  cooldownMs: number;
}

const PAUSE_RESUME_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h anti-oscillation
const BUDGET_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h per budget action

function pauseResumeEntry(
  pauseToolId: string,
  resumeToolId: string,
  level: AggregationLevel,
  pauseRisk: RecommendationRisk,
  resumeRisk: RecommendationRisk
): { pause: ActionCatalogEntry; resume: ActionCatalogEntry } {
  return {
    pause: {
      toolIdFor: () => pauseToolId,
      allowedLevels: [level],
      baseRisk: pauseRisk,
      cooldownMs: PAUSE_RESUME_COOLDOWN_MS,
    },
    resume: {
      toolIdFor: () => resumeToolId,
      allowedLevels: [level],
      baseRisk: resumeRisk,
      cooldownMs: PAUSE_RESUME_COOLDOWN_MS,
    },
  };
}

const campaignPR = pauseResumeEntry(
  "meta.campaign.pause",
  "meta.campaign.resume",
  "CAMPAIGN",
  "HIGH",
  "MEDIUM"
);
const adSetPR = pauseResumeEntry(
  "meta.adset.pause",
  "meta.adset.resume",
  "AD_SET",
  "MEDIUM",
  "MEDIUM"
);
const adPR = pauseResumeEntry("meta.ad.pause", "meta.ad.resume", "AD", "LOW", "LOW");

const budgetEntry = (baseRisk: RecommendationRisk): ActionCatalogEntry => ({
  toolIdFor: (level) =>
    level === "AD_SET" ? "meta.adset.budget.update" : "meta.campaign.budget.update",
  allowedLevels: ["CAMPAIGN", "AD_SET"], // no ad-level budget tool exists
  baseRisk,
  cooldownMs: BUDGET_COOLDOWN_MS,
});

export const ACTION_CATALOG: Record<RecommendationAction, ActionCatalogEntry> = {
  PAUSE_CAMPAIGN: campaignPR.pause,
  RESUME_CAMPAIGN: campaignPR.resume,
  PAUSE_AD_SET: adSetPR.pause,
  RESUME_AD_SET: adSetPR.resume,
  PAUSE_AD: adPR.pause,
  RESUME_AD: adPR.resume,
  INCREASE_BUDGET: budgetEntry("MEDIUM"),
  DECREASE_BUDGET: budgetEntry("LOW"),
};

/** Actions whose params include an explicit requestedDailyBudget number. */
export function isBudgetAction(
  a: RecommendationAction
): a is "INCREASE_BUDGET" | "DECREASE_BUDGET" {
  return a === "INCREASE_BUDGET" || a === "DECREASE_BUDGET";
}

/** Family used for oscillation + conflict logic. */
export type ActionFamily = "PAUSE" | "RESUME" | "BUDGET_INCREASE" | "BUDGET_DECREASE";
export function familyOf(a: RecommendationAction): ActionFamily {
  switch (a) {
    case "PAUSE_CAMPAIGN":
    case "PAUSE_AD_SET":
    case "PAUSE_AD":
      return "PAUSE";
    case "RESUME_CAMPAIGN":
    case "RESUME_AD_SET":
    case "RESUME_AD":
      return "RESUME";
    case "INCREASE_BUDGET":
      return "BUDGET_INCREASE";
    case "DECREASE_BUDGET":
      return "BUDGET_DECREASE";
  }
}

/** Entity level encoded in an action name (CAMPAIGN | AD_SET | AD). */
function levelSuffixOf(a: RecommendationAction): string {
  if (a.endsWith("_AD_SET")) return "AD_SET";
  if (a.endsWith("_AD")) return "AD";
  return "CAMPAIGN";
}

/**
 * Two active recommendations on the same entity conflict when their families
 * fight each other. Non-conflicting combos may coexist.
 */
export function actionsConflict(a: RecommendationAction, b: RecommendationAction): boolean {
  if (a === b) return true;
  const fa = familyOf(a);
  const fb = familyOf(b);
  if (fa === fb) return true;
  // Pause/resume only fight on the SAME entity level; pausing an ad set and
  // resuming a different-level ad are independent decisions. (Conflicts are
  // evaluated per-entity anyway, so cross-level pairs never meet in practice.)
  const opposite =
    (fa === "PAUSE" && fb === "RESUME") || (fa === "RESUME" && fb === "PAUSE");
  if (opposite) return levelSuffixOf(a) === levelSuffixOf(b);
  const budgetFight =
    (fa === "BUDGET_INCREASE" && fb === "BUDGET_DECREASE") ||
    (fa === "BUDGET_DECREASE" && fb === "BUDGET_INCREASE");
  if (budgetFight) return true;
  // Never raise spend on something we are pausing (or vice versa).
  if (
    (fa === "PAUSE" && fb === "BUDGET_INCREASE") ||
    (fa === "BUDGET_INCREASE" && fb === "PAUSE")
  )
    return true;
  // Decreasing budget while resuming spend is contradictory intent.
  if (
    (fa === "RESUME" && fb === "BUDGET_DECREASE") ||
    (fa === "BUDGET_DECREASE" && fb === "RESUME")
  )
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// Budget guardrails (server-side financial limits)
// ---------------------------------------------------------------------------
// Values mirror packages/tools DEFAULT_BUDGET_GUARDRAILS (Phase 9.2) so the
// engine only ever proposes transitions the execution layer will accept.
// The tools package cannot be imported here (it depends on core); parity is
// asserted by convention and re-verified at execution time regardless.

export const RECOMMENDATION_BUDGET_GUARDRAILS = {
  maxDailyBudget: 10_000,
  maxIncreasePercent: 25,
  maxIncreaseAbsolute: 2500,
  maxDecreasePercent: 50,
  maxDecreaseAbsolute: 5000,
} as const;

/** Default proposed increase magnitude (bounded by guardrail caps). */
export const BUDGET_INCREASE_TARGET_PERCENT = 20;
/** Default proposed decrease magnitude. */
export const BUDGET_DECREASE_TARGET_PERCENT = 20;
/** Smallest viable daily budget we will ever propose. */
export const MIN_DAILY_BUDGET = 1;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface BudgetProposal {
  currentBudget: number;
  requestedDailyBudget: number;
  percentChange: number;
  absoluteChange: number;
}

/**
 * Deterministic budget proposal. Increase: smallest of (percent cap,
 * absolute cap, global ceiling) -- always within guardrails. Decrease:
 * symmetric. Returns null when no meaningful transition is possible.
 */
export function proposeBudgetChange(
  currentBudget: number,
  action: "INCREASE_BUDGET" | "DECREASE_BUDGET"
): BudgetProposal | null {
  if (!Number.isFinite(currentBudget) || currentBudget <= 0) return null;
  const g = RECOMMENDATION_BUDGET_GUARDRAILS;
  let requested: number;
  if (action === "INCREASE_BUDGET") {
    // Target a conservative step; hard caps clamp everything.
    const pct = Math.min(BUDGET_INCREASE_TARGET_PERCENT, g.maxIncreasePercent);
    requested = Math.min(
      currentBudget * (1 + pct / 100),
      currentBudget + g.maxIncreaseAbsolute,
      g.maxDailyBudget
    );
  } else {
    const pct = Math.min(BUDGET_DECREASE_TARGET_PERCENT, g.maxDecreasePercent);
    requested = Math.max(currentBudget * (1 - pct / 100), MIN_DAILY_BUDGET);
  }
  requested = round2(requested);
  // An "increase" that lands at or below the current budget (cap-clamped) or
  // a "decrease" that cannot go lower is not a meaningful transition.
  if (action === "INCREASE_BUDGET" && requested <= currentBudget) return null;
  if (action === "DECREASE_BUDGET" && requested >= currentBudget) return null;
  const absoluteChange = round2(requested - currentBudget);
  const percentChange = Math.round((absoluteChange / currentBudget) * 10000) / 100;
  if (Math.abs(absoluteChange) < 0.01) return null;
  return { currentBudget, requestedDailyBudget: requested, percentChange, absoluteChange };
}

/** Re-validate any proposed transition against guardrails. Fail closed. */
export function validateBudgetProposal(p: BudgetProposal): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const g = RECOMMENDATION_BUDGET_GUARDRAILS;
  if (p.requestedDailyBudget <= 0) errors.push("Requested budget must be positive");
  if (p.requestedDailyBudget > g.maxDailyBudget)
    errors.push(
      `Requested budget ${p.requestedDailyBudget} exceeds max daily budget ${g.maxDailyBudget}`
    );
  if (p.absoluteChange > 0) {
    if (p.absoluteChange > g.maxIncreaseAbsolute)
      errors.push(`Increase ${p.absoluteChange} exceeds absolute cap ${g.maxIncreaseAbsolute}`);
    if (p.percentChange > g.maxIncreasePercent)
      errors.push(`Increase ${p.percentChange}% exceeds percent cap ${g.maxIncreasePercent}%`);
  } else if (p.absoluteChange < 0) {
    if (-p.absoluteChange > g.maxDecreaseAbsolute)
      errors.push(`Decrease ${-p.absoluteChange} exceeds absolute cap ${g.maxDecreaseAbsolute}`);
    if (-p.percentChange > g.maxDecreasePercent)
      errors.push(`Decrease ${-p.percentChange}% exceeds percent cap ${g.maxDecreasePercent}%`);
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Diagnosis -> action policy (deterministic mapping table)
// ---------------------------------------------------------------------------

export type CategoryOutcomeKind =
  | "ALLOW_ACTIONS"
  | "NO_SPEND_ACTION"
  | "INVESTIGATION_REQUIRED"
  | "NO_RECOMMENDATION";

export interface CategoryPolicy {
  outcome: CategoryOutcomeKind;
  detail: string;
  allowedActions?: readonly RecommendationAction[];
}

/**
 * Conservative, explicitly-enumerated mapping. Categories not listed would be
 * a contract bug -- the engine fails closed on unknown categories.
 */
export const DIAGNOSIS_ACTION_POLICY: Record<DiagnosisCategory, CategoryPolicy> = {
  CREATIVE_FATIGUE: {
    outcome: "ALLOW_ACTIONS",
    detail: "Creative fatigue: stop fatigued creative or throttle its spend.",
    allowedActions: ["PAUSE_AD", "DECREASE_BUDGET"],
  },
  AUDIENCE_SATURATION: {
    outcome: "ALLOW_ACTIONS",
    detail: "Audience saturated: pause saturated ad set or reduce spend.",
    allowedActions: ["PAUSE_AD_SET", "DECREASE_BUDGET"],
  },
  COST_INFLATION: {
    outcome: "ALLOW_ACTIONS",
    detail: "Costs inflating vs baseline: reduce spend or cut worst creative.",
    allowedActions: ["PAUSE_AD", "DECREASE_BUDGET"],
  },
  ENGAGEMENT_DECLINE: {
    outcome: "ALLOW_ACTIONS",
    detail: "Engagement declining: cut worst creative or reduce spend.",
    allowedActions: ["PAUSE_AD", "DECREASE_BUDGET"],
  },
  CONVERSION_RATE_DECLINE: {
    outcome: "ALLOW_ACTIONS",
    detail: "Conversion rate declining: reduce spend while root cause is investigated.",
    allowedActions: ["DECREASE_BUDGET"],
  },
  BUDGET_CONSTRAINT: {
    outcome: "ALLOW_ACTIONS",
    detail:
      "Delivery constrained by budget: bounded increase within guardrails (or resume if paused).",
    allowedActions: [
      "INCREASE_BUDGET",
      "RESUME_CAMPAIGN",
      "RESUME_AD_SET",
      "RESUME_AD",
    ],
  },
  LANDING_PAGE_ISSUE: {
    outcome: "INVESTIGATION_REQUIRED",
    detail: "Off-platform root cause: fix destination before changing spend.",
  },
  TRACKING_ISSUE: {
    outcome: "NO_SPEND_ACTION",
    detail: "Measurement unreliable: spend decisions must wait for tracking fix.",
  },
  DELIVERY_ISSUE: {
    outcome: "INVESTIGATION_REQUIRED",
    detail: "Delivery anomaly requires investigation before automated changes.",
  },
  COMPETITIVE_PRESSURE: {
    outcome: "NO_RECOMMENDATION",
    detail: "Strategic context: human judgment required.",
  },
  SEASONALITY: {
    outcome: "NO_RECOMMENDATION",
    detail: "Expected seasonal pattern: no action warranted.",
  },
  INSUFFICIENT_DATA: {
    outcome: "NO_RECOMMENDATION",
    detail: "Not enough data to justify any action.",
  },
  NO_CLEAR_DIAGNOSIS: {
    outcome: "NO_RECOMMENDATION",
    detail: "No confident diagnosis: no action.",
  },
  UNKNOWN: {
    outcome: "NO_RECOMMENDATION",
    detail: "Unclassified condition: no action.",
  },
};

// ---------------------------------------------------------------------------
// Status lifecycle
// ---------------------------------------------------------------------------

const STATUS_TRANSITIONS: Record<
  RecommendationStatus,
  readonly RecommendationStatus[]
> = {
  PROPOSED: ["APPROVED", "REJECTED", "EXPIRED", "STALE"],
  APPROVED: ["EXECUTING", "EXPIRED", "STALE", "FAILED"],
  EXECUTING: ["EXECUTED", "FAILED"],
  EXECUTED: [],
  REJECTED: [],
  EXPIRED: [],
  STALE: [],
  FAILED: [],
};

export function canTransition(
  from: RecommendationStatus,
  to: RecommendationStatus
): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function terminalStatuses(): ReadonlySet<RecommendationStatus> {
  return new Set(
    (Object.keys(STATUS_TRANSITIONS) as RecommendationStatus[]).filter(
      (s) => STATUS_TRANSITIONS[s].length === 0
    )
  );
}

export const ACTIVE_STATUSES: readonly RecommendationStatus[] = [
  "PROPOSED",
  "APPROVED",
  "EXECUTING",
];

// ---------------------------------------------------------------------------
// Phase 11.8B — Deterministic confidence assessment (structured explanation)
// ---------------------------------------------------------------------------
// Historical outcomes are SUPPORTING EVIDENCE ONLY. They are never causal
// proof and must never guarantee future performance. Every field below is
// produced by a pure deterministic function — no LLM, no randomness, and no
// free-form AI reasoning.
// ---------------------------------------------------------------------------

/**
 * Sample-quality classification for historical evidence (spec §4).
 * Thresholds are configurable in the confidence model; the labels are fixed:
 *   0        -> NO_HISTORY
 *   1–2      -> VERY_LOW_SAMPLE
 *   3–9      -> LOW_SAMPLE
 *   10+      -> STRONGER_HISTORY
 * A larger sample NEVER by itself claims statistical significance.
 */
export const SampleQualitySchema = z.enum([
  "NO_HISTORY",
  "VERY_LOW_SAMPLE",
  "LOW_SAMPLE",
  "STRONGER_HISTORY",
]);
export type SampleQuality = z.infer<typeof SampleQualitySchema>;

export const ConfidenceAssessmentSchema = z.object({
  /** Final combined confidence after historical evidence (or before, if none). */
  level: z.enum(["LOW", "MEDIUM", "HIGH"]),
  /** Pre-history current-evidence strength (diagnosis + evidence package). */
  currentEvidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  /** Historical evidence strength label. */
  historicalEvidence: z.enum(["NONE", "WEAK", "MODERATE", "STRONG"]),
  sampleQuality: SampleQualitySchema,
  historicalSampleSize: z.number().int().nonnegative(),
  historicalConsistency: z.enum([
    "NONE",
    "CONSISTENT_POSITIVE",
    "CONSISTENT_NEGATIVE",
    "MIXED",
  ]),
  /** OutcomeIds of relevant NEGATIVE historical outcomes (traceable). */
  contradictoryEvidence: z.array(z.string()).max(500),
  limitations: z.array(z.string()).max(20),
}).strict();
export type ConfidenceAssessment = z.infer<typeof ConfidenceAssessmentSchema>;

// ---------------------------------------------------------------------------
// Recommendation record
// ---------------------------------------------------------------------------

export const RecommendationRecordSchema = z
  .object({
    schemaVersion: z.literal(RECOMMENDATION_SCHEMA_VERSION),
    recommendationId: z.string().min(1),
    userId: z.string().min(1),
    accountId: z.string().min(1),
    entityLevel: AggregationLevelSchema,
    entityId: z.string().min(1),
    diagnosisId: z.string().min(1),
    diagnosisCategory: z.string().nullable().optional(),
    anomalyIds: z.array(z.string()).max(50),
    actionType: RecommendationActionSchema,
    currentState: z.record(z.unknown()),
    proposedState: z.record(z.unknown()),
    reason: z.string().min(1).max(2000),
    evidence: EvidencePackageSchema,
    expectedImpact: ExpectedImpactSchema,
    risk: RecommendationRiskSchema,
    confidence: ConfidenceLevelSchema,
    priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
    historicalEvidenceIds: z.array(z.string()).default([]),
    confidenceExplanation: ConfidenceAssessmentSchema.nullable().optional(),
    preconditions: z.array(z.string()).max(20),
    paramsHash: z.string().min(16),
    stateHash: z.string().min(16),
    identityHash: z.string().min(16),
    status: RecommendationStatusSchema.default("PROPOSED"),
    /** Mutations ALWAYS require human approval. Structural constant. */
    requiresApproval: z.literal(true),
    createdAt: z.string(),
    updatedAt: z.string(),
    expiresAt: z.string(),
    approvalId: z.string().optional(),
    executionId: z.string().optional(),
    staleReasons: z.array(z.string()).max(10).default([]),
  })
  .strict();
export type RecommendationRecord = z.infer<typeof RecommendationRecordSchema>;

/** Executable parameters exactly as the target tool receives them. */
export function buildExecutableParams(
  actionType: RecommendationAction,
  accountId: string,
  entityId: string,
  proposedDailyBudget?: number,
  entityLevel?: AggregationLevel
): Record<string, unknown> {
  switch (actionType) {
    case "PAUSE_CAMPAIGN":
    case "RESUME_CAMPAIGN":
      return { accountId, campaignId: entityId };
    case "PAUSE_AD_SET":
    case "RESUME_AD_SET":
      return { accountId, adSetId: entityId };
    case "INCREASE_BUDGET":
    case "DECREASE_BUDGET": {
      if (proposedDailyBudget === undefined || !Number.isFinite(proposedDailyBudget)) {
        throw new Error("Budget action requires proposedDailyBudget");
      }
      // Phase 11.6A fix: budget tools differ by target level —
      // meta.campaign.budget.update takes campaignId, meta.adset.budget.update
      // takes adSetId. The level is REQUIRED for budget actions so the exact
      // tool parameters (and therefore paramsHash) are unambiguous.
      if (entityLevel === "CAMPAIGN") {
        return { accountId, campaignId: entityId, requestedDailyBudget: proposedDailyBudget };
      }
      if (entityLevel === "AD_SET") {
        return { accountId, adSetId: entityId, requestedDailyBudget: proposedDailyBudget };
      }
      throw new Error("Budget action requires entityLevel CAMPAIGN or AD_SET");
    }
    case "PAUSE_AD":
    case "RESUME_AD":
      return { accountId, adId: entityId };
  }
}
