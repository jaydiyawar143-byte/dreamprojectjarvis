// ---------------------------------------------------------------------------
// V3 — the dashboard layout model.
//
// Pure functions and plain data: no React, no DOM. Drag, the keyboard move
// buttons and any future voice command ("make the system monitor bigger") all
// go through these same functions, so the three can never diverge in what they
// permit.
//
// WHY AN ORDERED LIST RATHER THAN (x, y) COORDINATES.
//
// A free-form coordinate grid needs collision detection, compaction and
// re-flow, and every one of those is a source of widgets landing on top of each
// other or leaving holes. Instead the layout is an ORDER plus a SIZE per widget,
// rendered into a CSS grid with dense auto-placement. The browser does the
// packing, which it is extremely good at.
//
// The trade-off is honest: a user cannot leave a deliberate gap. What they get
// instead is a layout that can never be broken, that reflows correctly at every
// breakpoint without a second stored layout per screen size, and where "move
// left" has an obvious meaning on a phone as well as a monitor.
// ---------------------------------------------------------------------------

export type WidgetId =
  | "orb"
  | "map"
  | "system"
  | "clock"
  | "worldclock"
  | "weather"
  | "tasks"
  | "markets";

/** Grid units. The dashboard grid is 4 columns wide on a large screen. */
export interface WidgetSize {
  w: 1 | 2 | 3 | 4;
  h: 1 | 2 | 3;
}

export interface WidgetPlacement {
  id: WidgetId;
  size: WidgetSize;
  hidden?: boolean;
}

export interface WidgetConstraints {
  min: WidgetSize;
  max: WidgetSize;
  /**
   * Whether the user may hide it.
   *
   * The Orb is the product. A dashboard where it can be switched off is a
   * different product, so it is not offered — which is also why "hide" is a
   * per-widget property rather than a blanket capability.
   */
  hideable: boolean;
}

export const CONSTRAINTS: Record<WidgetId, WidgetConstraints> = {
  // The hero. Its minimum is deliberately large: shrinking it to a tile would
  // stop it being the primary visual element, which is the one thing the
  // dashboard is for.
  orb: { min: { w: 2, h: 2 }, max: { w: 4, h: 3 }, hideable: false },
  // A real interactive Google map. 2×2 by default because that is where it
  // becomes genuinely usable; 1×1 is permitted because the brief asks for it,
  // and a Google map does still pan and zoom at that size.
  map: { min: { w: 1, h: 1 }, max: { w: 3, h: 3 }, hideable: true },
  // Six metric tiles plus sparklines need the height.
  system: { min: { w: 1, h: 2 }, max: { w: 3, h: 3 }, hideable: true },
  clock: { min: { w: 1, h: 1 }, max: { w: 2, h: 2 }, hideable: true },
  worldclock: { min: { w: 1, h: 1 }, max: { w: 2, h: 2 }, hideable: true },
  weather: { min: { w: 1, h: 1 }, max: { w: 2, h: 3 }, hideable: true },
  tasks: { min: { w: 1, h: 1 }, max: { w: 2, h: 3 }, hideable: true },
  markets: { min: { w: 1, h: 1 }, max: { w: 2, h: 3 }, hideable: true },
};

/**
 * The layout JARVIS ships with.
 *
 * Ordered to put the Orb first and largest, with the two widgets that most
 * reward space — the map and the system monitor — beside it, then the compact
 * row underneath. This is the composition the grid renders before any user has
 * expressed a preference.
 */
export const DEFAULT_LAYOUT: WidgetPlacement[] = [
  { id: "orb", size: { w: 2, h: 3 } },
  { id: "map", size: { w: 2, h: 2 } },
  { id: "system", size: { w: 1, h: 2 } },
  { id: "weather", size: { w: 1, h: 1 } },
  { id: "clock", size: { w: 1, h: 1 } },
  { id: "worldclock", size: { w: 1, h: 1 } },
  { id: "tasks", size: { w: 1, h: 1 } },
  { id: "markets", size: { w: 1, h: 2 } },
];

export const ALL_WIDGET_IDS: WidgetId[] = DEFAULT_LAYOUT.map((p) => p.id);

