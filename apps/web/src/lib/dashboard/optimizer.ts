// ---------------------------------------------------------------------------
// Dashboard layout optimization.
//
// WHAT THIS IS. A pure function from (layout, what the widgets actually
// measured, viewport) to a set of PROPOSED placement changes, plus the sentences
// explaining them. It computes; it does not act. Applying is a separate call the
// UI makes only after the user says yes.
//
// WHY PURE. Every safety rule in the brief — never delete a widget, never touch
// user data, never call a tool, never send anything — is satisfied structurally
// rather than by discipline, because this module is handed nothing but geometry
// and returns nothing but geometry. There is no client here, no fetch, no store,
// no widget instance. A change to this file cannot send an email because there
// is nothing in scope that could.
//
// WHY IT MEASURES RATHER THAN GUESSES. "Weather is too narrow" is not something
// you can tell from grid units: two columns is roomy at 2560px and cramped at
// 1280px, and it depends on whether the place name is "Pune" or
// "Thiruvananthapuram". So the analysis takes OBSERVATIONS — the rendered pixel
// box and whether content actually overflowed it — and reasons from those. A
// recommendation that cannot point at a measurement is not made.
//
// CONFIDENCE IS PART OF THE OUTPUT. When the engine cannot place a change
// without disturbing something it does not understand, it reports the issue and
// withholds the change. Recommending is always safe; applying is not, and the
// brief is explicit that low confidence means recommend only.
// ---------------------------------------------------------------------------

import {
  CONSTRAINTS,
  GRID_COLS,
  GRID_ROWS,
  overlaps,
  visibleWidgets,
  type WidgetId,
  type WidgetPlacement,
} from "@/components/widgets/layout";

/** What one widget reported about itself after rendering. */
export interface WidgetObservation {
  id: WidgetId;
  /** Rendered content box, in CSS pixels. */
  width: number;
  height: number;
  /** True when the widget's content did not fit and it grew a scrollbar. */
  overflowing: boolean;
  /** How many pixels of content were beyond the box, when known. */
  overflowBy?: number;
  /**
   * The height the content actually needs, when the widget can measure it
   * (`scrollHeight`). Slack is `height - contentHeight`.
   *
   * REQUIRED for any shrink proposal. Without it there is no way to tell a
   * widget that is comfortably full from one that is mostly empty, and an
   * earlier version of this engine guessed — which made it propose shrinking
   * every low-priority widget on a perfectly good dashboard. Absent this
   * number, no shrink is suggested at all.
   */
  contentHeight?: number;
}

export type IssueSeverity = "high" | "medium" | "low";

export interface OptimizationIssue {
  /** Stable key, so the UI can list issues without inventing ids. */
  id: string;
  widgetId: WidgetId | null;
  /** One sentence, in the user's terms. */
  title: string;
  severity: IssueSeverity;
}

export interface OptimizationChange {
  widgetId: WidgetId;
  from: Pick<WidgetPlacement, "x" | "y" | "w" | "h">;
  to: Pick<WidgetPlacement, "x" | "y" | "w" | "h">;
  /** Why, in the user's terms. Shown next to the before/after. */
  reason: string;
}

export interface OptimizationPlan {
  issues: OptimizationIssue[];
  changes: OptimizationChange[];
  /**
   * `low` means: show the issues, withhold the changes.
   *
   * Set when a proposed change could not be placed cleanly, so the engine would
   * be guessing at the user's intent rather than fixing a measured problem.
   */
  confidence: "high" | "low";
  /** The whole thing as prose, for the chat/preview surface. */
  summary: string;
}

/**
 * How much a widget's job is worth in grid space.
 *
 * Used only to decide who yields when two widgets both want room. The Orb is
 * the product — it is never the one asked to shrink.
 */
const PRIORITY: Record<WidgetId, number> = {
  orb: 100,
  map: 60,
  tasks: 50,
  system: 40,
  weather: 35,
  markets: 30,
  clock: 20,
  worldclock: 20,
};

/**
 * Below this, a widget is cramped enough that its own layout gives up.
 *
 * Measured, not assumed: these are the widths at which the existing cards start
 * wrapping values away from their labels.
 */
const NARROW_PX = 200;

/** A widget with this much unused height is holding space it is not using. */
const SLACK_PX = 90;

function clampToConstraints(id: WidgetId, p: Pick<WidgetPlacement, "x" | "y" | "w" | "h">) {
  const c = CONSTRAINTS[id];
  const w = Math.max(c.minW, Math.min(c.maxW, p.w));
  const h = Math.max(c.minH, Math.min(c.maxH, p.h));
  return {
    w,
    h,
    x: Math.max(0, Math.min(GRID_COLS - w, p.x)),
    y: Math.max(0, p.y),
  };
}

/** Would this placement collide with anything else currently visible? */
function collidesWithOthers(
  candidate: WidgetPlacement,
  layout: WidgetPlacement[]
): boolean {
  return visibleWidgets(layout).some(
    (other) => other.id !== candidate.id && overlaps(candidate, other)
  );
}

