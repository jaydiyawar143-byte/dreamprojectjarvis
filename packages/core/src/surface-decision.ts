import type { ToolExecutionResult } from "./types/execution.js";
import type { RetrievedChunk } from "./types/knowledge-retrieval.js";
import {
  SurfaceSchema,
  type Surface,
  type SurfaceDirective,
  type SurfaceProvenance,
  type SurfaceType,
} from "./types/surface.js";
import { getSurfaceDefinition } from "./surface-registry.js";
import { detectVisualIntent, isFollowUp, MIN_CONFIDENCE, type VisualIntent } from "./surface-intent.js";

// ---------------------------------------------------------------------------
// The decision layer.
//
// Turns "what did the user ask" + "what did the tools actually return" into a
// surface, or into nothing at all.
//
// ---------------------------------------------------------------------------
// THE ONE RULE THAT MATTERS.
//
// A surface is built ONLY from data a tool returned. Not from the model's
// answer, not from the message, not from a plausible default. If the user asks
// for a route and no route tool ran — or it ran and failed — the outcome is an
// `unavailable` surface saying so, never a map with a guessed line on it.
//
// This is what makes the feature safe to ship. The model chooses whether a
// picture helps; it never supplies what is IN the picture. Every number,
// coordinate, duration and price below is read out of a `ToolExecutionResult`
// and re-validated against the schema before it leaves.
//
// The corollary is that this file will frequently decide NOT to open anything,
// and that is correct. A missing surface costs a picture. A fabricated one
// costs the user's trust in every number JARVIS has ever shown them.
// ---------------------------------------------------------------------------

export interface SurfaceDecisionInput {
  message: string;
  /** Results from the tools the orchestrator actually ran, in order. */
  toolResults: ToolExecutionResult[];
  /** `contextKey`s of surfaces already on screen, for reuse and topic change. */
  activeContextKeys?: string[];
  /**
   * Recent USER messages, oldest first, for follow-ups that carry no subject.
   *
   * "Tokyo bhi" means "Tokyo as well" — as well as the cities already on the
   * clock. Those cities are not in this message and are not in the surface key
   * either; they are in what the user said a moment ago. Reading them back is
   * the difference between a world clock that accumulates and one that forgets
   * London the instant Tokyo is mentioned.
   */
  recentUserMessages?: string[];
  /**
   * What RAG retrieved for this turn, if anything.
   *
   * Passed in rather than re-fetched: these are the exact passages the model
   * was shown, which is what makes a citation on screen checkable rather than
   * merely plausible. Re-running retrieval here would cost a second embedding
   * call and could return a different set, so the panel and the answer would
   * cite different things.
   */
  knowledge?: {
    chunks: RetrievedChunk[];
    retrievedAt: string | null;
    outcome: "retrieved" | "empty" | "skipped" | "disabled" | "failed";
  };
  /** The user's clock preference, so a clock surface matches their dashboard. */
  hourFormat?: "12" | "24";
  /** Injected for tests. */
  now?: Date;
  /** Injected for tests; ids must be stable within a decision. */
  idFactory?: () => string;
}

export interface SurfaceDecision {
  directive: SurfaceDirective | null;
  /** Always populated, including when nothing opens — this is the audit trail. */
  rationale: {
    intent: VisualIntent;
    confidence: number;
    /** Why a surface was or was not produced, in one line. */
    outcome: string;
  };
}

// ---------------------------------------------------------------------------
// Reading tool output
// ---------------------------------------------------------------------------

/** The successful result of a given tool, if it ran. */
function toolData(results: ToolExecutionResult[], toolId: string): Record<string, unknown> | null {
  for (const r of results) {
    if (r.toolId !== toolId) continue;
    if (r.status !== "completed" || !r.result?.success) continue;
    const data = r.result.data;
    if (data && typeof data === "object") return data as Record<string, unknown>;
  }
  return null;
}

/** Whether a tool ran and failed, as distinct from never having run. */
function toolFailure(results: ToolExecutionResult[], toolId: string): string | null {
  for (const r of results) {
    if (r.toolId !== toolId) continue;
    if (r.status === "completed" && r.result?.success) continue;
    return r.result?.error ?? r.error ?? "The provider did not answer.";
  }
  return null;
}

