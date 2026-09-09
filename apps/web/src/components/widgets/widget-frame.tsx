"use client";

// ---------------------------------------------------------------------------
// V3 — the customise-mode wrapper.
//
// Wraps every widget on the dashboard. When customise mode is OFF it renders
// its child and nothing else — no handles, no outlines, no extra DOM that could
// intercept a click. That matters: the normal experience has to stay clean, and
// a drag handle sitting invisibly over a map would break panning.
//
// When customise mode is ON the widget becomes:
//   * draggable, by pointer, onto any other widget's position;
//   * resizable, by explicit ± buttons per axis;
//   * hideable, unless it is one the dashboard cannot lose.
//
// WHY BUTTONS FOR RESIZE RATHER THAN A CORNER HANDLE. A corner handle is
// unusable by keyboard and fiddly on touch. Buttons are operable by pointer,
// keyboard and screen reader with no extra code, and they make the size
// constraints visible — a control that is disabled at the limit tells the user
// the limit exists, where a handle that simply stops moving does not.
//
// Dragging is bound to a dedicated grip, not the whole card, so buttons, inputs
// and the map inside a widget keep working while customise mode is on.
// ---------------------------------------------------------------------------

import { useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, EyeOff, GripVertical, Minus, Plus } from "lucide-react";
import {
  CONSTRAINTS,
  canGrow,
  canShrink,
  type WidgetId,
  type WidgetPlacement,
} from "./layout";

export interface WidgetFrameProps {
  placement: WidgetPlacement;
  label: string;
  customizing: boolean;
  /** Position among visible widgets, for the accessible announcement. */
  index: number;
  total: number;
  onMove: (direction: -1 | 1) => void;
  onResize: (delta: { w?: number; h?: number }) => void;
  onHide: () => void;
  onDropOn: (id: WidgetId) => void;
  className?: string;
  children: ReactNode;
}

