"use client";

// ---------------------------------------------------------------------------
// VO-1 — the scene wrapper. VO-2.2 Stage 2 — the pixel-art office. VO-3.1 —
// the living office.
//
// The scene owns no data and derives nothing. It exists so the page has one
// element to place, one accessible summary to announce, one clock and one
// renderer. The widget preview and the expanded view both draw through it,
// from the same model, with the same engine; the expanded view adds a
// viewport (pan, zoom, a room close up).
//
// `role="group"` rather than `role="img"` is deliberate: the figures inside
// are real buttons, and `role="img"` would hide them from assistive
// technology. The visual floor is decorative; the summary and the event table
// carry the information.
// ---------------------------------------------------------------------------

import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import type { DepartmentId, OfficeModel } from "./office-model";
import { OFFICE_RENDERERS } from "./office-renderer";
import { placeAgents, roomViewport } from "./pixel/floor-plan";
import { sceneSchedule, useFigureMotion, useSceneTime, useSceneTimer } from "./pixel/use-office-motion";
import { useOfficeViewport } from "./pixel/use-office-viewport";
import { usePrefersReducedMotion } from "./pixel/use-reduced-motion";

export function officeSceneSummary(model: OfficeModel): string {
  const { availableAgents, unavailableAgents, running, pending } = model.counts;

  const agents =
    availableAgents === 1
      ? "1 registered agent is on the floor"
      : `${availableAgents} registered agents are on the floor`;

  const absent =
    unavailableAgents === 0
      ? "Every declared agent is registered on this deployment."
      : `${unavailableAgents} declared ${
          unavailableAgents === 1 ? "agent is" : "agents are"
        } not on this deployment and ${
          unavailableAgents === 1 ? "is" : "are"
        } not shown on the floor.`;

  const busy = model.agents.filter((agent) => agent.lifecycle !== "idle");
  const working =
    busy.length === 0
      ? "No agent has real work right now."
      : `${busy.map((agent) => `${agent.label}: ${agent.lifecycleLabel}`).join("; ")}.`;

  return `${agents}. ${running} ${
    running === 1 ? "task is" : "tasks are"
  } running and ${pending} ${pending === 1 ? "task is" : "tasks are"} queued. ${working} ${absent} Slow idle movement and break activities are decorative.`;
}

export interface OfficeSceneProps {
  model: OfficeModel;
  selectedActorId: string | null;
  onSelectActor: (id: string) => void;
  /** A room shown close up, with the others dimmed. */
  focusDepartment?: DepartmentId | null;
  /** When given, a room's sign is a control that inspects the room. */
  onSelectDepartment?: (id: DepartmentId) => void;
  /** Pan, zoom and the keyboard — the expanded view. The widget preview is static. */
  interactive?: boolean;
  /** The widget's small preview: no name tags. */
  compact?: boolean;
  /**
   * VO-3.1 — decorative break activities for idle agents. On by default; off,
   * every figure stays at its workstation. Reduced motion turns them off too.
   */
  ambient?: boolean;
  /** A fixed instant, for tests: no timer runs and positions are a pure function of it. */
  clock?: number;
  /**
   * Positions the scene. Defaults to `relative`. A caller that fills a box
   * passes `absolute inset-0` INSTEAD — never both: `relative` is later in
   * Tailwind's stylesheet, so it would win and the floor would size itself by
   * its aspect ratio and spill out of the box.
   */
  className?: string;
}

export function OfficeScene({
  model,
  selectedActorId,
  onSelectActor,
  focusDepartment = null,
  onSelectDepartment,
  interactive = false,
  compact = false,
  ambient = true,
  clock,
  className = "relative",
}: OfficeSceneProps) {
  const Renderer = OFFICE_RENDERERS.pixel;
  const reducedMotion = usePrefersReducedMotion();
  const viewport = useOfficeViewport(interactive, focusDepartment ? roomViewport(focusDepartment) : null);

  const ambientEnabled = ambient && !reducedMotion;
  const placed = placeAgents(model);

  // ONE clock: the motion is computed for the current instant, and the timer
  // is then armed for the next instant that motion says anything changes.
  const [now, tick] = useSceneTime(clock);
  const motions = useFigureMotion(placed, now, { ambientEnabled, smooth: !reducedMotion });
  const schedule = sceneSchedule(motions);
  useSceneTimer(tick, {
    ...(clock !== undefined ? { fixed: clock } : {}),
    enabled: model.agents.length > 0,
    walking: schedule.walking,
    nextChangeAt: schedule.nextChangeAt,
    now,
  });

  const zoomButton =
    "sys-focus rounded border border-sys-line bg-sys-panel/80 p-1 text-sys-dim transition-colors enabled:hover:text-white disabled:opacity-30";

  const floor = (
    <Renderer
      model={model}
      selectedActorId={selectedActorId}
      onSelectActor={onSelectActor}
      focusDepartment={focusDepartment}
      onSelectDepartment={onSelectDepartment}
      viewport={interactive ? viewport : null}
      reducedMotion={reducedMotion}
      compact={compact}
      motions={motions}
    />
  );

  return (
    <div
      data-testid="office-scene"
      role="group"
      aria-label="Virtual office floor plan"
      data-ambient={ambientEnabled ? "on" : "off"}
      className={interactive ? `${className} flex flex-col` : className}
    >
      <p data-testid="office-scene-summary" className="sr-only">
        {officeSceneSummary(model)}
      </p>

      {/* The expanded view gives the floor its own box and the zoom controls a
          strip under it. Laid over the floor's corner, the controls covered
          whoever stood there — and their name. */}
      {interactive ? (
        <div data-testid="office-floor-box" className="min-h-0 flex-1">
          {floor}
        </div>
      ) : (
        floor
      )}

      {interactive && (
        <div
          data-testid="office-viewport-controls"
          className="flex shrink-0 items-center justify-end gap-1 border-t border-sys-line/60 bg-sys-void/70 px-1.5 py-1"
        >
          <span data-testid="office-viewport-scale" className="px-1 font-mono text-[10px] tabular-nums text-sys-dim" aria-live="polite">
            {viewport.scale.toFixed(1)}×
          </span>
          <button type="button" aria-label="Zoom out" title="Zoom out (−)" className={zoomButton} onClick={viewport.zoomOut} disabled={!viewport.canZoomOut}>
            <ZoomOut size={13} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" className={zoomButton} onClick={viewport.zoomIn} disabled={!viewport.canZoomIn}>
            <ZoomIn size={13} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Reset view" title="Reset view (0)" className={zoomButton} onClick={viewport.reset}>
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

