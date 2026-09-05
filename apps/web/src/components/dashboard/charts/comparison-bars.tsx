"use client";

// ---------------------------------------------------------------------------
// Sprint 4.4 — Magnitude comparison.
//
// Horizontal bars, because the identities are campaign names: long, of varying
// length, and unreadable rotated under a vertical axis. Length carries the
// magnitude, so every bar is the same colour — shading them by value would
// encode the same fact twice and imply a category that is not there.
//
// Rows are pre-sorted by the API (largest spend first).
// ---------------------------------------------------------------------------

import { useId, useState } from "react";
import type { CampaignMetrics } from "@/lib/api";
import { CHART, METRIC_BY_KEY, formatMetric, type MetricKey } from "./chart-tokens";

export function ComparisonBars({
  rows,
  metric,
  currency,
  maxRows = 8,
}: {
  rows: CampaignMetrics[];
  metric: MetricKey;
  currency?: string;
  maxRows?: number;
}) {
  const titleId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const spec = METRIC_BY_KEY[metric];

  const usable = rows
    .map((r) => ({ row: r, value: r[metric] }))
    .filter((r): r is { row: CampaignMetrics; value: number } =>
      typeof r.value === "number" && Number.isFinite(r.value)
    )
    .sort((a, b) => b.value - a.value)
    .slice(0, maxRows);

  if (usable.length === 0) return null;

  const max = Math.max(...usable.map((u) => u.value)) || 1;
  const unit = spec.kind === "currency" && currency ? `${currency} ` : "";

  return (
    <div className="w-full">
      <ul className="space-y-2.5" aria-labelledby={titleId}>
        <span id={titleId} className="sr-only">
          {`Campaigns by ${spec.label}, largest first`}
        </span>

        {usable.map((u, i) => {
          const pct = (u.value / max) * 100;
          const name = u.row.campaignName ?? u.row.campaignId ?? "Unnamed campaign";
          const isHover = hover === i;

          return (
            <li
              key={u.row.campaignId ?? `row-${i}`}
              data-testid="comparison-row"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="group"
            >
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="truncate text-xs text-sys-text/85" title={name}>
                  {name}
                </span>
                {/* The value is direct-labelled, so the bar never has to be
                    measured against the axis to be read. */}
                <span className="shrink-0 font-mono text-xs tabular-nums text-sys-text">
                  {unit}
                  {formatMetric(u.value, spec.kind)}
                </span>
              </div>

              <div className="h-2 w-full overflow-hidden rounded-sm bg-sys-edge/35">
                <div
                  className="h-full rounded-sm transition-[width] duration-300"
                  style={{
                    width: `${Math.max(pct, 1.5)}%`,
                    background: isHover ? CHART.seriesBright : CHART.series,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
