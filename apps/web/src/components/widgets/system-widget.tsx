"use client";

// ---------------------------------------------------------------------------
// V3 — system monitor.
//
// Live host metrics over the authenticated socket, with a sparkline per series.
//
// THE UNAVAILABLE CASE IS THE INTERESTING ONE. On the machine this was built
// against — Intel UHD integrated graphics on Windows — CPU temperature, GPU
// utilisation, GPU memory and GPU temperature are simply not exposed by the OS.
// Those tiles say so, and say why. They do not render 0, and they do not render
// a dash next to a green "live" dot. On hardware that does expose sensors the
// same tiles fill in with no code change.
//
// The sparkline is inline SVG rather than a chart library: one polyline over
// 60-300 points does not justify a dependency, and this way the render cost is
// a single path per series.
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Cpu, HardDrive, MemoryStick, Network, Thermometer } from "lucide-react";
import type { Maybe, ProviderMeta } from "@/lib/api";
import { useSystemStream, type MetricHistory } from "@/lib/use-system-stream";
import { WidgetShell } from "./widget-shell";

type Range = 60 | 300;

/**
 * A sparkline.
 *
 * Normalised against `max` when given (percentages share a 0-100 axis so two
 * tiles are comparable) and against the series' own peak otherwise (network
 * rates have no natural ceiling).
 */
