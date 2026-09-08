// ---------------------------------------------------------------------------
// V3 — market data.
//
// TWO SOURCES WITH VERY DIFFERENT STANDING, kept apart on purpose.
//
// CRYPTO is genuinely available: CoinGecko's public API needs no key and
// publishes a `last_updated` timestamp per coin, which is what makes honest
// freshness possible. The three coins shown are a named WATCHLIST rather than
// "top 3 by market cap" — see DEFAULT_CRYPTO_WATCHLIST for why — but every
// price and every rank reported is the provider's real value.
//
// INDIAN INDICES are NOT. Real-time NIFTY 50 and BANKNIFTY are licensed data.
// The two ways to get them for free are scraping NSE's site or calling an
// undocumented endpoint, and both were ruled out — correctly, because both
// break when the vendor changes anything and neither is licensed for
// redistribution.
//
// So the indices provider is a real, complete integration behind a key that
// this deployment does not have. With no key it reports UNAVAILABLE and says
// why. It never invents a number, and it never quietly downgrades to scraping.
// ---------------------------------------------------------------------------

import { TtlCache, fetchJson, meta, unavailable, type ProviderResult } from "./freshness.js";

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

const CRYPTO_SOURCE = "CoinGecko";
const CRYPTO_ENDPOINT = "https://api.coingecko.com/api/v3/coins/markets";

/** CoinGecko's free tier is rate-limited; a minute of cache stays well inside it. */
const CRYPTO_TTL_MS = 60 * 1000;
/** A price older than two minutes is DELAYED; older than fifteen, STALE. */
const CRYPTO_THRESHOLDS = { liveWithin: 120, delayedWithin: 900 };

export interface CryptoQuote {
  id: string;
  symbol: string;
  name: string;
  price: number;
  changePct24h: number | null;
  marketCapRank: number;
}

interface CoinGeckoCoin {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number | null;
  market_cap_rank: number;
  last_updated: string;
}

const cryptoCache = new TtlCache<CoinGeckoCoin[]>(CRYPTO_TTL_MS, 8);

/**
 * The default watchlist.
 *
 * NAMED coins rather than "top N by market cap", because the two answer
 * different questions. Ranking by market cap puts USDT — a dollar stablecoin
 * that is always ~$1.00 — at number three, which is factually correct and
 * useless on a dashboard. These are the three the product asks for; the prices
 * are still entirely real, and the ranking is still reported per coin.
 */
export const DEFAULT_CRYPTO_WATCHLIST = ["bitcoin", "ethereum", "solana"] as const;

