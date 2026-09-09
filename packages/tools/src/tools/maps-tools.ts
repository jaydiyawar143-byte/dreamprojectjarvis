import { BaseTool } from "../base-tool.js";
import type { ToolResult, ToolContext } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Google Maps tools — ALL READ-ONLY
// ---------------------------------------------------------------------------
// These are the ONLY way a model reaches Google Maps. The raw Places, Routes
// and Geocoding calls live behind `MapsPort`, implemented in the API against
// the server key; a model can ask for "a route from Balaghat to Gondia" but
// never for an arbitrary URL, a field mask, or a key.
//
// Every tool is READ_ONLY with permission ["read"], so ToolApprovalService
// auto-approves it — the same treatment the Meta and Google Ads read tools get.
// Nothing here is a side effect: no map query changes state anywhere.
//
// LOCATION IS NEVER A MODEL PARAMETER.
//
// `maps.current.location` takes no arguments at all, and the "near me" bias on
// search and nearby is read from the CONTEXT, not from params. That is the
// whole tenant-isolation story for this feature: the coordinates come from a
// server-side store keyed on the authenticated `context.userId`, so a model —
// or a user crafting a message — cannot ask for another person's position, and
// cannot claim to be somewhere they are not in order to bias a search.
// ---------------------------------------------------------------------------

/** A resolved point on the map. Mirrors the API's `Place`. */
export interface MapsPlace {
  name: string;
  latitude: number;
  longitude: number;
  type?: string;
  placeId?: string;
  attribution: string;
}

export interface MapsRoute {
  from: MapsPlace;
  to: MapsPlace;
  distanceKm: number;
  durationMinutes: number;
  geometry?: Array<[number, number]>;
  attribution: string;
}

/**
 * What every port call returns.
 *
 * `data: null` with a `reason` is a normal outcome, not an exception — an
 * unfound place and an exceeded quota are both things the user should be told
 * plainly. `source` names the provider that actually answered, so a result from
 * OpenStreetMap is never reported to the model as a Google one.
 */
export interface MapsOutcome<T> {
  data: T | null;
  source: string;
  reason?: string;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/**
 * The server-owned Maps capability.
 *
 * Implemented in the API over the Google server key (with an OpenStreetMap
 * fallback). Declared here as a port so `@jarvis/tools` stays free of HTTP,
 * keys and provider choice — the same shape as the Meta and Google Ads
 * provider ports.
 */
/**
 * The trailing `userId` on every method is ATTRIBUTION for the monthly usage
 * counter, not authorization. It is always `context.userId` — the authenticated
 * caller — so a model cannot attribute its spending to somebody else. It is
 * optional because the port must stay usable in tests that have no counter, and
 * because an unattributed call still counts against the global limit.
 */
export interface MapsPort {
  geocode(query: string, limit?: number, userId?: string): Promise<MapsOutcome<MapsPlace[]>>;
  reverseGeocode(
    latitude: number,
    longitude: number,
    userId?: string
  ): Promise<MapsOutcome<MapsPlace>>;
  searchPlaces(
    query: string,
    near?: Coordinates,
    limit?: number,
    userId?: string
  ): Promise<MapsOutcome<MapsPlace[]>>;
  getPlace(placeId: string, userId?: string): Promise<MapsOutcome<MapsPlace>>;
  route(
    from: MapsPlace,
    to: MapsPlace,
    options: { travelMode?: string; geometry?: boolean },
    userId?: string
  ): Promise<MapsOutcome<MapsRoute>>;
}

/**
 * Where a user's current position comes from.
 *
 * Keyed on the AUTHENTICATED user id and resolved server-side. The browser
 * publishes its position on an authenticated request; nothing a model emits can
 * reach this. Returns null when there is no recent fix, which the tools report
 * as "ask the user to enable location" rather than guessing a city.
 */
export interface CurrentLocationPort {
  get(userId: string): Promise<Coordinates | null>;
}

const MAX_LIMIT = 10;

/** Clamps a model-supplied count into a range that cannot run up a bill. */
function clampLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}

function asQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Two characters is the provider floor; 200 is far past any real place name
  // and stops a whole document being posted through as a "query".
  if (trimmed.length < 2 || trimmed.length > 200) return null;
  return trimmed;
}

