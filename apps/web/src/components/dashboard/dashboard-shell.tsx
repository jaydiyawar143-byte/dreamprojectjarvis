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
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { DashboardSidebar } from "./dashboard-sidebar";
import { DashboardTopbar } from "./dashboard-topbar";

export function DashboardShell({ children }: { children: ReactNode }) {
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
    <div data-testid="dashboard-shell" className="flex min-h-screen bg-sys-void text-sys-text">
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

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardTopbar onOpenNav={() => setNavOpen(true)} />
        <main data-testid="dashboard-main" className="flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
