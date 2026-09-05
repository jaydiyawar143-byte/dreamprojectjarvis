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
      {/* Desktop rail */}
      <aside
        data-testid="sidebar-desktop"
        className="hidden shrink-0 lg:block"
        aria-label="Primary"
      >
        <div className="fixed inset-y-0 left-0 w-64">
          <DashboardSidebar />
        </div>
        {/* Spacer so content is not overlapped by the fixed rail. */}
        <div className="w-64" aria-hidden="true" />
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
