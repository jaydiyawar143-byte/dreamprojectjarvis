import type {
  ExternalEntityState,
  RecentActionRow,
  RecommendationAction,
  RecommendationRecord,
  RecommendationStatus,
  RecommendationStorePort,
} from "@jarvis/core";
import { canTransition, redactSecrets } from "@jarvis/core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Phase 11.5 -- Durable recommendation store (Prisma/PostgreSQL).
//
// Implements the engine's RecommendationStorePort on top of the
// PerformanceRecommendation table and adds strict single-winner lifecycle
// transitions (conditional UPDATE ... WHERE status IN (...)), expiry sweeps,
// stale marking and secret-free audit rows.
//
// Enum bridging: core uses spec names (PAUSE_AD_SET); the DB enum keeps its
// Phase 11.1 spelling (PAUSE_ADSET). Mapping is explicit and total below.
// ---------------------------------------------------------------------------

type DbAction =
  | "PAUSE_CAMPAIGN"
  | "RESUME_CAMPAIGN"
  | "PAUSE_ADSET"
  | "RESUME_ADSET"
  | "PAUSE_AD"
  | "RESUME_AD"
  | "INCREASE_BUDGET"
  | "DECREASE_BUDGET";

const ACTION_TO_DB: Record<RecommendationAction, DbAction> = {
  PAUSE_CAMPAIGN: "PAUSE_CAMPAIGN",
  RESUME_CAMPAIGN: "RESUME_CAMPAIGN",
  PAUSE_AD_SET: "PAUSE_ADSET",
  RESUME_AD_SET: "RESUME_ADSET",
  PAUSE_AD: "PAUSE_AD",
  RESUME_AD: "RESUME_AD",
  INCREASE_BUDGET: "INCREASE_BUDGET",
  DECREASE_BUDGET: "DECREASE_BUDGET",
};
const DB_TO_ACTION: Record<DbAction, RecommendationAction> = Object.fromEntries(
  Object.entries(ACTION_TO_DB).map(([k, v]) => [v, k])
) as Record<DbAction, RecommendationAction>;

const ACTIVE_DB_STATUSES = ["PROPOSED", "PENDING_APPROVAL", "APPROVED", "EXECUTING"] as const;

/** Deterministic label -> legacy Float confidence column. */
const CONFIDENCE_TO_FLOAT: Record<RecommendationRecord["confidence"], number> = {
  LOW: 0.3,
  MEDIUM: 0.6,
  HIGH: 0.9,
};

/** Thrown when a concurrent insert violates the partial unique identity index. */
export class DuplicateRecommendationError extends Error {
  constructor(public readonly identityHash: string) {
    super(`Active recommendation already exists for identity ${identityHash}`);
    this.name = "DuplicateRecommendationError";
  }
}

interface DbRowShape {
  id: string;
  userId: string;
  accountId: string;
  targetLevel: "ACCOUNT" | "CAMPAIGN" | "AD_SET" | "AD";
  targetId: string;
  actionType: DbAction;
  status: string;
  reason: string;
  evidence: unknown;
  expectedImpact: string;
  confidence: number;
  riskLevel: string;
  proposedChange: unknown;
  paramsHash: string;
  diagnosisId: string | null;
  anomalyIds: unknown;
  currentState: unknown;
  proposedState: unknown;
  preconditions: unknown;
  evidenceHash: string | null;
  stateHash: string | null;
  identityHash: string | null;
  requiresApproval: boolean;
  staleReasons: unknown;
  approvalId: string | null;
  executionId: string | null;
  expiresAt: Date;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  executedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function floatToConfidence(f: number): RecommendationRecord["confidence"] {
  return f >= 0.75 ? "HIGH" : f >= 0.45 ? "MEDIUM" : "LOW";
}

function toRecord(row: DbRowShape): RecommendationRecord {
  const impactRaw = row.expectedImpact;
  let expectedImpact: RecommendationRecord["expectedImpact"];
  try {
    expectedImpact = JSON.parse(impactRaw) as RecommendationRecord["expectedImpact"];
  } catch {
    // Legacy plain-string impacts normalize to a safe unforecast shape.
    expectedImpact = {
      metric: "SPEND",
      direction: "STABILIZE",
      estimatedRange: "NOT_ESTIMATED",
      rationale: impactRaw.slice(0, 1000),
    };
  }
  const record: RecommendationRecord = {
    schemaVersion: 1,
    recommendationId: row.id,
    userId: row.userId,
    accountId: row.accountId,
    entityLevel: row.targetLevel,
    entityId: row.targetId,
    diagnosisId: row.diagnosisId ?? "unknown_diagnosis",
    anomalyIds: Array.isArray(row.anomalyIds) ? (row.anomalyIds as string[]) : [],
    actionType: DB_TO_ACTION[row.actionType],
    currentState:
      row.currentState && typeof row.currentState === "object"
        ? (row.currentState as Record<string, unknown>)
        : {},
    proposedState:
      row.proposedState && typeof row.proposedState === "object"
        ? (row.proposedState as Record<string, unknown>)
        : {},
    reason: row.reason,
    evidence: row.evidence as RecommendationRecord["evidence"],
    expectedImpact,
    risk: (row.riskLevel as RecommendationRecord["risk"]) ?? "LOW",
    confidence: floatToConfidence(row.confidence),
    preconditions: Array.isArray(row.preconditions) ? (row.preconditions as string[]) : [],
    paramsHash: row.paramsHash,
    stateHash: row.stateHash ?? "",
    identityHash: row.identityHash ?? "",
    status: row.status as RecommendationStatus,
    requiresApproval: true,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    approvalId: row.approvalId ?? undefined,
    executionId: row.executionId ?? undefined,
    staleReasons: Array.isArray(row.staleReasons) ? (row.staleReasons as string[]) : [],
  };
  if (!record.stateHash || !record.identityHash) {
    // Legacy Phase 11.1 rows carry no binding hashes: they can never pass
    // verifyFreshForExecution and are surfaced with explicit markers.
    record.staleReasons = [...record.staleReasons, "LEGACY_ROW_MISSING_BINDING"];
  }
  return record;
}

function auditMetadata(record: RecommendationRecord): Prisma.InputJsonValue {
  // Secret-free by construction: identifiers and decisions only.
  return JSON.parse(
    redactSecrets(
      JSON.stringify({
        recommendationId: record.recommendationId,
        accountId: record.accountId,
        entityId: record.entityId,
        entityLevel: record.entityLevel,
        actionType: record.actionType,
        risk: record.risk,
        confidence: record.confidence,
        identityHash: record.identityHash,
        stateHash: record.stateHash,
        paramsHash: record.paramsHash,
      })
    )
  ) as Prisma.InputJsonValue;
}

export class PrismaRecommendationRepository implements RecommendationStorePort {
  constructor(private prisma: PrismaClient) {}

