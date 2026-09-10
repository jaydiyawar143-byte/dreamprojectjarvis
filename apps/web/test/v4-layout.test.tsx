// ---------------------------------------------------------------------------
// V4 — the free-form dashboard layout model.
//
// The model is pure, so most of this needs no DOM. That matters more in V4 than
// it did in V3: dragging, the keyboard controls and any future voice command
// all funnel through `clampPlacement`, so the guarantee that nothing can leave
// the workspace is provable here rather than only observable in a browser.
//
// The component tests below cover the parts that only exist on screen: that
// customise mode adds nothing when it is off, that the Orb cannot be switched
// off, and — the V4 one — that no widget offers a menu of preset sizes.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

import {
  CONSTRAINTS,
  DEFAULT_LAYOUT,
  GRID_COLS,
  GRID_ROWS,
  MAX_ROWS,
  canGrow,
  canShrink,
  clampPlacement,
  findCollisions,
  isWithinGrid,
  isWithinNominalGrid,
  layoutRows,
  normalizeLayout,
  nudge,
  occupiedCells,
  overlaps,
  resizeBy,
  setHidden,
  visibleWidgets,
  type WidgetPlacement,
} from "../src/components/widgets/layout";
import { WidgetFrame } from "../src/components/widgets/widget-frame";
import { CustomizeBar } from "../src/components/widgets/customize-bar";
import { formatInZone, DEFAULT_CITIES } from "../src/components/widgets/world-clock-widget";

const at = (id: WidgetPlacement["id"], x: number, y: number, w: number, h: number): WidgetPlacement =>
  ({ id, x, y, w, h });

const find = (layout: WidgetPlacement[], id: WidgetPlacement["id"]) =>
  layout.find((p) => p.id === id)!;

// ---------------------------------------------------------------------------
// The shipped layout
// ---------------------------------------------------------------------------

