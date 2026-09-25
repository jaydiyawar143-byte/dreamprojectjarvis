// ---------------------------------------------------------------------------
// S6 — Objective evaluation. Implementation Phase 2: the pure builder.
//
// Given ONE request — the user's own words (Phase 1 extracts objectives from
// them) and the rows the SERVER wrote while handling it — answer, objective by
// objective, what the evidence proves:
//
//   EVIDENCED           the evidence proves it
//   AWAITING_APPROVAL   a write is waiting on a human, outside this request
//   BLOCKED             every attempt was refused or failed
//   NOT_ATTEMPTED       the request ended and nothing was tried
//   NOT_EVALUABLE       the evidence cannot decide — and `missing` says why
//
// THREE LAYERS, NEVER COLLAPSED. `facts` restate server-written rows, using
// enumerated fields only. `assessments` apply one fixed rule each and name it.
// `missing` names what is unknown. There is no success flag, no score and no
// confidence: fixed rules have no probability to report.
//
// WHAT THIS FILE CANNOT DO. It is a pure function of its arguments. It holds
// no executor, registry, policy, gate, planner, memory or model, so there is
// no edit to a status here that could run, approve, refuse, route or retry
// anything. Nothing on the planning path imports it; a test pins that.
//
// WHAT IS NEVER EVIDENCE. Tool parameters, free-text metadata (`detail`,
// `internalError`, error messages), approval prose, `agentId`, model output
// and the user's own words beyond objective extraction. A provider's word is
// read only as a code from a closed enum. Feedback (S5) is copied beside the
// assessments and never read by a rule.
//
// Locked in the S6 contract — JARVIS_SKILL_SYSTEM_V1.md §7d.
// ---------------------------------------------------------------------------

import type { AuditEntry } from "./types/common.js";
import type { ConversationMessage } from "./types/conversation.js";
import type { RiskLevel } from "./types/tool.js";
import { GOOGLE_TASK_ACTIONS, type GoogleTaskStatus } from "./types/google-workspace.js";
import { GOOGLE_WRITE_ACTIONS, type WriteVerification } from "./types/google-write.js";
import {
  INTEGRATION_COMMANDS,
  type IntegrationCommand,
  type IntegrationErrorCode,
} from "./types/integration.js";
import { skillForToolId } from "./capability-presentation.js";
import { buildExecutionOutcome, type UserFeedback } from "./execution-outcome.js";
import {
  extractObjectives,
  extractionMissing,
  type EvidenceClass,
  type Objective,
} from "./objective-extraction.js";

// ---------------------------------------------------------------------------
// The contract's types
// ---------------------------------------------------------------------------

export type ObjectiveStatus =
  | "EVIDENCED"
  | "AWAITING_APPROVAL"
  | "BLOCKED"
  | "NOT_ATTEMPTED"
  | "NOT_EVALUABLE";

/** Closed. Every NOT_EVALUABLE assessment carries exactly one. */
export type MissingEvidence =
  | "REQUEST_TEXT"
  | "OBJECTIVE_CLASS"
  | "ROW_LIMIT"
  | "TURN_CONCLUSION"
  | "RESPONSE_MEANING"
  | "ATTRIBUTION"
  | "CORROBORATION"
  | "DEFERRED_TO_TASK"
  | "UNRECORDED_WRITE_PATH";

export type Refusal =
  | "POLICY"
  | "NOT_REQUESTED"
  | "CLARIFICATION_REQUIRED"
  | "APPROVAL_GATE_MISSING"
  | "PERMISSION"
  | "UNSPECIFIED_REJECTION";

export type EvidenceFactKind =
  | "TOOL_RESULT"
  | "TOOL_REFUSED"
  | "APPROVAL_REQUESTED"
  | "WRITE_PLANNED"
  | "WRITE_EXECUTED"
  | "PROVIDER_RESULT"
  | "TURN_VERDICT"
  | "REPLY_STORED"
  | "TASK_CREATED";

