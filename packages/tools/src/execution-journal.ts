import type {
  BeginExecutionInput,
  ExecutionErrorInfo,
  ExecutionJournalPort,
  ExecutionJournalStatus,
  ToolExecutionRecord,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// isAmbiguousWriteError — transport-level failures where the request may
// already have been transmitted to the provider. Such errors leave the
// external outcome uncertain and must map the execution to UNKNOWN.
// Deterministic rejections (plain Error, HTTP 4xx bodies surfaced as errors)
// remain ordinary FAILED outcomes.
// ---------------------------------------------------------------------------

const AMBIGUOUS_ERROR_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed?\s*out/i,
  /abort/i,
  /econn(aborted|reset|refused)/i,
  /socket\s*hang\s*up/i,
  /network\s*(error|request\s*failed)/i,
  /fetch\s*failed/i,
];

export function isAmbiguousWriteError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  const haystack = `${name} ${message}`;
  return AMBIGUOUS_ERROR_PATTERNS.some((p) => p.test(haystack));
}

/**
 * In-memory ExecutionJournalPort implementation.
 *
 * Faithful to the durable contract (composite uniqueness, single-winner
 * claims, strict transitions). It exists ONLY as a default for unit tests and
 * as a reference semantics document. Production wiring MUST inject a durable
 * store (PrismaToolExecutionRepository); no production code may rely on this
 * class for idempotency.
 *
 * Atomicity note: claim/transition checks and writes happen synchronously in
 * one microtask section — JavaScript's single thread guarantees exactly one
 * winner even under Promise.all.
 */
export class MemoryExecutionJournal implements ExecutionJournalPort {
  private readonly rows = new Map<string, ToolExecutionRecord>();

  private static composite(
    userId: string,
    toolId: string,
    idempotencyKey: string
  ): string {
    return `${userId}::${toolId}::${idempotencyKey}`;
  }

  async begin(input: BeginExecutionInput): Promise<ToolExecutionRecord> {
    const key = MemoryExecutionJournal.composite(
      input.userId,
      input.toolId,
      input.idempotencyKey
    );
    const existing = this.rows.get(key);
    if (existing) return existing;

    const record: ToolExecutionRecord = {
      executionId: crypto.randomUUID(),
      userId: input.userId,
      toolId: input.toolId,
      idempotencyKey: input.idempotencyKey,
      paramsHash: input.paramsHash,
      status: "PENDING",
      provider: input.provider,
      traceId: input.traceId,
      createdAt: new Date(),
    };
    this.rows.set(key, record);
    return record;
  }

  async claimForExecution(executionId: string): Promise<ToolExecutionRecord | null> {
    const record = this.findAndTransition(executionId, ["PENDING", "APPROVED"], "EXECUTING");
    if (record && !record.startedAt) record.startedAt = new Date();
    return record;
  }

  async markSucceeded(
    executionId: string,
    externalResourceId?: string
  ): Promise<ToolExecutionRecord | null> {
    const record = this.findAndTransition(executionId, ["EXECUTING"], "SUCCEEDED");
    if (record) {
      record.completedAt = new Date();
      if (externalResourceId !== undefined) record.externalResourceId = externalResourceId;
    }
    return record;
  }

  async markFailed(
    executionId: string,
    error?: ExecutionErrorInfo
  ): Promise<ToolExecutionRecord | null> {
    const record = this.findAndTransition(executionId, ["EXECUTING"], "FAILED");
    if (record) {
      record.completedAt = new Date();
      record.errorCode = error?.code;
      record.errorMessage = error?.message;
    }
    return record;
  }

  async markUnknown(
    executionId: string,
    error?: ExecutionErrorInfo
  ): Promise<ToolExecutionRecord | null> {
    const record = this.findAndTransition(executionId, ["EXECUTING"], "UNKNOWN");
    if (record) {
      record.completedAt = new Date();
      record.errorCode = error?.code;
      record.errorMessage = error?.message;
    }
    return record;
  }

  async getById(executionId: string): Promise<ToolExecutionRecord | null> {
    for (const record of this.rows.values()) {
      if (record.executionId === executionId) return record;
    }
    return null;
  }

  async findByIdempotentKey(
    userId: string,
    toolId: string,
    idempotencyKey: string
  ): Promise<ToolExecutionRecord | null> {
    return (
      this.rows.get(MemoryExecutionJournal.composite(userId, toolId, idempotencyKey)) ??
      null
    );
  }

  /** Legacy/test seam: first record matching a raw idempotency key (any user/tool). */
  findByAnyKey(idempotencyKey: string): ToolExecutionRecord | null {
    for (const record of this.rows.values()) {
      if (record.idempotencyKey === idempotencyKey) return record;
    }
    return null;
  }

  clear(): void {
    this.rows.clear();
  }

  size(): number {
    return this.rows.size;
  }

  private findAndTransition(
    executionId: string,
    from: readonly ExecutionJournalStatus[],
    to: ExecutionJournalStatus
  ): ToolExecutionRecord | null {
    for (const record of this.rows.values()) {
      if (record.executionId !== executionId) continue;
      if (!from.includes(record.status)) return null;
      // Synchronous check-and-set: atomic within the event loop tick.
      record.status = to;
      return record;
    }
    return null;
  }
}
