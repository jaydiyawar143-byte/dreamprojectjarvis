// ---------------------------------------------------------------------------
// V3 — dashboard customisation.
//
// The layout model is pure, so most of this needs no DOM: drag, the keyboard
// move buttons and any future voice command all call the SAME functions, and
// testing them here is what guarantees the three cannot diverge in what they
// permit.
//
// The component tests cover the parts that only exist on screen: that customise
// mode adds nothing when it is off, that the Orb cannot be switched off, and
// that a size limit is visible as a disabled control rather than a silent no-op.
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
  canGrow,
  canShrink,
  move,
  moveTo,
  normalizeLayout,
  resize,
  setHidden,
  visibleWidgets,
  type WidgetPlacement,
} from "../src/components/widgets/layout";
import { WidgetFrame } from "../src/components/widgets/widget-frame";
import { CustomizeBar } from "../src/components/widgets/customize-bar";
import { formatInZone, DEFAULT_CITIES } from "../src/components/widgets/world-clock-widget";

const ids = (layout: WidgetPlacement[]) => layout.map((p) => p.id);

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

describe("resize", () => {
  it("grows and shrinks within the widget's own limits", () => {
    const bigger = resize(DEFAULT_LAYOUT, "weather", { w: 1 });
    expect(bigger.find((p) => p.id === "weather")!.size.w).toBe(2);
  });

  it("refuses to shrink the Orb below the size that makes it the hero", () => {
    // The product IS the Orb. A dashboard where it can be reduced to a tile is
    // a different product, so the floor is enforced rather than advisory.
    let layout = DEFAULT_LAYOUT;
    for (let i = 0; i < 5; i++) layout = resize(layout, "orb", { w: -1, h: -1 });

    const orb = layout.find((p) => p.id === "orb")!;
    expect(orb.size.w).toBe(CONSTRAINTS.orb.min.w);
    expect(orb.size.h).toBe(CONSTRAINTS.orb.min.h);
    expect(orb.size.w).toBeGreaterThanOrEqual(2);
  });

  it("keeps the map and system monitor above a readable minimum", () => {
    let layout = DEFAULT_LAYOUT;
    for (let i = 0; i < 5; i++) layout = resize(layout, "map", { w: -1, h: -1 });
    const map = layout.find((p) => p.id === "map")!;
    expect(map.size.h).toBeGreaterThanOrEqual(CONSTRAINTS.map.min.h);
  });

  it("clamps at the maximum instead of growing without bound", () => {
    let layout = DEFAULT_LAYOUT;
    for (let i = 0; i < 8; i++) layout = resize(layout, "system", { w: 1, h: 1 });
    const system = layout.find((p) => p.id === "system")!;
    expect(system.size.w).toBe(CONSTRAINTS.system.max.w);
    expect(system.size.h).toBe(CONSTRAINTS.system.max.h);
  });

  it("reports when a widget is at a limit, so the UI can disable the control", () => {
    const orb = DEFAULT_LAYOUT.find((p) => p.id === "orb")!;
    expect(canShrink({ ...orb, size: { w: 2, h: 2 } }, "w")).toBe(false);
    expect(canGrow({ ...orb, size: { w: 4, h: 3 } }, "w")).toBe(false);
    expect(canGrow({ ...orb, size: { w: 2, h: 2 } }, "w")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Move and drag
// ---------------------------------------------------------------------------

describe("move", () => {
  it("steps a widget through the order", () => {
    const moved = move(DEFAULT_LAYOUT, "system", -1);
    expect(ids(moved).indexOf("system")).toBeLessThan(ids(DEFAULT_LAYOUT).indexOf("system"));
  });

  it("does nothing at the ends rather than wrapping", () => {
    // Wrapping would move a widget from first to last on a single click, which
    // reads as a bug rather than a feature.
    expect(move(DEFAULT_LAYOUT, "orb", -1)).toBe(DEFAULT_LAYOUT);
    const last = DEFAULT_LAYOUT[DEFAULT_LAYOUT.length - 1]!.id;
    expect(move(DEFAULT_LAYOUT, last, 1)).toBe(DEFAULT_LAYOUT);
  });

  it("steps through VISIBLE widgets only", () => {
    // With a hidden widget in between, moving "one place" against the raw array
    // would appear to do nothing.
    const withHidden = setHidden(DEFAULT_LAYOUT, "map", true);
    const moved = move(withHidden, "system", -1);
    const visible = ids(visibleWidgets(moved));
    expect(visible[0]).toBe("system");
  });

  it("drops a dragged widget at the target's position", () => {
    const moved = moveTo(DEFAULT_LAYOUT, "markets", 1);
    expect(ids(visibleWidgets(moved))[1]).toBe("markets");
  });

  it("keeps hidden widgets out of the way when reordering", () => {
    const withHidden = setHidden(DEFAULT_LAYOUT, "tasks", true);
    const moved = moveTo(withHidden, "markets", 0);
    // Still present, still hidden — unhiding must not drop it somewhere random.
    expect(moved.find((p) => p.id === "tasks")?.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hide
// ---------------------------------------------------------------------------

describe("hide and show", () => {
  it("hides a widget the user is allowed to hide", () => {
    const hidden = setHidden(DEFAULT_LAYOUT, "markets", true);
    expect(ids(visibleWidgets(hidden))).not.toContain("markets");
    // Still in the layout, so it can come back where it was.
    expect(ids(hidden)).toContain("markets");
  });

  it("REFUSES to hide the Orb", () => {
    // Reachable from a future voice command, so it declines quietly rather than
    // throwing — but it never actually hides.
    const attempted = setHidden(DEFAULT_LAYOUT, "orb", true);
    expect(attempted).toBe(DEFAULT_LAYOUT);
    expect(ids(visibleWidgets(attempted))).toContain("orb");
  });

  it("restores a hidden widget", () => {
    const hidden = setHidden(DEFAULT_LAYOUT, "weather", true);
    const shown = setHidden(hidden, "weather", false);
    expect(ids(visibleWidgets(shown))).toContain("weather");
  });
});

// ---------------------------------------------------------------------------
// Stored layouts
// ---------------------------------------------------------------------------

describe("normalizeLayout", () => {
  it("falls back to the default when nothing is stored", () => {
    expect(normalizeLayout(undefined)).toBe(DEFAULT_LAYOUT);
    expect(normalizeLayout([])).toBe(DEFAULT_LAYOUT);
    expect(normalizeLayout("nonsense")).toBe(DEFAULT_LAYOUT);
  });

  it("drops widgets a newer build no longer has", () => {
    // A layout is user data that outlives the code that wrote it.
    const restored = normalizeLayout([
      { id: "orb", size: { w: 2, h: 3 } },
      { id: "stock-ticker-2019", size: { w: 1, h: 1 } },
    ]);
    expect(ids(restored)).not.toContain("stock-ticker-2019");
  });

  it("appends widgets added after the layout was saved", () => {
    // Otherwise shipping a widget would make it invisible to every existing
    // user, which is the worst possible outcome for a new feature.
    const restored = normalizeLayout([{ id: "orb", size: { w: 2, h: 3 } }]);
    expect(ids(restored)).toContain("worldclock");
    expect(ids(restored)).toContain("markets");
  });

  it("re-clamps sizes in case the constraints themselves changed", () => {
    const restored = normalizeLayout([{ id: "weather", size: { w: 99, h: -4 } }]);
    const weather = restored.find((p) => p.id === "weather")!;
    expect(weather.size.w).toBeLessThanOrEqual(CONSTRAINTS.weather.max.w);
    expect(weather.size.h).toBeGreaterThanOrEqual(CONSTRAINTS.weather.min.h);
  });

  it("cannot be used to hide the Orb through a crafted payload", () => {
    // The client sends this document, so the repair step is a control, not a
    // convenience.
    const restored = normalizeLayout([{ id: "orb", size: { w: 2, h: 3 }, hidden: true }]);
    expect(restored.find((p) => p.id === "orb")?.hidden).toBeUndefined();
    expect(ids(visibleWidgets(restored))).toContain("orb");
  });

  it("ignores duplicates rather than rendering a widget twice", () => {
    const restored = normalizeLayout([
      { id: "clock", size: { w: 1, h: 1 } },
      { id: "clock", size: { w: 2, h: 2 } },
    ]);
    expect(ids(restored).filter((id) => id === "clock")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

describe("widget frame", () => {
  const placement: WidgetPlacement = { id: "weather", size: { w: 1, h: 1 } };
  const noop = () => undefined;

  const renderFrame = (customizing: boolean, over: Partial<WidgetPlacement> = {}) =>
    render(
      <WidgetFrame
        placement={{ ...placement, ...over }}
        label="Weather"
        customizing={customizing}
        index={1}
        total={4}
        onMove={noop}
        onResize={noop}
        onHide={noop}
        onDropOn={noop}
      >
        <p>widget content</p>
      </WidgetFrame>
    );

  it("adds NOTHING when customise mode is off", () => {
    // The normal experience has to stay clean — and an invisible drag handle
    // over a map would break panning.
    renderFrame(false);
    expect(screen.getByText("widget content")).toBeInTheDocument();
    expect(screen.queryByTestId("drag-weather")).toBeNull();
    expect(screen.queryByTestId("hide-weather")).toBeNull();
  });

  it("offers drag, move, resize and hide when customising", () => {
    renderFrame(true);
    expect(screen.getByTestId("drag-weather")).toBeInTheDocument();
    expect(screen.getByTestId("move-left-weather")).toBeInTheDocument();
    expect(screen.getByTestId("wider-weather")).toBeInTheDocument();
    expect(screen.getByTestId("hide-weather")).toBeInTheDocument();
  });

  it("disables a resize control at the limit, so the limit is visible", () => {
    renderFrame(true, { size: { w: 2, h: 3 } });
    // Weather maxes at w:2 — the control says so rather than silently no-oping.
    expect(screen.getByTestId("wider-weather")).toBeDisabled();
    expect(screen.getByTestId("narrower-weather")).toBeEnabled();
  });

  it("carries the widget id on drag, so a drop knows what moved", () => {
    renderFrame(true);
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByTestId("drag-weather"), {
      dataTransfer: { setData, effectAllowed: "" },
    });
    expect(setData).toHaveBeenCalledWith("text/jarvis-widget", "weather");
  });

  it("announces position for screen readers on the move controls", () => {
    renderFrame(true);
    expect(screen.getByTestId("move-left-weather")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("position 2 of 4")
    );
  });
});

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

describe("customize bar", () => {
  const noop = () => undefined;
  const base = {
    dirty: false,
    saving: false,
    layout: DEFAULT_LAYOUT,
    onToggle: noop,
    onSetHidden: noop,
    onSave: noop,
    onReset: noop,
  };

  it("is a single quiet button when customise mode is off", () => {
    render(<CustomizeBar {...base} customizing={false} />);
    expect(screen.getByTestId("customize-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("save-layout")).toBeNull();
  });

  it("cannot save when there is nothing to save", () => {
    render(<CustomizeBar {...base} customizing />);
    expect(screen.getByTestId("save-layout")).toBeDisabled();
  });

  it("says so when there are unsaved changes", () => {
    // Edits apply immediately but persist only on Save, so the state has to be
    // visible or "did that stick?" becomes a real question.
    render(<CustomizeBar {...base} customizing dirty />);
    expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("save-layout")).toBeEnabled();
  });

  it("will not let the Orb be switched off in Manage widgets", () => {
    render(<CustomizeBar {...base} customizing />);
    fireEvent.click(screen.getByTestId("manage-widgets"));
    expect(screen.getByTestId("toggle-orb")).toBeDisabled();
    expect(screen.getByTestId("toggle-weather")).toBeEnabled();
  });

  it("reports how many widgets are hidden", () => {
    const hidden = setHidden(DEFAULT_LAYOUT, "markets", true);
    render(<CustomizeBar {...base} customizing layout={hidden} />);
    expect(screen.getByTestId("manage-widgets")).toHaveTextContent("1 hidden");
  });
});

// ---------------------------------------------------------------------------
// World clock
// ---------------------------------------------------------------------------

describe("world clock", () => {
  it("converts one instant into each city's local time", () => {
    // 2026-09-08T12:00:00Z — a fixed instant, so the expected offsets are known.
    const instant = new Date("2026-09-08T12:00:00Z");

    const ny = formatInZone(instant, "America/New_York", false);
    const london = formatInZone(instant, "Europe/London", false);
    const tokyo = formatInZone(instant, "Asia/Tokyo", false);

    // September: New York is UTC-4, London UTC+1, Tokyo UTC+9.
    expect(ny?.time).toContain("08:");
    expect(london?.time).toContain("13:");
    expect(tokyo?.time).toContain("21:");
  });

  it("crosses the date line correctly", () => {
    // 23:30 UTC is already the next day in Tokyo.
    const instant = new Date("2026-09-08T23:30:00Z");
    const tokyo = formatInZone(instant, "Asia/Tokyo", false);
    expect(tokyo?.day).toContain("9");
  });

  it("survives an unknown timezone instead of taking the widget down", () => {
    expect(formatInZone(new Date(), "Mars/Olympus_Mons", false)).toBeNull();
  });

  it("ships the three cities the product asks for", () => {
    expect(DEFAULT_CITIES.map((c) => c.label)).toEqual(["New York", "London", "Tokyo"]);
  });
});
