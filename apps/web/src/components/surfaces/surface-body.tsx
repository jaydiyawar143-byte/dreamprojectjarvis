"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react";
import type { Surface, SurfaceProvenance } from "@jarvis/core/surface";
import { RouteSurface } from "./route-surface";

// ---------------------------------------------------------------------------
// Surface bodies.
//
// One renderer per data variant. Each is handed a shape the schema has already
// validated, so none of them defends against malformed input — that argument
// was had at the boundary, and repeating it here would only spread the
// responsibility around until it was unclear who held it.
//
// What they DO all do is render absence honestly: a null is an em dash and,
// where the provider explained itself, its reason. No renderer here turns a
// missing measurement into a zero.
// ---------------------------------------------------------------------------

/** Source and freshness, on every surface that shows somebody else's data. */
function Provenance({ meta }: { meta: SurfaceProvenance }) {
  const age = meta.observedAt
    ? Math.max(0, Math.round((Date.now() - new Date(meta.observedAt).getTime()) / 1000))
    : null;

  const when =
    age === null ? null : age < 45 ? "just now" : age < 3600 ? `${Math.round(age / 60)} min ago` : `${Math.round(age / 3600)} h ago`;

  return (
    <p
      data-testid="surface-provenance"
      className="mt-3 border-t border-white/[0.06] pt-2 font-mono text-xs uppercase tracking-hud text-sys-dim"
    >
      {meta.source}
      {when ? ` · ${when}` : ""}
      {meta.freshness !== "LIVE" ? ` · ${meta.freshness.toLowerCase()}` : ""}
    </p>
  );
}

const dash = <span className="text-sys-dim">—</span>;

// ---------------------------------------------------------------------------
// Clock — rendered from ZONES, live, on the client's own clock
// ---------------------------------------------------------------------------

