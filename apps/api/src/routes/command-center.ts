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
import type { PrismaPreferenceRepository, PrismaTaskRepository } from "@jarvis/db";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import { getWeather } from "../services/providers/weather-provider.js";
import {
  createIndicesConfig,
  getIndianIndices,
  getTopCrypto,
  isIndicesConfigured,
} from "../services/providers/market-provider.js";
import { geocode, route as routeBetween, searchNearby } from "../services/providers/geo-provider.js";
import { googleReverseGeocode } from "../services/providers/google-maps-provider.js";
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
    // Widget layout: order, size and visibility.
    //
    // Bounded on every axis. This document is written by the client and read on
    // every dashboard load, so an unbounded array would let one user store
    // arbitrary data in a table every user shares. The server does NOT validate
    // widget ids against a list — the client repairs unknown ids on read, which
    // means shipping a new widget does not require a coordinated API deploy.
    layout: z
      .array(
        z
          .object({
            id: z.string().trim().max(40),
            size: z.object({ w: z.number().int().min(1).max(4), h: z.number().int().min(1).max(3) }),
            hidden: z.boolean().optional(),
          })
          .strict()
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
  deps: { tasks: PrismaTaskRepository; preferences: PrismaPreferenceRepository }
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
      near.success ? await searchNearby(q, near.data.lat, near.data.lon) : await geocode(q)
    );
  });

  router.get("/geo/route", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    if (!from || !to) {
      return fail(res, 400, "INVALID_REQUEST", "Both 'from' and 'to' are required");
    }

    sendProvider(
      res,
      await routeBetween(from, to, {
        geometry: req.query.geometry === "true",
        ...(typeof req.query.mode === "string" ? { travelMode: req.query.mode } : {}),
      })
    );
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

    const config = createGoogleMapsConfig();
    if (!config.serverKey) {
      return ok(res, {
        value: null,
        meta: {
          freshness: "UNAVAILABLE",
          observedAt: new Date().toISOString(),
          ageSeconds: 0,
          source: "Google Maps Platform",
          reason: "Reverse geocoding needs GOOGLE_MAPS_SERVER_KEY.",
        },
      });
    }

    sendProvider(res, await googleReverseGeocode(parsed.data.lat, parsed.data.lon, config.serverKey));
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
      const tasks = await deps.tasks.list(req.auth.userId, { includeCompleted });
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
      });

      // Null means "no such task, or not yours". Deliberately one message for
      // both, so this cannot be used to probe another user's task ids.
      if (!task) return fail(res, 404, "NOT_FOUND", "Task not found");
      ok(res, { task });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not update the task");
    }
  });

  router.delete("/tasks/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    try {
      const removed = await deps.tasks.deleteOwned(req.auth.userId, req.params.id!);
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
