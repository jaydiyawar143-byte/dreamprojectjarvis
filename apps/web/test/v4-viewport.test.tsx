// ---------------------------------------------------------------------------
// V4 — the command centre fits the viewport.
//
// WHAT THIS FILE IS DEFENDING, AND HOW.
//
// The dashboard had two measured defects. Both were structural, and both are
// the kind that come back the moment someone adds a wrapper:
//
//   1. VERTICAL. The grid's rows were a fixed `10.5rem`, so its height was
//      1068px on every screen. With the topbar and padding the page came to
//      1202px, and any viewport shorter than that scrolled — 434px of overflow
//      at 1366×768, 122px at 1920×1080.
//   2. HORIZONTAL. The grid was capped at `max-w-6xl` (1152px) and centred, so
//      a 1920px screen rendered a 1152px dashboard with 704px of dead gutter.
//
// WHY THESE ARE CONTRACT TESTS AND NOT PIXEL TESTS.
//
// jsdom has no layout engine. Every box is 0×0, `scrollHeight` is 0 and
// `getBoundingClientRect()` returns zeros, so the obvious assertion —
// `documentElement.scrollHeight <= innerHeight` — passes here whatever the CSS
// says. It would be a test that cannot fail, which is worse than no test: it
// would have passed against the broken build above.
//
// So this file asserts the STRUCTURE that produces the fit — the flex chain
// that lets the column shrink, the absence of the two caps that broke it, and
// the single element allowed to scroll — and the real pixel measurement is
// done against a live browser by
// `.claude/skills/run-jarvis/viewport-audit.mjs`, which reports the actual
// scrollWidth/scrollHeight at five viewports and fails on any overflow.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

let pathname = "/dashboard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => pathname,
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    listApprovals: vi.fn(),
    getCapabilities: vi.fn(),
    getPreferences: vi.fn(),
    savePreferences: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    getWeather: vi.fn(),
    getCrypto: vi.fn(),
    getIndices: vi.fn(),
    getRoute: vi.fn(),
    searchPlaces: vi.fn(),
    getMapsConfig: vi.fn(),
    reverseGeocode: vi.fn(),
  };
});

// The monitor streams over a socket. Nothing here is about the transport, so it
// is replaced with one fixed live snapshot — the tiles need real values to lay
// out at all, and a stubbed stream keeps the layout assertions deterministic.
vi.mock("../src/lib/use-system-stream", () => ({
  useSystemStream: () => ({
    snapshot: {
      at: new Date().toISOString(),
      cpu: { loadPct: { value: 42 }, cores: 8, model: "Test CPU", temperatureC: { value: null, reason: "No sensor" } },
      memory: { usedPct: 61, usedBytes: 8e9, totalBytes: 16e9, availableBytes: 8e9 },
      gpu: { model: { value: null, reason: "n/a" }, utilizationPct: { value: null, reason: "n/a" }, memoryUsedMB: { value: null, reason: "n/a" }, temperatureC: { value: null, reason: "n/a" } },
      disk: { value: { usedPct: 47, usedBytes: 4e11, totalBytes: 1e12, mount: "C:" } },
      network: { value: { rxBytesPerSec: 1000, txBytesPerSec: 500, iface: "Wi-Fi" } },
      uptimeSeconds: 3600,
      containerized: false,
    },
    history: { cpu: [40, 42], memory: [60, 61], netRx: [900, 1000], netTx: [400, 500] },
    status: "live",
  }),
}));

import * as api from "../src/lib/api";
import { AuthProvider } from "../src/lib/auth";
import { DashboardShell } from "../src/components/dashboard/dashboard-shell";
import { WidgetShell } from "../src/components/widgets/widget-shell";
import { CommandCenter } from "../src/components/dashboard/command-center";
import {
  GRID_ROWS,
  gridHeight,
  gridRowHeight,
  MIN_ROW_HEIGHT,
} from "../src/components/widgets/layout";

const mockedApi = vi.mocked(api);
const ts = () => new Date().toISOString();

