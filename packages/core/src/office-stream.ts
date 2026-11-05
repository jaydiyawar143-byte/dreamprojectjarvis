// ---------------------------------------------------------------------------
// VO-2 — the Virtual Office's live stream contract.
//
// The office already has three honest HTTP reads (`/agents`, `/tasks`,
// `/activity`). This file adds the fourth thing it needs: a small, fixed set of
// events it may receive over the socket the app already authenticates.
//
// TWO RULES ARE BUILT IN HERE, NOT AT THE EDGE.
//
//   1. AN ALLOWLIST, NOT A PROJECTION OF WHATEVER ARRIVED. Each event is
//      constructed field by field. A raw audit row, an approval, a task title
//      or a tool parameter has nowhere to go: there is no spread of the input
//      anywhere in this file. Redaction at write time is a second net, not the
//      one this contract relies on.
//
//   2. ONE USER, ONE ROOM. The event carries no `userId` at all. Routing is the
//      socket layer's job (`userRoom`), so a payload cannot name a recipient
//      and a bug here cannot widen an audience.
//
// The event names live here too, so the server's policy list and the browser's
// subscription cannot drift into two spellings of the same channel.
// ---------------------------------------------------------------------------

import type { AuditEntry } from "./types/common.js";
import type { TaskStatus } from "./types/task.js";

/** Server -> client. One office event. */
export const OFFICE_STREAM_EVENT = "office:event" as const;
/** Client -> server. Start receiving office events for the authenticated user. */
export const OFFICE_SUBSCRIBE_EVENT = "office:subscribe" as const;
/** Client -> server. Stop receiving them. */
export const OFFICE_UNSUBSCRIBE_EVENT = "office:unsubscribe" as const;

/**
 * Runtime vocabularies. The TypeScript types constrain the writers; these sets
 * constrain what a decoder will accept from the wire.
 *
 * `OFFICE_TASK_STATUSES` is checked against core's `TaskStatusSchema` by the
 * API's office-stream test, so adding a lifecycle state cannot silently make
 * those events undecodable.
 */
const ACTIVITY_RESULTS = new Set(["success", "failure", "rejected", "pending"]);
const OFFICE_TASK_STATUSES = new Set([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "UNRESOLVED",
]);

export type OfficeActivityResult = "success" | "failure" | "rejected" | "pending";

/**
 * A durable audit row, reduced to what the office is allowed to show.
 *
 * `agentId` is only present when the row genuinely named one. `toolId` is the
 * registered tool's id, never its parameters. `executionId` and `durationMs`
 * are copied from the row's metadata one key at a time; no other metadata
 * reaches this type.
 */
export interface OfficeActivityEvent {
  kind: "activity";
  /** The audit row's own id. The office dedupes on this. */
  id: string;
  /** ISO-8601 instant of the audit row. */
  at: string;
  action: string;
  result: OfficeActivityResult;
  agentId?: string;
  toolId?: string;
  traceId?: string;
  executionId?: string;
  durationMs?: number;
}

/**
 * A durable task lifecycle change.
 *
 * Deliberately carries NO title, description, error text or `createdBy`. The
 * task engine records no agent on a task, so an event cannot attribute one
 * either. A page that wants the title reads `GET /tasks`, which is already
 * scoped to its owner.
 */
export interface OfficeTaskEvent {
  kind: "task";
  /** Deterministic from the durable row: task + status + transition instant. */
  id: string;
  /** ISO-8601 instant the row moved (its `updatedAt`). */
  at: string;
  taskId: string;
  status: TaskStatus;
  executionId?: string;
}

export type OfficeStreamEvent = OfficeActivityEvent | OfficeTaskEvent;

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

/** Longest identifier or action string worth carrying. */
const MAX_TEXT = 512;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT) return undefined;
  return trimmed;
}

function instant(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** A duration is a fact only when it is a finite, non-negative number. */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
function duration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > MAX_DURATION_MS) return undefined;
  return value;
}

