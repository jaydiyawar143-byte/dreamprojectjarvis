"use client";

// ---------------------------------------------------------------------------
// VO-1 — the text version of the office.
//
// The floor is a picture; this table is the record. It is not a fallback for a
// screenshot — it is the accessible source of truth, and the scene's summary
// points at the same facts.
//
// Columns are deliberately narrow: time, actor, what happened, result. A row
// never carries tool parameters, message text or a model's words.
// ---------------------------------------------------------------------------

import { Badge, DataTable, type Column } from "@/components/ui/primitives";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState } from "@/components/dashboard/states";
import type { OfficeEventResult, OfficeEventRow } from "./office-model";

const RESULT_TONE: Record<
  OfficeEventResult,
  "neutral" | "info" | "ok" | "warn" | "danger"
> = {
  success: "ok",
  failure: "danger",
  rejected: "danger",
  pending: "warn",
  queued: "info",
  running: "info",
};

function resultLabel(result: OfficeEventResult): string {
  switch (result) {
    case "success":
      return "Success";
    case "failure":
      return "Failure";
    case "rejected":
      return "Refused";
    case "pending":
      return "Waiting";
    case "queued":
      return "Queued";
    case "running":
      return "Running";
  }
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const COLUMNS: Array<Column<OfficeEventRow>> = [
  {
    key: "time",
    header: "Time",
    className: "w-20",
    render: (row) => (
      <time dateTime={row.at} className="font-mono text-xs text-sys-dim">
        {when(row.at)}
      </time>
    ),
  },
  {
    key: "actor",
    header: "Actor",
    render: (row) => (
      <span
        data-testid="office-event-attribution"
        data-attributed={row.attributed ? "true" : "false"}
        className="text-xs"
      >
        <span className="text-sys-text">{row.actorLabel}</span>
        {!row.attributed && (
          <span className="ml-1 font-mono text-[10px] uppercase tracking-hud text-sys-dim">
            system
          </span>
        )}
      </span>
    ),
  },
  {
    key: "what",
    header: "What",
    render: (row) => <span className="text-xs text-sys-text/90">{row.summary}</span>,
  },
  {
    key: "result",
    header: "Result",
    className: "w-24",
    render: (row) => <Badge tone={RESULT_TONE[row.result]}>{resultLabel(row.result)}</Badge>,
  },
];

export function OfficeEventList({ events }: { events: OfficeEventRow[] }) {
  return (
    <div data-testid="office-event-list">
      <Panel
        title="Recent activity"
        description="Queued and running tasks, plus the newest audit rows. Newest first."
        footer="Every row is a real record. A row with no registered agent is JARVIS system work, not an agent."
      >
        {events.length === 0 ? (
          <EmptyState
            title="No activity recorded yet"
            message="When a task is queued or an agent records an action, it appears here. Idle movement on the floor is not activity."
          />
        ) : (
          <DataTable
            columns={COLUMNS}
            rows={events}
            rowKey={(row) => row.id}
            caption="Recent real activity from the task engine and the audit log, newest first"
          />
        )}
      </Panel>
    </div>
  );
}
