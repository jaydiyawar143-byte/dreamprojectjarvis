// ---------------------------------------------------------------------------
// V3 — Google Geocoding, Places and Routes.
//
// Server-side only. The key used here never reaches a browser, which is the
// whole reason these calls are proxied rather than made from the page: a
// geocoding key in client JavaScript is a billable credential anyone can lift.
//
// WHY OSM IS NOT DELETED. When no Google server key is configured, the existing
// Nominatim/OSRM path still answers — see geo-provider.ts. That is a deliberate
// choice: throwing away working geocoding to show "unavailable" would be worse
// for the user, and every response reports WHICH provider answered in
// `meta.source`, so nothing is passed off as Google that was not.
//
// The interactive MAP is a different matter: without a browser key there is no
// Google map to draw, and the widget says exactly that rather than substituting
// a hand-drawn one.
// ---------------------------------------------------------------------------

import { TtlCache, fetchJson, meta, unavailable, type ProviderResult } from "./freshness.js";
import type { Place, RouteResult } from "./geo-provider.js";

const SOURCE = "Google Maps Platform";

const GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const PLACES_ENDPOINT = "https://maps.googleapis.com/maps/api/place/textsearch/json";
const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

/** Google's terms permit caching geocodes for up to 30 days; a day is plenty. */
const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const ROUTE_TTL_MS = 60 * 60 * 1000;

/** Reference data rather than an observation, so age is not a quality signal. */
const REFERENCE_THRESHOLDS = { liveWithin: 7 * 24 * 3600, delayedWithin: 30 * 24 * 3600 };

export const GOOGLE_ATTRIBUTION = "Map data ©2026 Google";

export type TravelMode = "DRIVE" | "WALK" | "BICYCLE" | "TRANSIT";

/** Maps a spoken travel mode onto the Routes API enum. */
export function normalizeTravelMode(input: string | undefined): TravelMode {
  switch ((input ?? "").trim().toLowerCase()) {
    case "walk":
    case "walking":
    case "foot":
      return "WALK";
    case "cycle":
    case "cycling":
    case "bike":
    case "bicycle":
      return "BICYCLE";
    case "transit":
    case "bus":
    case "train":
    case "public":
      return "TRANSIT";
    default:
      // Driving is the sensible default: it is what "how far is X from Y"
      // almost always means, and it is supported everywhere Routes is.
      return "DRIVE";
  }
}

const geoCache = new TtlCache<Place[]>(GEO_TTL_MS, 256);
const routeCache = new TtlCache<RouteResult>(ROUTE_TTL_MS, 128);

interface GoogleGeocodeResponse {
  status: string;
  error_message?: string;
  results?: Array<{
    formatted_address: string;
    geometry?: { location?: { lat: number; lng: number } };
    types?: string[];
  }>;
}

interface GooglePlacesResponse {
  status: string;
  error_message?: string;
  results?: Array<{
    name?: string;
    formatted_address?: string;
    geometry?: { location?: { lat: number; lng: number } };
    types?: string[];
  }>;
}

/**
 * Turns a Google status into a message worth showing.
 *
 * `error_message` is deliberately NOT forwarded: on a misconfigured key Google
 * returns text that can echo the key or the referrer, and that would end up on
 * screen and in logs.
 */
function describeStatus(status: string): string {
  switch (status) {
    case "ZERO_RESULTS":
      return "Google found no match for that.";
    case "OVER_QUERY_LIMIT":
      return "The Google Maps quota for this project has been exceeded.";
    case "REQUEST_DENIED":
      return "Google refused the request. Check that the server key is valid and the Geocoding and Routes APIs are enabled for it.";
    case "INVALID_REQUEST":
      return "That search could not be understood.";
    default:
      return "Google Maps could not answer that request.";
  }
}

function shapePlace(
  address: string,
  location: { lat: number; lng: number } | undefined,
  type?: string
): Place | null {
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return null;
  return {
    name: address,
    latitude: location.lat,
    longitude: location.lng,
    ...(type ? { type } : {}),
    attribution: GOOGLE_ATTRIBUTION,
  };
}