/** A grid map of which cells are taken, excluding one widget. */
function occupancyExcluding(layout: WidgetPlacement[], exclude: WidgetId): boolean[][] {
  const rows = Math.max(GRID_ROWS, ...layout.map((p) => p.y + p.h));
  const grid: boolean[][] = Array.from({ length: rows }, () =>
    Array.from({ length: GRID_COLS }, () => false)
  );
  for (const p of visibleWidgets(layout)) {
    if (p.id === exclude) continue;
    for (let y = p.y; y < p.y + p.h; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        if (grid[y]?.[x] !== undefined) grid[y]![x] = true;
      }
    }
  }
  return grid;
}

/** How far a widget could extend downward before hitting something. */
function freeRowsBelow(p: WidgetPlacement, layout: WidgetPlacement[]): number {
  const grid = occupancyExcluding(layout, p.id);
  let free = 0;
  for (let y = p.y + p.h; y < GRID_ROWS; y++) {
    const rowClear = Array.from({ length: p.w }, (_, i) => p.x + i).every(
      (x) => grid[y]?.[x] === false
    );
    if (!rowClear) break;
    free++;
  }
  return free;
}

/** How far a widget could extend upward before hitting something. */
function freeRowsAbove(p: WidgetPlacement, layout: WidgetPlacement[]): number {
  const grid = occupancyExcluding(layout, p.id);
  let free = 0;
  for (let y = p.y - 1; y >= 0; y--) {
    const rowClear = Array.from({ length: p.w }, (_, i) => p.x + i).every(
      (x) => grid[y]?.[x] === false
    );
    if (!rowClear) break;
    free++;
  }
  return free;
}

/** How far a widget could widen to its right before hitting something. */
function freeColsRight(p: WidgetPlacement, layout: WidgetPlacement[]): number {
  const grid = occupancyExcluding(layout, p.id);
  let free = 0;
  for (let x = p.x + p.w; x < GRID_COLS; x++) {
    const colClear = Array.from({ length: p.h }, (_, i) => p.y + i).every(
      (y) => grid[y]?.[x] === false
    );
    if (!colClear) break;
    free++;
  }
  return free;
}

// ---------------------------------------------------------------------------

/**
 * Analyse a layout and propose improvements.
 *
 * Order matters: the Orb is considered first, because it is the surface
 * everything else is arranged around, and a change to it reframes what counts
 * as cramped elsewhere.
 */
