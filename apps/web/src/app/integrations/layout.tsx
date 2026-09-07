// UI V2 — Google, WhatsApp and n8n connection state.
import type { ReactNode } from "react";
import { RequireAuth } from "@/components/require-auth";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

export default function IntegrationsLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <DashboardShell>{children}</DashboardShell>
    </RequireAuth>
  );
}
