// ---------------------------------------------------------------------------
// V3 — Google Maps integration.
//
// Two things are pinned here, and they are the two that would quietly go wrong:
//
//   1. KEY SAFETY. The server key must never reach a client, and a Google error
//      must never be forwarded verbatim — Google's `error_message` can echo the
//      key or the referrer straight back.
//
//   2. NO SILENT SUBSTITUTION. When Google is unconfigured, geocoding falls back
//      to OpenStreetMap and says so; the interactive map does NOT fall back to
//      anything, because there is no honest substitute for it.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  isGoogleMapsBrowserConfigured,
  isGoogleMapsServerConfigured,
  createGoogleMapsConfig,
  describeGoogleMapsStatus,
} from "@jarvis/config";
import {
  decodePolyline,
  normalizeTravelMode,
  googleGeocode,
  __resetGoogleMapsCaches,
} from "../src/services/providers/google-maps-provider.js";

afterEach(() => {
  __resetGoogleMapsCaches();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("treats the browser and server keys as separate concerns", () => {
    // Reusing one unrestricted key for both is the common mistake: it turns a
    // referrer-restricted browser key into a billable server credential that
    // anyone can lift out of the page.
    expect(isGoogleMapsBrowserConfigured({})).toBe(false);
    expect(isGoogleMapsBrowserConfigured({ GOOGLE_MAPS_BROWSER_KEY: "b" })).toBe(true);
    expect(isGoogleMapsServerConfigured({ GOOGLE_MAPS_BROWSER_KEY: "b" })).toBe(false);
    expect(isGoogleMapsServerConfigured({ GOOGLE_MAPS_SERVER_KEY: "s" })).toBe(true);
  });

  it("reports the map as unavailable when only the server key exists", () => {
    // Routing would work but nothing could be drawn, and the widget is a map
    // first — so this counts as not configured.
    const status = describeGoogleMapsStatus({ GOOGLE_MAPS_SERVER_KEY: "s" });
    expect(status.configured).toBe(false);
    expect(status.reason).toContain("BROWSER_KEY");
  });

  it("says geocoding falls back when only the browser key exists", () => {
    const status = describeGoogleMapsStatus({ GOOGLE_MAPS_BROWSER_KEY: "b" });
    expect(status.configured).toBe(true);
    expect(status.reason).toMatch(/OpenStreetMap/i);
  });

  it("returns nulls rather than empty strings when unset", () => {
    // "" would let a client load the SDK with an empty key and get an opaque
    // Google error instead of our own message.
    const config = createGoogleMapsConfig({});
    expect(config.browserKey).toBeNull();
    expect(config.serverKey).toBeNull();
  });
});

describe("travel modes", () => {
  it("maps spoken words onto the Routes API enum", () => {
    expect(normalizeTravelMode("walking")).toBe("WALK");
    expect(normalizeTravelMode("Cycle")).toBe("BICYCLE");
    expect(normalizeTravelMode("transit")).toBe("TRANSIT");
    expect(normalizeTravelMode("driving")).toBe("DRIVE");
  });

  it("defaults to driving for anything unrecognised", () => {
    // "How far is X from Y" almost always means by road.
    expect(normalizeTravelMode(undefined)).toBe("DRIVE");
    expect(normalizeTravelMode("teleport")).toBe("DRIVE");
    expect(normalizeTravelMode("")).toBe("DRIVE");
  });
});

describe("polyline decoding", () => {
  it("decodes Google's encoded polyline to [lng, lat] pairs", () => {
    // The example from Google's own documentation:
    // (38.5,-120.2) (40.7,-120.95) (43.252,-126.453)
    const points = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");

    expect(points).toHaveLength(3);
    // Stored [lng, lat] to match the rest of the geo layer.
    expect(points[0]![1]).toBeCloseTo(38.5, 4);
    expect(points[0]![0]).toBeCloseTo(-120.2, 4);
    expect(points[2]![1]).toBeCloseTo(43.252, 3);
    expect(points[2]![0]).toBeCloseTo(-126.453, 3);
  });

  it("returns an empty path for empty input rather than throwing", () => {
    expect(decodePolyline("")).toEqual([]);
  });
});

describe("error handling", () => {
  it("NEVER forwards Google's error message, which can echo the key", async () => {
    // This is the load-bearing test. Google returns `error_message` containing
    // the API key and referrer on a misconfiguration; forwarding it would put
    // the key on screen and in logs.
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "REQUEST_DENIED",
        error_message:
          "This API project is not authorized. Key=AIzaSyFAKE_SECRET_KEY referer=https://example.com",
      }),
    } as Response);

    const result = await googleGeocode("Gondia", "AIzaSyFAKE_SECRET_KEY");

    expect(result.data).toBeNull();
    expect(result.meta.freshness).toBe("UNAVAILABLE");

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("AIzaSyFAKE_SECRET_KEY");
    expect(serialised).not.toContain("error_message");
    // Still actionable, without leaking anything.
    expect(result.meta.reason).toMatch(/Geocoding and Routes APIs/);
  });

  it("distinguishes no-results from a refused request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ZERO_RESULTS", results: [] }),
    } as Response);

    const result = await googleGeocode("qqqqzzzz", "key");
    expect(result.meta.reason).toMatch(/no match/i);
  });

  it("reports a quota failure as such", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ status: "OVER_QUERY_LIMIT" }),
    } as Response);

    const result = await googleGeocode("Gondia", "key");
    expect(result.meta.reason).toMatch(/quota/i);
  });

  it("survives a network failure without inventing a place", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const result = await googleGeocode("Gondia", "key");
    expect(result.data).toBeNull();
    expect(result.meta.freshness).toBe("UNAVAILABLE");
  });

  it("attributes a successful result to Google, not to OpenStreetMap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "OK",
        results: [
          {
            formatted_address: "Gondia, Maharashtra, India",
            geometry: { location: { lat: 21.46, lng: 80.19 } },
            types: ["locality"],
          },
        ],
      }),
    } as Response);

    const result = await googleGeocode("Gondia", "key");
    expect(result.data?.[0]?.name).toContain("Gondia");
    // Every response names the provider that actually answered, so an OSM
    // result is never passed off as Google or the reverse.
    expect(result.meta.source).toBe("Google Maps Platform");
    expect(result.data?.[0]?.attribution).toContain("Google");
  });
});
