"use client";

import { useEffect, useMemo, useRef } from "react";
import { ChevronUp, Maximize2, Minimize2, Minus, X } from "lucide-react";
import type { Surface, SurfaceAnchor } from "@jarvis/core/surface";
import { useSurfaceStore, type LiveSurface } from "@/lib/surface-store";
import { SurfaceBody } from "./surface-body";

// ---------------------------------------------------------------------------
// The surface layer.
//
// Sits above the dashboard and below nothing. It is `fixed` and `inset-0` with
// `pointer-events-none`, so the grid underneath keeps every click that is not
// on a panel — dragging a widget with a clock on screen still drags the widget.
//
// IT NEVER TOUCHES THE DASHBOARD. No layout is read, no widget is moved, and
// the user's saved arrangement is not consulted. The two systems share a screen
// and nothing else, which is the only way a transient panel can be safe to
// throw over an arrangement somebody spent time building.
//
// Positioning is by ANCHOR, resolved to a viewport-bounded box below. A surface
// cannot be placed outside the viewport because there is no anchor that
// expresses it — the anchors are corners and edges of a box that is itself
// inset from the screen.
// ---------------------------------------------------------------------------

/**
 * Anchor → position. Every one is inset from the viewport edge, so a surface
 * is bounded by construction rather than by a clamp that could be wrong.
 *
 * `max-h`/`max-w` are in viewport units for the same reason: a panel can be
 * larger than its content but never larger than the screen, whatever the
 * content turns out to be.
 */
const ANCHOR_CLASS: Record<SurfaceAnchor, string> = {
  center: "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(30rem,90vw)]",
  "orb-side": "left-[max(5rem,8vw)] top-1/2 -translate-y-1/2 w-[min(26rem,42vw)]",
  right: "right-4 top-[max(5rem,12vh)] w-[min(24rem,88vw)]",
  left: "left-[max(5rem,6vw)] top-[max(5rem,12vh)] w-[min(24rem,88vw)]",
  "top-right": "right-4 top-[max(4.5rem,10vh)] w-[min(24rem,88vw)]",
  "bottom-right": "right-4 bottom-24 w-[min(24rem,88vw)]",
  "map-primary": "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(52rem,92vw)]",
};

/**
 * On a phone every surface is a bottom sheet.
 *
 * Desktop holographic placement does not survive a 390px screen: a centred
 * 30rem panel is wider than the device, and a right-anchored one covers the
 * content it is annotating. A sheet is the native idiom and it keeps the
 * command bar reachable above the keyboard.
 */
const MOBILE_CLASS =
  "max-md:inset-x-2 max-md:bottom-2 max-md:top-auto max-md:left-2 max-md:right-2 max-md:w-auto max-md:translate-x-0 max-md:translate-y-0";

/**
 * Anchor overridden while expanded: the surface takes the workspace.
 *
 * How MUCH of the workspace depends on what is inside, which is the difference
 * between "bigger" and "better".
 *
 *   interactive — a map. Wider is strictly more useful: more road, more
 *                 context, more of the journey visible at once. It goes to
 *                 94vw, which on a wide monitor is genuinely near-fullscreen.
 *   analysis    — prose. Wider is strictly WORSE past a point: a 2400px line
 *                 on a 2560px monitor is unreadable, so it is capped at a
 *                 measure the eye can track and grows in height instead.
 */
const EXPANDED_BASE = "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[min(52rem,88dvh)]";
const EXPANDED_WIDE = `${EXPANDED_BASE} w-[94vw]`;
const EXPANDED_READABLE = `${EXPANDED_BASE} w-[min(72rem,94vw)]`;

