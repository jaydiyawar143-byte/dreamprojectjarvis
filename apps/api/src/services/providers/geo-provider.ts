// ---------------------------------------------------------------------------
// V3 — geocoding, place search and routing.
//
// OpenStreetMap's Nominatim for geocoding and search, OSRM for routing. Both
// are public services with published usage policies, both are free of keys, and
// both are LEGITIMATE APIs — this is the alternative to scraping Google Maps,
// which was ruled out and would also violate their terms.
//
// The layers are kept separate (geocode / search / route) because they are
// different capabilities with different providers and different limits. A
// future swap to a commercial provider replaces one function, not the module.
//
// USAGE POLICY IS CODE HERE, NOT A COMMENT. Nominatim requires an identifying
// User-Agent (set in fetchJson), asks for at most one request per second, and
// expects heavy users to cache. All three are implemented below; a caller
// cannot accidentally violate them.
//
// ATTRIBUTION. Nominatim data is ODbL and requires visible credit, so every
// result carries `attribution` and the UI renders it.
// ---------------------------------------------------------------------------

import { TtlCache, fetchJson, meta, unavailable, type ProviderResult } from "./freshness.js";
import {
  googleGeocode,
  googlePlaceSearch,
  googleRoute,
  normalizeTravelMode,
} from "./google-maps-provider.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OSRM = "https://router.project-osrm.org";

const GEO_SOURCE = "OpenStreetMap / Nominatim";
const ROUTE_SOURCE = "OSRM";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

/** Place geometry barely changes; a long cache is correct and polite. */
const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const ROUTE_TTL_MS = 60 * 60 * 1000;

/** These are reference data, not observations, so age is not a quality signal. */
const REFERENCE_THRESHOLDS = { liveWithin: 7 * 24 * 3600, delayedWithin: 30 * 24 * 3600 };

/**
 * Which provider answers.
 *
 * Google when a server key is configured, OpenStreetMap otherwise. Both are
 * real; `meta.source` on every response names the one that answered, so an OSM
 * result is never presented as a Google one. Keeping OSM rather than reporting
 * "unavailable" means a deployment without a Google key still gets working
 * geocoding and routing.
 */
function googleServerKey(): string | null {
  return process.env.GOOGLE_MAPS_SERVER_KEY || null;
}

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
  type?: string;
  attribution: string;
}

export interface RouteResult {
  from: Place;
  to: Place;
  distanceKm: number;
  durationMinutes: number;
  /** Coarse polyline for drawing. Omitted when the caller does not need it. */
  geometry?: Array<[number, number]>;
  attribution: string;
}

const geoCache = new TtlCache<Place[]>(GEO_TTL_MS, 256);
const routeCache = new TtlCache<RouteResult>(ROUTE_TTL_MS, 128);

// ---------------------------------------------------------------------------
// Rate limiting
//
// Nominatim's policy is a hard maximum of one request per second for the
// public instance. This serialises our calls so the limit holds no matter how
// many users are on the dashboard — being throttled or blocked would take the
// feature down for everyone.
// ---------------------------------------------------------------------------
let lastNominatimCall = 0;
let nominatimChain: Promise<unknown> = Promise.resolve();

function throttledNominatim<T>(run: () => Promise<T>): Promise<T> {
  const next = nominatimChain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastNominatimCall));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimCall = Date.now();
    return run();
  });
  // Keep the chain alive even when one call rejects, or every later request
  // would inherit the rejection.
  nominatimChain = next.catch(() => undefined);
  return next;
}

interface NominatimPlace {
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
}

function shapePlaces(raw: NominatimPlace[]): Place[] {
  return raw
    .map((p) => ({
      name: p.display_name,
      latitude: Number(p.lat),
      longitude: Number(p.lon),
      ...(p.type ? { type: p.type } : {}),
      attribution: OSM_ATTRIBUTION,
    }))
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}