/** PROVEN: one server-written row (or one field of one stored reply), restated. */
export interface EvidenceFact {
  /** `audit:<id>`, `message:<id>`, or `message:<id>#<field>` for a reply field. */
  ref: string;
  kind: EvidenceFactKind;
  at: Date;
  /** Tool-level kinds. Google write rows are named by their planner tool. */
  toolId?: string;
  /** PROVIDER_RESULT only: the audit action, e.g. "integration.testConnection". */
  action?: string;
  /** Audit-sourced kinds. */
  result?: AuditEntry["result"];
  /** TOOL_REFUSED only. */
  refusal?: Refusal;
  /** PROVIDER_RESULT only, and only when the value is in its closed enum. */
  code?: IntegrationErrorCode | GoogleTaskStatus;
  approvalId?: string;
  /** WRITE_EXECUTED only, and only when the value is in its closed enum. */
  verification?: WriteVerification;
  /** TASK_CREATED only. */
  taskId?: string;
}

export type AssessmentRule =
  | "RETRIEVE_READ_PROVEN"
  | "RETRIEVE_READ_UNCORROBORATED"
  | "RETRIEVE_ATTEMPTS_STOPPED"
  | "WRITE_EXECUTION_PROVEN"
  | "WRITE_AWAITING_APPROVAL"
  | "WRITE_UNCORROBORATED"
  | "WRITE_ATTEMPTS_STOPPED"
  | "WRITE_NOT_ATTEMPTED"
  | "WRITE_PATH_UNRECORDED"
  | "RESPONSE_ONLY"
  | "RESPONSE_STOPPED"
  | "TURN_FAILED_UNATTEMPTED"
  | "DEFERRED_TO_TASK"
  | "ATTRIBUTION_AMBIGUOUS"
  | "TURN_CONCLUSION_UNKNOWN"
  | "ROW_LIMIT_ABSENCE_UNPROVEN";

/** INFERRED: one fixed rule applied to facts. */
export interface ObjectiveAssessment {
  objectiveId: string;
  status: ObjectiveStatus;
  rule: AssessmentRule;
  /** Refs of the facts the rule used, in fact order. May be empty. */
  evidence: readonly string[];
  /** Present if and only if the status is NOT_EVALUABLE. */
  missing?: MissingEvidence;
}

export interface ObjectiveEvaluation {
  traceId: string;
  /** Exactly one user message of this trace carries its request. */
  bound: boolean;
  objectives: readonly Objective[];
  /** One per objective, in the same order. */
  assessments: readonly ObjectiveAssessment[];
  /** Time-ordered. Listed even when the trace is unbound. */
  facts: readonly EvidenceFact[];
  /** Trace-level unknowns: REQUEST_TEXT, OBJECTIVE_CLASS, ROW_LIMIT. */
  missing: readonly MissingEvidence[];
  /** Copied from S5, never combined with any status. */
  feedback: UserFeedback | null;
  /** The latest row read — not the clock. Null when nothing was read. */
  asOf: Date | null;
}

export interface ObjectiveEvaluationInput {
  traceId: string;
  /** This user's audit rows for the trace, at most the evaluation's row limit. */
  auditRows: readonly AuditEntry[];
  /** True when more rows existed than were read. */
  truncated: boolean;
  /** This user's messages whose metadata carries the trace id. */
  messages: readonly ConversationMessage[];
  /** The registry's risk for a tool, or undefined for a tool it does not know. */
  riskOf: (toolId: string) => RiskLevel | undefined;
}

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/**
 * Which command each integration tool sends, so its reported success can be
 * checked against the command service's own row. Pinned against the real
 * tools in packages/tools/test/objective-evaluation-drift-s6.test.ts.
 */
export const INTEGRATION_TOOL_COMMAND: Readonly<Record<string, IntegrationCommand>> = Object.freeze({
  "integration.list": "list",
  "integration.status": "status",
  "integration.health": "getHealth",
  "integration.permissions": "getPermissions",
  "integration.audit": "getAudit",
  "integration.test": "testConnection",
  "integration.validate": "validateConfig",
  "integration.connect": "connect",
  "integration.configure": "configure",
  "integration.reconnect": "reconnect",
  "integration.enable": "enable",
  "integration.disable": "disable",
  "integration.disconnect": "disconnect",
});

