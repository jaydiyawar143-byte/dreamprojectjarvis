// ---------------------------------------------------------------------------
// Google Maps — Places API (New), Place IDs, and the location store.
//
// Companion to v3-google-maps.test.ts, which pins key safety and the
// no-silent-substitution rule. This file pins the three things that this
// integration would most plausibly get wrong in a way nobody notices:
//
//   1. THE RIGHT PLACES API. Google stopped enabling the legacy
//      `maps/api/place/*` endpoints for Cloud projects created after March
//      2025. A deployment that follows the setup guide would get a working map
//      and a working route, and REQUEST_DENIED on every place search. The
//      requests are asserted against the v1 endpoints for that reason.
//
//   2. PLACE IDs AS ROUTE ENDPOINTS. "Gondia" is a city, a district and a
//      railway station. When the user picks one from a list, the route must run
//      between the places they picked — not between whatever a re-geocode of
//      the display string happens to return.
//
//   3. THE LOCATION STORE'S BOUNDARIES. It is keyed on the authenticated user,
//      it expires, and it refuses impossible coordinates. Each of those is the
//      difference between a feature and a privacy incident.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  googleGeocode,
  googlePlaceAutocomplete,
  googlePlaceDetails,
  googlePlaceSearch,
  googleRoute,
  __resetGoogleMapsCaches,
} from "../src/services/providers/google-maps-provider.js";
import { LocationStore } from "../src/services/location-store.js";
import { getMapsUsageGuard, setMapsUsageGuard } from "../src/services/maps-usage-guard.js";
import type { Place } from "../src/services/providers/geo-provider.js";

afterEach(() => {
  __resetGoogleMapsCaches();
  vi.restoreAllMocks();
});

/** Captures the single fetch a provider call makes. */
function captureFetch(response: unknown, ok = true) {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    json: async () => response,
  } as Response);
  return spy;
}

const GONDIA: Place = {
  name: "Gondia, Maharashtra, India",
  latitude: 21.46,
  longitude: 80.19,
  placeId: "ChIJgondia",
  attribution: "Map data ©2026 Google",
};

const BALAGHAT: Place = {
  name: "Balaghat, Madhya Pradesh, India",
  latitude: 21.81,
  longitude: 80.18,
  attribution: "Map data ©2026 Google",
};

// ---------------------------------------------------------------------------

describe("Places API (New)", () => {
  it("calls the v1 searchText endpoint, NOT the legacy textsearch one", async () => {
    const spy = captureFetch({
      places: [
        {
          id: "ChIJcafe",
          displayName: { text: "Cafe Coffee Day" },
          formattedAddress: "MG Road, Gondia",
          location: { latitude: 21.46, longitude: 80.19 },
          types: ["cafe"],
        },
      ],
    });

    await googlePlaceSearch("cafes", "server-key");

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://places.googleapis.com/v1/places:searchText");
    // The legacy endpoint is the failure this test exists to catch.
    expect(String(url)).not.toContain("maps/api/place");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("sends the key in a header and a field mask, never in the query string", async () => {
    const spy = captureFetch({ places: [] });
    await googlePlaceSearch("cafes", "SECRET-KEY");

    const [url, init] = spy.mock.calls[0]!;
    // A key in a URL ends up in proxy logs and browser history.
    expect(String(url)).not.toContain("SECRET-KEY");

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("SECRET-KEY");
    // Without a mask the response is billed at the highest SKU.
    expect(headers["X-Goog-FieldMask"]).toContain("places.location");
  });

  it("carries the Place ID through onto the resolved place", async () => {
    captureFetch({
      places: [
        {
          id: "ChIJgondia",
          displayName: { text: "Gondia" },
          formattedAddress: "Gondia, Maharashtra, India",
          location: { latitude: 21.46, longitude: 80.19 },
          types: ["locality"],
        },
      ],
    });

    const result = await googlePlaceSearch("Gondia", "key");
    expect(result.data?.[0]?.placeId).toBe("ChIJgondia");
  });

  it("does not repeat the display name when it already prefixes the address", async () => {
    captureFetch({
      places: [
        {
          id: "p1",
          displayName: { text: "Gondia" },
          formattedAddress: "Gondia, Maharashtra, India",
          location: { latitude: 21.46, longitude: 80.19 },
        },
      ],
    });

    const result = await googlePlaceSearch("Gondia", "key");
    expect(result.data?.[0]?.name).toBe("Gondia, Maharashtra, India");
  });

  it("drops a place with no usable coordinates rather than defaulting to 0,0", async () => {
    captureFetch({
      places: [
        { id: "broken", displayName: { text: "Nowhere" } },
        {
          id: "ok",
          displayName: { text: "Gondia" },
          formattedAddress: "Gondia, Maharashtra",
          location: { latitude: 21.46, longitude: 80.19 },
        },
      ],
    });

    const result = await googlePlaceSearch("Gondia", "key");
    // 0,0 is in the Gulf of Guinea. A place silently placed there is worse
    // than a place that is missing.
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0]?.placeId).toBe("ok");
  });

  it("caps the result count a caller can ask for", async () => {
    const spy = captureFetch({ places: [] });
    await googlePlaceSearch("cafes", "key", undefined, 500);

    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.maxResultCount).toBeLessThanOrEqual(20);
  });

  it("translates a gRPC status into a message that names the right API", async () => {
    captureFetch({ error: { status: "PERMISSION_DENIED", message: "key AIza-LEAK denied" } }, false);

    const result = await googlePlaceSearch("Gondia", "AIza-LEAK");
    expect(result.data).toBeNull();
    expect(result.meta.reason).toMatch(/Places API \(New\)/);
    // The same rule as the legacy path: Google's message can echo the key.
    expect(JSON.stringify(result)).not.toContain("AIza-LEAK");
  });

  it("reports an exhausted quota as a quota problem, not a missing place", async () => {
    captureFetch({ error: { status: "RESOURCE_EXHAUSTED" } }, false);
    const result = await googlePlaceSearch("Gondia", "key");
    expect(result.meta.reason).toMatch(/quota/i);
  });

  it("names billing when Google reports a failed precondition", async () => {
    captureFetch({ error: { status: "FAILED_PRECONDITION" } }, false);
    const result = await googlePlaceSearch("Gondia", "key");
    expect(result.meta.reason).toMatch(/billing/i);
  });
});

