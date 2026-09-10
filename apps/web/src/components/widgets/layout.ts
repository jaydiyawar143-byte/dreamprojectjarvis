// ---------------------------------------------------------------------------
// V4 — the dashboard layout model.
//
// Pure functions and plain data: no React, no DOM. Dragging, the keyboard
// controls and any future voice command ("put the map top right") all go
// through these same functions, so the three can never diverge in what they
// permit.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED FROM V3, AND WHY.
//
// V3 stored an ORDER plus a SIZE per widget and let CSS grid's dense auto-flow
// do the packing. It was a defensible model — the browser cannot produce an
// overlap or a hole — but it bought that safety by taking placement away from
// the user. The only way to express "make this bigger" was a pair of ± buttons
// stepping through whole columns, and the only way to express "put it there"
// was to nudge it through a one-dimensional order until it landed. There was no
// way to say "here", because the model had no coordinates to say it with.
//
// V4 stores real coordinates: {x, y, w, h} on a fixed 12x12 grid. The user drags
// a widget where they want it and drags a corner to size it. The grid is what
// makes that safe rather than chaotic — every position snaps to a cell, and the
// grid is BOUNDED, so no arrangement can push the dashboard past the viewport.
//
// WHY A FIXED NUMBER OF ROWS, NOT AN OPEN CANVAS.
//
// Twelve rows is not a scroll region that happens to be twelve tall — it is the
// viewport, divided. The row HEIGHT is computed at render time from the space
// actually available (see command-center.tsx), so twelve rows always means
// "exactly the screen". That is the property that makes a page scrollbar
// structurally impossible rather than merely absent: a widget cannot be dragged
// to row 13, because there is no row 13.
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

/**
 * The grid every layout is expressed in.
 *
 * Twelve columns is the usual choice for a reason: it divides by 2, 3, 4 and 6,
 * so halves, thirds and quarters are all expressible exactly. Twelve rows gives
 * the vertical axis the same granularity, which matters once the user is
 * dragging a corner rather than picking from a list — a 6-row grid would make
 * every size jump feel coarse.
 */
export const GRID_COLS = 12;

/**
 * The nominal grid: what the shipped layout fills, and the FEWEST rows the
 * workspace is ever divided into.
 */
export const GRID_ROWS = 12;

/**
 * The most rows a layout may reach, and why there is a second number at all.
 *
 * The shipped layout tiles 12x12 exactly, which is what makes the dashboard
 * look finished on first open — and it also means there is nowhere to drop
 * anything. Every drag must displace something, react-grid-layout pushes the
 * displaced widgets down, and the arrangement grows past twelve rows.
 *
 * Three ways out, and only one of them is honest:
 *
 *   - refuse the drop. The library snaps back cleanly, but with a fully tiled
 *     default NOTHING can ever be moved, which is the opposite of the point.
 *   - let the workspace scroll. Then the dashboard is a scrolling page again,
 *     just one level down.
 *   - let the ROW COUNT grow and shrink the ROW HEIGHT to match, so the grid is
 *     still exactly the height of the workspace.
 *
 * The third is what happens. A drag that needs fourteen rows gets fourteen
 * shorter rows, not a scrollbar. Vertical compaction then pulls everything back
 * up as soon as it can, so the row count returns to twelve on its own once the
 * arrangement re-tiles — the shrinking is a transient of a messy layout, not a
 * permanent tax.
 *
 * The ceiling is generous on purpose. It bounds what may be STORED — a layout
 * restored from the server, or one built with the keyboard — and it has to sit
 * above anything the grid library can produce on its own, because a stored
 * layout clamped tighter than the library would re-place it does not survive a
 * round trip: the clamp creates an overlap, compaction resolves it somewhere
 * else, and the arrangement the user saved is not the one they get back.
 *
 * It is NOT enforced by the library. `maxRows` was measured doing nothing to
 * stop vertical compaction pushing past it, which is the whole reason the row
 * height absorbs depth instead of the row count being capped.
 */
export const MAX_ROWS = 32;