/**
 * Writes to JARVIS's own task store. Their provider IS this system, so the
 * executor's row is the provider's record and no second row exists to check.
 */
export const TASK_STORE_WRITE_TOOLS: readonly string[] = Object.freeze(["task.create", "task.updateStatus"]);

// Each closed enum as a complete key set: the compiler rejects a missing or an
// extra member, so these cannot drift from the union they mirror.
const GOOGLE_TASK_STATUS: Record<GoogleTaskStatus, true> = {
  ok: true,
  not_connected: true,
  needs_reauth: true,
  permission_missing: true,
  provider_error: true,
};
const INTEGRATION_ERROR_CODE: Record<IntegrationErrorCode, true> = {
  UNKNOWN_INTEGRATION: true,
  NOT_CONFIGURED: true,
  NOT_CONNECTED: true,
  INVALID_CONFIG: true,
  NEEDS_REAUTH: true,
  PERMISSION_DENIED: true,
  CONFIRMATION_REQUIRED: true,
  RATE_LIMITED: true,
  PROVIDER_ERROR: true,
  TIMEOUT: true,
  UNSUPPORTED_COMMAND: true,
  INTERNAL_ERROR: true,
};
const WRITE_VERIFICATION: Record<WriteVerification, true> = {
  verified: true,
  verification_failed: true,
  provider_reported: true,
  verification_unavailable: true,
  indeterminate: true,
  failed: true,
};

function member<K extends string>(set: Record<K, true>, value: unknown): value is K {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(set, value);
}

const REFUSAL_BY_ACTION: Readonly<Record<string, Refusal>> = Object.freeze({
  "agent.tool_denied": "POLICY",
  "agent.tool_not_requested": "NOT_REQUESTED",
  "agent.tool_clarification_required": "CLARIFICATION_REQUIRED",
  "agent.approval_gate_missing": "APPROVAL_GATE_MISSING",
});

const GOOGLE_READ_ACTIONS = new Set<string>(GOOGLE_TASK_ACTIONS);
const GOOGLE_WRITE_ACTION_SET = new Set<string>(GOOGLE_WRITE_ACTIONS);
const INTEGRATION_COMMAND_SET = new Set<string>(INTEGRATION_COMMANDS);
const TASK_STORE_WRITES = new Set<string>(TASK_STORE_WRITE_TOOLS);

const GOOGLE_PLAN_PREFIX = "google.plan.";
const GOOGLE_WRITE_PLAN_PREFIX = "google.write.plan.";
const GOOGLE_WRITE_EXECUTE_PREFIX = "google.write.execute.";

/**
 * Every action this system writes under its own name is a dotted identifier
 * ("tool.execute", "agent.tool_denied"). The approval service is the one
 * writer that puts a tool's prose DESCRIPTION in `action`; its rows are
 * recognised by that shape plus their structured fields — the prose itself
 * is never read.
 */
const DOTTED_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function millis(value: Date | string | undefined): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function traceOf(message: ConversationMessage): string | undefined {
  return nonEmpty(record(message.metadata).traceId);
}

// ---------------------------------------------------------------------------
// Evidence normalization
// ---------------------------------------------------------------------------

