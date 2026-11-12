// ---------------------------------------------------------------------------
// VO-1 — the Virtual Office model.
//
// This file is PURE: it takes the three reads the server already exposes
// (`GET /agents`, `GET /tasks`, `GET /activity`) and derives what the office
// may say. It performs no I/O and invents nothing.
//
// THE RULE IT ENFORCES. A row is a fact; a state is a claim. The office may
// only claim:
//
//   * an agent is REGISTERED — from `AgentSummary.registered` (live registry);
//   * a task is PENDING or RUNNING — from `Task.status` in the task engine;
//   * an agent's last recorded action — from the newest audit row naming it.
//
// It may NOT claim "working", "progress" or "paused" for an agent, because:
//
//   - there is no durable start row for a conversational turn, and the
//     `orchestrator.process` row is written when the turn ENDS;
//   - `Task` carries no `agentId`, so a scheduled or REST task run has no
//     agent attribution at all;
//   - the task lifecycle has no PAUSED state and no progress measure.
//
// So an agent actor can be idle, recently finished, waiting, or in need of
// attention — and never "working". Only the JARVIS system actor may be shown
// as working, and only from a real `Task.status === "RUNNING"` row.
// ---------------------------------------------------------------------------

import type { ActivityEntry, AgentSummary, TaskRecord, TaskStatusCounts } from "@/lib/api";
import type { OfficeStreamEvent, OfficeTaskEvent } from "@jarvis/core/office-stream";

export type DepartmentId =
  | "command-center"
  | "development-lab"
  | "marketing-hub"
  | "research-lab"
  | "conference-room"
  | "break-zone";

export interface OfficeDepartment {
  id: DepartmentId;
  label: string;
  purpose: string;
}

/**
 * The floor plan. Fixed, because a room is not a claim about data — it is the
 * place the data is laid out in. Every agent is mapped to exactly one.
 */
export const OFFICE_DEPARTMENTS: readonly OfficeDepartment[] = [
  {
    id: "command-center",
    label: "Command Center",
    purpose: "Routing, coordination and system work",
  },
  {
    id: "development-lab",
    label: "Development Lab",
    purpose: "Automation, browser and desktop tooling",
  },
  {
    id: "marketing-hub",
    label: "Marketing Hub",
    purpose: "Meta Ads, Google Ads and marketing",
  },
  {
    id: "research-lab",
    label: "Research Lab",
    purpose: "Knowledge and analytics",
  },
  {
    id: "conference-room",
    label: "Conference Room",
    purpose: "Communication and meetings",
  },
  {
    id: "break-zone",
    label: "Break Zone",
    purpose: "Unassigned space — no agent is stationed here",
  },
] as const;

/**
 * Where a registered agent sits.
 *
 * The domain vocabulary is the one the server publishes today
 * (`packages/agents/src/agent-policy.ts`, eleven agents). An unknown domain
 * falls back to the Command Center rather than being hidden: the agent is
 * real, and only its desk assignment is a presentation choice.
 */
const DOMAIN_DEPARTMENT: Record<string, DepartmentId> = {
  general: "command-center",
  location: "command-center",
  "meta-ads": "marketing-hub",
  "google-ads": "marketing-hub",
  marketing: "marketing-hub",
  knowledge: "research-lab",
  analytics: "research-lab",
  automation: "development-lab",
  browser: "development-lab",
  desktop: "development-lab",
  communication: "conference-room",
};

export function departmentForDomain(domain: string): DepartmentId {
  return DOMAIN_DEPARTMENT[domain] ?? "command-center";
}

