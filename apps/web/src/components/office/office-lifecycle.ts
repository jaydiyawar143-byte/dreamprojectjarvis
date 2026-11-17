// ---------------------------------------------------------------------------
// VO-3.1 — an agent's lifecycle, from durable facts only.
//
// PURE: no I/O, no React, no clock of its own. Three steps:
//
//   1. `parseAgentWork`      validate the server's per-agent read field by
//                            field (an older or newer API never puts an unknown
//                            field on screen);
//   2. `overlayAgentWork`    apply live task events (newest per task) on top of
//                            that read, so a start or a finish shows at once;
//                            an event older than the read is ignored;
//   3. `deriveLifecycle`     turn one agent's facts into one state.
//
// THE STATES AND THEIR ONLY SOURCES.
//
//   working | researching | using_tool
//                 a RUNNING task assigned to the agent. "researching" when its
//                 tool's declared registry risk is READ_ONLY; "using_tool" when
//                 the tool is known and not read-only; "working" when the row
//                 names no tool (a run recorded before VO-3.1).
//   waiting_for_approval
//                 a PENDING, unexpired approval the agent asked for (the
//                 Approval table, via the read), or — while that read is not
//                 available — the agent's own fresh `pending` audit row.
//   assigned      a PENDING assigned task the scheduler has claimed.
//   queued        a PENDING assigned task due now or within QUEUE_HORIZON_MS.
//   failed        its newest finished task FAILED or UNRESOLVED, or its newest
//                 audit row failed or was refused, within RECENT_WINDOW_MS.
//   completed     its newest finished task COMPLETED, or its newest audit row
//                 succeeded, within RECENT_WINDOW_MS.
//   idle          none of the above.
//
// There is NO paused state: the task engine has none. Returning to a desk is
// not a state here at all — it is movement, decided by the renderer when a
// real state above arrives while the figure is away on a decorative activity.
// ---------------------------------------------------------------------------

import type { OfficeTaskEvent } from "@jarvis/core/office-stream";
import type { OfficeAgentWork, OfficeAgentWorkView, OfficeTaskView } from "@/lib/api";

export type OfficeAgentLifecycle =
  | "idle"
  | "queued"
  | "assigned"
  | "working"
  | "researching"
  | "using_tool"
  | "waiting_for_approval"
  | "completed"
  | "failed";

/** States in which the agent belongs at its desk, doing or about to do real work. */
export const DESK_BOUND: ReadonlySet<OfficeAgentLifecycle> = new Set([
  "queued",
  "assigned",
  "working",
  "researching",
  "using_tool",
  "waiting_for_approval",
  "failed",
]);

/** States backed by a running task: the only ones that may animate typing. */
export const EXECUTING: ReadonlySet<OfficeAgentLifecycle> = new Set(["working", "researching", "using_tool"]);

/** How far ahead a scheduled task counts as "queued" rather than merely planned. */
export const QUEUE_HORIZON_MS = 10 * 60_000;

/** Same window the VO-1 model uses for "just finished" / "needs attention". */
export const LIFECYCLE_RECENT_WINDOW_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// 1. Parse
// ---------------------------------------------------------------------------

const MAX_TEXT = 512;
const MAX_TITLE = 300;

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? null : trimmed;
}

function instant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function taskView(value: unknown): OfficeTaskView | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const taskId = text(v.taskId);
  const status = text(v.status);
  if (!taskId || !status) return null;
  return {
    taskId,
    // A long title is shortened, not dropped: it is the user's own words.
    title: typeof v.title === "string" ? v.title.trim().slice(0, MAX_TITLE) : "",
    status,
    executionId: text(v.executionId),
    toolId: text(v.toolId),
    toolRisk: text(v.toolRisk),
    assignedAt: instant(v.assignedAt),
    startedAt: instant(v.startedAt),
    scheduledAt: instant(v.scheduledAt),
    claimed: v.claimed === true,
    finishedAt: instant(v.finishedAt),
    error: typeof v.error === "string" ? v.error.slice(0, 1000) : null,
  };
}

