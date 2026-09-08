"use client";

// ---------------------------------------------------------------------------
// V3 — weather.
//
// The reading comes from the server, which calls Open-Meteo. The browser never
// calls the provider directly: that would send the user's coordinates to a third
// party from their own IP, and would defeat the shared cache.
//
// LOCATION. Geolocation is requested only when the user has no stored location,
// and only through the browser's own permission prompt. A refusal is a normal
// outcome, not an error — the widget then says what to do about it.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { CloudSun, MapPin } from "lucide-react";
import { getWeather, type Live, type WeatherNow } from "@/lib/api";
import { WidgetShell } from "./widget-shell";

/**
 * WMO weather codes to words.
 *
 * Open-Meteo returns the WMO code rather than a description, so the mapping has
 * to live somewhere; grouping the ranges keeps it to a readable table instead of
 * a hundred entries.
 */
export function describeWeatherCode(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code <= 48) return "Fog";
  if (code <= 55) return "Drizzle";
  if (code <= 57) return "Freezing drizzle";
  if (code <= 65) return "Rain";
  if (code <= 67) return "Freezing rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  if (code <= 99) return "Thunderstorm";
  return "Unknown";
}

function timeOnly(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function WeatherWidget({
  location,
  onLocationDetected,
}: {
  location?: { latitude: number; longitude: number; label?: string } | null;
  /** Lets the dashboard persist a detected fix so it is asked for only once. */
  onLocationDetected?: (coords: { latitude: number; longitude: number }) => void;
}) {
  const [live, setLive] = useState<Live<WeatherNow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  // Guards against a late response from a previous location overwriting a newer
  // one — a real race when the user changes location while a fetch is running.
  const requestId = useRef(0);

  const load = useCallback(
    async (coords?: { latitude: number; longitude: number }) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      const res = await getWeather(coords);
      if (id !== requestId.current) return;

      if (res.success && res.data) setLive(res.data);
      else setError(res.error?.message ?? "Could not load weather.");
      setLoading(false);
    },
    []
  );

  useEffect(() => {
    void load(location ?? undefined);
  }, [load, location?.latitude, location?.longitude]);

  /** Asks the browser for a fix. Refusal is expected and handled. */
  const detect = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This browser cannot report a location.");
      return;
    }
    setAsking(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setAsking(false);
        const coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        onLocationDetected?.(coords);
        void load(coords);
      },
      () => {
        setAsking(false);
        setError("Location access was declined. Choose a place in settings instead.");
      },
      { timeout: 10_000, maximumAge: 10 * 60 * 1000 }
    );
  }, [load, onLocationDetected]);

  const w = live?.value;

  return (
    <WidgetShell
      testId="widget-weather"
      title="Weather"
      icon={<CloudSun size={13} />}
      {...(live?.meta ? { meta: live.meta } : {})}
      loading={loading}
      error={error}
      onRetry={() => void load(location ?? undefined)}
      action={
        !location && (
          <button
            type="button"
            data-testid="weather-detect"
            onClick={detect}
            disabled={asking}
            title="Use my location"
            className="sys-focus flex shrink-0 items-center gap-0.5 rounded border border-sys-line px-1 py-0.5 font-mono text-[0.45rem] uppercase tracking-hud text-sys-dim transition-colors hover:text-white disabled:opacity-50"
          >
            <MapPin size={9} aria-hidden="true" />
            <span className="sr-only">{asking ? "Locating" : "Use my location"}</span>
            {asking && <span aria-hidden="true">…</span>}
          </button>
        )
      }
    >
      {w && (
        <div>
          <div className="flex items-baseline gap-2">
            <span
              data-testid="weather-temp"
              className="font-mono text-[1.75rem] leading-none text-white [font-variant-numeric:tabular-nums]"
            >
              {Math.round(w.temperatureC)}°
            </span>
            <span className="text-xs text-sys-text/80">{describeWeatherCode(w.code)}</span>
          </div>

          <p className="mt-1 truncate text-[0.68rem] text-sys-dim">
            {w.location.label ??
              `${w.location.latitude.toFixed(2)}, ${w.location.longitude.toFixed(2)}`}
            {w.feelsLikeC !== null && ` · feels ${Math.round(w.feelsLikeC)}°`}
          </p>

          {/* Only render a figure the provider actually returned. */}
          <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[0.62rem]">
            {w.humidityPct !== null && (
              <>
                <dt className="text-sys-dim">Humidity</dt>
                <dd className="text-right text-sys-text/85">{w.humidityPct}%</dd>
              </>
            )}
            {w.windKph !== null && (
              <>
                <dt className="text-sys-dim">Wind</dt>
                <dd className="text-right text-sys-text/85">{Math.round(w.windKph)} km/h</dd>
              </>
            )}
            {w.precipitationMm !== null && (
              <>
                <dt className="text-sys-dim">Precip.</dt>
                <dd className="text-right text-sys-text/85">{w.precipitationMm} mm</dd>
              </>
            )}
            <dt className="text-sys-dim">Sun</dt>
            <dd className="text-right text-sys-text/85">
              {timeOnly(w.sunrise)} – {timeOnly(w.sunset)}
            </dd>
          </dl>

          {w.forecast.length > 1 && (
            <ul className="mt-2.5 flex gap-2 border-t border-white/[0.06] pt-2">
              {w.forecast.slice(1, 4).map((day) => (
                <li key={day.date} className="min-w-0 flex-1 text-center">
                  <p className="truncate font-mono text-[0.45rem] uppercase tracking-hud text-sys-dim">
                    {new Date(day.date).toLocaleDateString(undefined, { weekday: "short" })}
                  </p>
                  <p className="text-[0.62rem] text-sys-text/85">
                    {Math.round(day.maxC)}°/{Math.round(day.minC)}°
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </WidgetShell>
  );
}
