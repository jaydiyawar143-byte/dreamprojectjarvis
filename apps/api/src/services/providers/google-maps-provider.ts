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
import type { Place, PlaceSuggestion, RouteResult } from "./geo-provider.js";
import type { MapsService } from "@jarvis/db";
import { getMapsUsageGuard } from "../maps-usage-guard.js";

const SOURCE = "Google Maps Platform";

const GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

// Places API (NEW), not the legacy `maps/api/place/*` endpoints.
//
// This is not a preference. Google stopped enabling the legacy Places API for
// Cloud projects created after March 2025, so a deployment following the setup
// instructions in the report would get REQUEST_DENIED on every place search
// while geocoding and routing worked — the most confusing possible failure.
// The New API is also where Place IDs, autocomplete sessions and field masks
// live, all of which this feature needs.
const PLACES_SEARCH_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const PLACES_AUTOCOMPLETE_ENDPOINT = "https://places.googleapis.com/v1/places:autocomplete";
const PLACES_DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";

/** Only the fields that are drawn. A wider mask costs more per call. */
const PLACE_FIELDS = "places.id,places.displayName,places.formattedAddress,places.location,places.types";
const PLACE_DETAIL_FIELDS = "id,displayName,formattedAddress,location,types";

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
    place_id?: string;
  }>;
}

// --- Places API (New) wire shapes -----------------------------------------

interface NewPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
}

interface PlacesSearchResponse {
  places?: NewPlace[];
  error?: { status?: string; message?: string };
}

interface PlacesAutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
      types?: string[];
    };
  }>;
  error?: { status?: string; message?: string };
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
    // Legacy Geocoding/Routes statuses.
    case "ZERO_RESULTS":
      return "Google found no match for that.";
    case "OVER_QUERY_LIMIT":
      return "The Google Maps quota for this project has been exceeded.";
    case "REQUEST_DENIED":
      return "Google refused the request. Check that the server key is valid and the Geocoding and Routes APIs are enabled for it.";
    case "INVALID_REQUEST":
      return "That search could not be understood.";

    // Places API (New) and Routes v2 use gRPC status names instead.
    case "PERMISSION_DENIED":
      return "Google refused the request. Check that the server key is valid and the Places API (New) and Routes API are enabled for it.";
    case "RESOURCE_EXHAUSTED":
      return "The Google Maps quota for this project has been exceeded.";
    case "INVALID_ARGUMENT":
      return "That search could not be understood.";
    case "NOT_FOUND":
      return "Google found no match for that.";
    case "UNAUTHENTICATED":
      return "Google rejected the server key. Check that it is valid and not restricted away from this server.";
    case "FAILED_PRECONDITION":
      return "Google refused the request. Billing may not be enabled for this Cloud project.";
    default:
      return "Google Maps could not answer that request.";
  }
}

/**
 * POST helper for the v1 Places endpoints.
 *
 * Separate from `fetchJson` because these are POSTs carrying a field mask, and
 * because a non-2xx here still has a JSON body worth classifying — a thrown
 * error would lose the distinction between "quota" and "key rejected".
 */
async function postPlaces<T>(
  url: string,
  serverKey: string,
  body: unknown,
  fieldMask?: string
): Promise<{ ok: boolean; payload: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": serverKey,
        ...(fieldMask ? { "X-Goog-FieldMask": fieldMask } : {}),
      },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, payload: (await res.json()) as T };
  } finally {
    clearTimeout(timer);
  }
}

