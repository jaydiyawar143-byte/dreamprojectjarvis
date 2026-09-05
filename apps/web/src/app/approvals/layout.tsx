// Sprint 4.1 — /approvals is a protected route. The gate lives in the layout so
// the page component is untouched and its data fetch cannot run before the
// session has resolved.
import type { ReactNode } from "react";
import { RequireAuth } from "@/components/require-auth";

export default function ApprovalsLayout({ children }: { children: ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
