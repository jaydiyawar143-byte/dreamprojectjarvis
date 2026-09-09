"use client";

// ---------------------------------------------------------------------------
// Sprint 4.6 — Meta Ads panel.
//
// READ-ONLY. Every request this page makes is a GET. It never calls
// /recommendations/:id/execute, never calls an approval endpoint, and never
// reaches a Meta write tool — the dashboard API it reads from will only run
// tools on its read-only allow-list. Acting on a recommendation means following
// the link into the existing opportunity → approval flow, unchanged.
//
// The account id is never chosen here; it comes from server configuration.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import {
  getMetaAccount,
  getMetaCampaigns,
  getMetaOverview,
  getMetaTimeseries,
  listOpportunities,
  type CampaignMetrics,
  type MetaAccountContext,
  type MetricPoint,
  type MetricTotals,
  type OpportunityQueueItem,
} from "@/lib/api";
import { PageContainer, PageHeader, PanelGrid } from "@/components/dashboard/page-container";
import { Panel, StatPanel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState } from "@/components/dashboard/states";
import { ChartPanel } from "@/components/dashboard/charts/chart-panel";
import { TimeSeriesChart } from "@/components/dashboard/charts/time-series-chart";
import { ComparisonBars } from "@/components/dashboard/charts/comparison-bars";
import {
  METRIC_BY_KEY,
  METRIC_SPECS,
  formatDay,
  formatMetric,
  type MetricKey,
} from "@/components/dashboard/charts/chart-tokens";
import { OpportunityPanel } from "@/components/dashboard/meta/opportunity-panel";

type Gate = "loading" | "ok" | "not-configured" | "not-authorized" | "error";