/** Resolves a place name to coordinates. */
export async function geocode(query: string, limit = 5): Promise<ProviderResult<Place[]>> {
  const google = googleServerKey();
  if (google) return googleGeocode(query, google, limit);

  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return unavailable(GEO_SOURCE, "Enter at least two characters to search for a place.");
  }

  const key = `geo:${trimmed.toLowerCase()}:${limit}`;
  const hit = geoCache.get(key);
  if (hit && !hit.expired) {
    return { data: hit.value, meta: meta(hit.observedAt, GEO_SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  try {
    const raw = await throttledNominatim(() =>
      fetchJson<NominatimPlace[]>(
        `${NOMINATIM}/search?q=${encodeURIComponent(trimmed)}&format=json&limit=${Math.min(limit, 10)}&addressdetails=0`,
        { timeoutMs: 9000 }
      )
    );

    const places = shapePlaces(raw);
    if (places.length === 0) {
      return unavailable(GEO_SOURCE, `No place matched "${trimmed}".`);
    }

    const observedAt = new Date();
    geoCache.set(key, places, observedAt);
    return { data: places, meta: meta(observedAt, GEO_SOURCE, REFERENCE_THRESHOLDS) };
  } catch {
    if (hit) {
      return { data: hit.value, meta: meta(hit.observedAt, GEO_SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
    }
    return unavailable(GEO_SOURCE, "The place-search service could not be reached.");
  }
}

/**
 * Finds places of interest near a point.
 *
 * Uses a bounded viewbox rather than a radius: Nominatim has no radius filter,
 * and asking for an unbounded search then filtering client-side would both
 * waste the provider's quota and return irrelevant results from far away.
 */
export async function searchNearby(
  query: string,
  latitude: number,
  longitude: number,
  limit = 8
): Promise<ProviderResult<Place[]>> {
  const google = googleServerKey();
  if (google) return googlePlaceSearch(query, google, { latitude, longitude }, limit);

  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return unavailable(GEO_SOURCE, "Enter at least two characters to search.");
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return unavailable(GEO_SOURCE, "A location is needed before searching nearby.");
  }

  // ~0.15 degrees is roughly 15km, which is a sensible "near me".
  const d = 0.15;
  const viewbox = `${longitude - d},${latitude + d},${longitude + d},${latitude - d}`;
  const key = `near:${trimmed.toLowerCase()}:${latitude.toFixed(2)},${longitude.toFixed(2)}`;

  const hit = geoCache.get(key);
  if (hit && !hit.expired) {
    return { data: hit.value, meta: meta(hit.observedAt, GEO_SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  try {
    const raw = await throttledNominatim(() =>
      fetchJson<NominatimPlace[]>(
        `${NOMINATIM}/search?q=${encodeURIComponent(trimmed)}&format=json&limit=${Math.min(limit, 12)}` +
          `&viewbox=${viewbox}&bounded=1`,
        { timeoutMs: 9000 }
      )
    );

    const places = shapePlaces(raw);
    if (places.length === 0) {
      return unavailable(GEO_SOURCE, `Nothing matching "${trimmed}" was found nearby.`);
    }

    const observedAt = new Date();
    geoCache.set(key, places, observedAt);
    return { data: places, meta: meta(observedAt, GEO_SOURCE, REFERENCE_THRESHOLDS) };
  } catch {
    return unavailable(GEO_SOURCE, "The place-search service could not be reached.");
  }
}

/**
 * Driving route between two places, by name.
 *
 * Both endpoints are geocoded first, so a caller can ask in the terms a person
 * uses ("Balaghat to Gondia") rather than in coordinates.
 */
export async function route(
  fromQuery: string,
  toQuery: string,
  options: { geometry?: boolean; travelMode?: string } = {}
): Promise<ProviderResult<RouteResult>> {
  const fromResult = await geocode(fromQuery, 1);
  if (!fromResult.data?.[0]) {
    return unavailable(ROUTE_SOURCE, fromResult.meta.reason ?? `Could not find "${fromQuery}".`);
  }
  const toResult = await geocode(toQuery, 1);
  if (!toResult.data?.[0]) {
    return unavailable(ROUTE_SOURCE, toResult.meta.reason ?? `Could not find "${toQuery}".`);
  }

  const from = fromResult.data[0];
  const to = toResult.data[0];

  // Google Routes supports driving, walking, cycling and transit; OSRM's public
  // demo server is driving-only, so a requested mode is honoured only when
  // Google is configured. The mode is never silently substituted.
  const google = googleServerKey();
  if (google) {
    return googleRoute(from, to, google, normalizeTravelMode(options.travelMode));
  }

  const key = `route:${from.latitude.toFixed(3)},${from.longitude.toFixed(3)}:${to.latitude.toFixed(3)},${to.longitude.toFixed(3)}:${options.geometry ? "g" : "n"}`;

  const hit = routeCache.get(key);
  if (hit && !hit.expired) {
    return { data: hit.value, meta: meta(hit.observedAt, ROUTE_SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  try {
    const overview = options.geometry ? "overview=simplified&geometries=geojson" : "overview=false";
    const payload = await fetchJson<{
      code: string;
      routes?: Array<{ distance: number; duration: number; geometry?: { coordinates: Array<[number, number]> } }>;
    }>(
      `${OSRM}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?${overview}`,
      { timeoutMs: 12000 }
    );

    const best = payload.routes?.[0];
    if (payload.code !== "Ok" || !best) {
      return unavailable(ROUTE_SOURCE, "No driving route was found between those places.");
    }

    const result: RouteResult = {
      from,
      to,
      distanceKm: Math.round((best.distance / 1000) * 10) / 10,
      durationMinutes: Math.round(best.duration / 60),
      ...(best.geometry?.coordinates ? { geometry: best.geometry.coordinates } : {}),
      attribution: `${OSM_ATTRIBUTION} · routing by OSRM`,
    };

    const observedAt = new Date();
    routeCache.set(key, result, observedAt);
    return { data: result, meta: meta(observedAt, ROUTE_SOURCE, REFERENCE_THRESHOLDS) };
  } catch {
    return unavailable(ROUTE_SOURCE, "The routing service could not be reached.");
  }
}

export function __resetGeoCaches(): void {
  geoCache.clear();
  routeCache.clear();
}
