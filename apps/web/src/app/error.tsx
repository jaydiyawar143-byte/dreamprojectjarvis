"use client";

// ---------------------------------------------------------------------------
// UI V2 — the route error boundary.
//
// Next renders this when a segment throws during render. It deliberately shows
// `error.digest` and NOT `error.message`: in production Next replaces the
// message with a generic string anyway, and in development the raw message can
// carry a stack or a connection string. The digest is the handle that ties this
// screen to the server log entry.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import { ErrorState } from "@/components/dashboard/states";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("route error", { digest: error.digest });
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <ErrorState
        title="Something went wrong on this page"
        message={
          error.digest
            ? `The page could not be rendered. Reference: ${error.digest}`
            : "The page could not be rendered."
        }
        onRetry={reset}
        retryLabel="Try again"
      />
    </div>
  );
}
