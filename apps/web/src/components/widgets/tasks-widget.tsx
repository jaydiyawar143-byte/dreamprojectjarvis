"use client";

// ---------------------------------------------------------------------------
// V3 — tasks and reminders.
//
// Backed by the database, so a reminder survives a closed tab — a reminder that
// lives only in a browser is not a reminder. It is also why JARVIS can create
// one from a spoken request and have it still be there tomorrow.
//
// Grouped OVERDUE / TODAY / UPCOMING because that is the decision the reader is
// making. Bucketing is done from the due date rather than a stored flag, so it
// stays correct as time passes without anything having to run.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  HelpCircle,
  ListTodo,
  Loader,
  Plus,
  X,
} from "lucide-react";
import {
  createTask,
  deleteTask,
  isJarvisTask,
  listTasks,
  updateTask,
  type TaskRecord,
} from "@/lib/api";
import { WidgetShell } from "./widget-shell";

type Bucket = "OVERDUE" | "TODAY" | "UPCOMING" | "SOMEDAY";

/** Which group a task belongs to right now. Pure, so it is testable. */
export function bucketFor(task: TaskRecord, now = new Date()): Bucket {
  if (!task.dueAt) return "SOMEDAY";
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return "SOMEDAY";

  // End of the local day, so "today" means the calendar day the reader is in
  // rather than the next 24 hours.
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  if (due < now) return "OVERDUE";
  if (due <= endOfToday) return "TODAY";
  return "UPCOMING";
}

const BUCKET_LABEL: Record<Bucket, string> = {
  OVERDUE: "Overdue",
  TODAY: "Today",
  UPCOMING: "Upcoming",
  SOMEDAY: "No date",
};

const BUCKET_TONE: Record<Bucket, string> = {
  OVERDUE: "text-red-300/90",
  TODAY: "text-sys-cyan-soft",
  UPCOMING: "text-sys-dim",
  SOMEDAY: "text-sys-dim",
};

// ---------------------------------------------------------------------------
// JARVIS work tasks
//
// A separate section above the buckets, because a work task answers a
// different question. The buckets sort todos by WHEN THEY ARE DUE; a work task
// has no due date at all — it has a lifecycle (has it run? did it work?) and,
// if it is scheduled, an instant it will run at. Folding it into "No date"
// would show it without saying anything true about it.
//
// The rows are READ-ONLY, and rendered without a complete or delete control
// rather than with a disabled one: the server refuses both with a 404, and
// AGENTS.md is explicit that a control which cannot do anything is a lie about
// what the page can change.
// ---------------------------------------------------------------------------

type WorkStatus = "RUNNING" | "PENDING" | "UNRESOLVED" | "FAILED" | "COMPLETED";

/**
 * Order the section is read in: what is happening, then what needs a person,
 * then what is settled.
 *
 * UNRESOLVED sits high deliberately. It is the only state that asks something
 * of the reader - JARVIS will not touch it again, so if anyone is going to
 * find out what happened, it is them.
 */
const WORK_ORDER: WorkStatus[] = ["RUNNING", "PENDING", "UNRESOLVED", "FAILED", "COMPLETED"];

const WORK_LABEL: Record<WorkStatus, string> = {
  RUNNING: "Running",
  PENDING: "Pending",
  // Not "Unknown" and not "Failed": the run happened, and what it did is what
  // is unknown. "Needs checking" says whose problem it is now.
  UNRESOLVED: "Needs checking",
  FAILED: "Failed",
  COMPLETED: "Done",
};

const WORK_TONE: Record<WorkStatus, string> = {
  RUNNING: "text-sys-cyan-soft",
  PENDING: "text-sys-dim",
  // Amber, not red. A failure is settled; this one is still a question.
  UNRESOLVED: "text-amber-300/90",
  FAILED: "text-red-300/90",
  COMPLETED: "text-emerald-300/80",
};

const WORK_DOT: Record<WorkStatus, string> = {
  RUNNING: "bg-sys-cyan-soft",
  PENDING: "bg-sys-dim/70",
  UNRESOLVED: "bg-amber-300/80",
  FAILED: "bg-red-300/80",
  COMPLETED: "bg-emerald-300/70",
};