describe("default layout", () => {
  it("tiles the grid exactly — no overlap, no holes", () => {
    // A dashboard that opens with a dead corner looks broken before the user
    // has touched anything. 144 cells is the whole grid.
    expect(findCollisions(DEFAULT_LAYOUT)).toEqual([]);
    expect(occupiedCells(DEFAULT_LAYOUT)).toBe(GRID_COLS * GRID_ROWS);
  });

  it("keeps every widget inside the workspace", () => {
    for (const p of DEFAULT_LAYOUT) expect(isWithinGrid(p)).toBe(true);
  });

  it("respects every widget's own minimum", () => {
    for (const p of DEFAULT_LAYOUT) {
      expect(p.w).toBeGreaterThanOrEqual(CONSTRAINTS[p.id].minW);
      expect(p.h).toBeGreaterThanOrEqual(CONSTRAINTS[p.id].minH);
    }
  });

  it("includes every widget the command centre ships with", () => {
    const ids = DEFAULT_LAYOUT.map((p) => p.id).sort();
    expect(ids).toEqual(
      ["clock", "map", "markets", "orb", "system", "tasks", "weather", "worldclock"].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe("clampPlacement", () => {
  it("pulls a widget back inside the right edge", () => {
    // The core promise of a BOUNDED workspace: no arrangement can produce a
    // widget hanging off the side, which is where horizontal page overflow
    // would come from.
    const clamped = clampPlacement(at("markets", 11, 0, 8, 4));
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(GRID_COLS);
    expect(isWithinGrid(clamped)).toBe(true);
  });

  it("pulls a widget back inside the bottom edge", () => {
    // Against MAX_ROWS, not the nominal twelve. A drag legitimately pushes the
    // arrangement past twelve rows — the row HEIGHT absorbs that, so clamping
    // to twelve here would fight the grid instead of bounding it. See MAX_ROWS.
    const clamped = clampPlacement(at("tasks", 0, 30, 2, 6));
    expect(clamped.y + clamped.h).toBeLessThanOrEqual(MAX_ROWS);
    expect(isWithinGrid(clamped)).toBe(true);
  });

  it("keeps the SHIPPED layout inside the nominal twelve rows", () => {
    // The ceiling is headroom for rearranging, not a licence for the default to
    // open taller than the screen's worth of rows.
    for (const p of DEFAULT_LAYOUT) expect(isWithinNominalGrid(p)).toBe(true);
    expect(layoutRows(DEFAULT_LAYOUT)).toBe(GRID_ROWS);
  });

  it("grows the row count when an arrangement needs it, and never below twelve", () => {
    expect(layoutRows([at("tasks", 0, 12, 2, 4)])).toBe(16);
    // A short arrangement does not stretch its widgets over the whole screen.
    expect(layoutRows([at("clock", 0, 0, 2, 2)])).toBe(GRID_ROWS);
  });

  it("refuses a negative position", () => {
    const clamped = clampPlacement(at("clock", -5, -3, 2, 2));
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
  });

  it("refuses to shrink the Orb below the size that makes it the hero", () => {
    // The product IS the Orb. A dashboard where it can be reduced to a tile is
    // a different product, so the floor is enforced rather than advisory.
    const clamped = clampPlacement(at("orb", 0, 0, 1, 1));
    expect(clamped.w).toBe(CONSTRAINTS.orb.minW);
    expect(clamped.h).toBe(CONSTRAINTS.orb.minH);
  });

  it("clamps a size larger than the grid itself", () => {
    const clamped = clampPlacement(at("map", 0, 0, 99, 99));
    expect(clamped.w).toBeLessThanOrEqual(GRID_COLS);
    expect(clamped.h).toBeLessThanOrEqual(GRID_ROWS);
    expect(isWithinGrid(clamped)).toBe(true);
  });

  it("rounds fractional coordinates onto the grid", () => {
    // A drag reports pixels; the model only ever holds whole cells.
    const clamped = clampPlacement({ id: "clock", x: 2.6, y: 3.4, w: 2.5, h: 2.4 });
    for (const v of [clamped.x, clamped.y, clamped.w, clamped.h]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("never produces a placement outside the grid, for any input", () => {
    // Exhaustive rather than illustrative: this is the one invariant that keeps
    // the page from scrolling, so it is worth asserting over a range.
    for (const x of [-9, 0, 5, 11, 40]) {
      for (const y of [-9, 0, 5, 11, 40]) {
        for (const w of [-2, 1, 4, 13]) {
          for (const h of [-2, 1, 4, 13]) {
            expect(isWithinGrid(clampPlacement({ id: "markets", x, y, w, h }))).toBe(true);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Keyboard equivalents of dragging
// ---------------------------------------------------------------------------

describe("nudge and resizeBy", () => {
  it("moves a widget by whole cells", () => {
    const moved = nudge(DEFAULT_LAYOUT, "clock", 1, -1);
    const before = find(DEFAULT_LAYOUT, "clock");
    const after = find(moved, "clock");
    expect(after.x).toBe(before.x + 1);
    expect(after.y).toBe(before.y - 1);
  });

  it("declines to move past the edge instead of clamping silently", () => {
    // Reference equality is how every caller — including the unsaved-changes
    // tracking — learns that nothing happened.
    const layout = [at("clock", 0, 0, 2, 2)];
    expect(nudge(layout, "clock", -1, 0)).toBe(layout);
    expect(nudge(layout, "clock", 0, -1)).toBe(layout);
  });

  it("grows and shrinks within the widget's own limits", () => {
    const bigger = resizeBy(DEFAULT_LAYOUT, "weather", 1, 0);
    expect(find(bigger, "weather").w).toBe(find(DEFAULT_LAYOUT, "weather").w + 1);
  });

  it("stops at the minimum rather than collapsing", () => {
    let layout: WidgetPlacement[] = [at("map", 0, 0, 6, 6)];
    for (let i = 0; i < 10; i++) layout = resizeBy(layout, "map", -1, -1);
    expect(find(layout, "map").w).toBe(CONSTRAINTS.map.minW);
    expect(find(layout, "map").h).toBe(CONSTRAINTS.map.minH);
  });

  it("keeps a widget on screen when it grows against the edge", () => {
    // Growing a widget flush with the right edge must pull it left, not push it
    // out of the workspace.
    const layout = [at("markets", 9, 9, 3, 3)];
    const grown = resizeBy(layout, "markets", 2, 2);
    expect(isWithinGrid(find(grown, "markets"))).toBe(true);
  });

  it("reports when a widget is at a limit, so the UI can disable the control", () => {
    expect(canShrink(at("orb", 0, 0, CONSTRAINTS.orb.minW, 5), "w")).toBe(false);
    expect(canGrow(at("orb", 0, 0, GRID_COLS, 5), "w")).toBe(false);
    expect(canGrow(at("orb", 0, 0, 4, 5), "w")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------

describe("collisions", () => {
  it("detects two widgets sharing a cell", () => {
    expect(overlaps(at("clock", 0, 0, 3, 3), at("tasks", 2, 2, 3, 3))).toBe(true);
  });

  it("does not call touching edges an overlap", () => {
    expect(overlaps(at("clock", 0, 0, 2, 2), at("tasks", 2, 0, 2, 2))).toBe(false);
    expect(overlaps(at("clock", 0, 0, 2, 2), at("tasks", 0, 2, 2, 2))).toBe(false);
  });

  it("ignores hidden widgets, which occupy nothing", () => {
    const layout: WidgetPlacement[] = [
      at("clock", 0, 0, 3, 3),
      { ...at("tasks", 0, 0, 3, 3), hidden: true },
    ];
    expect(findCollisions(layout)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hide and show
// ---------------------------------------------------------------------------

describe("hide and show", () => {
  it("hides a widget the user is allowed to hide", () => {
    const hidden = setHidden(DEFAULT_LAYOUT, "markets", true);
    expect(visibleWidgets(hidden).map((p) => p.id)).not.toContain("markets");
  });

  it("REFUSES to hide the Orb", () => {
    const attempted = setHidden(DEFAULT_LAYOUT, "orb", true);
    expect(attempted).toBe(DEFAULT_LAYOUT);
    expect(visibleWidgets(attempted).map((p) => p.id)).toContain("orb");
  });

  it("restores a hidden widget where it was", () => {
    // Hiding must not also forget the placement, or restoring would drop the
    // widget somewhere arbitrary.
    const hidden = setHidden(DEFAULT_LAYOUT, "weather", true);
    const shown = setHidden(hidden, "weather", false);
    expect(find(shown, "weather")).toMatchObject({
      x: find(DEFAULT_LAYOUT, "weather").x,
      y: find(DEFAULT_LAYOUT, "weather").y,
    });
    expect(visibleWidgets(shown).map((p) => p.id)).toContain("weather");
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("normalizeLayout", () => {
  it("falls back to the default when nothing is stored", () => {
    expect(normalizeLayout(undefined)).toBe(DEFAULT_LAYOUT);
    expect(normalizeLayout([])).toBe(DEFAULT_LAYOUT);
  });

  it("restores a saved V4 layout as it was", () => {
    const stored = [{ id: "orb", x: 5, y: 2, w: 4, h: 5 }];
    expect(find(normalizeLayout(stored), "orb")).toMatchObject({ x: 5, y: 2, w: 4, h: 5 });
  });

  it("drops widgets a newer build no longer has", () => {
    const restored = normalizeLayout([{ id: "not-a-widget", x: 0, y: 0, w: 2, h: 2 }]);
    expect(restored.map((p) => p.id)).not.toContain("not-a-widget");
  });

  it("appends widgets added after the layout was saved", () => {
    // Otherwise a widget shipped in a later release is invisible to every
    // existing user, forever.
    const restored = normalizeLayout([{ id: "orb", x: 0, y: 0, w: 4, h: 7 }]);
    expect(restored.map((p) => p.id)).toContain("markets");
    expect(restored.map((p) => p.id)).toContain("tasks");
  });

  it("re-clamps a stored placement that no longer fits the grid", () => {
    const restored = normalizeLayout([{ id: "map", x: 20, y: 20, w: 40, h: 40 }]);
    expect(isWithinGrid(find(restored, "map"))).toBe(true);
  });

  it("cannot be used to hide the Orb through a crafted payload", () => {
    const restored = normalizeLayout([{ id: "orb", x: 0, y: 0, w: 4, h: 7, hidden: true }]);
    expect(find(restored, "orb").hidden).toBeUndefined();
    expect(visibleWidgets(restored).map((p) => p.id)).toContain("orb");
  });

  it("ignores duplicates rather than rendering a widget twice", () => {
    const restored = normalizeLayout([
      { id: "clock", x: 0, y: 0, w: 2, h: 2 },
      { id: "clock", x: 4, y: 4, w: 2, h: 2 },
    ]);
    expect(restored.filter((p) => p.id === "clock")).toHaveLength(1);
  });

  it("survives a stored entry with missing or nonsense fields", () => {
    const restored = normalizeLayout([
      { id: "clock" },
      { id: "tasks", x: "left", y: null, w: NaN, h: Infinity },
    ]);
    expect(findCollisions(restored)).toEqual([]);
    for (const p of restored) expect(isWithinGrid(p)).toBe(true);
  });

  // ---- V3 -> V4 migration ------------------------------------------------

  it("MIGRATES a V3 layout instead of rendering it as garbage", () => {
    // V3 stored an order and a size on a 4-column grid, with no coordinates at
    // all. Read as V4 the positions would all default to the same cell, so the
    // migration falls back to the shipped arrangement.
    const v3 = [
      { id: "orb", size: { w: 2, h: 3 } },
      { id: "map", size: { w: 2, h: 2 } },
      { id: "system", size: { w: 1, h: 2 } },
    ];
    const restored = normalizeLayout(v3);

    expect(findCollisions(restored)).toEqual([]);
    expect(occupiedCells(restored)).toBe(GRID_COLS * GRID_ROWS);
    for (const p of restored) expect(isWithinGrid(p)).toBe(true);
  });

  it("carries a V3 user's HIDDEN widgets across the migration", () => {
    // Positions cannot survive, but "I did not want to see the markets" is a
    // real preference and it is recorded unambiguously.
    const v3 = [
      { id: "orb", size: { w: 2, h: 3 } },
      { id: "markets", size: { w: 1, h: 2 }, hidden: true },
    ];
    const restored = normalizeLayout(v3);
    expect(find(restored, "markets").hidden).toBe(true);
    expect(visibleWidgets(restored).map((p) => p.id)).not.toContain("markets");
  });

  it("does not let a V3 payload hide the Orb either", () => {
    const restored = normalizeLayout([{ id: "orb", size: { w: 2, h: 3 }, hidden: true }]);
    expect(visibleWidgets(restored).map((p) => p.id)).toContain("orb");
  });
});

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

describe("widget frame", () => {
  const props = {
    placement: at("markets", 4, 8, 8, 4),
    label: "Markets",
    onNudge: vi.fn(),
    onResizeBy: vi.fn(),
    onHide: vi.fn(),
  };

  it("adds NOTHING when customise mode is off", () => {
    // The premium state of this dashboard is the one where none of this is on
    // screen — and an invisible drag handle over a map would break panning.
    render(
      <WidgetFrame {...props} customizing={false}>
        <p>widget</p>
      </WidgetFrame>
    );
    expect(screen.getByText("widget")).toBeInTheDocument();
    expect(screen.queryByTestId("drag-markets")).toBeNull();
    expect(screen.queryByTestId("hide-markets")).toBeNull();
  });

  it("offers a drag grip and a hide control when customising", () => {
    render(
      <WidgetFrame {...props} customizing>
        <p>widget</p>
      </WidgetFrame>
    );
    expect(screen.getByTestId("drag-markets")).toBeInTheDocument();
    expect(screen.getByTestId("hide-markets")).toBeInTheDocument();
  });

  it("offers NO preset size buttons — size comes from dragging", () => {
    // The V4 assertion. V3 shipped ± controls that stepped through whole
    // columns; the readout that replaced them reports where the corner IS and
    // cannot be clicked to change it.
    render(
      <WidgetFrame {...props} customizing>
        <p>widget</p>
      </WidgetFrame>
    );
    const readout = screen.getByTestId("size-markets");
    expect(readout).toHaveTextContent("8×4");
    expect(readout.tagName).toBe("SPAN");
    expect(readout.closest("button")).toBeNull();

    for (const gone of ["wider-markets", "narrower-markets", "taller-markets", "shorter-markets"]) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
  });

  it("keeps a keyboard route to both moving and resizing", () => {
    // react-grid-layout is pointer-only. Without these the dashboard would be
    // unusable without a mouse.
    const onNudge = vi.fn();
    const onResizeBy = vi.fn();
    render(
      <WidgetFrame {...props} onNudge={onNudge} onResizeBy={onResizeBy} customizing>
        <p>widget</p>
      </WidgetFrame>
    );

    fireEvent.click(screen.getByTestId("keyboard-markets"));
    fireEvent.click(screen.getByTestId("move-left-markets"));
    expect(onNudge).toHaveBeenCalledWith(-1, 0);
    fireEvent.click(screen.getByTestId("move-down-markets"));
    expect(onNudge).toHaveBeenCalledWith(0, 1);
    fireEvent.click(screen.getByTestId("grow-markets"));
    expect(onResizeBy).toHaveBeenCalledWith(1, 1);
    fireEvent.click(screen.getByTestId("shrink-markets"));
    expect(onResizeBy).toHaveBeenCalledWith(-1, -1);
  });

  it("says where the widget is, for a screen reader", () => {
    render(
      <WidgetFrame {...props} customizing>
        <p>widget</p>
      </WidgetFrame>
    );
    fireEvent.click(screen.getByTestId("keyboard-markets"));
    expect(screen.getByTestId("move-left-markets")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("column")
    );
    expect(screen.getByTestId("grow-markets")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("cells")
    );
  });

  it("disables a move that would leave the workspace", () => {
    render(
      <WidgetFrame {...props} placement={at("clock", 0, 0, 2, 2)} label="Clock" customizing>
        <p>widget</p>
      </WidgetFrame>
    );
    fireEvent.click(screen.getByTestId("keyboard-clock"));
    expect(screen.getByTestId("move-left-clock")).toBeDisabled();
    expect(screen.getByTestId("move-up-clock")).toBeDisabled();
  });

  it("gives the Orb no hide control at all", () => {
    // Not a disabled one: a disabled control implies the dashboard could exist
    // without the Orb.
    render(
      <WidgetFrame {...props} placement={at("orb", 0, 0, 4, 7)} label="JARVIS Orb" customizing>
        <p>widget</p>
      </WidgetFrame>
    );
    expect(screen.queryByTestId("hide-orb")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

describe("customize bar", () => {
  const props = {
    layout: DEFAULT_LAYOUT,
    onToggle: vi.fn(),
    onSetHidden: vi.fn(),
    onSave: vi.fn(),
    onReset: vi.fn(),
  };

  it("is a single quiet button when customise mode is off", () => {
    render(<CustomizeBar {...props} customizing={false} dirty={false} saving={false} />);
    expect(screen.getByTestId("customize-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("save-layout")).toBeNull();
  });

  it("cannot save when there is nothing to save", () => {
    render(<CustomizeBar {...props} customizing dirty={false} saving={false} />);
    expect(screen.getByTestId("save-layout")).toBeDisabled();
  });

  it("says so when there are unsaved changes", () => {
    render(<CustomizeBar {...props} customizing dirty saving={false} />);
    expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("save-layout")).toBeEnabled();
  });

  it("will not let the Orb be switched off in Manage widgets", () => {
    render(<CustomizeBar {...props} customizing dirty={false} saving={false} />);
    fireEvent.click(screen.getByTestId("manage-widgets"));
    expect(screen.getByTestId("toggle-orb")).toBeDisabled();
  });

  it("reports how many widgets are hidden, so they can be found again", () => {
    const hidden = setHidden(setHidden(DEFAULT_LAYOUT, "markets", true), "tasks", true);
    render(<CustomizeBar {...props} layout={hidden} customizing dirty saving={false} />);
    expect(screen.getByTestId("manage-widgets")).toHaveTextContent("2 hidden");
  });
});

// ---------------------------------------------------------------------------
// World clock — unchanged by V4, kept here with its neighbours
// ---------------------------------------------------------------------------

describe("world clock", () => {
  it("converts one instant into each city's local time", () => {
    const instant = new Date("2026-01-15T12:00:00Z");
    const shown = DEFAULT_CITIES.map((c) => formatInZone(instant, c.zone, "24"));
    expect(new Set(shown).size).toBeGreaterThan(1);
  });

  it("survives an unknown timezone instead of taking the widget down", () => {
    expect(() => formatInZone(new Date(), "Not/AZone", "24")).not.toThrow();
  });
});
