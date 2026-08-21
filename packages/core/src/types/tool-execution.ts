// ---------------------------------------------------------------------------
// Execution Journal — durable, database-enforced execution lifecycle (Phase 10.1)
// ---------------------------------------------------------------------------
// One authoritative record per (userId, toolId, idempotencyKey). The database
// unique constraint arbitrates concurrent attempts; JavaScript maps, singletons
// and process-local mutexes must never be the source of truth.
// ---------------------------------------------------------------------------

export const EXECUTION_JOURNAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "EXECUTING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
  "RECONCILING",
  "CANCELLED",
] as const;

export type ExecutionJournalStatus = (typeof EXECUTION_JOURNAL_STATUSES)[number];

/**
 * UNKNOWN means the external provider may have executed the side effect but
 * the outcome is uncertain (e.g. timeout after transmission). An UNKNOWN
 * execution must NEVER be automatically converted to FAILED and must NEVER
 * be retried automatically — resolution requires reconciliation.
 */
export const AMBIGUOUS_STATUSES: ReadonlySet<ExecutionJournalStatus> = new Set([
  "UNKNOWN",
  "RECONCILING",
]);

/** States that block a new execution attempt for reversible actions. */
export const BLOCKED_STATUSES: ReadonlySet<ExecutionJournalStatus> = new Set([
  "EXECUTING",
  "UNKNOWN",
  "RECONCILING",
  "CANCELLED",
]);

/**
 * States that block a new execution attempt even for normally re-runnable
 * actions. Used by creation-type tools where a completed execution must never
 * run again (duplicate resource risk).
 */
export const CREATE_BLOCKED_STATUSES: ReadonlySet<ExecutionJournalStatus> = new Set([
  ...BLOCKED_STATUSES,
  "SUCCEEDED",
]);

/**
 * Allowed transitions of the journal state machine. Transitions are enforced
 * atomically via conditional updates — a transition is valid only if the row
 * is still in one of the listed source states at update time.
 *
 *   PENDING   -> EXECUTING            (claim: exactly one worker wins)
 *   APPROVED  -> EXECUTING            (claim after future approval wiring)
 *   FAILED    -> EXECUTING            (explicit retry re-claims the record;
 *                                      still single-winner, never automatic)
 *   EXECUTING -> SUCCEEDED | FAILED | UNKNOWN
 *
 * UNKNOWN is terminal until reconciliation (future phase) resolves it.
 * SUCCEEDED is terminal: a new execution attempt for a creation-type tool is
 * blocked via CREATE_BLOCKED_STATUSES; reversible tools re-check live state
 * and return an idempotent result instead of claiming again.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<ExecutionJournalStatus, readonly ExecutionJournalStatus[]>
> = {
  PENDING: ["EXECUTING", "APPROVED", "CANCELLED"],
  APPROVED: ["EXECUTING", "CANCELLED"],
  EXECUTING: ["SUCCEEDED", "FAILED", "UNKNOWN", "RECONCILING"],
  SUCCEEDED: [],
  FAILED: ["EXECUTING"],
  UNKNOWN: ["RECONCILING", "FAILED", "SUCCEEDED"],
  RECONCILING: ["SUCCEEDED", "FAILED", "UNKNOWN"],
  CANCELLED: [],
};

export interface ToolExecutionRecord {
  executionId: string;
  userId: string;
  toolId: string;
  idempotencyKey: string;
  paramsHash?: string;
  status: ExecutionJournalStatus;
  provider?: string;
  externalResourceId?: string;
  errorCode?: string;
  errorMessage?: string;
  traceId?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  /** Durable lease ownership (Phase 10.2). Identifies the worker that holds the claim. */
  ownerId?: string;
  /** Lease expiry. A live worker renews it via heartbeat(); expiry makes the
   *  record eligible for STALE RECOVERY (-> UNKNOWN), NEVER for takeover or
   *  automatic re-execution. */
  leaseUntil?: Date;
  heartbeatAt?: Date;
  /** One-time approval consumed to authorize this execution (Phase 10.3).
   *  Stamped at begin() and re-stamped by atomic consumption; provides the
   *  durable approval <-> execution audit linkage. */
  approvalId?: string;
}

