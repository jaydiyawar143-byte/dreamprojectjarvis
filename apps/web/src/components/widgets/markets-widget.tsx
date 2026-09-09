"use client";

// ---------------------------------------------------------------------------
// V3 — markets.
//
// Crypto and Indian indices sit in one card but are fetched independently, and
// each carries its OWN freshness. That matters here more than anywhere else:
// crypto is live from CoinGecko while indices are unavailable on this
// deployment, and a single shared badge would necessarily be wrong about one of
// them.
//
// The indices half renders the server's stated reason rather than a generic
// "unavailable", because the reason is actionable — it names the two variables
// that would switch it on.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { TrendingUp } from "lucide-react";
import {
  getCrypto,
  getIndices,
  type CryptoQuote,
  type IndexQuote,
  type Live,
} from "@/lib/api";
import { WidgetShell, FreshnessBadge } from "./widget-shell";

/** Refreshed on an interval, not on a stream: prices move, but not per second. */
const REFRESH_MS = 60_000;

function ChangePill({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-sys-dim">—</span>;
  const up = pct >= 0;
  return (
    <span
      className={`font-mono text-xs [font-variant-numeric:tabular-nums] ${
        up ? "text-emerald-300/90" : "text-red-300/90"
      }`}
    >
      {up ? "+" : ""}
      {pct.toFixed(2)}%
    </span>
  );
}

/** Crypto spans many orders of magnitude; a fixed precision suits none of it. */
function formatPrice(value: number): string {
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (value >= 1) return value.toFixed(2);
  return value.toPrecision(4);
}

export function MarketsWidget({ indicesEnabled = false }: { indicesEnabled?: boolean }) {
  const [crypto, setCrypto] = useState<Live<CryptoQuote[]> | null>(null);
  const [indices, setIndices] = useState<Live<IndexQuote[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    // Both in flight together; indices only when the server says it can answer,
    // so an unconfigured deployment makes no pointless request every minute.
    const [c, i] = await Promise.all([
      getCrypto(3),
      indicesEnabled ? getIndices() : Promise.resolve(null),
    ]);

    if (c.success && c.data) setCrypto(c.data);
    else setError(c.error?.message ?? "Could not load market data.");

    if (i && i.success && i.data) setIndices(i.data);
    setLoading(false);
  }, [indicesEnabled]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <WidgetShell
      testId="widget-markets"
      title="Markets"
      icon={<TrendingUp size={13} />}
      {...(crypto?.meta ? { meta: crypto.meta } : {})}
      loading={loading}
      error={error}
      onRetry={() => void load()}
    >
      <div className="space-y-2.5">
        <ul data-testid="crypto-list" className="space-y-1.5">
          {(crypto?.value ?? []).map((coin) => (
            <li key={coin.id} className="flex items-center gap-2">
              <span className="w-9 shrink-0 font-mono text-xs text-white/90">
                {coin.symbol}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-sys-dim">
                {coin.name}
              </span>
              <span className="font-mono text-xs text-sys-text/90 [font-variant-numeric:tabular-nums]">
                ${formatPrice(coin.price)}
              </span>
              <span className="w-14 text-right">
                <ChangePill pct={coin.changePct24h} />
              </span>
            </li>
          ))}
        </ul>

        {/* Indices carry their own badge — see the note at the top of the file. */}
        <div className="border-t border-white/[0.06] pt-2">
          <div className="mb-1.5 flex items-center gap-2">
            <p className="flex-1 font-mono text-xs uppercase tracking-hud text-sys-dim">
              Indian indices
            </p>
            {indices?.meta && <FreshnessBadge meta={indices.meta} />}
          </div>

          {indices?.value && indices.value.length > 0 ? (
            <ul data-testid="indices-list" className="space-y-1.5">
              {indices.value.map((idx) => (
                <li key={idx.symbol} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-white/90">
                    {idx.symbol}
                  </span>
                  {idx.marketState && idx.marketState !== "UNKNOWN" && (
                    <span className="font-mono text-xs uppercase tracking-hud text-sys-dim">
                      {idx.marketState === "OPEN" ? "Open" : "Closed"}
                    </span>
                  )}
                  <span className="font-mono text-xs text-sys-text/90 [font-variant-numeric:tabular-nums]">
                    {idx.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                  <span className="w-14 text-right">
                    <ChangePill pct={idx.changePct} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p data-testid="indices-unavailable" className="text-xs leading-relaxed text-sys-dim">
              {indices?.meta.reason ??
                "Real-time NIFTY and BANKNIFTY are licensed data. No provider is configured, so no value is shown."}
            </p>
          )}
        </div>
      </div>
    </WidgetShell>
  );
}
