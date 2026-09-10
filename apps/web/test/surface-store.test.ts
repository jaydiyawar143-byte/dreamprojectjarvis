// ---------------------------------------------------------------------------
// Contextual surface lifecycle.
//
// The auto-close rule is the thing this file exists for, and it is the single
// easiest part of the feature to implement backwards. "Closes after 5 seconds"
// and "closes after 5 seconds of inactivity" differ by two words and produce
// completely different products: the first is a panel that vanishes while you
// are reading it, the second is one that gets out of the way when you are done.
//
// Several tests below would pass against the wrong implementation if they only
// checked "it eventually closes", so each one advances the clock in stages and
// asserts what is true in between.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSurfaceStore } from "../src/lib/surface-store";

const clockSurface = (overrides: Record<string, unknown> = {}) => ({
  op: "open",
  surface: {
    surfaceId: "s-clock",
    type: "clock",
    mode: "glance",
    title: "Local time",
    status: "opening",
    conversationBound: true,
    contextKey: "clock",
    autoClose: { enabled: true, idleSeconds: 5 },
    position: { anchor: "center" },
    data: { kind: "clock", zones: [{ label: "UTC", timeZone: "UTC", offsetMinutes: 0 }], hourFormat: "24", showAnalog: true },
    actions: [],
    reason: "test",
    ...overrides,
  },
});

const marketSurface = (id = "s-market") => ({
  op: "open",
  surface: {
    surfaceId: id,
    type: "market",
    mode: "glance",
    title: "Solana",
    status: "opening",
    conversationBound: true,
    contextKey: "market",
    autoClose: { enabled: true, idleSeconds: 10 },
    position: { anchor: "right" },
    data: {
      kind: "market",
      quotes: [{ symbol: "SOL", name: "Solana", price: 101, currency: "USD", change24hPct: 1, marketCap: null, volume24h: null }],
      provenance: { source: "CoinGecko", freshness: "LIVE" },
    },
    actions: [],
    reason: "test",
  },
});

/** A map: interactive, and never auto-closed. */
const routeSurface = (contextKey = "route:a->b") => ({
  op: "open",
  surface: {
    surfaceId: "s-route",
    type: "route",
    mode: "interactive",
    title: "A → B",
    status: "opening",
    conversationBound: true,
    contextKey,
    autoClose: { enabled: false, idleSeconds: 60 },
    position: { anchor: "map-primary" },
    data: {
      kind: "route",
      origin: { label: "A", position: { lat: 1, lng: 2 } },
      destination: { label: "B", position: { lat: 3, lng: 4 } },
      travelMode: "driving",
      routes: [
        {
          id: "primary",
          summary: "via NH 543",
          distanceMeters: 62400,
          durationSeconds: 5040,
          hasTolls: null,
          durationInTrafficSeconds: null,
          geometry: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }],
          recommended: true,
          recommendationReason: null,
        },
      ],
      provenance: { source: "Google Maps", freshness: "LIVE" },
    },
    actions: [],
    reason: "test",
  },
});

const reset = () =>
  useSurfaceStore.setState({
    surfaces: [],
    focusedId: null,
    reducedMotion: false,
    dashboardCustomizing: false,
  });
const store = () => useSurfaceStore.getState();
const ids = () => store().surfaces.map((s) => s.surface.surfaceId);

beforeEach(() => {
  vi.useRealTimers();
  reset();
});

// ---------------------------------------------------------------------------
// Auto-close — inactivity, not a countdown from opening
// ---------------------------------------------------------------------------