function isActivityResult(value: unknown): value is OfficeActivityResult {
  return typeof value === "string" && ACTIVITY_RESULTS.has(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && OFFICE_TASK_STATUSES.has(value);
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * The one projection from an audit row to an office event.
 *
 * Exported for the API's composition root, which hands it to `AuditLogger` as
 * a post-write observer, and for the tests that pin what it must never carry.
 */
export type OfficeActivitySource = Pick<
  AuditEntry,
  "id" | "timestamp" | "action" | "result" | "agentId" | "toolId" | "traceId" | "metadata"
>;

export function officeActivityEvent(entry: OfficeActivitySource): OfficeActivityEvent | null {
  const id = text(entry.id);
  const at = instant(entry.timestamp);
  const action = text(entry.action);
  if (!id || !at || !action || !isActivityResult(entry.result)) return null;

  const agentId = text(entry.agentId);
  const toolId = text(entry.toolId);
  const traceId = text(entry.traceId);
  // Only these two keys are read from metadata. Everything else — error text,
  // a request body, a provider response — is dropped here rather than at a
  // serialisation boundary someone could forget.
  const executionId = text(entry.metadata?.executionId);
  const durationMs = duration(entry.metadata?.durationMs);

  return {
    kind: "activity",
    id,
    at,
    action,
    result: entry.result,
    ...(agentId ? { agentId } : {}),
    ...(toolId ? { toolId } : {}),
    ...(traceId ? { traceId } : {}),
    ...(executionId ? { executionId } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export interface OfficeTaskSource {
  id: string;
  status: TaskStatus;
  /** The durable row's `updatedAt`. */
  updatedAt: Date | string;
  executionId?: string | null;
}

/**
 * The one projection from a task row to an office event.
 *
 * The row's title and error are NOT arguments to this function, which is the
 * strongest form the "never send them" rule can take.
 */
export function officeTaskEvent(task: OfficeTaskSource): OfficeTaskEvent | null {
  const taskId = text(task.id);
  const at = instant(task.updatedAt);
  if (!taskId || !at || !isTaskStatus(task.status)) return null;

  const executionId = text(task.executionId ?? undefined);

  return {
    kind: "task",
    id: `task:${taskId}:${task.status}:${at}`,
    at,
    taskId,
    status: task.status,
    ...(executionId ? { executionId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Validates a payload received over the wire and rebuilds it from the
 * allowlist.
 *
 * The server is ours, so this is defence in depth rather than mistrust: a
 * browser that reconnects to an older or newer API must never copy an unknown
 * field into a rendered row. Unknown fields are dropped, malformed events are
 * ignored, and the returned object is always a fresh one.
 */
export function parseOfficeStreamEvent(value: unknown): OfficeStreamEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.kind === "activity") {
    const id = text(record.id);
    const at = instant(record.at);
    const action = text(record.action);
    if (!id || !at || !action || !isActivityResult(record.result)) return null;

    const agentId = text(record.agentId);
    const toolId = text(record.toolId);
    const traceId = text(record.traceId);
    const executionId = text(record.executionId);
    const durationMs = duration(record.durationMs);

    return {
      kind: "activity",
      id,
      at,
      action,
      result: record.result,
      ...(agentId ? { agentId } : {}),
      ...(toolId ? { toolId } : {}),
      ...(traceId ? { traceId } : {}),
      ...(executionId ? { executionId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  if (record.kind === "task") {
    const taskId = text(record.taskId);
    const at = instant(record.at);
    if (!taskId || !at || !isTaskStatus(record.status)) return null;

    const executionId = text(record.executionId);

    return {
      kind: "task",
      // Recomputed rather than trusted, so two deliveries of the same durable
      // transition decode to the same dedupe key.
      id: `task:${taskId}:${record.status}:${at}`,
      at,
      taskId,
      status: record.status,
      ...(executionId ? { executionId } : {}),
    };
  }

  return null;
}
