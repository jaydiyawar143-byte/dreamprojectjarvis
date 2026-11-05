"use client";

// ---------------------------------------------------------------------------
// VO-1 — the selected-actor panel.
//
// It repeats only facts the model holds, and it names the limit where a limit
// exists. The system actor's panel says, in words, that the task engine records
// no agent for a run — because that is why the work appears under JARVIS.
// ---------------------------------------------------------------------------

import { Badge, Button, StatusDot } from "@/components/ui/primitives";
import { Panel } from "@/components/dashboard/panel";
import {
  OFFICE_DEPARTMENTS,
  type OfficeSelection,
} from "./office-model";

const AGENT_TONE: Record<
  Extract<OfficeSelection, { kind: "agent" }>["state"],
  "neutral" | "info" | "ok" | "warn" | "danger"
> = {
  idle: "neutral",
  recent: "ok",
  attention: "danger",
  waiting: "warn",
};

function departmentLabel(id: string): string {
  return OFFICE_DEPARTMENTS.find((department) => department.id === id)?.label ?? id;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
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

          <p className="text-xs leading-relaxed text-sys-dim" data-testid="office-system-note">
            A task run in the task engine records no agent, so it is shown as JARVIS system
            work. No percentage progress is shown, because the task engine has no progress
            measure.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title={selection.label}
      description={`${departmentLabel(selection.department)} · ${selection.domain}`}
      className="h-full"
      action={
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={AGENT_TONE[selection.state]}>{selection.stateLabel}</Badge>
          <Badge tone="neutral">
            {selection.toolCount} {selection.toolCount === 1 ? "tool" : "tools"}
          </Badge>
          {selection.approvedWrites && <Badge tone="info">Writes need approval</Badge>}
        </div>

        <div>
          <p className="font-mono text-[10px] uppercase tracking-hud text-sys-dim">
            Last recorded activity
          </p>
          {selection.lastActivityAt ? (
            <p className="mt-1 text-sm text-sys-text" data-testid="office-last-activity">
              {selection.lastSummary ?? "Recorded activity"} ·{" "}
              <time dateTime={selection.lastActivityAt}>{when(selection.lastActivityAt)}</time>
            </p>
          ) : (
            <p className="mt-1 text-sm text-sys-dim" data-testid="office-last-activity">
              No activity recorded for this agent yet.
            </p>
          )}
        </div>

        <p className="text-xs leading-relaxed text-sys-dim">
          The office shows the newest audit row that names this agent. It does not show the
          agent as working, because a conversational turn records no durable start.
        </p>
      </div>
    </Panel>
  );
}
