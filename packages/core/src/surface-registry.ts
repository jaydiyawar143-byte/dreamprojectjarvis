import type { SurfaceAnchor, SurfaceMode, SurfaceType } from "./types/surface.js";

// ---------------------------------------------------------------------------
// The surface registry.
//
// One entry per surface type, holding the things that are true of that KIND of
// surface regardless of what it is showing: how it behaves when idle, where it
// prefers to sit, and what it offers to do next.
//
// It exists so the lifecycle engine can stay ignorant of domains. The engine
// asks "how long does this kind of thing wait before closing" and gets an
// answer; it never contains a branch about maps or prices. Adding a surface
// type is an entry here plus a renderer — not a change to the engine.
// ---------------------------------------------------------------------------

export interface SurfaceDefinition {
  type: SurfaceType;
  mode: SurfaceMode;
  anchor: SurfaceAnchor;
  /**
   * Seconds of inactivity before this kind of surface closes itself.
   *
   * Reading is not inactivity, which is why these are not all the same number.
   * A clock is understood at a glance and five seconds is generous; a page of
   * investment reasoning takes longer than five seconds to READ, and closing it
   * mid-sentence would be the interface fighting the user.
   */
  idleSeconds: number;
  /**
   * Whether idle auto-close applies at all.
   *
   * Off for surfaces the user is expected to work inside. A map that closed
   * itself while being panned would be indefensible; the interaction rules
   * would prevent it anyway, but a map is better governed by "close when the
   * subject changes" than by a timer.
   */
  autoClose: boolean;
  /** Offered on the surface. Each is sent back through the ordinary chat path. */
  actions: Array<{ id: string; label: string; intent: string; style?: "default" | "quiet" }>;
}

const CLOSE_ACTION = { id: "close", label: "Close", intent: "close the surface", style: "quiet" as const };

export const SURFACE_REGISTRY: Record<SurfaceType, SurfaceDefinition> = {
  clock: {
    type: "clock",
    mode: "glance",
    anchor: "center",
    idleSeconds: 5,
    autoClose: true,
    actions: [
      { id: "world", label: "World clocks", intent: "show world clocks" },
      CLOSE_ACTION,
    ],
  },

  "world-clock": {
    type: "world-clock",
    mode: "glance",
    anchor: "center",
    idleSeconds: 8,
    autoClose: true,
    actions: [CLOSE_ACTION],
  },

  weather: {
    type: "weather",
    mode: "glance",
    anchor: "right",
    idleSeconds: 8,
    autoClose: true,
    actions: [
      { id: "forecast", label: "Forecast", intent: "show the forecast" },
      CLOSE_ACTION,
    ],
  },

  map: {
    type: "map",
    mode: "interactive",
    anchor: "map-primary",
    // A map is worked in, not glanced at. It leaves when the subject changes or
    // the user says so.
    idleSeconds: 60,
    autoClose: false,
    actions: [
      { id: "expand", label: "Expand", intent: "expand the map" },
      CLOSE_ACTION,
    ],
  },

  route: {
    type: "route",
    mode: "interactive",
    anchor: "map-primary",
    idleSeconds: 60,
    autoClose: false,
    actions: [
      { id: "alternatives", label: "Alternatives", intent: "show alternative routes" },
      { id: "walking", label: "Walking", intent: "show the walking route" },
      CLOSE_ACTION,
    ],
  },

  "place-search": {
    type: "place-search",
    mode: "interactive",
    anchor: "map-primary",
    idleSeconds: 45,
    autoClose: false,
    actions: [CLOSE_ACTION],
  },

  market: {
    type: "market",
    mode: "glance",
    anchor: "right",
    idleSeconds: 10,
    autoClose: true,
    actions: [
      { id: "analyze", label: "Analyse", intent: "analyse this for investment" },
      CLOSE_ACTION,
    ],
  },

  "system-monitor": {
    type: "system-monitor",
    mode: "glance",
    anchor: "right",
    idleSeconds: 10,
    autoClose: true,
    actions: [CLOSE_ACTION],
  },

  tasks: {
    type: "tasks",
    mode: "glance",
    anchor: "right",
    idleSeconds: 12,
    autoClose: true,
    actions: [CLOSE_ACTION],
  },

  knowledge: {
    type: "knowledge",
    mode: "analysis",
    anchor: "center",
    // Prose. Closing this on a five-second timer would close it while it is
    // still being read.
    idleSeconds: 90,
    autoClose: false,
    actions: [CLOSE_ACTION],
  },

  "generic-data": {
    type: "generic-data",
    mode: "glance",
    anchor: "right",
    idleSeconds: 10,
    autoClose: true,
    actions: [CLOSE_ACTION],
  },

  unavailable: {
    type: "unavailable",
    mode: "glance",
    anchor: "center",
    // Long enough to read the reason and press Retry.
    idleSeconds: 15,
    autoClose: true,
    actions: [CLOSE_ACTION],
  },
};

export function getSurfaceDefinition(type: SurfaceType): SurfaceDefinition {
  return SURFACE_REGISTRY[type];
}

/**
 * The most contextual surfaces on screen at once.
 *
 * Two: one primary and one supporting — a route beside its details, a price
 * beside its analysis. A third is almost always the interface talking over
 * itself, and the dashboard is already behind all of this.
 */
export const MAX_ACTIVE_SURFACES = 2;
