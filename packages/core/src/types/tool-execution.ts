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
 *   EXECUTING -> SUCCEEDED | FAILED | UNKNOWN
 *
 * UNKNOWN is terminal until reconciliation (future phase) resolves it.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<ExecutionJournalStatus, readonly ExecutionJournalStatus[]>
> = {
  PENDING: ["EXECUTING", "APPROVED", "CANCELLED"],
  APPROVED: ["EXECUTING", "CANCELLED"],
  EXECUTING: ["SUCCEEDED", "FAILED", "UNKNOWN", "RECONCILING"],
  SUCCEEDED: [],
  FAILED: [],
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
}

export interface BeginExecutionInput {
  userId: string;
  toolId: string;
  idempotencyKey: string;
  paramsHash?: string;
  provider?: string;
  traceId?: string;
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
 *  - claimForExecution(): atomic PENDING|APPROVED -> EXECUTING. Exactly one
 *    concurrent caller receives a record; all others receive null.
 */
export interface ExecutionJournalPort {
  begin(input: BeginExecutionInput): Promise<ToolExecutionRecord>;
  claimForExecution(executionId: string): Promise<ToolExecutionRecord | null>;
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