export function analyzeLayout(
  layout: WidgetPlacement[],
  observations: WidgetObservation[],
  viewport: { width: number; height: number }
): OptimizationPlan {
  const issues: OptimizationIssue[] = [];
  const changes: OptimizationChange[] = [];
  // Changes are proposed against a working copy, so two proposals cannot both
  // claim the same cells.
  let working: WidgetPlacement[] = layout.map((p) => ({ ...p }));

  const propose = (
    id: WidgetId,
    to: Pick<WidgetPlacement, "x" | "y" | "w" | "h">,
    reason: string
  ): boolean => {
    const current = working.find((p) => p.id === id);
    if (!current || current.hidden) return false;

    const clamped = clampToConstraints(id, to);
    if (
      clamped.x === current.x &&
      clamped.y === current.y &&
      clamped.w === current.w &&
      clamped.h === current.h
    ) {
      return false;
    }

    const candidate: WidgetPlacement = { ...current, ...clamped };
    if (collidesWithOthers(candidate, working)) return false;
    if (candidate.y + candidate.h > GRID_ROWS) return false;

    changes.push({
      widgetId: id,
      from: { x: current.x, y: current.y, w: current.w, h: current.h },
      to: clamped,
      reason,
    });
    working = working.map((p) => (p.id === id ? candidate : p));
    return true;
  };

  // --- 1. The Orb should own its full column band -------------------------
  const orb = working.find((p) => p.id === "orb");
  if (orb && !orb.hidden) {
    const above = freeRowsAbove(orb, working);
    const below = freeRowsBelow(orb, working);

    if (above + below > 0) {
      issues.push({
        id: "orb-not-full-height",
        widgetId: "orb",
        title: `The JARVIS orb is not using the full dashboard height — ${above + below} row${above + below === 1 ? "" : "s"} above or below it are empty.`,
        severity: "high",
      });

      propose(
        "orb",
        { x: orb.x, y: orb.y - above, w: orb.w, h: orb.h + above + below },
        "Extend the orb through the full height of its column, so the conversation surface is the tallest thing on the dashboard."
      );
    }
  }

  // --- 2. Widgets whose content does not fit -------------------------------
  //
  // Overflow is the one issue reported by the widget itself rather than
  // inferred, so it is the most trustworthy signal here.
  const overflowing = observations
    .filter((o) => o.overflowing)
    .sort((a, b) => (PRIORITY[b.id] ?? 0) - (PRIORITY[a.id] ?? 0));

  for (const obs of overflowing) {
    const p = working.find((w) => w.id === obs.id);
    if (!p || p.hidden) continue;

    const tooNarrow = obs.width < NARROW_PX && freeColsRight(p, working) > 0;

    issues.push({
      id: `overflow-${obs.id}`,
      widgetId: obs.id,
      title: tooNarrow
        ? `${label(obs.id)} is too narrow for its content and has grown a scrollbar.`
        : `${label(obs.id)} is too short for its content and has grown a scrollbar.`,
      severity: "medium",
    });

    if (tooNarrow) {
      propose(
        obs.id,
        { x: p.x, y: p.y, w: p.w + 1, h: p.h },
        `Widen ${label(obs.id)} by one column so its content fits without scrolling.`
      );
    } else if (freeRowsBelow(p, working) > 0) {
      propose(
        obs.id,
        { x: p.x, y: p.y, w: p.w, h: p.h + 1 },
        `Give ${label(obs.id)} one more row so its content fits without scrolling.`
      );
    }
  }

  // --- 3. Low-priority widgets holding space they are not using ------------
  for (const obs of observations) {
    if (obs.overflowing) continue;
    const p = working.find((w) => w.id === obs.id);
    if (!p || p.hidden) continue;
    if ((PRIORITY[obs.id] ?? 0) >= PRIORITY.map) continue;
    if (p.h <= CONSTRAINTS[obs.id].minH) continue;

    // A shrink needs EVIDENCE of unused space, which only `contentHeight`
    // provides. Inferring it from the box height alone cannot distinguish a
    // full widget from an empty one of the same size.
    if (typeof obs.contentHeight !== "number" || obs.contentHeight <= 0) continue;

    const slack = obs.height - obs.contentHeight;
    const rowPx = obs.height / p.h;
    // Worth a row only if losing one still leaves the content room to fit.
    if (rowPx <= 0 || slack < Math.max(SLACK_PX, rowPx)) continue;

    issues.push({
      id: `slack-${obs.id}`,
      widgetId: obs.id,
      title: `${label(obs.id)} is taller than its content needs.`,
      severity: "low",
    });

    propose(
      obs.id,
      { x: p.x, y: p.y, w: p.w, h: p.h - 1 },
      `Reduce ${label(obs.id)} by one row and give the space back to the layout.`
    );
  }

  // --- confidence ----------------------------------------------------------
  //
  // Issues found but nothing placeable means the engine understands the problem
  // and not the solution. Saying so is more useful than shuffling the grid.
  const confidence: "high" | "low" =
    issues.length > 0 && changes.length === 0 ? "low" : "high";

  return {
    issues,
    changes,
    confidence,
    summary: buildSummary(issues, changes, confidence, viewport),
  };
}

/**
 * Apply a plan, returning a NEW layout.
 *
 * Never mutates the input: undo depends on the previous array still being
 * exactly what it was. Widgets absent from the plan are copied through
 * untouched, and no widget is ever removed or hidden here — the returned layout
 * always has the same members as the one that went in.
 */
export function applyPlan(
  layout: WidgetPlacement[],
  plan: OptimizationPlan
): WidgetPlacement[] {
  const changes = new Map(plan.changes.map((c) => [c.widgetId, c]));
  return layout.map((p) => {
    const change = changes.get(p.id);
    return change ? { ...p, ...change.to } : { ...p };
  });
}

// ---------------------------------------------------------------------------

const LABELS: Record<WidgetId, string> = {
  orb: "The JARVIS orb",
  map: "Location",
  system: "System monitor",
  clock: "Time",
  worldclock: "World clocks",
  weather: "Weather",
  tasks: "Tasks",
  markets: "Markets",
};

function label(id: WidgetId): string {
  return LABELS[id] ?? id;
}

function buildSummary(
  issues: OptimizationIssue[],
  changes: OptimizationChange[],
  confidence: "high" | "low",
  viewport: { width: number; height: number }
): string {
  if (issues.length === 0) {
    return `Your dashboard looks well arranged at ${viewport.width}×${viewport.height}. I did not find anything worth moving.`;
  }

  const lines: string[] = [
    `I found ${issues.length} ${issues.length === 1 ? "improvement" : "improvements"}:`,
    "",
    ...issues.map((issue, i) => `${i + 1}. ${issue.title}`),
  ];

  if (confidence === "low" || changes.length === 0) {
    lines.push(
      "",
      "I can see the problem but not a clean way to fix it without moving things you arranged yourself, so I have not proposed any changes."
    );
    return lines.join("\n");
  }

  lines.push("", "Recommended changes:");
  for (const c of changes) {
    lines.push(
      `- ${label(c.widgetId)}: ${c.from.w}×${c.from.h} → ${c.to.w}×${c.to.h}`
    );
  }
  lines.push("", "Apply these changes?");
  return lines.join("\n");
}
