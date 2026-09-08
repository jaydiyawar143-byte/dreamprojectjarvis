"use client";

// ---------------------------------------------------------------------------
// UI V2 — Dashboard, as a command centre.
//
// The whole page is the command centre: Orb, one input, one status line, and an
// approval panel when something is waiting on a human. Nothing else.
//
// WHAT MOVED, AND WHERE IT WENT. This page previously carried queue counts,
// four Meta KPIs and two charts stacked beneath the Orb. None of that was
// deleted — every panel already exists on the page it belongs to, which is
// where someone goes when they actually want it:
//
//   Pending approvals   -> /approvals
//   Open opportunities  -> /opportunities
//   Documents           -> /knowledge
//   Spend / Impressions / Clicks / ROAS, and both charts
//                       -> /meta-ads   (identical StatPanels and ChartPanels)
//   Conversations       -> /chat
//
// So this is a relocation, not a removal, and the sidebar is the way back to
// all of it. A command centre answers "what should I do now"; a BI dashboard
// answers "what happened". Stacking the second under the first made the screen
// pretend to be one while behaving like the other.
//
// (For the record of what was here before that: the version prior to UI V2 was
// a static mockup — hard-coded agent names, invented confidence percentages, a
// frozen clock. Those numbers came from nowhere and are not coming back.)
// ---------------------------------------------------------------------------

import { CommandCenter } from "@/components/dashboard/command-center";

export default function DashboardPage() {
  return <CommandCenter />;
}
