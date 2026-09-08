"use client";

// ---------------------------------------------------------------------------
// V3 — world clocks.
//
// Uses the IANA zone database through `Intl.DateTimeFormat`, so each city is
// converted correctly and daylight saving is handled by the platform rather
// than by an offset table that would silently go wrong twice a year.
//
// Like the local clock, this renders nothing on the server: "now" differs
// between the server render and the client hydration, and printing a time in
// both guarantees a mismatch.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Globe2 } from "lucide-react";
import { WidgetShell } from "./widget-shell";

export interface WorldCity {
  label: string;
  timeZone: string;
}

/** The three the brief names. Kept as data so a preference can extend it. */
export const DEFAULT_CITIES: WorldCity[] = [
  { label: "New York", timeZone: "America/New_York" },
  { label: "London", timeZone: "Europe/London" },
  { label: "Tokyo", timeZone: "Asia/Tokyo" },
];

/**
 * Formats one city.
 *
 * Exported so the conversion is testable without mounting a component and
 * without waiting on a timer.
 */
export function formatInZone(
  date: Date,
  timeZone: string,
  hour12: boolean
): { time: string; day: string } | null {
  try {
    return {
      time: date.toLocaleTimeString(undefined, {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12,
      }),
      day: date.toLocaleDateString(undefined, {
        timeZone,
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
    };
  } catch {
    // An unknown zone must not take the widget down with it.
    return null;
  }
}

export function WorldClockWidget({
  cities = DEFAULT_CITIES,
  hourFormat = "24",
}: {
  cities?: WorldCity[];
  hourFormat?: "12" | "24";
}) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    // Minute resolution is enough here — no seconds are shown, so a faster
    // timer would re-render for nothing.
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <WidgetShell testId="widget-worldclock" title="World" icon={<Globe2 size={13} />}>
      {!now ? (
        <div className="h-16" aria-hidden="true" />
      ) : (
        <ul data-testid="world-clock-list" className="space-y-1.5">
          {cities.map((city) => {
            const parts = formatInZone(now, city.timeZone, hourFormat === "12");
            return (
              <li key={city.timeZone} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[0.68rem] text-sys-text/85">
                  {city.label}
                </span>
                {parts ? (
                  <>
                    <span className="shrink-0 font-mono text-[0.5rem] text-sys-dim">
                      {parts.day}
                    </span>
                    <span className="shrink-0 font-mono text-[0.78rem] text-white [font-variant-numeric:tabular-nums]">
                      {parts.time}
                    </span>
                  </>
                ) : (
                  <span className="shrink-0 text-[0.6rem] text-sys-dim">Unknown zone</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}
