"use client";

// ---------------------------------------------------------------------------
// VO-1 — renderer seam.
//
// The floor is drawn by an `OfficeRenderer`. VO-1 ships exactly one: DOM/CSS.
// VO-4 adds a PixiJS implementation behind the same interface, and no page,
// hook or model has to change when it does.
//
// A renderer receives the derived model and nothing else. It must not fetch,
// derive state, or read a clock: those live in `office-model.ts`, so every
// renderer shows the same facts.
// ---------------------------------------------------------------------------

import type { CSSProperties, ReactElement } from "react";

import type { OfficeModel } from "./office-model";
import { OfficeActor, OfficeSystemActorCard } from "./office-actor";

export interface OfficeRendererProps {
  model: OfficeModel;
  selectedActorId: string | null;
  onSelectActor: (id: string) => void;
}

export type OfficeRenderer = (props: OfficeRendererProps) => ReactElement;

/** The pixel grid is paint, not data. */
const FLOOR_GRID: CSSProperties = {
  backgroundImage:
    "linear-gradient(rgba(148, 163, 184, 0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(148, 163, 184, 0.06) 1px, transparent 1px)",
  backgroundSize: "16px 16px",
};

function DepartmentZone({
  department,
  model,
  selectedActorId,
  onSelectActor,
}: {
  department: OfficeModel["departments"][number];
  model: OfficeModel;
  selectedActorId: string | null;
  onSelectActor: (id: string) => void;
}) {
  const isCommandCenter = department.id === "command-center";

  return (
    <section
      data-testid="office-department"
      data-department-id={department.id}
      aria-label={department.label}
      className={[
        "relative flex min-h-[10rem] flex-col rounded border p-2.5",
        "border-sys-line/70 bg-sys-panel/40",
        isCommandCenter ? "border-sys-cyan/30" : "",
      ].join(" ")}
    >
      <header className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="truncate font-mono text-[11px] uppercase tracking-hud text-sys-text/85">
          {department.label}
        </h3>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-sys-dim">
          {department.actors.length}
        </span>
      </header>

      <p className="mb-2 text-[11px] leading-snug text-sys-dim">{department.purpose}</p>

      <div className="mt-auto space-y-1.5">
        {isCommandCenter && (
          <OfficeSystemActorCard
            actor={model.system}
            selected={selectedActorId === model.system.id}
            onSelect={onSelectActor}
          />
        )}

        {department.actors.map((actor) => (
          <OfficeActor
            key={actor.id}
            actor={actor}
            selected={selectedActorId === actor.id}
            onSelect={onSelectActor}
          />
        ))}

        {department.actors.length === 0 && !isCommandCenter && (
          <p
            data-testid="office-empty-desk"
            className="rounded border border-dashed border-sys-line/60 px-2 py-1 text-[10px] text-sys-dim"
          >
            No agent is stationed here.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The VO-1 renderer: a CSS floor plan and pixel-block figures.
 *
 * No canvas, no WebGL, no dependency. It deliberately reuses the dashboard's
 * existing tokens (`sys-*`) and its `font-mono` HUD type, so the tab reads as
 * part of the same product rather than a game pasted beside it.
 */
export function DomOfficeRenderer({
  model,
  selectedActorId,
  onSelectActor,
}: OfficeRendererProps) {
  return (
    <div
      data-testid="office-floor-plan"
      className="rounded-md border border-sys-line/70 bg-sys-void/60 p-2"
      style={FLOOR_GRID}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {model.departments.map((department) => (
          <DepartmentZone
            key={department.id}
            department={department}
            model={model}
            selectedActorId={selectedActorId}
            onSelectActor={onSelectActor}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The registry VO-4 extends. Keeping the lookup explicit means an unknown
 * renderer id cannot silently fall through to a half-built scene.
 */
export const OFFICE_RENDERERS: Record<"dom", OfficeRenderer> = {
  dom: DomOfficeRenderer,
};
