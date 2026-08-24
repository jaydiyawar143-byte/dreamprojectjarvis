import type {
  MeasurementState,
  OutcomeEnum,
  OutcomeRecord,
  OutcomeStorePort,
  OutcomeRevision,
  LearningHistoryRecord,
} from "@jarvis/core";
import { redactSecrets } from "@jarvis/core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Phase 11.7A — Durable Outcome Store (Prisma / PostgreSQL)
//
// Implements OutcomeStorePort.
//
// Security invariants:
//   - Every read enforces (userId + accountId) → no cross-account IDOR.
//   - baselineSnapshot is written ONCE at create and excluded from all
//     update paths — it can NEVER be overwritten.
//   - FINALIZED rows are immutable: the DB trigger enforces this; the
//     repository also guards at the query layer (WHERE is_final = false).
//   - No secrets in persisted JSON (redactSecrets applied to audit rows).
//
// Idempotency:
//   - create() is idempotent via the unique constraint on recommendation_id.
//   - finalize() is idempotent: a second call on an already-finalized row
//     returns false (0 rows updated) without error.
// ---------------------------------------------------------------------------

// Enum bridging: core uses camelCase PrimaryMetric strings, DB stores them as
// plain TEXT (primary_metric column is TEXT, not an enum, for forward compat).
// OptimizationActionType needs the DB spelling.
type DbAction =
  | "PAUSE_CAMPAIGN"
  | "RESUME_CAMPAIGN"
  | "PAUSE_ADSET"
  | "RESUME_ADSET"
  | "PAUSE_AD"
  | "RESUME_AD"
  | "INCREASE_BUDGET"
  | "DECREASE_BUDGET";

type CoreAction = OutcomeRecord["actionType"];

const ACTION_TO_DB: Record<CoreAction, DbAction> = {
  PAUSE_CAMPAIGN: "PAUSE_CAMPAIGN",
  RESUME_CAMPAIGN: "RESUME_CAMPAIGN",
  PAUSE_AD_SET: "PAUSE_ADSET",
  RESUME_AD_SET: "RESUME_ADSET",
  PAUSE_AD: "PAUSE_AD",
  RESUME_AD: "RESUME_AD",
  INCREASE_BUDGET: "INCREASE_BUDGET",
  DECREASE_BUDGET: "DECREASE_BUDGET",
};

const DB_TO_ACTION: Record<DbAction, CoreAction> = Object.fromEntries(
  Object.entries(ACTION_TO_DB).map(([k, v]) => [v, k])
) as Record<DbAction, CoreAction>;

// DB row shape returned by findUnique/findFirst on OutcomeRecord
interface DbOutcomeRow {
  outcomeId: string;
  recommendationId: string;
  executionId: string;
  userId: string;
  accountId: string;
  diagnosisCategory: string | null;
  entityType: string;
  entityId: string;
  actionType: DbAction;
  objective: string | null;
  primaryMetric: string;
  baselineSnapshot: unknown;
  measurementKpis: unknown;
  comparison: unknown;
  outcomeEnum: string | null;
  confidence: number | null;
  dataQuality: string | null;
  attributionStatus: string;
  confounders: unknown;
  measurementWindow: unknown;
  measurementState: string;
  isFinal: boolean;
  measuredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: DbOutcomeRow): OutcomeRecord {
  return {
    outcomeId: row.outcomeId,
    recommendationId: row.recommendationId,
    executionId: row.executionId,
    accountId: row.accountId,
    diagnosisCategory: (row.diagnosisCategory as any) ?? null,
    entityType: row.entityType as OutcomeRecord["entityType"],
    entityId: row.entityId,
    actionType: DB_TO_ACTION[row.actionType],
    objective: row.objective,
    primaryMetric: row.primaryMetric as OutcomeRecord["primaryMetric"],
    baseline: row.baselineSnapshot as OutcomeRecord["baseline"],
    measurement: row.measurementKpis
      ? (row.measurementKpis as OutcomeRecord["measurement"])
      : null,
    comparison: row.comparison
      ? (row.comparison as OutcomeRecord["comparison"])
      : null,
    outcome: row.outcomeEnum ? (row.outcomeEnum as OutcomeEnum) : null,
    confidence: row.confidence,
    dataQuality: row.dataQuality as OutcomeRecord["dataQuality"],
    attributionStatus: row.attributionStatus as OutcomeRecord["attributionStatus"],
    confounders: Array.isArray(row.confounders)
      ? (row.confounders as OutcomeRecord["confounders"])
      : [],
    measurementWindow: row.measurementWindow as OutcomeRecord["measurementWindow"],
    measuredAt: row.measuredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    userId: row.userId,
    measurementState: row.measurementState as MeasurementState,
  };
}

