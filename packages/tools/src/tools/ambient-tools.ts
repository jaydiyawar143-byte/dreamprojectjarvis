import { BaseTool } from "../base-tool.js";
import type { ToolContext, ToolResult } from "@jarvis/core";
import type { CurrentLocationPort, MapsPort } from "./maps-tools.js";

// ---------------------------------------------------------------------------
// Ambient tools — weather, markets, and this machine.
//
// ---------------------------------------------------------------------------
// WHY THESE EXIST.
//
// The dashboard could already show a weather card, a price row and a CPU gauge,
// because the widgets call the API directly. The ASSISTANT could not. Ask it
// "aaj Solana ka kya price hai?" and there was no tool to answer with, which
// leaves a language model holding a question about a number it cannot look up —
// the exact situation that produces a confident, invented price.
//
// So these are not new capabilities. They are the capabilities the dashboard
// already had, made reachable by the agent, over the SAME providers: the
// CoinGecko client, the Open-Meteo client and the host telemetry collector are
// untouched and unduplicated. Only the port in front of them is new.
//
// All three are READ_ONLY and require no approval. They cannot write, cannot
// spend, and cannot reach anything the user's dashboard could not already see.
// ---------------------------------------------------------------------------

/** What every ambient port call returns. Mirrors `MapsOutcome`. */
export interface AmbientOutcome<T> {
  data: T | null;
  /** The provider that actually answered. Never a brand we did not call. */
  source: string;
  /** Present when `data` is null, in the provider's own words. */
  reason?: string;
  /** When the DATA was observed, not when it was fetched. */
  observedAt?: string;
}

export interface WeatherReading {
  temperatureC: number;
  feelsLikeC: number | null;
  humidityPct: number | null;
  windKph: number | null;
  /** The provider's condition text. Not our paraphrase. */
  condition: string | null;
  location: { label: string; latitude: number; longitude: number };
  forecast: Array<{ date: string; minC: number; maxC: number; condition: string | null }>;
}

export interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  currency: string;
  changePct24h: number | null;
  marketCap: number | null;
  volume24h: number | null;
}

export interface SystemReading {
  /** `null` value means the sensor is not exposed. It never means zero. */
  metrics: Array<{ label: string; value: number | null; unit: string; reason: string | null }>;
  model: string;
  uptimeSeconds: number;
}

export interface WeatherPort {
  current(latitude: number, longitude: number, label?: string): Promise<AmbientOutcome<WeatherReading>>;
}

export interface MarketPort {
  /** `symbols` are user-facing names or tickers; the adapter maps them. */
  quotes(symbols: string[]): Promise<AmbientOutcome<MarketQuote[]>>;
}

export interface SystemPort {
  snapshot(): AmbientOutcome<SystemReading>;
}

abstract class AmbientTool extends BaseTool {
  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[]
  ) {
    super(id, name, description, "research", parameters, false, ["read"], "READ_ONLY", "1.0.0", true);
  }

  protected fromOutcome(outcome: { reason?: string }, fallback: string): ToolResult {
    return this.failure(outcome.reason ?? fallback);
  }
}

// ---------------------------------------------------------------------------
// weather.current
// ---------------------------------------------------------------------------

