"use client";

// ---------------------------------------------------------------------------
// V3 — clock.
//
// The only widget with no provider: the time comes from the machine the browser
// is running on, which is the correct source and needs no network call. So it
// carries no freshness badge — a badge would imply an upstream that could be
// stale, and there isn't one.
//
// HYDRATION. Next renders this on the server too, where "now" is a different
// instant. Rendering a time during SSR guarantees a mismatch, so the first paint
// is deliberately empty and the clock starts on mount.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import { WidgetShell } from "./widget-shell";

export type ClockMode = "DIGITAL" | "ANALOG";
export type HourFormat = "12" | "24";

/** Hands for an analog face. Exported so the geometry is testable. */
export function handAngles(date: Date): { hour: number; minute: number; second: number } {
  const seconds = date.getSeconds();
  const minutes = date.getMinutes() + seconds / 60;
  // Modulo 12 then × 30°, plus the fractional hour, so the hour hand creeps
  // between numerals instead of jumping.
  const hours = (date.getHours() % 12) + minutes / 60;
  return { hour: hours * 30, minute: minutes * 6, second: seconds * 6 };
}

function AnalogFace({ date }: { date: Date }) {
  const { hour, minute, second } = handAngles(date);
  return (
    <svg viewBox="0 0 100 100" className="mx-auto h-[5.5rem] w-[5.5rem]" role="img" aria-hidden="true">
      <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1.5" />
      {/* Hour ticks. Twelve marks read as a clock; sixty read as noise. */}
      {Array.from({ length: 12 }).map((_, i) => (
        <line
          key={i}
          x1="50"
          y1="9"
          x2="50"
          y2={i % 3 === 0 ? 16 : 13}
          stroke={i % 3 === 0 ? "rgba(62,224,242,0.55)" : "rgba(255,255,255,0.18)"}
          strokeWidth={i % 3 === 0 ? 2 : 1}
          transform={`rotate(${i * 30} 50 50)`}
          strokeLinecap="round"
        />
      ))}
      <line x1="50" y1="50" x2="50" y2="28" stroke="rgba(255,255,255,0.9)" strokeWidth="3.2" strokeLinecap="round" transform={`rotate(${hour} 50 50)`} />
      <line x1="50" y1="50" x2="50" y2="19" stroke="rgba(255,255,255,0.75)" strokeWidth="2.2" strokeLinecap="round" transform={`rotate(${minute} 50 50)`} />
      <line x1="50" y1="56" x2="50" y2="15" stroke="rgba(62,224,242,0.9)" strokeWidth="1" strokeLinecap="round" transform={`rotate(${second} 50 50)`} />
      <circle cx="50" cy="50" r="2.4" fill="rgba(62,224,242,0.95)" />
    </svg>
  );
}

export function ClockWidget({
  mode = "DIGITAL",
  hourFormat = "24",
  onToggleMode,
}: {
  mode?: ClockMode;
  hourFormat?: HourFormat;
  onToggleMode?: (next: ClockMode) => void;
}) {
  // `null` until mounted — see the hydration note above.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    // One second, because the analog face has a second hand and the digital
    // face shows seconds. Anything slower visibly stutters.
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const timeZone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";

  return (
    <WidgetShell
      testId="widget-clock"
      title="Time"
      icon={<Clock3 size={13} />}
      action={
        onToggleMode && (
          <button
            type="button"
            data-testid="clock-mode-toggle"
            onClick={() => onToggleMode(mode === "DIGITAL" ? "ANALOG" : "DIGITAL")}
            aria-label={`Switch to ${mode === "DIGITAL" ? "analog" : "digital"} clock`}
            className="sys-focus rounded border border-sys-line px-1.5 py-0.5 font-mono text-xs uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
          >
            {mode === "DIGITAL" ? "Analog" : "Digital"}
          </button>
        )
      }
    >
      {!now ? (
        // Reserves the same height the clock will occupy, so mounting does not
        // shift the widgets below it.
        <div className="h-[5.5rem]" aria-hidden="true" />
      ) : mode === "ANALOG" ? (
        <div>
          <AnalogFace date={now} />
          <p data-testid="clock-date" className="mt-1.5 text-center text-xs text-sys-dim">
            {now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
          </p>
        </div>
      ) : (
        <div className="flex h-[5.5rem] flex-col justify-center">
          <p
            data-testid="clock-time"
            // Tabular figures stop the whole line jittering as digits change.
            className="font-mono text-[1.75rem] leading-none tracking-tight text-white [font-variant-numeric:tabular-nums]"
          >
            {now.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: hourFormat === "12",
            })}
          </p>
          <p data-testid="clock-date" className="mt-1.5 text-xs text-sys-dim">
            {now.toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
      )}

      {timeZone && (
        <p className="mt-1 font-mono text-xs uppercase tracking-hud text-sys-dim">
          {timeZone}
        </p>
      )}
    </WidgetShell>
  );
}
