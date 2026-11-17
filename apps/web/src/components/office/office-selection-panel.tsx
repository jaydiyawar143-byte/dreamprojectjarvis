"use client";

// ---------------------------------------------------------------------------
// VO-1 — the selected-actor panel. VO-3.1 — what the agent is actually doing.
//
// It repeats only facts the model holds, and it names the limit where a limit
// exists. An agent's state comes from the task assigned to it and the audit
// rows that name it (`office-lifecycle.ts`); while it is idle, its movement and
// breaks are labelled decorative. The system actor's panel says, in words, that
// the task engine records no agent for a run — because that is why the work
// appears under JARVIS.
// ---------------------------------------------------------------------------

import { Badge, Button, StatusDot } from "@/components/ui/primitives";
import { Panel } from "@/components/dashboard/panel";
import type { OfficeTaskView } from "@/lib/api";
import {
  OFFICE_DEPARTMENTS,
  type OfficeSelection,
} from "./office-model";
import { lifecycleTone } from "./office-lifecycle-tone";

function departmentLabel(id: string): string {
  return OFFICE_DEPARTMENTS.find((department) => department.id === id)?.label ?? id;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function riskTone(risk: string | undefined): "neutral" | "info" {
  return risk === "READ_ONLY" ? "neutral" : "info";
}

/** The task a state is about: its title, status, tool and the time that matters. */
function TaskLine({ task, testId }: { task: OfficeTaskView; testId: string }) {
  const time = task.finishedAt
    ? `finished ${when(task.finishedAt)}`
    : task.startedAt
      ? `started ${when(task.startedAt)}`
      : task.scheduledAt
        ? `scheduled ${when(task.scheduledAt)}`
        : task.assignedAt
          ? `assigned ${when(task.assignedAt)}`
          : null;

  return (
    <div
      data-testid={testId}
      data-task-id={task.taskId}
      data-status={task.status}
      data-tool-id={task.toolId ?? undefined}
      className="rounded border border-sys-line/60 bg-sys-edge/20 px-2 py-1.5"
    >
      <p className="truncate text-sm text-sys-text" title={task.title || undefined}>
        {task.title || "Untitled task"}
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-1 font-mono text-[10px] uppercase tracking-hud text-sys-dim">
        <span>{task.status}</span>
        {task.toolId && (
          <>
            <span aria-hidden="true">·</span>
            <span>{task.toolId}</span>
          </>
        )}
        {task.toolRisk && <Badge tone={riskTone(task.toolRisk)}>{task.toolRisk}</Badge>}
        {time && (
          <>
            <span aria-hidden="true">·</span>
            <span className="normal-case tracking-normal">{time}</span>
          </>
        )}
      </p>
      {task.error && <p className="mt-1 text-xs leading-snug text-sys-danger">{task.error}</p>}
    </div>
  );
}

export function OfficeSelectionPanel({
  selection,
  onClear,
}: {
  selection: OfficeSelection | null;
  onClear: () => void;
}) {
  if (!selection) {
    return (
      <Panel title="Selected actor" className="h-full">
        <p className="text-sm text-sys-dim">
          Select an agent or JARVIS on the floor to see what the office knows about it.
        </p>
      </Panel>
    );
  }

  if (selection.kind === "system") {
    return (
      <Panel
        title="JARVIS"
        description="System work, from the task engine."
        className="h-full"
        action={
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        }
      >
        <div className="space-y-3">
          <StatusDot
            tone={selection.state === "working" ? "ok" : selection.state === "queued" ? "info" : "neutral"}
            label={selection.stateLabel}
          />

          <dl className="grid grid-cols-3 gap-2">
            {[
              { label: "Running", value: selection.running },
              { label: "Queued", value: selection.pending },
              { label: "Completed", value: selection.completed },
            ].map((item) => (
              <div key={item.label} className="rounded border border-sys-line/60 bg-sys-edge/20 px-2 py-1.5">
                <dt className="font-mono text-[10px] uppercase tracking-hud text-sys-dim">
                  {item.label}
                </dt>
                <dd className="font-mono text-lg tabular-nums text-white">{item.value}</dd>
              </div>
            ))}
          </dl>

          {!selection.countsAreTotals && (
            <p className="text-xs leading-relaxed text-sys-dim" data-testid="office-system-counts-note">
              These counts are from the newest tasks read, because this API sent no totals.
            </p>
          )}

          <p className="text-xs leading-relaxed text-sys-dim" data-testid="office-system-note">
            A task run in the task engine records no agent, so it is shown as JARVIS system
            work. No percentage progress is shown, because the task engine has no progress
            measure.
          </p>
        </div>
      </Panel>
    );
  }

  const agent = selection;
  const approvals = agent.pendingApprovals;
  const current = agent.currentTask;
  const outcome = agent.lifecycle === "completed" || agent.lifecycle === "failed";
  const tools = agent.tools;

  return (
    <Panel
      title={agent.label}
      description={`${departmentLabel(agent.department)} · ${agent.domain}`}
      className="h-full"
      action={
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={lifecycleTone(agent.lifecycle)}>{agent.lifecycleLabel}</Badge>
          <Badge tone="neutral">
            {agent.toolCount} {agent.toolCount === 1 ? "tool" : "tools"}
          </Badge>
          {agent.approvedWrites && <Badge tone="info">Writes need approval</Badge>}
          {agent.queuedCount > 0 && (
            <Badge tone="info">
              {agent.queuedCount} queued {agent.queuedCount === 1 ? "task" : "tasks"}
            </Badge>
          )}
        </div>

        <div>
          <p className="font-mono text-[10px] uppercase tracking-hud text-sys-dim">
            {outcome ? "Last task outcome" : "Current work"}
          </p>
          {agent.lifecycle === "waiting_for_approval" ? (
            <p className="mt-1 text-sm text-sys-text" data-testid="office-agent-approvals">
              {approvals
                ? `${approvals.count} ${approvals.count === 1 ? "approval is" : "approvals are"} waiting${
                    approvals.toolId ? ` for ${approvals.toolId}` : ""
                  }; the request expires ${when(approvals.expiresAt)}.`
                : "An audit row says this agent is waiting for an approval."}
            </p>
          ) : current ? (
            <div className="mt-1">
              <TaskLine task={current} testId="office-agent-current-task" />
            </div>
          ) : (
            <p className="mt-1 text-sm text-sys-dim" data-testid="office-agent-current-task">
              No task is assigned to this agent right now.
            </p>
          )}

          {agent.upcomingTask && (
            <div className="mt-2">
              <p className="font-mono text-[10px] uppercase tracking-hud text-sys-dim">
                Next scheduled
              </p>
              <div className="mt-1">
                <TaskLine task={agent.upcomingTask} testId="office-agent-upcoming-task" />
              </div>
            </div>
          )}
        </div>

        <div>
          <p className="font-mono text-[10px] uppercase tracking-hud text-sys-dim">Available tools</p>
          {tools.length === 0 ? (
            <p className="mt-1 text-sm text-sys-dim" data-testid="office-agent-tools">
              No tool is declared for this agent.
            </p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-1.5" data-testid="office-agent-tools">
              {tools.map((tool) => (
                <li
                  key={tool.id}
                  data-testid="office-agent-tool"
                  data-tool-id={tool.id}
                  data-risk={tool.risk ?? undefined}
                  className="flex items-center gap-1.5 rounded border border-sys-line/60 bg-sys-edge/10 px-1.5 py-0.5"
                >
                  <span className="font-mono text-[11px] text-sys-text">{tool.id}</span>
                  {tool.risk && <Badge tone={riskTone(tool.risk)}>{tool.risk}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="font-mono text-[10px] uppercase tracking-hud text-sys-dim">
            Last recorded activity
          </p>
          {agent.lastActivityAt ? (
            <p className="mt-1 text-sm text-sys-text" data-testid="office-last-activity">
              {agent.lastSummary ?? "Recorded activity"} ·{" "}
              <time dateTime={agent.lastActivityAt}>{when(agent.lastActivityAt)}</time>
            </p>
          ) : (
            <p className="mt-1 text-sm text-sys-dim" data-testid="office-last-activity">
              No activity recorded for this agent yet.
            </p>
          )}
        </div>

        {agent.decorative ? (
          <p className="text-xs leading-relaxed text-sys-dim" data-testid="office-agent-decorative">
            This agent has no task assigned right now. Its slow pulse, walks and breaks —
            coffee, water, lunch, the sofa, a chat — are decorative and record nothing.
          </p>
        ) : (
          <p className="text-xs leading-relaxed text-sys-dim" data-testid="office-agent-work-note">
            Shown from the task assigned to this agent and the audit rows that name it. The
            office claims a task is running only while the task engine says RUNNING, and shows
            no percentage progress because the task engine has no progress measure.
          </p>
        )}
      </div>
    </Panel>
  );
}
