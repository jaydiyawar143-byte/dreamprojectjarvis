// ---------------------------------------------------------------------------
// S6 — Objective Evaluation, Phase 3: the read-only service.
//
// One operation, and deliberately no second:
//
//   evaluate(userId, traceId)   what each objective of that request proves
//
// A READ LAYER, NOT A RULE LAYER. The service fetches the two inputs the pure
// Phase 2 builder needs and hands them over unchanged:
//
//   the trace's audit rows   through S5's reader — the same query, the same
//                            (userId, createdAt) bound, one row past the limit
//                            so a truncated read is known to be truncated
//   the trace's messages     through a reader scoped by Conversation.userId,
//                            which is where the request is bound (PD-2)
//
// `buildObjectiveEvaluation` extracts the objectives from the bound request,
// normalizes the evidence, copies S5's feedback and applies the fixed rules.
// Nothing here repeats, bends or adds to any of that.
//
// WHAT THIS SERVICE CANNOT DO. It holds two readers and one pure function —
// the registry's risk for a tool id — and nothing else. No executor,
// registry, policy, gate, planner, task or approval service, memory or model
// is reachable from here, so there is no edit to this file that could make an
// evaluation run, approve, refuse, route, retry or remember anything. It
// writes nothing: not an audit row, not a message.
//
// WHAT IT NEVER FOLLOWS. Every read is keyed by the one trace id asked for.
// An approval resolved in another request, a task's current state, a
// scheduler run — none is read, so none can be silently joined to this one.
// ---------------------------------------------------------------------------

import {
  buildObjectiveEvaluation,
  type ConversationMessage,
  type ObjectiveEvaluation,
  type RiskLevel,
} from "@jarvis/core";
import { OUTCOME_LOOKBACK_MS, type AuditTraceReader } from "./execution-outcome-service.js";

/**
 * Audit rows an evaluation reads. One more is requested, so "there were more"
 * is a fact the evaluation can report (ROW_LIMIT) rather than a silent cut.
 */
export const EVALUATION_ROW_LIMIT = 200;

/** A request stores one user message and at most one reply; ten is ample. */
export const EVALUATION_MESSAGE_LIMIT = 10;

/** The narrow read this service needs. Not the whole repository. */
export interface TraceMessageReader {
  /**
   * The caller's messages whose `metadata.traceId` equals `traceId`, created
   * at or after `since`, oldest first, at most `limit`. Ownership is part of
   * the query: another user's message is never returned.
   */
  findTraceMessages(
    userId: string,
    traceId: string,
    since: Date,
    limit: number
  ): Promise<ConversationMessage[]>;
}

export interface ObjectiveEvaluationDeps {
  /** S5's audit reader, unchanged. */
  audit: AuditTraceReader;
  messages: TraceMessageReader;
  /** The registry's risk for a tool id; undefined for a tool it does not know. */
  riskOf: (toolId: string) => RiskLevel | undefined;
  /** Overridable for tests; defaults to the real clock. */
  now?: () => Date;
}

export class ObjectiveEvaluationService {
  constructor(private readonly deps: ObjectiveEvaluationDeps) {}

  /**
   * The objective evaluation of one request.
   *
   * Returns null when this user has neither an audit row nor a message for the
   * trace — which is also the answer for a trace belonging to somebody else,
   * deliberately: "not found" and "not yours" are the same reply, so this
   * cannot be used to learn which trace ids exist.
   *
   * A trace with rows but no bound request is still evaluated: it comes back
   * `bound: false` with its facts listed and no objectives invented.
   */
  async evaluate(userId: string, traceId: string): Promise<ObjectiveEvaluation | null> {
    if (!userId || !traceId) return null;

    const now = this.deps.now?.() ?? new Date();
    const since = new Date(now.getTime() - OUTCOME_LOOKBACK_MS);

    // Independent reads, so they run together.
    const [rows, messages] = await Promise.all([
      this.deps.audit.findByTrace(userId, traceId, since, EVALUATION_ROW_LIMIT + 1),
      this.deps.messages.findTraceMessages(userId, traceId, since, EVALUATION_MESSAGE_LIMIT),
    ]);

    if (rows.length === 0 && messages.length === 0) return null;

    const truncated = rows.length > EVALUATION_ROW_LIMIT;
    return buildObjectiveEvaluation({
      traceId,
      auditRows: truncated ? rows.slice(0, EVALUATION_ROW_LIMIT) : rows,
      truncated,
      messages,
      riskOf: this.deps.riskOf,
    });
  }
}
