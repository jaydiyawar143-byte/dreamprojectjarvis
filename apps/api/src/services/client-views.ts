// ---------------------------------------------------------------------------
// Phase 19.1 audit C1 — what a client may be told about an approval or a
// pending action.
//
// An approval row stores the exact parameters a person approved, because the
// executor must run those. That does not make them safe to return: a browser
// approval carries typed text and nested form values, and a pending action
// carries the same. The API therefore projects the row through an ALLOWLIST.
//
// Two things stay client-visible because a person needs them to decide:
//
//   • the server-generated summary (`buildApprovalSummary`) — already
//     value-free for browser actions;
//   • for a Google write, the reviewed plan — recipients, field labels and the
//     text that will be sent. GoogleWritePlanDetail renders exactly this.
//
// Everything else is gone. `paramsHash` stays: it is a SHA-256 binding, not a
// credential and not reversible, and the approval page displays it as the
// binding it is.
// ---------------------------------------------------------------------------

import {
  isComputerControlAction,
  isGoogleWriteAction,
  type Approval,
  type PendingAction,
} from "@jarvis/core";

export interface ClientWritePlanTarget {
  kind?: string;
  id?: string;
  label?: string;
  location?: string;
}

export interface ClientWritePlanField {
  label?: string;
  before?: string;
  after?: string;
}

export interface ClientWritePlanRisk {
  level?: string;
  irreversible?: boolean;
  outwardFacing?: boolean;
  requiresStrongConfirmation?: boolean;
  consequence?: string;
}

/**
 * The reviewed Google write plan, reduced to the fields the approval page
 * renders. Never the raw `params` object, so a future field added to a plan
 * does not silently become API output.
 */
export interface ClientWritePlan {
  action?: string;
  target?: ClientWritePlanTarget;
  recipients?: string[];
  fields?: ClientWritePlanField[];
  risk?: ClientWritePlanRisk;
  requiredScopes?: string[];
  expiresAt?: string;
  requestId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function texts(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((entry): entry is string => typeof entry === "string").slice(0, limit);
  return out.length > 0 ? out : undefined;
}

function projectTarget(value: unknown): ClientWritePlanTarget | undefined {
  if (!isRecord(value)) return undefined;
  const target: ClientWritePlanTarget = {};
  const kind = text(value.kind);
  const id = text(value.id);
  const label = text(value.label);
  const location = text(value.location);
  if (kind) target.kind = kind;
  if (id) target.id = id;
  if (label) target.label = label;
  if (location) target.location = location;
  return Object.keys(target).length > 0 ? target : undefined;
}

function projectFields(value: unknown): ClientWritePlanField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields: ClientWritePlanField[] = [];
  for (const entry of value.slice(0, 100)) {
    if (!isRecord(entry)) continue;
    const field: ClientWritePlanField = {};
    const label = text(entry.label);
    const before = text(entry.before);
    const after = text(entry.after);
    if (label) field.label = label;
    if (before) field.before = before;
    if (after) field.after = after;
    if (Object.keys(field).length > 0) fields.push(field);
  }
  return fields.length > 0 ? fields : undefined;
}

function projectRisk(value: unknown): ClientWritePlanRisk | undefined {
  if (!isRecord(value)) return undefined;
  const risk: ClientWritePlanRisk = {};
  const level = text(value.level);
  if (level) risk.level = level;
  for (const key of [
    "irreversible",
    "outwardFacing",
    "requiresStrongConfirmation",
  ] as const) {
    if (typeof value[key] === "boolean") risk[key] = value[key];
  }
  const consequence = text(value.consequence);
  if (consequence) risk.consequence = consequence;
  return Object.keys(risk).length > 0 ? risk : undefined;
}

/**
 * The reviewed plan for a Google write, or nothing. A non-Google approval has
 * no plan to show, and its raw parameters are never returned.
 */
export function clientWritePlan(toolId: string, params: unknown): ClientWritePlan | undefined {
  if (!isGoogleWriteAction(toolId) || !isRecord(params)) return undefined;

  const plan: ClientWritePlan = {};
  const action = text(params.action);
  const target = projectTarget(params.target);
  const recipients = texts(params.recipients, 100);
  const fields = projectFields(params.fields);
  const risk = projectRisk(params.risk);
  const requiredScopes = texts(params.requiredScopes, 50);
  const expiresAt = text(params.expiresAt);
  const requestId = text(params.requestId);

  if (action) plan.action = action;
  if (target) plan.target = target;
  if (recipients) plan.recipients = recipients;
  if (fields) plan.fields = fields;
  if (risk) plan.risk = risk;
  if (requiredScopes) plan.requiredScopes = requiredScopes;
  if (expiresAt) plan.expiresAt = expiresAt;
  if (requestId) plan.requestId = requestId;
  return plan;
}

