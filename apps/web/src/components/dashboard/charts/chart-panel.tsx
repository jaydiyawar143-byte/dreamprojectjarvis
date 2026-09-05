"use client";

// ---------------------------------------------------------------------------
// Sprint 4.4 — Chart panel.
//
// Wraps a chart in the states a real data surface needs, plus two things the
// charts themselves cannot provide:
//
//   metric selector — the honest alternative to a second y-axis
//   table view      — the same figures as text, so the chart is never the only
//                     way to read the data (screen readers, print, CVD)
// ---------------------------------------------------------------------------

import { useId, useState, type ReactNode } from "react";
import { Table2, LineChart as LineIcon } from "lucide-react";
import { Panel } from "../panel";
import { EmptyState, ErrorState, LoadingState } from "../states";
import { METRIC_BY_KEY, formatMetric, type MetricKey, type MetricSpec } from "./chart-tokens";
import { cn } from "@/lib/utils";

export interface ChartRow {
  /** Row identity: a date for a series, a campaign name for a comparison. */
  label: string;
  value: number | null;
}

export function ChartPanel({
  title,
  description,
  metric,
  metrics,
  onMetricChange,
  loading,
  error,
  onRetry,
  emptyTitle,
  emptyMessage,
  isEmpty,
  tableRows,
  currency,
  children,
}: {
  title: string;
  description?: ReactNode;
  metric: MetricKey;
  metrics: MetricSpec[];
  onMetricChange: (m: MetricKey) => void;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  emptyTitle: string;
  emptyMessage: string;
  isEmpty: boolean;
  tableRows: ChartRow[];
  currency?: string;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const tableId = useId();
  const spec = METRIC_BY_KEY[metric];

  return (
    <Panel
      title={title}
      description={description}
      action={
        <div className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor={`${tableId}-metric`}>
            Metric to plot
          </label>
          <select
            id={`${tableId}-metric`}
            data-testid="metric-select"
            value={metric}
            onChange={(e) => onMetricChange(e.target.value as MetricKey)}
            className="sys-focus rounded border border-sys-line bg-sys-panel px-2 py-1 font-mono text-[0.58rem] uppercase tracking-hud text-sys-text"
          >
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            data-testid="toggle-table"
            onClick={() => setAsTable((v) => !v)}
            aria-pressed={asTable}
            aria-label={asTable ? "Show chart" : "Show data table"}
            title={asTable ? "Show chart" : "Show data table"}
            className={cn(
              "sys-focus rounded border p-1.5 transition-colors",
              asTable
                ? "border-sys-cyan/45 bg-sys-cyan/[0.08] text-sys-cyan"
                : "border-sys-line text-sys-dim hover:text-sys-text"
            )}
          >
            {asTable ? <LineIcon size={13} aria-hidden="true" /> : <Table2 size={13} aria-hidden="true" />}
          </button>
        </div>
      }
    >
      {loading ? (
        <LoadingState label={`Loading ${spec.label.toLowerCase()}`} lines={4} />
      ) : error ? (
        <ErrorState title="Could not load this chart" message={error} onRetry={onRetry} />
      ) : isEmpty ? (
        <EmptyState title={emptyTitle} message={emptyMessage} />
      ) : asTable ? (
        <div className="max-h-72 overflow-auto" data-testid="chart-table">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{`${title} — ${spec.label}`}</caption>
            <thead className="sticky top-0 bg-sys-panel">
              <tr className="border-b border-sys-line">
                <th scope="col" className="py-1.5 pr-3 font-mono text-[0.55rem] uppercase tracking-hud text-sys-dim">
                  {title.includes("Campaign") ? "Campaign" : "Date"}
                </th>
                <th scope="col" className="py-1.5 text-right font-mono text-[0.55rem] uppercase tracking-hud text-sys-dim">
                  {spec.label}
                </th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r, i) => (
                <tr key={`${r.label}-${i}`} className="border-b border-sys-line/50 last:border-0">
                  <td className="py-1.5 pr-3 text-sys-text/85">{r.label}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-sys-text">
                    {currency && spec.kind === "currency" ? `${currency} ` : ""}
                    {formatMetric(r.value, spec.kind)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </Panel>
  );
}
