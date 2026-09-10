// ---------------------------------------------------------------------------
// Sprint 4.2 — /dashboard is protected, and wears the persistent shell.
//
// The Sprint 4.1 gate stays on the outside: children do not mount until the
// session has resolved, so nothing inside the shell can fetch unauthenticated.
//
// V3.1 — and it is the ONE route that wears the shell in fullscreen. The
// command centre is sized to the viewport so the page never scrolls; every
// other route keeps the ordinary document behaviour. See dashboard-shell.tsx.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import { RequireAuth } from "@/components/require-auth";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <DashboardShell fullscreen>{children}</DashboardShell>
    </RequireAuth>
  );
}
