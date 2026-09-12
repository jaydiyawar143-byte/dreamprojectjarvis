"use client";

// ---------------------------------------------------------------------------
// Sprint 4.2 — Dashboard shell.
//
// Composes the persistent chrome: a fixed sidebar from lg upward, an overlay
// drawer below it, and a sticky top bar over a scrolling content column.
//
// The drawer is the only stateful part. It closes on selection, on Escape and
// on backdrop click, and it is removed from the accessibility tree while shut
// rather than merely hidden, so a screen reader never walks a nav that is not
// on screen.
//
// ---------------------------------------------------------------------------
// The shell is ALWAYS viewport-height. `fullscreen` now selects only where the
// scrolling happens.
//
// This changed when the document stopped scrolling. `html`/`body` are pinned to
// `height: 100%; overflow: hidden` (see globals.css), because a page-level
// scrollbar on a dark full-bleed layout reads as a rendering fault and the
// chat route was producing one. With the document pinned, a `min-h-screen`
// shell would be the worst of both worlds: content could still grow, but
// nothing would be able to scroll it, so it would simply clip.
//
// So every route now wears the same fixed shell, and the difference is which
// element owns the scroll region:
//
//   fullscreen (/dashboard) — a command centre read at a glance. Its own panes
//                             scroll internally; `<main>` must NOT, so it stays
//                             `overflow-hidden`.
//   everything else         — /approvals, /knowledge, /integrations and the
//                             rest are documents that legitimately run past the
//                             fold. `<main>` gets `overflow-y-auto`, which puts
//                             their scrollbar inside the content column instead
//                             of on the page. Nothing becomes unreachable.
//
// The `min-h-0` on the content column and on `<main>` is load-bearing, not
// defensive: a flex child's default `min-height: auto` refuses to shrink below
// its content, so without it the column grows past 100dvh and the overflow rule
// never engages — it would merely CLIP. That exact omission, on the chat route's
// message list, is what put a scrollbar on the document in the first place.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { DashboardSidebar } from "./dashboard-sidebar";
import { DashboardTopbar } from "./dashboard-topbar";
import { SurfaceLayer } from "@/components/surfaces/surface-layer";

export function DashboardShell({
  children,
  fullscreen = false,
}: {
  children: ReactNode;
  /**
   * Fit the shell to the viewport instead of growing with its content.
   *
   * Only /dashboard sets this. See the note at the top of the file for why it
   * is not the default.
   */
  fullscreen?: boolean;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();

  const closeNav = useCallback(() => setNavOpen(false), []);

  // A route change must never leave the drawer covering the page it opened.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    <div
      data-testid="dashboard-shell"
      data-fullscreen={fullscreen ? "true" : undefined}
      // ALWAYS viewport-height now, not only in fullscreen. The document no
      // longer scrolls (see globals.css), so a `min-h-screen` shell would let
      // content grow with nothing able to scroll it — the page would simply
      // clip. Every route is a fixed shell with internal scroll regions.
      className={`flex h-[100dvh] max-h-[100dvh] overflow-hidden bg-sys-void text-sys-text`}
    >
      {/*
        Desktop rail — UI V2.

        Collapsed to an icon rail by default and expanded on hover or on focus
        entering it. `group` + `group-hover`/`group-focus-within` does the work
        in CSS, so it responds to the keyboard as well as the pointer; a JS
        mouseenter handler would strand tab users on a collapsed rail.

        The rail EXPANDS OVER the content rather than pushing it: the spacer
        keeps the collapsed width, so the page does not reflow every time the
        cursor passes by. Reflowing a dashboard on hover is disorienting and
        would move the thing the user was reaching for.
      */}
      <aside
        data-testid="sidebar-desktop"
        className="group hidden shrink-0 lg:block"
        aria-label="Primary"
      >
        <div
          data-testid="sidebar-rail"
          className="fixed inset-y-0 left-0 z-40 w-16 transition-[width] duration-300 ease-out group-hover:w-64 group-focus-within:w-64 motion-reduce:transition-none"
        >
          <DashboardSidebar collapsible />
        </div>
        <div className="w-16" aria-hidden="true" />
      </aside>

      {/* Mobile / tablet drawer */}
      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" data-testid="nav-drawer">
          <button
            type="button"
            data-testid="nav-backdrop"
            aria-label="Close navigation"
            onClick={closeNav}
            className="absolute inset-0 h-full w-full cursor-default bg-black/70"
          />
          <div className="absolute inset-y-0 left-0 w-64 shadow-2xl">
            <DashboardSidebar onNavigate={closeNav} />
            <button
              type="button"
              onClick={closeNav}
              data-testid="close-nav"
              aria-label="Close navigation"
              className="sys-focus absolute right-2 top-3.5 rounded p-1.5 text-sys-dim transition-colors hover:bg-white/[0.05] hover:text-white"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/*
        Contextual surfaces.

        Above the dashboard and outside the content column, so a panel is never
        clipped by the workspace's `overflow-hidden` and never participates in
        the grid's height. It is `pointer-events-none` except on the panels
        themselves, so the widgets underneath keep every click that is not on
        one — dragging a widget with a clock on screen still drags the widget.

        It renders nothing at all when no surface is open, which is most of the
        time.
      */}
      <SurfaceLayer />

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col min-h-0">
        <DashboardTopbar onOpenNav={() => setNavOpen(true)} />
        {/*
          This is where page scrolling now lives.

          `fullscreen` (the dashboard) owns its own internal panes and must not
          scroll as a whole, so it stays `overflow-hidden`. Every other route —
          integrations, settings, knowledge — can be taller than the viewport,
          and with the document pinned they would be unreachable without a
          scroll region of their own. So they get `overflow-y-auto` HERE, which
          puts the scrollbar inside the content column rather than on the page.

          `min-h-0` on both this element and its parent is what allows either
          behaviour: without it the flex child refuses to shrink and grows
          instead, which is the bug that produced a page-level scrollbar.
        */}
        <main
          data-testid="dashboard-main"
          data-scroll={fullscreen ? "contained" : "internal"}
          className={`min-h-0 flex-1 ${fullscreen ? "overflow-hidden" : "overflow-y-auto"}`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