export function WidgetFrame({
  placement,
  label,
  customizing,
  index,
  total,
  onMove,
  onResize,
  onHide,
  onDropOn,
  className = "",
  children,
}: WidgetFrameProps) {
  const limits = CONSTRAINTS[placement.id];
  const dragging = useRef(false);

  // Off: render the widget, and nothing else. No wrapper behaviour at all.
  if (!customizing) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      className={`relative ${className}`}
      data-testid={`frame-${placement.id}`}
      data-customizing="true"
      // HTML5 drag-and-drop rather than pointer maths: the browser supplies the
      // drag image, the drop targets and the cancel semantics, and it does not
      // fight the page's own scrolling on touch.
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const sourceId = e.dataTransfer.getData("text/jarvis-widget");
        if (sourceId && sourceId !== placement.id) onDropOn(sourceId as WidgetId);
      }}
    >
      {/* A dashed outline is the whole "you are editing" affordance. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-1 rounded-xl border border-dashed border-sys-cyan/35"
      />

      <div className="relative h-full">{children}</div>

      {/* ---- Controls -----------------------------------------------------
          Positioned over the widget's own header, which is empty space in
          every widget. `pointer-events-none` on the strip with `auto` on the
          buttons means the widget underneath stays clickable between them.
      */}
      <div className="pointer-events-none absolute inset-x-0 -top-3 flex justify-center">
        <div className="glass-panel pointer-events-auto flex items-center gap-0.5 rounded-full px-1 py-0.5 shadow-lg">
          {/* Drag grip. Only this is draggable, so controls and widget content
              inside the card keep working. */}
          <button
            type="button"
            draggable
            data-testid={`drag-${placement.id}`}
            aria-label={`Drag ${label} to reorder`}
            title="Drag to reorder"
            onDragStart={(e) => {
              dragging.current = true;
              e.dataTransfer.setData("text/jarvis-widget", placement.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              dragging.current = false;
            }}
            className="sys-focus cursor-grab rounded p-1 text-sys-dim transition-colors hover:text-white active:cursor-grabbing"
          >
            <GripVertical size={11} aria-hidden="true" />
          </button>

          {/* Keyboard equivalents for the drag above. Required, not a nicety:
              a drag handle alone leaves keyboard users unable to reorder. */}
          <button
            type="button"
            data-testid={`move-left-${placement.id}`}
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={`Move ${label} earlier (position ${index + 1} of ${total})`}
            className="sys-focus rounded p-1 text-sys-dim transition-colors enabled:hover:text-white disabled:opacity-30"
          >
            <ArrowLeft size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid={`move-right-${placement.id}`}
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label={`Move ${label} later (position ${index + 1} of ${total})`}
            className="sys-focus rounded p-1 text-sys-dim transition-colors enabled:hover:text-white disabled:opacity-30"
          >
            <ArrowRight size={11} aria-hidden="true" />
          </button>

          <span aria-hidden="true" className="mx-0.5 h-3 w-px bg-white/10" />

          {/* Width. Disabled at the limit, so the constraint is visible. */}
          <button
            type="button"
            data-testid={`narrower-${placement.id}`}
            onClick={() => onResize({ w: -1 })}
            disabled={!canShrink(placement, "w")}
            aria-label={`Make ${label} narrower (currently ${placement.size.w} of ${limits.max.w} columns)`}
            className="sys-focus rounded p-1 text-sys-dim transition-colors enabled:hover:text-white disabled:opacity-30"
          >
            <Minus size={11} aria-hidden="true" />
          </button>
          <span
            data-testid={`size-${placement.id}`}
            className="font-mono text-xs uppercase tracking-hud text-sys-dim"
          >
            {placement.size.w}×{placement.size.h}
          </span>
          <button
            type="button"
            data-testid={`wider-${placement.id}`}
            onClick={() => onResize({ w: 1 })}
            disabled={!canGrow(placement, "w")}
            aria-label={`Make ${label} wider (currently ${placement.size.w} of ${limits.max.w} columns)`}
            className="sys-focus rounded p-1 text-sys-dim transition-colors enabled:hover:text-white disabled:opacity-30"
          >
            <Plus size={11} aria-hidden="true" />
          </button>

          <span aria-hidden="true" className="mx-0.5 h-3 w-px bg-white/10" />

          {/* Height, as two explicit controls rather than a second ± pair, so
              the labels can say which axis they affect. */}
          <button
            type="button"
            data-testid={`shorter-${placement.id}`}
            onClick={() => onResize({ h: -1 })}
            disabled={!canShrink(placement, "h")}
            aria-label={`Make ${label} shorter (currently ${placement.size.h} of ${limits.max.h} rows)`}
            className="sys-focus rounded px-1 py-1 font-mono text-xs text-sys-dim transition-colors enabled:hover:text-white disabled:opacity-30"
          >
            ↑↓−
          </button>
          <button
            type="button"
            data-testid={`taller-${placement.id}`}
            onClick={() => onResize({ h: 1 })}
            disabled={!canGrow(placement, "h")}
            aria-label={`Make ${label} taller (currently ${placement.size.h} of ${limits.max.h} rows)`}
            className="sys-focus rounded px-1 py-1 font-mono text-xs text-sys-dim transition-colors enabled:hover:text-white disabled:opacity-30"
          >
            ↑↓+
          </button>

          {/* Hide is offered only where hiding is allowed. The Orb has no
              hide control at all, rather than a disabled one that implies the
              dashboard could exist without it. */}
          {limits.hideable && (
            <>
              <span aria-hidden="true" className="mx-0.5 h-3 w-px bg-white/10" />
              <button
                type="button"
                data-testid={`hide-${placement.id}`}
                onClick={onHide}
                aria-label={`Hide ${label}`}
                className="sys-focus rounded p-1 text-sys-dim transition-colors hover:text-red-300"
              >
                <EyeOff size={11} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
