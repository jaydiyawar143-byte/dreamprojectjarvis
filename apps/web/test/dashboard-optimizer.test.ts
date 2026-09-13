// ---------------------------------------------------------------------------
// Dashboard layout optimization.
//
// The safety block at the bottom is the one that matters. This engine runs on
// the user's saved arrangement and, if it were wrong, would silently rearrange
// work they did by hand. So the tests that earn their keep assert what it can
// NEVER do: lose a widget, hide one, violate a constraint, produce an overlap,
// escape the grid, or mutate the layout it was handed.
//
// The second theme is honesty about confidence. The brief is explicit that low
// confidence means recommend rather than apply, and the failure mode worth
// preventing is an engine that shuffles the grid because it found *an* issue
// while having no idea what the right fix is.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  analyzeLayout,
  applyPlan,
  type WidgetObservation,
} from "../src/lib/dashboard/optimizer";
import {
  CONSTRAINTS,
  DEFAULT_LAYOUT,
  GRID_COLS,
  GRID_ROWS,
  findCollisions,
  type WidgetId,
  type WidgetPlacement,
} from "../src/components/widgets/layout";

const VIEWPORT = { width: 1366, height: 768 };

/** Every widget comfortable and not overflowing. */
function contentFits(layout: WidgetPlacement[] = DEFAULT_LAYOUT): WidgetObservation[] {
  return layout.map((p) => ({
    id: p.id,
    width: p.w * 110,
    height: p.h * 52,
    overflowing: false,
  }));
}

function withOverflow(
  id: WidgetId,
  over: Partial<WidgetObservation> = {},
  layout: WidgetPlacement[] = DEFAULT_LAYOUT
): WidgetObservation[] {
  return contentFits(layout).map((o) =>
    o.id === id ? { ...o, overflowing: true, ...over } : o
  );
}

// ---------------------------------------------------------------------------

describe("it reasons from measurements, not from grid units alone", () => {
  it("finds nothing to do when everything fits and the grid is full", () => {
    // DEFAULT_LAYOUT tiles the grid exactly, so there is no slack anywhere.
    const plan = analyzeLayout(DEFAULT_LAYOUT, contentFits(), VIEWPORT);

    expect(plan.changes).toHaveLength(0);
    expect(plan.summary).toMatch(/well arranged/i);
  });

  it("does not call a widget cramped just because it is narrow in columns", () => {
    // Two columns is roomy at 2560px. Only an actual overflow counts.
    const plan = analyzeLayout(DEFAULT_LAYOUT, contentFits(), { width: 2560, height: 1440 });
    expect(plan.issues.filter((i) => i.id.startsWith("overflow-"))).toHaveLength(0);
  });

  it("reports a widget that actually grew a scrollbar", () => {
    const layout: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 0, w: 4, h: 12 },
      { id: "weather", x: 4, y: 0, w: 2, h: 4 },
    ];
    const obs = withOverflow("weather", { width: 150 }, layout);

    const plan = analyzeLayout(layout, obs, VIEWPORT);

    const issue = plan.issues.find((i) => i.id === "overflow-weather");
    expect(issue).toBeDefined();
    expect(issue!.title).toMatch(/scrollbar/i);
  });

  it("widens a narrow overflowing widget when there is room beside it", () => {
    const layout: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 0, w: 4, h: 12 },
      { id: "weather", x: 4, y: 0, w: 2, h: 4 },
    ];

    const plan = analyzeLayout(layout, withOverflow("weather", { width: 150 }, layout), VIEWPORT);
    const change = plan.changes.find((c) => c.widgetId === "weather");

    expect(change).toBeDefined();
    expect(change!.to.w).toBe(3);
    expect(change!.to.h).toBe(4);
  });

  it("gives a row instead when the widget is wide but too short", () => {
    const layout: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 0, w: 4, h: 12 },
      { id: "markets", x: 4, y: 0, w: 8, h: 3 },
    ];

    const plan = analyzeLayout(layout, withOverflow("markets", { width: 800 }, layout), VIEWPORT);
    const change = plan.changes.find((c) => c.widgetId === "markets");

    expect(change).toBeDefined();
    expect(change!.to.h).toBe(4);
    expect(change!.to.w).toBe(8);
  });
});

