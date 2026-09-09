// ---------------------------------------------------------------------------
// Google Maps tools.
//
// The security claim these tools make is narrow and testable: A MODEL CANNOT
// CHOOSE A LOCATION. Coordinates are read from the authenticated tool context,
// never from parameters, so no prompt and no crafted message can read another
// user's position or claim to be somewhere it is not.
//
// The honesty claim is the other half: a tool that cannot answer says so. It
// never returns a plausible distance, never rounds a guess into kilometres, and
// never substitutes a city for a missing fix — those are the failures a user has
// no way to catch.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ToolContext } from "@jarvis/core";
import {
  MAPS_TOOL_IDS,
  MapsCurrentLocationTool,
  MapsDistanceTool,
  MapsGeocodeTool,
  MapsGetPlaceTool,
  MapsNearbySearchTool,
  MapsReverseGeocodeTool,
  MapsRouteTool,
  MapsSearchPlaceTool,
  createMapsTools,
  type Coordinates,
  type CurrentLocationPort,
  type MapsPlace,
  type MapsPort,
} from "../src/tools/maps-tools.js";

const GONDIA: MapsPlace = {
  name: "Gondia, Maharashtra, India",
  latitude: 21.46,
  longitude: 80.19,
  placeId: "ChIJgondia",
  attribution: "Map data ©2026 Google",
};

const BALAGHAT: MapsPlace = {
  name: "Balaghat, Madhya Pradesh, India",
  latitude: 21.81,
  longitude: 80.18,
  attribution: "Map data ©2026 Google",
};

function ctx(userId = "user-a"): ToolContext {
  return { userId, traceId: "t-1" };
}

/** A port that records what it was asked, so parameters can be asserted. */
function makeMaps(overrides: Partial<MapsPort> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string, impl: (...args: never[]) => unknown) =>
    (...args: never[]) => {
      calls.push({ method, args });
      return impl(...args);
    };

  const base: MapsPort = {
    geocode: record("geocode", async () => ({ data: [GONDIA], source: "Google Maps Platform" })),
    reverseGeocode: record("reverseGeocode", async () => ({
      data: { ...GONDIA, type: "current" },
      source: "Google Maps Platform",
    })),
    searchPlaces: record("searchPlaces", async () => ({
      data: [GONDIA],
      source: "Google Maps Platform",
    })),
    getPlace: record("getPlace", async () => ({ data: GONDIA, source: "Google Maps Platform" })),
    route: record("route", async () => ({
      data: {
        from: BALAGHAT,
        to: GONDIA,
        distanceKm: 61.2,
        durationMinutes: 70,
        geometry: [
          [80.18, 21.81],
          [80.19, 21.46],
        ] as Array<[number, number]>,
        attribution: "Map data ©2026 Google",
      },
      source: "Google Maps Platform",
    })),
    ...overrides,
  };

  return { maps: base, calls };
}

function makeLocation(fixes: Record<string, Coordinates | null> = {}): CurrentLocationPort {
  return {
    get: async (userId: string) => fixes[userId] ?? null,
  };
}

// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers exactly the documented tool ids", () => {
    const tools = createMapsTools(makeMaps().maps, makeLocation());
    expect(tools.map((t) => t.id).sort()).toEqual([...MAPS_TOOL_IDS].sort());
  });

  it("makes every maps tool READ_ONLY and free of approval", () => {
    // A map query changes nothing anywhere. If one of these ever needs
    // approval, it is because it stopped being a read — and this fails first.
    for (const tool of createMapsTools(makeMaps().maps, makeLocation())) {
      expect(tool.risk).toBe("READ_ONLY");
      expect(tool.requiresApproval).toBe(false);
      expect(tool.requiredPermissions).toEqual(["read"]);
    }
  });

  it("exposes no parameter that could carry a location", () => {
    // The load-bearing check. `nearMe` is a boolean; nothing here accepts a
    // latitude, a longitude or a user id from the model.
    for (const tool of createMapsTools(makeMaps().maps, makeLocation())) {
      if (tool.id === "maps.reverse.geocode") continue; // explicitly takes a point
      const names = tool.parameters.map((p) => p.name);
      expect(names).not.toContain("latitude");
      expect(names).not.toContain("longitude");
      expect(names).not.toContain("userId");
      expect(names).not.toContain("location");
    }
  });
});

// ---------------------------------------------------------------------------