function factFromRow(row: AuditEntry): EvidenceFact | null {
  const meta = record(row.metadata);
  const ref = `audit:${row.id}`;
  const at = new Date(millis(row.timestamp));
  const toolId = nonEmpty(row.toolId);
  const approvalId = nonEmpty(meta.approvalId);
  const action = row.action;

  if (action === "tool.execute") {
    if (!toolId) return null;
    if (row.result === "success" || row.result === "failure") {
      return { ref, kind: "TOOL_RESULT", at, toolId, result: row.result };
    }
    if (row.result === "rejected") {
      return { ref, kind: "TOOL_REFUSED", at, toolId, result: row.result, refusal: "UNSPECIFIED_REJECTION" };
    }
    return { ref, kind: "APPROVAL_REQUESTED", at, toolId, result: row.result };
  }

  const refusal = REFUSAL_BY_ACTION[action];
  if (refusal) {
    return toolId ? { ref, kind: "TOOL_REFUSED", at, toolId, result: row.result, refusal } : null;
  }

  if (action.startsWith(GOOGLE_WRITE_PLAN_PREFIX)) {
    const writeAction = action.slice(GOOGLE_WRITE_PLAN_PREFIX.length);
    if (!GOOGLE_WRITE_ACTION_SET.has(writeAction) || row.result !== "success" || !approvalId) return null;
    return { ref, kind: "WRITE_PLANNED", at, toolId: `${GOOGLE_PLAN_PREFIX}${writeAction}`, result: row.result, approvalId };
  }

  if (action.startsWith(GOOGLE_WRITE_EXECUTE_PREFIX)) {
    const writeAction = action.slice(GOOGLE_WRITE_EXECUTE_PREFIX.length);
    if (!GOOGLE_WRITE_ACTION_SET.has(writeAction)) return null;
    return {
      ref,
      kind: "WRITE_EXECUTED",
      at,
      toolId: `${GOOGLE_PLAN_PREFIX}${writeAction}`,
      result: row.result,
      ...(approvalId ? { approvalId } : {}),
      ...(member(WRITE_VERIFICATION, meta.verification) ? { verification: meta.verification } : {}),
    };
  }

  if (action.startsWith("google.")) {
    if (!GOOGLE_READ_ACTIONS.has(action.slice("google.".length))) return null;
    return {
      ref,
      kind: "PROVIDER_RESULT",
      at,
      action,
      result: row.result,
      ...(member(GOOGLE_TASK_STATUS, meta.status) ? { code: meta.status } : {}),
    };
  }

  if (action.startsWith("integration.")) {
    if (!INTEGRATION_COMMAND_SET.has(action.slice("integration.".length))) return null;
    return {
      ref,
      kind: "PROVIDER_RESULT",
      at,
      action,
      result: row.result,
      ...(member(INTEGRATION_ERROR_CODE, meta.code) ? { code: meta.code } : {}),
    };
  }

  if (action === "orchestrator.process") {
    return { ref, kind: "TURN_VERDICT", at, result: row.result };
  }

  // The approval service's rows, recognised by shape. Its prose action and its
  // agentId (which holds an execution id) are never read.
  if (toolId && !DOTTED_IDENTIFIER.test(action)) {
    if (row.result === "pending" && approvalId) {
      return { ref, kind: "APPROVAL_REQUESTED", at, toolId, result: row.result, approvalId };
    }
    if (row.result === "rejected" && record(meta.error).code === "AUTHORIZATION_FAILED") {
      return { ref, kind: "TOOL_REFUSED", at, toolId, result: row.result, refusal: "PERMISSION" };
    }
  }

  // Everything else — surface decisions, feedback, `approval.*` rows (whose
  // trace id a client header supplies), analysis rows — is not evidence.
  return null;
}

function factsFromReply(message: ConversationMessage): EvidenceFact[] {
  const meta = record(message.metadata);
  const at = new Date(millis(message.createdAt));
  const facts: EvidenceFact[] = [{ ref: `message:${message.id}`, kind: "REPLY_STORED", at }];

  const pending = record(meta.pendingAction);
  const toolId = nonEmpty(pending.toolId);
  const approvalId = nonEmpty(pending.approvalId);
  if (toolId && approvalId) {
    facts.push({ ref: `message:${message.id}#pendingAction`, kind: "APPROVAL_REQUESTED", at, toolId, approvalId });
  }

  const taskId = nonEmpty(meta.taskId);
  if (taskId) facts.push({ ref: `message:${message.id}#taskId`, kind: "TASK_CREATED", at, taskId });

  return facts;
}

function byTimeThenRef(a: EvidenceFact, b: EvidenceFact): number {
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) return byTime;
  return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
}

/**
 * The facts of one trace, time-ordered.
 *
 * Rows and messages of any other trace are ignored rather than trusted, so a
 * caller that over-fetches cannot blend two requests together.
 */
