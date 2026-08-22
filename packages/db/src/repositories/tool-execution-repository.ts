import type {
  BeginExecutionInput,
  ClaimOptions,
  ExecutionErrorInfo,
  ReconciliationClaimOptions,
  ReconciliationDecision,
  RecoveryOptions,
  RecoveryResult,
} from "@jarvis/core";
import { DEFAULT_LEASE_MS } from "@jarvis/core";
import type { ExecutionJournalPort, ToolExecutionRecord } from "@jarvis/core";
import { redactSecrets } from "@jarvis/core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

interface ToolExecutionRow {
  executionId: string;
  userId: string;
  toolId: string;
  idempotencyKey: string;
  paramsHash: string | null;
  status:
    | "PENDING"
    | "APPROVED"
    | "EXECUTING"
    | "SUCCEEDED"
    | "FAILED"
    | "UNKNOWN"
    | "RECONCILING"
    | "SAFE_TO_RETRY"
    | "CANCELLED";
  provider: string | null;
  externalResourceId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  traceId: string | null;
  ownerId: string | null;
  leaseUntil: Date | null;
  heartbeatAt: Date | null;
  approvalId: string | null;
  reconciliationAttempts: number | null;
  lastReconciliationAt: Date | null;
  lastReconciliationResult: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

function toRecord(row: ToolExecutionRow): ToolExecutionRecord {
  return {
    executionId: row.executionId,
    userId: row.userId,
    toolId: row.toolId,
    idempotencyKey: row.idempotencyKey,
    paramsHash: row.paramsHash ?? undefined,
    status: row.status,
    provider: row.provider ?? undefined,
    externalResourceId: row.externalResourceId ?? undefined,
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    traceId: row.traceId ?? undefined,
    ownerId: row.ownerId ?? undefined,
    leaseUntil: row.leaseUntil ?? undefined,
    heartbeatAt: row.heartbeatAt ?? undefined,
    approvalId: row.approvalId ?? undefined,
    reconciliationAttempts: row.reconciliationAttempts ?? 0,
    lastReconciliationAt: row.lastReconciliationAt ?? undefined,
    lastReconciliationResult: row.lastReconciliationResult ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

/**
 * Phase 10.1 — PostgreSQL-backed execution journal.
 *
 * Implements ExecutionJournalPort with database-enforced idempotency:
 *  - begin() relies on the UNIQUE(user_id, tool_id, idempotency_key)
 *    constraint. Concurrent callers race on INSERT; the loser reads and
 *    returns the winner's row instead of creating a second execution.
 *  - claimForExecution()/mark*() are atomic conditional updates
 *    (updateMany ... WHERE status IN (...)); a transition applies only if
 *    the row is still in an allowed source state, so exactly one worker can
 *    claim PENDING -> EXECUTING.
 *
 * Secrets are redacted from error fields before persistence.
 */
export class PrismaToolExecutionRepository implements ExecutionJournalPort {
  constructor(private prisma: PrismaClient) {}

  async begin(input: BeginExecutionInput): Promise<ToolExecutionRecord> {
    try {
      const row = await this.prisma.toolExecution.create({
        data: {
          userId: input.userId,
          toolId: input.toolId,
          idempotencyKey: input.idempotencyKey,
          paramsHash: input.paramsHash ?? null,
          provider: input.provider ?? null,
          traceId: input.traceId ?? null,
          approvalId: input.approvalId ?? null,
          status: "PENDING",
        },
      });
      return toRecord(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;

      const existing = await this.prisma.toolExecution.findUnique({
        where: {
          userId_toolId_idempotencyKey: {
            userId: input.userId,
            toolId: input.toolId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing) return toRecord(existing);

      // The winning insert has not become visible yet (extremely rare);
      // surface a retryable conflict rather than fabricating state.
      throw new Prisma.PrismaClientKnownRequestError(
        "Concurrent execution journal insert conflict",
        { code: "P2002", clientVersion: Prisma.prismaVersion.client }
      );
    }
  }

  async claimForExecution(
    executionId: string,
    options?: ClaimOptions
  ): Promise<ToolExecutionRecord | null> {
    // FAILED -> EXECUTING is the explicit retry path (single-winner, exactly
    // like the PENDING|APPROVED claim). UNKNOWN/SUCCEEDED stay unclaimable.
    // The winner takes a durable lease: (owner_id, lease_until, heartbeat_at)
    // are written in the SAME atomic conditional update as the status change.
    const now = new Date();
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    const result = await this.prisma.toolExecution.updateMany({
      where: { executionId, status: { in: ["PENDING", "APPROVED", "FAILED"] } },
      data: {
        status: "EXECUTING",
        startedAt: now,
        ownerId: options?.ownerId ?? null,
        leaseUntil: new Date(now.getTime() + leaseMs),
        heartbeatAt: now,
      },
    });
    if (result.count === 0) return null;
    return this.getById(executionId);
  }

  async heartbeat(
    executionId: string,
    ownerId: string,
    leaseMs: number
  ): Promise<ToolExecutionRecord | null> {
    // Ownership-checked renewal: only the current EXECUTING owner may extend.
    const now = new Date();
    const result = await this.prisma.toolExecution.updateMany({
      where: { executionId, status: "EXECUTING", ownerId },
      data: {
        leaseUntil: new Date(now.getTime() + leaseMs),
        heartbeatAt: now,
      },
    });
    if (result.count === 0) return null;
    return this.getById(executionId);
  }

  async findStaleExecutions(
    options?: RecoveryOptions
  ): Promise<ToolExecutionRecord[]> {
    const now = options?.now ?? new Date();
    const rows = await this.prisma.toolExecution.findMany({
      where: {
        status: "EXECUTING",
        leaseUntil: { lt: now },
      },
      take: options?.batchSize,
      orderBy: { leaseUntil: "asc" },
    });
    return rows.map(toRecord);
  }

  async recoverStaleExecutions(
    options?: RecoveryOptions
  ): Promise<RecoveryResult> {
    // Idempotent by construction: markUnknown() is an atomic conditional
    // update (only applies while the row is still EXECUTING), so concurrent
    // or repeated invocations can never double-transition a record.
    //
    // A crashed worker's provider outcome is unknowable — the request may or
    // may not have been transmitted — so stale records map to UNKNOWN. They
    // are NEVER auto-converted to FAILED and NEVER re-executed; resolution
    // requires explicit reconciliation.
    const stale = await this.findStaleExecutions(options);
    const recovered: ToolExecutionRecord[] = [];
    for (const record of stale) {
      const done = await this.markUnknown(record.executionId, {
        code: "STALE_EXECUTION_RECOVERED",
        message:
          "Worker lease expired while EXECUTING; external outcome is uncertain and requires reconciliation",
      });
      if (done) recovered.push(done);
    }
    return { recovered };
  }

  async markSucceeded(
    executionId: string,
    externalResourceId?: string
  ): Promise<ToolExecutionRecord | null> {
    const result = await this.prisma.toolExecution.updateMany({
      where: { executionId, status: "EXECUTING" },
      data: {
        status: "SUCCEEDED",
        completedAt: new Date(),
        ownerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        ...(externalResourceId !== undefined
          ? { externalResourceId }
          : {}),
      },
    });
    if (result.count === 0) return null;
    return this.getById(executionId);
  }

  async markFailed(
    executionId: string,
    error?: ExecutionErrorInfo
  ): Promise<ToolExecutionRecord | null> {
    const result = await this.prisma.toolExecution.updateMany({
      where: { executionId, status: "EXECUTING" },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        ownerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        errorCode:
          error?.code !== undefined ? redactSecrets(error.code) : undefined,
        errorMessage:
          error?.message !== undefined ? redactSecrets(error.message) : undefined,
      },
    });
    if (result.count === 0) return null;
    return this.getById(executionId);
  }

  async markUnknown(
    executionId: string,
    error?: ExecutionErrorInfo
  ): Promise<ToolExecutionRecord | null> {
    const result = await this.prisma.toolExecution.updateMany({
      where: { executionId, status: "EXECUTING" },
      data: {
        status: "UNKNOWN",
        completedAt: new Date(),
        ownerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        errorCode:
          error?.code !== undefined ? redactSecrets(error.code) : undefined,
        errorMessage:
          error?.message !== undefined ? redactSecrets(error.message) : undefined,
      },
    });
    if (result.count === 0) return null;
    return this.getById(executionId);
  }

  async getById(executionId: string): Promise<ToolExecutionRecord | null> {
    const row = await this.prisma.toolExecution.findUnique({
      where: { executionId },
    });
    return row ? toRecord(row) : null;
  }

  /**
   * PHASE 10.7 — latest durable execution linked to an approval, so the
   * approval detail view can show whether/where the approved action ran.
   */
  async findLatestByApprovalId(
    approvalId: string
  ): Promise<ToolExecutionRecord | null> {
    const row = await this.prisma.toolExecution.findFirst({
      where: { approvalId },
      orderBy: { createdAt: "desc" },
    });
    return row ? toRecord(row) : null;
  }

  async findByIdempotentKey(
    userId: string,
    toolId: string,
    idempotencyKey: string
  ): Promise<ToolExecutionRecord | null> {
    const row = await this.prisma.toolExecution.findUnique({
      where: {
        userId_toolId_idempotencyKey: {
          userId,
          toolId,
          idempotencyKey,
        },
      },
    });
    return row ? toRecord(row) : null;
  }

  // -------------------------------------------------------------------------
  // Reconciliation (Phase 10.5)
  // -------------------------------------------------------------------------

  async claimForReconciliation(
    executionId: string,
    options?: ReconciliationClaimOptions
  ): Promise<ToolExecutionRecord | null> {
    // Atomic single-winner UNKNOWN -> RECONCILING with a durable lease.
    // Only UNKNOWN is claimable: SAFE_TO_RETRY/SUCCEEDED are resolved, and
    // stale RECONCILING rows first flow through recoverStaleReconciliations
    // (crash recovery) so there is exactly ONE canonical entry state.
    const now = new Date();
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    const result = await this.prisma.toolExecution.updateMany({
      where: { executionId, status: "UNKNOWN" },
      data: {
        status: "RECONCILING",
        ownerId: options?.ownerId ?? null,
        leaseUntil: new Date(now.getTime() + leaseMs),
        heartbeatAt: now,
      },
    });
    if (result.count === 0) return null;
    return this.getById(executionId);
  }

  async finalizeReconciliation(
    executionId: string,
    ownerId: string,
    decision: ReconciliationDecision
  ): Promise<ToolExecutionRecord | null> {
    // Ownership guard in the WHERE clause: a worker that lost its lease
    // (crash recovery reassigned it) can never finalize. The attempt counter
    // and last-outcome metadata advance in the same atomic update as the
    // terminal transition.
    const now = new Date();
    const current = await this.prisma.toolExecution.findUnique({
      where: { executionId },
      select: { reconciliationAttempts: true },
    });
    if (!current) return null;

    const terminal = decision.status !== "UNKNOWN";
    const result = await this.prisma.toolExecution.updateMany({
      where: { executionId, status: "RECONCILING", ownerId },
      data: {
        status: decision.status,
        completedAt: terminal ? now : undefined,
        ownerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        externalResourceId:
          decision.externalResourceId !== undefined
            ? decision.externalResourceId
            : undefined,
        errorCode:
          decision.error?.code !== undefined
            ? redactSecrets(decision.error.code)
            : undefined,
        errorMessage:
          decision.error?.message !== undefined
            ? redactSecrets(decision.error.message)
            : undefined,
        reconciliationAttempts: (current.reconciliationAttempts ?? 0) + 1,
        lastReconciliationAt: now,
        lastReconciliationResult: redactSecrets(decision.outcome),
      },
    });
    if (result.count === 0) return null;
    return this.getById(executionId);
  }

  async findStaleReconciliations(
    options?: RecoveryOptions
  ): Promise<ToolExecutionRecord[]> {
    const now = options?.now ?? new Date();
    const rows = await this.prisma.toolExecution.findMany({
      where: {
        status: "RECONCILING",
        leaseUntil: { lt: now },
      },
      take: options?.batchSize,
      orderBy: { leaseUntil: "asc" },
    });
    return rows.map(toRecord);
  }

  async recoverStaleReconciliations(
    options?: RecoveryOptions
  ): Promise<RecoveryResult> {
    // Idempotent crash recovery: stale RECONCILING -> UNKNOWN via atomic
    // conditional update. NEVER FAILED, never retried automatically — the
    // execution simply becomes reconciliation-eligible again.
    const stale = await this.findStaleReconciliations(options);
    const recovered: ToolExecutionRecord[] = [];
    for (const record of stale) {
      const result = await this.prisma.toolExecution.updateMany({
        where: { executionId: record.executionId, status: "RECONCILING" },
        data: {
          status: "UNKNOWN",
          completedAt: new Date(),
          ownerId: null,
          leaseUntil: null,
          heartbeatAt: null,
          errorCode: "RECONCILIATION_LEASE_EXPIRED",
          errorMessage:
            "Worker lease expired while RECONCILING; outcome remains uncertain and requires reconciliation",
        },
      });
      if (result.count > 0) {
        const done = await this.getById(record.executionId);
        if (done) recovered.push(done);
      }
    }
    return { recovered };
  }
}