// ---------------------------------------------------------------------------

describe("autocomplete", () => {
  it("returns predictions with Place IDs and no coordinates", async () => {
    captureFetch({
      suggestions: [
        {
          placePrediction: {
            placeId: "ChIJgondia",
            text: { text: "Gondia, Maharashtra, India" },
            structuredFormat: {
              mainText: { text: "Gondia" },
              secondaryText: { text: "Maharashtra, India" },
            },
            types: ["locality"],
          },
        },
      ],
    });

    const result = await googlePlaceAutocomplete("Gond", "key");
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0]?.placeId).toBe("ChIJgondia");
    expect(result.data?.[0]?.primary).toBe("Gondia");
    expect(result.data?.[0]?.secondary).toBe("Maharashtra, India");
    // A prediction is not a place. Coordinates come from Place Details.
    expect(result.data?.[0]).not.toHaveProperty("latitude");
  });

  it("hits the v1 autocomplete endpoint and sends no field mask", async () => {
    const spy = captureFetch({ suggestions: [] });
    await googlePlaceAutocomplete("Gond", "key");

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://places.googleapis.com/v1/places:autocomplete");
    // The Autocomplete (New) endpoint rejects a field mask.
    expect((init as RequestInit).headers).not.toHaveProperty("X-Goog-FieldMask");
  });

  it("refuses a one-character input without calling Google", async () => {
    const spy = captureFetch({ suggestions: [] });
    const result = await googlePlaceAutocomplete("G", "key");

    expect(spy).not.toHaveBeenCalled();
    expect(result.data).toBeNull();
    expect(result.meta.reason).toMatch(/two characters/i);
  });

  it("drops a prediction with no Place ID rather than emitting an unusable row", async () => {
    captureFetch({
      suggestions: [
        { placePrediction: { text: { text: "No id here" } } },
        { placePrediction: { placeId: "ok", text: { text: "Gondia" } } },
      ],
    });

    const result = await googlePlaceAutocomplete("Gond", "key");
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0]?.placeId).toBe("ok");
  });
});

// ---------------------------------------------------------------------------

