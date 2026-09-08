// ---------------------------------------------------------------------------
// V3 — the shared honesty contract for every live widget.
//
// The product rule is "never fabricate, never present stale data as live". That
// is easy to say and easy to violate one widget at a time, so it is expressed
// HERE as a type every provider must return, rather than as a convention each
// route re-implements.
//
// The important consequence: there is no shape in which a provider can return
// a number without also stating when it was measured and whether that is still
// current. A widget cannot accidentally render a stale price as live, because
// the payload it receives always carries the verdict.
//
// UNAVAILABLE is a first-class outcome, not an error. A machine with no
// temperature sensor and a market with no configured provider are both normal
// states that the UI must state plainly — the alternative is a zero, and a zero
// is a lie.
// ---------------------------------------------------------------------------

/** How much to trust what is on screen. */
export type Freshness =
  /** Measured within its expected interval. */
  | "LIVE"
  /** Real, but older than expected — the provider or the network is lagging. */
  | "DELAYED"
  /** Real, but old enough that it should not drive a decision. */
  | "STALE"
  /** The source cannot answer at all: unconfigured, unsupported, unreachable. */
  | "UNAVAILABLE";

export interface ProviderMeta {
  freshness: Freshness;
  /** When the DATA was measured, not when it was served from cache. */
  observedAt: string;
  /** Seconds since `observedAt`. Precomputed so the client never drifts. */
  ageSeconds: number;
  /** Who produced it. Shown in the UI; also how a licence is attributed. */
  source: string;
  /** Present only when freshness is UNAVAILABLE. Plain, actionable English. */
  reason?: string;
  /** Whether the payload came from cache rather than a fresh upstream call. */
  cached?: boolean;
}

export interface ProviderResult<T> {
  data: T | null;
  meta: ProviderMeta;
}

/**
 * Classifies an age against a provider's own expectations.
 *
 * Thresholds are per-provider because "old" means different things: a crypto
 * price is stale in minutes, a weather observation is fine for an hour, and a
 * sunrise time is good all day. A single global constant would mislabel most of
 * them.
 */
export function classifyAge(
  ageSeconds: number,
  thresholds: { liveWithin: number; delayedWithin: number }
): Freshness {
  if (ageSeconds <= thresholds.liveWithin) return "LIVE";
  if (ageSeconds <= thresholds.delayedWithin) return "DELAYED";
  return "STALE";
}

export function meta(
  observedAt: Date,
  source: string,
  thresholds: { liveWithin: number; delayedWithin: number },
  extra: { cached?: boolean } = {}
): ProviderMeta {
  const ageSeconds = Math.max(0, Math.round((Date.now() - observedAt.getTime()) / 1000));
  return {
    freshness: classifyAge(ageSeconds, thresholds),
    observedAt: observedAt.toISOString(),
    ageSeconds,
    source,
    ...(extra.cached ? { cached: true } : {}),
  };
}

/**
 * The result for a source that cannot answer.
 *
 * `data` is null rather than an empty object: a caller destructuring a zeroed
 * shape is exactly how "0°C" ends up on screen for a missing sensor.
 */
export function unavailable(source: string, reason: string): ProviderResult<never> {
  return {
    data: null,
    meta: {
      freshness: "UNAVAILABLE",
      observedAt: new Date().toISOString(),
      ageSeconds: 0,
      source,
      reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface Entry<T> {
  value: T;
  observedAt: Date;
  expiresAt: number;
}

/**
 * A tiny in-process TTL cache, per provider.
 *
 * It exists to be a good citizen of free upstream APIs — Open-Meteo, CoinGecko
 * and Nominatim all rate-limit, and a dashboard with several open tabs would
 * otherwise hammer them. It also serves the last good value when upstream
 * fails, which is what lets a widget say "DELAYED" instead of going blank.
 *
 * Deliberately NOT shared across users for anything user-specific: the key is
 * supplied by the caller, and user-scoped providers include the user id in it.
 */
export class TtlCache<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(private ttlMs: number, private maxEntries = 200) {}

  get(key: string): { value: T; observedAt: Date; expired: boolean } | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    // `>=`, not `>`: at the expiry instant the entry HAS expired. With a
    // zero TTL the strict comparison made an entry permanently fresh within
    // the millisecond it was written.
    return { value: hit.value, observedAt: hit.observedAt, expired: Date.now() >= hit.expiresAt };
  }

  set(key: string, value: T, observedAt = new Date()): void {
    // Bounded so a long-running process cannot grow this without limit — for
    // example one entry per geocoded place name.
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, observedAt, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Fetch with a hard timeout.
 *
 * Every upstream here is a third party on the public internet. Without a
 * deadline one slow provider holds a request open until the client gives up,
 * and on the metrics stream it would stall the interval behind it.
 */
export async function fetchJson<T>(
  url: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Nominatim's usage policy REQUIRES an identifying User-Agent, and
        // sending one is a condition of using it at all.
        "User-Agent": "JARVIS-CommandCenter/3.0 (self-hosted)",
        Accept: "application/json",
        ...(options.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