export async function getTopCrypto(
  count = 3,
  watchlist: readonly string[] = DEFAULT_CRYPTO_WATCHLIST
): Promise<ProviderResult<CryptoQuote[]>> {
  const limit = Math.min(Math.max(count, 1), 10);
  const ids = watchlist.slice(0, limit);
  const key = `ids:${ids.join(",")}`;
  const hit = cryptoCache.get(key);

  if (hit && !hit.expired) {
    return { data: shapeCrypto(hit.value), meta: meta(hit.observedAt, CRYPTO_SOURCE, CRYPTO_THRESHOLDS, { cached: true }) };
  }

  // Requested by id. `order=market_cap_desc` still applies so the returned rows
  // are in a stable, meaningful order, and each row carries its real rank.
  const url =
    `${CRYPTO_ENDPOINT}?vs_currency=usd&ids=${encodeURIComponent(ids.join(","))}` +
    `&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;

  try {
    const coins = await fetchJson<CoinGeckoCoin[]>(url, { timeoutMs: 8000 });
    if (!Array.isArray(coins) || coins.length === 0) {
      return unavailable(CRYPTO_SOURCE, "The market service returned no quotes.");
    }

    // The oldest quote in the set governs freshness: reporting the newest would
    // overstate how current the slowest row is.
    const observedAt = coins.reduce<Date>((oldest, c) => {
      const t = c.last_updated ? new Date(c.last_updated) : new Date();
      return t < oldest ? t : oldest;
    }, new Date());

    cryptoCache.set(key, coins, observedAt);
    return { data: shapeCrypto(coins), meta: meta(observedAt, CRYPTO_SOURCE, CRYPTO_THRESHOLDS) };
  } catch {
    if (hit) {
      return { data: shapeCrypto(hit.value), meta: meta(hit.observedAt, CRYPTO_SOURCE, CRYPTO_THRESHOLDS, { cached: true }) };
    }
    return unavailable(CRYPTO_SOURCE, "The market service could not be reached.");
  }
}

function shapeCrypto(coins: CoinGeckoCoin[]): CryptoQuote[] {
  return coins.map((c) => ({
    id: c.id,
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    price: c.current_price,
    changePct24h: c.price_change_percentage_24h ?? null,
    marketCapRank: c.market_cap_rank,
  }));
}

// ---------------------------------------------------------------------------
// Indian indices
// ---------------------------------------------------------------------------

export interface IndexQuote {
  symbol: string;
  name: string;
  value: number;
  change: number | null;
  changePct: number | null;
  /** Whether the exchange is open, when the provider reports it. */
  marketState?: "OPEN" | "CLOSED" | "PRE_OPEN" | "UNKNOWN";
}

const INDEX_TTL_MS = 30 * 1000;
const INDEX_THRESHOLDS = { liveWithin: 60, delayedWithin: 900 };

const indexCache = new TtlCache<{ quotes: IndexQuote[] }>(INDEX_TTL_MS, 4);

export interface IndicesConfig {
  /** Base URL of a licensed market-data vendor. */
  baseUrl: string;
  apiKey: string;
}

/**
 * Whether a licensed indices provider is configured.
 *
 * BOTH halves are required. A base URL with no key would call an endpoint that
 * refuses us, and reporting "configured" then failing every request is worse
 * than reporting the truth up front.
 */
export function isIndicesConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.MARKET_INDICES_API_URL) && Boolean(env.MARKET_INDICES_API_KEY);
}

export function createIndicesConfig(env: NodeJS.ProcessEnv = process.env): IndicesConfig | null {
  if (!isIndicesConfigured(env)) return null;
  return {
    baseUrl: env.MARKET_INDICES_API_URL!.replace(/\/+$/, ""),
    apiKey: env.MARKET_INDICES_API_KEY!,
  };
}

const INDEX_SYMBOLS = ["NIFTY 50", "NIFTY BANK"] as const;

/**
 * NIFTY 50 and BANKNIFTY from a licensed vendor.
 *
 * The vendor contract is deliberately generic — `GET {baseUrl}/quote?symbol=…`
 * with a bearer key, returning value/change/percent/market state — because
 * which vendor is used is a commercial decision, not an architectural one.
 * Swapping vendors should mean changing `mapVendorQuote`, not this file's shape.
 */
export async function getIndianIndices(
  config: IndicesConfig | null
): Promise<ProviderResult<IndexQuote[]>> {
  if (!config) {
    return unavailable(
      "Licensed market data",
      "No Indian market-data provider is configured. Real-time NIFTY and BANKNIFTY are licensed data; set MARKET_INDICES_API_URL and MARKET_INDICES_API_KEY to enable this widget."
    );
  }

  const hit = indexCache.get("indices");
  if (hit && !hit.expired) {
    return { data: hit.value.quotes, meta: meta(hit.observedAt, "Licensed market data", INDEX_THRESHOLDS, { cached: true }) };
  }

  try {
    const quotes: IndexQuote[] = [];
    for (const symbol of INDEX_SYMBOLS) {
      const payload = await fetchJson<Record<string, unknown>>(
        `${config.baseUrl}/quote?symbol=${encodeURIComponent(symbol)}`,
        {
          timeoutMs: 6000,
          // The key travels in a header and never reaches the browser: this
          // whole module runs server-side for exactly that reason.
          headers: { Authorization: `Bearer ${config.apiKey}` },
        }
      );
      const mapped = mapVendorQuote(symbol, payload);
      if (mapped) quotes.push(mapped);
    }

    if (quotes.length === 0) {
      return unavailable("Licensed market data", "The market-data provider returned no quotes.");
    }

    const observedAt = new Date();
    indexCache.set("indices", { quotes }, observedAt);
    return { data: quotes, meta: meta(observedAt, "Licensed market data", INDEX_THRESHOLDS) };
  } catch {
    if (hit) {
      return { data: hit.value.quotes, meta: meta(hit.observedAt, "Licensed market data", INDEX_THRESHOLDS, { cached: true }) };
    }
    return unavailable("Licensed market data", "The market-data provider could not be reached.");
  }
}

/**
 * Normalises one vendor payload.
 *
 * Written defensively because vendors differ: any of these key spellings is
 * common, and a missing value yields null rather than 0 — a zeroed index is
 * indistinguishable from a crash to a reader.
 */
function mapVendorQuote(symbol: string, payload: Record<string, unknown>): IndexQuote | null {
  const num = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = payload[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };

  const value = num("last", "lastPrice", "value", "close", "ltp");
  if (value === null) return null;

  const state = payload.marketState ?? payload.market_state ?? payload.status;
  const marketState =
    typeof state === "string" && ["OPEN", "CLOSED", "PRE_OPEN"].includes(state.toUpperCase())
      ? (state.toUpperCase() as IndexQuote["marketState"])
      : "UNKNOWN";

  return {
    symbol: symbol === "NIFTY BANK" ? "BANKNIFTY" : "NIFTY 50",
    name: symbol,
    value,
    change: num("change", "netChange", "chg"),
    changePct: num("changePercent", "pChange", "percentChange", "changePct"),
    marketState,
  };
}

export function __resetMarketCaches(): void {
  cryptoCache.clear();
  indexCache.clear();
}