export function normalizeEvidence(input: {
  traceId: string;
  auditRows: readonly AuditEntry[];
  messages: readonly ConversationMessage[];
}): EvidenceFact[] {
  const facts: EvidenceFact[] = [];
  for (const row of input.auditRows) {
    if (row.traceId !== input.traceId) continue;
    const fact = factFromRow(row);
    if (fact) facts.push(fact);
  }
  for (const message of input.messages) {
    if (message.role !== "assistant" || traceOf(message) !== input.traceId) continue;
    facts.push(...factsFromReply(message));
  }
  return facts.sort(byTimeThenRef);
}

// ---------------------------------------------------------------------------
// Attribution and outcomes
// ---------------------------------------------------------------------------

type Side = "READ" | "WRITE";

const ATTEMPT_KINDS = new Set<EvidenceFactKind>([
  "TOOL_RESULT",
  "TOOL_REFUSED",
  "APPROVAL_REQUESTED",
  "WRITE_PLANNED",
  "WRITE_EXECUTED",
]);

interface Context {
  facts: readonly EvidenceFact[];
  order: ReadonlyMap<string, number>;
  attempts: readonly EvidenceFact[];
  providers: readonly EvidenceFact[];
  replies: readonly EvidenceFact[];
  tasks: readonly EvidenceFact[];
  verdict: EvidenceFact | null;
  sides: ReadonlyMap<string, Side | null>;
  classCount: ReadonlyMap<EvidenceClass, number>;
}

function sideOf(ctx: Context, fact: EvidenceFact): Side | null {
  return ctx.sides.get(fact.toolId!) ?? null;
}

/**
 * The attempts attributed to an objective — an inference, never a fact.
 *
 * A1: the tool's skill is one the objective names. A2, only when A1 finds
 * nothing: the objective is the only one of its class, so every attempt on its
 * side is its own. A tool the registry does not know is never attributed.
 * `others` are the attempts that could have been this objective's but are not
 * attributable to it.
 */
function attribute(
  objective: Objective,
  ctx: Context,
  side: Side | "ANY"
): { mine: EvidenceFact[]; others: EvidenceFact[] } {
  const onSide = ctx.attempts.filter((f) => {
    const s = sideOf(ctx, f);
    return s !== null && (side === "ANY" || s === side);
  });

  let mine =
    objective.skills.length > 0
      ? onSide.filter((f) => objective.skills.includes(skillForToolId(f.toolId!)?.id ?? ""))
      : [];
  if (mine.length === 0 && ctx.classCount.get(objective.evidenceClass) === 1) mine = onSide;

  const others = ctx.attempts.filter((f) => {
    if (mine.includes(f)) return false;
    const s = sideOf(ctx, f);
    return s === null || side === "ANY" || s === side;
  });
  return { mine, others };
}

type OutcomeKind = "PROVEN" | "AWAITING" | "UNCORROBORATED" | "STOP";

interface Outcome {
  kind: OutcomeKind;
  facts: readonly EvidenceFact[];
}

const outcome = (kind: OutcomeKind, ...facts: EvidenceFact[]): Outcome => ({ kind, facts });

/**
 * Checks a tool's reported result against the provider's own row for the same
 * call. Used for the families that report success on bad news: Google reads,
 * integration tools. A confirmation the command service asked for is a wait
 * for a human, not a stop.
 */
function corroborate(fact: EvidenceFact, rows: readonly EvidenceFact[], confirmationIsApproval: boolean): Outcome {
  const succeeded = rows.filter((r) => r.result === "success");
  const failed = rows.filter((r) => r.result !== "success");
  const confirmation = confirmationIsApproval ? failed.filter((r) => r.code === "CONFIRMATION_REQUIRED") : [];

  if (confirmation.length > 0) return outcome("AWAITING", fact, ...confirmation);
  if (fact.result === "success") {
    if (succeeded.length > 0) return outcome("PROVEN", fact, ...succeeded);
    if (failed.length > 0) return outcome("STOP", fact, ...failed);
    return outcome("UNCORROBORATED", fact);
  }
  return outcome("STOP", fact, ...failed);
}

function providerRows(ctx: Context, action: string): EvidenceFact[] {
  return ctx.providers.filter((p) => p.action === action);
}