abstract class BaseMapsTool extends BaseTool {
  protected readonly maps: MapsPort;
  protected readonly location: CurrentLocationPort;

  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[],
    maps: MapsPort,
    location: CurrentLocationPort
  ) {
    super(id, name, description, "research", parameters, false, ["read"], "READ_ONLY", "1.0.0", true);
    this.maps = maps;
    this.location = location;
  }

  /** A provider outcome that carries no data, turned into a tool failure. */
  protected fromOutcome(outcome: { reason?: string; source: string }, fallback: string): ToolResult {
    return this.failure(outcome.reason ?? fallback);
  }

  /**
   * Resolves an endpoint the way a person would name one.
   *
   * A Place ID wins over a name, because it is unambiguous — "Gondia" is a
   * city, a district and a station, and re-geocoding a label the user already
   * picked is how a route quietly ends up between the wrong two points.
   */
  protected async resolveEndpoint(
    value: string,
    placeId: string | null,
    context: ToolContext
  ): Promise<{ place: MapsPlace } | { error: ToolResult }> {
    if (placeId) {
      const found = await this.maps.getPlace(placeId, context.userId);
      if (found.data) return { place: found.data };
      return { error: this.fromOutcome(found, "That place could not be resolved.") };
    }

    // "my location" / "here" resolves from the server-side fix, never from a
    // guess and never from a coordinate the model supplied.
    if (/^(my location|current location|here|meri location|mera location)$/i.test(value.trim())) {
      const coords = await this.location.get(context.userId);
      if (!coords) {
        return {
          error: this.failure(
            "No current location is available. Ask the user to allow location access in the map widget, then try again."
          ),
        };
      }
      const here = await this.maps.reverseGeocode(coords.latitude, coords.longitude, context.userId);
      return {
        place: here.data ?? {
          name: "Current location",
          latitude: coords.latitude,
          longitude: coords.longitude,
          type: "current",
          attribution: here.source,
        },
      };
    }

    const found = await this.maps.geocode(value, 1, context.userId);
    if (found.data?.[0]) return { place: found.data[0] };
    return { error: this.fromOutcome(found, `No place matched "${value}".`) };
  }
}

// ---------------------------------------------------------------------------
// maps.search — place search
// ---------------------------------------------------------------------------

