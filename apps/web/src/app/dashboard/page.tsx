"use client";

// ---------------------------------------------------------------------------
// Sprint 4.2 shell / Sprint 4.4 visualisation — Dashboard overview.
//
// Every figure on this page comes from /api/v1/dashboard, which in turn reads
// the existing repositories and the existing read-only Meta tools. Nothing is
// generated, sampled or filled in: when Meta has no rows for a window the KPIs
// read "—" and the charts show their empty state, because that is the truth.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Megaphone } from "lucide-react";
import {
  getDashboardSummary,
  getMetaCampaigns,
  getMetaOverview,
  getMetaTimeseries,
  type CampaignMetrics,
  type DashboardSummary,
  type MetricPoint,
  type MetricTotals,
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

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const [totals, setTotals] = useState<MetricTotals | null>(null);
  const [series, setSeries] = useState<MetricPoint[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignMetrics[]>([]);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaConfigured, setMetaConfigured] = useState(true);

  const [seriesMetric, setSeriesMetric] = useState<MetricKey>("spend");
  const [compareMetric, setCompareMetric] = useState<MetricKey>("spend");

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    const res = await getDashboardSummary();
    if (res.success && res.data) {
      setSummary(res.data);
      setMetaConfigured(res.data.metaConfigured);
    } else {
      setSummaryError(res.error?.message ?? "Could not reach JARVIS.");
    }
    setSummaryLoading(false);
  }, []);

  const loadMeta = useCallback(async () => {
    setMetaLoading(true);
    setMetaError(null);

    const [overview, timeseries, comparison] = await Promise.all([
      getMetaOverview(),
      getMetaTimeseries(),
      getMetaCampaigns(undefined, 10),
    ]);

    // A server with no ad account configured is not an error state — it is a
    // deployment that simply does not have Meta, and says so once.
    if (overview.error?.code === "ACCOUNT_NOT_CONFIGURED") {
      setMetaConfigured(false);
      setMetaLoading(false);
      return;
    }

    if (!overview.success && !timeseries.success && !comparison.success) {
      setMetaError(overview.error?.message ?? "Meta data is unavailable.");
      setMetaLoading(false);
      return;
    }

    setTotals(overview.data?.totals ?? null);
    setSeries(timeseries.data?.series ?? []);
    setCampaigns(comparison.data?.campaigns ?? []);
    setMetaLoading(false);
  }, []);

  useEffect(() => {
    void loadSummary();
    void loadMeta();
  }, [loadSummary, loadMeta]);

  const kpi = (key: MetricKey) =>
    totals ? formatMetric(totals[key], METRIC_BY_KEY[key].kind) : "—";

  return (
    <PageContainer>
      <PageHeader
        title="Dashboard"
        description="Where JARVIS is waiting on you, and how the account has been performing."
      />

      <div className="space-y-6">
        {/* ---- Queue counts ------------------------------------------- */}
        {summaryError ? (
          <ErrorState
            title="Overview unavailable"
            message={summaryError}
            onRetry={() => void loadSummary()}
            retryLabel="Reload"
          />
        ) : (
          <PanelGrid columns={4}>
            <StatPanel
              label="Pending approvals"
              value={summary?.pendingApprovals ?? 0}
              hint="Waiting on your decision"
              tone={summary && summary.pendingApprovals > 0 ? "accent" : "default"}
              loading={summaryLoading}
            />
            <StatPanel
              label="Open opportunities"
              value={summary?.openOpportunities ?? 0}
              hint="Ranked for review"
              loading={summaryLoading}
            />
            <StatPanel
              label="Documents"
              value={summary?.knowledgeDocuments ?? 0}
              hint={
                summary
                  ? `${summary.knowledgeProcessed} searchable`
                  : "In your knowledge base"
              }
              loading={summaryLoading}
            />
            <StatPanel
              label="Conversations"
              value={summary?.conversations ?? 0}
              hint="Across all agents"
              loading={summaryLoading}
            />
          </PanelGrid>
        )}

        {/* ---- Meta performance --------------------------------------- */}
        {!metaConfigured ? (
          <Panel title="Performance">
            <EmptyState
              title="No ad account connected"
              message="This deployment has no Meta ad account configured, so there is no performance data to show."
            />
          </Panel>
        ) : (
          <>
            <PanelGrid columns={4}>
              <StatPanel label="Spend" value={kpi("spend")} hint="Selected window" loading={metaLoading} />
              <StatPanel label="Impressions" value={kpi("impressions")} hint="Selected window" loading={metaLoading} />
              <StatPanel label="Clicks" value={kpi("clicks")} hint="Selected window" loading={metaLoading} />
              <StatPanel label="ROAS" value={kpi("roas")} hint="Revenue ÷ spend" loading={metaLoading} />
            </PanelGrid>

            <ChartPanel
              title="Performance over time"
              description="Last 30 days, one day per point."
              metric={seriesMetric}
              metrics={METRIC_SPECS}
              onMetricChange={setSeriesMetric}
              loading={metaLoading}
              error={metaError}
              onRetry={() => void loadMeta()}
              isEmpty={series.length === 0}
              emptyTitle="No performance data in this window"
              emptyMessage="Meta returned no rows for these dates. Nothing has been substituted."
              tableRows={series.map((p) => ({ label: formatDay(p.date), value: p[seriesMetric] }))}
            >
              <TimeSeriesChart series={series} metric={seriesMetric} />
            </ChartPanel>

            <ChartPanel
              title="Campaign comparison"
              description="Largest first, same window."
              metric={compareMetric}
              metrics={METRIC_SPECS}
              onMetricChange={setCompareMetric}
              loading={metaLoading}
              error={metaError}
              onRetry={() => void loadMeta()}
              isEmpty={campaigns.length === 0}
              emptyTitle="No campaigns to compare"
              emptyMessage="Meta returned no campaign rows for these dates."
              tableRows={campaigns.map((c) => ({
                label: c.campaignName ?? c.campaignId ?? "Unnamed",
                value: c[compareMetric],
              }))}
            >
              <ComparisonBars rows={campaigns} metric={compareMetric} />
            </ChartPanel>
          </>
        )}

        {/* ---- What the shell is ready for ---------------------------- */}
        <PanelGrid columns={2}>
          <Panel title="Activity" description="Recent agent work will appear here.">
            <EmptyState
              title="Nothing to show yet"
              message="Once JARVIS runs tools or proposes changes, the trail shows up here."
              action={
                <Link
                  href="/chat"
                  className="sys-focus inline-flex items-center rounded border border-sys-cyan/40 bg-sys-cyan/[0.08] px-3 py-1.5 font-mono text-[0.58rem] uppercase tracking-hud text-sys-cyan-soft transition-colors hover:border-sys-cyan/80"
                >
                  Open assistant
                </Link>
              }
            />
          </Panel>

          <Panel title="Coming next" description="Panels this shell is built to host.">
            <ul className="space-y-3">
              <li className="flex items-start gap-3">
                <BookOpen size={15} className="mt-0.5 shrink-0 text-sys-dim" aria-hidden="true" />
                <div>
                  <p className="text-sm text-sys-text/90">Knowledge Base</p>
                  <p className="text-xs text-sys-dim">
                    Upload, search and inspect your documents.
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Megaphone size={15} className="mt-0.5 shrink-0 text-sys-dim" aria-hidden="true" />
                <div>
                  <p className="text-sm text-sys-text/90">Meta Ads</p>
                  <p className="text-xs text-sys-dim">
                    Anomalies, diagnosis and recommendations in one place.
                  </p>
                </div>
              </li>
            </ul>
          </Panel>
        </PanelGrid>
      </div>
    </PageContainer>
  );
}