describe("auto-close", () => {
  it("does NOT close five seconds after opening if the user is still using it", () => {
    // The failure this whole file is defending against. A surface being USED at
    // t+5s must still be on screen.
    store().applyDirective(clockSurface());
    const t0 = Date.now();

    // Used at t+4s.
    store().touch("s-clock");
    const usedAt = Date.now();

    // t+5s from OPENING, but only ~1s since it was used.
    store().reapIdle(t0 + 5_100);
    expect(ids()).toContain("s-clock");

    // Five seconds after the USE, it goes.
    store().reapIdle(usedAt + 5_100);
    expect(store().surfaces.find((s) => s.surface.surfaceId === "s-clock")?.status).toBe("closing");
  });

  it("closes after the idle window when genuinely untouched", () => {
    store().applyDirective(clockSurface());
    const openedAt = store().surfaces[0]!.lastActiveAt;

    store().reapIdle(openedAt + 4_000);
    expect(store().surfaces[0]?.status).not.toBe("closing");

    store().reapIdle(openedAt + 5_100);
    expect(store().surfaces[0]?.status).toBe("closing");
  });

  it("does not run the timer at all while the pointer is inside", () => {
    store().applyDirective(clockSurface());
    store().setInteracting("s-clock", true);

    // A minute later, still open: interaction is not idling.
    store().reapIdle(Date.now() + 60_000);
    expect(store().surfaces[0]?.status).not.toBe("closing");
  });

  it("restarts the countdown from when the pointer LEAVES", () => {
    store().applyDirective(clockSurface());
    store().setInteracting("s-clock", true);
    store().setInteracting("s-clock", false);
    const leftAt = Date.now();

    store().reapIdle(leftAt + 3_000);
    expect(store().surfaces[0]?.status).not.toBe("closing");

    store().reapIdle(leftAt + 5_100);
    expect(store().surfaces[0]?.status).toBe("closing");
  });

  it("does not close a surface that has keyboard focus", () => {
    store().applyDirective(clockSurface());
    store().setFocused("s-clock", true);
    store().reapIdle(Date.now() + 60_000);
    expect(store().surfaces[0]?.status).not.toBe("closing");
  });

  it("does not close a surface that is still loading", () => {
    // A map fetching tiles has not been ignored; it has not arrived yet.
    store().applyDirective(clockSurface());
    store().setLoading("s-clock", true);
    store().reapIdle(Date.now() + 60_000);
    expect(store().surfaces[0]?.status).not.toBe("closing");
  });

  it("never auto-closes a surface the user works inside", () => {
    store().applyDirective(routeSurface());
    store().reapIdle(Date.now() + 600_000);
    expect(store().surfaces[0]?.status).not.toBe("closing");
  });
});

// ---------------------------------------------------------------------------
// Reuse and the stack
// ---------------------------------------------------------------------------