/** A glyph per state, so the group reads without relying on its colour. */
const WORK_ICON: Record<WorkStatus, typeof Circle> = {
  RUNNING: Loader,
  PENDING: Circle,
  UNRESOLVED: HelpCircle,
  FAILED: AlertTriangle,
  COMPLETED: CheckCircle2,
};

/**
 * The rule that separates the two halves of this widget.
 *
 * Same type face and tracking as the bucket headings, one step brighter and
 * with a hairline after it — enough to say "different kind of thing", not a
 * new visual language. The widget is small, so the separator is a border
 * rather than a spacer.
 */
function SectionHeading({
  label,
  tone,
  testId,
  badge = false,
}: {
  label: string;
  tone: string;
  testId: string;
  badge?: boolean;
}) {
  return (
    <p
      data-testid={testId}
      className={`flex items-center gap-1.5 border-b border-sys-line/60 pb-1 font-mono text-xs uppercase tracking-hud ${tone}`}
    >
      {badge && (
        <span
          data-testid="task-jarvis-badge"
          className="rounded border border-sys-cyan-soft/40 px-1 py-px text-[10px] leading-none"
        >
          JARVIS
        </span>
      )}
      <span>{label}</span>
    </p>
  );
}

/**
 * The lifecycle state to show for a work task.
 *
 * `status` is the authority. `completedAt` is consulted only as a fallback for
 * a row written before the status column existed, so an old task reads as Done
 * rather than as Pending forever.
 */
export function workStatusOf(task: TaskRecord): WorkStatus {
  const status = typeof task.status === "string" ? task.status.toUpperCase() : "";
  if (
    status === "RUNNING" ||
    status === "PENDING" ||
    status === "UNRESOLVED" ||
    status === "FAILED" ||
    status === "COMPLETED"
  ) {
    return status;
  }
  return task.completedAt ? "COMPLETED" : "PENDING";
}

/**
 * "Scheduled 22:45" for today, "Scheduled 23 Sep, 10:00" otherwise.
 *
 * Empty when there is no schedule, which the caller reads as a DIFFERENT
 * thing from "scheduled for a time I could not parse" — both return "", but
 * only the first is a state a task is legitimately in.
 */
export function scheduledLabel(task: TaskRecord, now = new Date()): string {
  if (!task.scheduledAt) return "";
  const at = new Date(task.scheduledAt);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay = at.toDateString() === now.toDateString();
  const when = sameDay
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
  return `Scheduled ${when}`;
}

/**
 * The one secondary line under a work task's title.
 *
 * WHY "UNSCHEDULED" IS A LABEL AND NOT A STATUS. A PENDING task with no
 * `scheduledAt` is a real state the database is in: work that was recorded but
 * never given a time, including the historical rows created before the
 * scheduler stopped putting the time phrase into the goal. Nothing will ever
 * pick those up, and showing them as plain "Pending" implies a run that is
 * coming. This says so on screen and changes nothing underneath — the row
 * stays PENDING in the database, and the scheduler's rules are untouched.
 */
export function workDetailOf(task: TaskRecord, status: WorkStatus, now = new Date()): string {
  if (status === "UNRESOLVED") {
    // The reason says what is UNKNOWN. It must never read as "this failed",
    // because the work may well have happened.
    const reason = task.error?.trim();
    return reason ?? "Outcome unknown - JARVIS will not repeat this.";
  }
  if (status === "FAILED") {
    const reason = task.error?.trim();
    return reason ? `Failed — ${reason}` : "Failed";
  }
  const scheduled = scheduledLabel(task, now);
  if (scheduled) return scheduled;
  if (status === "PENDING") return "Unscheduled";
  return "";
}

