import { z } from "zod";

// ---------------------------------------------------------------------------
// Contextual surfaces — the wire model.
//
// A surface is a panel JARVIS brings up because a visual answer is genuinely
// better than a sentence: a map for a route, a clock for a time, a price card
// for a quote. It is NOT a dashboard widget. Widgets are the user's permanent
// arrangement; a surface arrives with an answer, stays while it is useful, and
// leaves.
//
// ---------------------------------------------------------------------------
// THIS FILE IS THE SECURITY BOUNDARY.
//
// The model is allowed to decide THAT a surface should appear and WHICH KIND.
// It never authors one. There is no field here that carries HTML, JSX, CSS, a
// URL to execute, or anything else the browser would run — and that is a
// property of the schema, not a convention: `SurfaceSchema` is `.strict()` all
// the way down, so an unrecognised key is a validation failure rather than
// something forwarded to the client and hoped about.
//
// The data itself is not shaped by the model either. Every `data` variant below
// is a closed shape filled in from a tool result or a provider response, so the
// worst a compromised or hallucinating model can do is ask for the wrong KIND
// of surface about the right data — never invent a price, a duration or a
// coordinate.
//
// The split, stated once (see also `surface-decision.ts`):
//
//     the model      decides what visual experience helps
//     the tools      decide where data comes from
//     the backend    decides whether the request is allowed
//     this schema    decides whether the surface is well-formed
//     the frontend   decides how it renders
// ---------------------------------------------------------------------------

/**
 * Every surface JARVIS knows how to render.
 *
 * Adding one is a matter of adding a member here, a data variant below, and a
 * renderer on the client — the engine, the lifecycle and the auto-close rules
 * do not change.
 */
export const SURFACE_TYPES = [
  "clock",
  "world-clock",
  "weather",
  "map",
  "route",
  "place-search",
  "market",
  "system-monitor",
  "tasks",
  "knowledge",
  "generic-data",
  "unavailable",
] as const;

export type SurfaceType = (typeof SURFACE_TYPES)[number];

/**
 * How much of the screen, and how much interaction, the surface expects.
 *
 *   glance      — a reading. Small, informational, closes itself when idle.
 *   interactive — the user is expected to touch it (a map). Never auto-closes
 *                 while it is being touched.
 *   analysis    — a body of reasoning to read. Longer idle timeout, because
 *                 reading is not "inactivity".
 */
export const SurfaceModeSchema = z.enum(["glance", "interactive", "analysis"]);
export type SurfaceMode = z.infer<typeof SurfaceModeSchema>;

/**
 * The lifecycle, as the client drives it.
 *
 * The server only ever emits `opening`. Everything after that is the client's
 * business: the server has no idea whether a pointer is inside the panel.
 */
export const SurfaceStatusSchema = z.enum([
  "opening",
  "active",
  "idle",
  "closing",
  "closed",
]);
export type SurfaceStatus = z.infer<typeof SurfaceStatusSchema>;

/** Where a surface prefers to sit. The client still bounds it to the viewport. */
export const SurfaceAnchorSchema = z.enum([
  "center",
  "orb-side",
  "right",
  "left",
  "top-right",
  "bottom-right",
  "map-primary",
]);
export type SurfaceAnchor = z.infer<typeof SurfaceAnchorSchema>;

/**
 * Provenance, on every surface that shows external data.
 *
 * Deliberately the same vocabulary the dashboard widgets already use, so
 * "where did this come from and how old is it" reads identically whether the
 * user is looking at a permanent widget or a surface that appeared a second
 * ago. A surface carrying provider data without this is rejected below.
 */
export const SurfaceProvenanceSchema = z
  .object({
    /** The provider actually used. Never a guess, never a brand we did not call. */
    source: z.string().min(1).max(80),
    /** When the DATA was observed, not when we fetched it. */
    observedAt: z.string().datetime().optional(),
    freshness: z.enum(["LIVE", "DELAYED", "STALE", "UNAVAILABLE"]),
    /** Why it is unavailable or stale, in the provider's own terms. */
    reason: z.string().max(400).optional(),
  })
  .strict();
export type SurfaceProvenance = z.infer<typeof SurfaceProvenanceSchema>;

/**
 * A control the surface offers.
 *
 * `intent` is a phrase fed back through the ordinary chat path, NOT a function
 * the client is trusted to call: pressing "Alternative route" says the same
 * thing the user could have typed, and it goes through the same orchestrator,
 * the same tools and the same permission checks. That is what stops a surface
 * button becoming a way around the approval system.
 */
export const SurfaceActionSchema = z
  .object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(48),
    intent: z.string().min(1).max(200),
    style: z.enum(["default", "quiet"]).default("default"),
  })
  .strict();
export type SurfaceAction = z.infer<typeof SurfaceActionSchema>;

// ---------------------------------------------------------------------------
// Data variants
//
// One closed shape per surface type. A discriminated union rather than
// `Record<string, unknown>` so the renderer can rely on what it is given and
// the schema can reject a payload that does not match the type it claims.
// ---------------------------------------------------------------------------

