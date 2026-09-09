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
import type { UsageContext } from "./google-maps-provider.js";
import {
  googleGeocode,
  googlePlaceAutocomplete,
  googlePlaceDetails,
  googlePlaceSearch,
  googleReverseGeocode,
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
  /**
   * Google's stable identifier for the place, when Google resolved it.
   *
   * Carried so routing can name an endpoint EXPLICITLY rather than re-geocoding
   * a display string. "Gondia" matches a district, a city and a railway station;
   * re-resolving the label a user already picked is how a route quietly ends up
   * between two different places from the ones on screen.
   *
   * Absent on OpenStreetMap results — Nominatim ids are not Place IDs and must
   * never be passed to Google as one.
   */
  placeId?: string;
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

/**
 * One type-ahead row.
 *
 * A suggestion is NOT a place: Google returns a label and a Place ID with no
 * coordinates, and selecting one is a second call. OpenStreetMap has no
 * autocomplete product, so its rows come from a normal search and already carry
 * the resolved place — hence both fields being optional, and exactly one of
 * them always being present.
 */
export interface PlaceSuggestion {
  /** Google Place ID. Absent on OpenStreetMap suggestions. */
  placeId?: string;
  /** Full label, e.g. "Gondia, Maharashtra, India". */
  description: string;
  /** The prominent half, e.g. "Gondia". */
  primary: string;
  secondary?: string;
  type?: string;
  /** Already-resolved coordinates, when the provider returned them. */
  place?: Place;
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
export async function geocode(
  query: string,
  limit = 5,
  usage?: UsageContext
): Promise<ProviderResult<Place[]>> {
  const google = googleServerKey();
  if (google) return googleGeocode(query, google, limit, usage);

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
  limit = 8,
  usage?: UsageContext
): Promise<ProviderResult<Place[]>> {
  const google = googleServerKey();
  if (google) return googlePlaceSearch(query, google, { latitude, longitude }, limit, usage);

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
  options: { geometry?: boolean; travelMode?: string } = {},
  usage?: UsageContext
): Promise<ProviderResult<RouteResult>> {
  const fromResult = await geocode(fromQuery, 1, usage);
  if (!fromResult.data?.[0]) {
    return unavailable(ROUTE_SOURCE, fromResult.meta.reason ?? `Could not find "${fromQuery}".`);
  }
  const toResult = await geocode(toQuery, 1, usage);
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
    return googleRoute(from, to, google, normalizeTravelMode(options.travelMode), usage);
  }

  return osrmRoute(from, to, options.geometry === true);
}

/**
 * The OpenStreetMap routing path, split out so `routeBetween` can reach it
 * without going back through geocoding.
 *
 * OSRM's public demo server is DRIVING ONLY. A requested walking or transit
 * mode is not silently substituted here — the caller is told which modes are
 * available (see `/maps/config`), and the UI disables the rest.
 */
async function osrmRoute(
  from: Place,
  to: Place,
  geometry: boolean
): Promise<ProviderResult<RouteResult>> {
  const key = `route:${from.latitude.toFixed(3)},${from.longitude.toFixed(3)}:${to.latitude.toFixed(3)},${to.longitude.toFixed(3)}:${geometry ? "g" : "n"}`;

  const hit = routeCache.get(key);
  if (hit && !hit.expired) {
    return { data: hit.value, meta: meta(hit.observedAt, ROUTE_SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  try {
    const overview = geometry ? "overview=simplified&geometries=geojson" : "overview=false";
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

/**
 * Type-ahead suggestions for a partial query.
 *
 * Google answers with predictions (label + Place ID, no coordinates).
 * OpenStreetMap has no autocomplete product, so its rows come from an ordinary
 * bounded search and arrive already resolved. Callers must therefore handle
 * both shapes — see `resolveSuggestion`.
 *
 * NOT cached on purpose: the input changes on every keystroke, so a cache would
 * hold a per-user trail of partial searches and hit almost never. Call volume
 * is controlled by the client-side debounce instead.
 */
export async function autocomplete(
  input: string,
  near?: { latitude: number; longitude: number },
  limit = 5,
  usage?: UsageContext
): Promise<ProviderResult<PlaceSuggestion[]>> {
  const google = googleServerKey();
  if (google) return googlePlaceAutocomplete(input, google, near, limit, usage);

  const trimmed = input.trim();
  if (trimmed.length < 2) return unavailable(GEO_SOURCE, "Type at least two characters.");

  const found = near
    ? await searchNearby(trimmed, near.latitude, near.longitude, limit)
    : await geocode(trimmed, limit);

  if (!found.data?.length) {
    return unavailable(GEO_SOURCE, found.meta.reason ?? `No place matched "${trimmed}".`);
  }

  const suggestions: PlaceSuggestion[] = found.data.slice(0, limit).map((place) => {
    // Nominatim's display_name is "Primary, region, state, country". Splitting
    // on the first comma reproduces Google's primary/secondary split closely
    // enough for the same UI to render both providers.
    const [primary, ...rest] = place.name.split(",");
    const secondary = rest.join(",").trim();
    return {
      description: place.name,
      primary: (primary ?? place.name).trim(),
      ...(secondary ? { secondary } : {}),
      ...(place.type ? { type: place.type } : {}),
      place,
    };
  });

  return { data: suggestions, meta: found.meta };
}

/**
 * A suggestion → a place with coordinates.
 *
 * The OpenStreetMap path already has them. The Google path costs a Place
 * Details call, which is exactly why it is deferred until the user picks a row
 * rather than made for every prediction.
 */
export async function resolveSuggestion(
  suggestion: { placeId?: string; place?: Place },
  usage?: UsageContext
): Promise<ProviderResult<Place>> {
  if (suggestion.place) {
    return { data: suggestion.place, meta: meta(new Date(), GEO_SOURCE, REFERENCE_THRESHOLDS) };
  }

  const google = googleServerKey();
  if (suggestion.placeId && google) return googlePlaceDetails(suggestion.placeId, google, usage);

  return unavailable(
    GEO_SOURCE,
    suggestion.placeId
      ? "Resolving a Google place needs GOOGLE_MAPS_SERVER_KEY."
      : "That suggestion carried no location."
  );
}

/** Place ID → place. Google only; OpenStreetMap has no Place IDs. */
export async function resolvePlaceId(
  placeId: string,
  usage?: UsageContext
): Promise<ProviderResult<Place>> {
  const google = googleServerKey();
  if (!google) {
    return unavailable(GEO_SOURCE, "Resolving a Google place needs GOOGLE_MAPS_SERVER_KEY.");
  }
  return googlePlaceDetails(placeId, google, usage);
}

/**
 * Coordinates → a human-readable address.
 *
 * Falls back to Nominatim so the current-location marker gets a real label on a
 * deployment without a Google server key. Both providers are named in
 * `meta.source`; neither result is ever presented as the other.
 *
 * The cache key is ROUNDED to three decimals (~110m). That is deliberate: a
 * precise key would keep an exact per-user location trail in process memory,
 * and would almost never hit.
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
  usage?: UsageContext
): Promise<ProviderResult<Place>> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return unavailable(GEO_SOURCE, "A valid location is required.");
  }

  const google = googleServerKey();
  if (google) return googleReverseGeocode(latitude, longitude, google, usage);

  const key = `rev:${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const hit = geoCache.get(key);
  if (hit?.value[0] && !hit.expired) {
    return { data: hit.value[0], meta: meta(hit.observedAt, GEO_SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  try {
    const raw = await throttledNominatim(() =>
      fetchJson<NominatimPlace & { error?: string }>(
        `${NOMINATIM}/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=12`,
        { timeoutMs: 9000 }
      )
    );

    if (!raw || raw.error || !raw.display_name) {
      return unavailable(GEO_SOURCE, "No address was found for that location.");
    }

    const place: Place = {
      name: raw.display_name,
      latitude: Number(raw.lat),
      longitude: Number(raw.lon),
      type: "current",
      attribution: OSM_ATTRIBUTION,
    };
    if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) {
      return unavailable(GEO_SOURCE, "No usable address was found for that location.");
    }

    const observedAt = new Date();
    geoCache.set(key, [place], observedAt);
    return { data: place, meta: meta(observedAt, GEO_SOURCE, REFERENCE_THRESHOLDS) };
  } catch {
    return unavailable(GEO_SOURCE, "The address lookup service could not be reached.");
  }
}

/**
 * Route between two ALREADY-RESOLVED places.
 *
 * Separate from `route()` so a caller that has Place IDs in hand — a user who
 * picked both endpoints from autocomplete — does not send the display strings
 * back through geocoding and risk landing on a different "Gondia".
 */
export async function routePlaces(
  from: Place,
  to: Place,
  options: { geometry?: boolean; travelMode?: string } = {},
  usage?: UsageContext
): Promise<ProviderResult<RouteResult>> {
  const google = googleServerKey();
  if (google) return googleRoute(from, to, google, normalizeTravelMode(options.travelMode), usage);
  return osrmRoute(from, to, options.geometry === true);
}

export function __resetGeoCaches(): void {
  geoCache.clear();
  routeCache.clear();
}