describe("location is never a model parameter", () => {
  it("reads the current location from the AUTHENTICATED user, not from params", async () => {
    const location = makeLocation({ "user-a": { latitude: 21.1, longitude: 79.1 } });
    const spy = vi.spyOn(location, "get");
    const tool = new MapsCurrentLocationTool(makeMaps().maps, location);

    await tool.execute({ userId: "user-b", latitude: 0, longitude: 0 }, ctx("user-a"));

    // Whatever the model put in params, the lookup used the context id.
    expect(spy).toHaveBeenCalledWith("user-a");
    expect(spy).not.toHaveBeenCalledWith("user-b");
  });

  it("cannot read another user's position", async () => {
    const location = makeLocation({ "user-b": { latitude: 51.5, longitude: -0.12 } });
    const tool = new MapsCurrentLocationTool(makeMaps().maps, location);

    const result = await tool.execute({ userId: "user-b" }, ctx("user-a"));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("51.5");
  });

  it("takes no parameters at all", () => {
    const tool = new MapsCurrentLocationTool(makeMaps().maps, makeLocation());
    expect(tool.parameters).toHaveLength(0);
  });

  it("says location is unavailable rather than naming a city", async () => {
    const tool = new MapsCurrentLocationTool(makeMaps().maps, makeLocation());
    const result = await tool.execute({}, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/allow location access/i);
  });

  it("returns real coordinates with a null address when reverse geocoding fails", async () => {
    const { maps } = makeMaps({
      reverseGeocode: async () => ({ data: null, source: "OSM", reason: "unreachable" }),
    });
    const tool = new MapsCurrentLocationTool(
      maps,
      makeLocation({ "user-a": { latitude: 21.1, longitude: 79.1 } })
    );

    const result = await tool.execute({}, ctx());
    const data = result.data as { latitude: number; address: string | null };

    // The coordinates are real; the address is absent rather than invented.
    expect(data.latitude).toBeCloseTo(21.1);
    expect(data.address).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("nearby search", () => {
  it("biases to the authenticated user's own position", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsNearbySearchTool(
      maps,
      makeLocation({ "user-a": { latitude: 21.1, longitude: 79.1 } })
    );

    await tool.execute({ query: "restaurants" }, ctx("user-a"));

    const call = calls.find((c) => c.method === "searchPlaces")!;
    expect(call.args[1]).toEqual({ latitude: 21.1, longitude: 79.1 });
  });

  it("refuses rather than searching a guessed area", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsNearbySearchTool(maps, makeLocation());

    const result = await tool.execute({ query: "restaurants" }, ctx());

    expect(result.success).toBe(false);
    // No upstream call at all — a "near me" search with no "me" is not a
    // search over the whole world.
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("place search", () => {
  it("clamps a limit the model asked for", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsSearchPlaceTool(maps, makeLocation());

    await tool.execute({ query: "cafes", limit: 9999 }, ctx());

    // Cost control: an unbounded page size is a bill, not a feature.
    expect(calls[0]!.args[2]).toBeLessThanOrEqual(10);
  });

  it("rejects a one-character query without an upstream call", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsSearchPlaceTool(maps, makeLocation());

    const result = await tool.execute({ query: "x" }, ctx());
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects a query long enough to be a pasted document", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsSearchPlaceTool(maps, makeLocation());

    const result = await tool.execute({ query: "a".repeat(5000) }, ctx());
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports the provider that actually answered", async () => {
    const { maps } = makeMaps({
      searchPlaces: async () => ({ data: [BALAGHAT], source: "OpenStreetMap / Nominatim" }),
    });
    const tool = new MapsSearchPlaceTool(maps, makeLocation());

    const result = await tool.execute({ query: "Balaghat" }, ctx());
    // An OpenStreetMap result must never reach the model labelled as Google.
    expect(result.metadata?.source).toBe("OpenStreetMap / Nominatim");
  });

  it("passes the provider's own reason through instead of inventing one", async () => {
    const { maps } = makeMaps({
      searchPlaces: async () => ({
        data: null,
        source: "Google Maps Platform",
        reason: "The Google Maps quota for this project has been exceeded.",
      }),
    });
    const tool = new MapsSearchPlaceTool(maps, makeLocation());

    const result = await tool.execute({ query: "cafes" }, ctx());
    expect(result.error).toMatch(/quota/i);
  });

  it("refuses a nearMe search when there is no fix", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsSearchPlaceTool(maps, makeLocation());

    const result = await tool.execute({ query: "cafes", nearMe: true }, ctx());
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("geocoding", () => {
  it("flags several candidates as ambiguous rather than picking one", async () => {
    const { maps } = makeMaps({
      geocode: async () => ({
        data: [GONDIA, { ...GONDIA, name: "Gondia Junction railway station", placeId: "ChIJstation" }],
        source: "Google Maps Platform",
      }),
    });
    const tool = new MapsGeocodeTool(maps, makeLocation());

    const result = await tool.execute({ query: "Gondia" }, ctx());
    // The agent prompt tells the model to ask which one; this is the signal
    // it acts on.
    expect((result.data as { ambiguous: boolean }).ambiguous).toBe(true);
  });

  it("rejects an out-of-range latitude on reverse geocoding", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsReverseGeocodeTool(maps, makeLocation());

    const result = await tool.execute({ latitude: 91, longitude: 0 }, ctx());
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-numeric coordinate", async () => {
    const { maps } = makeMaps();
    const tool = new MapsReverseGeocodeTool(maps, makeLocation());

    const result = await tool.execute({ latitude: "north", longitude: 0 }, ctx());
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("routing", () => {
  it("returns a drawable path", async () => {
    const { maps } = makeMaps();
    const tool = new MapsRouteTool(maps, makeLocation());

    const result = await tool.execute({ from: "Balaghat", to: "Gondia" }, ctx());
    expect(result.success).toBe(true);
    // The whole point of maps.route over maps.distance: the widget draws this.
    expect(result.metadata?.drawable).toBe(true);
  });

  it("prefers a Place ID over the display string", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsRouteTool(maps, makeLocation());

    await tool.execute(
      { from: "Balaghat", to: "Gondia", toPlaceId: "ChIJgondia" },
      ctx()
    );

    // "Gondia" is a city, a district and a station; the id says which.
    expect(calls.some((c) => c.method === "getPlace" && c.args[0] === "ChIJgondia")).toBe(true);
  });

  it("resolves 'my location' from the server-side fix", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsRouteTool(
      maps,
      makeLocation({ "user-a": { latitude: 21.1, longitude: 79.1 } })
    );

    const result = await tool.execute({ from: "my location", to: "Gondia" }, ctx("user-a"));

    expect(result.success).toBe(true);
    expect(calls.some((c) => c.method === "reverseGeocode")).toBe(true);
  });

  it("resolves the Hinglish phrasing too", async () => {
    const { maps } = makeMaps();
    const tool = new MapsRouteTool(
      maps,
      makeLocation({ "user-a": { latitude: 21.1, longitude: 79.1 } })
    );

    const result = await tool.execute({ from: "meri location", to: "Gondia" }, ctx("user-a"));
    expect(result.success).toBe(true);
  });

  it("refuses 'my location' with no fix, rather than guessing an origin", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsRouteTool(maps, makeLocation());

    const result = await tool.execute({ from: "my location", to: "Gondia" }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/allow location access/i);
    expect(calls.some((c) => c.method === "route")).toBe(false);
  });

  it("reports an unfound place instead of routing to something else", async () => {
    const { maps } = makeMaps({
      geocode: async () => ({ data: null, source: "Google Maps Platform", reason: 'No place matched "Xyzzy".' }),
    });
    const tool = new MapsRouteTool(maps, makeLocation());

    const result = await tool.execute({ from: "Xyzzy", to: "Gondia" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Xyzzy/);
  });

  it("returns UNAVAILABLE when no route exists, never a zero distance", async () => {
    const { maps } = makeMaps({
      route: async () => ({ data: null, source: "Google Maps Platform", reason: "No route." }),
    });
    const tool = new MapsRouteTool(maps, makeLocation());

    const result = await tool.execute({ from: "Balaghat", to: "Gondia" }, ctx());
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('"distanceKm":0');
  });

  it("passes the requested travel mode through", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsRouteTool(maps, makeLocation());

    await tool.execute({ from: "Balaghat", to: "Gondia", travelMode: "walking" }, ctx());

    expect((calls.find((c) => c.method === "route")!.args[2] as { travelMode: string }).travelMode).toBe(
      "walking"
    );
  });
});

// ---------------------------------------------------------------------------

describe("distance", () => {
  it("asks for no geometry, so a polyline cannot end up in chat", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsDistanceTool(maps, makeLocation());

    await tool.execute({ from: "Balaghat", to: "Gondia" }, ctx());

    expect((calls.find((c) => c.method === "route")!.args[2] as { geometry: boolean }).geometry).toBe(
      false
    );
  });

  it("returns the numbers and the resolved names, and nothing else", async () => {
    const { maps } = makeMaps();
    const tool = new MapsDistanceTool(maps, makeLocation());

    const result = await tool.execute({ from: "Balaghat", to: "Gondia" }, ctx());
    expect(result.data).toEqual({
      from: "Balaghat, Madhya Pradesh, India",
      to: "Gondia, Maharashtra, India",
      distanceKm: 61.2,
      durationMinutes: 70,
    });
  });
});

// ---------------------------------------------------------------------------

describe("place details", () => {
  it("requires a place id", async () => {
    const { maps, calls } = makeMaps();
    const tool = new MapsGetPlaceTool(maps, makeLocation());

    const result = await tool.execute({ placeId: "   " }, ctx());
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the provider's reason when a place cannot be resolved", async () => {
    const { maps } = makeMaps({
      getPlace: async () => ({
        data: null,
        source: "Google Maps Platform",
        reason: "That place reference is not valid.",
      }),
    });
    const tool = new MapsGetPlaceTool(maps, makeLocation());

    const result = await tool.execute({ placeId: "../../evil" }, ctx());
    expect(result.error).toMatch(/not valid/i);
  });
});

// ---------------------------------------------------------------------------

describe("no upstream call is made for invalid input", () => {
  let calls: Array<{ method: string; args: unknown[] }>;

  beforeEach(() => {
    calls = [];
  });

  it("validates before spending a request", async () => {
    const made = makeMaps();
    calls = made.calls;
    const tools = [
      new MapsSearchPlaceTool(made.maps, makeLocation()),
      new MapsGeocodeTool(made.maps, makeLocation()),
      new MapsRouteTool(made.maps, makeLocation()),
      new MapsDistanceTool(made.maps, makeLocation()),
    ];

    for (const tool of tools) {
      await tool.execute({}, ctx());
    }

    // Every one of these is a billable call avoided.
    expect(calls).toHaveLength(0);
  });
});