const unavailable = {
  freshness: "UNAVAILABLE" as const,
  observedAt: ts(),
  ageSeconds: 0,
  source: "Test",
  reason: "Not configured in this test",
};

beforeEach(() => {
  vi.clearAllMocks();
  pathname = "/dashboard";
  mockedApi.listApprovals.mockResolvedValue({
    success: true,
    data: [],
    pagination: { page: 1, limit: 3, total: 0, totalPages: 1 },
    timestamp: ts(),
  } as never);
  mockedApi.getCapabilities.mockResolvedValue({
    success: true,
    data: { weather: true, crypto: true, indices: false, geo: true, system: true, tasks: true },
    timestamp: ts(),
  } as never);
  mockedApi.getPreferences.mockResolvedValue({
    success: true, data: { preferences: {} }, timestamp: ts(),
  } as never);
  mockedApi.savePreferences.mockResolvedValue({
    success: true, data: { preferences: {} }, timestamp: ts(),
  } as never);
  mockedApi.listTasks.mockResolvedValue({ success: true, data: { tasks: [] }, timestamp: ts() } as never);
  mockedApi.getWeather.mockResolvedValue({ success: true, data: { value: null, meta: unavailable }, timestamp: ts() } as never);
  mockedApi.getCrypto.mockResolvedValue({ success: true, data: { value: [], meta: unavailable }, timestamp: ts() } as never);
  mockedApi.getIndices.mockResolvedValue({ success: true, data: { value: null, meta: unavailable }, timestamp: ts() } as never);
  // The map hook rejects on an unmocked config call, which takes the tree down
  // and turns every assertion below into a mystery. "Not configured" is the
  // honest answer in a test: no key, no map, no network.
  mockedApi.getMapsConfig.mockResolvedValue({
    success: true, data: { configured: false, apiKey: null }, timestamp: ts(),
  } as never);
  mockedApi.reverseGeocode.mockResolvedValue({ success: false, error: { code: "X", message: "no" }, timestamp: ts() } as never);

  // The sidebar reads useAuth(), so the shell needs a resolved session. UI V2
  // keeps it in an HttpOnly cookie, so it is seeded by making refresh succeed.
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/auth/refresh")
      ? { accessToken: "token-abc", expiresIn: 900 }
      : { id: "u1", email: "op@jarvis.local", name: "Operator", role: "member", createdAt: ts(), updatedAt: ts() };
    return Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ success: true, data: body, timestamp: ts() }),
    } as Response);
  }) as unknown as typeof fetch;
});

/** The shell always sits under a resolved session in the real app. */
const renderShell = (fullscreen: boolean) =>
  render(
    <AuthProvider>
      <DashboardShell fullscreen={fullscreen}>content</DashboardShell>
    </AuthProvider>
  );

/** Class list of an element, as a set, so assertions read as intent. */
const classes = (el: Element) => new Set(el.className.split(/\s+/).filter(Boolean));
const has = (el: Element, c: string) => classes(el).has(c);

// ---------------------------------------------------------------------------
// The shell — fullscreen is OPT-IN
// ---------------------------------------------------------------------------

