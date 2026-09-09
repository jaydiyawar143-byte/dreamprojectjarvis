// ---------------------------------------------------------------------------
// Preview route for the installed scroll-animation hero.
//
// Deliberately its own top-level route with no layout of its own: it does not
// sit under RequireAuth or DashboardShell, so previewing it cannot disturb the
// authenticated app, and the component gets the full viewport it pins against.
//
// This is the `demo.tsx` from the component's install instructions, placed
// where it is actually reachable rather than left as an unrouted file.
// ---------------------------------------------------------------------------

import PublishedComponent from "@/components/ui/home-hero-landing-scroll-animation";

export default function Demo() {
  return <PublishedComponent />;
}
