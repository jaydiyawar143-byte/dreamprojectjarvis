"use client";

// ---------------------------------------------------------------------------
// Sprint 4.2 — Dashboard top bar.
//
// Chrome that does not change between routes: the drawer trigger below lg, the
// current section, and a live connection dot. It carries no page title — that
// belongs to PageHeader, inside the page's own measure.
// ---------------------------------------------------------------------------

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, activeNavHref } from "./nav";

export function DashboardTopbar({ onOpenNav }: { onOpenNav: () => void }) {
  const pathname = usePathname();
  const active = activeNavHref(pathname);
  const section = NAV_ITEMS.find((i) => i.href === active)?.label ?? "JARVIS";

  return (
    <header
      data-testid="dashboard-topbar"
      className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-sys-line bg-sys-deep/90 px-4 backdrop-blur-md sm:px-6"
    >
      <button
        type="button"
        onClick={onOpenNav}
        data-testid="open-nav"
        aria-label="Open navigation"
        className="sys-focus -ml-1 rounded p-2 text-sys-text transition-colors hover:bg-white/[0.04] hover:text-white lg:hidden"
      >
        <Menu size={18} aria-hidden="true" />
      </button>

      <span
        data-testid="topbar-section"
        className="font-mono text-xs uppercase tracking-hud text-sys-text/75"
      >
        {section}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-sys-ok animate-sys-pulse"
        />
        <span className="hidden font-mono text-xs uppercase tracking-hud text-sys-dim sm:inline">
          Connected
        </span>
      </div>
    </header>
  );
}
