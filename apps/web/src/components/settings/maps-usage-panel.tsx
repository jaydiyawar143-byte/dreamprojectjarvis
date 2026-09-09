"use client";

// ---------------------------------------------------------------------------
// Google Maps monthly usage, in Settings → Connections.
//
// Three rules this panel follows, all of them about not misleading an operator:
//
//   1. IT NEVER SHOWS A KEY. There is nothing here but counts — the endpoint
//      behind it does not return a key, and could not.
//
//   2. IT NEVER SHOWS A ZERO IT DOES NOT KNOW. If the counter cannot be read,
//      it says so. "0 requests" and "we could not read the counter" look
//      identical on a progress bar and mean opposite things.
//
//   3. IT SAYS WHAT THE NUMBER IS NOT. Browser map loads are billed by Google
//      and never reach the server, so this figure is not the bill. Stating that
//      is the difference between a useful guard and a false sense of security.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { getMapsUsage, type MapsUsage } from "@/lib/api";

/** Bar and text colour per band. Matches the server's own thresholds. */
function toneFor(level: MapsUsage["level"]): { bar: string; text: string; label: string } {
  switch (level) {
    case "BLOCKED":
      return { bar: "bg-sys-danger", text: "text-sys-danger", label: "Blocked" };
    case "CRITICAL":
      return { bar: "bg-sys-danger", text: "text-sys-danger", label: "Critical" };
    case "STRONG_WARNING":
      return { bar: "bg-amber-400", text: "text-amber-300", label: "Warning" };
    case "WARNING":
      return { bar: "bg-amber-400/80", text: "text-amber-300/90", label: "Warning" };
    default:
      return { bar: "bg-sys-cyan", text: "text-sys-dim", label: "OK" };
  }
}

export function MapsUsagePanel() {
  const [usage, setUsage] = useState<MapsUsage | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMapsUsage();
    setLoading(false);

    if (res.success && res.data?.available) {
      setUsage(res.data);
      setUnavailable(null);
      return;
    }
    setUsage(null);
    // Narrowed on the discriminant rather than optional-chained, so a future
    // shape change fails to compile instead of silently showing the fallback.
    const reason =
      res.data && res.data.available === false ? res.data.reason : undefined;
    setUnavailable(reason ?? res.error?.message ?? "Usage figures could not be read.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <p data-testid="maps-usage-loading" className="text-xs text-sys-dim">
        Reading usage…
      </p>
    );
  }

  if (!usage) {
    return (
      <div data-testid="maps-usage-unavailable" className="space-y-1.5">
        {/* Not a zero. An unreadable counter is its own state. */}
        <p className="text-xs text-amber-300/90">{unavailable}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="sys-focus rounded border border-sys-line px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
        >
          Retry
        </button>
      </div>
    );
  }

  const tone = toneFor(usage.level);
  // Clamped for the BAR only — the number beside it is always the real one, so
  // a limit lowered below current usage still reads honestly as e.g. 143%.
  const barWidth = Math.min(100, Math.max(0, usage.percentUsed));

  return (
    <div data-testid="maps-usage" data-level={usage.level} className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-xs uppercase tracking-hud text-sys-dim">
          Monthly usage · {usage.period}
        </p>
        <p className={`font-mono text-xs uppercase tracking-hud ${tone.text}`}>{tone.label}</p>
      </div>

      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-lg leading-none text-white [font-variant-numeric:tabular-nums]">
            {usage.used.toLocaleString()}
          </span>
          <span className="text-xs text-sys-dim">
            of {usage.limit.toLocaleString()} requests
          </span>
          <span className={`ml-auto font-mono text-sm ${tone.text}`}>{usage.percentUsed}%</span>
        </div>

        <div
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]"
          role="progressbar"
          aria-valuenow={usage.percentUsed}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Google Maps monthly usage"
        >
          <div className={`h-full ${tone.bar}`} style={{ width: `${barWidth}%` }} />
        </div>
      </div>

      {usage.level !== "OK" && (
        <p data-testid="maps-usage-message" className={`text-xs ${tone.text}`}>
          {usage.message}
        </p>
      )}

      {usage.byService.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {usage.byService.map((row) => (
            <div key={row.service} className="flex justify-between gap-2">
              <dt className="truncate text-sys-dim">{row.service.replace(/_/g, " ")}</dt>
              <dd className="font-mono text-sys-text/85 [font-variant-numeric:tabular-nums]">
                {row.count.toLocaleString()}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-sys-dim">
        <span>Your usage: {usage.yourUsage.toLocaleString()}</span>
        {usage.lastRequestAt && (
          <span>Last request: {new Date(usage.lastRequestAt).toLocaleString()}</span>
        )}
      </div>

      {/* Admin-only. Absent from the payload entirely for non-admins, so this
          is not a client-side hide over data that was sent anyway. */}
      {usage.byUser && usage.byUser.length > 0 && (
        <details className="text-xs">
          <summary className="sys-focus cursor-pointer text-sys-dim hover:text-white">
            Top users ({usage.byUser.length})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {usage.byUser.map((row) => (
              <li key={row.userId} className="flex justify-between gap-2">
                <span className="truncate font-mono text-sys-dim">{row.userId}</span>
                <span className="font-mono text-sys-text/85 [font-variant-numeric:tabular-nums]">
                  {row.count.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="border-t border-sys-line pt-2 text-xs leading-relaxed text-sys-dim/80">
        {usage.note}
      </p>
    </div>
  );
}
