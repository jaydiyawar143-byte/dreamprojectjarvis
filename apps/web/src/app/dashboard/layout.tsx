// ---------------------------------------------------------------------------
// Sprint 4.2 — /dashboard is protected, and wears the persistent shell.
//
// The Sprint 4.1 gate stays on the outside: children do not mount until the
// session has resolved, so nothing inside the shell can fetch unauthenticated.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import { RequireAuth } from "@/components/require-auth";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <DashboardShell>{children}</DashboardShell>
    </RequireAuth>
  );
}
