"use client";

import { create } from "zustand";
import {
  MAX_ACTIVE_SURFACES,
  parseSurfaceDirective,
  type Surface,
  type SurfaceStatus,
} from "@jarvis/core/surface";

// ---------------------------------------------------------------------------
// Contextual surface state.
//
// Owns the part of the feature the server cannot: whether a pointer is inside
// the panel, whether it has keyboard focus, and how long it has been since
// either was true. The server decides WHAT to show; everything about how long
// it stays is decided here, because everything about how long it stays depends
// on the user.
//
// Deliberately separate from the dashboard's layout store. A surface is not a
// widget: it has no saved position, it is not dragged, and it must never touch
// the arrangement the user spent time building. The two share the screen and
// nothing else.
//
// ---------------------------------------------------------------------------
// THE AUTO-CLOSE RULE, WHICH IS THE WHOLE FEATURE.
//
// "Five seconds" means five seconds of INACTIVITY, not five seconds from
// opening. A panel that vanishes five seconds after appearing is a bug that
// looks like a design decision, and it is the single easiest thing to get
// wrong here.
//
// So the timer is not started when the surface opens. It is started when the
// surface becomes idle, and every one of these RESTARTS it:
//
//   * the pointer entering the panel
//   * the panel taking keyboard focus
//   * data still loading
//   * a new message in the conversation the surface is bound to
//
// and while any of the first three is still TRUE the timer does not run at all.
// ---------------------------------------------------------------------------

/** A surface plus the client-side state the server knows nothing about. */
export interface LiveSurface {
  surface: Surface;
  status: SurfaceStatus;
  /** Pointer is inside, or a drag/pan is in progress. */
  interacting: boolean;
  /** Focus is inside the panel. */
  focused: boolean;
  /** The surface is still fetching something of its own. */
  loading: boolean;
  /** When the surface was last used or updated. Drives the idle timer. */
  lastActiveAt: number;
  /** Set while the exit animation plays, so it is not unmounted mid-transition. */
  closingAt?: number;
  /**
   * Collapsed to its title bar.
   *
   * Distinct from closed: the surface is still bound to the conversation, still
   * reachable, and a follow-up still updates it. Minimising is "I am reading
   * something else for a moment", which is a different intention from "I am
   * done with this" — and a UI that only offers the second forces the user to
   * re-ask for the first.
   */
  minimized: boolean;
  /** Enlarged to fill the workspace. Only one surface can be expanded. */
  expanded: boolean;
}

interface SurfaceState {
  surfaces: LiveSurface[];
  /** The surface keyboard interaction currently applies to. */
  focusedId: string | null;
  /** Honoured by the renderer; also shortens the closing delay. */
  reducedMotion: boolean;

  /** Applies a validated directive from a chat response. */
  applyDirective: (raw: unknown) => void;
  /** Marks a surface used, which restarts its idle timer. */
  touch: (surfaceId: string) => void;
  setInteracting: (surfaceId: string, value: boolean) => void;
  setFocused: (surfaceId: string, value: boolean) => void;
  setLoading: (surfaceId: string, value: boolean) => void;
  /** User- or system-initiated close. Plays the exit, then removes. */
  close: (surfaceId: string, reason: string) => void;
  closeAll: (reason: string) => void;
  /** Called on a timer by the renderer; closes whatever has gone idle. */
  reapIdle: (now?: number) => void;
  /** Told to the server on the next turn, so it can reuse instead of duplicate. */
  activeContextKeys: () => string[];
  setReducedMotion: (value: boolean) => void;

  /** Collapse to the title bar, or restore. Neither closes the surface. */
  setMinimized: (surfaceId: string, value: boolean) => void;
  /** Fill the workspace, or return to the anchor. At most one at a time. */
  setExpanded: (surfaceId: string, value: boolean) => void;

  /**
   * Whether the user is rearranging their dashboard right now.
   *
   * Surfaces never touch widget positions, but they should not be COMPETING
   * for attention with a drag either: while customise mode is on, entrance
   * animations are suppressed and the idle timer is paused, so a panel cannot
   * fade out from under a cursor that is busy dragging a widget.
   */
  dashboardCustomizing: boolean;
  setDashboardCustomizing: (value: boolean) => void;
}

