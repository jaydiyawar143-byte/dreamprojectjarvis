import type {
  AmbientOutcome,
  MarketPort,
  MarketQuote,
  SystemPort,
  SystemReading,
  TasksPort,
  TaskReading,
  WeatherPort,
  WeatherReading,
} from "@jarvis/tools";
import { JARVIS_TASK_CREATOR } from "@jarvis/core";
import { getWeather } from "./providers/weather-provider.js";
import { getTopCrypto } from "./providers/market-provider.js";
import { snapshot as systemSnapshot } from "./providers/system-monitor.js";

// ---------------------------------------------------------------------------
// Ambient adapter — the ports in `@jarvis/tools`, over the providers the
// dashboard already uses.
//
// The same shape as `maps-adapter.ts`, and for the same reason: the tools
// package must not know about HTTP, API keys or which vendor answered, and the
// providers must not know they are being called by an agent rather than a
// widget. Everything here is translation.
//
// NOTHING IS FETCHED TWICE. These call the very same cached provider functions
// the `/api/v1/weather`, `/markets/crypto` and `/system` routes call, so an
// agent asking for a price and a widget showing one hit the same cache entry
// and report the same number. Two code paths to the same vendor is how a
// dashboard ends up disagreeing with the assistant on screen.
// ---------------------------------------------------------------------------

/** Open-Meteo's WMO code, in the provider's own vocabulary. */
const WMO: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  80: "Rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with heavy hail",
};

// A code with no mapping returns null rather than "Unknown": an absent
// condition renders as absent, where a literal "Unknown" reads like a reading.
const describeCode = (code: number): string | null => WMO[code] ?? null;

export function createWeatherPort(): WeatherPort {
  return {
    async current(latitude, longitude, label): Promise<AmbientOutcome<WeatherReading>> {
      const result = await getWeather(latitude, longitude, label);
      if (!result.data) {
        return {
          data: null,
          source: result.meta.source,
          ...(result.meta.reason ? { reason: result.meta.reason } : {}),
        };
      }

      const w = result.data;
      const reading: WeatherReading = {
        temperatureC: w.temperatureC,
        feelsLikeC: w.feelsLikeC,
        humidityPct: w.humidityPct,
        windKph: w.windKph,
        condition: describeCode(w.code),
        location: {
          label: w.location.label ?? label ?? "Current location",
          latitude: w.location.latitude,
          longitude: w.location.longitude,
        },
        forecast: w.forecast.slice(0, 5).map((d) => ({
          date: d.date,
          minC: d.minC,
          maxC: d.maxC,
          condition: describeCode(d.code),
        })),
      };

      return { data: reading, source: result.meta.source, observedAt: result.meta.observedAt };
    },
  };
}

/**
 * How a person names a coin, mapped to the id the provider wants.
 *
 * Deliberately small and explicit. The alternative — passing the user's word
 * straight through — makes "sol" resolve to whatever CoinGecko happens to list
 * under that ticker, and a price for the wrong asset is worse than no price.
 * An unrecognised name is reported as unavailable, not guessed at.
 */
const COIN_IDS: Record<string, string> = {
  btc: "bitcoin",
  bitcoin: "bitcoin",
  eth: "ethereum",
  ether: "ethereum",
  ethereum: "ethereum",
  sol: "solana",
  solana: "solana",
};