export function isWidgetId(value: unknown): value is WidgetId {
  return typeof value === "string" && (ALL_WIDGET_IDS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** Applies a size change, clamped to the widget's own constraints. */
export function resize(
  layout: WidgetPlacement[],
  id: WidgetId,
  delta: { w?: number; h?: number }
): WidgetPlacement[] {
  const limits = CONSTRAINTS[id];
  return layout.map((p) => {
    if (p.id !== id) return p;
    return {
      ...p,
      size: {
        w: clamp(p.size.w + (delta.w ?? 0), limits.min.w, limits.max.w) as WidgetSize["w"],
        h: clamp(p.size.h + (delta.h ?? 0), limits.min.h, limits.max.h) as WidgetSize["h"],
      },
    };
  });
}

export function canGrow(placement: WidgetPlacement, axis: "w" | "h"): boolean {
  return placement.size[axis] < CONSTRAINTS[placement.id].max[axis];
}

export function canShrink(placement: WidgetPlacement, axis: "w" | "h"): boolean {
  return placement.size[axis] > CONSTRAINTS[placement.id].min[axis];
}

/**
 * Moves a widget one position through the VISIBLE order.
 *
 * Stepping through visible widgets only is what makes the keyboard controls
 * match what the user sees: with a hidden widget in between, moving "one place
 * left" against the raw array would appear to do nothing.
 */
export function move(
  layout: WidgetPlacement[],
  id: WidgetId,
  direction: -1 | 1
): WidgetPlacement[] {
  const visible = layout.filter((p) => !p.hidden);
  const from = visible.findIndex((p) => p.id === id);
  if (from === -1) return layout;

  const to = from + direction;
  if (to < 0 || to >= visible.length) return layout;

  const reordered = [...visible];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved!);

  // Hidden widgets keep their relative place at the end, so unhiding one does
  // not drop it in an arbitrary position.
  return [...reordered, ...layout.filter((p) => p.hidden)];
}

/** Moves a widget to an absolute index in the visible order. Used by drag. */
export function moveTo(
  layout: WidgetPlacement[],
  id: WidgetId,
  targetIndex: number
): WidgetPlacement[] {
  const visible = layout.filter((p) => !p.hidden);
  const from = visible.findIndex((p) => p.id === id);
  if (from === -1) return layout;

  const to = clamp(targetIndex, 0, visible.length - 1);
  if (to === from) return layout;

  const reordered = [...visible];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved!);

  return [...reordered, ...layout.filter((p) => p.hidden)];
}

/**
 * Hides or shows a widget.
 *
 * A request to hide something that must stay is IGNORED rather than throwing:
 * this is reachable from a voice command, and refusing loudly is worse than
 * quietly declining to break the dashboard.
 */
export function setHidden(
  layout: WidgetPlacement[],
  id: WidgetId,
  hidden: boolean
): WidgetPlacement[] {
  if (hidden && !CONSTRAINTS[id].hideable) return layout;
  return layout.map((p) => (p.id === id ? { ...p, hidden } : p));
}

export function visibleWidgets(layout: WidgetPlacement[]): WidgetPlacement[] {
  return layout.filter((p) => !p.hidden);
}

/**
 * Repairs a stored layout.
 *
 * A saved layout is user data that outlives the code that wrote it, so this
 * assumes nothing: unknown ids are dropped (a widget removed in a later
 * release), missing ids are appended (a widget added in a later release, which
 * would otherwise be invisible to every existing user), and every size is
 * re-clamped in case the constraints themselves changed.
 */
export function normalizeLayout(stored: unknown): WidgetPlacement[] {
  if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_LAYOUT;

  const seen = new Set<WidgetId>();
  const result: WidgetPlacement[] = [];

  for (const entry of stored) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (!isWidgetId(id) || seen.has(id)) continue;

    const limits = CONSTRAINTS[id];
    const size = (entry as { size?: { w?: unknown; h?: unknown } }).size ?? {};
    const w = typeof size.w === "number" ? size.w : limits.min.w;
    const h = typeof size.h === "number" ? size.h : limits.min.h;

    const hidden = (entry as { hidden?: unknown }).hidden === true;

    result.push({
      id,
      size: {
        w: clamp(Math.round(w), limits.min.w, limits.max.w) as WidgetSize["w"],
        h: clamp(Math.round(h), limits.min.h, limits.max.h) as WidgetSize["h"],
      },
      // A stored layout cannot hide something that must stay visible, even if
      // it was written when that widget was hideable.
      ...(hidden && limits.hideable ? { hidden: true } : {}),
    });
    seen.add(id);
  }

  for (const fallback of DEFAULT_LAYOUT) {
    if (!seen.has(fallback.id)) result.push(fallback);
  }

  return result.length > 0 ? result : DEFAULT_LAYOUT;
}

/** Tailwind span classes per size. Static strings so the JIT can see them. */
export const COL_SPAN: Record<WidgetSize["w"], string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
};

export const ROW_SPAN: Record<WidgetSize["h"], string> = {
  1: "lg:row-span-1",
  2: "lg:row-span-2",
  3: "lg:row-span-3",
};
