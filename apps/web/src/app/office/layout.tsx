// VO-1 — the Virtual Office keeps the same authenticated shell as every other
// dashboard route. It is deliberately NOT `fullscreen`: only /dashboard owns a
// no-scroll command surface, and the office is a document that can run past the
// fold, so `<main>` keeps its internal scroll region.
import type { ReactNode } from "react";
import { RequireAuth } from "@/components/require-auth";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

export default function OfficeLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <DashboardShell>{children}</DashboardShell>
    </RequireAuth>
  );
}
