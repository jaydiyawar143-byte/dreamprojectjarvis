// ---------------------------------------------------------------------------
// Where a user's current position lives on the server — and for how long.
//
// The map widget knows the browser's coordinates. The maps TOOLS run on the
// server, so "route from my location to Gondia" needs those coordinates to
// cross the gap. This is that crossing, and it is deliberately the narrowest
// one that works.
//
// FOUR PROPERTIES, all of them load-bearing:
//
//   1. IN MEMORY ONLY. Nothing is written to Postgres, to a log line, or to a
//      file. A precise position is among the most sensitive things a user can
//      hand over, and the feature does not need it to survive a restart — the
//      browser simply publishes it again.
//
//   2. SHORT TTL. An entry expires in fifteen minutes. A stale fix answering
//      "where am I" an hour later would be wrong in a way the user cannot see,
//      and holding it longer serves nothing.
//
//   3. KEYED ON THE AUTHENTICATED USER ID. `set` is only ever called with the
//      id the auth middleware resolved, and `get` only with the id on the tool
//      context. There is no code path that takes a user id from a request body
//      or from model output, which is what makes cross-tenant reads impossible
//      rather than merely disallowed.
//
//   4. COARSE IN LOGS, ABSENT FROM RESPONSES. Nothing here logs coordinates,
//      and the store is never serialised into an API response.
//
// The bound on the map exists so a long-lived process cannot accumulate one
// entry per user forever; the oldest entry is dropped once it is reached.
// ---------------------------------------------------------------------------

export interface Coordinates {
  latitude: number;
  longitude: number;
  /** Metres, when the browser reported it. Not used for filtering — recorded. */
  accuracy?: number;
}

interface Entry extends Coordinates {
  expiresAt: number;
}

/** Fifteen minutes. Long enough for a conversation, short enough to be honest. */
export const LOCATION_TTL_MS = 15 * 60 * 1000;

const MAX_USERS = 5000;

export class LocationStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = LOCATION_TTL_MS,
    private readonly maxUsers: number = MAX_USERS
  ) {}

  /**
   * Records the position the browser reported for ONE authenticated user.
   *
   * Rejects anything outside real coordinate ranges rather than storing it: a
   * NaN or a longitude of 900 can only come from a broken client or a crafted
   * request, and either way it must not reach a routing call.
   */
  set(userId: string, coords: Coordinates): boolean {
    if (!userId) return false;
    const { latitude, longitude } = coords;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return false;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return false;

    if (!this.entries.has(userId) && this.entries.size >= this.maxUsers) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }

    this.entries.set(userId, {
      latitude,
      longitude,
      ...(Number.isFinite(coords.accuracy) ? { accuracy: coords.accuracy } : {}),
      expiresAt: Date.now() + this.ttlMs,
    });
    return true;
  }

  /**
   * The user's last known position, or null.
   *
   * Null is a normal outcome — no permission granted, no dashboard open, or the
   * fix aged out. Callers must say so rather than substituting a location.
   */
  get(userId: string): Coordinates | null {
    const hit = this.entries.get(userId);
    if (!hit) return null;

    if (Date.now() >= hit.expiresAt) {
      this.entries.delete(userId);
      return null;
    }

    return {
      latitude: hit.latitude,
      longitude: hit.longitude,
      ...(hit.accuracy !== undefined ? { accuracy: hit.accuracy } : {}),
    };
  }

  /** Forgets one user's position. Backs the "stop sharing" control. */
  clear(userId: string): void {
    this.entries.delete(userId);
  }

  /** Test seam. */
  clearAll(): void {
    this.entries.clear();
  }

  /** How many users currently have a live fix. Never exposes coordinates. */
  size(): number {
    return this.entries.size;
  }
}

/**
 * The process-wide store.
 *
 * A singleton because the tools and the route that feeds them are constructed
 * in different places and must see the same map.
 */
export const locationStore = new LocationStore();
