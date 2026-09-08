"use client";

// ---------------------------------------------------------------------------
// V3 — the frame every live widget renders inside.
//
// It exists so the honesty rules are structural rather than per-widget: a
// widget author gets the freshness badge, the loading state, the unavailable
// state and the error state for free, and cannot forget them. There is no path
// through this component that renders a value without also rendering how
// current it is.
//
// The badge is deliberately not decorative. LIVE is quiet, DELAYED and STALE
// are visible, UNAVAILABLE replaces the content entirely with the provider's
// stated reason — because a card showing dashes next to a green dot is exactly
// the failure mode this whole design is trying to avoid.
// ---------------------------------------------------------------------------

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { Freshness, ProviderMeta } from "@/lib/api";

const BADGE: Record<Freshness, { label: string; className: string }> = {
  LIVE: { label: "Live", className: "border-emerald-400/35 bg-emerald-400/10 text-emerald-300/90" },
  DELAYED: { label: "Delayed", className: "border-amber-400/35 bg-amber-400/10 text-amber-300/90" },
  STALE: { label: "Stale", className: "border-orange-400/35 bg-orange-400/10 text-orange-300/90" },
  UNAVAILABLE: { label: "Unavailable", className: "border-sys-line bg-white/[0.03] text-sys-dim" },
};

/** "just now" / "4 min ago" — how old the DATA is, not when we fetched it. */
export function formatAge(seconds: number): string {
  if (seconds < 45) return "just now";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function FreshnessBadge({ meta }: { meta: ProviderMeta }) {
  const badge = BADGE[meta.freshness];

  // Age is recomputed on a timer so a card left open does not keep claiming
  // "just now" for a value that is now ten minutes old.
  const [age, setAge] = useState(meta.ageSeconds);
  useEffect(() => {
    setAge(meta.ageSeconds);
    const started = Date.now();
    const timer = setInterval(
      () => setAge(meta.ageSeconds + Math.round((Date.now() - started) / 1000)),
      15_000
    );
    return () => clearInterval(timer);
  }, [meta.ageSeconds, meta.observedAt]);

  return (
    <span
      data-testid="freshness-badge"
      data-freshness={meta.freshness}
      title={`${meta.source} · observed ${new Date(meta.observedAt).toLocaleString()}`}
      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[0.45rem] uppercase tracking-hud ${badge.className}`}
    >
      {badge.label}
      {meta.freshness !== "UNAVAILABLE" && ` · ${formatAge(age)}`}
    </span>
  );
}

export interface WidgetShellProps {
  title: string;
  icon?: ReactNode;
  /** Absent while the first load is in flight. */
  meta?: ProviderMeta;
  loading?: boolean;
  /** A transport failure, as distinct from a provider reporting UNAVAILABLE. */
  error?: string | null;
  onRetry?: () => void;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
  /** Test hook, so a suite can find one widget among many. */
  testId?: string;
}

export function WidgetShell({
  title,
  icon,
  meta,
  loading = false,
  error = null,
  onRetry,
  action,
  className = "",
  children,
  testId,
}: WidgetShellProps) {
  const unavailable = meta?.freshness === "UNAVAILABLE";

  return (
    <section
      data-testid={testId}
      aria-label={title}
      className={`glass-panel glass-edge relative flex min-w-0 flex-col rounded-xl p-3.5 ${className}`}
    >
      <header className="mb-2.5 flex items-center gap-2">
        {icon && (
          <span aria-hidden="true" className="shrink-0 text-sys-dim">
            {icon}
          </span>
        )}
        <h3 className="min-w-[3.5rem] flex-1 truncate font-mono text-[0.55rem] uppercase tracking-hud text-sys-dim">
          {title}
        </h3>
        {action}
        {meta && <FreshnessBadge meta={meta} />}
      </header>

      {loading && !meta && (
        <div
          data-testid="widget-loading"
          className="flex flex-1 items-center gap-2 text-sys-dim"
          role="status"
        >
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          <span className="text-xs">Loading…</span>
        </div>
      )}

      {!loading && error && (
        <div data-testid="widget-error" className="flex flex-1 flex-col justify-center gap-2">
          <p className="flex items-start gap-1.5 text-xs text-red-300/90">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="sys-focus self-start rounded border border-sys-line px-2 py-1 font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/*
        UNAVAILABLE replaces the content rather than sitting beside it. Rendering
        empty rows under an "Unavailable" badge is how a reader ends up believing
        a dash is a measurement.
      */}
      {!loading && !error && unavailable && (
        <div data-testid="widget-unavailable" className="flex flex-1 items-center">
          <p className="text-xs leading-relaxed text-sys-dim">
            {meta?.reason ?? "Data unavailable."}
          </p>
        </div>
      )}

      {!loading && !error && !unavailable && (
        // `flex-1` would stretch short content down a tall grid cell; the
        // content should sit at the top and let the cell end where it ends.
        <div className="min-w-0">{children}</div>
      )}
    </section>
  );
}