  async save(record: RecommendationRecord): Promise<void> {
    try {
      await this.prisma.performanceRecommendation.create({
        data: {
          id: record.recommendationId,
          userId: record.userId,
          accountId: record.accountId,
          targetLevel: record.entityLevel,
          targetId: record.entityId,
          actionType: ACTION_TO_DB[record.actionType],
          status: record.status === "PROPOSED" ? "PROPOSED" : record.status,
          reason: record.reason,
          evidence: record.evidence as unknown as Prisma.InputJsonValue,
          expectedImpact: JSON.stringify(record.expectedImpact),
          confidence: CONFIDENCE_TO_FLOAT[record.confidence],
          riskLevel: record.risk,
          proposedChange: (record.proposedState ?? {}) as unknown as Prisma.InputJsonValue,
          paramsHash: record.paramsHash,
          diagnosisId: record.diagnosisId,
          anomalyIds: record.anomalyIds as unknown as Prisma.InputJsonValue,
          currentState: record.currentState as unknown as Prisma.InputJsonValue,
          proposedState: record.proposedState as unknown as Prisma.InputJsonValue,
          preconditions: record.preconditions as unknown as Prisma.InputJsonValue,
          evidenceHash: record.evidence.evidenceHash,
          stateHash: record.stateHash,
          identityHash: record.identityHash,
          requiresApproval: true,
          staleReasons: (record.staleReasons ?? []) as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(record.expiresAt),
          createdAt: new Date(record.createdAt),
          approvedAt: record.approvalId ? new Date() : null,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // The only unique constraint an insert can violate here is the
        // partial active-identity index (the PK id is a fresh UUID).
        throw new DuplicateRecommendationError(record.identityHash);
      }
      throw err;
    }

    await this.prisma.auditLog.create({
      data: {
        userId: record.userId,
        toolId: ACTION_TO_DB[record.actionType],
        action: "recommendation.created",
        parameters: auditMetadata(record),
        result: "PENDING",
      },
    });
  }

  async findActiveByIdentity(identityHash: string): Promise<RecommendationRecord | null> {
    if (!identityHash) return null;
    const row = await this.prisma.performanceRecommendation.findFirst({
      where: { identityHash, status: { in: [...ACTIVE_DB_STATUSES] } },
      orderBy: { createdAt: "desc" },
    });
    return row ? toRecord(row) : null;
  }

  async findActiveByEntity(accountId: string, entityId: string): Promise<RecommendationRecord[]> {
    const rows = await this.prisma.performanceRecommendation.findMany({
      where: {
        accountId,
        targetId: entityId,
        status: { in: [...ACTIVE_DB_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map(toRecord);
  }

  async findMostRecentByActions(
    accountId: string,
    entityId: string,
    actionTypes: readonly RecommendationAction[]
  ): Promise<RecentActionRow | null> {
    if (actionTypes.length === 0) return null;
    const row = await this.prisma.performanceRecommendation.findFirst({
      where: {
        accountId,
        targetId: entityId,
        actionType: { in: actionTypes.map((a) => ACTION_TO_DB[a]) },
      },
      orderBy: { createdAt: "desc" },
    });
    return row ? { actionType: DB_TO_ACTION[row.actionType], createdAt: row.createdAt.toISOString() } : null;
  }

  async countBudgetActionsSince(accountId: string, sinceIso: string): Promise<number> {
    return this.prisma.performanceRecommendation.count({
      where: {
        accountId,
        actionType: { in: ["INCREASE_BUDGET", "DECREASE_BUDGET"] },
        createdAt: { gte: new Date(sinceIso) },
      },
    });
  }

  async get(id: string): Promise<RecommendationRecord | null> {
    const row = await this.prisma.performanceRecommendation.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  /** User-scoped read: IDOR-safe accessor for API surfaces. */
  async getForUser(id: string, userId: string): Promise<RecommendationRecord | null> {
    const row = await this.prisma.performanceRecommendation.findFirst({
      where: { id, userId },
    });
    return row ? toRecord(row) : null;
  }

  /**
   * Strict single-winner status transition. Conditional update over allowed
   * source statuses; the lifecycle map (canTransition) is enforced here so an
   * illegal edge (e.g. EXECUTED -> PROPOSED) can never reach the database
   * even from a buggy caller. Returns false when another caller won the race.
   */
  async transition(
    id: string,
    userId: string,
    fromStatuses: readonly RecommendationStatus[],
    to: RecommendationStatus,
    patch?: { approvalId?: string; executionId?: string; staleReasons?: string[] }
  ): Promise<boolean> {
    const legalSources = [...new Set(fromStatuses)].filter((s) => canTransition(s, to));
    if (legalSources.length === 0) return false;
    const now = new Date();
    const data: Record<string, unknown> = { status: to, updatedAt: now };
    if (to === "APPROVED") data.approvedAt = now;
    if (to === "REJECTED") data.rejectedAt = now;
    if (to === "EXECUTED") data.executedAt = now;
    if (patch?.approvalId) data.approvalId = patch.approvalId;
    if (patch?.executionId) data.executionId = patch.executionId;
    if (patch?.staleReasons) data.staleReasons = patch.staleReasons as unknown as Prisma.InputJsonValue;

    const result = await this.prisma.performanceRecommendation.updateMany({
      where: {
        id,
        userId,
        status: { in: legalSources },
      },
      data: data as never,
    });
    if (result.count !== 1) return false;

    await this.prisma.auditLog.create({
      data: {
        userId,
        action: `recommendation.${to.toLowerCase()}`,
        parameters: JSON.parse(
          redactSecrets(JSON.stringify({ recommendationId: id, from: legalSources, to }))
        ) as Prisma.InputJsonValue,
        result: to === "FAILED" ? "FAILURE" : "SUCCESS",
      },
    });
    return true;
  }

  /** Bulk TTL sweep: overdue PROPOSED/APPROVED rows become EXPIRED. */
  async expireOverdue(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.performanceRecommendation.updateMany({
      where: {
        status: { in: ["PROPOSED", "APPROVED"] },
        expiresAt: { lte: now },
      },
      data: { status: "EXPIRED", updatedAt: now },
    });
    return result.count;
  }

  /** Mark a recommendation STALE with machine-readable reasons. */
  async markStale(id: string, userId: string, reasons: string[]): Promise<boolean> {
    return this.transition(id, userId, ["PROPOSED", "APPROVED"], "STALE", { staleReasons: reasons });
  }

  /** Attach the approval + execution ids once they exist downstream. */
  async linkExecution(id: string, userId: string, approvalId: string, executionId: string): Promise<boolean> {
    const result = await this.prisma.performanceRecommendation.updateMany({
      where: { id, userId },
      data: { approvalId, executionId, updatedAt: new Date() },
    });
    return result.count === 1;
  }

  /** Convenience for API layers: list active proposals for one account. */
  async listByUser(
    userId: string,
    options?: { accountId?: string; status?: RecommendationStatus; limit?: number }
  ): Promise<{ items: RecommendationRecord[]; total: number }> {
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
    const where: Record<string, unknown> = { userId };
    if (options?.accountId) where.accountId = options.accountId;
    if (options?.status) where.status = options.status === "PROPOSED" ? { in: ["PROPOSED", "PENDING_APPROVAL"] } : options.status;
    const [rows, total] = await Promise.all([
      this.prisma.performanceRecommendation.findMany({
        where: where as never,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      this.prisma.performanceRecommendation.count({ where: where as never }),
    ]);
    return { items: rows.map(toRecord), total };
  }
}

/** Re-export for consumers building ExternalStatePort implementations. */
export type { ExternalEntityState };