describe("dashboard shell viewport mode", () => {
  it("keeps long pages reachable by scrolling INSIDE main, not the document", () => {
    // The intent here is unchanged and still load-bearing: /approvals and
    // /knowledge are lists that legitimately run past the fold, and capping
    // them at the viewport must not strand their content.
    //
    // What changed is WHERE the scrollbar lives. The document no longer scrolls
    // at all (html/body are pinned in globals.css, because the chat route was
    // putting a scrollbar on the page), so `min-h-screen` would now be the
    // worst outcome — content could grow with nothing able to scroll it, and it
    // would simply clip. Instead the shell is viewport-height and `<main>`
    // carries the scroll region.
    renderShell(false);

    const shell = screen.getByTestId("dashboard-shell");
    expect(has(shell, "min-h-screen")).toBe(false);
    expect(has(shell, "h-[100dvh]")).toBe(true);
    expect(shell.getAttribute("data-fullscreen")).toBeNull();

    const main = screen.getByTestId("dashboard-main");
    // Reachable: it scrolls itself.
    expect(has(main, "overflow-y-auto")).toBe(true);
    expect(has(main, "overflow-hidden")).toBe(false);
    // And able to shrink, or the overflow rule would never engage.
    expect(has(main, "min-h-0")).toBe(true);
    expect(main.getAttribute("data-scroll")).toBe("internal");
  });

  it("pins itself to the viewport when a route opts in", () => {
    renderShell(true);

    const shell = screen.getByTestId("dashboard-shell");
    expect(shell.getAttribute("data-fullscreen")).toBe("true");
    // Exactly the viewport, and never taller.
    expect(has(shell, "h-[100dvh]")).toBe(true);
    expect(has(shell, "max-h-[100dvh]")).toBe(true);
    expect(has(shell, "min-h-screen")).toBe(false);
  });

  it("lets the content column SHRINK, not merely clip", () => {
    // The whole fix rests on this. A flex child defaults to `min-height: auto`,
    // which refuses to shrink below its content — so without `min-h-0` the
    // column still grows past 100dvh and `overflow-hidden` just hides the
    // overflow instead of preventing it. That is the "don't just hide the
    // scrollbar" failure mode, and this assertion is what rules it out.
    renderShell(true);

    const main = screen.getByTestId("dashboard-main");
    expect(has(main, "min-h-0")).toBe(true);
    expect(has(main, "overflow-hidden")).toBe(true);

    const column = main.parentElement!;
    expect(has(column, "min-h-0")).toBe(true);
    expect(has(column, "min-w-0")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The command centre — full width, full height, one grid
//
// The grid only renders once the workspace has been MEASURED, and jsdom has no
// layout: `clientWidth` and `clientHeight` are 0, so the component would always
// take the stacked branch. The two tests that need the grid stub those two
// properties, which is the smallest possible lie — everything else about the
// component runs for real.
// ---------------------------------------------------------------------------

/** Makes jsdom report a size, so the measured-workspace branch can be reached. */
function withMeasuredWorkspace(width: number, height: number) {
  const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
  return () => {
    if (w) Object.defineProperty(HTMLElement.prototype, "clientWidth", w);
    if (h) Object.defineProperty(HTMLElement.prototype, "clientHeight", h);
  };
}

describe("command centre viewport layout", () => {
  const renderCentre = async () => {
    render(<CommandCenter />);
    await waitFor(() => expect(screen.getByTestId("command-workspace")).toBeInTheDocument());
  };

  it("is a full-height column that can shrink", async () => {
    await renderCentre();
    const centre = screen.getByTestId("command-center");
    expect(has(centre, "h-full")).toBe(true);
    expect(has(centre, "min-h-0")).toBe(true);
    expect(has(centre, "flex-col")).toBe(true);
  });

  it("does NOT centre itself in a narrow measure", async () => {
    // The 1152px-wide dashboard floating in the middle of a 1920px screen. The
    // cap and the centring were separate mistakes and both have to stay gone.
    await renderCentre();
    const centre = screen.getByTestId("command-center");
    expect(has(centre, "items-center")).toBe(false);
    expect([...classes(centre)].some((c) => /(^|:)max-w-/.test(c))).toBe(false);
  });

  it("gives the workspace the height the chrome leaves it", async () => {
    await renderCentre();
    const workspace = screen.getByTestId("command-workspace");
    expect(has(workspace, "flex-1")).toBe(true);
    expect(has(workspace, "min-h-0")).toBe(true);
    expect([...classes(workspace)].some((c) => /(^|:)max-w-/.test(c))).toBe(false);
  });

  it("keeps the command bar OUTSIDE the workspace", async () => {
    // The one control that must always be reachable. Inside the grid, a user
    // who shrank the Orb would have shrunk the composer with it; outside, no
    // arrangement can cover it, move it or squeeze it.
    await renderCentre();
    const workspace = screen.getByTestId("command-workspace");
    const bar = screen.getByTestId("command-bar");

    expect(workspace.contains(bar)).toBe(false);
    expect(has(bar, "shrink-0")).toBe(true);
    expect(screen.getByTestId("command-input")).toBeInTheDocument();
  });

  it("stacks into one column when the viewport is too narrow for a 12-column grid", async () => {
    // A 12-column grid on a phone is ~30px per cell. Below the threshold the
    // grid is not rendered at all and the widgets stack, scrolling INSIDE the
    // workspace — never the page.
    await renderCentre();
    const workspace = screen.getByTestId("command-workspace");

    expect(workspace.getAttribute("data-mode")).toBe("stacked");
    expect(screen.getByTestId("command-stack")).toBeInTheDocument();
    expect(has(workspace, "overflow-y-auto")).toBe(true);
    expect(has(workspace, "overflow-x-hidden")).toBe(true);
  });

  it("renders the free-form grid once the workspace has a desktop width", async () => {
    const restore = withMeasuredWorkspace(1600, 800);
    try {
      render(<CommandCenter />);
      await waitFor(() =>
        expect(screen.getByTestId("command-workspace").getAttribute("data-mode")).toBe("grid")
      );

      // Every widget is present as a grid cell, the Orb included — it is a
      // widget now, not a hard-coded hero outside the layout.
      for (const id of ["orb", "map", "system", "clock", "worldclock", "weather", "tasks", "markets"]) {
        expect(screen.getByTestId(`cell-${id}`)).toBeInTheDocument();
      }
      // And it does not scroll: the grid is sized to fit.
      expect(has(screen.getByTestId("command-workspace"), "overflow-hidden")).toBe(true);
    } finally {
      restore();
    }
  });

  it("shows grid guides only while customising", async () => {
    const restore = withMeasuredWorkspace(1600, 800);
    try {
      render(<CommandCenter />);
      await waitFor(() =>
        expect(screen.getByTestId("command-workspace").getAttribute("data-mode")).toBe("grid")
      );

      // Clean by default — the premium state of this dashboard is the one with
      // no spreadsheet showing through it.
      expect(screen.queryByTestId("grid-guides")).toBeNull();

      fireEvent.click(screen.getByTestId("customize-toggle"));
      await waitFor(() => expect(screen.getByTestId("grid-guides")).toBeInTheDocument());
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// The geometry that makes a page scrollbar impossible
// ---------------------------------------------------------------------------

describe("grid geometry", () => {
  const MARGIN = 10;

  it("never asks for more height than the workspace has", () => {
    // The assertion the whole fix rests on, across every viewport height the
    // dashboard is expected to run at — and a few it is not.
    for (const available of [420, 560, 598, 646, 778, 800, 958, 1318, 2000]) {
      const rh = gridRowHeight(available, MARGIN);
      expect(gridHeight(rh, MARGIN)).toBeLessThanOrEqual(available);
    }
  });

  it("uses very nearly all of it, rather than leaving a band empty", () => {
    // Fitting is easy if you waste half the screen. The floor costs at most one
    // pixel per row, so twelve rows must land within GRID_ROWS px of the space.
    for (const available of [598, 646, 778, 958, 1318]) {
      const rh = gridRowHeight(available, MARGIN);
      expect(available - gridHeight(rh, MARGIN)).toBeLessThan(GRID_ROWS);
    }
  });

  it("grows the rows when the viewport grows", () => {
    expect(gridRowHeight(1318, MARGIN)).toBeGreaterThan(gridRowHeight(598, MARGIN));
  });

  it("still fits when a drag has pushed the arrangement far past twelve rows", () => {
    // The regression that took longest to find. A deep arrangement was given a
    // row height computed for a SHALLOWER one — first because the row count was
    // capped at a ceiling the grid library does not actually honour, then
    // because a comfortable row-height floor refused to go low enough — and the
    // bottom widgets hung out of the workspace either way.
    //
    // Every combination below is one the dashboard can genuinely reach: the
    // supported viewports, against depths from the shipped twelve rows up to
    // the storage ceiling.
    for (const rows of [12, 16, 20, 26, 32]) {
      for (const available of [562, 646, 778, 958, 1318]) {
        const rh = gridRowHeight(available, MARGIN, rows);
        expect(gridHeight(rh, MARGIN, rows)).toBeLessThanOrEqual(available);
      }
    }
  });

  it("cannot fit what does not fit, and fails safe when it cannot", () => {
    // Honesty about the tail. Thirty-two rows in a 420px workspace is not a
    // layout problem, it is arithmetic: the GAPS alone are 31 × 10px = 310px,
    // so no row height closes it. That combination needs a viewport under about
    // 600px tall AND an arrangement the user has driven to the storage ceiling.
    //
    // It is recorded rather than hidden because the failure mode matters: the
    // workspace is `overflow-hidden`, so the excess is CLIPPED. The page still
    // does not scroll, which is the invariant this whole file exists to defend
    // — the dashboard degrades by showing less, never by growing.
    const rows = 32;
    const available = 420;
    const rh = gridRowHeight(available, MARGIN, rows);
    expect(rh).toBe(MIN_ROW_HEIGHT);
    expect(gridHeight(rh, MARGIN, rows)).toBeGreaterThan(available);
    expect(MARGIN * (rows - 1)).toBeGreaterThan(available - rows * MIN_ROW_HEIGHT);
  });

  it("never returns a row height of zero, however little room there is", () => {
    // The floor is not a readable size — it is the last line of defence. A row
    // height of 0 would collapse every widget to nothing.
    expect(gridRowHeight(60, MARGIN, 32)).toBeGreaterThanOrEqual(MIN_ROW_HEIGHT);
    expect(MIN_ROW_HEIGHT).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Widgets scroll inside themselves
// ---------------------------------------------------------------------------

describe("widget overflow containment", () => {
  it("scrolls a list widget inside its own panel", () => {
    render(
      <WidgetShell title="Markets" meta={{ ...unavailable, freshness: "LIVE" }}>
        <p>rows</p>
      </WidgetShell>
    );
    const body = screen.getByText("rows").parentElement!;
    expect(has(body, "overflow-y-auto")).toBe(true);
    expect(has(body, "min-h-0")).toBe(true);
    expect(has(body, "flex-1")).toBe(true);
  });

  it("does not put a scrollbar over a canvas widget", () => {
    // A map is sized TO its box, so it can never have more to show than fits.
    // A scrollbar there would only ever be a sub-pixel artefact sitting over
    // the map, and the wheel belongs to Google Maps.
    render(
      <WidgetShell title="Location" fill meta={{ ...unavailable, freshness: "LIVE" }}>
        <p>map</p>
      </WidgetShell>
    );
    const body = screen.getByText("map").parentElement!;
    expect(body.getAttribute("data-fill")).toBe("true");
    expect(has(body, "overflow-hidden")).toBe(true);
    expect(has(body, "overflow-y-auto")).toBe(false);
  });

  it("keeps the system monitor's six tiles in ONE grid", async () => {
    // Two grids of four and two could never produce fewer than three rows of
    // tiles, whatever the width — which is why the monitor was the first widget
    // to clip on a 1366×768 screen. Merged, a wider widget can lay them out in
    // two rows instead. The column count itself follows the element's measured
    // width, so it is not assertable here (jsdom has no ResizeObserver and no
    // layout); that the tiles share one container is.
    const { SystemWidget } = await import("../src/components/widgets/system-widget");
    render(<SystemWidget />);

    const tiles = await screen.findByTestId("system-tiles", undefined, { timeout: 4000 });
    for (const id of ["tile-cpu", "tile-ram", "tile-cpu-temp", "tile-gpu", "tile-disk", "tile-network"]) {
      const tile = screen.queryByTestId(id);
      if (tile) expect(tiles.contains(tile)).toBe(true);
    }
    // Falls back to two columns where the width cannot be measured, rather than
    // rendering nothing or guessing wide.
    expect(tiles.getAttribute("data-columns")).toBe("2");
  });

  it("lets the panel itself be shorter than its content", () => {
    render(
      <WidgetShell title="Markets" testId="w" meta={{ ...unavailable, freshness: "LIVE" }}>
        <p>rows</p>
      </WidgetShell>
    );
    expect(has(screen.getByTestId("w"), "min-h-0")).toBe(true);
  });
});
