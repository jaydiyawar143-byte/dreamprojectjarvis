// ---------------------------------------------------------------------------
// V3 — Command Center data surface.
//
// One router for the live widgets: weather, markets, geo, system, tasks and
// preferences. They share a router because they share the same three rules, and
// keeping them together is what stops the rules drifting apart per widget:
//
//   1. EVERY response carries provider metadata (freshness, observedAt, source).
//      There is no shape in which a number arrives without a verdict on how
//      current it is, so a widget cannot render stale data as live.
//
//   2. NOTHING IS FABRICATED. A provider that cannot answer returns
//      data: null with a reason. No zeros, no placeholders.
//
//   3. EVERY route is auth-gated and user-scoped. Tasks and preferences filter
//      on the authenticated userId from the token — never on anything the
//      client sends.
//
// Third-party calls happen HERE, not in the browser: it keeps any future API
// key server-side, keeps the user's coordinates off third-party servers under
// their own IP, and lets one cache serve every open tab.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { JARVIS_TASK_CREATOR } from "@jarvis/core";
import type {
  PrismaMapsUsageRepository,
  PrismaPreferenceRepository,
  PrismaTaskRepository,
} from "@jarvis/db";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import { getWeather } from "../services/providers/weather-provider.js";
import {
  createIndicesConfig,
  getIndianIndices,
  getTopCrypto,
  isIndicesConfigured,
} from "../services/providers/market-provider.js";
import {
  autocomplete,
  geocode,
  resolvePlaceId,
  reverseGeocode,
  route as routeBetween,
  routePlaces,
  searchNearby,
} from "../services/providers/geo-provider.js";
import { locationStore } from "../services/location-store.js";
import { getMapsUsageGuard } from "../services/maps-usage-guard.js";
import {
  createGoogleMapsConfig,
  describeGoogleMapsStatus,
  isGoogleMapsBrowserConfigured,
} from "@jarvis/config";
import { refreshSlow, snapshot } from "../services/providers/system-monitor.js";
import type { ProviderResult } from "../services/providers/freshness.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CoordSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

/**
 * A position published by the browser's Geolocation API.
 *
 * Spelled out rather than reusing CoordSchema because this one is a JSON body
 * with the browser's own field names, and because it must reject a coordinate
 * out of range at the edge rather than letting an impossible latitude reach a
 * routing call.
 */
const PositionSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Metres. Recorded when present; never used to reject a fix. */
  accuracy: z.number().nonnegative().max(1_000_000).optional(),
});

const TaskCreateSchema = z.object({
  title: z.string().trim().min(1, "A title is required").max(300),
  description: z.string().trim().max(4000).optional(),
  // Accepts an ISO instant. Rejecting a bad date here means a task can never be
  // stored with a due time nobody can interpret.
  dueAt: z.string().datetime({ offset: true }).optional().nullable(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
});

const TaskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  completed: z.boolean().optional(),
});

/**
 * Preferences are validated, not stored blind.
 *
 * This document is written by the client and read back on every dashboard load;
 * accepting arbitrary JSON would let one user store unbounded data in a shared
 * table. `.strict()` also means a typo in a key is reported rather than
 * silently persisted and never read.
 */
const PreferencesSchema = z
  .object({
    clockMode: z.enum(["DIGITAL", "ANALOG"]).optional(),
    hourFormat: z.enum(["12", "24"]).optional(),
    weatherLocation: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        label: z.string().trim().max(120).optional(),
      })
      .nullable()
      .optional(),
    // Widget layout: position, size and visibility.
    //
    // Bounded on every axis. This document is written by the client and read on
    // every dashboard load, so an unbounded array would let one user store
    // arbitrary data in a table every user shares. The server does NOT validate
    // widget ids against a list — the client repairs unknown ids on read, which
    // means shipping a new widget does not require a coordinated API deploy.
    //
    // TWO SHAPES, because two versions of the client have written this column.
    //
    //   V4 — {x, y, w, h} on a 12-column grid. What the dashboard writes now.
    //   V3 — {size: {w, h}} with the order carried by the array. Still in the
    //        database for anyone who saved a layout before the free-form grid,
    //        and still accepted so their row keeps validating; the client
    //        migrates it on read.
    //
    // The union is not decoration. This schema is `.strict()`, so before V4 was
    // added here the new payload was REJECTED WHOLESALE — the dashboard saved,
    // the request 400'd, and the next load quietly served the old layout back.
    // "Save, reload, unchanged" looked like a front-end persistence bug and was
    // this object.
    //
    // The bounds mirror GRID_COLS (12) and MAX_ROWS (32) in the web app. They
    // are duplicated rather than imported: the API does not depend on the web
    // package, and this limit's job is to stop unbounded values reaching the
    // database, not to re-state the client's layout rules.
    //
    // It must stay at or above the client's ceiling. When it sat below — 20
    // here against 32 there — a deep arrangement failed validation, the save
    // 400'd, and the dashboard silently served the previous layout on the next
    // load. A row bound that is too tight does not correct a layout; it
    // discards one.
    layout: z
      .array(
        z.union([
          z
            .object({
              id: z.string().trim().max(40),
              x: z.number().int().min(0).max(12),
              y: z.number().int().min(0).max(32),
              w: z.number().int().min(1).max(12),
              h: z.number().int().min(1).max(32),
              hidden: z.boolean().optional(),
            })
            .strict(),
          z
            .object({
              id: z.string().trim().max(40),
              size: z.object({ w: z.number().int().min(1).max(4), h: z.number().int().min(1).max(3) }),
              hidden: z.boolean().optional(),
            })
            .strict(),
        ])
      )
      .max(32)
      .optional(),
    // Retained from the first V3 pass so a preference written by that build
    // still validates rather than being rejected wholesale.
    widgets: z.array(z.string().trim().max(40)).max(32).optional(),
    hiddenWidgets: z.array(z.string().trim().max(40)).max(32).optional(),
  })
  .strict();