export class MapsSearchPlaceTool extends BaseMapsTool {
  constructor(maps: MapsPort, location: CurrentLocationPort) {
    super(
      "maps.search",
      "Search Places",
      "Search the map for a city, address, business, landmark, restaurant, hotel or airport. Set nearMe to true to bias results to the user's current location.",
      [
        { name: "query", type: "string", description: "What to look for, e.g. 'Gondia' or 'cafes'", required: true },
        { name: "nearMe", type: "boolean", description: "Bias results to the user's current location", required: false },
        { name: "limit", type: "number", description: "How many results (1-10, default 5)", required: false },
      ],
      maps,
      location
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = asQuery(params.query);
    if (!query) return this.failure("Provide a place to search for (2-200 characters).");

    const near =
      params.nearMe === true ? await this.location.get(context.userId) : null;
    if (params.nearMe === true && !near) {
      return this.failure(
        "No current location is available, so results cannot be biased to the user. Ask them to allow location access, or search by place name."
      );
    }

    const found = await this.maps.searchPlaces(
      query,
      near ?? undefined,
      clampLimit(params.limit, 5),
      context.userId
    );
    if (!found.data) return this.fromOutcome(found, `No place matched "${query}".`);

    return this.success(
      { query, places: found.data, count: found.data.length },
      { source: found.source, readOnly: true }
    );
  }
}

// ---------------------------------------------------------------------------
// maps.nearby — places near the user
// ---------------------------------------------------------------------------

export class MapsNearbySearchTool extends BaseMapsTool {
  constructor(maps: MapsPort, location: CurrentLocationPort) {
    super(
      "maps.nearby",
      "Find Places Nearby",
      "Find places of a given kind near the user's current location — restaurants, cafes, petrol pumps, hospitals, the nearest airport. Requires the user to have allowed location access.",
      [
        { name: "query", type: "string", description: "What kind of place, e.g. 'restaurants' or 'airport'", required: true },
        { name: "limit", type: "number", description: "How many results (1-10, default 5)", required: false },
      ],
      maps,
      location
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = asQuery(params.query);
    if (!query) return this.failure("Provide what kind of place to look for (2-200 characters).");

    const near = await this.location.get(context.userId);
    if (!near) {
      return this.failure(
        "No current location is available. Ask the user to allow location access in the map widget, then try again."
      );
    }

    const found = await this.maps.searchPlaces(query, near, clampLimit(params.limit, 5), context.userId);
    if (!found.data) return this.fromOutcome(found, `Nothing matching "${query}" was found nearby.`);

    return this.success(
      { query, places: found.data, count: found.data.length },
      { source: found.source, readOnly: true, nearCurrentLocation: true }
    );
  }
}

// ---------------------------------------------------------------------------
// maps.geocode — name → coordinates
// ---------------------------------------------------------------------------

export class MapsGeocodeTool extends BaseMapsTool {
  constructor(maps: MapsPort, location: CurrentLocationPort) {
    super(
      "maps.geocode",
      "Resolve Place",
      "Turn a place name or address into coordinates. Use this when you need a precise location for a named place.",
      [
        { name: "query", type: "string", description: "Place name or address", required: true },
        { name: "limit", type: "number", description: "How many candidates (1-10, default 3)", required: false },
      ],
      maps,
      location
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = asQuery(params.query);
    if (!query) return this.failure("Provide a place name or address (2-200 characters).");

    const found = await this.maps.geocode(query, clampLimit(params.limit, 3), context.userId);
    if (!found.data) return this.fromOutcome(found, `No place matched "${query}".`);

    // More than one strong candidate is itself the answer: the caller should
    // ask which one rather than silently taking the first.
    return this.success(
      { query, places: found.data, count: found.data.length, ambiguous: found.data.length > 1 },
      { source: found.source, readOnly: true }
    );
  }
}

// ---------------------------------------------------------------------------
// maps.reverse.geocode — coordinates → address
// ---------------------------------------------------------------------------

export class MapsReverseGeocodeTool extends BaseMapsTool {
  constructor(maps: MapsPort, location: CurrentLocationPort) {
    super(
      "maps.reverse.geocode",
      "Describe Coordinates",
      "Turn a latitude and longitude into a human-readable address.",
      [
        { name: "latitude", type: "number", description: "Latitude, -90 to 90", required: true },
        { name: "longitude", type: "number", description: "Longitude, -180 to 180", required: true },
      ],
      maps,
      location
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const lat = Number(params.latitude);
    const lng = Number(params.longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return this.failure("Latitude must be a number between -90 and 90.");
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      return this.failure("Longitude must be a number between -180 and 180.");
    }

    const found = await this.maps.reverseGeocode(lat, lng, context.userId);
    if (!found.data) return this.fromOutcome(found, "No address was found for that location.");

    return this.success({ place: found.data }, { source: found.source, readOnly: true });
  }
}

// ---------------------------------------------------------------------------
// maps.current.location — where the user is
// ---------------------------------------------------------------------------

/**
 * Takes NO parameters, deliberately.
 *
 * The user id comes from the authenticated context, so there is nothing for a
 * model to supply and nothing to spoof. A user with no recent browser fix gets
 * a clear "ask them to enable it" — never an invented city.
 */
export class MapsCurrentLocationTool extends BaseMapsTool {
  constructor(maps: MapsPort, location: CurrentLocationPort) {
    super(
      "maps.current.location",
      "Current Location",
      "Get the user's current location, if they have allowed location access in the dashboard. Takes no arguments.",
      [],
      maps,
      location
    );
  }

  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const coords = await this.location.get(context.userId);
    if (!coords) {
      return this.failure(
        "No current location is available. Ask the user to allow location access in the map widget, then try again."
      );
    }