/** Address → coordinates. */
export async function googleGeocode(
  query: string,
  serverKey: string,
  limit = 5
): Promise<ProviderResult<Place[]>> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return unavailable(SOURCE, "Enter at least two characters to search for a place.");
  }

  const key = `g:geo:${trimmed.toLowerCase()}`;
  const hit = geoCache.get(key);
  if (hit && !hit.expired) {
    return { data: hit.value.slice(0, limit), meta: meta(hit.observedAt, SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  try {
    const payload = await fetchJson<GoogleGeocodeResponse>(
      `${GEOCODE_ENDPOINT}?address=${encodeURIComponent(trimmed)}&key=${encodeURIComponent(serverKey)}`,
      { timeoutMs: 9000 }
    );

    if (payload.status !== "OK" || !payload.results?.length) {
      return unavailable(SOURCE, describeStatus(payload.status));
    }

    const places = payload.results
      .map((r) => shapePlace(r.formatted_address, r.geometry?.location, r.types?.[0]))
      .filter((p): p is Place => p !== null);

    if (places.length === 0) return unavailable(SOURCE, "Google returned no usable coordinates.");

    const observedAt = new Date();
    geoCache.set(key, places, observedAt);
    return { data: places.slice(0, limit), meta: meta(observedAt, SOURCE, REFERENCE_THRESHOLDS) };
  } catch {
    if (hit) {
      return { data: hit.value.slice(0, limit), meta: meta(hit.observedAt, SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
    }
    return unavailable(SOURCE, "Google Maps could not be reached.");
  }
}

/**
 * Coordinates → a human address.
 *
 * Used to label the current-location marker. The coordinates are NOT cached
 * under a precise key: they are rounded first, which both makes the cache
 * useful and avoids keeping a precise per-user trail in process memory.
 */
export async function googleReverseGeocode(
  latitude: number,
  longitude: number,
  serverKey: string
): Promise<ProviderResult<Place>> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return unavailable(SOURCE, "A valid location is required.");
  }

  const key = `g:rev:${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const hit = geoCache.get(key);
  if (hit?.value[0] && !hit.expired) {
    return { data: hit.value[0], meta: meta(hit.observedAt, SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  try {
    const payload = await fetchJson<GoogleGeocodeResponse>(
      `${GEOCODE_ENDPOINT}?latlng=${latitude},${longitude}&key=${encodeURIComponent(serverKey)}`,
      { timeoutMs: 9000 }
    );

    if (payload.status !== "OK" || !payload.results?.length) {
      return unavailable(SOURCE, describeStatus(payload.status));
    }

    // Google returns most-specific first; a locality-level answer is what a
    // person means by "where am I", not a street address.
    const preferred =
      payload.results.find((r) => r.types?.includes("locality")) ?? payload.results[0]!;

    const place = shapePlace(preferred.formatted_address, preferred.geometry?.location, "current");
    if (!place) return unavailable(SOURCE, "Google returned no usable address.");

    const observedAt = new Date();
    geoCache.set(key, [place], observedAt);
    return { data: place, meta: meta(observedAt, SOURCE, REFERENCE_THRESHOLDS) };
  } catch {
    return unavailable(SOURCE, "Google Maps could not be reached.");
  }
}

/** Text place search — restaurants, landmarks, businesses. */
export async function googlePlaceSearch(
  query: string,
  serverKey: string,
  near?: { latitude: number; longitude: number },
  limit = 8
): Promise<ProviderResult<Place[]>> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return unavailable(SOURCE, "Enter at least two characters to search.");

  const locationBias = near ? `&location=${near.latitude},${near.longitude}&radius=20000` : "";
  const key = `g:place:${trimmed.toLowerCase()}:${near ? `${near.latitude.toFixed(2)},${near.longitude.toFixed(2)}` : "any"}`;

  const hit = geoCache.get(key);
  if (hit && !hit.expired) {
    return { data: hit.value.slice(0, limit), meta: meta(hit.observedAt, SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  try {
    const payload = await fetchJson<GooglePlacesResponse>(
      `${PLACES_ENDPOINT}?query=${encodeURIComponent(trimmed)}${locationBias}&key=${encodeURIComponent(serverKey)}`,
      { timeoutMs: 9000 }
    );

    if (payload.status !== "OK" || !payload.results?.length) {
      return unavailable(SOURCE, describeStatus(payload.status));
    }

    const places = payload.results
      .map((r) =>
        shapePlace(
          r.name ? `${r.name}${r.formatted_address ? ` — ${r.formatted_address}` : ""}` : r.formatted_address ?? "",
          r.geometry?.location,
          r.types?.[0]
        )
      )
      .filter((p): p is Place => p !== null && p.name.length > 0);

    if (places.length === 0) return unavailable(SOURCE, "Google returned no usable places.");

    const observedAt = new Date();
    geoCache.set(key, places, observedAt);
    return { data: places.slice(0, limit), meta: meta(observedAt, SOURCE, REFERENCE_THRESHOLDS) };
  } catch {
    return unavailable(SOURCE, "Google Maps could not be reached.");
  }
}

interface RoutesApiResponse {
  routes?: Array<{
    distanceMeters?: number;
    duration?: string;
    polyline?: { encodedPolyline?: string };
  }>;
  error?: { status?: string; message?: string };
}

/**
 * Decodes Google's encoded polyline into coordinate pairs.
 *
 * Implemented rather than pulled from a package: it is the standard algorithm
 * in about twenty lines, and a dependency for that is not worth the supply
 * chain. Returns [lng, lat] pairs to match the rest of the geo layer.
 */
export function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    // Each coordinate is a zig-zag encoded delta in 5-bit chunks.
    for (const axis of ["lat", "lng"] as const) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);

      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === "lat") lat += delta;
      else lng += delta;
    }
    points.push([lng / 1e5, lat / 1e5]);
  }

  return points;
}

/** A driving/walking/cycling/transit route between two resolved places. */
export async function googleRoute(
  from: Place,
  to: Place,
  serverKey: string,
  travelMode: TravelMode = "DRIVE"
): Promise<ProviderResult<RouteResult>> {
  const key = `g:route:${from.latitude.toFixed(3)},${from.longitude.toFixed(3)}:${to.latitude.toFixed(3)},${to.longitude.toFixed(3)}:${travelMode}`;
  const hit = routeCache.get(key);
  if (hit && !hit.expired) {
    return { data: hit.value, meta: meta(hit.observedAt, SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);

    let payload: RoutesApiResponse;
    try {
      const res = await fetch(ROUTES_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": serverKey,
          // A field mask is REQUIRED by the Routes API, and asking for only
          // what is drawn keeps the response small and the cost lower.
          "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: from.latitude, longitude: from.longitude } } },
          destination: { location: { latLng: { latitude: to.latitude, longitude: to.longitude } } },
          travelMode,
          // Traffic-aware routing is only valid for DRIVE.
          ...(travelMode === "DRIVE" ? { routingPreference: "TRAFFIC_AWARE" } : {}),
          polylineQuality: "OVERVIEW",
        }),
      });
      payload = (await res.json()) as RoutesApiResponse;
      if (!res.ok) {
        return unavailable(SOURCE, describeStatus(payload.error?.status ?? "UNKNOWN"));
      }
    } finally {
      clearTimeout(timer);
    }

    const best = payload.routes?.[0];
    if (!best || typeof best.distanceMeters !== "number") {
      return unavailable(SOURCE, "Google found no route between those places.");
    }

    // `duration` arrives as a protobuf duration string, e.g. "3204s".
    const seconds = Number.parseInt(String(best.duration ?? "0").replace(/[^0-9]/g, ""), 10) || 0;

    const result: RouteResult = {
      from,
      to,
      distanceKm: Math.round((best.distanceMeters / 1000) * 10) / 10,
      durationMinutes: Math.round(seconds / 60),
      ...(best.polyline?.encodedPolyline
        ? { geometry: decodePolyline(best.polyline.encodedPolyline) }
        : {}),
      attribution: GOOGLE_ATTRIBUTION,
    };

    const observedAt = new Date();
    routeCache.set(key, result, observedAt);
    return { data: result, meta: meta(observedAt, SOURCE, REFERENCE_THRESHOLDS) };
  } catch {
    return unavailable(SOURCE, "Google Maps could not be reached.");
  }
}

export function __resetGoogleMapsCaches(): void {
  geoCache.clear();
  routeCache.clear();
}