export default function MetaAdsPage() {
  const [gate, setGate] = useState<Gate>("loading");
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const [account, setAccount] = useState<MetaAccountContext | null>(null);

  const [totals, setTotals] = useState<MetricTotals | null>(null);
  const [series, setSeries] = useState<MetricPoint[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignMetrics[]>([]);
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  const [opportunities, setOpportunities] = useState<OpportunityQueueItem[]>([]);
  const [oppLoading, setOppLoading] = useState(true);
  const [oppError, setOppError] = useState<string | null>(null);

  const [seriesMetric, setSeriesMetric] = useState<MetricKey>("spend");
  const [compareMetric, setCompareMetric] = useState<MetricKey>("spend");

  // Account context is the gate: without it there is nothing honest to show.
  const loadAccount = useCallback(async () => {
    const res = await getMetaAccount();
    if (res.success && res.data) {
      setAccount(res.data.account);
      setGate("ok");
      return true;
    }
    if (res.error?.code === "ACCOUNT_NOT_CONFIGURED") setGate("not-configured");
    else if (res.error?.code === "ACCOUNT_NOT_AUTHORIZED" || res.error?.code === "FORBIDDEN")
      setGate("not-authorized");
    else {
      setGate("error");
      setGateMessage(res.error?.message ?? "Could not reach the ad account.");
    }
    return false;
  }, []);

  const loadMetrics = useCallback(async () => {
    setMetricsLoading(true);
    setMetricsError(null);

    const [overview, timeseries, comparison] = await Promise.all([
      getMetaOverview(),
      getMetaTimeseries(),
      getMetaCampaigns(undefined, 10),
    ]);

    if (!overview.success && !timeseries.success && !comparison.success) {
      setMetricsError(overview.error?.message ?? "Meta data is unavailable.");
      setMetricsLoading(false);
      return;
    }

    setTotals(overview.data?.totals ?? null);
    setSeries(timeseries.data?.series ?? []);
    setCampaigns(comparison.data?.campaigns ?? []);
    setRange(overview.data?.dateRange ?? timeseries.data?.dateRange ?? null);
    setMetricsLoading(false);
  }, []);

  const loadOpportunities = useCallback(async () => {
    setOppLoading(true);
    setOppError(null);
    const res = await listOpportunities({ limit: 5 });
    if (res.success) setOpportunities(res.items ?? []);
    else setOppError(res.error?.message ?? "Could not load opportunities.");
    setOppLoading(false);
  }, []);

  useEffect(() => {
    void (async () => {
      const usable = await loadAccount();
      if (!usable) {
        setMetricsLoading(false);
        setOppLoading(false);
        return;
      }
      void loadMetrics();
      void loadOpportunities();
    })();
  }, [loadAccount, loadMetrics, loadOpportunities]);

  const kpi = (key: MetricKey) =>
    totals ? formatMetric(totals[key], METRIC_BY_KEY[key].kind) : "—";

  // ---- Gates ------------------------------------------------------------

  if (gate === "not-configured" || gate === "not-authorized" || gate === "error") {
    return (
      <PageContainer>
        <PageHeader title="Meta Ads" description="Performance and proposed changes for your ad account." />
        <Panel>
          {gate === "not-configured" ? (
            <EmptyState
              title="No ad account connected"
              message="This deployment has no Meta ad account configured, so there is nothing to report."
            />
          ) : gate === "not-authorized" ? (
            <EmptyState
              title="Not authorized for this account"
              message="Your account does not have access to the ad account this server is configured with."
            />
          ) : (
            <ErrorState title="Meta is unreachable" message={gateMessage ?? "Unknown error"} onRetry={() => void loadAccount()} />
          )}
        </Panel>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Meta Ads"
        description="Performance and proposed changes for your ad account."
        actions={
          <span
            data-testid="read-only-badge"
            className="inline-flex items-center gap-1.5 rounded border border-sys-ok/40 bg-sys-ok/[0.07] px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-ok"
          >
            <ShieldCheck size={11} aria-hidden="true" />
            Read only
          </span>
        }
      />

      <div className="space-y-6">
        {/* ---- Account context ---------------------------------------- */}
        <Panel title="Account" tone="accent">
          <dl
            data-testid="account-context"
            className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4"
          >
            {[
              ["Account", account?.name ?? account?.accountId ?? "—"],
              ["Account ID", account?.accountId ?? "—"],
              ["Currency", account?.currency ?? "—"],
              ["Timezone", account?.timezone ?? "—"],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="font-mono text-xs uppercase tracking-hud text-sys-dim">{label}</dt>
                <dd className="truncate text-sm text-sys-text" title={String(value)}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          {range && (
            <p className="mt-3 border-t border-sys-line/60 pt-2.5 text-xs text-sys-dim">
              Figures below cover {range.start} to {range.end}.
            </p>
          )}
        </Panel>

        {/* ---- KPIs ---------------------------------------------------- */}
        <PanelGrid columns={4}>
          <StatPanel label="Spend" value={kpi("spend")} hint={account?.currency ?? undefined} loading={metricsLoading} />
          <StatPanel label="Impressions" value={kpi("impressions")} loading={metricsLoading} />
          <StatPanel label="Clicks" value={kpi("clicks")} hint={`CTR ${kpi("ctr")}`} loading={metricsLoading} />
          <StatPanel label="ROAS" value={kpi("roas")} hint={`CPA ${kpi("cpa")}`} loading={metricsLoading} />
        </PanelGrid>

        {/* ---- Performance -------------------------------------------- */}
        <ChartPanel
          title="Performance over time"
          description="One point per day."
          metric={seriesMetric}
          metrics={METRIC_SPECS}
          onMetricChange={setSeriesMetric}
          loading={metricsLoading}
          error={metricsError}
          onRetry={() => void loadMetrics()}
          isEmpty={series.length === 0}
          emptyTitle="No performance data in this window"
          emptyMessage="Meta returned no rows for these dates. Nothing has been substituted."
          currency={account?.currency ?? undefined}
          tableRows={series.map((p) => ({ label: formatDay(p.date), value: p[seriesMetric] }))}
        >
          <TimeSeriesChart series={series} metric={seriesMetric} currency={account?.currency ?? undefined} />
        </ChartPanel>

        <ChartPanel
          title="Campaign comparison"
          description="Largest first, same window."
          metric={compareMetric}
          metrics={METRIC_SPECS}
          onMetricChange={setCompareMetric}
          loading={metricsLoading}
          error={metricsError}
          onRetry={() => void loadMetrics()}
          isEmpty={campaigns.length === 0}
          emptyTitle="No campaigns to compare"
          emptyMessage="Meta returned no campaign rows for these dates."
          currency={account?.currency ?? undefined}
          tableRows={campaigns.map((c) => ({
            label: c.campaignName ?? c.campaignId ?? "Unnamed",
            value: c[compareMetric],
          }))}
        >
          <ComparisonBars rows={campaigns} metric={compareMetric} currency={account?.currency ?? undefined} />
        </ChartPanel>

        {/* ---- Intelligence ------------------------------------------- */}
        <OpportunityPanel
          items={opportunities}
          loading={oppLoading}
          error={oppError}
          onRetry={() => void loadOpportunities()}
        />

        <Panel title="How changes get made" tone="default">
          <p className="text-sm text-sys-dim">
            This screen only reads. JARVIS never changes a campaign on its own: every proposed
            change goes through the approval queue, where you see the exact parameters before
            anything is sent to Meta.{" "}
            <Link href="/approvals" className="text-sys-cyan hover:underline">
              Open approvals
            </Link>
            .
          </p>
        </Panel>
      </div>
    </PageContainer>
  );
}