function toolResultOutcome(fact: EvidenceFact, ctx: Context): Outcome {
  const toolId = fact.toolId!;

  if (GOOGLE_READ_ACTIONS.has(toolId)) {
    return corroborate(fact, providerRows(ctx, `google.${toolId}`), false);
  }

  const command = INTEGRATION_TOOL_COMMAND[toolId];
  if (command) {
    return corroborate(fact, providerRows(ctx, `integration.${command}`), true);
  }

  if (toolId.startsWith(GOOGLE_PLAN_PREFIX) && GOOGLE_WRITE_ACTION_SET.has(toolId.slice(GOOGLE_PLAN_PREFIX.length))) {
    if (fact.result !== "success") return outcome("STOP", fact);
    const plans = ctx.attempts.filter((f) => f.kind === "WRITE_PLANNED" && f.toolId === toolId);
    return plans.length > 0 ? outcome("AWAITING", fact, ...plans) : outcome("UNCORROBORATED", fact);
  }

  if (fact.result !== "success") return outcome("STOP", fact);
  if (TASK_STORE_WRITES.has(toolId)) return outcome("PROVEN", fact);
  // Any other READ_ONLY tool fails honestly, so its success needs no second
  // row. Any other write has no same-trace source that could corroborate it.
  return sideOf(ctx, fact) === "READ" ? outcome("PROVEN", fact) : outcome("UNCORROBORATED", fact);
}

function outcomeOf(fact: EvidenceFact, ctx: Context): Outcome {
  switch (fact.kind) {
    case "TOOL_REFUSED":
      return outcome("STOP", fact);
    case "APPROVAL_REQUESTED":
    case "WRITE_PLANNED":
      return outcome("AWAITING", fact);
    case "WRITE_EXECUTED":
      if (fact.result !== "success") return outcome("STOP", fact);
      return fact.verification === "verified" ? outcome("PROVEN", fact) : outcome("UNCORROBORATED", fact);
    default:
      return toolResultOutcome(fact, ctx);
  }
}

// ---------------------------------------------------------------------------
// Status rules — first match wins, per class
// ---------------------------------------------------------------------------

function refs(ctx: Context, facts: readonly EvidenceFact[]): string[] {
  const unique = [...new Set(facts.map((f) => f.ref))];
  return unique.sort((a, b) => (ctx.order.get(a) ?? 0) - (ctx.order.get(b) ?? 0));
}

function assessment(
  objective: Objective,
  status: ObjectiveStatus,
  rule: AssessmentRule,
  evidence: readonly string[],
  missing?: MissingEvidence
): ObjectiveAssessment {
  return {
    objectiveId: objective.objectiveId,
    status,
    rule,
    evidence,
    ...(status === "NOT_EVALUABLE" && missing ? { missing } : {}),
  };
}

function factsOf(outcomes: readonly Outcome[], kind: OutcomeKind): EvidenceFact[] {
  return outcomes.filter((o) => o.kind === kind).flatMap((o) => o.facts);
}

function assessRetrieve(objective: Objective, ctx: Context): ObjectiveAssessment {
  const { mine, others } = attribute(objective, ctx, "READ");
  const outcomes = mine.map((f) => outcomeOf(f, ctx));

  const proven = factsOf(outcomes, "PROVEN");
  if (proven.length > 0) return assessment(objective, "EVIDENCED", "RETRIEVE_READ_PROVEN", refs(ctx, proven));

  const uncorroborated = factsOf(outcomes, "UNCORROBORATED");
  if (uncorroborated.length > 0) {
    return assessment(objective, "NOT_EVALUABLE", "RETRIEVE_READ_UNCORROBORATED", refs(ctx, uncorroborated), "CORROBORATION");
  }

  if (mine.length > 0 && outcomes.every((o) => o.kind === "STOP")) {
    return assessment(objective, "BLOCKED", "RETRIEVE_ATTEMPTS_STOPPED", refs(ctx, factsOf(outcomes, "STOP")));
  }

  if (mine.length === 0 && others.length > 0) {
    return assessment(objective, "NOT_EVALUABLE", "ATTRIBUTION_AMBIGUOUS", refs(ctx, others), "ATTRIBUTION");
  }

  if (ctx.tasks.length > 0) {
    return assessment(objective, "NOT_EVALUABLE", "DEFERRED_TO_TASK", refs(ctx, ctx.tasks), "DEFERRED_TO_TASK");
  }
  if (ctx.replies.length > 0) {
    return assessment(objective, "NOT_EVALUABLE", "RESPONSE_ONLY", refs(ctx, ctx.replies), "RESPONSE_MEANING");
  }
  if (ctx.verdict?.result === "failure") {
    return assessment(objective, "NOT_ATTEMPTED", "TURN_FAILED_UNATTEMPTED", [ctx.verdict.ref]);
  }
  return assessment(objective, "NOT_EVALUABLE", "TURN_CONCLUSION_UNKNOWN", [], "TURN_CONCLUSION");
}

