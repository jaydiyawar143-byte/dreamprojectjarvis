"use client";

// ---------------------------------------------------------------------------
// The shared state renderer for every Workspace panel.
//
// WHY THIS IS ONE COMPONENT. Gmail, Drive and Calendar each have to handle the
// same five non-happy outcomes, and they are NOT interchangeable:
//
//   not_connected      -> offer the connect flow
//   needs_reauth       -> offer reconnect, and do NOT offer retry
//   permission_missing -> explain that this SERVICE was not included
//   provider_error     -> offer retry, because a retry might work
//   empty              -> connected and working, with nothing to show
//
// Three copies of that logic would drift, and the way it drifts is by one panel
// offering a Retry button on a revoked grant — which loops forever and teaches
// the user that the button does nothing.
//
// The server decides which state applies; this component only renders it. It
// never infers a state from a message string.
// ---------------------------------------------------------------------------

import { AlertTriangle, Inbox, KeyRound, Loader2, Plug, RefreshCw } from "lucide-react";
import type { GoogleTaskStatus } from "@/lib/api";
import { Button } from "@/components/ui/primitives";

export function PanelLoading({ label }: { label: string }) {
  return (
    <div
      data-testid="workspace-loading"
      className="flex flex-1 items-center justify-center gap-2 py-8 text-xs text-sys-dim"
      role="status"
      aria-live="polite"
    >
      <Loader2 size={13} className="animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function PanelEmpty({ message }: { message: string }) {
  return (
    <div
      data-testid="workspace-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center"
    >
      <Inbox size={18} className="text-sys-dim/70" aria-hidden />
      {/* Connected and working, with nothing to show. Deliberately NOT styled
          as an error: an empty inbox is good news. */}
      <p className="text-xs text-sys-dim">{message}</p>
    </div>
  );
}

export interface PanelProblemProps {
  status: Exclude<GoogleTaskStatus, "ok">;
  message: string;
  requiredAction?: string;
  /** Present only where a retry could plausibly help. */
  onRetry?: () => void;
  onConnect?: () => void;
}

/**
 * The non-ok states.
 *
 * Retry is offered ONLY for `provider_error`. On `needs_reauth` and
 * `permission_missing` a retry is guaranteed to fail — the grant is gone or was
 * never given — so the only control shown is the one that can actually fix it.
 */
export function PanelProblem({
  status,
  message,
  requiredAction,
  onRetry,
  onConnect,
}: PanelProblemProps) {
  const needsGoogle =
    status === "not_connected" || status === "needs_reauth" || status === "permission_missing";

  const tone = needsGoogle ? "text-amber-300" : "text-red-300";
  const Icon =
    status === "needs_reauth" || status === "permission_missing"
      ? KeyRound
      : status === "not_connected"
        ? Plug
        : AlertTriangle;

  return (
    <div
      data-testid={`workspace-${status}`}
      data-status={status}
      className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
    >
      <Icon size={18} className={tone} aria-hidden />
      <p className={`text-xs leading-relaxed ${tone}`}>{message}</p>

      {requiredAction && (
        <p className="max-w-[22rem] text-xs leading-relaxed text-sys-dim">{requiredAction}</p>
      )}

      <div className="flex flex-wrap justify-center gap-2 pt-1">
        {needsGoogle && onConnect && (
          <Button data-testid="workspace-connect" onClick={onConnect}>
            {status === "not_connected" ? "Connect Google" : "Reconnect Google"}
          </Button>
        )}

        {/* Only where it can help. */}
        {status === "provider_error" && onRetry && (
          <Button data-testid="workspace-retry" variant="secondary" onClick={onRetry}>
            <RefreshCw size={11} aria-hidden />
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** "2 min ago" / "in 3 h" — relative, and signed. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";

  const deltaSec = Math.round((then - now) / 1000);
  const future = deltaSec > 0;
  const abs = Math.abs(deltaSec);

  const render = (value: number, unit: string) =>
    future ? `in ${value} ${unit}` : `${value} ${unit} ago`;

  if (abs < 45) return future ? "in a moment" : "just now";
  if (abs < 3600) return render(Math.round(abs / 60), "min");
  if (abs < 86400) return render(Math.round(abs / 3600), "h");
  return render(Math.round(abs / 86400), "d");
}

/** A clock time, in the viewer's own locale and zone. */
export function clockTime(iso: string, allDay = false): string {
  if (allDay) return "All day";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** A day label the viewer recognises: "Today", "Tomorrow", or a date. */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const tomorrow = new Date(now.getTime() + 86400_000);
  if (sameDay(date, now)) return "Today";
  if (sameDay(date, tomorrow)) return "Tomorrow";

  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Bytes as something readable. Null means the provider reported no size. */
export function fileSize(bytes: number | null): string {
  // Google Workspace native files genuinely have no size, which is different
  // from a size of zero and is worth saying differently.
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