    const here = await this.maps.reverseGeocode(coords.latitude, coords.longitude, context.userId);
    return this.success(
      {
        latitude: coords.latitude,
        longitude: coords.longitude,
        // A failed reverse geocode is cosmetic — the coordinates are still
        // real, and inventing an address for them would not be.
        address: here.data?.name ?? null,
      },
      { source: here.data ? here.source : "browser geolocation", readOnly: true }
    );
  }
}

// ---------------------------------------------------------------------------
// maps.route — a drawn route
// ---------------------------------------------------------------------------

export class MapsRouteTool extends BaseMapsTool {
  constructor(maps: MapsPort, location: CurrentLocationPort) {
    super(
      "maps.route",
      "Route Between Places",
      "Calculate a real route between two places and return its distance, duration and path so the map can draw it. Use 'my location' as the origin to start from the user's current position.",
      [
        { name: "from", type: "string", description: "Origin place name, or 'my location'", required: true },
        { name: "to", type: "string", description: "Destination place name", required: true },
        { name: "travelMode", type: "string", description: "driving | walking | cycling | transit (default driving)", required: false },
        { name: "fromPlaceId", type: "string", description: "Exact Place ID for the origin, when known", required: false },
        { name: "toPlaceId", type: "string", description: "Exact Place ID for the destination, when known", required: false },
      ],
      maps,
      location
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const from = asQuery(params.from);
    const to = asQuery(params.to);
    if (!from || !to) return this.failure("Provide both an origin and a destination.");

    const origin = await this.resolveEndpoint(
      from,
      typeof params.fromPlaceId === "string" ? params.fromPlaceId : null,
      context
    );
    if ("error" in origin) return origin.error;

    const destination = await this.resolveEndpoint(
      to,
      typeof params.toPlaceId === "string" ? params.toPlaceId : null,
      context
    );
    if ("error" in destination) return destination.error;

    const result = await this.maps.route(
      origin.place,
      destination.place,
      {
        ...(typeof params.travelMode === "string" ? { travelMode: params.travelMode } : {}),
        // The geometry is what the widget draws; a route without it would be
        // the "text only" answer this feature exists to replace.
        geometry: true,
      },
      context.userId
    );
    if (!result.data) {
      return this.fromOutcome(result, "No route was found between those places.");
    }

    return this.success(
      { route: result.data },
      { source: result.source, readOnly: true, drawable: (result.data.geometry?.length ?? 0) > 1 }
    );
  }
}

// ---------------------------------------------------------------------------
// maps.distance — how far, how long
// ---------------------------------------------------------------------------

/**
 * The same upstream call as `maps.route`, without the path.
 *
 * It exists separately because "how far is Gondia from Balaghat" and "show me
 * the route" are different questions with different answers, and giving the
 * model one tool for both led it to dump a polyline into chat.
 */
export class MapsDistanceTool extends BaseMapsTool {
  constructor(maps: MapsPort, location: CurrentLocationPort) {
    super(
      "maps.distance",
      "Distance And Travel Time",
      "Get the real road distance and estimated travel time between two places, without the drawn path. Use 'my location' as the origin to measure from the user's current position.",
      [
        { name: "from", type: "string", description: "Origin place name, or 'my location'", required: true },
        { name: "to", type: "string", description: "Destination place name", required: true },
        { name: "travelMode", type: "string", description: "driving | walking | cycling | transit (default driving)", required: false },
      ],
      maps,
      location
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const from = asQuery(params.from);
    const to = asQuery(params.to);
    if (!from || !to) return this.failure("Provide both an origin and a destination.");

    const origin = await this.resolveEndpoint(from, null, context);
    if ("error" in origin) return origin.error;

    const destination = await this.resolveEndpoint(to, null, context);
    if ("error" in destination) return destination.error;

    const result = await this.maps.route(
      origin.place,
      destination.place,
      {
        ...(typeof params.travelMode === "string" ? { travelMode: params.travelMode } : {}),
        geometry: false,
      },
      context.userId
    );
    if (!result.data) {
      return this.fromOutcome(result, "No route was found between those places.");
    }

    return this.success(
      {
        from: result.data.from.name,
        to: result.data.to.name,
        distanceKm: result.data.distanceKm,
        durationMinutes: result.data.durationMinutes,
      },
      { source: result.source, readOnly: true }
    );
  }
}

// ---------------------------------------------------------------------------
// maps.place — Place ID → place
// ---------------------------------------------------------------------------

export class MapsGetPlaceTool extends BaseMapsTool {
  constructor(maps: MapsPort, location: CurrentLocationPort) {
    super(
      "maps.place",
      "Get Place Details",
      "Resolve an exact Place ID returned by an earlier search into a place with coordinates.",
      [{ name: "placeId", type: "string", description: "Place ID from a previous search result", required: true }],
      maps,
      location
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const placeId = typeof params.placeId === "string" ? params.placeId.trim() : "";
    if (!placeId) return this.failure("Provide a Place ID from a previous search result.");

    const found = await this.maps.getPlace(placeId, context.userId);
    if (!found.data) return this.fromOutcome(found, "That place could not be resolved.");

    return this.success({ place: found.data }, { source: found.source, readOnly: true });
  }
}

/** Registry ids, so the agent policy and the container cannot drift apart. */
export const MAPS_TOOL_IDS = [
  "maps.search",
  "maps.nearby",
  "maps.geocode",
  "maps.reverse.geocode",
  "maps.current.location",
  "maps.route",
  "maps.distance",
  "maps.place",
] as const;

/** Every maps tool, constructed over one provider pair. */
export function createMapsTools(maps: MapsPort, location: CurrentLocationPort): BaseTool[] {
  return [
    new MapsSearchPlaceTool(maps, location),
    new MapsNearbySearchTool(maps, location),
    new MapsGeocodeTool(maps, location),
    new MapsReverseGeocodeTool(maps, location),
    new MapsCurrentLocationTool(maps, location),
    new MapsRouteTool(maps, location),
    new MapsDistanceTool(maps, location),
    new MapsGetPlaceTool(maps, location),
  ];
}
