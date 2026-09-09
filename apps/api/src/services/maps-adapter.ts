// ---------------------------------------------------------------------------
// The API's implementation of `MapsPort` and `CurrentLocationPort`.
//
// `@jarvis/tools` declares WHAT a maps capability can do; this file is the only
// place that knows HOW — which provider answers, where the key lives, what a
// failure looks like on the wire. Same split as the Meta and Google Ads
// provider ports.
//
// Two things it deliberately does NOT do:
//
//   - It never hands a tool the API key, an endpoint or a raw response. A tool
//     receives a resolved place or a null with a reason, so no prompt can steer
//     an outbound Google request.
//
//   - It never invents a fallback. When the provider says UNAVAILABLE, that
//     reason is passed through verbatim, because those strings were written to
//     be shown to a user and are the difference between "quota exceeded" and
//     "no such place".
// ---------------------------------------------------------------------------

import type {
  Coordinates,
  CurrentLocationPort,
  MapsOutcome,
  MapsPlace,
  MapsPort,
  MapsRoute,
} from "@jarvis/tools";
import type { ProviderResult } from "./providers/freshness.js";
import type { Place, RouteResult } from "./providers/geo-provider.js";
import type { UsageContext } from "./providers/google-maps-provider.js";
import {
  geocode,
  resolvePlaceId,
  reverseGeocode,
  routePlaces,
  searchNearby,
} from "./providers/geo-provider.js";
import { locationStore } from "./location-store.js";

/**
 * `ProviderResult` → `MapsOutcome`.
 *
 * The shapes are close but not identical on purpose: freshness thresholds and
 * cache flags are a widget concern, and a model given `ageSeconds` on a road
 * distance would start reasoning about how "fresh" a road is.
 */
function toOutcome<T>(result: ProviderResult<T>): MapsOutcome<T> {
  return {
    data: result.data,
    source: result.meta.source,
    ...(result.meta.reason ? { reason: result.meta.reason } : {}),
  };
}

/** `Place` and `MapsPlace` are structurally identical; this pins that. */
function toPlace(place: Place): MapsPlace {
  return place;
}

function toRoute(route: RouteResult): MapsRoute {
  return route;
}

/**
 * Attribution for the monthly usage counter.
 *
 * Undefined when a call has no authenticated user behind it — the provider then
 * attributes it to "system". The call is still counted against the global
 * limit either way; attribution decides only which row it lands in.
 */
function usageFor(userId?: string): UsageContext | undefined {
  return userId ? { userId } : undefined;
}

export function createMapsPort(): MapsPort {
  return {
    async geocode(query, limit, userId) {
      const result = await geocode(query, limit ?? 3, usageFor(userId));
      return toOutcome({
        ...result,
        data: result.data ? result.data.map(toPlace) : null,
      });
    },

    async reverseGeocode(latitude, longitude, userId) {
      const result = await reverseGeocode(latitude, longitude, usageFor(userId));
      return toOutcome({
        ...result,
        data: result.data ? toPlace(result.data) : null,
      });
    },

    async searchPlaces(query, near, limit, userId) {
      // `searchNearby` biases to a point when it has one and falls back to a
      // plain geocode otherwise, which is what a place search without a
      // location should do.
      const result = near
        ? await searchNearby(query, near.latitude, near.longitude, limit ?? 5, usageFor(userId))
        : await geocode(query, limit ?? 5, usageFor(userId));
      return toOutcome({
        ...result,
        data: result.data ? result.data.map(toPlace) : null,
      });
    },

    async getPlace(placeId, userId) {
      const result = await resolvePlaceId(placeId, usageFor(userId));
      return toOutcome({
        ...result,
        data: result.data ? toPlace(result.data) : null,
      });
    },

    async route(from, to, options, userId) {
      const result = await routePlaces(
        from,
        to,
        {
          ...(options.travelMode ? { travelMode: options.travelMode } : {}),
          geometry: options.geometry === true,
        },
        usageFor(userId)
      );
      return toOutcome({
        ...result,
        data: result.data ? toRoute(result.data) : null,
      });
    },
  };
}

/**
 * Reads the browser-published position for the AUTHENTICATED user.
 *
 * The user id arrives on the tool context, which the executor fills from the
 * session — never from tool parameters. That is what makes one tenant's
 * position unreachable from another's conversation.
 */
export function createCurrentLocationPort(): CurrentLocationPort {
  return {
    get(userId: string): Promise<Coordinates | null> {
      const coords = locationStore.get(userId);
      return Promise.resolve(
        coords ? { latitude: coords.latitude, longitude: coords.longitude } : null
      );
    },
  };
}