function assessWrite(objective: Objective, ctx: Context): ObjectiveAssessment {
  const { mine, others } = attribute(objective, ctx, "WRITE");
  const outcomes = mine.map((f) => outcomeOf(f, ctx));

  const proven = factsOf(outcomes, "PROVEN");
  if (proven.length > 0) return assessment(objective, "EVIDENCED", "WRITE_EXECUTION_PROVEN", refs(ctx, proven));

  const awaiting = factsOf(outcomes, "AWAITING");
  if (awaiting.length > 0) {
    return assessment(objective, "AWAITING_APPROVAL", "WRITE_AWAITING_APPROVAL", refs(ctx, awaiting));
  }

  const uncorroborated = factsOf(outcomes, "UNCORROBORATED");
  if (uncorroborated.length > 0) {
    return assessment(objective, "NOT_EVALUABLE", "WRITE_UNCORROBORATED", refs(ctx, uncorroborated), "CORROBORATION");
  }

  if (mine.length > 0) {
    return assessment(objective, "BLOCKED", "WRITE_ATTEMPTS_STOPPED", refs(ctx, factsOf(outcomes, "STOP")));
  }

  if (others.length > 0) {
    return assessment(objective, "NOT_EVALUABLE", "ATTRIBUTION_AMBIGUOUS", refs(ctx, others), "ATTRIBUTION");
  }

  if (ctx.tasks.length > 0) {
    return assessment(objective, "NOT_EVALUABLE", "DEFERRED_TO_TASK", refs(ctx, ctx.tasks), "DEFERRED_TO_TASK");
  }
  // A failed turn does not store its reply, and a pending action created
  // before the failure is recorded nowhere in the trace — so absence of a write
  // attempt cannot be proven.
  if (ctx.verdict?.result === "failure") {
    return assessment(objective, "NOT_EVALUABLE", "WRITE_PATH_UNRECORDED", [ctx.verdict.ref], "UNRECORDED_WRITE_PATH");
  }
  if (ctx.verdict || ctx.replies.length > 0) {
    return assessment(objective, "NOT_ATTEMPTED", "WRITE_NOT_ATTEMPTED", refs(ctx, ctx.verdict ? [ctx.verdict] : ctx.replies));
  }
  return assessment(objective, "NOT_EVALUABLE", "TURN_CONCLUSION_UNKNOWN", [], "TURN_CONCLUSION");
}

/**
 * COMPOSE and ANALYZE are satisfied, if at all, by the meaning of the reply,
 * which no fixed rule reads. Attributed attempts are listed as context.
 */
function assessResponse(objective: Objective, ctx: Context): ObjectiveAssessment {
  const { mine } = attribute(objective, ctx, "ANY");

  if (ctx.replies.length > 0) {
    return assessment(objective, "NOT_EVALUABLE", "RESPONSE_ONLY", refs(ctx, [...mine, ...ctx.replies]), "RESPONSE_MEANING");
  }
  if (ctx.verdict?.result === "failure") {
    const stops = factsOf(
      mine.map((f) => outcomeOf(f, ctx)),
      "STOP"
    );
    if (stops.length > 0) {
      return assessment(objective, "BLOCKED", "RESPONSE_STOPPED", refs(ctx, [...stops, ctx.verdict]));
    }
    return assessment(objective, "NOT_ATTEMPTED", "TURN_FAILED_UNATTEMPTED", [ctx.verdict.ref]);
  }
  return assessment(objective, "NOT_EVALUABLE", "TURN_CONCLUSION_UNKNOWN", [], "TURN_CONCLUSION");
}