function SurfacePanel({ live }: { live: LiveSurface }) {
  const { surface, status, minimized, expanded } = live;
  const ref = useRef<HTMLElement | null>(null);
  const store = useSurfaceStore();
  const customizing = useSurfaceStore((s) => s.dashboardCustomizing);

  const closing = status === "closing";
  // While the dashboard is being rearranged the entrance is suppressed rather
  // than played: a panel fading in over a drag is one more moving thing on a
  // screen where the user is already moving something.
  const opening = status === "opening" && !customizing;

  // ---- focus trap --------------------------------------------------------
  //
  // Only while EXPANDED. A glance surface is a panel beside the conversation
  // and trapping focus in it would strand the keyboard away from the composer;
  // an expanded one has taken over the workspace, and Tab escaping it into
  // widgets nobody can see is the worse failure.
  useEffect(() => {
    if (!expanded) return;
    const node = ref.current;
    if (!node) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Promote to `active` on the frame after mount, so the entrance transition
  // has two states to move between.
  useEffect(() => {
    if (!opening) return;
    const id = window.requestAnimationFrame(() => store.touch(surface.surfaceId));
    return () => window.cancelAnimationFrame(id);
  }, [opening, store, surface.surfaceId]);

  return (
    // ---- positioning, and ONLY positioning -------------------------------
    //
    // Split from the animated element on purpose. The anchors centre with
    // `-translate-y-1/2`, and the entrance animation also wants to move the
    // panel — so when both lived on one element the animation's `translate-y-0`
    // silently overrode the centring transform and every centred surface
    // rendered half its own height too low. At 1280×720 that put the route
    // panel 147px below the fold.
    //
    // One element owns the transform that positions. The other owns the
    // transform that animates. They cannot fight.
    <div
      className={[
        "pointer-events-none fixed z-[60]",
        expanded
          ? surface.mode === "interactive"
            ? EXPANDED_WIDE
            : EXPANDED_READABLE
          : ANCHOR_CLASS[surface.position.anchor],
        MOBILE_CLASS,
        // Never taller than the screen it is drawn on, whatever it contains.
        "max-h-[calc(100dvh-2rem)]",
        // Expanded leads, so a second surface cannot sit on top of the one the
        // user deliberately enlarged.
        expanded ? "z-[70]" : "",
      ].join(" ")}
    >
    <section
      ref={ref}
      role="dialog"
      aria-label={surface.title}
      data-testid={`surface-${surface.type}`}
      data-surface-id={surface.surfaceId}
      data-surface-status={status}
      data-context-key={surface.contextKey}
      tabIndex={-1}
      // Pointer and focus both pause the idle timer. This is where "5 seconds
      // of inactivity" stops being a phrase and becomes a behaviour.
      onPointerEnter={() => store.setInteracting(surface.surfaceId, true)}
      onPointerLeave={() => store.setInteracting(surface.surfaceId, false)}
      onPointerDown={() => store.touch(surface.surfaceId)}
      onFocusCapture={() => store.setFocused(surface.surfaceId, true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          store.setFocused(surface.surfaceId, false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          store.close(surface.surfaceId, "escape");
        }
      }}
      className={[
        // A column, so the body scrolls and the header and actions do not.
        "pointer-events-auto flex max-h-full w-full flex-col overflow-hidden",
        // Liquid glass: a real blur over a low-opacity fill, a hairline rim and
        // ONE restrained glow. The text sits on an opaque-enough ground to stay
        // readable, which is the constraint the effect has to respect.
        "surface-glass rounded-2xl",
        // Entrance and exit. Transform and opacity only — both composite, so
        // the Orb's animation and a Google map keep their frame budget.
        "transition-[opacity,transform,filter] duration-200 ease-out motion-reduce:transition-none",
        opening || closing
          ? "translate-y-1 scale-[0.98] opacity-0 blur-[2px] motion-reduce:blur-0"
          : "translate-y-0 scale-100 opacity-100 blur-0",
      ].join(" ")}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-white/[0.07] px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-white/90">{surface.title}</h2>
          {surface.subtitle && (
            <p className="truncate font-mono text-xs uppercase tracking-hud text-sys-dim">
              {surface.subtitle}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-testid={`surface-minimize-${surface.type}`}
            onClick={() => store.setMinimized(surface.surfaceId, !minimized)}
            aria-label={minimized ? `Restore ${surface.title}` : `Minimise ${surface.title}`}
            aria-expanded={!minimized}
            title={minimized ? "Restore" : "Minimise"}
            className="sys-focus rounded p-1 text-sys-dim transition-colors hover:text-white"
          >
            {minimized ? <ChevronUp size={14} aria-hidden="true" /> : <Minus size={14} aria-hidden="true" />}
          </button>

          {/* Expand is offered only where there is something to enlarge. A
              bigger clock is just a bigger clock. */}
          {surface.mode !== "glance" && (
            <button
              type="button"
              data-testid={`surface-expand-${surface.type}`}
              onClick={() => store.setExpanded(surface.surfaceId, !expanded)}
              aria-label={expanded ? `Shrink ${surface.title}` : `Expand ${surface.title}`}
              aria-pressed={expanded}
              title={expanded ? "Shrink" : "Expand"}
              className="sys-focus rounded p-1 text-sys-dim transition-colors hover:text-white"
            >
              {expanded ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
            </button>
          )}

          <button
            type="button"
            data-testid={`surface-close-${surface.type}`}
            onClick={() => store.close(surface.surfaceId, "user")}
            aria-label={`Close ${surface.title}`}
            title="Close"
            className="sys-focus -mr-1 rounded p-1 text-sys-dim transition-colors hover:text-white"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Collapsed to the title bar. The surface is still live and still bound
          to the conversation — a follow-up updates it and it reopens. */}
      {!minimized && (
        <>
          {/* The panel scrolls INSIDE itself. A surface never grows the page. */}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3.5 py-3">
            <SurfaceBody surface={surface} />
          </div>

          {surface.actions.length > 0 && <SurfaceActions surface={surface} />}
        </>
      )}
    </section>
    </div>
  );
}

/**
 * The action row.
 *
 * Every button sends its `intent` back through the ORDINARY chat path. Nothing
 * here calls a tool, and nothing here can: a surface control is a sentence the
 * user could have typed, so it goes through the same orchestrator, the same
 * permissions and the same approval gate as if they had. That is what stops a
 * panel button becoming a way around the approval system.
 */
function SurfaceActions({ surface }: { surface: Surface }) {
  const store = useSurfaceStore();

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-white/[0.07] px-3.5 py-2">
      {surface.actions.map((action) => (
        <button
          key={action.id}
          type="button"
          data-testid={`surface-action-${action.id}`}
          onClick={() => {
            if (action.id === "close") {
              store.close(surface.surfaceId, "user");
              return;
            }
            store.touch(surface.surfaceId);
            window.dispatchEvent(
              new CustomEvent("jarvis:surface-intent", { detail: { intent: action.intent } })
            );
          }}
          className={[
            "sys-focus rounded-full px-2.5 py-1 font-mono text-xs uppercase tracking-hud transition-colors",
            action.style === "quiet"
              ? "text-sys-dim hover:text-white"
              : "border border-sys-cyan/30 bg-sys-cyan/10 text-sys-cyan hover:bg-sys-cyan/20",
          ].join(" ")}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

export function SurfaceLayer() {
  const surfaces = useSurfaceStore((s) => s.surfaces);
  const reapIdle = useSurfaceStore((s) => s.reapIdle);
  const setReducedMotion = useSurfaceStore((s) => s.setReducedMotion);
  const closeAll = useSurfaceStore((s) => s.closeAll);

  // Reduced motion is a preference, not a hint: it shortens the exit and
  // disables the transition rather than merely softening it.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [setReducedMotion]);

  // One timer for every surface. A per-surface timeout would have to be
  // cancelled and recreated on every pointer move; a single low-frequency
  // sweep asks the same question without the churn.
  useEffect(() => {
    if (surfaces.length === 0) return;
    const id = window.setInterval(() => reapIdle(), 500);
    return () => window.clearInterval(id);
  }, [surfaces.length, reapIdle]);

  // Escape closes the top surface even when focus is elsewhere on the page.
  useEffect(() => {
    if (surfaces.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const top = surfaces[surfaces.length - 1];
      if (top) useSurfaceStore.getState().close(top.surface.surfaceId, "escape");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [surfaces]);

  // "close it" arriving as a directive is handled in the store; this is the
  // route-change case — surfaces are about a conversation, not a page.
  useEffect(() => () => closeAll("unmounted"), [closeAll]);

  const visible = useMemo(() => surfaces.slice(0, 2), [surfaces]);
  if (visible.length === 0) return null;

  return (
    <div
      data-testid="surface-layer"
      // `pointer-events-none` is what keeps the dashboard usable underneath:
      // only the panels themselves take the pointer.
      className="pointer-events-none fixed inset-0 z-[55]"
      aria-live="polite"
    >
      {visible.map((live) => (
        <SurfacePanel key={live.surface.surfaceId} live={live} />
      ))}
    </div>
  );
}