const ClockEntrySchema = z
  .object({
    label: z.string().min(1).max(60),
    timeZone: z.string().min(1).max(64),
    /** IANA zone offset in minutes, so the client renders without a lookup. */
    offsetMinutes: z.number().int().min(-840).max(840),
  })
  .strict();

const ClockDataSchema = z
  .object({
    kind: z.literal("clock"),
    /** The clock face(s). One for `clock`, several for `world-clock`. */
    zones: z.array(ClockEntrySchema).min(1).max(6),
    /** 12h/24h follows the user's dashboard preference. */
    hourFormat: z.enum(["12", "24"]).default("24"),
    showAnalog: z.boolean().default(true),
  })
  .strict();

const WeatherDataSchema = z
  .object({
    kind: z.literal("weather"),
    location: z.string().min(1).max(120),
    temperatureC: z.number().nullable(),
    feelsLikeC: z.number().nullable(),
    /** The provider's own condition wording; never our paraphrase. */
    condition: z.string().max(120).nullable(),
    humidityPct: z.number().min(0).max(100).nullable(),
    windKph: z.number().min(0).nullable(),
    provenance: SurfaceProvenanceSchema,
  })
  .strict();

const LatLngSchema = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .strict();

const RouteLegSchema = z
  .object({
    id: z.string().min(1).max(60),
    summary: z.string().max(160),
    distanceMeters: z.number().min(0),
    durationSeconds: z.number().min(0),
    /** Only present when the provider actually returned it. Never inferred. */
    hasTolls: z.boolean().nullable(),
    /** The provider's own traffic-adjusted duration, when it gave one. */
    durationInTrafficSeconds: z.number().min(0).nullable(),
    /** Encoded path for the map to draw. */
    geometry: z.array(LatLngSchema).max(2000),
    recommended: z.boolean(),
    /**
     * Why this one is recommended, in terms of the fields above ONLY.
     *
     * "Fastest by 6 minutes" is derivable. "Safer", "better roads" and
     * "less traffic at this hour" are not, and the decision layer will not
     * produce them — see the note in surface-decision.ts.
     */
    recommendationReason: z.string().max(240).nullable(),
  })
  .strict();

const RouteDataSchema = z
  .object({
    kind: z.literal("route"),
    origin: z.object({ label: z.string().max(160), position: LatLngSchema.nullable() }).strict(),
    destination: z.object({ label: z.string().max(160), position: LatLngSchema.nullable() }).strict(),
    travelMode: z.enum(["driving", "walking", "cycling", "transit"]),
    routes: z.array(RouteLegSchema).min(1).max(5),
    provenance: SurfaceProvenanceSchema,
  })
  .strict();

const PlaceSchema = z
  .object({
    id: z.string().max(200),
    name: z.string().max(160),
    address: z.string().max(300).nullable(),
    position: LatLngSchema.nullable(),
  })
  .strict();

const MapDataSchema = z
  .object({
    kind: z.literal("map"),
    center: LatLngSchema.nullable(),
    zoom: z.number().min(1).max(21).default(12),
    places: z.array(PlaceSchema).max(20),
    provenance: SurfaceProvenanceSchema,
  })
  .strict();

const QuoteSchema = z
  .object({
    symbol: z.string().max(20),
    name: z.string().max(80),
    price: z.number().nullable(),
    currency: z.string().max(8).default("USD"),
    change24hPct: z.number().nullable(),
    marketCap: z.number().nullable(),
    volume24h: z.number().nullable(),
  })
  .strict();

/**
 * A market surface, optionally carrying analysis.
 *
 * The analysis block is prose the model wrote ABOUT numbers the provider
 * returned — never numbers the model wrote. It is kept in clearly separated
 * fields, rather than one paragraph, so the client can label them: a bull case
 * and a fact are different kinds of claim and must not look alike.
 */
const MarketDataSchema = z
  .object({
    kind: z.literal("market"),
    quotes: z.array(QuoteSchema).min(1).max(6),
    analysis: z
      .object({
        /** Statements that restate provider figures. */
        facts: z.array(z.string().max(300)).max(6),
        bullCase: z.array(z.string().max(300)).max(5),
        bearCase: z.array(z.string().max(300)).max(5),
        risks: z.array(z.string().max(300)).max(5),
      })
      .strict()
      .optional(),
    provenance: SurfaceProvenanceSchema,
  })
  .strict();

const MetricSchema = z
  .object({
    label: z.string().max(40),
    /** `null` means the sensor is not exposed. It is NOT zero. */
    value: z.number().nullable(),
    unit: z.string().max(12).default(""),
    /** The provider's reason when the value is null. */
    reason: z.string().max(160).nullable(),
  })
  .strict();

const SystemDataSchema = z
  .object({
    kind: z.literal("system"),
    metrics: z.array(MetricSchema).min(1).max(12),
    provenance: SurfaceProvenanceSchema,
  })
  .strict();

const TasksDataSchema = z
  .object({
    kind: z.literal("tasks"),
    tasks: z
      .array(
        z
          .object({
            id: z.string().max(64),
            title: z.string().max(200),
            dueAt: z.string().max(40).nullable(),
            priority: z.string().max(16),
            done: z.boolean(),
          })
          .strict()
      )
      .max(20),
  })
  .strict();

