"use client";

// ---------------------------------------------------------------------------
// Sprint 4.1 — Protected route gate.
//
// Holds a protected subtree back until the session has actually resolved, so
// no authenticated request is ever issued in an unresolved state. Children are
// not rendered while the session is being validated, which means their effects
// cannot run early — the ordering problem is removed rather than worked around.
//
// Applied through a route `layout.tsx` rather than inside each page, so the
// page components themselves stay untouched and remain renderable on their own
// in tests.
//
// This is a client-side convenience only. It decides what to *show*; it grants
// nothing. Every protected endpoint still authenticates the bearer token
// server-side, and removing this component would not expose any data.
// ---------------------------------------------------------------------------

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

/** Shown while the stored session is being validated. */
function SessionPending() {
  return (
    <div
      data-testid="session-pending"
      className="flex min-h-screen items-center justify-center bg-gray-950"
    >
      <p className="text-sm text-gray-400">Restoring your session…</p>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { authenticated, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // `replace`, not `push`: a route the user could not open should not become
    // a back-button destination.
    if (!loading && !authenticated) {
      router.replace("/login");
    }
  }, [loading, authenticated, router]);

  if (loading) return <SessionPending />;

  // The redirect above is in flight. Rendering nothing keeps the protected
  // subtree unmounted, so nothing fetches on the way out.
  if (!authenticated) return null;

  return <>{children}</>;
}