/** Turns a Places API (New) record into the shared `Place` shape. */
function shapeNewPlace(raw: NewPlace): Place | null {
  const lat = raw.location?.latitude;
  const lng = raw.location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const display = raw.displayName?.text?.trim();
  const address = raw.formattedAddress?.trim();
  // "Cafe Coffee Day — MG Road, Gondia" reads better than either half alone.
  // But when the address already begins with the display name — a locality,
  // where displayName is "Gondia" and formattedAddress is "Gondia,
  // Maharashtra, India" — the address is the STRICTLY MORE INFORMATIVE half,
  // so it wins outright. Preferring `display` there would throw away the state
  // and country and leave two different "Gondia" rows indistinguishable.
  const name =
    display && address
      ? address.startsWith(display)
        ? address
        : `${display} — ${address}`
      : address || display || "";
  if (!name) return null;

  return {
    name,
    latitude: lat as number,
    longitude: lng as number,
    ...(raw.types?.[0] ? { type: raw.types[0] } : {}),
    ...(raw.id ? { placeId: raw.id } : {}),
    attribution: GOOGLE_ATTRIBUTION,
  };
}

function shapePlace(
  address: string,
  location: { lat: number; lng: number } | undefined,
  type?: string,
  placeId?: string
): Place | null {
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return null;
  return {
    name: address,
    latitude: location.lat,
    longitude: location.lng,
    ...(type ? { type } : {}),
    ...(placeId ? { placeId } : {}),
    attribution: GOOGLE_ATTRIBUTION,
  };
}

// ---------------------------------------------------------------------------
// Monthly usage guard
//
// Every function below passes through `meter()` at the point a request is about
// to LEAVE THE PROCESS — after the cache has been consulted, before `fetch`.
// That placement is the whole reason the counter is accurate: a cache hit costs
// Google nothing and must not consume budget, and a blocked call must not
// increment the counter that blocked it.
//
// With no guard installed (unit tests, and any deployment that has not wired
// one) nothing is metered and nothing is blocked. The guard is a cost control,
// not a correctness dependency.
// ---------------------------------------------------------------------------

/** Who a billable call is attributed to. */
export interface UsageContext {
  userId: string;
}

/** Attribution when a call has no authenticated user behind it. */
const SYSTEM_ATTRIBUTION = "system";

/**
 * The gate. Returns null when the call may proceed, or a `ProviderResult`
 * carrying the limit message when it may not — which callers return directly.
 */
async function meter(
  service: MapsService,
  usage: UsageContext | undefined
): Promise<ProviderResult<never> | null> {
  const guard = getMapsUsageGuard();
  if (!guard) return null;

  const { allowed, status } = await guard.check();
  if (!allowed) return unavailable(SOURCE, status.message);

  // Recorded here rather than after the response, because the cost is incurred
  // by SENDING the request: a call that times out or returns 500 is still
  // billed, and a counter that ignored those would drift low exactly when
  // something is going wrong.
  await guard.record(usage?.userId ?? SYSTEM_ATTRIBUTION, service);
  return null;
}

