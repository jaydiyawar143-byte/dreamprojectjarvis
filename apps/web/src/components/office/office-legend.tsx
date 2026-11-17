"use client";

// ---------------------------------------------------------------------------
// VO-1 — the legend. VO-3.1 — the states the living office may show.
//
// A pixel office invites the viewer to read movement as work. This legend is
// the correction, in the page itself rather than in a tooltip: it says what
// each state means, that idle motion is decorative, and which states the
// office refuses to invent.
//
// Every working state below has one source: a RUNNING task assigned to the
// agent. Coffee, walking and conversation are a separate, decorative layer
// that stops the moment a real state arrives.
// ---------------------------------------------------------------------------

import { StatusDot } from "@/components/ui/primitives";
import { Panel } from "@/components/dashboard/panel";

const ENTRIES: Array<{
  tone: "neutral" | "info" | "ok" | "warn" | "danger";
  label: string;
  meaning: string;
}> = [
  {
    tone: "neutral",
    label: "Idle",
    meaning:
      "Registered, with nothing real to do. Its slow pulse, coffee, walking and conversations are decorative.",
  },
  {
    tone: "info",
    label: "Queued / assigned",
    meaning:
      "A PENDING task is assigned to the agent — due within ten minutes, or already claimed by the scheduler.",
  },
  {
    tone: "ok",
    label: "Working / researching / using a tool",
    meaning:
      "A RUNNING task is assigned to the agent. The word comes from the tool's declared risk: research for a read-only tool, a tool by name for a write.",
  },
  {
    tone: "warn",
    label: "Waiting for approval",
    meaning:
      "The agent asked for a pending approval that has not expired. It cannot proceed until a person answers.",
  },
  {
    tone: "ok",
    label: "Task completed",
    meaning: "The agent's newest finished task completed within the last ten minutes.",
  },
  {
    tone: "danger",
    label: "Task failed",
    meaning: "The agent's newest finished task failed or was left unresolved.",
  },
  {
    tone: "ok",
    label: "JARVIS working",
    meaning: "At least one task in the task engine is RUNNING and names no agent.",
  },
  {
    tone: "info",
    label: "JARVIS queued",
    meaning: "At least one task is PENDING and none is running.",
  },
];

export function OfficeLegend() {
  return (
    <Panel
      title="Legend"
      description="What the floor is allowed to claim."
      data-testid="office-legend"
    >
      <ul className="grid gap-2 sm:grid-cols-2">
        {ENTRIES.map((entry) => (
          <li
            key={entry.label}
            className="rounded border border-sys-line/60 bg-sys-edge/10 px-2.5 py-2"
          >
            <StatusDot tone={entry.tone} label={entry.label} />
            <p className="mt-1 text-xs leading-snug text-sys-dim">{entry.meaning}</p>
          </li>
        ))}
      </ul>

      <div className="mt-3 space-y-1.5 border-t border-sys-line/60 pt-3 text-xs leading-relaxed text-sys-dim">
        <p data-testid="office-legend-decorative">
          Only registered agents appear as employees. Coffee, walking, lunch and other idle
          activity are decorative: they are a simulation, never a claim of work, and they stop
          when real work arrives.
        </p>
        <p data-testid="office-legend-limits">
          The office shows no percentage progress and no paused state, because the task engine
          has neither. A task run with no agent attribution is shown as JARVIS system work.
        </p>
      </div>
    </Panel>
  );
}