export class WeatherCurrentTool extends AmbientTool {
  constructor(
    private readonly weather: WeatherPort,
    private readonly maps: MapsPort,
    private readonly location: CurrentLocationPort
  ) {
    super(
      "weather.current",
      "Current Weather",
      "Get the real current weather and short forecast for a place, or for the user's current location when no place is given.",
      [{ name: "place", type: "string", description: "Place name. Omit for the user's current location.", required: false }]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const place = typeof params.place === "string" ? params.place.trim() : "";

    let latitude: number;
    let longitude: number;
    let label: string;

    if (place && !/^(here|my location|current location|meri location)$/i.test(place)) {
      const found = await this.maps.geocode(place, 1, context.userId);
      const first = found.data?.[0];
      if (!first) return this.fromOutcome(found, `No place matched "${place}".`);
      latitude = first.latitude;
      longitude = first.longitude;
      label = first.name;
    } else {
      // Never guessed. No fix means we ask, which is what §13 requires — a
      // weather report for a city the user is not in is worse than no report.
      const coords = await this.location.get(context.userId);
      if (!coords) {
        return this.failure(
          "No current location is available. Ask the user which place they mean, or ask them to allow location access."
        );
      }
      latitude = coords.latitude;
      longitude = coords.longitude;
      const here = await this.maps.reverseGeocode(latitude, longitude, context.userId);
      label = here.data?.name ?? "Current location";
    }

    const result = await this.weather.current(latitude, longitude, label);
    if (!result.data) return this.fromOutcome(result, "Weather data could not be retrieved.");

    return this.success(
      { weather: result.data },
      { source: result.source, observedAt: result.observedAt, readOnly: true }
    );
  }
}

// ---------------------------------------------------------------------------
// market.quote
// ---------------------------------------------------------------------------

export class MarketQuoteTool extends AmbientTool {
  constructor(private readonly market: MarketPort) {
    super(
      "market.quote",
      "Market Quote",
      // The wording is load-bearing, and each sentence fixes an observed
      // failure rather than describing the tool for its own sake.
      //
      //  * "or whether it is worth buying" — without it the model answered
      //    "Solana mein invest karna chahiye?" from memory, with no quote
      //    fetched, which is an investment opinion about a price it never saw.
      //  * "list EVERY asset" — without it "Bitcoin ka bhi" fetched only
      //    Bitcoin, and the comparison the user asked for replaced the thing
      //    they were comparing it to.
      "Get the real current price and 24h change for one or more cryptocurrencies. " +
        "Use this before answering ANY question about what something costs, how it has moved, " +
        "or whether it is worth buying — never answer those from memory. " +
        "When the user adds an asset to something already under discussion " +
        "(\"bitcoin ka bhi\", \"compare both\"), list EVERY asset in the conversation " +
        "in a single call, not just the newest one. " +
        // Third observed failure: asked "should I invest in Solana?", the model
        // declined to advise — correctly — and in declining also never looked
        // up the price, so the user got neither advice nor the figures. Reading
        // a public price is not advice, and the two decisions are separate.
        "Reading a price is NOT financial advice: fetch the quote even when you " +
        "intend to decline the recommendation, so the user can at least see the " +
        "current figures alongside your reasoning.",
      [
        {
          name: "symbols",
          type: "string",
          description: "Comma-separated names or tickers, e.g. 'solana' or 'bitcoin,ethereum'",
          required: true,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const raw = typeof params.symbols === "string" ? params.symbols : "";
    const symbols = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 40)
      // Six is the widest comparison the market surface renders, and a longer
      // list is a sign the model is fishing rather than answering.
      .slice(0, 6);

    if (symbols.length === 0) return this.failure("Name at least one asset, e.g. 'solana'.");

    const result = await this.market.quotes(symbols);
    if (!result.data || result.data.length === 0) {
      return this.fromOutcome(result, `No market data was available for ${symbols.join(", ")}.`);
    }

    return this.success(
      { quotes: result.data },
      { source: result.source, observedAt: result.observedAt, readOnly: true }
    );
  }
}

// ---------------------------------------------------------------------------
// time.now
// ---------------------------------------------------------------------------

/**
 * The current time, so the assistant can SAY it.
 *
 * This looks redundant next to the clock surface, and is not. Without it the
 * model has no clock at all, so "abhi kya time hua hai?" was answered with
 * "main samay ki jaankari nahi de sakta" — while a clock surface opened
 * alongside showing the time. An assistant contradicting its own interface is
 * worse than one that simply lacks a feature.
 *
 * No port: the time is `Date`, and a zone conversion is `Intl`. Reaching over a
 * network for something the process already knows would add a failure mode to
 * the most reliable answer JARVIS can give.
 */
export class TimeNowTool extends AmbientTool {
  constructor() {
    super(
      "time.now",
      "Current Time",
      "Get the real current time, optionally in a named city or IANA timezone. Use this whenever the user asks what time it is — never answer a time question from memory.",
      [
        {
          name: "timeZone",
          type: "string",
          description: "IANA zone such as 'Asia/Kolkata' or 'Europe/London'. Omit for the server's local zone.",
          required: false,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const requested = typeof params.timeZone === "string" ? params.timeZone.trim() : "";
    const now = new Date();

    try {
      const timeZone = requested || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const time = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(now);
      const date = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(now);

      return this.success(
        { time, date, timeZone, iso: now.toISOString() },
        { source: "system clock", readOnly: true }
      );
    } catch {
      // An unknown zone is reported, not silently answered as UTC — the wrong
      // city's time under the right city's name is the worst possible outcome.
      return this.failure(`"${requested}" is not a timezone I can resolve.`);
    }
  }
}

// ---------------------------------------------------------------------------
// system.status
// ---------------------------------------------------------------------------

export class SystemStatusTool extends AmbientTool {
  constructor(private readonly system: SystemPort) {
    super(
      "system.status",
      "System Status",
      "Read this machine's real telemetry: CPU, memory, disk, network, and temperatures where the hardware exposes them.",
      []
    );
  }

  async execute(_params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const result = this.system.snapshot();
    if (!result.data) return this.fromOutcome(result, "System telemetry is not available.");

    return this.success(
      { system: result.data },
      { source: result.source, observedAt: result.observedAt, readOnly: true }
    );
  }
}

/**
 * All three, for registration.
 *
 * Mirrors `createMapsTools` so the container wires ambient capability the same
 * way it wires location capability.
 */
export function createAmbientTools(
  weather: WeatherPort,
  market: MarketPort,
  system: SystemPort,
  maps: MapsPort,
  location: CurrentLocationPort
): BaseTool[] {
  return [
    new WeatherCurrentTool(weather, maps, location),
    new MarketQuoteTool(market),
    new SystemStatusTool(system),
    new TimeNowTool(),
  ];
}
