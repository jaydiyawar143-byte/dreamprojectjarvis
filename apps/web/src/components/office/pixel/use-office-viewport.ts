"use client";

// ---------------------------------------------------------------------------
// VO-2.2 Stage 2 — looking around the office.
//
// The scene is an SVG with a viewBox in scene units. Zooming and panning are
// nothing more than changing that viewBox, which the browser then letterboxes
// into whatever box the SVG has (`preserveAspectRatio="xMidYMid meet"`). No
// transforms are animated and no animation frame is scheduled: a gesture sets
// state, React paints once.
//
// Gestures:
//   drag              pan (pointer events, so mouse, pen and touch alike)
//   ctrl/⌘ + wheel    zoom about the pointer (plain wheel still scrolls the
//                     page, so the office never traps a scroll)
//   + / - / 0         zoom in, out, reset, when the scene has focus
//   arrow keys        pan, when the scene has focus
//   double-click      reset
//
// A drag must not also be a click: `consumeDrag()` tells an actor's click
// handler whether the pointer travelled, and the handler ignores the click if
// it did.
//
// The pointer is captured only once a press has BECOME a drag. Capturing on
// pointerdown retargets the pointerup to the SVG, and the browser then sends
// the click to the SVG instead of the figure or sign under the pointer — so
// nothing on the floor could be clicked. (jsdom does not retarget, which is
// why only the browser showed it; the test pins when capture happens.)
//
// The ctrl+wheel listener is added natively, non-passive, because React's
// `onWheel` is passive and `preventDefault` there cannot stop the browser from
// zooming the whole page. It is removed on unmount or when panning is turned
// off.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

import { SCENE, type Rect } from "./floor-plan";

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const ZOOM_STEP = 1.25;
/** Pointer travel, in CSS pixels, past which a gesture is a drag and not a click. */
export const DRAG_THRESHOLD_PX = 4;