describe("the orb is treated as the primary surface", () => {
  it("proposes extending the orb through empty rows in its column", () => {
    const layout: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 0, w: 4, h: 7 },
      { id: "markets", x: 4, y: 0, w: 8, h: 4 },
    ];

    const plan = analyzeLayout(layout, contentFits(layout), VIEWPORT);
    const change = plan.changes.find((c) => c.widgetId === "orb");

    expect(change).toBeDefined();
    expect(change!.to.h).toBe(GRID_ROWS);
    expect(plan.issues.some((i) => i.id === "orb-not-full-height")).toBe(true);
  });

  it("extends upward as well as downward", () => {
    const layout: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 3, w: 4, h: 6 },
      { id: "markets", x: 4, y: 0, w: 8, h: 4 },
    ];

    const plan = analyzeLayout(layout, contentFits(layout), VIEWPORT);
    const change = plan.changes.find((c) => c.widgetId === "orb")!;

    expect(change.to.y).toBe(0);
    expect(change.to.h).toBe(GRID_ROWS);
  });

  it("does not extend the orb into space another widget occupies", () => {
    // The shipped layout puts clock and worldclock under the orb.
    const plan = analyzeLayout(DEFAULT_LAYOUT, contentFits(), VIEWPORT);
    const change = plan.changes.find((c) => c.widgetId === "orb");

    expect(change).toBeUndefined();
  });

  it("never proposes shrinking the orb to make room for something else", () => {
    const layout: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 0, w: 4, h: 12 },
      { id: "weather", x: 4, y: 0, w: 2, h: 4 },
    ];

    const plan = analyzeLayout(layout, withOverflow("weather", { width: 150 }, layout), VIEWPORT);
    const orbChange = plan.changes.find((c) => c.widgetId === "orb");

    expect(orbChange).toBeUndefined();
  });
});

describe("confidence is reported honestly", () => {
  it("withholds changes and says so when nothing can be placed cleanly", () => {
    // Overflowing, but boxed in on every side: the engine understands the
    // problem and not the solution.
    const layout: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 0, w: 4, h: 12 },
      { id: "weather", x: 4, y: 0, w: 2, h: 12 },
      { id: "markets", x: 6, y: 0, w: 6, h: 12 },
    ];

    const plan = analyzeLayout(layout, withOverflow("weather", { width: 150 }, layout), VIEWPORT);

    expect(plan.issues.length).toBeGreaterThan(0);
    expect(plan.changes).toHaveLength(0);
    expect(plan.confidence).toBe("low");
    expect(plan.summary).toMatch(/not proposed any changes/i);
  });

  it("reports high confidence when it has a concrete fix", () => {
    const layout: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 0, w: 4, h: 12 },
      { id: "weather", x: 4, y: 0, w: 2, h: 4 },
    ];

    const plan = analyzeLayout(layout, withOverflow("weather", { width: 150 }, layout), VIEWPORT);
    expect(plan.confidence).toBe("high");
  });

  it("writes a summary a person can act on, with before and after sizes", () => {
    const layout: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 0, w: 4, h: 7 },
      { id: "markets", x: 4, y: 0, w: 8, h: 4 },
    ];

    const plan = analyzeLayout(layout, contentFits(layout), VIEWPORT);

    expect(plan.summary).toMatch(/I found \d+ improvement/);
    expect(plan.summary).toMatch(/→/);
    expect(plan.summary).toMatch(/Apply these changes\?/);
  });
});

