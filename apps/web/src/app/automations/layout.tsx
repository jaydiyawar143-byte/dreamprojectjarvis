// UI V2 — n8n workflows and executions, read-only.
import type { ReactNode } from "react";
import { RequireAuth } from "@/components/require-auth";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

export default function AutomationsLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <DashboardShell>{children}</DashboardShell>
    </RequireAuth>
  );
}