/** Validates the server's per-agent read. Null when it is not one. */
export function parseAgentWork(value: unknown): OfficeAgentWorkView | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.agents)) return null;
  const generatedAt = instant(v.generatedAt);
  if (!generatedAt) return null;

  const agents: OfficeAgentWork[] = [];
  for (const raw of v.agents) {
    if (typeof raw !== "object" || raw === null) continue;
    const a = raw as Record<string, unknown>;
    const agentId = text(a.agentId);
    if (!agentId) continue;
    const approvals = a.pendingApprovals as Record<string, unknown> | null | undefined;
    const pending =
      approvals && typeof approvals === "object" && count(approvals.count) > 0
        ? {
            count: count(approvals.count),
            newestAt: instant(approvals.newestAt) ?? generatedAt,
            toolId: text(approvals.toolId) ?? "",
            expiresAt: instant(approvals.expiresAt) ?? generatedAt,
          }
        : null;
    agents.push({
      agentId,
      active: taskView(a.active),
      queuedCount: count(a.queuedCount),
      lastCompleted: taskView(a.lastCompleted),
      lastFailed: taskView(a.lastFailed),
      pendingApprovals: pending,
    });
  }
  return { agents, approvalsRead: v.approvalsRead === true, generatedAt };
}

// ---------------------------------------------------------------------------
// 2. Overlay live task events
// ---------------------------------------------------------------------------

export interface OverlayContext {
  /** Titles the task list knows, by task id. Events carry none. */
  titles: ReadonlyMap<string, string>;
  /** Declared risk by tool id, from the agents read. */
  toolRisk: ReadonlyMap<string, string>;
}

function emptyWork(agentId: string): OfficeAgentWork {
  return { agentId, active: null, queuedCount: 0, lastCompleted: null, lastFailed: null, pendingApprovals: null };
}

/**
 * Applies the newest live event per task on top of the read.
 *
 * An event is applied only when it is NEWER than the read it would change
 * (`at` after `generatedAt`): the read already holds everything committed
 * before it was taken, so an older event is at best a duplicate and at worst
 * a stale state. Events are keyed by task, so one agent's event cannot move
 * another agent — except to take a task OFF an agent it no longer belongs to.
 *
 * Returns a new view; the inputs are not touched.
 */
export function overlayAgentWork(
  view: OfficeAgentWorkView | null,
  updates: ReadonlyMap<string, OfficeTaskEvent>,
  context: OverlayContext
): OfficeAgentWorkView | null {
  if (!view) return null;
  if (updates.size === 0) return view;

  const readAt = Date.parse(view.generatedAt);
  const agents = new Map(view.agents.map((a) => [a.agentId, { ...a }]));
  const agentFor = (agentId: string) => {
    let found = agents.get(agentId);
    if (!found) {
      found = emptyWork(agentId);
      agents.set(agentId, found);
    }
    return found;
  };

  const ordered = [...updates.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of ordered) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at <= readAt) continue;

    // Take the task off any agent that is not the one this event names.
    for (const work of agents.values()) {
      if (work.active?.taskId === event.taskId && work.agentId !== event.agentId) {
        work.active = null;
        work.queuedCount = Math.max(0, work.queuedCount - 1);
      }
    }
    if (!event.agentId) continue;

    const work = agentFor(event.agentId);
    const previous = work.active?.taskId === event.taskId ? work.active : null;
    const base: OfficeTaskView = {
      taskId: event.taskId,
      title: context.titles.get(event.taskId) ?? previous?.title ?? "",
      status: event.status,
      executionId: event.executionId ?? previous?.executionId ?? null,
      toolId: event.toolId ?? previous?.toolId ?? null,
      toolRisk:
        (event.toolId ? context.toolRisk.get(event.toolId) : undefined) ?? previous?.toolRisk ?? null,
      assignedAt: previous?.assignedAt ?? event.at,
      startedAt: event.status === "RUNNING" ? event.at : previous?.startedAt ?? null,
      scheduledAt: previous?.scheduledAt ?? null,
      claimed: previous?.claimed ?? false,
      finishedAt: null,
      error: null,
    };

    if (event.status === "RUNNING") {
      work.active = base;
    } else if (event.status === "PENDING") {
      if (!work.active || work.active.status !== "RUNNING") {
        if (!previous) work.queuedCount += 1;
        work.active = base;
      }
    } else {
      // COMPLETED, FAILED or UNRESOLVED: this task is done.
      if (work.active?.taskId === event.taskId) {
        work.active = null;
        if (previous && previous.status === "PENDING") work.queuedCount = Math.max(0, work.queuedCount - 1);
      }
      const finished = { ...base, startedAt: previous?.startedAt ?? null, finishedAt: event.at };
      if (event.status === "COMPLETED") work.lastCompleted = finished;
      else work.lastFailed = finished;
    }
  }

  return { ...view, agents: [...agents.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)) };
}

