// UI V2 — health and readiness, read from the unauthenticated /health routes plus /dashboard/status.
import type { ReactNode } from "react";
import { RequireAuth } from "@/components/require-auth";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

export default function SystemLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <DashboardShell>{children}</DashboardShell>
    </RequireAuth>
  );
}