/** How long the exit animation is given before the surface is unmounted. */
const CLOSING_MS = 220;
const CLOSING_MS_REDUCED = 40;

export const useSurfaceStore = create<SurfaceState>((set, get) => ({
  surfaces: [],
  focusedId: null,
  reducedMotion: false,
  dashboardCustomizing: false,

  applyDirective: (raw) => {
    const parsed = parseSurfaceDirective(raw);
    if (!parsed.ok) {
      // A malformed directive is dropped, loudly in development and silently
      // in production. The user still has their answer in text; throwing a
      // broken panel at them would be strictly worse than showing none.
      if (process.env.NODE_ENV === "development") {
        console.warn("[surface] rejected directive:", parsed.errors);
      }
      return;
    }

    const directive = parsed.directive;
    const now = Date.now();

    if (directive.op === "close") {
      const target = directive.surfaceId;
      if (target) get().close(target, directive.reason);
      else get().closeAll(directive.reason);
      return;
    }

    if (directive.op === "update") {
      set((state) => ({
        surfaces: state.surfaces.map((live) =>
          live.surface.contextKey === directive.patch.contextKey ||
          live.surface.surfaceId === directive.patch.surfaceId
            ? {
                ...live,
                // The id is kept from the LIVE surface, not the patch: the
                // panel on screen keeps its identity across an update, which
                // is what lets React transition it rather than remount it —
                // and what stops a Google map being torn down and rebuilt
                // every time the user asks a follow-up.
                surface: { ...live.surface, ...directive.patch, surfaceId: live.surface.surfaceId },
                status: "active",
                lastActiveAt: now,
                ...(live.closingAt !== undefined ? { closingAt: undefined } : {}),
              }
            : live
        ),
      }));
      return;
    }

    // ---- open ------------------------------------------------------------
    const incoming = directive.surface;

    set((state) => {
      const existing = state.surfaces.find((s) => s.surface.contextKey === incoming.contextKey);

      // Same subject: this is a reuse, whatever the server called it.
      if (existing) {
        return {
          surfaces: state.surfaces.map((live) =>
            live.surface.contextKey === incoming.contextKey
              ? {
                  ...live,
                  surface: { ...incoming, surfaceId: live.surface.surfaceId },
                  status: "active",
                  lastActiveAt: now,
                  closingAt: undefined,
                }
              : live
          ),
        };
      }

      // ---- topic change ---------------------------------------------------
      //
      // A new subject retires the surfaces that were about the old one. Only
      // the ones that would have closed themselves anyway: a map the user
      // opened deliberately is not swept away because they glanced at a clock,
      // but a clock IS swept away when the conversation moves to Solana.
      const kept = state.surfaces.filter(
        (live) => !(live.surface.autoClose.enabled && !live.interacting && !live.focused)
      );

      const next: LiveSurface = {
        surface: incoming,
        status: "opening",
        interacting: false,
        focused: false,
        loading: false,
        lastActiveAt: now,
        minimized: false,
        expanded: false,
      };

      // ---- the stack ------------------------------------------------------
      //
      // Two at most. When it is full, the one evicted is the least recently
      // used — and interaction counts as use, so the panel under the cursor is
      // never the one that disappears.
      const stack = [...kept, next];
      if (stack.length <= MAX_ACTIVE_SURFACES) return { surfaces: stack };

      const evictable = stack
        .slice(0, -1)
        .filter((s) => !s.interacting && !s.focused)
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt);

      const victim = evictable[0] ?? stack[0]!;
      return { surfaces: stack.filter((s) => s !== victim) };
    });
  },

  touch: (surfaceId) =>
    set((state) => ({
      surfaces: state.surfaces.map((live) =>
        live.surface.surfaceId === surfaceId
          ? { ...live, status: "active", lastActiveAt: Date.now(), closingAt: undefined }
          : live
      ),
    })),

  setInteracting: (surfaceId, value) =>
    set((state) => ({
      surfaces: state.surfaces.map((live) =>
        live.surface.surfaceId === surfaceId
          ? {
              ...live,
              interacting: value,
              // Leaving the panel does NOT start the countdown from zero-ago —
              // it starts it from now, which is what "five seconds after you
              // stop" means.
              lastActiveAt: Date.now(),
              status: value ? "active" : live.status,
              closingAt: undefined,
            }
          : live
      ),
    })),

  setFocused: (surfaceId, value) =>
    set((state) => ({
      focusedId: value ? surfaceId : state.focusedId === surfaceId ? null : state.focusedId,
      surfaces: state.surfaces.map((live) =>
        live.surface.surfaceId === surfaceId
          ? { ...live, focused: value, lastActiveAt: Date.now(), closingAt: undefined }
          : live
      ),
    })),

  setLoading: (surfaceId, value) =>
    set((state) => ({
      surfaces: state.surfaces.map((live) =>
        live.surface.surfaceId === surfaceId
          ? { ...live, loading: value, lastActiveAt: Date.now() }
          : live
      ),
    })),

  close: (surfaceId, _reason) => {
    const { reducedMotion } = get();
    set((state) => ({
      surfaces: state.surfaces.map((live) =>
        live.surface.surfaceId === surfaceId
          ? { ...live, status: "closing", closingAt: Date.now() }
          : live
      ),
    }));

    // Removed after the exit animation, not during it. Unmounting immediately
    // is what makes a panel appear to blink out rather than leave.
    window.setTimeout(
      () =>
        set((state) => ({
          surfaces: state.surfaces.filter((live) => live.surface.surfaceId !== surfaceId),
          focusedId: state.focusedId === surfaceId ? null : state.focusedId,
        })),
      reducedMotion ? CLOSING_MS_REDUCED : CLOSING_MS
    );
  },

  closeAll: (reason) => {
    for (const live of get().surfaces) get().close(live.surface.surfaceId, reason);
  },

  reapIdle: (now = Date.now()) => {
    // A drag in progress owns the pointer. Retiring a panel mid-drag would be
    // the interface moving while the user is trying to move something else.
    if (get().dashboardCustomizing) return;

    for (const live of get().surfaces) {
      const { surface } = live;
      if (!surface.autoClose.enabled) continue;
      if (live.status === "closing") continue;

      // Any of these means the surface is in use. The timer does not run.
      if (live.interacting || live.focused || live.loading) continue;
      // Expanded means the user deliberately made it the thing they are
      // looking at. Closing that on a timer would be absurd.
      if (live.expanded) continue;

      const idleMs = now - live.lastActiveAt;
      if (idleMs >= surface.autoClose.idleSeconds * 1000) {
        get().close(surface.surfaceId, "idle");
      }
    }
  },

  activeContextKeys: () =>
    get()
      .surfaces.filter((s) => s.status !== "closing")
      .map((s) => s.surface.contextKey),

  setMinimized: (surfaceId, value) =>
    set((state) => ({
      surfaces: state.surfaces.map((live) =>
        live.surface.surfaceId === surfaceId
          ? {
              ...live,
              minimized: value,
              // Minimising is not abandoning: the timer restarts rather than
              // continuing from whenever the surface was last touched.
              lastActiveAt: Date.now(),
              // Collapsing an expanded surface returns it to its anchor first.
              expanded: value ? false : live.expanded,
            }
          : live
      ),
    })),

  setExpanded: (surfaceId, value) =>
    set((state) => ({
      surfaces: state.surfaces.map((live) =>
        live.surface.surfaceId === surfaceId
          ? { ...live, expanded: value, minimized: false, lastActiveAt: Date.now() }
          // At most one expanded surface: two panels both claiming the whole
          // workspace is two panels on top of each other.
          : value
            ? { ...live, expanded: false }
            : live
      ),
    })),

  setDashboardCustomizing: (value) => set({ dashboardCustomizing: value }),

  setReducedMotion: (value) => set({ reducedMotion: value }),
}));

/**
 * Pulls a surface directive out of a chat response's metadata.
 *
 * Kept here rather than in the chat store so the transport detail — that a
 * surface rides `metadata.surface`, exactly as `pendingAction` does — is stated
 * in one place.
 */
export function surfaceDirectiveFrom(metadata: unknown): unknown | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).surface;
  return value ?? null;
}
