import type {
  ApprovalConsumptionInput,
  ApprovalConsumptionResult,
  BeginExecutionInput,
  ClaimOptions,
  ExecutionErrorInfo,
  ExecutionJournalPort,
  ExecutionJournalStatus,
  ReconciliationClaimOptions,
  ReconciliationDecision,
  RecoveryOptions,
  RecoveryResult,
  ToolExecutionRecord,
} from "@jarvis/core";
import { DEFAULT_LEASE_MS } from "@jarvis/core";

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

// ---------------------------------------------------------------------------
// classifyWriteOutcome — Phase 10.4 timeout/abort classification
// ---------------------------------------------------------------------------
// Maps a provider-layer failure to the journal state it may safely produce:
//
//   A/B  request never transmitted / cancelled before any external side
//        effect                          -> FAILED (safe, known outcome)
//   C    explicit provider failure (4xx) -> FAILED
//   D/E  network timeout after transmission, connection drop, in-flight
//        abort of a write request        -> UNKNOWN (outcome uncertain)
//   F    explicit provider success       -> SUCCEEDED (no error reaches here)
//
// The transport layer (meta-graph MetaRequestAbortedError) reports whether
// the request had been transmitted and whether a side effect was possible;
// everything else falls back to conservative pattern matching where ANY
// ambiguity maps to UNKNOWN — never to an ordinary FAILED retry loop.
// ---------------------------------------------------------------------------

/** Stable journal error codes recorded for timeout/abort outcomes. */
export const TIMEOUT_ERROR_CODES = {
  /** Abort fired before the HTTP request was transmitted — no side effect possible. */
  CANCELLED_BEFORE_SEND: "CANCELLED_BEFORE_SEND",
  /** Request cancelled but provably side-effect-free (e.g. GET verification read). */
  REQUEST_CANCELLED: "REQUEST_CANCELLED",
  /** Ambiguous outcome — the write may have executed; requires reconciliation. */
  AMBIGUOUS_OUTCOME: "AMBIGUOUS_OUTCOME",
} as const;

/**
 * Shape of the typed transport error thrown by @jarvis/meta-graph's HTTP
 * client on abort/timeout. Declared structurally so this package does NOT
 * depend on meta-graph (dependency direction: meta-graph -> tools).
 */
interface TransportAbortShape {
  name: string;
  phase?: "before-send" | "in-flight";
  sideEffectPossible?: boolean;
}

function isTransportAbort(err: unknown): err is TransportAbortShape & Error {
  return err instanceof Error && err.name === "MetaRequestAbortedError";
}

export type WriteOutcomeClassification =
  | { kind: "ambiguous"; status: "UNKNOWN"; code: typeof TIMEOUT_ERROR_CODES.AMBIGUOUS_OUTCOME }
  | { kind: "cancelled-before-send"; status: "FAILED"; code: typeof TIMEOUT_ERROR_CODES.CANCELLED_BEFORE_SEND }
  | { kind: "cancelled-no-side-effect"; status: "FAILED"; code: typeof TIMEOUT_ERROR_CODES.REQUEST_CANCELLED }
  | { kind: "known-failure"; status: "FAILED"; code: "EXECUTION_ERROR" };