describe("place details", () => {
  it("resolves a Place ID to coordinates", async () => {
    captureFetch({
      id: "ChIJgondia",
      displayName: { text: "Gondia" },
      formattedAddress: "Gondia, Maharashtra, India",
      location: { latitude: 21.46, longitude: 80.19 },
      types: ["locality"],
    });

    const result = await googlePlaceDetails("ChIJgondia", "key");
    expect(result.data?.latitude).toBeCloseTo(21.46);
    expect(result.data?.placeId).toBe("ChIJgondia");
  });

  it("REJECTS a Place ID containing path traversal, without calling Google", async () => {
    const spy = captureFetch({});
    // The id goes into a URL path. A slash-bearing value must never get there.
    const result = await googlePlaceDetails("../../v1/places:searchText", "key");

    expect(spy).not.toHaveBeenCalled();
    expect(result.data).toBeNull();
    expect(result.meta.reason).toMatch(/not valid/i);
  });

  it("rejects an empty or absurdly long Place ID", async () => {
    const spy = captureFetch({});
    expect((await googlePlaceDetails("", "key")).data).toBeNull();
    expect((await googlePlaceDetails("x".repeat(600), "key")).data).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("routing endpoints", () => {
  it("names an endpoint by Place ID when the place has one", async () => {
    const spy = captureFetch({
      routes: [{ distanceMeters: 61000, duration: "4200s" }],
    });

    await googleRoute(GONDIA, GONDIA, "key");

    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    // A Place ID is unambiguous; a coordinate can snap to the wrong side of a
    // divided road.
    expect(body.origin).toEqual({ placeId: "ChIJgondia" });
  });

  it("falls back to coordinates for a place with no Place ID", async () => {
    const spy = captureFetch({ routes: [{ distanceMeters: 61000, duration: "4200s" }] });

    await googleRoute(BALAGHAT, GONDIA, "key");

    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    // OpenStreetMap places have no Place ID and must not be given a fake one.
    expect(body.origin.location.latLng.latitude).toBeCloseTo(21.81);
    expect(body.destination).toEqual({ placeId: "ChIJgondia" });
  });

  it("returns a real distance and duration, and a drawable path", async () => {
    // "gck|B" is a valid short encoded polyline.
    captureFetch({
      routes: [
        {
          distanceMeters: 61234,
          duration: "4200s",
          polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC" },
        },
      ],
    });

    const result = await googleRoute(BALAGHAT, GONDIA, "key");
    expect(result.data?.distanceKm).toBe(61.2);
    expect(result.data?.durationMinutes).toBe(70);
    expect((result.data?.geometry?.length ?? 0)).toBeGreaterThan(1);
  });

  it("returns UNAVAILABLE rather than a zero distance when Google finds no route", async () => {
    captureFetch({ routes: [] });
    const result = await googleRoute(BALAGHAT, GONDIA, "key");
    expect(result.data).toBeNull();
    expect(result.meta.freshness).toBe("UNAVAILABLE");
  });

  it("only asks for traffic-aware routing on DRIVE", async () => {
    const spy = captureFetch({ routes: [{ distanceMeters: 100, duration: "60s" }] });

    await googleRoute(BALAGHAT, GONDIA, "key", "WALK");
    const walk = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    // TRAFFIC_AWARE is rejected by the Routes API for non-driving modes.
    expect(walk.routingPreference).toBeUndefined();
    expect(walk.travelMode).toBe("WALK");
  });
});

// ---------------------------------------------------------------------------

describe("location store", () => {
  it("keeps each user's position separate", () => {
    const store = new LocationStore();
    store.set("user-a", { latitude: 21.46, longitude: 80.19 });
    store.set("user-b", { latitude: 51.5, longitude: -0.12 });

    expect(store.get("user-a")?.latitude).toBeCloseTo(21.46);
    expect(store.get("user-b")?.latitude).toBeCloseTo(51.5);
    // The whole tenant-isolation claim reduces to this: an id with no entry
    // gets null, never someone else's fix.
    expect(store.get("user-c")).toBeNull();
  });

  it("expires a fix rather than answering with a stale one", () => {
    const store = new LocationStore(0);
    store.set("user-a", { latitude: 21.46, longitude: 80.19 });
    // A TTL of zero has already elapsed by the time we read.
    expect(store.get("user-a")).toBeNull();
  });

  it("refuses impossible coordinates", () => {
    const store = new LocationStore();
    expect(store.set("u", { latitude: 91, longitude: 0 })).toBe(false);
    expect(store.set("u", { latitude: 0, longitude: 181 })).toBe(false);
    expect(store.set("u", { latitude: Number.NaN, longitude: 0 })).toBe(false);
    expect(store.get("u")).toBeNull();
  });

  it("accepts the edges of the real coordinate range", () => {
    const store = new LocationStore();
    expect(store.set("u", { latitude: -90, longitude: 180 })).toBe(true);
    expect(store.get("u")?.longitude).toBe(180);
  });

  it("forgets a position on demand", () => {
    const store = new LocationStore();
    store.set("u", { latitude: 21.46, longitude: 80.19 });
    store.clear("u");
    // "Stop sharing" has to actually stop sharing.
    expect(store.get("u")).toBeNull();
  });

  it("stays bounded, so a long-lived process cannot grow without limit", () => {
    const store = new LocationStore(60_000, 3);
    for (const id of ["a", "b", "c", "d"]) {
      store.set(id, { latitude: 1, longitude: 1 });
    }
    expect(store.size()).toBe(3);
    expect(store.get("a")).toBeNull();
    expect(store.get("d")).not.toBeNull();
  });

  it("never exposes coordinates through size()", () => {
    const store = new LocationStore();
    store.set("u", { latitude: 21.46, longitude: 80.19 });
    expect(typeof store.size()).toBe("number");
  });
});

// ---------------------------------------------------------------------------

describe("usage metering at the provider boundary", () => {
  const realGuard = getMapsUsageGuard();

  afterEach(() => {
    setMapsUsageGuard(realGuard);
  });

  /** A guard stub that records what it was asked and can be forced to block. */
  function installGuard(blocked: boolean) {
    const recorded: Array<{ userId: string; service: string }> = [];
    setMapsUsageGuard({
      async check() {
        return {
          allowed: !blocked,
          status: {
            period: "2026-09",
            used: blocked ? 70_000 : 10,
            limit: 70_000,
            percentUsed: blocked ? 100 : 0,
            level: blocked ? "BLOCKED" : "OK",
            blocked,
            message: blocked ? "Google Maps monthly usage limit reached." : "ok",
          },
        };
      },
      async record(userId: string, service: string) {
        recorded.push({ userId, service });
      },
    } as never);
    return recorded;
  }

  it("counts a real call against the authenticated user and the right service", async () => {
    const recorded = installGuard(false);
    captureFetch({
      status: "OK",
      results: [
        {
          formatted_address: "Gondia, Maharashtra, India",
          geometry: { location: { lat: 21.46, lng: 80.19 } },
        },
      ],
    });

    await googleGeocode("Gondia", "key", 1, { userId: "user-a" });
    expect(recorded).toEqual([{ userId: "user-a", service: "geocoding" }]);
  });

  it("does NOT count a cache hit", async () => {
    const recorded = installGuard(false);
    captureFetch({
      status: "OK",
      results: [
        {
          formatted_address: "Gondia, Maharashtra, India",
          geometry: { location: { lat: 21.46, lng: 80.19 } },
        },
      ],
    });

    await googleGeocode("Gondia", "key", 1, { userId: "user-a" });
    await googleGeocode("Gondia", "key", 1, { userId: "user-a" });

    // A cache hit costs Google nothing. Charging budget for it would block a
    // deployment early for requests that were never billed.
    expect(recorded).toHaveLength(1);
  });

  it("makes NO network call once blocked", async () => {
    installGuard(true);
    const spy = captureFetch({ status: "OK", results: [] });

    const result = await googleGeocode("Gondia", "key", 1, { userId: "user-a" });

    // The whole point of the guard: the request never leaves the process.
    expect(spy).not.toHaveBeenCalled();
    expect(result.data).toBeNull();
    expect(result.meta.reason).toContain("Google Maps monthly usage limit reached.");
  });

  it("does not consume budget for a request it blocked", async () => {
    const recorded = installGuard(true);
    captureFetch({ status: "OK", results: [] });

    await googleGeocode("Gondia", "key", 1, { userId: "user-a" });
    expect(recorded).toHaveLength(0);
  });

  it("blocks every metered service, not just geocoding", async () => {
    installGuard(true);
    const spy = captureFetch({ places: [] });

    const results = await Promise.all([
      googlePlaceSearch("cafes", "key", undefined, 5, { userId: "u" }),
      googlePlaceAutocomplete("Gond", "key", undefined, 5, { userId: "u" }),
      googlePlaceDetails("ChIJgondia", "key", { userId: "u" }),
      googleRoute(BALAGHAT, GONDIA, "key", "DRIVE", { userId: "u" }),
    ]);

    expect(spy).not.toHaveBeenCalled();
    for (const result of results) {
      expect(result.data).toBeNull();
      expect(result.meta.reason).toContain("monthly usage limit reached");
    }
  });

  it("attributes an unauthenticated call to 'system' rather than dropping it", async () => {
    const recorded = installGuard(false);
    captureFetch({
      status: "OK",
      results: [
        {
          formatted_address: "Gondia",
          geometry: { location: { lat: 21.46, lng: 80.19 } },
        },
      ],
    });

    await googleGeocode("Gondia", "key", 1);
    // Still counted against the global limit; only the attribution differs.
    expect(recorded).toEqual([{ userId: "system", service: "geocoding" }]);
  });

  it("is inert with no guard installed — metering is not a dependency", async () => {
    setMapsUsageGuard(null);
    captureFetch({
      status: "OK",
      results: [
        {
          formatted_address: "Gondia",
          geometry: { location: { lat: 21.46, lng: 80.19 } },
        },
      ],
    });

    const result = await googleGeocode("Gondia", "key", 1, { userId: "u" });
    expect(result.data?.[0]?.name).toContain("Gondia");
  });

  it("never lets the limit message carry a key", async () => {
    installGuard(true);
    captureFetch({ status: "OK", results: [] });

    const result = await googleGeocode("Gondia", "AIzaSyFAKE_SECRET_KEY", 1, { userId: "u" });
    expect(JSON.stringify(result)).not.toContain("AIzaSyFAKE_SECRET_KEY");
  });
});