export interface BeginExecutionInput {
  userId: string;
  toolId: string;
  idempotencyKey: string;
  paramsHash?: string;
  provider?: string;
  traceId?: string;
  approvalId?: string;
}

/** Options for claimForExecution(): durable single-winner ownership. */
export interface ClaimOptions {
  /** Identity of the claiming worker/attempt (e.g. process id + uuid). */
  ownerId?: string;
  /** Lease duration in milliseconds. Must outlive the longest expected
   *  provider call; renew with heartbeat() for long-running work. */
  leaseMs?: number;
}

/** Default lease duration: comfortably above any provider timeout (30s). */
export const DEFAULT_LEASE_MS = 300_000;

export interface StaleScanOptions {
  /** Evaluation clock; defaults to now. Inject a future time in tests. */
  now?: Date;
}

export interface RecoveryOptions extends StaleScanOptions {
  /** Maximum records recovered per invocation. */
  batchSize?: number;
}

export interface RecoveryResult {
  /** Records transitioned EXECUTING -> UNKNOWN by this invocation. */
  recovered: ToolExecutionRecord[];
}

export interface ExecutionErrorInfo {
  code?: string;
  message?: string;
}

/**
 * Port implemented by durable stores (e.g. PrismaToolExecutionRepository).
 * Concurrency contract:
 *  - begin(): insert-or-get. Concurrent callers with the same
 *    (userId, toolId, idempotencyKey) converge on ONE record.
 *  - claimForExecution(): atomic PENDING|APPROVED|FAILED -> EXECUTING with
 *    durable lease ownership. Exactly one concurrent caller receives a
 *    record; all others receive null.
 *  - heartbeat(): renews the lease ONLY for the current EXECUTING owner.
 *  - findStaleExecutions()/recoverStaleExecutions(): deterministic, idempotent
 *    crash recovery. Stale = status EXECUTING with expired lease. Recovery
 *    maps stale records to UNKNOWN (outcome uncertain) — never FAILED,
 *    never re-executed.
 */
export interface ExecutionJournalPort {
  begin(input: BeginExecutionInput): Promise<ToolExecutionRecord>;
  claimForExecution(
    executionId: string,
    options?: ClaimOptions
  ): Promise<ToolExecutionRecord | null>;
  /** Renew the caller's lease. Returns null unless the caller still owns an
   *  EXECUTING record (ownership check is atomic). */
  heartbeat(
    executionId: string,
    ownerId: string,
    leaseMs: number
  ): Promise<ToolExecutionRecord | null>;
  /** All EXECUTING records whose lease has expired (crash candidates). */
  findStaleExecutions(options?: StaleScanOptions): Promise<ToolExecutionRecord[]>;
  /** Idempotent recovery: stale EXECUTING -> UNKNOWN. Running twice yields no
   *  additional work; concurrent invocations never double-transition a row. */
  recoverStaleExecutions(options?: RecoveryOptions): Promise<RecoveryResult>;
  markSucceeded(
    executionId: string,
    externalResourceId?: string
  ): Promise<ToolExecutionRecord | null>;
  markFailed(
    executionId: string,
    error?: ExecutionErrorInfo
  ): Promise<ToolExecutionRecord | null>;
  markUnknown(
    executionId: string,
    error?: ExecutionErrorInfo
  ): Promise<ToolExecutionRecord | null>;
  getById(executionId: string): Promise<ToolExecutionRecord | null>;
  findByIdempotentKey(
    userId: string,
    toolId: string,
    idempotencyKey: string
  ): Promise<ToolExecutionRecord | null>;
}
