// Sprint 4.1 — /opportunities and /opportunities/[id] are protected routes.
// One layout covers both: a nested route inherits its parent segment's layout,
// so the detail page is gated by the same contract as the list.
import type { ReactNode } from "react";
import { RequireAuth } from "@/components/require-auth";

export default function OpportunitiesLayout({ children }: { children: ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
