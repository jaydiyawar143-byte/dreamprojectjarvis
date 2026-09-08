// ---------------------------------------------------------------------------
// V3 — weather, from Open-Meteo.
//
// WHY OPEN-METEO. It is a real forecast API with no key, it permits
// non-commercial use without registration, and it publishes the observation
// time for every value. That last part is what makes honest freshness possible:
// the widget reports when the measurement was taken, not when we fetched it.
//
// No key means no secret to leak, but the call still runs SERVER-side. A browser
// calling a weather API directly would leak the user's coordinates to a third
// party from their own IP, and would make the response impossible to cache
// across the deployment.
// ---------------------------------------------------------------------------

import { TtlCache, fetchJson, meta, unavailable, type ProviderResult } from "./freshness.js";

const SOURCE = "Open-Meteo";
const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/**
 * Weather changes slowly; the model itself updates hourly. Fifteen minutes of
 * cache is invisible to a user and keeps us well inside fair use.
 */
const CACHE_TTL_MS = 15 * 60 * 1000;

/** An observation older than an hour is DELAYED; older than three, STALE. */
const THRESHOLDS = { liveWithin: 3600, delayedWithin: 3 * 3600 };

export interface WeatherNow {
  temperatureC: number;
  feelsLikeC: number | null;
  humidityPct: number | null;
  windKph: number | null;
  precipitationMm: number | null;
  /** WMO weather code, mapped to text by the client. */
  code: number;
  isDay: boolean;
  sunrise: string | null;
  sunset: string | null;
  location: { latitude: number; longitude: number; timezone: string; label?: string };
  forecast: Array<{ date: string; minC: number; maxC: number; code: number }>;
}

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  current?: {
    time: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    precipitation?: number;
    weather_code?: number;
    is_day?: number;
  };
  daily?: {
    time?: string[];
    temperature_2m_min?: number[];
    temperature_2m_max?: number[];
    weather_code?: number[];
    sunrise?: string[];
    sunset?: string[];
  };
}

const cache = new TtlCache<{ payload: OpenMeteoResponse; label?: string }>(CACHE_TTL_MS, 64);

/** Rounded so a moving GPS fix does not defeat the cache on every request. */
function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

function shape(payload: OpenMeteoResponse, label?: string): WeatherNow | null {
  const current = payload.current;
  if (!current || typeof current.temperature_2m !== "number") return null;

  const daily = payload.daily ?? {};
  const days = daily.time ?? [];

  return {
    temperatureC: current.temperature_2m,
    feelsLikeC: current.apparent_temperature ?? null,
    humidityPct: current.relative_humidity_2m ?? null,
    windKph: current.wind_speed_10m ?? null,
    precipitationMm: current.precipitation ?? null,
    code: current.weather_code ?? 0,
    isDay: current.is_day !== 0,
    sunrise: daily.sunrise?.[0] ?? null,
    sunset: daily.sunset?.[0] ?? null,
    location: {
      latitude: payload.latitude,
      longitude: payload.longitude,
      timezone: payload.timezone,
      ...(label ? { label } : {}),
    },
    forecast: days.slice(0, 5).map((date, i) => ({
      date,
      minC: daily.temperature_2m_min?.[i] ?? 0,
      maxC: daily.temperature_2m_max?.[i] ?? 0,
      code: daily.weather_code?.[i] ?? 0,
    })),
  };
}

export async function getWeather(
  latitude: number,
  longitude: number,
  label?: string
): Promise<ProviderResult<WeatherNow>> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return unavailable(SOURCE, "No location has been set for this widget.");
  }

  const key = cacheKey(latitude, longitude);
  const hit = cache.get(key);

  // A fresh cache entry is served without touching upstream. `observedAt` is
  // the ORIGINAL observation time, so age keeps counting up honestly rather
  // than resetting when we serve from cache.
  if (hit && !hit.expired) {
    const shaped = shape(hit.value.payload, hit.value.label ?? label);
    if (shaped) return { data: shaped, meta: meta(hit.observedAt, SOURCE, THRESHOLDS, { cached: true }) };
  }

  const url =
    `${ENDPOINT}?latitude=${latitude}&longitude=${longitude}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation,weather_code,is_day" +
    "&daily=temperature_2m_min,temperature_2m_max,weather_code,sunrise,sunset" +
    "&timezone=auto&forecast_days=5";

  try {
    const payload = await fetchJson<OpenMeteoResponse>(url, { timeoutMs: 8000 });
    const shaped = shape(payload, label);
    if (!shaped) return unavailable(SOURCE, "The weather service returned no current reading.");

    // The observation time comes from the provider, not from our clock.
    const observedAt = payload.current?.time ? new Date(payload.current.time) : new Date();
    cache.set(key, { payload, ...(label ? { label } : {}) }, observedAt);
    return { data: shaped, meta: meta(observedAt, SOURCE, THRESHOLDS) };
  } catch {
    // Upstream failed. If we still hold a previous reading, serve it and let
    // the freshness classification say how old it is — that is strictly more
    // useful than a blank card, and it cannot be mistaken for live.
    if (hit) {
      const shaped = shape(hit.value.payload, hit.value.label ?? label);
      if (shaped) return { data: shaped, meta: meta(hit.observedAt, SOURCE, THRESHOLDS, { cached: true }) };
    }
    return unavailable(SOURCE, "The weather service could not be reached.");
  }
}

/** Exposed for tests so a suite can start from a known empty cache. */
export function __resetWeatherCache(): void {
  cache.clear();
}