// ---------------------------------------------------------------------------
// 3. Derive one agent's state
// ---------------------------------------------------------------------------

/** The VO-1 audit-derived state, which still speaks for conversational turns. */
export type AuditState = "idle" | "recent" | "attention" | "waiting";

export interface LifecycleInput {
  work: OfficeAgentWork | null;
  /** Whether the server could read approvals; when false, the audit heuristic stands in. */
  approvalsRead: boolean;
  auditState: AuditState;
  now: number;
}

export interface LifecycleResult {
  lifecycle: OfficeAgentLifecycle;
  label: string;
  /** The task the state is about, when there is one. */
  task: OfficeTaskView | null;
}

function within(iso: string | null | undefined, now: number, windowMs: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && now - at <= windowMs && now - at >= -60_000;
}

export function deriveLifecycle(input: LifecycleInput): LifecycleResult {
  const { work, now } = input;
  const active = work?.active ?? null;

  if (active && active.status === "RUNNING") {
    if (active.toolId && active.toolRisk === "READ_ONLY") {
      return { lifecycle: "researching", label: `Researching — ${active.toolId}`, task: active };
    }
    if (active.toolId && active.toolRisk) {
      return { lifecycle: "using_tool", label: `Using ${active.toolId}`, task: active };
    }
    return { lifecycle: "working", label: "Working on a task", task: active };
  }

  const approvals = work?.pendingApprovals ?? null;
  if (approvals && Date.parse(approvals.expiresAt) > now) {
    return {
      lifecycle: "waiting_for_approval",
      label: approvals.count === 1 ? "Waiting for approval" : `Waiting for ${approvals.count} approvals`,
      task: null,
    };
  }
  if (!input.approvalsRead && input.auditState === "waiting") {
    return { lifecycle: "waiting_for_approval", label: "Waiting for approval", task: null };
  }

  if (active && active.status === "PENDING") {
    if (active.claimed) return { lifecycle: "assigned", label: "Assigned — starting", task: active };
    const due = active.scheduledAt ? Date.parse(active.scheduledAt) : now;
    if (due <= now + QUEUE_HORIZON_MS) {
      return { lifecycle: "queued", label: "Queued", task: active };
    }
  }

  const failedAt = work?.lastFailed?.finishedAt ?? null;
  const completedAt = work?.lastCompleted?.finishedAt ?? null;
  const taskFailed = within(failedAt, now, LIFECYCLE_RECENT_WINDOW_MS);
  const taskDone = within(completedAt, now, LIFECYCLE_RECENT_WINDOW_MS);

  // The newer of the two task outcomes speaks first; the audit state covers
  // conversational turns, which record no task.
  if (taskFailed && (!taskDone || Date.parse(failedAt!) >= Date.parse(completedAt!))) {
    return { lifecycle: "failed", label: "Task failed", task: work!.lastFailed };
  }
  if (taskDone) return { lifecycle: "completed", label: "Task completed", task: work!.lastCompleted };
  if (input.auditState === "attention") return { lifecycle: "failed", label: "Needs attention", task: null };
  if (input.auditState === "recent") return { lifecycle: "completed", label: "Just finished", task: null };

  return { lifecycle: "idle", label: "Idle", task: null };
}

/** The scheduled task beyond the queue horizon, if that is all the agent has. */
export function upcomingTask(work: OfficeAgentWork | null, now: number): OfficeTaskView | null {
  const active = work?.active;
  if (!active || active.status !== "PENDING" || active.claimed || !active.scheduledAt) return null;
  return Date.parse(active.scheduledAt) > now + QUEUE_HORIZON_MS ? active : null;
}
