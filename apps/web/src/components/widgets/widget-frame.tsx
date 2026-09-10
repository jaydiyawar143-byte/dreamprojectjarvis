"use client";

// ---------------------------------------------------------------------------
// V4 — the customise-mode wrapper.
//
// Wraps every widget on the dashboard. When customise mode is OFF it renders
// its child and nothing else — no handles, no outlines, no extra DOM that could
// intercept a click. That matters: the normal experience has to stay clean, and
// a drag handle sitting invisibly over a map would break panning.
//
// ---------------------------------------------------------------------------
// WHAT REPLACED THE ± BUTTONS.
//
// V3 resized through a pair of ± buttons per axis, stepping a widget through
// whole columns of a 4-column grid, and moved through arrows that walked a
// one-dimensional order. It was operable, and it was the wrong model: the user
// could not say "this big" or "there", only "one more than before" and "one
// place along".
//
// V4 gives the interaction to react-grid-layout. Dragging the grip moves the
// widget; dragging a corner or edge sizes it, continuously, against a live
// preview of where it will land. Neither is expressible as a button, which is
// exactly why the buttons are gone.
//
// THE KEYBOARD CONTROLS ARE NOT THE OLD BUTTONS COMING BACK.
//
// react-grid-layout is pointer-and-touch only — it has no keyboard story at
// all. Shipping it alone would make the dashboard unusable without a mouse, so
// each widget keeps arrow controls that nudge and resize it by one cell. They
// are the keyboard EQUIVALENT of the drag, moving the same placement through
// the same clamp, not a menu of preset sizes: there is no "2x3" to choose, and
// the size readout is a report of where the corner currently is.
//
// They live behind a disclosure rather than on the toolbar, so the pointer path
// stays uncluttered for the people who will mostly use it.
// ---------------------------------------------------------------------------

import { useId, useState, type ReactNode } from "react";
import {
  ChevronDown,
  EyeOff,
  GripVertical,
  Maximize2,
  Minimize2,
  MoveDown,
  MoveLeft,
  MoveRight,
  MoveUp,
} from "lucide-react";
import { CONSTRAINTS, canGrow, canShrink, type WidgetPlacement } from "./layout";

export interface WidgetFrameProps {
  placement: WidgetPlacement;
  label: string;
  customizing: boolean;
  /** Move by whole cells. The keyboard equivalent of dragging. */
  onNudge: (dx: number, dy: number) => void;
  /** Resize by whole cells. The keyboard equivalent of a corner drag. */
  onResizeBy: (dw: number, dh: number) => void;
  onHide: () => void;
  children: ReactNode;
}

/** The class react-grid-layout is told to treat as the drag handle. */
export const DRAG_HANDLE_CLASS = "jarvis-widget-drag-handle";

