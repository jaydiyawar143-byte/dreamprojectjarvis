"use client";

// ---------------------------------------------------------------------------
// Sprint 4.2 — Dashboard sidebar.
//
// One component serves both breakpoints: it is rendered fixed on desktop and
// inside the mobile drawer on small screens, so there is a single nav to keep
// correct. `onNavigate` lets the drawer close itself on selection without the
// sidebar knowing a drawer exists.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, User } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, activeNavHref } from "./nav";

export function DashboardSidebar({
  onNavigate,
  collapsible = false,
}: {
  onNavigate?: () => void;
  /**
   * UI V2 — render as a rail that reveals its labels on hover or focus.
   *
   * The reveal is pure CSS (`group-hover` / `group-focus-within` on the parent),
   * which is deliberate: a JS hover handler would leave keyboard users with a
   * permanently collapsed rail, and pointer events do not fire for tab
   * navigation. Labels stay in the DOM at all times and are only faded, so a
   * screen reader still announces "Dashboard" rather than an unlabelled icon.
   *
   * Off for the mobile drawer, which is already a full-width panel.
   */
  collapsible?: boolean;
}) {
  const pathname = usePathname();
  const active = activeNavHref(pathname);
  const { user, logout } = useAuth();

  // Fades with the rail. `whitespace-nowrap` stops the text reflowing mid
  // transition, which otherwise reads as a jitter rather than a slide.
  const revealed = collapsible
    ? "whitespace-nowrap opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100"
    : "";

  return (
    <div
      data-testid="dashboard-sidebar"
      data-collapsible={collapsible ? "true" : undefined}
      className="flex h-full w-full flex-col overflow-hidden border-r border-sys-line bg-sys-deep"
    >
      {/* Brand */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sys-line px-4">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-sys-cyan shadow-[0_0_10px_2px_rgba(62,224,242,0.55)]"
        />
        <span className={cn("font-mono text-xs uppercase tracking-hud text-white", revealed)}>
          JARVIS
        </span>
      </div>

      {/* Navigation */}
      <nav aria-label="Dashboard" className="no-scrollbar flex-1 overflow-y-auto overflow-x-hidden px-2 py-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="mb-5 last:mb-0">
            <p
              className={cn(
                "px-3 pb-2 font-mono text-xs uppercase tracking-hud text-sys-dim",
                revealed
              )}
            >
              {group.title}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = item.available && active === item.href;

                if (!item.available) {
                  return (
                    <li key={item.href}>
                      <span
                        data-testid={`nav-soon-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                        aria-disabled="true"
                        className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sys-dim"
                      >
                        <Icon size={15} className="shrink-0" aria-hidden="true" />
                        <span className={cn("truncate", revealed)}>{item.label}</span>
                        <span className="ml-auto rounded border border-sys-line px-1.5 py-px font-mono text-xs uppercase tracking-hud text-sys-dim">
                          Soon
                        </span>
                      </span>
                    </li>
                  );
                }

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={isActive ? "page" : undefined}
                      data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                      className={cn(
                        "sys-focus relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                        isActive
                          ? "bg-sys-cyan/[0.08] text-white"
                          : "text-sys-text/75 hover:bg-white/[0.03] hover:text-white"
                      )}
                    >
                      {/* Active rail — the one place a coloured bar is earned,
                          because it marks position rather than decorating. */}
                      {isActive && (
                        <span
                          aria-hidden="true"
                          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sys-cyan"
                        />
                      )}
                      <Icon
                        size={15}
                        className={cn("shrink-0", isActive ? "text-sys-cyan" : "text-sys-dim")}
                        aria-hidden="true"
                      />
                      <span className={cn("truncate", revealed)}>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Operator */}
      <div className="shrink-0 border-t border-sys-line px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <User size={14} className="shrink-0 text-sys-dim" aria-hidden="true" />
            <span data-testid="sidebar-user" className={cn("truncate text-xs text-sys-text/80", revealed)}>
              {user?.name || user?.email || "Operator"}
            </span>
          </div>
          <button
            type="button"
            onClick={logout}
            data-testid="sidebar-logout"
            aria-label="Sign out"
            title="Sign out"
            className="sys-focus rounded p-1.5 text-sys-dim transition-colors hover:bg-white/[0.04] hover:text-white"
          >
            <LogOut size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