const KnowledgeDataSchema = z
  .object({
    kind: z.literal("knowledge"),
    summary: z.string().max(4000),
    citations: z
      .array(
        z
          .object({
            documentId: z.string().max(64),
            documentName: z.string().max(200),
            excerpt: z.string().max(600),
          })
          .strict()
      )
      .max(10),
  })
  .strict();

/** The escape hatch: rows of label/value, for a shape with no dedicated surface. */
const GenericDataSchema = z
  .object({
    kind: z.literal("generic"),
    rows: z
      .array(z.object({ label: z.string().max(80), value: z.string().max(300) }).strict())
      .min(1)
      .max(20),
    provenance: SurfaceProvenanceSchema.optional(),
  })
  .strict();

/**
 * An honest failure.
 *
 * §32: when a provider is down, the surface says so. It does NOT fall back to
 * cached-looking numbers, a plausible guess, or an empty card that reads as
 * "nothing to report" — all three teach the user to trust a number that was
 * never measured.
 */
const UnavailableDataSchema = z
  .object({
    kind: z.literal("unavailable"),
    what: z.string().max(120),
    reason: z.string().max(400),
    retryIntent: z.string().max(200).nullable(),
  })
  .strict();

export const SurfaceDataSchema = z.discriminatedUnion("kind", [
  ClockDataSchema,
  WeatherDataSchema,
  RouteDataSchema,
  MapDataSchema,
  MarketDataSchema,
  SystemDataSchema,
  TasksDataSchema,
  KnowledgeDataSchema,
  GenericDataSchema,
  UnavailableDataSchema,
]);
export type SurfaceData = z.infer<typeof SurfaceDataSchema>;

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export const AutoCloseSchema = z
  .object({
    enabled: z.boolean(),
    /**
     * Seconds of INACTIVITY before closing — not seconds since opening.
     *
     * The distinction is the whole feature. A surface that vanishes five
     * seconds after appearing is a bug that looks like a design; one that
     * vanishes five seconds after the user stops using it is the design.
     */
    idleSeconds: z.number().int().min(1).max(600),
  })
  .strict();
export type AutoClose = z.infer<typeof AutoCloseSchema>;

export const SurfaceSchema = z
  .object({
    surfaceId: z.string().min(1).max(64),
    type: z.enum(SURFACE_TYPES),
    mode: SurfaceModeSchema,
    title: z.string().min(1).max(120),
    /** A short line under the title. Never the answer itself — that is spoken. */
    subtitle: z.string().max(200).optional(),
    status: SurfaceStatusSchema.default("opening"),
    /**
     * Whether the surface belongs to the conversation that opened it.
     *
     * A bound surface survives follow-ups: "alternative route?" updates it
     * rather than opening a second map, and the idle timer does not run while
     * the conversation is still about it.
     */
    conversationBound: z.boolean().default(true),
    /**
     * What this surface is ABOUT, for reuse and topic-change decisions.
     *
     * Two surfaces with the same key are the same subject and must reuse one
     * panel; a message that resolves to a different key is a topic change.
     * Keeping it opaque (a string the decision layer builds) means the client
     * needs no domain knowledge to make either judgement.
     */
    contextKey: z.string().min(1).max(160),
    autoClose: AutoCloseSchema,
    position: z.object({ anchor: SurfaceAnchorSchema }).strict(),
    data: SurfaceDataSchema,
    actions: z.array(SurfaceActionSchema).max(6).default([]),
    /** Why JARVIS decided to show this. Audited, and shown on request. */
    reason: z.string().max(300),
  })
  .strict();

export type Surface = z.infer<typeof SurfaceSchema>;

/** A partial update to a live surface. `surfaceId` identifies the target. */
export const SurfacePatchSchema = SurfaceSchema.partial()
  .extend({ surfaceId: z.string().min(1).max(64) })
  .strict();
export type SurfacePatch = z.infer<typeof SurfacePatchSchema>;

/**
 * What the orchestrator attaches to a response.
 *
 * `close` is how "close the map" and a topic change both reach the client
 * without inventing a second channel.
 */
export const SurfaceDirectiveSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("open"), surface: SurfaceSchema }).strict(),
  z.object({ op: z.literal("update"), patch: SurfacePatchSchema }).strict(),
  z
    .object({
      op: z.literal("close"),
      /** Absent means "whatever is open", which is what "close it" means. */
      surfaceId: z.string().max(64).optional(),
      reason: z.string().max(200),
    })
    .strict(),
]);
export type SurfaceDirective = z.infer<typeof SurfaceDirectiveSchema>;

/**
 * Validates a directive that arrived from anywhere less trusted than this file.
 *
 * Returns the parsed value or a list of problems — never throws, because the
 * caller's correct response to a malformed surface is to answer WITHOUT one,
 * not to fail the user's question.
 */
export function parseSurfaceDirective(
  value: unknown
): { ok: true; directive: SurfaceDirective } | { ok: false; errors: string[] } {
  const result = SurfaceDirectiveSchema.safeParse(value);
  if (result.success) return { ok: true, directive: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}