function ClockBody({ data }: { data: Extract<Surface["data"], { kind: "clock" }> }) {
  // Ticking here rather than trusting a server timestamp. A time serialised on
  // the server is already stale by the network latency and visibly wrong within
  // a minute; a clock that is slightly wrong is worse than no clock at all.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Nothing on the server render: the server's clock is not the user's, and a
  // hydration mismatch on a ticking value is guaranteed otherwise.
  if (!now) return <div className="h-24" aria-hidden="true" />;

  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: data.hourFormat === "12",
    }).format(now);

  const dateOf = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(now);

  const single = data.zones.length === 1;

  return (
    <div data-testid="clock-body">
      {single ? (
        <div className="text-center">
          <p
            data-testid="clock-time"
            className="font-mono text-4xl tabular-nums tracking-tight text-white"
          >
            {fmt(data.zones[0]!.timeZone)}
          </p>
          <p className="mt-1 text-sm text-sys-text/70">{dateOf(data.zones[0]!.timeZone)}</p>
          <p className="mt-0.5 font-mono text-xs uppercase tracking-hud text-sys-dim">
            {data.zones[0]!.timeZone}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {data.zones.map((z) => (
            <li key={z.timeZone} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-sys-text/85">{z.label}</span>
              <span className="shrink-0 font-mono text-lg tabular-nums text-white">
                {fmt(z.timeZone)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function WeatherBody({ data }: { data: Extract<Surface["data"], { kind: "weather" }> }) {
  return (
    <div data-testid="weather-body">
      <div className="flex items-baseline gap-3">
        <p className="font-mono text-4xl tabular-nums text-white">
          {data.temperatureC === null ? dash : `${Math.round(data.temperatureC)}°`}
        </p>
        <p className="text-sm text-sys-text/75">{data.condition ?? dash}</p>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        {[
          { label: "Feels like", value: data.feelsLikeC === null ? null : `${Math.round(data.feelsLikeC)}°` },
          { label: "Humidity", value: data.humidityPct === null ? null : `${Math.round(data.humidityPct)}%` },
          { label: "Wind", value: data.windKph === null ? null : `${Math.round(data.windKph)} km/h` },
        ].map((row) => (
          <div key={row.label} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
            <dt className="font-mono uppercase tracking-hud text-sys-dim">{row.label}</dt>
            <dd className="mt-0.5 font-mono tabular-nums text-sys-text/90">{row.value ?? dash}</dd>
          </div>
        ))}
      </dl>

      <Provenance meta={data.provenance} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function MarketBody({ data }: { data: Extract<Surface["data"], { kind: "market" }> }) {
  return (
    <div data-testid="market-body">
      <ul className="space-y-2">
        {data.quotes.map((q) => {
          const up = (q.change24hPct ?? 0) >= 0;
          return (
            <li key={q.symbol} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-white/90">{q.name}</p>
                <p className="font-mono text-xs uppercase tracking-hud text-sys-dim">{q.symbol}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono tabular-nums text-white">
                  {q.price === null ? dash : `$${q.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
                </p>
                {q.change24hPct !== null && (
                  <p
                    className={`flex items-center justify-end gap-1 font-mono text-xs tabular-nums ${
                      up ? "text-emerald-300/90" : "text-red-300/90"
                    }`}
                  >
                    {up ? <TrendingUp size={11} aria-hidden="true" /> : <TrendingDown size={11} aria-hidden="true" />}
                    {q.change24hPct.toFixed(2)}%
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/*
        Analysis, in labelled blocks.

        The labels are the point. A bull case and a measured price are different
        kinds of claim, and a panel that runs them together as one paragraph
        invites the reader to treat reasoning as data. Nothing here is presented
        as a prediction, and there is no field in which a guaranteed return
        could be expressed.
      */}
      {data.analysis && (
        <div data-testid="market-analysis" className="mt-4 space-y-3">
          {(
            [
              { key: "facts", label: "From the data", tone: "text-sys-text/85" },
              { key: "bullCase", label: "Bull case", tone: "text-emerald-300/85" },
              { key: "bearCase", label: "Bear case", tone: "text-red-300/85" },
              { key: "risks", label: "Key risks", tone: "text-amber-300/85" },
            ] as const
          ).map(({ key, label, tone }) => {
            const items = data.analysis?.[key] ?? [];
            if (items.length === 0) return null;
            return (
              <section key={key}>
                <h3 className={`font-mono text-xs uppercase tracking-hud ${tone}`}>{label}</h3>
                <ul className="mt-1 space-y-1">
                  {items.map((line, i) => (
                    <li key={i} className="text-xs leading-relaxed text-sys-text/80">
                      {line}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          <p className="border-t border-white/[0.06] pt-2 text-xs leading-relaxed text-sys-dim">
            Analysis, not advice. Markets can move against any of the above.
          </p>
        </div>
      )}

      <Provenance meta={data.provenance} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function SystemBody({ data }: { data: Extract<Surface["data"], { kind: "system" }> }) {
  return (
    <div data-testid="system-body">
      <ul className="grid grid-cols-2 gap-2">
        {data.metrics.map((m) => (
          <li key={m.label} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
            <p className="font-mono text-xs uppercase tracking-hud text-sys-dim">{m.label}</p>
            {m.value === null ? (
              // The honest empty state. Never a zero — a zero is a reading.
              <p className="mt-0.5 text-xs leading-snug text-sys-dim/80">{m.reason ?? "Unavailable"}</p>
            ) : (
              <p className="mt-0.5 font-mono tabular-nums text-sys-text/90">
                {Math.round(m.value)}
                <span className="ml-0.5 text-xs text-sys-dim">{m.unit}</span>
              </p>
            )}
          </li>
        ))}
      </ul>
      <Provenance meta={data.provenance} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function UnavailableBody({ data }: { data: Extract<Surface["data"], { kind: "unavailable" }> }) {
  return (
    <div data-testid="unavailable-body" className="flex items-start gap-2">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300/90" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm text-sys-text/85">{data.reason}</p>
        {data.retryIntent && (
          <button
            type="button"
            data-testid="surface-retry"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("jarvis:surface-intent", { detail: { intent: data.retryIntent } })
              )
            }
            className="sys-focus mt-2 rounded border border-sys-line px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function GenericBody({ data }: { data: Extract<Surface["data"], { kind: "generic" }> }) {
  return (
    <div data-testid="generic-body">
      <dl className="space-y-1.5">
        {data.rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="font-mono text-xs uppercase tracking-hud text-sys-dim">{row.label}</dt>
            <dd className="min-w-0 truncate text-sm text-sys-text/90">{row.value}</dd>
          </div>
        ))}
      </dl>
      {data.provenance && <Provenance meta={data.provenance} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function KnowledgeBody({ data }: { data: Extract<Surface["data"], { kind: "knowledge" }> }) {
  return (
    <div data-testid="knowledge-body">
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-sys-text/85">{data.summary}</p>
      {data.citations.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-white/[0.06] pt-2">
          {data.citations.map((c, i) => (
            <li key={`${c.documentId}-${i}`}>
              <p className="font-mono text-xs uppercase tracking-hud text-sys-dim">{c.documentName}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-sys-text/70">{c.excerpt}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TasksBody({ data }: { data: Extract<Surface["data"], { kind: "tasks" }> }) {
  if (data.tasks.length === 0) {
    return <p className="text-sm text-sys-dim">Nothing due.</p>;
  }
  return (
    <ul data-testid="tasks-body" className="space-y-1.5">
      {data.tasks.map((t) => (
        <li key={t.id} className="flex items-baseline justify-between gap-3">
          <span className={`min-w-0 truncate text-sm ${t.done ? "text-sys-dim line-through" : "text-sys-text/90"}`}>
            {t.title}
          </span>
          {t.dueAt && (
            <span className="shrink-0 font-mono text-xs uppercase tracking-hud text-sys-dim">{t.dueAt}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

export function SurfaceBody({ surface }: { surface: Surface }) {
  const data = surface.data;

  switch (data.kind) {
    case "clock":
      return <ClockBody data={data} />;
    case "weather":
      return <WeatherBody data={data} />;
    case "route":
    case "map":
      return <RouteSurface surface={surface} />;
    case "market":
      return <MarketBody data={data} />;
    case "system":
      return <SystemBody data={data} />;
    case "tasks":
      return <TasksBody data={data} />;
    case "knowledge":
      return <KnowledgeBody data={data} />;
    case "generic":
      return <GenericBody data={data} />;
    case "unavailable":
      return <UnavailableBody data={data} />;
    default:
      // Unreachable while the union and this switch agree. If a variant is
      // ever added without a renderer, nothing is shown rather than a crash
      // taking the dashboard down with it.
      return null;
  }
}