export function createCommandCenterRouter(
  container: Container,
  deps: {
    tasks: PrismaTaskRepository;
    preferences: PrismaPreferenceRepository;
    /** Absent on a deployment without usage tracking; the route says so. */
    mapsUsage?: PrismaMapsUsageRepository;
  }
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  function ok(res: Response, data: unknown, status = 200): void {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
  }

  function fail(res: Response, status: number, code: string, message: string, details?: unknown): void {
    res.status(status).json({
      success: false,
      error: { code, message, ...(details ? { details } : {}) },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Sends a provider result.
   *
   * Always HTTP 200, even when the provider is UNAVAILABLE. That is deliberate:
   * "this machine has no temperature sensor" is a successful answer to the
   * question, not a server error, and returning 5xx would make the client's
   * error path fire for a normal state. The verdict lives in `meta.freshness`.
   */
  function sendProvider<T>(res: Response, result: ProviderResult<T>): void {
    ok(res, { value: result.data, meta: result.meta });
  }

  // -------------------------------------------------------------------------
  // Weather
  // -------------------------------------------------------------------------
  router.get("/weather", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    // An explicit coordinate wins; otherwise the user's stored preference.
    let lat: number | undefined;
    let lon: number | undefined;
    let label: string | undefined;

    const parsed = CoordSchema.safeParse(req.query);
    if (parsed.success) {
      lat = parsed.data.lat;
      lon = parsed.data.lon;
    } else {
      const prefs = await deps.preferences.get(req.auth.userId);
      const stored = prefs?.weatherLocation as
        | { latitude?: number; longitude?: number; label?: string }
        | undefined;
      if (typeof stored?.latitude === "number" && typeof stored?.longitude === "number") {
        lat = stored.latitude;
        lon = stored.longitude;
        label = stored.label;
      }
    }

    if (lat === undefined || lon === undefined) {
      return ok(res, {
        value: null,
        meta: {
          freshness: "UNAVAILABLE",
          observedAt: new Date().toISOString(),
          ageSeconds: 0,
          source: "Open-Meteo",
          reason: "No location set. Allow location access or choose a place in settings.",
        },
      });
    }

    sendProvider(res, await getWeather(lat, lon, label));
  });

  // -------------------------------------------------------------------------
  // Markets
  // -------------------------------------------------------------------------
  router.get("/markets/crypto", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    const count = Math.min(Math.max(Number(req.query.count ?? 3) || 3, 1), 10);
    sendProvider(res, await getTopCrypto(count));
  });

  router.get("/markets/indices", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    // Returns UNAVAILABLE with a reason when no licensed provider is set, which
    // is this deployment's normal state.
    sendProvider(res, await getIndianIndices(createIndicesConfig()));
  });

  // -------------------------------------------------------------------------
  // Geo
  // -------------------------------------------------------------------------
  router.get("/geo/search", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const q = typeof req.query.q === "string" ? req.query.q : "";
    const near = CoordSchema.safeParse(req.query);

    sendProvider(
      res,
      near.success
        ? await searchNearby(q, near.data.lat, near.data.lon, 8, { userId: req.auth.userId })
        : await geocode(q, 5, { userId: req.auth.userId })
    );
  });

  // -------------------------------------------------------------------------
  // Routing.
  //
  // Accepts either display strings or Place IDs. IDs win when both are given:
  // "Gondia" names a city, a district and a railway station, and re-geocoding
  // a label the user already picked from a suggestion list is how a route
  // quietly ends up between two different places from the ones on screen.
  // -------------------------------------------------------------------------
  router.get("/geo/route", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    const fromPlaceId = typeof req.query.fromPlaceId === "string" ? req.query.fromPlaceId : "";
    const toPlaceId = typeof req.query.toPlaceId === "string" ? req.query.toPlaceId : "";

    if ((!from && !fromPlaceId) || (!to && !toPlaceId)) {
      return fail(res, 400, "INVALID_REQUEST", "Both an origin and a destination are required");
    }

    const options = {
      geometry: req.query.geometry === "true",
      ...(typeof req.query.mode === "string" ? { travelMode: req.query.mode } : {}),
    };

    // No Place IDs at all: the plain name-based path, unchanged.
    if (!fromPlaceId && !toPlaceId) {
      return sendProvider(res, await routeBetween(from, to, options, { userId: req.auth.userId }));
    }

    // At least one endpoint is an ID. Resolve both to places first, so the
    // route is computed between exactly what the caller named.
    const usage = { userId: req.auth.userId };
    const origin = fromPlaceId
      ? await resolvePlaceId(fromPlaceId, usage)
      : await geocode(from, 1, usage);
    const originPlace = Array.isArray(origin.data) ? origin.data[0] : origin.data;
    if (!originPlace) {
      return sendProvider(res, { data: null, meta: origin.meta });
    }

    const destination = toPlaceId
      ? await resolvePlaceId(toPlaceId, usage)
      : await geocode(to, 1, usage);
    const destinationPlace = Array.isArray(destination.data) ? destination.data[0] : destination.data;
    if (!destinationPlace) {
      return sendProvider(res, { data: null, meta: destination.meta });
    }

    sendProvider(res, await routePlaces(originPlace, destinationPlace, options, usage));
  });

  // -------------------------------------------------------------------------
  // Type-ahead suggestions.
  //
  // Separate from /geo/search because the two cost different things: this one
  // fires while the user is still typing, so the CLIENT debounces and this
  // endpoint refuses anything under two characters. Suggestions are never
  // cached server-side — see the provider for why.
  // -------------------------------------------------------------------------
  router.get("/geo/autocomplete", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const input = typeof req.query.q === "string" ? req.query.q : "";
    if (input.trim().length < 2) {
      return fail(res, 400, "INVALID_REQUEST", "Type at least two characters");
    }

    const near = CoordSchema.safeParse(req.query);
    sendProvider(
      res,
      await autocomplete(
        input,
        near.success ? { latitude: near.data.lat, longitude: near.data.lon } : undefined,
        5,
        { userId: req.auth.userId }
      )
    );
  });

  // -------------------------------------------------------------------------
  // Place ID -> a place with coordinates.
  //
  // What turns a picked suggestion into something routable. The id is validated
  // in the provider before it is ever put in a URL path.
  // -------------------------------------------------------------------------
  router.get("/geo/place/:placeId", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const placeId = req.params.placeId ?? "";
    if (!placeId) return fail(res, 400, "INVALID_REQUEST", "A place id is required");

    sendProvider(res, await resolvePlaceId(placeId, { userId: req.auth.userId }));
  });

  // -------------------------------------------------------------------------
  // The browser publishing its own position.
  //
  // This is the ONLY way a coordinate reaches the server for tool use, and it
  // is deliberately a small door:
  //
  //   - It is authenticated, and stored against `req.auth.userId`. A caller
  //     cannot name a different user, so no request can plant a position in
  //     someone else's session or read one out of it.
  //   - Nothing is persisted. It lands in an in-memory store with a fifteen
  //     minute TTL (see location-store.ts).
  //   - Nothing is logged. Not the coordinates, not the accuracy.
  //   - DELETE forgets it immediately, so "stop sharing" is real rather than
  //     just a UI state.
  //
  // The response deliberately echoes nothing back. There is no reason for the
  // server to tell a client where it just said it was, and a response body is
  // one more place a coordinate could end up in a proxy log.
  // -------------------------------------------------------------------------
  router.post("/geo/location", requireAuth, (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const parsed = PositionSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, "INVALID_REQUEST", "Valid latitude and longitude are required");
    }

    const stored = locationStore.set(req.auth.userId, {
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      ...(parsed.data.accuracy !== undefined ? { accuracy: parsed.data.accuracy } : {}),
    });
    if (!stored) {
      return fail(res, 400, "INVALID_REQUEST", "Valid latitude and longitude are required");
    }

    ok(res, { accepted: true });
  });

  router.delete("/geo/location", requireAuth, (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    locationStore.clear(req.auth.userId);
    ok(res, { cleared: true });
  });

  // -------------------------------------------------------------------------
  // Reverse geocoding — the label on the current-location marker.
  //
  // PRIVACY. The coordinates arrive from an AUTHENTICATED caller, are used only
  // to answer this request, and are never persisted. They are not written to the
  // audit log either: a precise position is exactly the kind of thing that
  // should not accumulate in a log file. The provider cache rounds to three
  // decimals (~110m) before keying, so process memory holds no precise trail.
  // -------------------------------------------------------------------------
  router.get("/geo/reverse", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const parsed = CoordSchema.safeParse(req.query);
    if (!parsed.success) {
      return fail(res, 400, "INVALID_REQUEST", "Valid lat and lon are required");
    }

    // Google when a server key exists, Nominatim otherwise. Previously this
    // returned UNAVAILABLE without a key, which left the current-location
    // marker unlabelled on every deployment that had only a browser key —
    // for a lookup OpenStreetMap answers perfectly well. `meta.source` names
    // whichever one replied.
    sendProvider(res, await reverseGeocode(parsed.data.lat, parsed.data.lon, { userId: req.auth.userId }));
  });

  // -------------------------------------------------------------------------
  // Maps configuration for the browser.
  //
  // The Maps JavaScript API key HAS to reach the browser — there is no way to
  // render a Google map without it — so it is not a secret. It is served from
  // here, behind authentication, rather than inlined as NEXT_PUBLIC_* into a
  // static bundle that anyone could fetch without logging in. Its real
  // protection is an HTTP-referrer restriction in the Google console.
  //
  // The SERVER key is never included in this response, only whether one exists.
  // -------------------------------------------------------------------------
  router.get("/maps/config", requireAuth, (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const config = createGoogleMapsConfig();
    const status = describeGoogleMapsStatus();

    ok(res, {
      // null, not "", so a client cannot accidentally load the SDK with an
      // empty key and get an opaque Google error instead of our own message.
      browserKey: config.browserKey,
      mapsAvailable: Boolean(config.browserKey),
      // Tells the UI whether route/search results will come from Google or from
      // OpenStreetMap, so it can label them truthfully.
      serverGeoAvailable: Boolean(config.serverKey),
      reason: status.reason,
    });
  });

  // -------------------------------------------------------------------------
  // Google Maps usage.
  //
  // Counts only. No key, no coordinates, no query text — there is nothing in
  // this response that would be sensitive if it were logged by a proxy.
  //
  // The per-user breakdown is ADMIN-ONLY, because "which user is generating the
  // most map traffic" is a fact about other people. Every authenticated caller
  // sees the global figures (they need to know why their map stopped working)
  // and their OWN consumption; only OWNER and ADMIN see the leaderboard.
  // -------------------------------------------------------------------------
  router.get("/maps/usage", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const guard = getMapsUsageGuard();
    if (!guard || !deps.mapsUsage) {
      return ok(res, {
        available: false,
        reason: "Usage tracking is not configured on this deployment.",
      });
    }

    try {
      const status = await guard.status();
      const isAdmin = req.auth.role === "owner" || req.auth.role === "admin";

      const [byService, mine, lastRequestAt, byUser] = await Promise.all([
        deps.mapsUsage.byService(status.period),
        deps.mapsUsage.totalForUser(status.period, req.auth.userId),
        deps.mapsUsage.lastRequestAt(status.period),
        isAdmin ? deps.mapsUsage.byUser(status.period, 10) : Promise.resolve(null),
      ]);

      ok(res, {
        available: true,
        period: status.period,
        used: status.used,
        limit: status.limit,
        percentUsed: status.percentUsed,
        level: status.level,
        blocked: status.blocked,
        message: status.message,
        byService,
        yourUsage: mine,
        lastRequestAt: lastRequestAt ? lastRequestAt.toISOString() : null,
        ...(byUser ? { byUser } : {}),
        // Stated in the payload, not just in a doc, so an operator reading the
        // admin panel cannot mistake this for their actual Google bill.
        note: "Counts server-side Places, Geocoding and Routes calls made by JARVIS. Map tile loads are billed by Google in the browser and are not visible here. This is a JARVIS safety limit, not a replacement for a Google Cloud budget and quota cap.",
      });
    } catch {
      // A counter that cannot be read is reported as such, never as zero — a
      // zero here would read as "no usage" and hide a real problem.
      fail(res, 503, "USAGE_UNAVAILABLE", "Usage figures could not be read.");
    }
  });

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------
  router.get("/system", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    // The slow (WMI-backed) tier is refreshed opportunistically rather than
    // awaited: on a cold first call it returns nulls with reasons, and the
    // socket stream fills them in a moment later. Awaiting ~3.4s of WMI here
    // would make the dashboard feel broken on load.
    void refreshSlow();

    ok(res, {
      value: snapshot(),
      meta: {
        freshness: "LIVE",
        observedAt: new Date().toISOString(),
        ageSeconds: 0,
        source: "host",
      },
    });
  });

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------
  router.get("/tasks", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    try {
      const includeCompleted = req.query.includeCompleted === "true";
      // Core V1.1 boundary: this is the TODO surface, so it reads todos only.
      //
      // Without this filter JARVIS work tasks rendered in the dashboard Tasks
      // widget as if they were todos — and a scheduled work task, which is
      // PENDING, was exactly what the widget showed and offered a delete
      // button for. The two surfaces read disjoint sets of the same table;
      // `task.list` passes the mirror-image `createdBy` filter.
      const tasks = await deps.tasks.list(req.auth.userId, {
        includeCompleted,
        excludeCreatedBy: JARVIS_TASK_CREATOR,
      });
      ok(res, { tasks });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not load tasks");
    }
  });

  router.post("/tasks", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const parsed = TaskCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, "INVALID_REQUEST", "Invalid task", parsed.error.flatten().fieldErrors);
    }

    try {
      const task = await deps.tasks.create(req.auth.userId, {
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
        priority: parsed.data.priority ?? "NORMAL",
      });
      await container.auditLogger?.log({
        userId: req.auth.userId,
        action: "task.create",
        result: "success",
        metadata: { taskId: task.id },
      });
      ok(res, { task }, 201);
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not create the task");
    }
  });

  router.patch("/tasks/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const parsed = TaskUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, "INVALID_REQUEST", "Invalid update", parsed.error.flatten().fieldErrors);
    }

    try {
      const task = await deps.tasks.updateOwned(req.auth.userId, req.params.id!, {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.dueAt !== undefined
          ? { dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null }
          : {}),
        ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
        ...(parsed.data.completed !== undefined ? { completed: parsed.data.completed } : {}),
      }, {
        // A JARVIS work task is not this surface's to edit. Scheduler V1
        // re-plans from the title at run time, so a rename here would change
        // what a scheduled task does between agreeing it and running it.
        excludeCreatedBy: JARVIS_TASK_CREATOR,
      });

      // Null means "no such task, not yours, or not this surface's to edit".
      // Deliberately one message for all three, so this cannot be used to
      // probe another user's task ids — or to find out which ids are work.
      if (!task) return fail(res, 404, "NOT_FOUND", "Task not found");
      ok(res, { task });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not update the task");
    }
  });

  router.delete("/tasks/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    try {
      // A JARVIS work task is not this surface's to delete, so it is filtered
      // out in the WHERE clause and comes back as "not found" — the same
      // answer another user's task gets, which is also what stops this being
      // used to probe which ids are work tasks.
      const removed = await deps.tasks.deleteOwned(req.auth.userId, req.params.id!, {
        excludeCreatedBy: JARVIS_TASK_CREATOR,
      });
      if (!removed) return fail(res, 404, "NOT_FOUND", "Task not found");
      ok(res, { deleted: true });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not delete the task");
    }
  });

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------
  router.get("/preferences", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    try {
      ok(res, { preferences: (await deps.preferences.get(req.auth.userId)) ?? {} });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not load preferences");
    }
  });

  router.put("/preferences", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const parsed = PreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, "INVALID_REQUEST", "Invalid preferences", parsed.error.flatten().fieldErrors);
    }

    try {
      await deps.preferences.put(req.auth.userId, parsed.data as Record<string, unknown>);
      ok(res, { preferences: parsed.data });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not save preferences");
    }
  });

  // -------------------------------------------------------------------------
  // Capability report
  //
  // Lets the client render only the widgets this deployment can actually feed,
  // instead of shipping a widget that always says "unavailable".
  // -------------------------------------------------------------------------
  router.get("/capabilities", requireAuth, (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    ok(res, {
      weather: true,
      crypto: true,
      indices: isIndicesConfigured(),
      // Geocoding and routing always work: Google when configured, OpenStreetMap
      // otherwise. `maps` is the separate question of whether an INTERACTIVE map
      // can be drawn, which needs a browser key and has no fallback.
      geo: true,
      maps: isGoogleMapsBrowserConfigured(),
      system: true,
      tasks: true,
    });
  });

  return router;
}
