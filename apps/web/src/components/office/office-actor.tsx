"use client";

// ---------------------------------------------------------------------------
// VO-1 — one actor on the floor.
//
// An actor is a BUTTON, not a div: selecting one opens its details, so it has
// to be reachable and operable from the keyboard. The pixel figure is
// `aria-hidden` because it carries no information the text does not.
//
// There is deliberately no `working` and no `paused` rendering here. Only the
// JARVIS system actor can be shown as working, and only from a real RUNNING
// task. An agent's slow idle pulse is decorative and marked as such.
// ---------------------------------------------------------------------------

import type { DepartmentId } from "./office-model";
import type { OfficeAgentActor, OfficeSystemActor } from "./office-model";

const DEPARTMENT_ACCENT: Record<DepartmentId, string> = {
  "command-center": "border-sys-cyan/40 bg-sys-cyan/10 text-sys-cyan",
  "development-lab": "border-emerald-400/35 bg-emerald-400/10 text-emerald-300",
  "marketing-hub": "border-fuchsia-400/35 bg-fuchsia-400/10 text-fuchsia-300",
  "research-lab": "border-indigo-400/35 bg-indigo-400/10 text-indigo-300",
  "conference-room": "border-amber-400/35 bg-amber-400/10 text-amber-300",
  "break-zone": "border-sys-line bg-sys-edge/20 text-sys-dim",
};

const AGENT_TONE: Record<OfficeAgentActor["state"], string> = {
  idle: "border-sys-line bg-sys-edge/30 text-sys-dim",
  recent: "border-sys-ok/35 bg-sys-ok/10 text-sys-ok",
  attention: "border-sys-danger/35 bg-sys-danger/10 text-sys-danger",
  waiting: "border-amber-400/35 bg-amber-400/10 text-amber-300",
};

const SYSTEM_TONE: Record<OfficeSystemActor["state"], string> = {
  idle: "border-sys-line bg-sys-edge/30 text-sys-dim",
  queued: "border-sys-cyan/35 bg-sys-cyan/10 text-sys-cyan",
  working: "border-sys-ok/45 bg-sys-ok/15 text-sys-ok",
};

/**
 * A fixed 4x4 pixel figure. Fixed, not random: the same actor must look the
 * same on every render, and a test must not depend on a random seed.
 */
const PIXEL_PATTERN: readonly number[] = [
  0, 1, 1, 0,
  1, 1, 1, 1,
  0, 1, 1, 0,
  0, 1, 0, 1,
];

function PixelAvatar({ accent }: { accent: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="office-avatar"
      className="grid h-8 w-8 shrink-0 grid-cols-4 grid-rows-4 gap-[1px] border border-black/40 bg-black/40 p-[2px]"
    >
      {PIXEL_PATTERN.map((filled, index) => (
        <span
          key={index}
          className={filled ? `block ${accent}` : "block bg-transparent"}
        />
      ))}
    </span>
  );
}

export function OfficeActor({
  actor,
  selected,
  onSelect,
}: {
  actor: OfficeAgentActor;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid="office-actor"
      data-agent-id={actor.id}
      data-state={actor.state}
      data-decorative={actor.decorative ? "true" : "false"}
      aria-pressed={selected}
      aria-label={`${actor.label}, ${actor.stateLabel}`}
      onClick={() => onSelect(actor.id)}
      className={[
        "sys-focus flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors",
        selected
          ? "border-sys-cyan/60 bg-sys-cyan/10"
          : "border-sys-line/60 bg-sys-panel/60 hover:border-sys-cyan/35 hover:bg-sys-edge/20",
      ].join(" ")}
    >
      <span className="relative">
        <PixelAvatar accent={DEPARTMENT_ACCENT[actor.department]} />
        {actor.decorative && (
          <span
            aria-hidden="true"
            data-testid="office-idle-pulse"
            className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-sys-dim motion-safe:animate-pulse"
          />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span
          data-testid="office-actor-name"
          className="block truncate text-xs font-semibold text-sys-text"
        >
          {actor.label}
        </span>
        <span
          data-testid="office-actor-state"
          className={[
            "mt-1 inline-flex items-center rounded border px-1.5 py-0.5",
            "font-mono text-[10px] uppercase tracking-hud",
            AGENT_TONE[actor.state],
          ].join(" ")}
        >
          {actor.stateLabel}
        </span>
      </span>

      <span className="shrink-0 font-mono text-[10px] tabular-nums text-sys-dim">
        {actor.toolCount} {actor.toolCount === 1 ? "tool" : "tools"}
      </span>
    </button>
  );
}

/**
 * The JARVIS system actor.
 *
 * It exists on every deployment because the task engine exists. Its state is
 * read from real task rows, and its `attribution` is permanently "system"
 * because a task run records no agent.
 */
export function OfficeSystemActorCard({
  actor,
  selected,
  onSelect,
}: {
  actor: OfficeSystemActor;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid="office-system-actor"
      data-state={actor.state}
      aria-pressed={selected}
      aria-label={`${actor.label}, ${actor.stateLabel}`}
      onClick={() => onSelect(actor.id)}
      className={[
        "sys-focus flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors",
        selected
          ? "border-sys-cyan/60 bg-sys-cyan/10"
          : "border-sys-cyan/25 bg-sys-cyan/[0.04] hover:border-sys-cyan/45",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center border border-sys-cyan/40 bg-sys-cyan/10 font-mono text-[10px] font-bold tracking-hud text-sys-cyan"
      >
        JV
      </span>

      <span className="min-w-0 flex-1">
        <span
          data-testid="office-system-actor-name"
          className="block truncate text-xs font-semibold text-sys-text"
        >
          {actor.label}
        </span>
        <span
          data-testid="office-system-actor-state"
          className={[
            "mt-1 inline-flex items-center rounded border px-1.5 py-0.5",
            "font-mono text-[10px] uppercase tracking-hud",
            SYSTEM_TONE[actor.state],
          ].join(" ")}
        >
          {actor.stateLabel}
        </span>
      </span>

      <span className="shrink-0 font-mono text-[10px] uppercase tracking-hud text-sys-dim">
        System
      </span>
    </button>
  );
}
