// ---------------------------------------------------------------------------
// Execution Outcome & Evaluation — Phase S5.
//
// S5 IS AN OBSERVER. Nothing in this file executes, plans, authorizes or
// adapts. It reads audit rows that were already written and arranges them into
// one answer to "what happened during that request?". Every fact it reports is
// a fact `AuditLog` already held; it adds none.
//
// TWO THINGS THAT ARE NOT THE SAME THING, and the reason this file exists:
//
//   EXECUTION OUTCOME   what the system DID. Derived from audit rows: which
//                       agent ran, which tools were called, which succeeded,
//                       which were denied, how the turn ended.
//   USER FEEDBACK       whether the person found it useful. Known ONLY when
//                       they said so explicitly.
//
// A tool returning COMPLETED does not mean JARVIS was right, and a turn the
// user never rated is not a turn they disliked. Collapsing those two is how a
// future learning layer would end up optimising for tool exit codes instead of
// for usefulness, so they are kept apart here, at the bottom, where the
// distinction is cheapest to hold.
//
// `feedback: null` therefore means NOT ASKED OR NOT ANSWERED. It is not a
// negative, and nothing in this file infers one from silence, from a follow-up
// question, from a correction or from anything else the user did next.
//
// NO PARALLEL STATUS ENUM. The outcome of a turn is the `result` the
// orchestrator already audited — success / failure / rejected / pending. S5
// reuses it rather than inventing a second vocabulary that could disagree.
// ---------------------------------------------------------------------------

import type { AuditEntry } from "./types/common.js";
import { skillsForToolIds } from "./capability-presentation.js";

/**
 * The explicit signal, and the only kind of feedback S5 recognises.
 *
 * Deliberately two values. A five-star scale invites a precision the signal
 * does not have, and a free-text box is a different feature with different
 * privacy consequences.
 */
export type UserFeedback = "HELPFUL" | "NOT_HELPFUL";

export function isUserFeedback(value: unknown): value is UserFeedback {
  return value === "HELPFUL" || value === "NOT_HELPFUL";
}

/**
 * The audit action a feedback row carries.
 *
 * Feedback is stored as an ordinary `AuditLog` row — same table, same writer,
 * same redaction, same retention. It IS an audited user action, so it needs no
 * table of its own, and keeping it here means the projection reads one source.
 */
export const FEEDBACK_AUDIT_ACTION = "conversation.feedback";

/** The orchestrator's own audited verdict for a turn. */
export const ORCHESTRATION_AUDIT_ACTION = "orchestrator.process";

/** One tool call, as the audit trail recorded it. */
export interface ExecutionOutcomeTool {
  toolId: string;
  /** The audited result. `rejected` is a policy denial, not a tool failure. */
  result: AuditEntry["result"];
  /** Correlation id, when the writer recorded one. */
  executionId?: string;
  durationMs?: number;
  at: Date;
}

/**
 * One request, as the audit trail can describe it.
 *
 * Every field is derived. Nothing here is stored under its own key, and
 * re-deriving it from the same rows always produces the same object.
 */
export interface ExecutionOutcome {
  traceId: string;

  /** Agents that appear on any row of this trace, first-seen order. */
  agents: readonly string[];
  /** Skills, via `skillsForToolIds` — the S2 mapping, not a second one. */
  skills: readonly string[];

  tools: readonly ExecutionOutcomeTool[];
  toolsSucceeded: number;
  toolsFailed: number;
  /** Calls refused by policy before reaching the executor. */
  toolsDenied: number;

  /** Approval decisions audited during this trace. */
  approvals: readonly { action: string; result: AuditEntry["result"]; at: Date }[];

  /**
   * How the turn ended, from the orchestrator's own audit row.
   *
   * Null when no such row exists — an in-flight or never-completed request.
   * This is NOT a judgement about quality.
   */
  outcome: AuditEntry["result"] | null;

  /**
   * The explicit user signal, or null for "not given".
   *
   * Null is not NOT_HELPFUL. Nothing infers this value.
   */
  feedback: UserFeedback | null;
  feedbackAt: Date | null;

  startedAt: Date | null;
  completedAt: Date | null;
  /**
   * Wall-clock span of the audited rows.
   *
   * Honest about what it is: the distance between the first and last row of
   * the trace, not a measured request duration. Null when there is only one
   * row to measure between.
   */
  durationMs: number | null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Project the audit rows of ONE trace into an execution outcome.
 *
 * Pure and total: any set of rows produces a well-formed outcome, including an
 * empty one. Rows belonging to another trace are ignored rather than trusted,
 * so a caller that over-fetches cannot blend two requests together.
 *
 * Order is derived from `timestamp`, not from the order rows arrive in.
 */
export function buildExecutionOutcome(
  traceId: string,
  entries: readonly AuditEntry[]
): ExecutionOutcome {
  const rows = entries
    .filter((e) => e.traceId === traceId)
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const agents: string[] = [];
  const tools: ExecutionOutcomeTool[] = [];
  const approvals: ExecutionOutcome["approvals"][number][] = [];
  let outcome: AuditEntry["result"] | null = null;
  let feedback: UserFeedback | null = null;
  let feedbackAt: Date | null = null;
  let toolsDenied = 0;

  for (const row of rows) {
    if (row.agentId && !agents.includes(row.agentId)) agents.push(row.agentId);

    const metadata = (row.metadata ?? {}) as Record<string, unknown>;

    if (row.action === "tool.execute" && row.toolId) {
      tools.push({
        toolId: row.toolId,
        result: row.result,
        ...(asString(metadata.executionId) ? { executionId: asString(metadata.executionId)! } : {}),
        ...(typeof metadata.durationMs === "number" ? { durationMs: metadata.durationMs } : {}),
        at: row.timestamp,
      });
      continue;
    }

    // A denial never reached the executor, so it is not a tool call that
    // failed — it is a call that was refused. Counted separately for exactly
    // that reason.
    if (row.action === "agent.tool_denied" || row.action === "agent.approval_gate_missing") {
      toolsDenied += 1;
      continue;
    }

    if (row.action.startsWith("approval.")) {
      approvals.push({ action: row.action, result: row.result, at: row.timestamp });
      continue;
    }

    if (row.action === ORCHESTRATION_AUDIT_ACTION) {
      // Last one wins: a retried turn's final verdict is the one that stands.
      outcome = row.result;
      continue;
    }

    if (row.action === FEEDBACK_AUDIT_ACTION) {
      const given = metadata.feedback;
      if (isUserFeedback(given)) {
        // Last one wins — a person may change their mind, and the most recent
        // statement is the one they meant.
        feedback = given;
        feedbackAt = row.timestamp;
      }
      continue;
    }
  }

  const first = rows[0]?.timestamp ?? null;
  const last = rows.length > 1 ? rows[rows.length - 1]!.timestamp : null;

  return {
    traceId,
    agents,
    // The S2 mapping, reused. A tool belonging to no skill — the intentional
    // orphans — contributes nothing rather than being invented a home.
    skills: skillsForToolIds(tools.map((t) => t.toolId)),
    tools,
    toolsSucceeded: tools.filter((t) => t.result === "success").length,
    toolsFailed: tools.filter((t) => t.result === "failure").length,
    toolsDenied,
    approvals,
    outcome,
    feedback,
    feedbackAt,
    startedAt: first,
    completedAt: last,
    durationMs: first && last ? last.getTime() - first.getTime() : null,
  };
}
