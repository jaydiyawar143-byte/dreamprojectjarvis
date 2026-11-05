"use client";

// ---------------------------------------------------------------------------
// VO-2 — the office's live-connection indicator.
//
// It exists so the page never presents a stale floor plan as current. The words
// follow the socket's real state: `live` only while connected, `reconnecting`
// while the client is retrying, `offline` once it has stopped, and
// `unauthenticated` when there is no token to connect with.
// ---------------------------------------------------------------------------

import { StatusDot } from "@/components/ui/primitives";
import type { OfficeStreamStatus as StreamStatus } from "@/lib/use-office-stream";

const COPY: Record<
  StreamStatus,
  { tone: "neutral" | "info" | "ok" | "warn" | "danger"; label: string; meaning: string }
> = {
  connecting: {
    tone: "info",
    label: "Connecting",
    meaning: "Opening the live feed. The figures below are from the initial read.",
  },
  live: {
    tone: "ok",
    label: "Live",
    meaning: "New agent, task and audit activity is arriving as it happens.",
  },
  reconnecting: {
    tone: "warn",
    label: "Reconnecting",
    meaning:
      "The live feed dropped. The floor shows the last readings and will re-read them when the connection returns.",
  },
  offline: {
    tone: "danger",
    label: "Offline",
    meaning:
      "The live feed is not connected. What you see is not current — use Refresh to re-read it.",
  },
  unauthenticated: {
    tone: "neutral",
    label: "Not signed in",
    meaning: "Live updates need an authenticated session.",
  },
};

export function OfficeStreamStatus({ status }: { status: StreamStatus }) {
  const copy = COPY[status];

  return (
    <div
      data-testid="office-stream-status"
      data-status={status}
      className="rounded border border-sys-line/60 bg-sys-edge/10 px-3 py-2"
    >
      <StatusDot tone={copy.tone} label={copy.label} />
      <p className="mt-1 text-xs leading-snug text-sys-dim">{copy.meaning}</p>
    </div>
  );
}