function Sparkline({
  series,
  max,
  className = "",
}: {
  series: number[];
  max?: number;
  className?: string;
}) {
  const path = useMemo(() => {
    if (series.length < 2) return null;
    const ceiling = max ?? Math.max(...series, 1);
    const width = 100;
    const height = 24;
    const step = width / (series.length - 1);

    return series
      .map((v, i) => {
        const x = i * step;
        // SVG y grows downward, so a high value must map to a low y.
        const y = height - Math.min(1, v / ceiling) * height;
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [series, max]);

  if (!path) {
    return <div className={`h-6 ${className}`} aria-hidden="true" />;
  }

  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      className={`h-6 w-full ${className}`}
      aria-hidden="true"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * One metric tile.
 *
 * Takes a `Maybe`, so an absent sensor is impossible to render as a number —
 * the unavailable branch is the only path when `value` is null.
 */
function Tile({
  label,
  icon,
  metric,
  unit = "",
  series,
  max,
  tone = "text-sys-cyan-soft",
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  metric: Maybe<number>;
  unit?: string;
  series?: number[];
  max?: number;
  tone?: string;
  testId?: string;
}) {
  const available = metric.value !== null;

  return (
    <div
      data-testid={testId}
      data-available={available ? "true" : "false"}
      className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="shrink-0 text-sys-dim" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[0.45rem] uppercase tracking-hud text-sys-dim">
          {label}
        </span>
      </div>

      {available ? (
        <>
          <p className={`font-mono text-sm leading-none [font-variant-numeric:tabular-nums] ${tone}`}>
            {Math.round(metric.value!)}
            <span className="ml-0.5 text-[0.6rem] text-sys-dim">{unit}</span>
          </p>
          {series && <Sparkline series={series} {...(max !== undefined ? { max } : {})} className={`mt-1 ${tone}`} />}
        </>
      ) : (
        // The reason, not a dash. "No sensor" and "0°C" are different claims.
        <p className="text-[0.55rem] leading-snug text-sys-dim/80">
          {metric.reason ?? "Unavailable"}
        </p>
      )}
    </div>
  );
}

function formatRate(bytesPerSec: number): string {
  const mbps = (bytesPerSec * 8) / 1_000_000;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`;
  return `${((bytesPerSec * 8) / 1000).toFixed(0)} kbps`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

export function SystemWidget() {
  const [range, setRange] = useState<Range>(60);
  const { snapshot, history, status } = useSystemStream(true);

  // The tail of each series, so switching range is a slice rather than a refetch.
  const windowed = useMemo(() => {
    const cut = (s: number[]) => s.slice(-range);
    return {
      cpu: cut(history.cpu),
      memory: cut(history.memory),
      netRx: cut(history.netRx),
      netTx: cut(history.netTx),
    } satisfies MetricHistory;
  }, [history, range, snapshot?.at]);

  // The stream is the source of truth about liveness, so the badge is derived
  // from the socket state rather than from a provider timestamp.
  const meta: ProviderMeta | undefined = snapshot
    ? {
        freshness: status === "live" ? "LIVE" : status === "offline" ? "STALE" : "DELAYED",
        observedAt: snapshot.at,
        ageSeconds: Math.max(0, Math.round((Date.now() - new Date(snapshot.at).getTime()) / 1000)),
        source: snapshot.containerized ? "container" : "host",
      }
    : undefined;

  const net = snapshot?.network;

  return (
    <WidgetShell
      testId="widget-system"
      title="System"
      icon={<Cpu size={13} />}
      {...(meta ? { meta } : {})}
      loading={!snapshot && status === "connecting"}
      error={
        status === "unauthenticated"
          ? "Sign in again to stream system metrics."
          : status === "offline" && !snapshot
            ? "The metrics stream is not connected."
            : null
      }
      action={
        <button
          type="button"
          data-testid="system-range-toggle"
          onClick={() => setRange((r) => (r === 60 ? 300 : 60))}
          aria-label={`Show ${range === 60 ? "five minutes" : "sixty seconds"} of history`}
          className="sys-focus rounded border border-sys-line px-1.5 py-0.5 font-mono text-[0.45rem] uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
        >
          {range === 60 ? "60s" : "5m"}
        </button>
      }
    >
      {snapshot && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Tile
              testId="tile-cpu"
              label="CPU"
              icon={<Cpu size={10} />}
              metric={snapshot.cpu.loadPct}
              unit="%"
              series={windowed.cpu}
              max={100}
            />
            <Tile
              testId="tile-ram"
              label="Memory"
              icon={<MemoryStick size={10} />}
              metric={{ value: snapshot.memory.usedPct }}
              unit="%"
              series={windowed.memory}
              max={100}
              tone="text-violet-300/90"
            />
            <Tile
              testId="tile-cpu-temp"
              label="CPU temp"
              icon={<Thermometer size={10} />}
              metric={snapshot.cpu.temperatureC}
              unit="°C"
              tone="text-amber-300/90"
            />
            <Tile
              testId="tile-gpu"
              label={snapshot.gpu.model.value ? "GPU" : "GPU"}
              icon={<Cpu size={10} />}
              metric={snapshot.gpu.utilizationPct}
              unit="%"
              tone="text-emerald-300/90"
            />
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <div
              data-testid="tile-disk"
              className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2"
            >
              <div className="mb-1 flex items-center gap-1.5">
                <HardDrive size={10} className="shrink-0 text-sys-dim" aria-hidden="true" />
                <span className="font-mono text-[0.45rem] uppercase tracking-hud text-sys-dim">Disk</span>
              </div>
              {snapshot.disk.value ? (
                <p className="font-mono text-sm leading-none text-sky-300/90 [font-variant-numeric:tabular-nums]">
                  {snapshot.disk.value.usedPct}
                  <span className="ml-0.5 text-[0.6rem] text-sys-dim">
                    % · {snapshot.disk.value.mount}
                  </span>
                </p>
              ) : (
                <p className="text-[0.55rem] text-sys-dim/80">{snapshot.disk.reason ?? "Unavailable"}</p>
              )}
            </div>

            <div
              data-testid="tile-network"
              className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2"
            >
              <div className="mb-1 flex items-center gap-1.5">
                <Network size={10} className="shrink-0 text-sys-dim" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-[0.45rem] uppercase tracking-hud text-sys-dim">
                  Network{net?.value ? ` · ${net.value.iface}` : ""}
                </span>
              </div>
              {net?.value ? (
                <>
                  <p className="font-mono text-[0.68rem] leading-tight text-sys-text/90 [font-variant-numeric:tabular-nums]">
                    ↓ {formatRate(net.value.rxBytesPerSec)}
                  </p>
                  <p className="font-mono text-[0.68rem] leading-tight text-sys-dim [font-variant-numeric:tabular-nums]">
                    ↑ {formatRate(net.value.txBytesPerSec)}
                  </p>
                  <Sparkline series={windowed.netRx} className="mt-0.5 text-sky-300/70" />
                </>
              ) : (
                <p className="text-[0.55rem] text-sys-dim/80">{net?.reason ?? "Unavailable"}</p>
              )}
            </div>
          </div>

          <p className="flex items-center justify-between font-mono text-[0.45rem] uppercase tracking-hud text-sys-dim/60">
            <span className="truncate">{snapshot.cpu.model}</span>
            <span className="shrink-0">up {formatUptime(snapshot.uptimeSeconds)}</span>
          </p>

          {/* Docker reports the container, not the machine. Saying so prevents
              a reader mistaking container memory for their laptop's. */}
          {snapshot.containerized && (
            <p className="text-[0.5rem] leading-snug text-sys-dim/70">
              Reporting the API container, not the host machine.
            </p>
          )}
        </div>
      )}
    </WidgetShell>
  );
}