export function WidgetFrame({
  placement,
  label,
  customizing,
  onNudge,
  onResizeBy,
  onHide,
  children,
}: WidgetFrameProps) {
  const limits = CONSTRAINTS[placement.id];
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const panelId = useId();

  // Off: render the widget, and nothing else. No wrapper behaviour at all.
  if (!customizing) {
    return <div className="h-full w-full">{children}</div>;
  }

  const btn =
    "sys-focus rounded p-1 text-sys-dim transition-colors enabled:hover:text-white disabled:opacity-30";

  return (
    <div className="relative h-full w-full" data-testid={`frame-${placement.id}`} data-customizing="true">
      {/* A dashed outline is the whole "you are editing" affordance. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-0.5 rounded-xl border border-dashed border-sys-cyan/35"
      />

      <div className="relative h-full w-full">{children}</div>

      {/* ---- Controls -----------------------------------------------------
          Positioned over the widget's own header, which is empty space in
          every widget. `pointer-events-none` on the strip with `auto` on the
          controls means the widget underneath stays clickable between them.
      */}
      <div className="pointer-events-none absolute inset-x-0 -top-2.5 flex justify-center">
        <div className="glass-panel pointer-events-auto flex items-center gap-0.5 rounded-full px-1 py-0.5 shadow-lg">
          {/*
            The drag grip. react-grid-layout is configured with
            `draggableHandle: .jarvis-widget-drag-handle`, so ONLY this moves
            the widget — buttons, inputs and the map inside the card keep
            working while customise mode is on.
          */}
          <span
            className={`${DRAG_HANDLE_CLASS} flex cursor-grab items-center gap-1 rounded px-1 py-0.5 text-sys-dim transition-colors hover:text-white active:cursor-grabbing`}
            data-testid={`drag-${placement.id}`}
            title={`Drag to move ${label}`}
            aria-hidden="true"
          >
            <GripVertical size={11} />
            <span className="max-w-[7rem] truncate font-mono text-xs uppercase tracking-hud">
              {label}
            </span>
          </span>

          <span aria-hidden="true" className="mx-0.5 h-3 w-px bg-white/10" />

          {/* Where the corner currently is. A readout, not a control. */}
          <span
            data-testid={`size-${placement.id}`}
            aria-hidden="true"
            className="font-mono text-xs uppercase tracking-hud text-sys-dim"
          >
            {placement.w}×{placement.h}
          </span>

          <button
            type="button"
            data-testid={`keyboard-${placement.id}`}
            onClick={() => setKeyboardOpen((v) => !v)}
            aria-expanded={keyboardOpen}
            aria-controls={panelId}
            aria-label={`Move or resize ${label} with the keyboard`}
            title="Move or resize with the keyboard"
            className={btn}
          >
            <ChevronDown
              size={11}
              aria-hidden="true"
              className={keyboardOpen ? "rotate-180 transition-transform" : "transition-transform"}
            />
          </button>

          {/* Hide is offered only where hiding is allowed. The Orb has no hide
              control at all, rather than a disabled one that implies the
              dashboard could exist without it. */}
          {limits.hideable && (
            <button
              type="button"
              data-testid={`hide-${placement.id}`}
              onClick={onHide}
              aria-label={`Hide ${label}`}
              title="Hide"
              className="sys-focus rounded p-1 text-sys-dim transition-colors hover:text-red-300"
            >
              <EyeOff size={11} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* ---- Keyboard move and resize -------------------------------------- */}
      {keyboardOpen && (
        <div
          id={panelId}
          data-testid={`keyboard-panel-${placement.id}`}
          role="group"
          aria-label={`Move or resize ${label}`}
          className="glass-panel pointer-events-auto absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-full px-1.5 py-1 shadow-xl"
        >
          <button
            type="button"
            data-testid={`move-left-${placement.id}`}
            onClick={() => onNudge(-1, 0)}
            disabled={placement.x === 0}
            aria-label={`Move ${label} left (column ${placement.x + 1})`}
            className={btn}
          >
            <MoveLeft size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid={`move-right-${placement.id}`}
            onClick={() => onNudge(1, 0)}
            aria-label={`Move ${label} right (column ${placement.x + 1})`}
            className={btn}
          >
            <MoveRight size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid={`move-up-${placement.id}`}
            onClick={() => onNudge(0, -1)}
            disabled={placement.y === 0}
            aria-label={`Move ${label} up (row ${placement.y + 1})`}
            className={btn}
          >
            <MoveUp size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid={`move-down-${placement.id}`}
            onClick={() => onNudge(0, 1)}
            aria-label={`Move ${label} down (row ${placement.y + 1})`}
            className={btn}
          >
            <MoveDown size={11} aria-hidden="true" />
          </button>

          <span aria-hidden="true" className="mx-0.5 h-3 w-px bg-white/10" />

          <button
            type="button"
            data-testid={`shrink-${placement.id}`}
            onClick={() => onResizeBy(-1, -1)}
            disabled={!canShrink(placement, "w") && !canShrink(placement, "h")}
            aria-label={`Make ${label} smaller (currently ${placement.w} by ${placement.h} cells)`}
            className={btn}
          >
            <Minimize2 size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid={`grow-${placement.id}`}
            onClick={() => onResizeBy(1, 1)}
            disabled={!canGrow(placement, "w") && !canGrow(placement, "h")}
            aria-label={`Make ${label} larger (currently ${placement.w} by ${placement.h} cells)`}
            className={btn}
          >
            <Maximize2 size={11} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
