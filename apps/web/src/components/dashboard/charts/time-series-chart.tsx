"use client";

// ---------------------------------------------------------------------------
// Sprint 4.4 — Single-series time chart.
//
// Deliberately ONE series. Spend, impressions and ROAS live on scales orders of
// magnitude apart, and putting two of them on one plot needs a second y-axis —
// the single most misleading thing a chart can do, because the crossing point
// is an artefact of the two scales rather than a fact about the data. The
// metric selector above the plot is the honest alternative.
//
// A null point is a gap in Meta's data, not a zero. The line breaks across it.
// ---------------------------------------------------------------------------

import { useId, useMemo, useState } from "react";
import type { MetricPoint } from "@/lib/api";
import {
  CHART,
  METRIC_BY_KEY,
  formatDay,
  formatMetric,
  niceTicks,
  type MetricKey,
} from "./chart-tokens";

const VB = { w: 720, h: 260 };
const PAD = { top: 16, right: 18, bottom: 30, left: 54 };

const PLOT = {
  w: VB.w - PAD.left - PAD.right,
  h: VB.h - PAD.top - PAD.bottom,
};

interface Placed {
  point: MetricPoint;
  value: number | null;
  x: number;
  y: number | null;
}

export function TimeSeriesChart({
  series,
  metric,
  currency,
}: {
  series: MetricPoint[];
  metric: MetricKey;
  currency?: string;
}) {
  const titleId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const spec = METRIC_BY_KEY[metric];

  const { placed, ticks, max } = useMemo(() => {
    const values = series.map((p) => {
      const v = p[metric];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    });
    const present = values.filter((v): v is number => v !== null);
    const maxValue = present.length ? Math.max(...present) : 0;
    const axisTicks = niceTicks(maxValue);
    const axisMax = axisTicks[axisTicks.length - 1] || 1;

    const step = series.length > 1 ? PLOT.w / (series.length - 1) : 0;

    const points: Placed[] = series.map((point, i) => {
      const value = values[i]!;
      return {
        point,
        value,
        x: PAD.left + (series.length === 1 ? PLOT.w / 2 : i * step),
        y: value === null ? null : PAD.top + PLOT.h - (value / axisMax) * PLOT.h,
      };
    });

    return { placed: points, ticks: axisTicks, max: axisMax };
  }, [series, metric]);

  if (series.length === 0) return null;

  // Split into runs of consecutive present values, so a gap is a break in the
  // line rather than a straight segment implying data that does not exist.
  const runs: Placed[][] = [];
  let run: Placed[] = [];
  for (const p of placed) {
    if (p.y === null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push(p);
    }
  }
  if (run.length) runs.push(run);

  const active = hover !== null ? placed[hover] : null;
  const unit = spec.kind === "currency" && currency ? `${currency} ` : "";

  // Label only the ends and the middle; a label on every point is noise.
  const labelled = new Set<number>(
    series.length <= 2 ? placed.map((_, i) => i) : [0, Math.floor(placed.length / 2), placed.length - 1]
  );

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${VB.w} ${VB.h}`}
        className="w-full"
        style={{ height: "auto" }}
        role="img"
        aria-labelledby={titleId}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}
      >
        <title id={titleId}>
          {`${spec.label} per day from ${series[0]!.date} to ${series[series.length - 1]!.date}`}
        </title>

        {/* Horizontal grid. Every line names a value the chart reaches. */}
        {ticks.map((t) => {
          const y = PAD.top + PLOT.h - (t / max) * PLOT.h;
          return (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={PAD.left + PLOT.w}
                y1={y}
                y2={y}
                stroke={CHART.grid}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y + 3.5}
                textAnchor="end"
                fontSize={10}
                fill={CHART.label}
                fontFamily="var(--font-mono), monospace"
              >
                {formatMetric(t, spec.kind)}
              </text>
            </g>
          );
        })}

        {/* Baseline */}
        <line
          x1={PAD.left}
          x2={PAD.left + PLOT.w}
          y1={PAD.top + PLOT.h}
          y2={PAD.top + PLOT.h}
          stroke={CHART.axis}
          strokeWidth={1}
        />

        {/* Area wash + line, one path pair per unbroken run */}
        {runs.map((r, i) => {
          const d = r.map((p, j) => `${j === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
          const areaD =
            r.length > 1
              ? `${d} L ${r[r.length - 1]!.x} ${PAD.top + PLOT.h} L ${r[0]!.x} ${PAD.top + PLOT.h} Z`
              : "";
          return (
            <g key={i}>
              {areaD && <path d={areaD} fill={CHART.seriesWash} stroke="none" />}
              <path
                d={d}
                fill="none"
                stroke={CHART.series}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {/* A lone point would otherwise be invisible: a path of one has no length. */}
        {runs
          .filter((r) => r.length === 1)
          .map((r, i) => (
            <circle key={`solo-${i}`} cx={r[0]!.x} cy={r[0]!.y!} r={3.5} fill={CHART.series} />
          ))}

        {/* Emphasised endpoint — where the series got to is the thing people look for. */}
        {(() => {
          const last = [...placed].reverse().find((p) => p.y !== null);
          if (!last) return null;
          return (
            <circle
              cx={last.x}
              cy={last.y!}
              r={4}
              fill={CHART.seriesBright}
              stroke="#070d16"
              strokeWidth={2}
            />
          );
        })()}

        {/* Crosshair + hovered marker */}
        {active && active.y !== null && (
          <g pointerEvents="none">
            <line
              x1={active.x}
              x2={active.x}
              y1={PAD.top}
              y2={PAD.top + PLOT.h}
              stroke={CHART.crosshair}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle
              cx={active.x}
              cy={active.y}
              r={5}
              fill={CHART.seriesBright}
              stroke="#070d16"
              strokeWidth={2}
            />
          </g>
        )}

        {/* x labels */}
        {placed.map((p, i) =>
          labelled.has(i) ? (
            <text
              key={p.point.date}
              x={p.x}
              y={VB.h - 10}
              textAnchor={i === 0 ? "start" : i === placed.length - 1 ? "end" : "middle"}
              fontSize={10}
              fill={CHART.label}
              fontFamily="var(--font-mono), monospace"
            >
              {formatDay(p.point.date)}
            </text>
          ) : null
        )}

        {/* Hit targets, wider than the marks so hovering is easy. */}
        {placed.map((p, i) => (
          <rect
            key={`hit-${p.point.date}`}
            x={p.x - (series.length > 1 ? PLOT.w / series.length / 2 : PLOT.w / 2)}
            y={PAD.top}
            width={series.length > 1 ? PLOT.w / series.length : PLOT.w}
            height={PLOT.h}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            data-testid={`ts-hit-${i}`}
          />
        ))}
      </svg>

      {/* Tooltip, below the plot so it never covers the line it describes. */}
      <div className="mt-1 min-h-[1.5rem]" aria-live="polite" data-testid="ts-tooltip">
        {active ? (
          // The readout wears the HUD label treatment; it is a measurement.
          <span className="font-mono text-[0.6rem] uppercase tracking-hud text-sys-text/85">
            {formatDay(active.point.date)}
            <span className="mx-2 text-sys-dim">·</span>
            {spec.label} {unit}
            {formatMetric(active.value, spec.kind)}
          </span>
        ) : (
          // The prompt is an aside, not a label — plain and quiet.
          <span className="text-xs text-sys-dim">Hover the chart for a day&rsquo;s figures</span>
        )}
      </div>
    </div>
  );
}
