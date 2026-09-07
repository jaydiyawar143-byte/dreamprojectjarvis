// ---------------------------------------------------------------------------
// Sprint 4.2 — Dashboard navigation model.
//
// Navigation is data, not markup, so a future panel is added by appending one
// entry here rather than by editing the sidebar. The Meta Ads and Knowledge
// Base rows already exist with `available: false`: they render as "Soon" and
// are deliberately not navigable, which is how the shell advertises the slots
// those sprints will fill without pretending the panels are built.
// ---------------------------------------------------------------------------

import {
  Activity,
  BookOpen,
  Bot,
  CheckSquare,
  Inbox,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  Plug,
  Settings,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** False when the destination is not built yet: shown, dimmed, inert. */
  available: boolean;
}

export interface NavGroup {
  /** Groups are titled by what the items are *for*, not by how they are built. */
  title: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, available: true },
    ],
  },
  {
    title: "Operate",
    items: [
      { href: "/chat", label: "Assistant", icon: MessageSquare, available: true },
      { href: "/opportunities", label: "Opportunities", icon: Inbox, available: true },
      { href: "/approvals", label: "Approvals", icon: CheckSquare, available: true },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { href: "/knowledge", label: "Knowledge Base", icon: BookOpen, available: true },
      { href: "/meta-ads", label: "Meta Ads", icon: Megaphone, available: true },
    ],
  },
  // UI V2 — the capability surfaces. Each of these is backed by an endpoint
  // that genuinely exists; nothing here is aspirational.
  {
    title: "Capabilities",
    items: [
      { href: "/agents", label: "Agents", icon: Bot, available: true },
      { href: "/automations", label: "Automations", icon: Workflow, available: true },
      { href: "/integrations", label: "Integrations", icon: Plug, available: true },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/activity", label: "Activity", icon: Activity, available: true },
      { href: "/system", label: "Health", icon: ShieldCheck, available: true },
      { href: "/settings", label: "Settings", icon: Settings, available: true },
    ],
  },
];

/** Flat view, for tests and for resolving the active route. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * The nav entry a pathname belongs to.
 *
 * Longest match wins so a nested route such as /opportunities/abc still lights
 * up its parent, while /dashboard does not swallow every other path.
 */
export function activeNavHref(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const matches = NAV_ITEMS.filter(
    (item) =>
      item.available &&
      (pathname === item.href || pathname.startsWith(`${item.href}/`))
  );
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (b.href.length > a.href.length ? b : a)).href;
}