export interface OfficeViewport {
  viewBox: Rect;
  /**
   * VO-3.1.1 — what is actually on screen, in scene units. `meet` letterboxes
   * the viewBox into the SVG's box, so the visible area is the viewBox grown
   * to the box's aspect. A figure is drawn only when it fits inside this, and
   * so is its name tag (see the renderer): nothing is ever cut at the edge.
   * Equal to `viewBox` until the box has been measured (and always in jsdom).
   */
  visible: Rect;
  /** 1 = the whole office; 4 = four times closer. */
  scale: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  /** True once if the gesture that just ended moved the pointer; clears itself. */
  consumeDrag: () => boolean;
  svgRef: RefObject<SVGSVGElement>;
  handlers: {
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (event: PointerEvent<SVGSVGElement>) => void;
    onPointerCancel: (event: PointerEvent<SVGSVGElement>) => void;
    onKeyDown: (event: KeyboardEvent<SVGSVGElement>) => void;
    onDoubleClick: () => void;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Keeps a viewBox inside the scene and its scale inside the limits. */
export function clampViewport(next: Rect): Rect {
  const scale = clamp(SCENE.w / next.w, MIN_SCALE, MAX_SCALE);
  const w = SCENE.w / scale;
  const h = SCENE.h / scale;
  return {
    x: clamp(next.x, SCENE.x, SCENE.x + SCENE.w - w),
    y: clamp(next.y, SCENE.y, SCENE.y + SCENE.h - h),
    w,
    h,
  };
}

/** The viewBox that shows `target`, at the scene's aspect ratio, centred on it. */
export function viewportAround(target: Rect): Rect {
  const scale = clamp(Math.min(SCENE.w / target.w, SCENE.h / target.h), MIN_SCALE, MAX_SCALE);
  const w = SCENE.w / scale;
  const h = SCENE.h / scale;
  return clampViewport({
    x: target.x + target.w / 2 - w / 2,
    y: target.y + target.h / 2 - h / 2,
    w,
    h,
  });
}

/** Zooms `current` by `factor`, keeping the scene point `about` where it is. */
export function zoomViewport(current: Rect, factor: number, about?: { x: number; y: number }): Rect {
  const scale = clamp((SCENE.w / current.w) * factor, MIN_SCALE, MAX_SCALE);
  const w = SCENE.w / scale;
  const h = SCENE.h / scale;
  const anchor = about ?? { x: current.x + current.w / 2, y: current.y + current.h / 2 };
  // The anchor's relative position in the old box is kept in the new one.
  const fx = (anchor.x - current.x) / current.w;
  const fy = (anchor.y - current.y) / current.h;
  return clampViewport({ x: anchor.x - fx * w, y: anchor.y - fy * h, w, h });
}

/**
 * The scene area a `meet`-letterboxed viewBox shows in a box of `size` CSS
 * pixels: the viewBox, centred, grown along the axis the box has room to spare.
 */
export function visibleArea(box: Rect, size: { width: number; height: number } | null): Rect {
  if (!size || size.width <= 0 || size.height <= 0) return box;
  const scale = Math.min(size.width / box.w, size.height / box.h);
  const w = size.width / scale;
  const h = size.height / scale;
  return { x: box.x - (w - box.w) / 2, y: box.y - (h - box.h) / 2, w, h };
}

export function useOfficeViewport(enabled: boolean, focus: Rect | null = null): OfficeViewport {
  const [viewBox, setViewBox] = useState<Rect>(SCENE);
  const svgRef = useRef<SVGSVGElement>(null);

  // The SVG's rendered size, for `visible`. Measured on mount and on resize.
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!enabled || !svg) return;
    const measure = () => {
      const bounds = svg.getBoundingClientRect();
      setBoxSize((current) =>
        current && Math.abs(current.width - bounds.width) < 0.5 && Math.abs(current.height - bounds.height) < 0.5
          ? current
          : bounds.width > 0 && bounds.height > 0
            ? { width: bounds.width, height: bounds.height }
            : null
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [enabled]);
  const visible = useMemo(() => visibleArea(viewBox, boxSize), [viewBox, boxSize]);

  const gesture = useRef<{ pointerId: number; startX: number; startY: number; box: Rect } | null>(null);
  const dragged = useRef(false);

  // A focused room sets the box; clearing the focus shows the whole office.
  // Keyed by the rectangle's VALUE: a caller may build the rect on every
  // render, and an effect keyed on the object would set state on every render.
  const focusKey = focus ? `${focus.x},${focus.y},${focus.w},${focus.h}` : "";
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    const target = focusRef.current;
    setViewBox(target ? viewportAround(target) : SCENE);
  }, [focusKey]);

  useEffect(() => {
    if (!enabled) setViewBox(SCENE);
  }, [enabled]);

  /** Scene units per CSS pixel, from the SVG's rendered box. */
  const unitsPerPixel = useCallback(
    (box: Rect): number => {
      const bounds = svgRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return 1;
      // `meet` letterboxes: the scene is scaled by the smaller of the two ratios.
      return Math.max(box.w / bounds.width, box.h / bounds.height);
    },
    []
  );

