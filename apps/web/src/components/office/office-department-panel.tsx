"use client";

// ---------------------------------------------------------------------------
// VO-2.2 Stage 2 — one room, inspected.
//
// Shown beside the floor when a room's sign is clicked. It lists the agents
// stationed there with the state the model gave each, JARVIS when the room is
// the Command Center, and the newest events naming any of them — all of it
// from the same model the floor is painted from, so the panel can never say
// more than the floor does. "Whole office" returns to the full floor.
// ---------------------------------------------------------------------------

import { Badge, Button, StatusDot } from "@/components/ui/primitives";
import { Panel } from "@/components/dashboard/panel";

import type { OfficeEventRow, OfficeModel, OfficeSystemActor } from "./office-model";
import { lifecycleTone } from "./office-lifecycle-tone";

const SYSTEM_TONE: Record<OfficeSystemActor["state"], "neutral" | "info" | "ok"> = {
  idle: "neutral",
  queued: "info",
  working: "ok",
};

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

export function OfficeDepartmentPanel({
  department,
  system,
  events,
  selectedActorId,
  onSelectActor,
  onShowAll,
}: {
  department: OfficeModel["departments"][number];
  system: OfficeSystemActor;
  events: OfficeEventRow[];
  selectedActorId: string | null;
  onSelectActor: (id: string) => void;
  onShowAll: () => void;
}) {
  const isCommandCenter = department.id === "command-center";
  const residents = new Set(department.actors.map((actor) => actor.id));
  if (isCommandCenter) residents.add(system.id);
  const recent = events.filter((event) => residents.has(event.actorId)).slice(0, 8);

  const row =
    "sys-focus flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left transition-colors";

  return (
    <Panel
      title={department.label}
      description={department.purpose}
      className="h-full"
      data-testid="office-department-panel"
      data-department-id={department.id}
      action={
        <Button variant="ghost" size="sm" onClick={onShowAll} data-testid="office-show-all">
          Whole office
        </Button>
      }
    >
      <div className="space-y-3">
        <ul className="space-y-1.5" aria-label={`Stationed in ${department.label}`}>
          {isCommandCenter && (
            <li>
              <button
                type="button"
                data-testid="office-department-member"
                data-agent-id={system.id}
                aria-pressed={selectedActorId === system.id}
                onClick={() => onSelectActor(system.id)}
                className={`${row} ${
                  selectedActorId === system.id
                    ? "border-sys-cyan/60 bg-sys-cyan/10"
                    : "border-sys-cyan/25 bg-sys-cyan/[0.04] hover:border-sys-cyan/45"
                }`}
              >
                <span className="min-w-0 truncate text-xs font-semibold text-sys-text">JARVIS</span>
                <Badge tone={SYSTEM_TONE[system.state]}>{system.stateLabel}</Badge>
              </button>
            </li>
          )}
          {department.actors.map((actor) => (
            <li key={actor.id}>
              <button
                type="button"
                data-testid="office-department-member"
                data-agent-id={actor.id}
                aria-pressed={selectedActorId === actor.id}
                onClick={() => onSelectActor(actor.id)}
                className={`${row} ${
                  selectedActorId === actor.id
                    ? "border-sys-cyan/60 bg-sys-cyan/10"
                    : "border-sys-line/60 bg-sys-panel/60 hover:border-sys-cyan/35"
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-sys-text">{actor.label}</span>
                  {actor.currentTask?.title ? (
                    <span className="mt-0.5 block truncate text-[10px] text-sys-dim">
                      {actor.currentTask.title}
                    </span>
                  ) : null}
                </span>
                <Badge tone={lifecycleTone(actor.lifecycle)}>{actor.lifecycleLabel}</Badge>
              </button>
            </li>
          ))}
          {department.actors.length === 0 && !isCommandCenter && (
            <li className="rounded border border-dashed border-sys-line/60 px-2 py-1.5 text-xs text-sys-dim">
              No agent is stationed here.
            </li>
          )}
        </ul>

        <div>
          <p className="font-mono text-[10px] uppercase tracking-hud text-sys-dim">Newest events here</p>
          {recent.length === 0 ? (
            <p className="mt-1 text-xs text-sys-dim" data-testid="office-department-no-events">
              No recorded event names anyone in this room.
            </p>
          ) : (
            <ul className="mt-1 space-y-1" data-testid="office-department-events">
              {recent.map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-2 text-xs">
                  <span className="min-w-0">
                    <StatusDot
                      tone={
                        event.result === "success"
                          ? "ok"
                          : event.result === "failure" || event.result === "rejected"
                            ? "danger"
                            : event.result === "pending" || event.result === "queued"
                              ? "warn"
                              : "info"
                      }
                      label={`${event.actorLabel}: ${event.summary}`}
                    />
                  </span>
                  <time dateTime={event.at} className="shrink-0 font-mono text-[10px] text-sys-dim">
                    {when(event.at)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
