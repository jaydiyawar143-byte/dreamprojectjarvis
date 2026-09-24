// ---------------------------------------------------------------------------
// Execution Outcome & Evaluation — Phase S5, the service.
//
// Two operations, and deliberately no third:
//
//   outcome(userId, traceId)   read what happened, derived from AuditLog
//   record(...)                write ONE explicit user signal
//
// WHAT THIS SERVICE CANNOT DO. It holds no tool registry, no executor, no
// agent and no policy — none is reachable from here, so there is no edit to
// this file that could make it run a tool. That is the point of S5 being an
// observer: the guarantee is structural, not a promise.
//
// It is also write-once-and-forget in the other direction: nothing in the
// planning path imports this module, so a recorded signal cannot reach agent
// selection, skill context, tool definitions or memory confidence. S5 records;
// it does not steer.
//
// PERSISTENCE. Feedback is an ordinary `AuditLog` row — the same table, the
// same writer, the same redaction and the same retention every other audited
// user action already gets. No new table, no new pipeline, and the projection
// therefore reads exactly one source of truth.
// ---------------------------------------------------------------------------

import {
  buildExecutionOutcome,
  FEEDBACK_AUDIT_ACTION,
  type AuditEntry,
  type ExecutionOutcome,
  type UserFeedback,
} from "@jarvis/core";

/**
 * How far back a trace is looked for.
 *
 * The lookup is bounded by `(userId, createdAt)` rather than by an index on
 * `traceId`, so the window is what keeps the scan proportional. Thirty days is
 * far longer than any conversation a person would rate and short enough that
 * the scan stays small.
 */
export const OUTCOME_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** The narrow write this service needs. Not the whole `AuditLogger`. */
export interface AuditWriter {
  log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void>;
}

/** The narrow read this service needs. Not the whole repository. */
export interface AuditTraceReader {
  findByTrace(
    userId: string,
    traceId: string,
    since: Date,
    limit?: number
  ): Promise<AuditEntry[]>;
}

export interface ExecutionOutcomeDeps {
  audit: AuditTraceReader;
  auditLogger: AuditWriter;
  /** Overridable for tests; defaults to the real clock. */
  now?: () => Date;
}

export class ExecutionOutcomeService {
  constructor(private readonly deps: ExecutionOutcomeDeps) {}

  private since(): Date {
    const now = this.deps.now?.() ?? new Date();
    return new Date(now.getTime() - OUTCOME_LOOKBACK_MS);
  }

  /**
   * What happened during one request.
   *
   * Returns null when the trace has no rows for this user — which is also the
   * answer for a trace belonging to somebody else, deliberately: "not found"
   * and "not yours" are the same reply, so this cannot be used to probe which
   * trace ids exist.
   */
  async outcome(userId: string, traceId: string): Promise<ExecutionOutcome | null> {
    const entries = await this.deps.audit.findByTrace(userId, traceId, this.since());
    if (entries.length === 0) return null;
    return buildExecutionOutcome(traceId, entries);
  }

  /**
   * Record the one explicit signal.
   *
   * REFUSES A TRACE THAT IS NOT THE CALLER'S. Without this, feedback would be
   * a write keyed by an id the caller supplies, which is an invitation to
   * write rows against somebody else's request. The read above is the
   * ownership check, and it costs one query.
   *
   * Returns the re-derived outcome so a caller sees the signal it just wrote
   * in the same shape it will read later.
   */
  async record(
    userId: string,
    traceId: string,
    feedback: UserFeedback,
    context?: { ipAddress?: string }
  ): Promise<ExecutionOutcome | null> {
    const entries = await this.deps.audit.findByTrace(userId, traceId, this.since());
    if (entries.length === 0) return null;

    await this.deps.auditLogger.log({
      userId,
      action: FEEDBACK_AUDIT_ACTION,
      // The signal was recorded successfully. This says nothing about whether
      // the turn it describes went well — that is `outcome`, and the two are
      // kept apart on purpose.
      result: "success",
      traceId,
      ...(context?.ipAddress ? { ipAddress: context.ipAddress } : {}),
      metadata: { feedback },
    });

    // Re-read so the returned view includes the row just written, rather than
    // this service predicting what the projection would say.
    const updated = await this.deps.audit.findByTrace(userId, traceId, this.since());
    return buildExecutionOutcome(traceId, updated);
  }
}