/** An approval row minus its raw parameters, plus the displayable plan. */
export function clientApproval(
  approval: Approval
): Omit<Approval, "params" | "tenantId" | "decidedById"> & { plan?: ClientWritePlan } {
  const { params, tenantId: _tenantId, decidedById: _decidedById, ...rest } = approval;
  const plan = clientWritePlan(approval.toolId, params);
  return { ...rest, ...(plan ? { plan } : {}) };
}

/**
 * Pending-action preview fields the dashboard renders. They are ordinary
 * campaign facts — a name, an objective, a budget, a status, an id — and carry
 * no typed browser value. A browser/desktop action gets no preview at all.
 */
const SAFE_PENDING_SCALARS = ["name", "objective", "dailyBudget", "status", "campaignId"] as const;
const SAFE_PROPOSAL_FIELDS = ["name", "objective", "daily_budget", "status"] as const;

function pendingPreview(toolId: string, params: Record<string, unknown>): Record<string, unknown> {
  // A browser action's parameters ARE the sensitive payload: typed text, a
  // selected value, nested submitted fields. Never project any of it, even a
  // key whose name happens to look safe.
  if (isComputerControlAction(toolId)) return {};

  const out: Record<string, unknown> = {};
  for (const key of SAFE_PENDING_SCALARS) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  if (isRecord(params.proposal)) {
    const proposal: Record<string, unknown> = {};
    for (const key of SAFE_PROPOSAL_FIELDS) {
      if (params.proposal[key] !== undefined) proposal[key] = params.proposal[key];
    }
    if (Object.keys(proposal).length > 0) out.proposal = proposal;
  }
  // Memory commands carry ids/versions/scope; non-sensitive and needed by
  // existing pending-action flows and tests.
  for (const key of ["memoryId", "memoryIds", "version", "versions", "sourceMessageId", "scope"]) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  return out;
}

export type ClientPendingAction = Omit<PendingAction, "params"> & {
  params: Record<string, unknown>;
};

/**
 * A pending action with a safe preview. The id, tool, state, approval id and
 * expiry are unchanged, so confirm/reject/modify keep working; only the raw
 * parameters are reduced.
 */
export function clientPendingAction(pending: PendingAction): ClientPendingAction {
  return { ...pending, params: pendingPreview(pending.toolId, pending.params) };
}

/**
 * The fields of a pending action a chat client may see, by name. What the card
 * needs to identify, explain and answer it — never anything else, so a field
 * added to the orchestrator's copy later does not silently become output.
 */
const CHAT_PENDING_ACTION_FIELDS = [
  "id",
  "toolId",
  "action",
  "riskLevel",
  "state",
  "approvalId",
  "expiresAt",
  "summary",
  "needsIndependentApproval",
] as const;

/**
 * Phase 19.1 (C1, the chat path) — a pending action as it rides chat
 * metadata: the orchestrator's presentation copy, or one stored in a message
 * before this projection existed. An allowlist of fields plus the same preview
 * `clientPendingAction` gives. A malformed one keeps no parameters at all.
 *
 * Execution never reads this copy: a confirmation runs the pending-action row,
 * whose parameters stay server-side.
 */
export function clientPendingActionRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of CHAT_PENDING_ACTION_FIELDS) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  const toolId = typeof value.toolId === "string" ? value.toolId : null;
  out.params = toolId && isRecord(value.params) ? pendingPreview(toolId, value.params) : {};
  return out;
}

/**
 * A message's metadata as a client may see it, and as the chat route stores
 * it. Only the pending action is reduced — at the top level, and inside
 * `model`, where the chat route keeps the orchestrator's whole metadata.
 * Everything else (trace id, surface, tool summary, task id) is unchanged.
 */
export function clientMessageMetadata<T>(metadata: T): T {
  if (!isRecord(metadata)) return metadata;
  let out: Record<string, unknown> | null = null;
  const copy = () => (out ??= { ...metadata });
  if (metadata.pendingAction !== undefined) {
    copy().pendingAction = clientPendingActionRecord(metadata.pendingAction);
  }
  const model = metadata.model;
  if (isRecord(model) && model.pendingAction !== undefined) {
    copy().model = { ...model, pendingAction: clientPendingActionRecord(model.pendingAction) };
  }
  return (out ?? metadata) as T;
}