export function classifyWriteOutcome(err: unknown): WriteOutcomeClassification {
  if (isTransportAbort(err)) {
    if (err.phase === "before-send") {
      return { kind: "cancelled-before-send", status: "FAILED", code: TIMEOUT_ERROR_CODES.CANCELLED_BEFORE_SEND };
    }
    if (err.sideEffectPossible === false) {
      return { kind: "cancelled-no-side-effect", status: "FAILED", code: TIMEOUT_ERROR_CODES.REQUEST_CANCELLED };
    }
    // Aborted in flight on a potentially side-effecting request: even though
    // the signal cancelled the socket, the server may already have applied
    // the write. Outcome is uncertain -> UNKNOWN, never auto-retryable FAILED.
    return { kind: "ambiguous", status: "UNKNOWN", code: TIMEOUT_ERROR_CODES.AMBIGUOUS_OUTCOME };
  }
  if (isAmbiguousWriteError(err)) {
    return { kind: "ambiguous", status: "UNKNOWN", code: TIMEOUT_ERROR_CODES.AMBIGUOUS_OUTCOME };
  }
  return { kind: "known-failure", status: "FAILED", code: "EXECUTION_ERROR" };
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
      approvalId: input.approvalId,
      createdAt: new Date(),
    };
    this.rows.set(key, record);
    return record;
  }

  async claimForExecution(
    executionId: string,
    options?: ClaimOptions
  ): Promise<ToolExecutionRecord | null> {
    // FAILED -> EXECUTING is the explicit retry path (single-winner, exactly
    // like the PENDING|APPROVED claim). UNKNOWN/SUCCEEDED stay unclaimable.
    // The winner takes a durable lease in the same atomic transition.
    const now = new Date();
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    const record = this.findAndTransition(
      executionId,
      ["PENDING", "APPROVED", "FAILED"],
      "EXECUTING"
    );
    if (record) {
      record.startedAt = now;
      record.ownerId = options?.ownerId;
      record.heartbeatAt = now;
      record.leaseUntil = new Date(now.getTime() + leaseMs);
    }
    return record;
  }

  async heartbeat(
    executionId: string,
    ownerId: string,
    leaseMs: number
  ): Promise<ToolExecutionRecord | null> {
    // Ownership-checked renewal: only the current EXECUTING owner may extend.
    for (const record of this.rows.values()) {
      if (record.executionId !== executionId) continue;
      if (record.status !== "EXECUTING" || record.ownerId !== ownerId) return null;
      const now = new Date();
      record.heartbeatAt = now;
      record.leaseUntil = new Date(now.getTime() + leaseMs);
      return record;
    }
    return null;
  }

  async findStaleExecutions(
    options?: RecoveryOptions
  ): Promise<ToolExecutionRecord[]> {
    const now = options?.now ?? new Date();
    const stale = [...this.rows.values()]
      .filter(
        (r) =>
          r.status === "EXECUTING" &&
          r.leaseUntil !== undefined &&
          r.leaseUntil.getTime() < now.getTime()
      )
      .sort(
        (a, b) => (a.leaseUntil?.getTime() ?? 0) - (b.leaseUntil?.getTime() ?? 0)
      );
    return options?.batchSize !== undefined ? stale.slice(0, options.batchSize) : stale;
  }

  async recoverStaleExecutions(
    options?: RecoveryOptions
  ): Promise<RecoveryResult> {
    // Idempotent by construction: markUnknown() only applies while the row is
    // still EXECUTING, so repeated or concurrent invocations can never
    // double-transition a record.
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
    const record = this.findAndTransition(executionId, ["EXECUTING"], "SUCCEEDED");
    if (record) {
      record.completedAt = new Date();
      if (externalResourceId !== undefined) record.externalResourceId = externalResourceId;
      this.clearLease(record);
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
      this.clearLease(record);
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
      this.clearLease(record);
    }
    return record;
  }

  private clearLease(record: ToolExecutionRecord): void {
    record.ownerId = undefined;
    record.leaseUntil = undefined;
    record.heartbeatAt = undefined;
  }

  async getById(executionId: string): Promise<ToolExecutionRecord | null> {
    for (const record of this.rows.values()) {
      if (record.executionId === executionId) return record;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Reconciliation (Phase 10.5) — reference semantics
  // -------------------------------------------------------------------------

  async claimForReconciliation(
    executionId: string,
    options?: ReconciliationClaimOptions
  ): Promise<ToolExecutionRecord | null> {
    // Atomic single-winner UNKNOWN -> RECONCILING with a durable lease.
    const now = new Date();
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    const record = this.findAndTransition(executionId, ["UNKNOWN"], "RECONCILING");
    if (record) {
      record.ownerId = options?.ownerId;
      record.heartbeatAt = now;
      record.leaseUntil = new Date(now.getTime() + leaseMs);
    }
    return record;
  }

  async finalizeReconciliation(
    executionId: string,
    ownerId: string,
    decision: ReconciliationDecision
  ): Promise<ToolExecutionRecord | null> {
    // Ownership-guarded: only the current RECONCILING owner may finalize.
    for (const record of this.rows.values()) {
      if (record.executionId !== executionId) continue;
      if (record.status !== "RECONCILING" || record.ownerId !== ownerId) return null;
      const now = new Date();
      record.status = decision.status;
      if (decision.externalResourceId !== undefined) {
        record.externalResourceId = decision.externalResourceId;
      }
      if (decision.error?.code !== undefined) record.errorCode = decision.error.code;
      if (decision.error?.message !== undefined) record.errorMessage = decision.error.message;
      record.reconciliationAttempts = (record.reconciliationAttempts ?? 0) + 1;
      record.lastReconciliationAt = now;
      record.lastReconciliationResult = decision.outcome;
      if (decision.status !== "UNKNOWN") {
        // Terminal resolution (SUCCEEDED / SAFE_TO_RETRY).
        record.completedAt = now;
      }
      // UNKNOWN finalizations drop the lease immediately: the record is
      // eligible for another reconciliation attempt right away.
      this.clearLease(record);
      return record;
    }
    return null;
  }

  async findStaleReconciliations(
    options?: RecoveryOptions
  ): Promise<ToolExecutionRecord[]> {
    const now = options?.now ?? new Date();
    const stale = [...this.rows.values()]
      .filter(
        (r) =>
          r.status === "RECONCILING" &&
          r.leaseUntil !== undefined &&
          r.leaseUntil.getTime() < now.getTime()
      )
      .sort(
        (a, b) => (a.leaseUntil?.getTime() ?? 0) - (b.leaseUntil?.getTime() ?? 0)
      );
    return options?.batchSize !== undefined ? stale.slice(0, options.batchSize) : stale;
  }

  async recoverStaleReconciliations(
    options?: RecoveryOptions
  ): Promise<RecoveryResult> {
    // Idempotent by construction: the conditional transition only applies
    // while the row is still RECONCILING. Stale claims map back to UNKNOWN —
    // NEVER FAILED, never retried automatically.
    const stale = await this.findStaleReconciliations(options);
    const recovered: ToolExecutionRecord[] = [];
    for (const record of stale) {
      const done = this.transitionIfStatus(record.executionId, "RECONCILING", "UNKNOWN");
      if (!done) continue;
      done.completedAt = new Date();
      done.errorCode = "RECONCILIATION_LEASE_EXPIRED";
      done.errorMessage =
        "Worker lease expired while RECONCILING; outcome remains uncertain and requires reconciliation";
      this.clearLease(done);
      recovered.push(done);
    }
    return { recovered };
  }

  private transitionIfStatus(
    executionId: string,
    from: ExecutionJournalStatus,
    to: ExecutionJournalStatus
  ): ToolExecutionRecord | null {
    for (const record of this.rows.values()) {
      if (record.executionId !== executionId) continue;
      if (record.status !== from) return null;
      record.status = to;
      return record;
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

// ---------------------------------------------------------------------------
// withSafeTerminalTransitions — DB-failure containment (Phase 10.2)
// ---------------------------------------------------------------------------
// If the journal becomes unreachable AFTER a claim, terminal transitions
// (markSucceeded/markFailed/markUnknown) may fail. Such failures must NEVER
// escape into tool result handling: doing so could invite callers to retry a
// possibly-transmitted external write. Instead the transition failure is
// contained; the record remains EXECUTING (lease expires) and the stale-
// recovery pass maps it to UNKNOWN. begin()/claimForExecution() failures DO
// propagate — no ownership was taken, so failing loudly is safe.
// ---------------------------------------------------------------------------

export function withSafeTerminalTransitions(
  journal: ExecutionJournalPort
): ExecutionJournalPort {
  const swallow = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch {
      // Journal unavailable post-claim. Record stays EXECUTING until the
      // durable stale-execution recovery classifies it as UNKNOWN.
      return null;
    }
  };
  return {
    begin: (input) => journal.begin(input),
    claimForExecution: (executionId, options) =>
      journal.claimForExecution(executionId, options),
    heartbeat: (executionId, ownerId, leaseMs) =>
      journal.heartbeat(executionId, ownerId, leaseMs),
    findStaleExecutions: (options) => journal.findStaleExecutions(options),
    recoverStaleExecutions: (options) => journal.recoverStaleExecutions(options),
    getById: (executionId) => journal.getById(executionId),
    findByIdempotentKey: (userId, toolId, idempotencyKey) =>
      journal.findByIdempotentKey(userId, toolId, idempotencyKey),
    claimForReconciliation: (executionId, options) =>
      journal.claimForReconciliation(executionId, options),
    findStaleReconciliations: (options) =>
      journal.findStaleReconciliations(options),
    recoverStaleReconciliations: (options) =>
      journal.recoverStaleReconciliations(options),
    // Journal unavailable mid-reconciliation: the record stays RECONCILING
    // until lease expiry maps it back to UNKNOWN (eligible again). Finalize
    // failures must never escape — a lost finalization is recovered, not
    // retried against the provider.
    finalizeReconciliation: (executionId, ownerId, decision) =>
      swallow(journal.finalizeReconciliation(executionId, ownerId, decision)),
    markSucceeded: (executionId, externalResourceId) =>
      swallow(journal.markSucceeded(executionId, externalResourceId)),
    markFailed: (executionId, error) =>
      swallow(journal.markFailed(executionId, error)),
    markUnknown: (executionId, error) =>
      swallow(journal.markUnknown(executionId, error)),
  };
}

// ---------------------------------------------------------------------------
// MemoryApprovalConsumer — reference IApprovalConsumptionPort (Phase 10.3)
// ---------------------------------------------------------------------------
// Mirrors the durable semantics of PrismaApprovalRepository.consumeForExecution:
// verifies approval id + user + tool + paramsHash + APPROVED state + expiry,
// burns the approval (CONSUMED is terminal) and claims the execution in one
// atomic step. JavaScript's single thread makes the check-then-write section
// indivisible; production MUST inject the PostgreSQL implementation.
// ---------------------------------------------------------------------------

export interface MemoryApprovalRecord {
  id: string;
  userId: string;
  toolId: string;
  paramsHash?: string;
  status: "pending" | "approved" | "consumed" | "rejected" | "expired";
  expiresAt: string;
  resolvedAt?: string | null;
}

export class MemoryApprovalConsumer {
  private readonly approvals = new Map<string, MemoryApprovalRecord>();

  constructor(private readonly journal: ExecutionJournalPort) {}

  create(input: Omit<MemoryApprovalRecord, "id"> & { id?: string }): MemoryApprovalRecord {
    const rec: MemoryApprovalRecord = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
    };
    this.approvals.set(rec.id, rec);
    return rec;
  }

  get(id: string): MemoryApprovalRecord | undefined {
    return this.approvals.get(id);
  }

  /** Terminal-state guard: CONSUMED can never be resurrected. */
  setStatus(id: string, status: MemoryApprovalRecord["status"]): boolean {
    const rec = this.approvals.get(id);
    if (!rec || rec.status === "consumed") return false;
    rec.status = status;
    if (status !== "pending") rec.resolvedAt = new Date().toISOString();
    return true;
  }

  async consumeForExecution(
    input: ApprovalConsumptionInput
  ): Promise<ApprovalConsumptionResult> {
    const rec = this.approvals.get(input.approvalId);
    if (!rec) return { ok: false, reason: "approval not found" };
    if (rec.userId !== input.userId) {
      return { ok: false, reason: "approval belongs to a different user" };
    }
    if (rec.toolId !== input.toolId) {
      return { ok: false, reason: "approval was issued for a different tool" };
    }
    if (!rec.paramsHash || rec.paramsHash !== input.paramsHash) {
      return { ok: false, reason: "params hash mismatch (or legacy approval without hash)" };
    }
    if (rec.status === "consumed") return { ok: false, reason: "approval already consumed" };
    if (rec.status === "rejected") return { ok: false, reason: "approval was rejected" };
    if (rec.status !== "approved") return { ok: false, reason: `approval is ${rec.status}` };
    if (new Date(rec.expiresAt).getTime() <= Date.now()) {
      return { ok: false, reason: "approval has expired" };
    }

    // Burn first, then claim. If the claim fails, roll the burn back so the
    // approval is not lost without an execution start (mirrors the PG
    // transaction rollback).
    rec.status = "consumed";
    rec.resolvedAt = new Date().toISOString();
    const claimed = await this.journal.claimForExecution(input.executionId, {
      ownerId: crypto.randomUUID(),
      leaseMs: DEFAULT_LEASE_MS,
    });
    if (!claimed) {
      rec.status = "approved";
      rec.resolvedAt = null;
      return { ok: false, reason: "execution is not in a claimable state" };
    }
    claimed.approvalId = input.approvalId;
    return { ok: true };
  }
}