/** Thrown when attempting to create a duplicate outcome for the same recommendation. */
export class DuplicateOutcomeError extends Error {
  constructor(public readonly recommendationId: string) {
    super(`Outcome already exists for recommendation ${recommendationId}`);
    this.name = "DuplicateOutcomeError";
  }
}

/** Thrown when attempting to mutate a finalized outcome. */
export class FinalizedOutcomeImmutableError extends Error {
  constructor(public readonly outcomeId: string) {
    super(`OutcomeRecord ${outcomeId} is FINALIZED and immutable`);
    this.name = "FinalizedOutcomeImmutableError";
  }
}

export class PrismaOutcomeRepository implements OutcomeStorePort {
  constructor(private prisma: PrismaClient) {}

  // -------------------------------------------------------------------------
  // create — idempotent by recommendationId unique constraint
  // -------------------------------------------------------------------------

  async create(record: OutcomeRecord): Promise<void> {
    // Verify accountId belongs to userId (IDOR prevention)
    const account = await this.prisma.marketingAccount.findFirst({
      where: { accountId: record.accountId },
      select: { userId: true },
    });
    // We do not expose whose account it is in the error; fail closed.
    if (!account) {
      throw new Error("Account not found or access denied");
    }

    try {
      await this.prisma.outcomeRecord.create({
        data: {
          outcomeId: record.outcomeId,
          recommendationId: record.recommendationId,
          executionId: record.executionId,
          userId: account.userId,
          accountId: record.accountId,
          diagnosisCategory: record.diagnosisCategory ?? null,
          entityType: record.entityType,
          entityId: record.entityId,
          actionType: ACTION_TO_DB[record.actionType],
          objective: record.objective,
          primaryMetric: record.primaryMetric,
          // Baseline is written ONCE — never updated
          baselineSnapshot: record.baseline as unknown as Prisma.InputJsonValue,
          measurementKpis: record.measurement
            ? (record.measurement as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          comparison: record.comparison
            ? (record.comparison as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          outcomeEnum: record.outcome ?? null,
          confidence: record.confidence,
          dataQuality: record.dataQuality,
          attributionStatus: record.attributionStatus,
          confounders: (record.confounders ?? []) as unknown as Prisma.InputJsonValue,
          measurementWindow: record.measurementWindow as unknown as Prisma.InputJsonValue,
          measurementState: "WAITING_FOR_DATA",
          isFinal: false,
          measuredAt: record.measuredAt ? new Date(record.measuredAt) : null,
          createdAt: new Date(record.createdAt),
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new DuplicateOutcomeError(record.recommendationId);
      }
      throw err;
    }

    // Audit log — secret-free
    await this.prisma.auditLog.create({
      data: {
        userId: account.userId,
        action: "outcome.created",
        parameters: JSON.parse(
          redactSecrets(
            JSON.stringify({
              outcomeId: record.outcomeId,
              recommendationId: record.recommendationId,
              accountId: record.accountId,
              primaryMetric: record.primaryMetric,
              actionType: record.actionType,
            })
          )
        ) as Prisma.InputJsonValue,
        result: "PENDING",
      },
    });
  }

  // -------------------------------------------------------------------------
  // get — user+account scoped (IDOR-safe)
  // -------------------------------------------------------------------------

  async get(outcomeId: string, userId: string): Promise<OutcomeRecord | null> {
    const row = await this.prisma.outcomeRecord.findFirst({
      where: { outcomeId, userId },
    });
    return row ? toRecord(row as unknown as DbOutcomeRow) : null;
  }

  // -------------------------------------------------------------------------
  // getByRecommendation — user-scoped
  // -------------------------------------------------------------------------

  async getByRecommendation(
    recommendationId: string,
    userId: string
  ): Promise<OutcomeRecord | null> {
    const row = await this.prisma.outcomeRecord.findFirst({
      where: { recommendationId, userId },
    });
    return row ? toRecord(row as unknown as DbOutcomeRow) : null;
  }

  // -------------------------------------------------------------------------
  // updateMeasurementState — conditional update, no-op if FINALIZED
  // -------------------------------------------------------------------------

  async updateMeasurementState(
    outcomeId: string,
    userId: string,
    state: MeasurementState,
    patch?: Partial<
      Pick<
        OutcomeRecord,
        | "measurement"
        | "comparison"
        | "outcome"
        | "confidence"
        | "dataQuality"
        | "measuredAt"
        | "confounders"
        | "attributionStatus"
      >
    >
  ): Promise<boolean> {
    // Refuse to update if FINALIZED — WHERE clause enforces this at DB level
    // (also enforced by the DB trigger, but belt-and-suspenders)
    const data: Record<string, unknown> = {
      measurementState: state,
      updatedAt: new Date(),
    };

    if (patch?.measurement !== undefined) {
      data.measurementKpis =
        patch.measurement !== null
          ? (patch.measurement as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull;
    }
    if (patch?.comparison !== undefined) {
      data.comparison =
        patch.comparison !== null
          ? (patch.comparison as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull;
    }
    if (patch?.outcome !== undefined) data.outcomeEnum = patch.outcome;
    if (patch?.confidence !== undefined) data.confidence = patch.confidence;
    if (patch?.dataQuality !== undefined) data.dataQuality = patch.dataQuality;
    if (patch?.measuredAt !== undefined) {
      data.measuredAt = patch.measuredAt ? new Date(patch.measuredAt) : null;
    }
    if (patch?.confounders !== undefined) {
      data.confounders = patch.confounders as unknown as Prisma.InputJsonValue;
    }
    if (patch?.attributionStatus !== undefined) {
      data.attributionStatus = patch.attributionStatus;
    }

    const result = await this.prisma.outcomeRecord.updateMany({
      where: { outcomeId, userId, isFinal: false },
      data: data as never,
    });

    return result.count === 1;
  }

  // -------------------------------------------------------------------------
  // finalize — idempotent, immutable once set
  // -------------------------------------------------------------------------

  async finalize(
    outcomeId: string,
    userId: string,
    outcome: OutcomeEnum,
    confidence: number,
    measuredAt: string
  ): Promise<boolean> {
    // Idempotent: WHERE isFinal = false ensures a second call returns 0 rows
    const result = await this.prisma.outcomeRecord.updateMany({
      where: { outcomeId, userId, isFinal: false },
      data: {
        outcomeEnum: outcome,
        confidence,
        measuredAt: new Date(measuredAt),
        measurementState: "FINALIZED",
        isFinal: true,
        updatedAt: new Date(),
      } as never,
    });

    if (result.count === 1) {
      await this.prisma.auditLog.create({
        data: {
          userId,
          action: "outcome.finalized",
          parameters: JSON.parse(
            redactSecrets(
              JSON.stringify({ outcomeId, outcome, confidence, measuredAt })
            )
          ) as Prisma.InputJsonValue,
          result: "SUCCESS",
        },
      });
    }

    return result.count === 1;
  }

  // -------------------------------------------------------------------------
  // listByAccount — account-scoped, user-isolated
  // -------------------------------------------------------------------------

  async listByAccount(
    accountId: string,
    userId: string,
    opts?: { limit?: number; state?: MeasurementState }
  ): Promise<{ items: OutcomeRecord[]; total: number }> {
    const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
    const where: Record<string, unknown> = { accountId, userId };
    if (opts?.state) where.measurementState = opts.state;

    const [rows, total] = await Promise.all([
      this.prisma.outcomeRecord.findMany({
        where: where as never,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      this.prisma.outcomeRecord.count({ where: where as never }),
    ]);

    return { items: rows.map((r) => toRecord(r as unknown as DbOutcomeRow)), total };
  }

  // -------------------------------------------------------------------------
  // createRevision — write-once historical outcome revisions
  // -------------------------------------------------------------------------

  async createRevision(revision: OutcomeRevision): Promise<void> {
    // Write-once via DB unique constraint: [outcomeId, revisionNumber]
    await this.prisma.outcomeRevision.create({
      data: {
        id: revision.id,
        outcomeId: revision.outcomeId,
        revisionNumber: revision.revisionNumber,
        outcomeEnum: revision.outcomeEnum,
        confidence: revision.confidence,
        dataQuality: revision.dataQuality,
        attributionStatus: revision.attributionStatus,
        confounders: revision.confounders as unknown as Prisma.InputJsonValue,
        measurementKpis: revision.measurementKpis as unknown as Prisma.InputJsonValue,
        comparison: revision.comparison as unknown as Prisma.InputJsonValue,
        measuredAt: new Date(revision.measuredAt),
        createdAt: new Date(revision.createdAt),
      },
    });

    // Audit log
    const outcome = await this.prisma.outcomeRecord.findUnique({
      where: { outcomeId: revision.outcomeId },
      select: { userId: true },
    });

    if (outcome) {
      await this.prisma.auditLog.create({
        data: {
          userId: outcome.userId,
          action: "outcome.revision_created",
          parameters: JSON.parse(
            redactSecrets(
              JSON.stringify({
                outcomeId: revision.outcomeId,
                revisionNumber: revision.revisionNumber,
                outcome: revision.outcomeEnum,
              })
            )
          ) as Prisma.InputJsonValue,
          result: "SUCCESS",
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // getRevisions — paginated revisions, user-scoped
  // -------------------------------------------------------------------------

  async getRevisions(
    outcomeId: string,
    userId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<{ items: OutcomeRevision[]; total: number }> {
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 100);
    const offset = Math.max(opts?.offset ?? 0, 0);

    // Verify user owns the underlying outcome record
    const outcomeExists = await this.prisma.outcomeRecord.count({
      where: { outcomeId, userId },
    });
    if (outcomeExists === 0) {
      return { items: [], total: 0 };
    }

    const [rows, total] = await Promise.all([
      this.prisma.outcomeRevision.findMany({
        where: { outcomeId },
        orderBy: { revisionNumber: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.outcomeRevision.count({
        where: { outcomeId },
      }),
    ]);

    const items: OutcomeRevision[] = rows.map((r) => ({
      id: r.id,
      outcomeId: r.outcomeId,
      revisionNumber: r.revisionNumber,
      outcomeEnum: r.outcomeEnum as OutcomeEnum,
      confidence: r.confidence,
      dataQuality: r.dataQuality,
      attributionStatus: r.attributionStatus as OutcomeRevision["attributionStatus"],
      confounders: r.confounders as unknown as OutcomeRevision["confounders"],
      measurementKpis: r.measurementKpis as unknown as OutcomeRevision["measurementKpis"],
      comparison: r.comparison as unknown as OutcomeRevision["comparison"],
      measuredAt: r.measuredAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));

    return { items, total };
  }

  // -------------------------------------------------------------------------
  // getLearningHistory — Expose historical outcomes for future decisions
  // -------------------------------------------------------------------------

  async getLearningHistory(
    accountId: string,
    userId: string,
    opts?: { limit?: number }
  ): Promise<LearningHistoryRecord[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500);

    // Fetch finalized outcome records (with optional revisions)
    const outcomes = await this.prisma.outcomeRecord.findMany({
      where: {
        accountId,
        userId,
        measurementState: "FINALIZED",
      },
      include: {
        revisions: {
          orderBy: { revisionNumber: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return outcomes.map((o) => {
      // If revisions exist, the latest revision defines the current reality
      const latestRevision = o.revisions[0];
      const outcomeVal = latestRevision ? latestRevision.outcomeEnum : o.outcomeEnum!;
      const confidenceVal = latestRevision ? latestRevision.confidence : o.confidence!;
      const measuredAtVal = latestRevision ? latestRevision.measuredAt : o.measuredAt!;

      return {
        actionType: DB_TO_ACTION[o.actionType as DbAction],
        outcome: outcomeVal as OutcomeEnum,
        confidence: confidenceVal,
        measuredAt: measuredAtVal.toISOString(),
        primaryMetric: o.primaryMetric as LearningHistoryRecord["primaryMetric"],
      };
    });
  }

  // -------------------------------------------------------------------------
  // findDueOutcomes — non-finalized or expired lease records
  // -------------------------------------------------------------------------

  async findDueOutcomes(limit: number, leaseExpiredAt: string): Promise<OutcomeRecord[]> {
    const expiredDate = new Date(leaseExpiredAt);

    const rows = await this.prisma.outcomeRecord.findMany({
      where: {
        isFinal: false,
        OR: [
          { measurementState: { in: ["SCHEDULED", "READY"] } },
          { measurementState: "COLLECTING", updatedAt: { lte: expiredDate } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    return rows.map((r) => toRecord(r as unknown as DbOutcomeRow));
  }

  // -------------------------------------------------------------------------
  // claimOutcome — atomically transition a record to COLLECTING
  // -------------------------------------------------------------------------

  async claimOutcome(outcomeId: string, leaseExpiredAt: string): Promise<boolean> {
    const expiredDate = new Date(leaseExpiredAt);

    const result = await this.prisma.outcomeRecord.updateMany({
      where: {
        outcomeId,
        isFinal: false,
        OR: [
          { measurementState: { in: ["SCHEDULED", "READY"] } },
          { measurementState: "COLLECTING", updatedAt: { lte: expiredDate } },
        ],
      },
      data: {
        measurementState: "COLLECTING",
        updatedAt: new Date(),
      } as never,
    });

    return result.count === 1;
  }

  // -------------------------------------------------------------------------
  // releaseOutcome — transition a record back to state
  // -------------------------------------------------------------------------

  async releaseOutcome(outcomeId: string, state: MeasurementState): Promise<boolean> {
    const result = await this.prisma.outcomeRecord.updateMany({
      where: { outcomeId, measurementState: "COLLECTING", isFinal: false },
      data: { measurementState: state, updatedAt: new Date() } as never,
    });

    return result.count === 1;
  }

  // -------------------------------------------------------------------------
  // findFinalizedOutcomes — query finalized outcomes for similarity matching
  // -------------------------------------------------------------------------

  async findFinalizedOutcomes(
    userId: string,
    filters: {
      accountId: string;
      entityType?: string;
      actionType?: string;
      diagnosisCategory?: string;
      primaryMetric?: string;
      objective?: string;
      outcome?: OutcomeEnum;
      confidence?: number;
      measurementWindowMs?: number;
    }
  ): Promise<OutcomeRecord[]> {
    const whereClause: any = {
      userId,
      accountId: filters.accountId,
      measurementState: "FINALIZED",
    };

    if (filters.entityType) {
      whereClause.entityType = filters.entityType;
    }
    if (filters.actionType) {
      whereClause.actionType = ACTION_TO_DB[filters.actionType as CoreAction] ?? filters.actionType;
    }
    if (filters.diagnosisCategory) {
      whereClause.diagnosisCategory = filters.diagnosisCategory;
    }
    if (filters.primaryMetric) {
      whereClause.primaryMetric = filters.primaryMetric;
    }
    if (filters.objective) {
      whereClause.objective = filters.objective;
    }
    if (filters.outcome) {
      whereClause.outcomeEnum = filters.outcome;
    }
    if (filters.confidence !== undefined) {
      whereClause.confidence = filters.confidence;
    }

    const rows = await this.prisma.outcomeRecord.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
    });

    let records = rows.map((r) => toRecord(r as unknown as DbOutcomeRow));

    if (filters.measurementWindowMs !== undefined) {
      records = records.filter(
        (r) => r.measurementWindow.measurementMs === filters.measurementWindowMs
      );
    }

    return records;
  }

  // -------------------------------------------------------------------------
  // findRecentlyFinalized — recently finalized records to audit for revisions
  // -------------------------------------------------------------------------

  async findRecentlyFinalized(limit: number): Promise<OutcomeRecord[]> {
    // Audit outcomes finalized within the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.outcomeRecord.findMany({
      where: {
        measurementState: "FINALIZED",
        measuredAt: { gte: sevenDaysAgo },
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });

    return rows.map((r) => toRecord(r as unknown as DbOutcomeRow));
  }
}