export interface WidgetPlacement {
  id: WidgetId;
  /** Column, 0-based, 0..GRID_COLS-1. */
  x: number;
  /** Row, 0-based, 0..GRID_ROWS-1. */
  y: number;
  /** Width in columns, >= 1. */
  w: number;
  /** Height in rows, >= 1. */
  h: number;
  hidden?: boolean;
}

export interface WidgetConstraints {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
  /**
   * Whether the user may hide it.
   *
   * The Orb is the product. A dashboard where it can be switched off is a
   * different product, so it is not offered — which is also why "hide" is a
   * per-widget property rather than a blanket capability.
   */
  hideable: boolean;
}

/**
 * Per-widget limits, in grid units.
 *
 * The minimums are the size below which a widget stops being able to say what
 * it knows — a map you cannot orient in, a monitor whose tiles cannot sit side
 * by side. They are enforced by the resize handles themselves, so the user
 * feels the limit as resistance rather than discovering it as a broken card.
 */
export const CONSTRAINTS: Record<WidgetId, WidgetConstraints> = {
  orb: { minW: 3, minH: 4, maxW: GRID_COLS, maxH: GRID_ROWS, hideable: false },
  map: { minW: 3, minH: 3, maxW: GRID_COLS, maxH: GRID_ROWS, hideable: true },
  system: { minW: 3, minH: 3, maxW: GRID_COLS, maxH: GRID_ROWS, hideable: true },
  clock: { minW: 2, minH: 2, maxW: 8, maxH: 8, hideable: true },
  worldclock: { minW: 2, minH: 3, maxW: 8, maxH: 10, hideable: true },
  weather: { minW: 2, minH: 3, maxW: 8, maxH: 10, hideable: true },
  tasks: { minW: 2, minH: 3, maxW: 8, maxH: GRID_ROWS, hideable: true },
  markets: { minW: 3, minH: 3, maxW: GRID_COLS, maxH: GRID_ROWS, hideable: true },
};

/**
 * The layout JARVIS ships with.
 *
 * It tiles the 12x12 grid EXACTLY — 144 cells, no overlap and no holes:
 *
 *     rows 0-3   orb(0-3)   map(4-11)
 *     rows 4-6   orb(0-3)   system(4-7)  weather(8-9)  tasks(10-11)
 *     row  7     clock(0-1) worldclock(2-3) system(4-7) weather(8-9) tasks(10-11)
 *     rows 8-11  clock(0-1) worldclock(2-3) markets(4-11)
 *
 *   ┌──────────┬──────────────────────────────┐
 *   │          │             MAP              │
 *   │   ORB    ├──────────┬─────────┬─────────┤
 *   │          │  SYSTEM  │ WEATHER │  TASKS  │
 *   ├────┬─────┤          │         │         │
 *   │CLK │WORLD│          │         │         │
 *   │    │     ├──────────┴─────────┴─────────┤
 *   │    │     │           MARKETS            │
 *   └────┴─────┴──────────────────────────────┘
 *
 * Tiling exactly is what stops the dashboard opening with a dead area in one
 * corner. It is a starting point, not a constraint — the moment the user drags
 * anything they can leave whatever gaps they like.
 */
export const DEFAULT_LAYOUT: WidgetPlacement[] = [
  { id: "orb", x: 0, y: 0, w: 4, h: 7 },
  { id: "map", x: 4, y: 0, w: 8, h: 4 },
  { id: "system", x: 4, y: 4, w: 4, h: 4 },
  { id: "weather", x: 8, y: 4, w: 2, h: 4 },
  { id: "tasks", x: 10, y: 4, w: 2, h: 4 },
  { id: "clock", x: 0, y: 7, w: 2, h: 5 },
  { id: "worldclock", x: 2, y: 7, w: 2, h: 5 },
  { id: "markets", x: 4, y: 8, w: 8, h: 4 },
];

export const ALL_WIDGET_IDS: WidgetId[] = DEFAULT_LAYOUT.map((p) => p.id);