describe("applying a plan is safe by construction", () => {
  const layout: WidgetPlacement[] = [
    { id: "orb", x: 0, y: 0, w: 4, h: 7 },
    { id: "markets", x: 4, y: 0, w: 8, h: 4 },
    { id: "clock", x: 4, y: 4, w: 2, h: 3, hidden: true },
  ];

  it("never removes a widget", () => {
    const plan = analyzeLayout(layout, contentFits(layout), VIEWPORT);
    const after = applyPlan(layout, plan);

    expect(after).toHaveLength(layout.length);
    expect(after.map((p) => p.id).sort()).toEqual(layout.map((p) => p.id).sort());
  });

  it("never hides or unhides a widget", () => {
    const plan = analyzeLayout(layout, contentFits(layout), VIEWPORT);
    const after = applyPlan(layout, plan);

    for (const before of layout) {
      const now = after.find((p) => p.id === before.id)!;
      expect(now.hidden, before.id).toBe(before.hidden);
    }
  });

  it("does not mutate the layout it was given, so undo stays exact", () => {
    const snapshot = JSON.stringify(layout);
    const plan = analyzeLayout(layout, contentFits(layout), VIEWPORT);
    applyPlan(layout, plan);

    expect(JSON.stringify(layout)).toBe(snapshot);
  });

  it("produces no overlaps", () => {
    const plan = analyzeLayout(layout, contentFits(layout), VIEWPORT);
    const after = applyPlan(layout, plan);

    expect(findCollisions(after)).toEqual([]);
  });

  it("keeps every widget inside the grid", () => {
    const plan = analyzeLayout(layout, contentFits(layout), VIEWPORT);

    for (const p of applyPlan(layout, plan)) {
      expect(p.x, p.id).toBeGreaterThanOrEqual(0);
      expect(p.y, p.id).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w, p.id).toBeLessThanOrEqual(GRID_COLS);
      expect(p.y + p.h, p.id).toBeLessThanOrEqual(GRID_ROWS);
    }
  });

  it("respects every widget's own min and max constraints", () => {
    const cramped: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 0, w: 4, h: 12 },
      { id: "clock", x: 4, y: 0, w: 2, h: 2 },
    ];
    const plan = analyzeLayout(cramped, withOverflow("clock", { width: 120 }, cramped), VIEWPORT);

    for (const p of applyPlan(cramped, plan)) {
      const c = CONSTRAINTS[p.id];
      expect(p.w, `${p.id} w`).toBeGreaterThanOrEqual(c.minW);
      expect(p.w, `${p.id} w`).toBeLessThanOrEqual(c.maxW);
      expect(p.h, `${p.id} h`).toBeGreaterThanOrEqual(c.minH);
      expect(p.h, `${p.id} h`).toBeLessThanOrEqual(c.maxH);
    }
  });

  it("changes nothing when the plan is empty", () => {
    const plan = analyzeLayout(DEFAULT_LAYOUT, contentFits(), VIEWPORT);
    expect(applyPlan(DEFAULT_LAYOUT, plan)).toEqual(DEFAULT_LAYOUT.map((p) => ({ ...p })));
  });

  it("only ever emits layout geometry — no data, no actions, no side effects", () => {
    // Structural: a change carries four numbers and a sentence. There is no
    // field here through which an email, a scope or a permission could travel.
    const l: WidgetPlacement[] = [
      { id: "orb", x: 0, y: 0, w: 4, h: 7 },
      { id: "markets", x: 4, y: 0, w: 8, h: 4 },
    ];
    const plan = analyzeLayout(l, contentFits(l), VIEWPORT);

    for (const c of plan.changes) {
      expect(Object.keys(c).sort()).toEqual(["from", "reason", "to", "widgetId"]);
      expect(Object.keys(c.to).sort()).toEqual(["h", "w", "x", "y"]);
      for (const v of Object.values(c.to)) expect(typeof v).toBe("number");
    }
  });

  it("leaves a hidden widget's placement untouched", () => {
    const plan = analyzeLayout(layout, contentFits(layout), VIEWPORT);
    const after = applyPlan(layout, plan).find((p) => p.id === "clock")!;
    const before = layout.find((p) => p.id === "clock")!;

    expect(after).toEqual({ ...before });
  });
});