function assess(objective: Objective, ctx: Context): ObjectiveAssessment {
  switch (objective.evidenceClass) {
    case "RETRIEVE":
      return assessRetrieve(objective, ctx);
    case "EXTERNAL_WRITE":
      return assessWrite(objective, ctx);
    default:
      return assessResponse(objective, ctx);
  }
}

/**
 * Over the row limit, a status that rests on ABSENCE — nothing succeeded,
 * nothing was attempted — cannot be proven: the missing rows might hold the
 * contrary. Statuses that rest on PRESENCE stand.
 */
function limitedByRows(a: ObjectiveAssessment): ObjectiveAssessment {
  if (a.status !== "BLOCKED" && a.status !== "NOT_ATTEMPTED") return a;
  return {
    objectiveId: a.objectiveId,
    status: "NOT_EVALUABLE",
    rule: "ROW_LIMIT_ABSENCE_UNPROVEN",
    evidence: a.evidence,
    missing: "ROW_LIMIT",
  };
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

function contextFor(
  facts: readonly EvidenceFact[],
  objectives: readonly Objective[],
  riskOf: (toolId: string) => RiskLevel | undefined
): Context {
  const attempts = facts.filter((f) => ATTEMPT_KINDS.has(f.kind) && f.toolId);

  const sides = new Map<string, Side | null>();
  for (const fact of attempts) {
    const toolId = fact.toolId!;
    if (sides.has(toolId)) continue;
    const risk = riskOf(toolId);
    sides.set(toolId, risk === undefined ? null : risk === "READ_ONLY" ? "READ" : "WRITE");
  }

  const classCount = new Map<EvidenceClass, number>();
  for (const o of objectives) classCount.set(o.evidenceClass, (classCount.get(o.evidenceClass) ?? 0) + 1);

  const verdicts = facts.filter((f) => f.kind === "TURN_VERDICT");
  return {
    facts,
    order: new Map(facts.map((f, i) => [f.ref, i])),
    attempts,
    providers: facts.filter((f) => f.kind === "PROVIDER_RESULT"),
    replies: facts.filter((f) => f.kind === "REPLY_STORED"),
    tasks: facts.filter((f) => f.kind === "TASK_CREATED"),
    verdict: verdicts.length > 0 ? verdicts[verdicts.length - 1]! : null,
    sides,
    classCount,
  };
}

/**
 * The objective evaluation of one request. Pure: the same arguments give the
 * same result, and nothing — the arguments included — is written to.
 */
export function buildObjectiveEvaluation(input: ObjectiveEvaluationInput): ObjectiveEvaluation {
  const { traceId } = input;
  const rows = input.auditRows.filter((r) => r.traceId === traceId);
  const messages = input.messages.filter((m) => traceOf(m) === traceId);

  const facts = normalizeEvidence({ traceId, auditRows: rows, messages });
  const requests = messages.filter((m) => m.role === "user");
  const bound = requests.length === 1;

  let objectives: Objective[] = [];
  let assessments: ObjectiveAssessment[] = [];
  const missing: MissingEvidence[] = [];

  if (!bound) {
    missing.push("REQUEST_TEXT");
  } else {
    objectives = extractObjectives(traceId, requests[0]!.content);
    missing.push(...extractionMissing(objectives));
    const ctx = contextFor(facts, objectives, input.riskOf);
    assessments = objectives.map((o) => assess(o, ctx));
    if (input.truncated) assessments = assessments.map(limitedByRows);
  }
  if (input.truncated) missing.push("ROW_LIMIT");

  const times = [...rows.map((r) => millis(r.timestamp)), ...messages.map((m) => millis(m.createdAt))];

  return {
    traceId,
    bound,
    objectives,
    assessments,
    facts,
    missing,
    // S5's own projection over the same rows — reused, never re-derived here.
    feedback: buildExecutionOutcome(traceId, rows).feedback,
    asOf: times.length > 0 ? new Date(Math.max(...times)) : null,
  };
}