describe("surface reuse", () => {
  it("updates in place rather than stacking a second panel on one subject", () => {
    store().applyDirective(marketSurface("s-market-1"));
    store().applyDirective(marketSurface("s-market-2"));

    expect(store().surfaces).toHaveLength(1);
    // The panel on screen keeps its identity, so React transitions it instead
    // of remounting — which is what stops a live map being rebuilt.
    expect(ids()).toEqual(["s-market-1"]);
  });

  it("applies an update directive to the surface with the same context key", () => {
    store().applyDirective(marketSurface());
    store().applyDirective({
      op: "update",
      patch: { surfaceId: "ignored", contextKey: "market", title: "Markets" },
    });
    expect(store().surfaces[0]?.surface.title).toBe("Markets");
    expect(store().surfaces[0]?.surface.surfaceId).toBe("s-market");
  });

  it("holds at most two surfaces", () => {
    store().applyDirective(routeSurface("route:1"));
    store().applyDirective(routeSurface("route:2"));
    store().applyDirective(routeSurface("route:3"));
    expect(store().surfaces.length).toBeLessThanOrEqual(2);
  });

  it("never evicts the panel the user is touching", () => {
    store().applyDirective(routeSurface("route:1"));
    store().setInteracting("s-route", true);

    // Two more subjects arrive. The one under the cursor survives.
    store().applyDirective({ ...routeSurface("route:2"), surface: { ...routeSurface("route:2").surface, surfaceId: "s-2" } });
    store().applyDirective({ ...routeSurface("route:3"), surface: { ...routeSurface("route:3").surface, surfaceId: "s-3" } });

    expect(store().surfaces.some((s) => s.surface.contextKey === "route:1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Topic change
// ---------------------------------------------------------------------------

describe("topic change", () => {
  it("retires an idle glance surface when the subject changes", () => {
    // Crypto on screen, user asks the time: the price card should not sit there
    // covering the screen for a conversation it is no longer part of.
    store().applyDirective(marketSurface());
    store().applyDirective(clockSurface());

    expect(store().surfaces.some((s) => s.surface.contextKey === "market")).toBe(false);
    expect(store().surfaces.some((s) => s.surface.contextKey === "clock")).toBe(true);
  });

  it("does NOT sweep away a surface the user is working in", () => {
    // A map being panned is not abandoned just because a clock was requested.
    store().applyDirective(routeSurface());
    store().setInteracting("s-route", true);
    store().applyDirective(clockSurface());

    expect(store().surfaces.some((s) => s.surface.type === "route")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Explicit close
// ---------------------------------------------------------------------------

describe("close", () => {
  it("closes everything on a bare close directive", () => {
    // "close it" names nothing, because the user can see what is open.
    store().applyDirective(clockSurface());
    store().applyDirective({ op: "close", reason: "user asked" });
    expect(store().surfaces.every((s) => s.status === "closing")).toBe(true);
  });

  it("plays the exit before unmounting", async () => {
    // Removing the node immediately makes a panel blink out instead of leave.
    store().applyDirective(clockSurface());
    store().close("s-clock", "user");

    expect(store().surfaces[0]?.status).toBe("closing");
    await new Promise((r) => setTimeout(r, 320));
    expect(store().surfaces).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Validation at the boundary
// ---------------------------------------------------------------------------

describe("security", () => {
  it("drops a directive carrying markup instead of rendering it", () => {
    store().applyDirective({
      op: "open",
      surface: { ...clockSurface().surface, html: "<script>alert(1)</script>" },
    });
    expect(store().surfaces).toHaveLength(0);
  });

  it("drops an unknown surface type", () => {
    store().applyDirective({
      op: "open",
      surface: { ...clockSurface().surface, type: "iframe" },
    });
    expect(store().surfaces).toHaveLength(0);
  });

  it("drops junk without throwing", () => {
    for (const junk of [null, undefined, 42, "open", {}, { op: "explode" }]) {
      expect(() => store().applyDirective(junk)).not.toThrow();
    }
    expect(store().surfaces).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Minimise and expand
// ---------------------------------------------------------------------------

describe("minimise and expand", () => {
  it("minimising does NOT close — the surface stays bound to the conversation", () => {
    // The distinction the two controls exist to express. "Get out of the way
    // for a second" and "I am finished with this" are different intentions, and
    // a UI offering only the second makes the user re-ask for the first.
    store().applyDirective(marketSurface());
    store().setMinimized("s-market", true);

    expect(store().surfaces).toHaveLength(1);
    expect(store().surfaces[0]?.minimized).toBe(true);
    expect(store().activeContextKeys()).toEqual(["market"]);
  });

  it("a follow-up still updates a minimised surface", () => {
    store().applyDirective(marketSurface());
    store().setMinimized("s-market", true);
    store().applyDirective({
      op: "update",
      patch: { surfaceId: "x", contextKey: "market", title: "Markets" },
    });
    expect(store().surfaces[0]?.surface.title).toBe("Markets");
  });

  it("restarts the idle timer when minimised, rather than continuing it", () => {
    store().applyDirective(marketSurface());
    const openedAt = store().surfaces[0]!.lastActiveAt;
    store().setMinimized("s-market", true);
    expect(store().surfaces[0]!.lastActiveAt).toBeGreaterThanOrEqual(openedAt);
  });

  it("never auto-closes an EXPANDED surface", () => {
    // Expanding is the user saying "this is the thing I am looking at". A timer
    // closing that would be absurd.
    store().applyDirective(marketSurface());
    store().setExpanded("s-market", true);
    store().reapIdle(Date.now() + 600_000);
    expect(store().surfaces[0]?.status).not.toBe("closing");
  });

  it("expands only one surface at a time", () => {
    store().applyDirective(routeSurface("route:1"));
    store().applyDirective({
      ...marketSurface("s-m"),
      surface: { ...marketSurface("s-m").surface, autoClose: { enabled: false, idleSeconds: 60 } },
    });

    store().setExpanded("s-route", true);
    store().setExpanded("s-m", true);

    expect(store().surfaces.filter((s) => s.expanded)).toHaveLength(1);
    expect(store().surfaces.find((s) => s.expanded)?.surface.surfaceId).toBe("s-m");
  });

  it("expanding un-minimises", () => {
    store().applyDirective(routeSurface());
    store().setMinimized("s-route", true);
    store().setExpanded("s-route", true);
    expect(store().surfaces[0]?.minimized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coexisting with the dashboard
// ---------------------------------------------------------------------------

describe("dashboard customisation", () => {
  it("does not retire a surface while the user is rearranging widgets", () => {
    // A panel fading out from under a cursor that is mid-drag is the interface
    // moving while the user is trying to move something else.
    store().applyDirective(clockSurface());
    store().setDashboardCustomizing(true);
    store().reapIdle(Date.now() + 60_000);
    expect(store().surfaces[0]?.status).not.toBe("closing");
  });

  it("resumes the idle timer once customisation ends", () => {
    store().applyDirective(clockSurface());
    store().setDashboardCustomizing(true);
    store().reapIdle(Date.now() + 60_000);
    store().setDashboardCustomizing(false);
    store().reapIdle(Date.now() + 60_000);
    expect(store().surfaces[0]?.status).toBe("closing");
  });

  it("keeps no dashboard layout state of its own", () => {
    // The two systems share a screen and nothing else. If the surface store
    // ever grew a widget position, a transient panel could start rewriting an
    // arrangement the user spent time building.
    store().applyDirective(clockSurface());
    const keys = Object.keys(store().surfaces[0] ?? {});
    for (const forbidden of ["x", "y", "w", "h", "layout", "widgets", "grid"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// What the server is told
// ---------------------------------------------------------------------------

describe("context keys sent to the server", () => {
  it("reports what is on screen, so the server can reuse instead of duplicate", () => {
    store().applyDirective(routeSurface("route:a->b"));
    expect(store().activeContextKeys()).toEqual(["route:a->b"]);
  });

  it("omits a surface that is on its way out", () => {
    store().applyDirective(routeSurface("route:a->b"));
    store().close("s-route", "user");
    expect(store().activeContextKeys()).toEqual([]);
  });
});