/** Provenance from a tool's own metadata. Never invented. */
function provenanceOf(
  results: ToolExecutionResult[],
  toolId: string,
  fallbackSource: string
): SurfaceProvenance {
  const entry = results.find((r) => r.toolId === toolId);
  const meta = entry?.result?.metadata as Record<string, unknown> | undefined;
  const source = typeof meta?.source === "string" ? meta.source : fallbackSource;
  const observedAt = typeof meta?.observedAt === "string" ? meta.observedAt : undefined;
  return {
    source,
    freshness: "LIVE",
    ...(observedAt ? { observedAt } : {}),
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

// ---------------------------------------------------------------------------
// Builders — one per surface, each reading a specific tool's output
// ---------------------------------------------------------------------------

const DEFAULT_ZONE = "UTC";

/**
 * Zone offsets computed here rather than shipped as a time.
 *
 * The surface carries ZONES, not a timestamp: the client renders the current
 * time itself, every second, from its own clock. A time serialised on the
 * server would be wrong by the network latency the moment it arrived, and
 * visibly wrong within a minute — a clock that is a little bit wrong is worse
 * than no clock.
 */
function zoneEntry(label: string, timeZone: string, now: Date): { label: string; timeZone: string; offsetMinutes: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    const part = fmt.formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
    const sign = m?.[1] === "-" ? -1 : 1;
    const hours = Number(m?.[2] ?? 0);
    const minutes = Number(m?.[3] ?? 0);
    return { label, timeZone, offsetMinutes: sign * (hours * 60 + minutes) };
  } catch {
    // An unknown IANA zone is dropped rather than defaulted to UTC: showing
    // London's time under a "Kolkata" label is worse than omitting the row.
    return null;
  }
}

/** Cities named in the message, matched against the zones we can resolve. */
const CITY_ZONES: Record<string, string> = {
  london: "Europe/London",
  tokyo: "Asia/Tokyo",
  "new york": "America/New_York",
  newyork: "America/New_York",
  paris: "Europe/Paris",
  dubai: "Asia/Dubai",
  singapore: "Asia/Singapore",
  sydney: "Australia/Sydney",
  berlin: "Europe/Berlin",
  moscow: "Europe/Moscow",
  delhi: "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  kolkata: "Asia/Kolkata",
  bengaluru: "Asia/Kolkata",
  india: "Asia/Kolkata",
  "san francisco": "America/Los_Angeles",
  "los angeles": "America/Los_Angeles",
  chicago: "America/Chicago",
  utc: "UTC",
};

function citiesIn(message: string): Array<{ label: string; zone: string }> {
  const text = message.toLowerCase();
  const found: Array<{ label: string; zone: string }> = [];
  for (const [name, zone] of Object.entries(CITY_ZONES)) {
    if (!text.includes(name)) continue;
    const label = name.replace(/\b\w/g, (c) => c.toUpperCase());
    if (!found.some((f) => f.zone === zone)) found.push({ label, zone });
  }
  return found;
}

/**
 * What kind of surface an open one implies for a subject-less follow-up.
 *
 * Keyed off `contextKey`, which is the only thing the client reports. The keys
 * are built by this file, so the shapes matched here are the shapes written
 * above — the two are meant to be read together.
 */
function inheritIntent(activeKeys: string[]): VisualIntent | null {
  // Most recent first: with two surfaces open, the follow-up belongs to the
  // one the conversation most recently produced.
  for (const key of [...activeKeys].reverse()) {
    if (key === "clock") return "WORLD_TIME";
    if (key === "market") return "MARKET_PRICE";
    if (key === "system") return "SYSTEM_STATUS";
    if (key.startsWith("route:")) return "ROUTE";
    if (key.startsWith("weather:")) return "WEATHER";
  }
  return null;
}

// ---------------------------------------------------------------------------

export function decideSurface(input: SurfaceDecisionInput): SurfaceDecision {
  const now = input.now ?? new Date();
  const results = input.toolResults;
  const nextId = input.idFactory ?? (() => `sfc-${Math.random().toString(36).slice(2, 10)}`);
  const active = input.activeContextKeys ?? [];

  const detected = detectVisualIntent(input.message);
  let intent = detected.intent;
  let confidence = detected.confidence;

  // ---- inheritance -------------------------------------------------------
  //
  // A follow-up carries no subject of its own: "Tokyo bhi", "alternative
  // route?", "Bitcoin ka bhi" are all complete sentences ONLY in the presence
  // of what is already on screen. When the rules find nothing and a surface is
  // open, the open surface supplies the missing intent.
  //
  // Without this the third turn of the brief's own clock example — "Tokyo bhi"
  // — produced no surface at all, and the world clock never appeared.
  if (intent === "NONE" && active.length > 0 && isFollowUp(input.message)) {
    const inherited = inheritIntent(active);
    if (inherited) {
      intent = inherited;
      // Inherited, not detected. Held just above the floor so it is honest
      // about being weaker evidence than a direct match.
      confidence = 0.6;
    }
  }

  const rationale = (outcome: string) => ({ intent, confidence, outcome });
  const nothing = (outcome: string): SurfaceDecision => ({ directive: null, rationale: rationale(outcome) });

  // ---- explicit dismissal ------------------------------------------------
  if (intent === "CLOSE_SURFACE") {
    return {
      directive: { op: "close", reason: "The user asked to close it." },
      rationale: rationale("closed on explicit request"),
    };
  }

  // ---- a follow-up with no visual intent of its own ----------------------
  //
  // "alternative route?", "Tokyo bhi", "isme toll hai?" inherit the subject of
  // whatever is on screen. If nothing is on screen there is nothing to inherit
  // and no surface to open; if something is, the branches below will have
  // rebuilt it from fresh tool output and the reuse logic will match it.
  if (intent === "NONE") {
    return nothing(
      active.length > 0 && isFollowUp(input.message)
        ? "follow-up with no new visual intent; existing surface left alone"
        : "no visual intent"
    );
  }

  if (confidence < MIN_CONFIDENCE) return nothing("visual intent below confidence floor");

  // -------------------------------------------------------------------------
  // Surfaces that need a tool
  // -------------------------------------------------------------------------

  /** An honest failure surface. Used whenever the data is not there. */
  const unavailable = (what: string, reason: string, retryIntent: string | null): SurfaceDecision => {
    const def = getSurfaceDefinition("unavailable");
    return finish(
      {
        surfaceId: nextId(),
        type: "unavailable",
        mode: def.mode,
        title: what,
        status: "opening",
        conversationBound: false,
        contextKey: `unavailable:${what.toLowerCase()}`,
        autoClose: { enabled: def.autoClose, idleSeconds: def.idleSeconds },
        position: { anchor: def.anchor },
        data: { kind: "unavailable", what, reason, retryIntent },
        actions: def.actions,
        reason: "The provider could not answer, and a surface must not invent one.",
      },
      "unavailable surface (provider had no data)"
    );
  };

  /** Validates and wraps. A surface that fails its own schema is not shown. */
  function finish(candidate: Record<string, unknown>, outcome: string): SurfaceDecision {
    const parsed = SurfaceSchema.safeParse(candidate);
    if (!parsed.success) {
      // Answer without a picture rather than fail the user's question.
      return nothing(
        `surface rejected by schema: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`
      );
    }
    const surface = parsed.data satisfies Surface;
    const reuse = active.includes(surface.contextKey);
    return {
      directive: reuse
        ? { op: "update", patch: { ...surface, surfaceId: surface.surfaceId } }
        : { op: "open", surface },
      rationale: rationale(reuse ? `${outcome} (reusing existing surface)` : outcome),
    };
  }

  const def = (type: SurfaceType) => getSurfaceDefinition(type);

  switch (intent) {
    // ---- time ------------------------------------------------------------
    case "TIME":
    case "WORLD_TIME": {
      // ---- which cities -------------------------------------------------
      //
      // "Tokyo bhi" means Tokyo AS WELL AS what is already up. The cities
      // already up are not in this message and are not in the surface key
      // either — they are in what the user said a moment ago, so the recent
      // turns are read back and unioned.
      //
      // Only while a clock is actually open. Otherwise "what time is it",
      // asked an hour after someone mentioned London, would open a two-city
      // world clock nobody asked for.
      const named = citiesIn(input.message);
      const clockIsOpen = active.includes("clock");
      const carried = clockIsOpen
        ? (input.recentUserMessages ?? []).flatMap((m) => citiesIn(m))
        : [];

      const merged = [...carried, ...named].filter(
        (c, i, all) => all.findIndex((o) => o.zone === c.zone) === i
      );

      const zones = (merged.length > 0 ? merged : [{ label: "Local time", zone: DEFAULT_ZONE }])
        // Six is what the surface schema allows and more than anyone reads.
        .slice(-6)
        .map((c) => zoneEntry(c.label, c.zone, now))
        .filter((z): z is NonNullable<typeof z> => z !== null);

      if (zones.length === 0) return nothing("no resolvable timezone in the message");

      // One named city is still a single clock; two or more is a world clock.
      const type: SurfaceType = zones.length > 1 ? "world-clock" : "clock";
      const d = def(type);

      return finish(
        {
          surfaceId: nextId(),
          type,
          mode: d.mode,
          title: zones.length > 1 ? "World clocks" : zones[0]!.label,
          status: "opening",
          conversationBound: true,
          // Every clock shares one key, so "London ka?" then "Tokyo bhi"
          // updates the panel already open instead of stacking three.
          contextKey: "clock",
          autoClose: { enabled: d.autoClose, idleSeconds: d.idleSeconds },
          position: { anchor: d.anchor },
          data: {
            kind: "clock",
            zones,
            hourFormat: input.hourFormat ?? "24",
            showAnalog: zones.length === 1,
          },
          actions: d.actions,
          reason: "A clock reads faster than a sentence, and the user asked for a time.",
        },
        `clock surface with ${zones.length} zone(s)`
      );
    }

    // ---- route -----------------------------------------------------------
    case "ROUTE": {
      const data = toolData(results, "maps.route");
      if (!data) {
        const failure = toolFailure(results, "maps.route");
        if (failure) return unavailable("Route", failure, "try that route again");
        return nothing("route intent, but no route tool ran");
      }

      const route = data.route as Record<string, unknown> | undefined;
      if (!route) return nothing("route tool returned no route");

      const from = route.from as Record<string, unknown> | undefined;
      const to = route.to as Record<string, unknown> | undefined;
      // The geo layer emits [lng, lat] — longitude FIRST — everywhere, which is
      // what `decodePolyline` pushes and what the dashboard map widget already
      // destructures. Reading it as [lat, lng] put every point in the wrong
      // hemisphere and `fitBounds` obligingly zoomed out to fit the planet.
      const geometry = Array.isArray(route.geometry)
        ? (route.geometry as Array<[number, number]>)
            .filter((p) => Array.isArray(p) && p.length === 2)
            .map(([lng, lat]) => ({ lat, lng }))
        : [];

      const primaryDuration = num(route.durationMinutes) ?? 0;
      const primaryDistance = num(route.distanceKm) ?? 0;

      const legs = [
        {
          id: "primary",
          summary: str(route.summary) ?? "Recommended",
          distanceMeters: Math.round(primaryDistance * 1000),
          durationSeconds: Math.round(primaryDuration * 60),
          // Tolls are only ever what the provider said. This provider does not
          // report them, so the answer is "not known" — never "no tolls".
          hasTolls: null,
          durationInTrafficSeconds:
            num(route.durationInTrafficMinutes) !== null
              ? Math.round((num(route.durationInTrafficMinutes) as number) * 60)
              : null,
          geometry,
          recommended: true,
          recommendationReason: null as string | null,
        },
      ];

      const alts = Array.isArray(route.alternatives) ? route.alternatives : [];
      alts.slice(0, 4).forEach((a, i) => {
        const alt = a as Record<string, unknown>;
        const d = num(alt.distanceKm) ?? 0;
        const t = num(alt.durationMinutes) ?? 0;
        legs.push({
          id: `alt-${i + 1}`,
          summary: str(alt.summary) ?? `Alternative ${i + 1}`,
          distanceMeters: Math.round(d * 1000),
          durationSeconds: Math.round(t * 60),
          hasTolls: null,
          durationInTrafficSeconds:
            num(alt.durationInTrafficMinutes) !== null
              ? Math.round((num(alt.durationInTrafficMinutes) as number) * 60)
              : null,
          geometry: Array.isArray(alt.geometry)
            ? (alt.geometry as Array<[number, number]>)
                .filter((p) => Array.isArray(p) && p.length === 2)
                .map(([lng, lat]) => ({ lat, lng }))
            : [],
          recommended: false,
          recommendationReason: null,
        });
      });

      // ---- why this one -------------------------------------------------
      //
      // Stated ONLY in terms of the two numbers the provider gave: time and
      // distance. "Fastest by 6 min" is a subtraction. "Safer", "better roads"
      // and "less traffic later" are not derivable from anything here, so they
      // are never produced — see the note on `recommendationReason`.
      if (legs.length > 1) {
        const fastest = legs.reduce((a, b) => (b.durationSeconds < a.durationSeconds ? b : a));
        const shortest = legs.reduce((a, b) => (b.distanceMeters < a.distanceMeters ? b : a));
        const savedMin = Math.round(
          (legs.filter((l) => l !== fastest).reduce((m, l) => Math.min(m, l.durationSeconds), Infinity) -
            fastest.durationSeconds) / 60
        );

        for (const leg of legs) leg.recommended = leg === fastest;
        fastest.recommendationReason =
          savedMin >= 1
            ? `Fastest by about ${savedMin} min on current route data.`
            : "Fastest on current route data.";
        if (shortest !== fastest) {
          shortest.recommendationReason = `Shortest by distance, but about ${Math.round(
            (shortest.durationSeconds - fastest.durationSeconds) / 60
          )} min longer.`;
        }
      }

      const originLabel = str(from?.name) ?? "Origin";
      const destinationLabel = str(to?.name) ?? "Destination";
      const d = def("route");

      return finish(
        {
          surfaceId: nextId(),
          type: "route",
          mode: d.mode,
          title: `${originLabel} → ${destinationLabel}`,
          subtitle: legs.length > 1 ? `${legs.length} routes` : undefined,
          status: "opening",
          conversationBound: true,
          // Keyed on the JOURNEY, so "alternative route?" and "kitna time
          // lagega?" both land on the map already showing it.
          contextKey: `route:${originLabel.toLowerCase()}->${destinationLabel.toLowerCase()}`,
          autoClose: { enabled: d.autoClose, idleSeconds: d.idleSeconds },
          position: { anchor: d.anchor },
          data: {
            kind: "route",
            origin: {
              label: originLabel,
              position:
                num(from?.latitude) !== null && num(from?.longitude) !== null
                  ? { lat: num(from?.latitude)!, lng: num(from?.longitude)! }
                  : null,
            },
            destination: {
              label: destinationLabel,
              position:
                num(to?.latitude) !== null && num(to?.longitude) !== null
                  ? { lat: num(to?.latitude)!, lng: num(to?.longitude)! }
                  : null,
            },
            travelMode: "driving",
            routes: legs,
            provenance: provenanceOf(results, "maps.route", str(route.attribution) ?? "Maps provider"),
          },
          actions: d.actions,
          reason: "A drawn route answers 'which way' in a way a paragraph cannot.",
        },
        `route surface with ${legs.length} route(s)`
      );
    }

    // ---- market ----------------------------------------------------------
    case "MARKET_PRICE":
    case "MARKET_ANALYSIS": {
      const data = toolData(results, "market.quote");
      if (!data) {
        const failure = toolFailure(results, "market.quote");
        if (failure) return unavailable("Market data", failure, "get that price again");

        // ---- analysis over a price already on screen ---------------------
        //
        // "Solana mein invest karna chahiye?" usually arrives one turn after
        // the price, and the model answers it from the quote already in
        // context rather than fetching again. No tool runs, so there is no new
        // data — and the card showing the old data is still open.
        //
        // The honest move is to change the card's MODE and leave its numbers
        // alone. This patch carries no `data` at all: the client merges it over
        // the live surface, so the figures on screen remain the ones the
        // provider actually returned, and the panel simply stops trying to
        // close itself while a page of reasoning is being read.
        if (intent === "MARKET_ANALYSIS" && active.includes("market")) {
          return {
            directive: {
              op: "update",
              patch: {
                surfaceId: "market",
                contextKey: "market",
                mode: "analysis",
                subtitle: "Analysis",
                autoClose: { enabled: false, idleSeconds: 120 },
              },
            },
            rationale: rationale("switched the open market surface to analysis mode"),
          };
        }

        return nothing("market intent, but no market tool ran");
      }

      const rawQuotes = Array.isArray(data.quotes) ? data.quotes : [];
      const quotes = rawQuotes
        .map((q) => q as Record<string, unknown>)
        .filter((q) => num(q.price) !== null)
        .slice(0, 6)
        .map((q) => ({
          symbol: str(q.symbol) ?? "?",
          name: str(q.name) ?? "Unknown",
          price: num(q.price),
          currency: str(q.currency) ?? "USD",
          change24hPct: num(q.changePct24h),
          marketCap: num(q.marketCap),
          volume24h: num(q.volume24h),
        }));

      if (quotes.length === 0) return unavailable("Market data", "No usable quote was returned.", null);

      const d = def("market");
      const analysing = intent === "MARKET_ANALYSIS";

      return finish(
        {
          surfaceId: nextId(),
          type: "market",
          mode: analysing ? "analysis" : d.mode,
          title: quotes.length > 1 ? "Markets" : quotes[0]!.name,
          subtitle: analysing ? "Analysis" : undefined,
          status: "opening",
          conversationBound: true,
          // One key for the whole market subject: "Bitcoin ka bhi" adds a row,
          // "compare dono" widens the same panel, and none of it stacks.
          contextKey: "market",
          autoClose: {
            // Reading an analysis is not idling, so the timer is longer and the
            // registry's glance value does not apply.
            enabled: analysing ? false : d.autoClose,
            idleSeconds: analysing ? 120 : d.idleSeconds,
          },
          position: { anchor: d.anchor },
          data: {
            kind: "market",
            quotes,
            provenance: provenanceOf(results, "market.quote", "Market provider"),
          },
          actions: d.actions,
          reason: analysing
            ? "The user asked whether to invest; the figures and the risks belong side by side."
            : "A price, its change and its source read better as a card than as prose.",
        },
        analysing ? "market surface in analysis mode" : `market surface with ${quotes.length} quote(s)`
      );
    }

    // ---- weather ---------------------------------------------------------
    case "WEATHER": {
      const data = toolData(results, "weather.current");
      if (!data) {
        const failure = toolFailure(results, "weather.current");
        if (failure) return unavailable("Weather", failure, "check the weather again");
        return nothing("weather intent, but no weather tool ran");
      }

      const w = data.weather as Record<string, unknown> | undefined;
      if (!w) return nothing("weather tool returned no reading");
      const loc = w.location as Record<string, unknown> | undefined;
      const label = str(loc?.label) ?? "Current location";
      const d = def("weather");

      return finish(
        {
          surfaceId: nextId(),
          type: "weather",
          mode: d.mode,
          title: label,
          status: "opening",
          conversationBound: true,
          contextKey: `weather:${label.toLowerCase()}`,
          autoClose: { enabled: d.autoClose, idleSeconds: d.idleSeconds },
          position: { anchor: d.anchor },
          data: {
            kind: "weather",
            location: label,
            temperatureC: num(w.temperatureC),
            feelsLikeC: num(w.feelsLikeC),
            condition: str(w.condition),
            humidityPct: num(w.humidityPct),
            windKph: num(w.windKph),
            provenance: provenanceOf(results, "weather.current", "Weather provider"),
          },
          actions: d.actions,
          reason: "Conditions are several readings at once, which is a card, not a sentence.",
        },
        "weather surface"
      );
    }

    // ---- system ----------------------------------------------------------
    case "SYSTEM_STATUS": {
      const data = toolData(results, "system.status");
      if (!data) {
        const failure = toolFailure(results, "system.status");
        if (failure) return unavailable("System telemetry", failure, "check the system again");
        return nothing("system intent, but no system tool ran");
      }

      const sys = data.system as Record<string, unknown> | undefined;
      const rawMetrics = Array.isArray(sys?.metrics) ? sys!.metrics : [];
      const metrics = rawMetrics
        .map((m) => m as Record<string, unknown>)
        .slice(0, 12)
        .map((m) => ({
          label: str(m.label) ?? "?",
          value: num(m.value),
          unit: str(m.unit) ?? "",
          reason: str(m.reason),
        }));

      if (metrics.length === 0) return unavailable("System telemetry", "No metrics were reported.", null);

      const d = def("system-monitor");
      return finish(
        {
          surfaceId: nextId(),
          type: "system-monitor",
          mode: d.mode,
          title: "System",
          subtitle: str(sys?.model) ?? undefined,
          status: "opening",
          conversationBound: true,
          contextKey: "system",
          autoClose: { enabled: d.autoClose, idleSeconds: d.idleSeconds },
          position: { anchor: d.anchor },
          data: {
            kind: "system",
            metrics,
            provenance: provenanceOf(results, "system.status", "host"),
          },
          actions: d.actions,
          reason: "Six live readings at once is a panel, not a paragraph.",
        },
        "system surface"
      );
    }

    // ---- place search ----------------------------------------------------
    case "PLACE_SEARCH": {
      // Either tool can answer this: `maps.search` for a named query,
      // `maps.nearby` for "what is around me". Whichever ran is read.
      const usedTool = toolData(results, "maps.search") ? "maps.search" : "maps.nearby";
      const data = toolData(results, usedTool);

      if (!data) {
        const failure = toolFailure(results, "maps.search") ?? toolFailure(results, "maps.nearby");
        // The location cases arrive here as ordinary tool failures carrying the
        // tool's own wording — "no current location is available, ask them to
        // allow location access". That message is shown verbatim rather than
        // rewritten, because the tool knows why it could not answer and this
        // layer does not.
        if (failure) return unavailable("Places", failure, "search for that again");
        return nothing("place-search intent, but no maps tool ran");
      }

      const rawPlaces = Array.isArray(data.places) ? data.places : [];
      const places = rawPlaces
        .map((p) => p as Record<string, unknown>)
        .slice(0, 20)
        .map((p) => ({
          id: str(p.placeId) ?? str(p.name) ?? "?",
          name: str(p.name) ?? "Unnamed place",
          address: str(p.address) ?? str(p.type),
          position:
            num(p.latitude) !== null && num(p.longitude) !== null
              ? { lat: num(p.latitude)!, lng: num(p.longitude)! }
              : null,
        }));

      // A search that genuinely found nothing gets an honest panel, not an
      // empty map. An empty map reads as "still loading" or "broken", and both
      // are worse than the true answer.
      if (places.length === 0) {
        const query = str(data.query);
        return unavailable(
          "Places",
          query ? `Nothing was found for "${query}".` : "No places were found.",
          null
        );
      }

      const located = places.filter((p) => p.position !== null);
      const d = def("place-search");
      const query = str(data.query) ?? "Nearby";

      return finish(
        {
          surfaceId: nextId(),
          type: "place-search",
          mode: d.mode,
          title: query,
          subtitle: `${places.length} result${places.length === 1 ? "" : "s"}`,
          status: "opening",
          conversationBound: true,
          // Keyed on the QUERY, so "aur dikhao" refines the same panel rather
          // than opening a second map beside it.
          contextKey: `places:${query.toLowerCase()}`,
          autoClose: { enabled: d.autoClose, idleSeconds: d.idleSeconds },
          position: { anchor: d.anchor },
          data: {
            kind: "map",
            // Centre on the first located result. Null when the provider gave
            // no coordinates at all, which the renderer handles by listing.
            center: located[0]?.position ?? null,
            zoom: located.length > 1 ? 12 : 14,
            places,
            provenance: provenanceOf(results, usedTool, "Maps provider"),
          },
          actions: d.actions,
          reason: "Places are positions; a list of names without a map answers half the question.",
        },
        `place-search surface with ${places.length} result(s)`
      );
    }

    // ---- tasks -----------------------------------------------------------
    case "TASKS": {
      const data = toolData(results, "tasks.list");
      if (!data) {
        const failure = toolFailure(results, "tasks.list");
        if (failure) return unavailable("Tasks", failure, "show my tasks again");
        return nothing("tasks intent, but no tasks tool ran");
      }

      const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
      const all = rawTasks
        .map((t) => t as Record<string, unknown>)
        .map((t) => ({
          id: str(t.id) ?? "?",
          title: str(t.title) ?? "Untitled",
          dueAt: str(t.dueAt),
          priority: str(t.priority) ?? "NORMAL",
          done: t.done === true,
        }));

      // ---- filters, applied to REAL rows ---------------------------------
      //
      // The message narrows what is shown; it never adds. A filter that matches
      // nothing produces an empty list, and an empty list is a real answer
      // ("nothing is high priority") rather than a reason to widen the query
      // until something appears.
      const text = input.message.toLowerCase();
      const wantsPending = /(pending|baaki|bache|incomplete|adhura|todo|to do)/u.test(text);
      const wantsHigh = /(high priority|urgent|zaroori|important|jaruri)/u.test(text);
      const wantsToday = /(today|aaj|aaj ke|aaj ka)/u.test(text);
      const wantsTomorrow = /(tomorrow|kal)/u.test(text);

      const sameDay = (iso: string | null, offsetDays: number): boolean => {
        if (!iso) return false;
        const due = new Date(iso);
        if (Number.isNaN(due.getTime())) return false;
        const target = new Date(now);
        target.setDate(target.getDate() + offsetDays);
        return (
          due.getFullYear() === target.getFullYear() &&
          due.getMonth() === target.getMonth() &&
          due.getDate() === target.getDate()
        );
      };

      let tasks = all;
      if (wantsPending) tasks = tasks.filter((t) => !t.done);
      if (wantsHigh) tasks = tasks.filter((t) => t.priority.toUpperCase() === "HIGH");
      if (wantsToday) tasks = tasks.filter((t) => sameDay(t.dueAt, 0));
      else if (wantsTomorrow) tasks = tasks.filter((t) => sameDay(t.dueAt, 1));

      tasks = tasks.slice(0, 20);

      const filtered = wantsPending || wantsHigh || wantsToday || wantsTomorrow;
      const d = def("tasks");

      return finish(
        {
          surfaceId: nextId(),
          type: "tasks",
          mode: d.mode,
          title: "Tasks",
          subtitle: filtered
            ? `${tasks.length} of ${all.length}`
            : tasks.length > 0
              ? `${tasks.length}`
              : undefined,
          status: "opening",
          conversationBound: true,
          contextKey: "tasks",
          autoClose: { enabled: d.autoClose, idleSeconds: d.idleSeconds },
          position: { anchor: d.anchor },
          // An EMPTY list is rendered, deliberately. "Nothing is due" is the
          // answer to "what are my tasks", and the panel showing a clear diary
          // is not an empty surface pretending to hold data — it is the data.
          data: { kind: "tasks", tasks },
          actions: d.actions,
          reason: "A due list is read down a column, not along a sentence.",
        },
        `tasks surface with ${tasks.length} task(s)${filtered ? " (filtered)" : ""}`
      );
    }

    // ---- knowledge -------------------------------------------------------
    case "KNOWLEDGE": {
      const knowledge = input.knowledge;

      if (!knowledge || knowledge.outcome === "failed") {
        return knowledge?.outcome === "failed"
          ? unavailable("Knowledge base", "Your documents could not be searched.", "search my documents again")
          : nothing("knowledge intent, but retrieval did not run");
      }

      // Nothing retrieved is NOT a surface. A citations panel with no citations
      // would suggest the answer came from documents when it did not, which is
      // the precise failure that citing sources exists to prevent.
      if (knowledge.outcome !== "retrieved" || knowledge.chunks.length === 0) {
        return nothing(`knowledge intent, but retrieval was ${knowledge.outcome}`);
      }

      const citations = knowledge.chunks.slice(0, 10).map((chunk) => ({
        documentId: chunk.documentId,
        documentName: chunk.documentTitle,
        chunkId: chunk.chunkId,
        chunkIndex: chunk.chunkIndex,
        pages: Array.isArray(chunk.pageNumbers) ? chunk.pageNumbers.slice(0, 20) : [],
        section: chunk.primarySection?.title ?? null,
        score: chunk.score,
        // Verbatim, and truncated rather than summarised. A paraphrased
        // "excerpt" is not a quotation, and this panel's whole value is that
        // what it shows is what is stored.
        excerpt: chunk.content.slice(0, 1200),
      }));

      const documents = new Set(citations.map((c) => c.documentId)).size;
      const d = def("knowledge");

      return finish(
        {
          surfaceId: nextId(),
          type: "knowledge",
          mode: d.mode,
          title: "Sources",
          subtitle: `${citations.length} passage${citations.length === 1 ? "" : "s"} from ${documents} document${documents === 1 ? "" : "s"}`,
          status: "opening",
          conversationBound: true,
          contextKey: "knowledge",
          autoClose: { enabled: d.autoClose, idleSeconds: d.idleSeconds },
          position: { anchor: d.anchor },
          // No `summary`. The answer is already in the conversation; repeating
          // the model's prose beside verbatim excerpts, in one frame, is how a
          // reader stops being able to tell which is which.
          data: {
            kind: "knowledge",
            citations,
            ...(knowledge.retrievedAt ? { retrievedAt: knowledge.retrievedAt } : {}),
          },
          actions: d.actions,
          reason: "The user asked what the answer was based on, so the passages are the answer.",
        },
        `knowledge surface with ${citations.length} citation(s)`
      );
    }

    default:
      return nothing(`no surface builder for ${intent}; answered without one`);
  }
}