function dueLabel(task: TaskRecord): string {
  if (!task.dueAt) return "";
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return "";
  const today = new Date();
  const sameDay = due.toDateString() === today.toDateString();
  return sameDay
    ? due.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : due.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function TasksWidget() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftDue, setDraftDue] = useState("");

  const load = useCallback(async () => {
    setError(null);
    // Completed rows ARE fetched, because a finished JARVIS run is exactly the
    // thing worth seeing — "did it work?" is the question the section answers.
    // Completed TODOS are then dropped below, so the buckets keep behaving as
    // they always have: this widens what is fetched, not what is shown there.
    const res = await listTasks(true);
    if (res.success && res.data) setTasks(res.data.tasks);
    else setError(res.error?.message ?? "Could not load tasks.");
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** JARVIS's work, by lifecycle state. */
  const work = useMemo(() => {
    const groups: Record<WorkStatus, TaskRecord[]> = {
      RUNNING: [],
      PENDING: [],
      UNRESOLVED: [],
      FAILED: [],
      COMPLETED: [],
    };
    for (const task of tasks) {
      if (isJarvisTask(task)) groups[workStatusOf(task)].push(task);
    }
    return groups;
  }, [tasks]);

  const hasWork = useMemo(() => tasks.some(isJarvisTask), [tasks]);
  /** Any OPEN todo — the heading is pointless above an empty half. */
  const hasTodos = useMemo(
    () => tasks.some((t) => !isJarvisTask(t) && !t.completedAt),
    [tasks]
  );

  const grouped = useMemo(() => {
    const now = new Date();
    const groups: Record<Bucket, TaskRecord[]> = { OVERDUE: [], TODAY: [], UPCOMING: [], SOMEDAY: [] };
    for (const task of tasks) {
      // Work tasks have their own section; completed todos stay hidden, which
      // is what `listTasks(false)` used to do for this half of the widget.
      if (isJarvisTask(task) || task.completedAt) continue;
      groups[bucketFor(task, now)].push(task);
    }
    return groups;
  }, [tasks]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;

    setDraft("");
    setDraftDue("");
    setAdding(false);

    const res = await createTask({
      title,
      // datetime-local has no timezone; the Date constructor reads it as local,
      // and toISOString then sends a correct absolute instant.
      ...(draftDue ? { dueAt: new Date(draftDue).toISOString() } : {}),
    });
    if (res.success && res.data) setTasks((prev) => [...prev, res.data!.task]);
    else setError(res.error?.message ?? "Could not create the task.");
  };

  const toggle = async (task: TaskRecord) => {
    // Optimistic: completing a task should feel instant. A failure restores it
    // by reloading rather than by guessing what the server now holds.
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    const res = await updateTask(task.id, { completed: true });
    if (!res.success) void load();
  };

  const remove = async (task: TaskRecord) => {
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    const res = await deleteTask(task.id);
    if (!res.success) void load();
  };

  const order: Bucket[] = ["OVERDUE", "TODAY", "UPCOMING", "SOMEDAY"];
  const hasAny = tasks.length > 0;

  return (
    <WidgetShell
      testId="widget-tasks"
      title="Tasks"
      icon={<ListTodo size={13} />}
      loading={loading}
      error={error}
      onRetry={() => void load()}
      action={
        <button
          type="button"
          data-testid="task-add-toggle"
          onClick={() => setAdding((v) => !v)}
          aria-label={adding ? "Cancel new task" : "Add a task"}
          aria-expanded={adding}
          className="sys-focus rounded border border-sys-line p-0.5 text-sys-dim transition-colors hover:text-white"
        >
          {adding ? <X size={11} aria-hidden="true" /> : <Plus size={11} aria-hidden="true" />}
        </button>
      }
    >
      {adding && (
        <form onSubmit={submit} className="mb-2.5 space-y-1.5">
          <label htmlFor="task-title" className="sr-only">
            Task title
          </label>
          <input
            id="task-title"
            data-testid="task-title-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What needs doing?"
            autoFocus
            className="sys-focus w-full rounded-md border border-sys-control bg-black/30 px-2 py-1.5 text-sm text-white placeholder:text-sys-dim"
          />
          <div className="flex gap-1.5">
            <label htmlFor="task-due" className="sr-only">
              Due date and time
            </label>
            <input
              id="task-due"
              data-testid="task-due-input"
              type="datetime-local"
              value={draftDue}
              onChange={(e) => setDraftDue(e.target.value)}
              className="sys-focus min-w-0 flex-1 rounded-md border border-sys-control bg-black/30 px-2 py-1 text-sm text-sys-text/85"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="sys-focus rounded-md border border-sys-cyan/40 bg-sys-cyan/10 px-2.5 py-1 font-mono text-xs uppercase tracking-hud text-sys-cyan transition-colors enabled:hover:bg-sys-cyan/20 disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </form>
      )}

      {!hasAny && !adding && (
        <p className="text-xs text-sys-dim">
          Nothing due. Ask JARVIS to remind you, or add a task above.
        </p>
      )}

      {hasWork && (
        <div className="mb-3 space-y-1.5" data-testid="task-jarvis-section">
          <SectionHeading
            testId="task-jarvis-heading"
            label="JARVIS Work"
            tone="text-sys-cyan-soft"
            badge
          />

          {WORK_ORDER.map((status) => {
            const items = work[status];
            // Only groups that contain something. An empty "FAILED · 0" is a
            // row of chrome on a widget whose whole constraint is height.
            if (items.length === 0) return null;
            const Icon = WORK_ICON[status];
            return (
              <div key={status} data-testid={`task-work-${status}`}>
                <p
                  className={`mb-0.5 flex items-center gap-1 font-mono text-xs uppercase tracking-hud ${WORK_TONE[status]}`}
                >
                  <Icon size={10} aria-hidden="true" />
                  {WORK_LABEL[status]} · {items.length}
                </p>
                <ul className="space-y-0.5">
                  {items.slice(0, 5).map((task) => {
                    const detail = workDetailOf(task, status);
                    return (
                      <li
                        key={task.id}
                        data-testid="task-work-row"
                        data-status={status}
                        className="flex items-start gap-1.5 pl-0.5"
                      >
                        {/* A dot, not a checkbox: there is nothing to tick. */}
                        <span
                          aria-hidden="true"
                          className={`mt-1 size-1.5 shrink-0 rounded-full ${WORK_DOT[status]}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs leading-tight text-sys-text/90">
                            {task.title}
                            {/* Colour alone never carries the state. */}
                            <span className="sr-only">{` — ${WORK_LABEL[status]}`}</span>
                          </span>
                          {detail && (
                            <span
                              data-testid="task-work-detail"
                              title={detail}
                              className={`block truncate font-mono text-[10px] leading-tight ${
                                status === "FAILED"
                                  ? "text-red-300/80"
                                  : status === "UNRESOLVED"
                                    ? "text-amber-300/80"
                                    : "text-sys-dim"
                              }`}
                            >
                              {detail}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {hasWork && hasTodos && (
        <SectionHeading testId="task-mine-heading" label="My Tasks" tone="text-sys-dim" />
      )}

      <div className="space-y-2">
        {order.map((bucket) => {
          const items = grouped[bucket];
          if (items.length === 0) return null;
          return (
            <div key={bucket} data-testid={`task-bucket-${bucket}`}>
              <p className={`mb-1 font-mono text-xs uppercase tracking-hud ${BUCKET_TONE[bucket]}`}>
                {BUCKET_LABEL[bucket]} · {items.length}
              </p>
              <ul className="space-y-1">
                {items.slice(0, 5).map((task) => (
                  <li key={task.id} className="group flex items-start gap-1.5">
                    <button
                      type="button"
                      data-testid="task-complete"
                      onClick={() => void toggle(task)}
                      aria-label={`Mark "${task.title}" complete`}
                      className="sys-focus mt-0.5 shrink-0 rounded text-sys-dim transition-colors hover:text-emerald-300"
                    >
                      {task.completedAt ? (
                        <CheckCircle2 size={12} aria-hidden="true" />
                      ) : (
                        <Circle size={12} aria-hidden="true" />
                      )}
                    </button>
                    <span className="min-w-0 flex-1 truncate text-xs text-sys-text/90">
                      {task.title}
                    </span>
                    {task.dueAt && (
                      <span className="shrink-0 font-mono text-xs text-sys-dim">
                        {dueLabel(task)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void remove(task)}
                      aria-label={`Delete "${task.title}"`}
                      // Hidden until hover OR focus: keyboard users must still
                      // be able to reach it.
                      className="sys-focus shrink-0 rounded text-transparent transition-colors group-hover:text-sys-dim focus:text-sys-dim hover:!text-red-300"
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </WidgetShell>
  );
}