export function createMarketPort(): MarketPort {
  return {
    async quotes(symbols): Promise<AmbientOutcome<MarketQuote[]>> {
      const wanted = symbols
        .map((s) => COIN_IDS[s.toLowerCase().trim()])
        .filter((id): id is string => Boolean(id));

      const unknown = symbols.filter((s) => !COIN_IDS[s.toLowerCase().trim()]);

      if (wanted.length === 0) {
        return {
          data: null,
          source: "CoinGecko",
          reason: `No supported market data for ${unknown.join(", ")}. Supported: Bitcoin, Ethereum, Solana.`,
        };
      }

      const ids = [...new Set(wanted)];
      const result = await getTopCrypto(ids.length, ids);
      if (!result.data) {
        return {
          data: null,
          source: result.meta.source,
          ...(result.meta.reason ? { reason: result.meta.reason } : {}),
        };
      }

      const quotes: MarketQuote[] = result.data.map((q) => ({
        symbol: q.symbol.toUpperCase(),
        name: q.name,
        price: q.price,
        currency: "USD",
        changePct24h: q.changePct24h,
        // The list endpoint does not return these. `null` says so; a zero
        // would be read as a measurement.
        marketCap: null,
        volume24h: null,
      }));

      return { data: quotes, source: result.meta.source, observedAt: result.meta.observedAt };
    },
  };
}

/**
 * The caller's own tasks, over the repository the `/tasks` route already uses.
 *
 * `userId` is threaded straight through to `list`, which scopes its query by
 * owner in SQL. There is no path here that reads a task belonging to anyone
 * else, and none that writes: creating and completing tasks stay on the
 * existing route, behind the permissions they already had.
 */
export function createTasksPort(tasks: {
  list(
    userId: string,
    options: { includeCompleted?: boolean; limit?: number; excludeCreatedBy?: string }
  ): Promise<
    Array<{ id: string; title: string; dueAt: Date | string | null; priority: string; completedAt: Date | string | null }>
  >;
}): TasksPort {
  return {
    async list(userId, options): Promise<AmbientOutcome<TaskReading[]>> {
      try {
        const rows = await tasks.list(userId, {
          includeCompleted: options.includeCompleted,
          limit: 50,
          // Core V1.1 — todos only.
          //
          // `tasks.list` answers "what is due?", and work JARVIS is carrying
          // out is not a todo the user has to do. Without this, asking about
          // due items returned undated work tasks mixed in with real
          // reminders. The work surface is `task.list`.
          excludeCreatedBy: JARVIS_TASK_CREATOR,
        });
        return {
          data: rows.map((t) => ({
            id: t.id,
            title: t.title,
            dueAt: t.dueAt ? new Date(t.dueAt).toISOString() : null,
            priority: t.priority,
            done: t.completedAt !== null,
          })),
          source: "JARVIS tasks",
          observedAt: new Date().toISOString(),
        };
      } catch {
        // The reason is deliberately vague to the model: a database error
        // message is an internal detail, and "could not be read" is all the
        // user can act on.
        return { data: null, source: "JARVIS tasks", reason: "Your tasks could not be read." };
      }
    },
  };
}

export function createSystemPort(): SystemPort {
  return {
    snapshot(): AmbientOutcome<SystemReading> {
      const s = systemSnapshot();

      // `Maybe<T>` carries either a value or the provider's reason for not
      // having one. Both are preserved: "no sensor is exposed by this system"
      // is a real answer and the only honest alternative to a number.
      const maybe = (label: string, m: { value: number | null; reason?: string }, unit: string) => ({
        label,
        value: m.value,
        unit,
        reason: m.value === null ? (m.reason ?? "No sensor is exposed by this system") : null,
      });

      const reading: SystemReading = {
        metrics: [
          maybe("CPU", s.cpu.loadPct, "%"),
          { label: "Memory", value: s.memory.usedPct, unit: "%", reason: null },
          maybe("CPU temp", s.cpu.temperatureC, "°C"),
          maybe("GPU", s.gpu.utilizationPct, "%"),
          {
            label: "Disk",
            value: s.disk.value?.usedPct ?? null,
            unit: "%",
            reason: s.disk.value ? null : (s.disk.reason ?? "Not reported"),
          },
        ],
        model: s.cpu.model,
        uptimeSeconds: s.uptimeSeconds,
      };

      return { data: reading, source: s.containerized ? "container" : "host", observedAt: s.at };
    },
  };
}