/** Address → coordinates. */
export async function googleGeocode(
  query: string,
  serverKey: string,
  limit = 5,
  usage?: UsageContext
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

  const blocked = await meter("geocoding", usage);
  if (blocked) return blocked;

  try {
    const payload = await fetchJson<GoogleGeocodeResponse>(
      `${GEOCODE_ENDPOINT}?address=${encodeURIComponent(trimmed)}&key=${encodeURIComponent(serverKey)}`,
      { timeoutMs: 9000 }
    );

    if (payload.status !== "OK" || !payload.results?.length) {
      return unavailable(SOURCE, describeStatus(payload.status));
    }

    const places = payload.results
      .map((r) => shapePlace(r.formatted_address, r.geometry?.location, r.types?.[0], r.place_id))
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
  serverKey: string,
  usage?: UsageContext
): Promise<ProviderResult<Place>> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return unavailable(SOURCE, "A valid location is required.");
  }

  const key = `g:rev:${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const hit = geoCache.get(key);
  if (hit?.value[0] && !hit.expired) {
    return { data: hit.value[0], meta: meta(hit.observedAt, SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  const blocked = await meter("geocoding", usage);
  if (blocked) return blocked;

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

/**
 * Text place search — restaurants, landmarks, businesses, cities.
 *
 * `near` biases rather than restricts: "restaurants near me" should prefer
 * local results but must still answer for a user on the edge of the radius,
 * and a hard restriction silently returns nothing there.
 */
export async function googlePlaceSearch(
  query: string,
  serverKey: string,
  near?: { latitude: number; longitude: number },
  limit = 8,
  usage?: UsageContext
): Promise<ProviderResult<Place[]>> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return unavailable(SOURCE, "Enter at least two characters to search.");

  const key = `g:place:${trimmed.toLowerCase()}:${near ? `${near.latitude.toFixed(2)},${near.longitude.toFixed(2)}` : "any"}`;

  const hit = geoCache.get(key);
  if (hit && !hit.expired) {
    return { data: hit.value.slice(0, limit), meta: meta(hit.observedAt, SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  const blocked = await meter("places", usage);
  if (blocked) return blocked;

  try {
    const { ok, payload } = await postPlaces<PlacesSearchResponse>(
      PLACES_SEARCH_ENDPOINT,
      serverKey,
      {
        textQuery: trimmed,
        // Capped server-side too, so a caller cannot ask for a 20-result page
        // and multiply the per-call cost.
        maxResultCount: Math.min(Math.max(limit, 1), 20),
        ...(near
          ? {
              locationBias: {
                circle: {
                  center: { latitude: near.latitude, longitude: near.longitude },
                  radius: 20000,
                },
              },
            }
          : {}),
      },
      PLACE_FIELDS
    );

    if (!ok) return unavailable(SOURCE, describeStatus(payload.error?.status ?? "UNKNOWN"));
    if (!payload.places?.length) return unavailable(SOURCE, describeStatus("ZERO_RESULTS"));

    const places = payload.places
      .map(shapeNewPlace)
      .filter((p): p is Place => p !== null);

    if (places.length === 0) return unavailable(SOURCE, "Google returned no usable places.");

    const observedAt = new Date();
    geoCache.set(key, places, observedAt);
    return { data: places.slice(0, limit), meta: meta(observedAt, SOURCE, REFERENCE_THRESHOLDS) };
  } catch {
    return unavailable(SOURCE, "Google Maps could not be reached.");
  }
}

/**
 * Type-ahead suggestions.
 *
 * Returns predictions, NOT places: a prediction has a Place ID and a label but
 * no coordinates, and Google's terms do not allow storing autocomplete results
 * as if they were resolved places. Selecting one calls `googlePlaceDetails`.
 *
 * Deliberately NOT cached. Autocomplete is priced per session, the input
 * changes on every keystroke, and caching prefixes would keep a per-user trail
 * of partial searches in process memory for no benefit. The DEBOUNCE on the
 * client is what controls the call volume.
 */
export async function googlePlaceAutocomplete(
  input: string,
  serverKey: string,
  near?: { latitude: number; longitude: number },
  limit = 5,
  usage?: UsageContext
): Promise<ProviderResult<PlaceSuggestion[]>> {
  const trimmed = input.trim();
  if (trimmed.length < 2) {
    return unavailable(SOURCE, "Type at least two characters.");
  }

  const blocked = await meter("autocomplete", usage);
  if (blocked) return blocked;

  try {
    const { ok, payload } = await postPlaces<PlacesAutocompleteResponse>(
      PLACES_AUTOCOMPLETE_ENDPOINT,
      serverKey,
      {
        input: trimmed,
        ...(near
          ? {
              locationBias: {
                circle: {
                  center: { latitude: near.latitude, longitude: near.longitude },
                  radius: 50000,
                },
              },
            }
          : {}),
      }
      // No field mask: the Autocomplete (New) endpoint does not accept one.
    );

    if (!ok) return unavailable(SOURCE, describeStatus(payload.error?.status ?? "UNKNOWN"));

    const suggestions: PlaceSuggestion[] = (payload.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => Boolean(p?.placeId))
      .map((p) => {
        const primary = p.structuredFormat?.mainText?.text ?? p.text?.text ?? "";
        const secondary = p.structuredFormat?.secondaryText?.text;
        return {
          placeId: p.placeId!,
          description: p.text?.text ?? [primary, secondary].filter(Boolean).join(", "),
          primary,
          ...(secondary ? { secondary } : {}),
          ...(p.types?.[0] ? { type: p.types[0] } : {}),
        };
      })
      .filter((s) => s.description.length > 0)
      .slice(0, limit);

    if (suggestions.length === 0) {
      return unavailable(SOURCE, `No place matched "${trimmed}".`);
    }

    return { data: suggestions, meta: meta(new Date(), SOURCE, REFERENCE_THRESHOLDS) };
  } catch {
    return unavailable(SOURCE, "Google Maps could not be reached.");
  }
}

/**
 * Place ID → a resolved place with coordinates.
 *
 * This is what makes a suggestion usable as a route endpoint. Resolving by ID
 * rather than by re-geocoding the label is the whole point: "Gondia" matches a
 * city, a district and a station, and a user who picked one from a list must
 * get THAT one.
 */
export async function googlePlaceDetails(
  placeId: string,
  serverKey: string,
  usage?: UsageContext
): Promise<ProviderResult<Place>> {
  const id = placeId.trim();
  // Place IDs are opaque but URL-safe; anything else is a caller bug or an
  // injection attempt, and must not be interpolated into a path.
  if (!/^[A-Za-z0-9_-]{4,512}$/.test(id)) {
    return unavailable(SOURCE, "That place reference is not valid.");
  }

  const key = `g:pid:${id}`;
  const hit = geoCache.get(key);
  if (hit?.value[0] && !hit.expired) {
    return { data: hit.value[0], meta: meta(hit.observedAt, SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  const blocked = await meter("place_details", usage);
  if (blocked) return blocked;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    let res: Response;
    let payload: NewPlace & { error?: { status?: string } };
    try {
      res = await fetch(`${PLACES_DETAILS_ENDPOINT}/${encodeURIComponent(id)}`, {
        signal: controller.signal,
        headers: {
          "X-Goog-Api-Key": serverKey,
          "X-Goog-FieldMask": PLACE_DETAIL_FIELDS,
        },
      });
      payload = (await res.json()) as NewPlace & { error?: { status?: string } };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return unavailable(SOURCE, describeStatus(payload.error?.status ?? "UNKNOWN"));

    const place = shapeNewPlace(payload);
    if (!place) return unavailable(SOURCE, "Google returned no usable coordinates for that place.");

    const observedAt = new Date();
    geoCache.set(key, [place], observedAt);
    return { data: place, meta: meta(observedAt, SOURCE, REFERENCE_THRESHOLDS) };
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

/**
 * A Routes API waypoint.
 *
 * Prefers the Place ID, because a coordinate pair snapped to the nearest road
 * can land on the wrong side of a divided highway or a river; the ID resolves
 * to the entrance Google itself would route to.
 */
function waypoint(p: Place): Record<string, unknown> {
  if (p.placeId) return { placeId: p.placeId };
  return { location: { latLng: { latitude: p.latitude, longitude: p.longitude } } };
}

/** A driving/walking/cycling/transit route between two resolved places. */
export async function googleRoute(
  from: Place,
  to: Place,
  serverKey: string,
  travelMode: TravelMode = "DRIVE",
  usage?: UsageContext
): Promise<ProviderResult<RouteResult>> {
  // Keyed on the Place ID when there is one: two searches for "Gondia" that
  // resolved to the same place must share a cache entry even if their rounded
  // coordinates differ by a metre.
  const endpoint = (p: Place) =>
    p.placeId ?? `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`;
  const key = `g:route:${endpoint(from)}:${endpoint(to)}:${travelMode}`;
  const hit = routeCache.get(key);
  if (hit && !hit.expired) {
    return { data: hit.value, meta: meta(hit.observedAt, SOURCE, REFERENCE_THRESHOLDS, { cached: true }) };
  }

  const blocked = await meter("routes", usage);
  if (blocked) return blocked;

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
          // A Place ID names the endpoint unambiguously; coordinates are the
          // fallback for OpenStreetMap-resolved places, which have none.
          origin: waypoint(from),
          destination: waypoint(to),
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