  const pointToScene = useCallback(
    (clientX: number, clientY: number, box: Rect): { x: number; y: number } => {
      const bounds = svgRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      }
      const ratio = unitsPerPixel(box);
      // The letterboxed scene is centred in the box.
      const drawnW = box.w / ratio;
      const drawnH = box.h / ratio;
      const offsetX = (bounds.width - drawnW) / 2;
      const offsetY = (bounds.height - drawnH) / 2;
      return {
        x: box.x + (clientX - bounds.left - offsetX) * ratio,
        y: box.y + (clientY - bounds.top - offsetY) * ratio,
      };
    },
    [unitsPerPixel]
  );

  const zoomIn = useCallback(() => setViewBox((current) => zoomViewport(current, ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setViewBox((current) => zoomViewport(current, 1 / ZOOM_STEP)), []);
  const reset = useCallback(() => {
    const target = focusRef.current;
    setViewBox(target ? viewportAround(target) : SCENE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const consumeDrag = useCallback(() => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  }, []);

  // ctrl/⌘ + wheel zooms about the pointer. Native and non-passive: see above.
  useEffect(() => {
    const svg = svgRef.current;
    if (!enabled || !svg) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setViewBox((current) =>
        zoomViewport(
          current,
          event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
          pointToScene(event.clientX, event.clientY, current)
        )
      );
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [enabled, pointToScene]);

  const handlers = useMemo<OfficeViewport["handlers"]>(
    () => ({
      onPointerDown: (event) => {
        if (!enabled) return;
        // Only the primary button pans; a right-click is the browser's.
        if (event.button !== 0) return;
        gesture.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          box: viewBox,
        };
        dragged.current = false;
        // No capture here: see the header. A plain press stays a click on
        // whatever is under it.
      },
      onPointerMove: (event) => {
        const active = gesture.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const dx = event.clientX - active.startX;
        const dy = event.clientY - active.startY;
        if (!dragged.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        if (!dragged.current) {
          // Now it is a drag: keep receiving moves even if the pointer leaves
          // the floor.
          const target = event.currentTarget;
          if (typeof target.setPointerCapture === "function") {
            try {
              target.setPointerCapture(event.pointerId);
            } catch {
              // Some pens refuse capture; dragging still works without it.
            }
          }
        }
        dragged.current = true;
        const ratio = unitsPerPixel(active.box);
        setViewBox(
          clampViewport({
            ...active.box,
            x: active.box.x - dx * ratio,
            y: active.box.y - dy * ratio,
          })
        );
      },
      onPointerUp: (event) => {
        if (gesture.current?.pointerId !== event.pointerId) return;
        gesture.current = null;
        const target = event.currentTarget;
        if (
          dragged.current &&
          typeof target.hasPointerCapture === "function" &&
          target.hasPointerCapture(event.pointerId)
        ) {
          try {
            target.releasePointerCapture(event.pointerId);
          } catch {
            // Already released.
          }
        }
        // A captured drag's click lands on the SVG, where nothing consumes
        // the flag. The click is dispatched in this same task, so clearing it
        // on the next one keeps "a drag is not a click" and stops a stale flag
        // from swallowing a later Enter or Space on a figure.
        if (dragged.current) {
          setTimeout(() => {
            dragged.current = false;
          }, 0);
        }
      },
      onPointerCancel: () => {
        gesture.current = null;
        dragged.current = false;
      },
      onKeyDown: (event) => {
        if (!enabled) return;
        const step = viewBox.w / 8;
        const pan = (dx: number, dy: number) =>
          setViewBox((current) => clampViewport({ ...current, x: current.x + dx, y: current.y + dy }));
        switch (event.key) {
          case "+":
          case "=":
            event.preventDefault();
            zoomIn();
            break;
          case "-":
          case "_":
            event.preventDefault();
            zoomOut();
            break;
          case "0":
            event.preventDefault();
            reset();
            break;
          case "ArrowLeft":
            event.preventDefault();
            pan(-step, 0);
            break;
          case "ArrowRight":
            event.preventDefault();
            pan(step, 0);
            break;
          case "ArrowUp":
            event.preventDefault();
            pan(0, -step);
            break;
          case "ArrowDown":
            event.preventDefault();
            pan(0, step);
            break;
          default:
            break;
        }
      },
      onDoubleClick: () => {
        if (enabled) reset();
      },
    }),
    [enabled, viewBox, unitsPerPixel, zoomIn, zoomOut, reset]
  );

  const scale = SCENE.w / viewBox.w;

  return {
    viewBox,
    visible,
    scale,
    canZoomIn: scale < MAX_SCALE - 1e-6,
    canZoomOut: scale > MIN_SCALE + 1e-6,
    zoomIn,
    zoomOut,
    reset,
    consumeDrag,
    svgRef,
    handlers,
  };
}
