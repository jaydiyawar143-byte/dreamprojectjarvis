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
  Globe,
  Inbox,
  LayoutDashboard,
  Mail,
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
    title: "Command",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, available: true },
      { href: "/chat", label: "Assistant", icon: MessageSquare, available: true },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { href: "/opportunities", label: "Opportunities", icon: Inbox, available: true },
      { href: "/knowledge", label: "Knowledge Base", icon: BookOpen, available: true },
      { href: "/meta-ads", label: "Meta Ads", icon: Megaphone, available: true },
      // Phase 12 — real read-only Gmail, Drive and Calendar. The page reports
      // its own live connection state, so on a deployment with no Google OAuth
      // client it says so rather than implying access it does not have.
      { href: "/workspace", label: "Google Workspace", icon: Mail, available: true },
    ],
  },
  {
    title: "Capabilities",
    items: [
      { href: "/agents", label: "Agents", icon: Bot, available: true },
      { href: "/automations", label: "Automations", icon: Workflow, available: true },
      { href: "/integrations", label: "Integrations", icon: Plug, available: true },
      // Browser now has a real page. It reports the browser agent's LIVE
      // registration state, so on a deployment with the runtime switched off it
      // says so rather than implying a capability that is not there. That keeps
      // the rule intact: this nav links only to pages that exist.
      { href: "/browser", label: "Browser", icon: Globe, available: true },
    ],
  },
  {
    title: "Control",
    items: [
      { href: "/approvals", label: "Approvals", icon: CheckSquare, available: true },
      { href: "/activity", label: "Activity", icon: Activity, available: true },
    ],
  },
  {
    title: "System",
    items: [
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