/** "meta-ads-agent" -> "Meta Ads Agent". A label, never a new identity. */
export function displayAgentName(agentId: string): string {
  return agentId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * An agent's visible state.
 *
 * `idle` is the only state that permits decorative movement, and the legend
 * says so. There is deliberately no `working` and no `paused` member: adding
 * one later without a real source would be a fabricated status.
 */
export type OfficeAgentState = "idle" | "recent" | "attention" | "waiting";

/** Only the system actor may be `working`, and only from a RUNNING task. */
export type OfficeSystemState = "idle" | "queued" | "working";

export interface OfficeAgentActor {
  kind: "agent";
  /** The registry id, never a display-only invention. */
  id: string;
  label: string;
  domain: string;
  department: DepartmentId;
  state: OfficeAgentState;
  stateLabel: string;
  lastActivityAt: string | null;
  lastSummary: string | null;
  toolCount: number;
  approvedWrites: boolean;
  /** True only for `idle`: the one state where motion is decorative. */
  decorative: boolean;
}

export interface OfficeSystemActor {
  kind: "system";
  id: "jarvis";
  label: "JARVIS";
  state: OfficeSystemState;
  stateLabel: string;
  pending: number;
  running: number;
  completed: number;
  /**
   * VO-2.1 — true when `pending`, `running` and `completed` are the task
   * engine's totals; false when only the listed rows could be counted, because
   * the API sent no totals. The page says which.
   */
  countsAreTotals: boolean;
  /** The task engine attributes no agent to these runs. */
  attribution: "system";
  decorative: false;
}

export type OfficeSelection = OfficeAgentActor | OfficeSystemActor;

// ---------------------------------------------------------------------------
// Event rows
// ---------------------------------------------------------------------------

export type OfficeEventResult =
  | "success"
  | "failure"
  | "rejected"
  | "pending"
  | "queued"
  | "running";

export interface OfficeEventRow {
  id: string;
  at: string;
  actorId: string;
  actorLabel: string;
  actorKind: "agent" | "system";
  /** False when the row names no registered agent; it is JARVIS work. */
  attributed: boolean;
  summary: string;
  result: OfficeEventResult;
  source: "audit" | "task";
}

export interface OfficeCounts {
  availableAgents: number;
  unavailableAgents: number;
  pending: number;
  running: number;
  completed: number;
  /** VO-2.1 — see `OfficeSystemActor.countsAreTotals`. */
  tasksAreTotals: boolean;
}

export interface OfficeModel {
  departments: Array<OfficeDepartment & { actors: OfficeAgentActor[] }>;
  agents: OfficeAgentActor[];
  system: OfficeSystemActor;
  events: OfficeEventRow[];
  unavailableAgents: AgentSummary[];
  counts: OfficeCounts;
  /** ISO instant the model was derived at, so the UI can say "as of". */
  generatedAt: string;
}

export interface OfficeModelInput {
  agents: AgentSummary[];
  tasks: TaskRecord[];
  activity: ActivityEntry[];
  /**
   * VO-2.1 — the server's per-state totals (already validated by
   * `parseTaskStatusCounts`, and adjusted by `overlayTaskCounts` for live
   * moves). Without them the system actor counts the listed rows, which the
   * list's cap bounds, and says so through `countsAreTotals`.
   */
  taskCounts?: TaskStatusCounts | null;
  /** Injectable clock, so the tests are deterministic. */
  now?: number;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** How long "just finished" / "needs attention" may be claimed. */
export const RECENT_WINDOW_MS = 10 * 60_000;

/**
 * "Waiting for approval" is claimed only from a very fresh `pending` audit row.
 *
 * This is deliberately short. Approvals are decided by `POST /approvals/:id/*`,
 * which does not copy `agentId` onto its audit row, so an older pending row
 * cannot be re-checked from `/activity` alone. Rather than show a stale
 * "waiting", the actor falls back to idle. VO-3 reads the Approval table,
 * which is the authoritative source.
 */
export const WAITING_WINDOW_MS = 2 * 60_000;

/** How many combined rows the event list keeps. */
export const OFFICE_EVENT_LIMIT = 40;

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function ageOf(value: string | null | undefined, now: number): number | null {
  const at = parseTime(value);
  if (at === null) return null;
  return Math.max(0, now - at);
}

function statusOf(task: TaskRecord): string {
  return typeof task.status === "string" ? task.status : "";
}

// ---------------------------------------------------------------------------
// Summaries — fixed copy from real fields, never free text from a model
// ---------------------------------------------------------------------------

const ACTION_LABEL: Record<string, string> = {
  "tool.execute": "Ran a tool",
  "orchestrator.process": "Handled a request",
  "task.create": "Recorded a task",
  "approval.approve": "Approved an action",
  "approval.reject": "Rejected an action",
  "agent.tool_denied": "A tool call was denied",
  "agent.tool_unavailable": "A tool was unavailable",
  "agent.tool_voice_refused": "A spoken action was refused",
  "agent.tool_desktop_refused": "A desktop action was refused",
  "agent.approval_gate_missing": "An approval gate was missing",
  "agent.tool_role_denied": "A role denied a tool",
  "agent.tool_access_denied": "Access denied a tool",
  "pending_action.voice_confirmation_refused": "A spoken confirmation was refused",
};

export function describeActivityAction(entry: ActivityEntry): string {
  if (entry.action === "tool.execute" && entry.toolId) return `Ran ${entry.toolId}`;
  return ACTION_LABEL[entry.action] ?? entry.action;
}

/** The single result vocabulary the UI renders. Never a percentage. */
function resultOf(entry: ActivityEntry): OfficeEventResult {
  return entry.result;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function latestForAgent(
  activity: ActivityEntry[],
  agentId: string
): ActivityEntry | undefined {
  return activity.find((entry) => entry.agentId === agentId);
}

function agentState(
  latest: ActivityEntry | undefined,
  now: number
): { state: OfficeAgentState; label: string } {
  if (!latest) return { state: "idle", label: "Idle" };

  const age = ageOf(latest.timestamp, now);

  if (age !== null && age <= WAITING_WINDOW_MS && latest.result === "pending") {
    return { state: "waiting", label: "Waiting for approval" };
  }
  if (age !== null && age <= RECENT_WINDOW_MS) {
    if (latest.result === "success") return { state: "recent", label: "Just finished" };
    if (latest.result === "failure" || latest.result === "rejected") {
      return { state: "attention", label: "Needs attention" };
    }
  }
  return { state: "idle", label: "Idle" };
}

function buildAgentActor(
  agent: AgentSummary,
  activity: ActivityEntry[],
  now: number
): OfficeAgentActor {
  const latest = latestForAgent(activity, agent.agentId);
  const { state, label } = agentState(latest, now);

  return {
    kind: "agent",
    id: agent.agentId,
    label: displayAgentName(agent.agentId),
    domain: agent.domain,
    department: departmentForDomain(agent.domain),
    state,
    stateLabel: label,
    lastActivityAt: latest?.timestamp ?? null,
    lastSummary: latest ? describeActivityAction(latest) : null,
    toolCount: agent.toolCount,
    approvedWrites: agent.writesRequireApproval,
    // Motion is decorative in exactly one state, and the legend says what it
    // means. A real event removes the pulse rather than adding one.
    decorative: state === "idle",
  };
}

function buildSystemActor(
  tasks: TaskRecord[],
  totals: TaskStatusCounts | null
): OfficeSystemActor {
  // VO-2.1 — the server's totals when it sent them. Counting the listed rows
  // is the fallback for an older API only: the list is capped, so past the cap
  // that count stops growing.
  const listed = (status: string) => tasks.filter((task) => statusOf(task) === status).length;
  const pending = totals ? totals.PENDING : listed("PENDING");
  const running = totals ? totals.RUNNING : listed("RUNNING");
  const completed = totals ? totals.COMPLETED : listed("COMPLETED");

  const state: OfficeSystemState =
    running > 0 ? "working" : pending > 0 ? "queued" : "idle";

  const stateLabel =
    running > 0
      ? `Working on ${running} ${running === 1 ? "task" : "tasks"}`
      : pending > 0
        ? `${pending} ${pending === 1 ? "task" : "tasks"} queued`
        : "No work queued";

  return {
    kind: "system",
    id: "jarvis",
    label: "JARVIS",
    state,
    stateLabel,
    pending,
    running,
    completed,
    countsAreTotals: totals !== null,
    attribution: "system",
    decorative: false,
  };
}

function taskEvent(task: TaskRecord): OfficeEventRow | null {
  const status = statusOf(task);
  if (status !== "PENDING" && status !== "RUNNING") return null;

  const at =
    status === "RUNNING"
      ? task.startedAt ?? task.createdAt
      : task.scheduledAt ?? task.createdAt;

  return {
    id: `task:${task.id}`,
    at,
    actorId: "jarvis",
    actorLabel: "JARVIS",
    actorKind: "system",
    // The task engine records no agent for a task run, so this is system work.
    attributed: false,
    summary: status === "RUNNING" ? `Running: ${task.title}` : `Queued: ${task.title}`,
    result: status === "RUNNING" ? "running" : "queued",
    source: "task",
  };
}

function auditEvent(
  entry: ActivityEntry,
  registeredIds: ReadonlySet<string>
): OfficeEventRow {
  const attributed =
    typeof entry.agentId === "string" && registeredIds.has(entry.agentId);

  return {
    id: `audit:${entry.id}`,
    at: entry.timestamp,
    actorId: attributed ? (entry.agentId as string) : "jarvis",
    actorLabel: attributed ? displayAgentName(entry.agentId as string) : "JARVIS",
    actorKind: attributed ? "agent" : "system",
    attributed,
    summary: describeActivityAction(entry),
    result: resultOf(entry),
    source: "audit",
  };
}

/**
 * Build the office from the three real reads.
 *
 * Ordering is stable and descending by time. Anything that cannot be placed on
 * the timeline (an unparseable timestamp) sorts last rather than being guessed
 * to "now".
 */
export function buildOfficeModel(input: OfficeModelInput): OfficeModel {
  const now = input.now ?? Date.now();

  const registered = input.agents
    .filter((agent) => agent.registered)
    .sort((a, b) => a.agentId.localeCompare(b.agentId));

  const unavailableAgents = input.agents
    .filter((agent) => !agent.registered)
    .sort((a, b) => a.agentId.localeCompare(b.agentId));

  const registeredIds = new Set(registered.map((agent) => agent.agentId));

  // The server returns newest first; re-sorting makes the model independent of
  // transport ordering and gives the tests one rule to assert.
  const activity = [...input.activity].sort((a, b) => {
    const left = parseTime(a.timestamp) ?? 0;
    const right = parseTime(b.timestamp) ?? 0;
    return right - left;
  });

  const actors = registered.map((agent) => buildAgentActor(agent, activity, now));
  const system = buildSystemActor(input.tasks, input.taskCounts ?? null);

  const byDepartment = new Map<DepartmentId, OfficeAgentActor[]>();
  for (const actor of actors) {
    const current = byDepartment.get(actor.department) ?? [];
    current.push(actor);
    byDepartment.set(actor.department, current);
  }

  const departments = OFFICE_DEPARTMENTS.map((department) => ({
    ...department,
    actors: byDepartment.get(department.id) ?? [],
  }));

  const events = [
    ...input.tasks.map(taskEvent).filter((event): event is OfficeEventRow => event !== null),
    ...activity.map((entry) => auditEvent(entry, registeredIds)),
  ]
    .sort((a, b) => {
      const left = parseTime(a.at) ?? 0;
      const right = parseTime(b.at) ?? 0;
      return right - left;
    })
    .slice(0, OFFICE_EVENT_LIMIT);

  return {
    departments,
    agents: actors,
    system,
    events,
    unavailableAgents,
    counts: {
      availableAgents: registered.length,
      unavailableAgents: unavailableAgents.length,
      pending: system.pending,
      running: system.running,
      completed: system.completed,
      tasksAreTotals: system.countsAreTotals,
    },
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * The newest instant a task row is known to have changed.
 *
 * The wire type carries no `updatedAt`, so this is derived from the three
 * timestamps a read actually gives us. It is only used to refuse an overlay
 * older than the row it would replace.
 */
function taskTransitionAt(task: TaskRecord): number {
  return Math.max(
    parseTime(task.createdAt) ?? 0,
    parseTime(task.startedAt) ?? 0,
    parseTime(task.completedAt) ?? 0
  );
}

/**
 * Merge the live activity events into the list `GET /activity` returned.
 *
 * Keyed by the audit row's id, so a row that arrives twice is one row, and a
 * live row the read already contained simply keeps the same content. The read
 * stays authoritative for anything older than the socket connection.
 */
export function mergeOfficeActivity(
  base: readonly ActivityEntry[],
  live: readonly OfficeStreamEvent[],
  limit = 200
): ActivityEntry[] {
  const byId = new Map<string, ActivityEntry>();
  for (const entry of base) byId.set(entry.id, entry);

  for (const event of live) {
    if (event.kind !== "activity") continue;
    byId.set(event.id, {
      id: event.id,
      timestamp: event.at,
      action: event.action,
      result: event.result,
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.toolId ? { toolId: event.toolId } : {}),
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.executionId ? { executionId: event.executionId } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    });
  }

  return [...byId.values()]
    .sort((a, b) => (parseTime(b.timestamp) ?? 0) - (parseTime(a.timestamp) ?? 0))
    .slice(0, limit);
}

/**
 * Apply live lifecycle changes to the task list the server returned.
 *
 * An overlay never invents a row: a task the read did not include is left
 * for the page's next read, because the event carries no title and the office
 * will not render an unnamed task. An overlay older than the row's last known
 * transition is ignored, so a delayed event cannot move a completed task back
 * to RUNNING.
 */
export function applyTaskOverlay(
  tasks: readonly TaskRecord[],
  updates: ReadonlyMap<string, OfficeTaskEvent>
): TaskRecord[] {
  if (updates.size === 0) return [...tasks];

  return tasks.map((task) => {
    const update = updates.get(task.id);
    if (!update) return task;

    const at = parseTime(update.at);
    if (at === null || at < taskTransitionAt(task)) return task;

    return {
      ...task,
      status: update.status,
      ...(update.status === "RUNNING" && !task.startedAt ? { startedAt: update.at } : {}),
      ...(update.status === "COMPLETED" && !task.completedAt ? { completedAt: update.at } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// VO-2.1 — task totals
// ---------------------------------------------------------------------------

const LIFECYCLE_STATES = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "UNRESOLVED"] as const;

function isLifecycleState(value: string): value is (typeof LIFECYCLE_STATES)[number] {
  return (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * Validates the server's `statusCounts` and rebuilds them from the five
 * lifecycle states.
 *
 * All or nothing: every state must be a finite, non-negative integer, or the
 * whole value is refused (null) and the office falls back to — and says it
 * is using — the listed rows. A half-valid total is not a total. Unknown keys
 * are dropped, and the result is always a fresh object.
 */
export function parseTaskStatusCounts(value: unknown): TaskStatusCounts | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const counts = {} as TaskStatusCounts;
  for (const state of LIFECYCLE_STATES) {
    const count = record[state];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
    counts[state] = count;
  }
  return counts;
}

/**
 * Moves the server's totals by the live transitions the overlay applied.
 *
 * `before` is the list the read returned and `after` is the same list with
 * `applyTaskOverlay` applied. Each listed task whose state the overlay changed
 * moves one from its old state's total to its new one, so a live
 * PENDING -> RUNNING shows at once without waiting for the next read.
 *
 * Only listed tasks can move a total: a live event for a task beyond the
 * list's cap changes nothing here, and the page's debounced re-read brings
 * the totals up to date. No total goes below zero. The two server reads (list
 * and totals) are not one snapshot, so this is presentation between reads,
 * never a replacement for them.
 */
export function overlayTaskCounts(
  totals: TaskStatusCounts,
  before: readonly TaskRecord[],
  after: readonly TaskRecord[]
): TaskStatusCounts {
  const next: TaskStatusCounts = { ...totals };
  const previous = new Map(before.map((task) => [task.id, statusOf(task)]));

  for (const task of after) {
    const from = previous.get(task.id);
    const to = statusOf(task);
    if (from === undefined || from === to) continue;
    if (!isLifecycleState(from) || !isLifecycleState(to)) continue;
    next[from] = Math.max(0, next[from] - 1);
    next[to] += 1;
  }
  return next;
}

/** Selection lookup for the details panel. */
export function findOfficeActor(model: OfficeModel, id: string | null): OfficeSelection | null {
  if (!id) return null;
  if (model.system.id === id) return model.system;
  return model.agents.find((actor) => actor.id === id) ?? null;
}