export function isWidgetId(value: unknown): value is WidgetId {
  return typeof value === "string" && (ALL_WIDGET_IDS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/**
 * Forces one placement inside the grid and inside its own limits.
 *
 * Everything that can produce a placement — a drag, a keyboard nudge, a layout
 * restored from the server, a layout written by an older build — goes through
 * here. It is the single point at which "a widget cannot leave the workspace"
 * is true, which is why it is applied on the way IN from the grid library as
 * well as on the way out to it.
 */
export function clampPlacement(placement: WidgetPlacement): WidgetPlacement {
  const limits = CONSTRAINTS[placement.id];

  // Size first: a width is meaningless until it is known to fit the grid at all,
  // and the position below has to be clamped against the size that survives.
  const w = clamp(Math.round(placement.w), limits.minW, Math.min(limits.maxW, GRID_COLS));
  const h = clamp(Math.round(placement.h), limits.minH, Math.min(limits.maxH, GRID_ROWS));

  return {
    ...placement,
    w,
    h,
    x: clamp(Math.round(placement.x), 0, GRID_COLS - w),
    // Against MAX_ROWS, not GRID_ROWS. Clamping to twelve here would fight the
    // grid's own compaction rather than help it: a widget pushed to row 13
    // would be yanked back to a row that is already occupied, the library would
    // push it down again on the next pass, and the two would argue forever.
    // Row height absorbs the extra rows instead — see MAX_ROWS.
    y: clamp(Math.round(placement.y), 0, MAX_ROWS - h),
  };
}

/**
 * How many rows this arrangement actually needs.
 *
 * Never fewer than the nominal twelve, so a layout with a short bottom row does
 * not stretch its widgets to fill the screen.
 */
export function layoutRows(layout: WidgetPlacement[]): number {
  const visible = visibleWidgets(layout);
  const deepest = visible.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  // Deliberately NOT capped at MAX_ROWS. `clampPlacement` already guarantees no
  // stored placement goes past it, so the cap would be a no-op on the happy
  // path — and on the unhappy one (the grid library reporting a taller layout
  // mid-drag, before the clamp has round-tripped) capping here would compute a
  // row height too tall for the content and let widgets spill out of the
  // workspace. Trusting the layout in front of us is what keeps that impossible.
  return Math.max(GRID_ROWS, deepest);
}

/**
 * Fixes only the HORIZONTAL bounds and the size limits, leaving `y` alone.
 *
 * This is the version used for layouts coming back from the grid library, and
 * the difference from `clampPlacement` is the whole reason both exist.
 *
 * Clamping `y` there was a bug that took a while to see. The library maintains
 * its own layout and re-compacts after every change; pulling a widget up to fit
 * a row ceiling puts it on top of something, so the library pushes it back down
 * and reports that, and the clamp pulls it up again. The two never agree. What
 * shows on screen is the library's version while the app believes its own, and
 * the row height — computed from the app's shallower idea of the layout — is
 * then too tall for what is actually rendered. Widgets hang out of the bottom
 * of the workspace, which is exactly the thing the clamp was there to prevent.
 *
 * So depth is not fought here; it is ABSORBED, by `layoutRows` reporting the
 * real depth and the row height shrinking to match. `x` and the size limits are
 * still enforced, because those never fight compaction — the library respects
 * the column count strictly, so this is a guard rather than a correction.
 */
export function clampToColumns(placement: WidgetPlacement): WidgetPlacement {
  const limits = CONSTRAINTS[placement.id];
  const w = clamp(Math.round(placement.w), limits.minW, Math.min(limits.maxW, GRID_COLS));
  const h = clamp(Math.round(placement.h), limits.minH, Math.min(limits.maxH, GRID_ROWS));

  return {
    ...placement,
    w,
    h,
    x: clamp(Math.round(placement.x), 0, GRID_COLS - w),
    y: Math.max(0, Math.round(placement.y)),
  };
}

/** Moves a widget by whole cells. The keyboard equivalent of dragging it. */
export function nudge(
  layout: WidgetPlacement[],
  id: WidgetId,
  dx: number,
  dy: number
): WidgetPlacement[] {
  let changed = false;
  const next = layout.map((p) => {
    if (p.id !== id) return p;
    const moved = clampPlacement({ ...p, x: p.x + dx, y: p.y + dy });
    if (moved.x !== p.x || moved.y !== p.y) changed = true;
    return moved;
  });
  // Reference equality means "nothing happened" to every caller, including the
  // dirty tracking in useDashboardLayout.
  return changed ? next : layout;
}

/** Grows or shrinks a widget by whole cells. The keyboard equivalent of a corner drag. */
export function resizeBy(
  layout: WidgetPlacement[],
  id: WidgetId,
  dw: number,
  dh: number
): WidgetPlacement[] {
  let changed = false;
  const next = layout.map((p) => {
    if (p.id !== id) return p;
    const sized = clampPlacement({ ...p, w: p.w + dw, h: p.h + dh });
    if (sized.w !== p.w || sized.h !== p.h || sized.x !== p.x || sized.y !== p.y) changed = true;
    return sized;
  });
  return changed ? next : layout;
}

export function canGrow(placement: WidgetPlacement, axis: "w" | "h"): boolean {
  const limits = CONSTRAINTS[placement.id];
  return axis === "w"
    ? placement.w < Math.min(limits.maxW, GRID_COLS)
    : placement.h < Math.min(limits.maxH, GRID_ROWS);
}

export function canShrink(placement: WidgetPlacement, axis: "w" | "h"): boolean {
  const limits = CONSTRAINTS[placement.id];
  return axis === "w" ? placement.w > limits.minW : placement.h > limits.minH;
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

/** Do two placements share any cell? */
export function overlaps(a: WidgetPlacement, b: WidgetPlacement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Every pair that overlaps, and every widget outside the grid.
 *
 * The grid library maintains both invariants while it is driving, so this is
 * not a runtime guard on the happy path — it is how a test states the
 * invariants, and how a layout restored from the server is checked before it is
 * trusted.
 */
export function findCollisions(layout: WidgetPlacement[]): Array<[WidgetId, WidgetId]> {
  const visible = visibleWidgets(layout);
  const hits: Array<[WidgetId, WidgetId]> = [];
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]!;
      const b = visible[j]!;
      if (overlaps(a, b)) hits.push([a.id, b.id]);
    }
  }
  return hits;
}

/** Inside the columns, and inside the row ceiling. */
export function isWithinGrid(p: WidgetPlacement): boolean {
  return p.x >= 0 && p.y >= 0 && p.x + p.w <= GRID_COLS && p.y + p.h <= MAX_ROWS;
}

/** Inside the NOMINAL twelve rows — what the shipped layout must satisfy. */
export function isWithinNominalGrid(p: WidgetPlacement): boolean {
  return p.x >= 0 && p.y >= 0 && p.x + p.w <= GRID_COLS && p.y + p.h <= GRID_ROWS;
}

/** Cells occupied by the visible widgets, for "does the default tile?" assertions. */
export function occupiedCells(layout: WidgetPlacement[]): number {
  return visibleWidgets(layout).reduce((sum, p) => sum + p.w * p.h, 0);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The pixel height of one grid row, given the height the workspace actually has.
 *
 * This is the single line that makes a page scrollbar impossible. The grid does
 * not have a row height that its container then has to accommodate; it has the
 * container's height, divided by however many rows the arrangement needs. Those
 * rows plus their gaps therefore always come to AT MOST the space available:
 *
 *     rows * rowHeight + (rows - 1) * margin  <=  available
 *
 * `rows` is an input for exactly the reason described on MAX_ROWS: a drag can
 * push the arrangement past twelve rows, and the answer is shorter rows rather
 * than a scrollbar.
 *
 * FLOORED, deliberately. A fractional row height rounded up is multiplied by
 * the row count, and that is exactly how a layout ends up a few pixels taller
 * than the box it was measured from — which is a scrollbar.
 */
/**
 * The shortest a row is allowed to get.
 *
 * Deliberately tiny. It is not a readable row height — it is the last line of
 * defence, chosen so that even a pathologically deep arrangement still fits the
 * workspace rather than hanging out of it. When this floor was set to a
 * comfortable 16px it CAUSED the overflow it was meant to prevent: a 26-row
 * arrangement in a 562px workspace needs 12px rows, was given 16, and overflowed
 * by exactly the difference. A floor that fights the fit is not a floor.
 */
export const MIN_ROW_HEIGHT = 6;

export function gridRowHeight(
  availableHeight: number,
  margin: number,
  rows: number = GRID_ROWS
): number {
  const usable = availableHeight - margin * (rows - 1);
  return Math.max(MIN_ROW_HEIGHT, Math.floor(usable / rows));
}



/** The height the grid will actually occupy at that row height. */
export function gridHeight(rowHeight: number, margin: number, rows: number = GRID_ROWS): number {
  return rowHeight * rows + margin * (rows - 1);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** A V3 entry, as still held in the database for anyone who saved one. */
interface LegacyPlacement {
  id: WidgetId;
  size?: { w?: unknown; h?: unknown };
  hidden?: unknown;
}

function isLegacy(entry: unknown): entry is LegacyPlacement {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "size" in entry &&
    !("x" in entry) &&
    !("y" in entry)
  );
}

/**
 * Repairs a stored layout, and MIGRATES one written by V3.
 *
 * A saved layout is user data that outlives the code that wrote it, so this
 * assumes nothing: unknown ids are dropped (a widget removed in a later
 * release), missing ids are appended (a widget added in a later release, which
 * would otherwise be invisible to every existing user), and every placement is
 * re-clamped in case the constraints themselves changed.
 *
 * The V3 -> V4 migration is deliberately crude. V3 stored an order and a size on
 * a 4-column grid and had no coordinates at all, so there is no faithful
 * translation — the information simply was not recorded. Rather than invent
 * positions that would land widgets on top of each other, a legacy layout is
 * honoured only for WHICH widgets were hidden, and the positions come from the
 * shipped default. Losing a hand-tuned V3 arrangement is a real cost; silently
 * restoring a broken one would be worse, and there is no third option that is
 * not a guess presented as a memory.
 */
export function normalizeLayout(stored: unknown): WidgetPlacement[] {
  if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_LAYOUT;

  if (stored.some(isLegacy)) {
    const hiddenIds = new Set<WidgetId>();
    for (const entry of stored) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      if (isWidgetId(id) && (entry as { hidden?: unknown }).hidden === true) hiddenIds.add(id);
    }
    return DEFAULT_LAYOUT.map((p) =>
      hiddenIds.has(p.id) && CONSTRAINTS[p.id].hideable ? { ...p, hidden: true } : p
    );
  }

  const seen = new Set<WidgetId>();
  const result: WidgetPlacement[] = [];

  for (const entry of stored) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (!isWidgetId(id) || seen.has(id)) continue;

    const raw = entry as { x?: unknown; y?: unknown; w?: unknown; h?: unknown; hidden?: unknown };
    const fallback = DEFAULT_LAYOUT.find((p) => p.id === id)!;
    const num = (v: unknown, or: number) => (typeof v === "number" && Number.isFinite(v) ? v : or);

    const placed = clampPlacement({
      id,
      x: num(raw.x, fallback.x),
      y: num(raw.y, fallback.y),
      w: num(raw.w, fallback.w),
      h: num(raw.h, fallback.h),
    });

    // A stored layout cannot hide something that must stay visible, even if it
    // was written when that widget was hideable.
    result.push(
      raw.hidden === true && CONSTRAINTS[id].hideable ? { ...placed, hidden: true } : placed
    );
    seen.add(id);
  }

  for (const fallback of DEFAULT_LAYOUT) {
    if (!seen.has(fallback.id)) result.push(fallback);
  }

  return result.length > 0 ? result : DEFAULT_LAYOUT;
}
