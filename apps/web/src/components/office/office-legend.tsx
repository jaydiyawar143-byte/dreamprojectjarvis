"use client";

// ---------------------------------------------------------------------------
// VO-1 — the legend.
//
// A pixel office invites the viewer to read movement as work. This legend is
// the correction, in the page itself rather than in a tooltip: it says what
// each state means, that idle motion is decorative, and which two states the
// office refuses to invent.
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
      "The agent is registered but has no recent audit row. Its slow pulse is decorative.",
  },
  {
    tone: "ok",
    label: "Just finished",
    meaning: "The newest audit row for this agent succeeded within the last ten minutes.",
  },
  {
    tone: "warn",
    label: "Waiting for approval",
    meaning:
      "The newest audit row for this agent is a fresh pending request. VO-3 will read the Approval table for the authoritative state.",
  },
  {
    tone: "danger",
    label: "Needs attention",
    meaning: "The newest audit row for this agent failed or was refused.",
  },
  {
    tone: "ok",
    label: "JARVIS working",
    meaning: "At least one task in the task engine is RUNNING.",
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
          Only registered agents appear as employees. Idle movement is decorative and never
          means an agent is working.
        </p>
        <p data-testid="office-legend-limits">
          The office shows no percentage progress and no paused state, because the task
          engine has neither. A task run with no agent attribution is shown as JARVIS
          system work.
        </p>
      </div>
    </Panel>
  );
}
