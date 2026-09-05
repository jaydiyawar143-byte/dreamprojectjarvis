// ---------------------------------------------------------------------------
// Sprint 4.4 — Dashboard visualisation.
//
// The charts are hand-built SVG, so these tests read the geometry directly:
// how many marks were drawn, whether a gap broke the line, whether the axis
// ticks name values the plot reaches. That is only possible because there is no
// chart library in the way, and it is the main reason there isn't one.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { TimeSeriesChart } from "../src/components/dashboard/charts/time-series-chart";
import { ComparisonBars } from "../src/components/dashboard/charts/comparison-bars";
import { ChartPanel } from "../src/components/dashboard/charts/chart-panel";
import {
  CHART,
  METRIC_SPECS,
  formatMetric,
  formatDay,
  niceTicks,
} from "../src/components/dashboard/charts/chart-tokens";
import type { CampaignMetrics, MetricPoint } from "../src/lib/api";

const NULLS = {
  spend: null, impressions: null, clicks: null, reach: null, conversions: null,
  revenue: null, ctr: null, cpc: null, cpm: null, cpa: null, roas: null,
};

const pt = (date: string, spend: number | null, clicks: number | null = null): MetricPoint => ({
  ...NULLS,
  date,
  spend,
  clicks,
});

const camp = (id: string, name: string | null, spend: number | null): CampaignMetrics => ({
  ...NULLS,
  date: null,
  campaignId: id,
  campaignName: name,
  spend,
});

const SERIES = [pt("2026-08-01", 10), pt("2026-08-02", 30), pt("2026-08-03", 20)];

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Formatting — the "no fabricated data" rule lives here
// ---------------------------------------------------------------------------

describe("metric formatting", () => {
  it("writes an em dash for a missing value, never a zero", () => {
    expect(formatMetric(null, "currency")).toBe("—");
    expect(formatMetric(undefined, "count")).toBe("—");
    expect(formatMetric(Number.NaN, "ratio")).toBe("—");
    expect(formatMetric(Infinity, "count")).toBe("—");
  });

  it("keeps a real zero as a zero", () => {
    expect(formatMetric(0, "count")).toBe("0");
    expect(formatMetric(0, "currency")).toBe("0.00");
  });

  it("writes each metric kind in its own units", () => {
    expect(formatMetric(1500, "count")).toBe("1.5k");
    expect(formatMetric(2_400_000, "count")).toBe("2.4M");
    expect(formatMetric(12.5, "percent")).toBe("12.50%");
    expect(formatMetric(3.2, "ratio")).toBe("3.20×");
  });

  it("produces axis ticks that reach the maximum", () => {
    const ticks = niceTicks(37);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(37);
  });

  it("survives a degenerate maximum", () => {
    expect(niceTicks(0).length).toBeGreaterThan(0);
    expect(niceTicks(Number.NaN).length).toBeGreaterThan(0);
  });

  it("writes a short human day label", () => {
    expect(formatDay("2026-08-01")).toBe("1 Aug");
  });
});

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

describe("TimeSeriesChart", () => {
  it("draws a labelled plot from real points", () => {
    const { container } = render(<TimeSeriesChart series={SERIES} metric="spend" />);

    const svg = container.querySelector("svg")!;
    expect(svg).toBeInTheDocument();
    expect(svg.getAttribute("role")).toBe("img");
    // The accessible name states what is plotted and over which dates.
    expect(container.querySelector("title")!.textContent).toContain("Spend per day");
    expect(container.querySelector("title")!.textContent).toContain("2026-08-01");

    // One path for the line and one for the area wash, since there are no gaps.
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBe(2);
  });

  it("scales to its container rather than a fixed pixel size", () => {
    const { container } = render(<TimeSeriesChart series={SERIES} metric="spend" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBeTruthy();
    expect(svg.getAttribute("width")).toBeNull();
    expect(svg.classList.contains("w-full")).toBe(true);
  });

  it("breaks the line across a gap instead of inventing a value", () => {
    const withGap = [pt("2026-08-01", 10), pt("2026-08-02", null), pt("2026-08-03", 20)];
    const { container } = render(<TimeSeriesChart series={withGap} metric="spend" />);

    // Two runs, each contributing a line; a run of one has no area path.
    const lines = [...container.querySelectorAll("path")].filter(
      (p) => p.getAttribute("fill") === "none"
    );
    expect(lines.length).toBe(2);

    // And the two single-point runs are drawn as dots so they stay visible.
    const dots = [...container.querySelectorAll("circle")];
    expect(dots.length).toBeGreaterThanOrEqual(2);
  });

  it("uses the validated series colour, not the UI accent, for the line", () => {
    const { container } = render(<TimeSeriesChart series={SERIES} metric="spend" />);
    const line = [...container.querySelectorAll("path")].find(
      (p) => p.getAttribute("fill") === "none"
    )!;
    expect(line.getAttribute("stroke")).toBe(CHART.series);
    expect(line.getAttribute("stroke-width")).toBe("2");
  });

  it("reveals a day's figures on hover and announces them", () => {
    render(<TimeSeriesChart series={SERIES} metric="spend" />);

    expect(screen.getByTestId("ts-tooltip").textContent).toContain("Hover the chart");

    fireEvent.mouseEnter(screen.getByTestId("ts-hit-1"));
    const tip = screen.getByTestId("ts-tooltip");
    expect(tip.getAttribute("aria-live")).toBe("polite");
    expect(tip.textContent).toContain("2 Aug");
    expect(tip.textContent).toContain("30.00");
  });

  it("plots whichever metric it is given", () => {
    const { container } = render(
      <TimeSeriesChart series={[pt("2026-08-01", 10, 4), pt("2026-08-02", 20, 8)]} metric="clicks" />
    );
    expect(container.querySelector("title")!.textContent).toContain("Clicks per day");
  });

  it("renders nothing at all for an empty series, leaving the empty state to the panel", () => {
    const { container } = render(<TimeSeriesChart series={[]} metric="spend" />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("handles a single point without collapsing", () => {
    const { container } = render(<TimeSeriesChart series={[pt("2026-08-01", 10)]} metric="spend" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelectorAll("circle").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

describe("ComparisonBars", () => {
  const ROWS = [camp("1", "Summer Launch", 900), camp("2", "Winter", 300), camp("3", "Spring", 150)];

  it("draws one direct-labelled row per campaign, largest first", () => {
    render(<ComparisonBars rows={ROWS} metric="spend" />);
    const rows = screen.getAllByTestId("comparison-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("Summer Launch")).toBeInTheDocument();
    // The value is written beside the bar, so the bar never has to be measured.
    expect(within(rows[0]!).getByText("900.00")).toBeInTheDocument();
  });

  it("re-sorts when the metric changes, so the ranking always matches the bars", () => {
    const rows = [camp("1", "A", 100), camp("2", "B", 900)];
    const { rerender } = render(<ComparisonBars rows={rows} metric="spend" />);
    expect(screen.getAllByTestId("comparison-row")[0]!.textContent).toContain("B");

    rerender(<ComparisonBars rows={[camp("1", "A", 100), camp("2", "B", 900)]} metric="clicks" />);
    // No clicks anywhere, so nothing is plottable and the chart yields.
    expect(screen.queryAllByTestId("comparison-row")).toHaveLength(0);
  });

  it("drops rows whose value is missing rather than plotting them as zero", () => {
    render(<ComparisonBars rows={[camp("1", "Has", 50), camp("2", "Missing", null)]} metric="spend" />);
    const rows = screen.getAllByTestId("comparison-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Has");
  });

  it("caps how many rows it draws", () => {
    const many = Array.from({ length: 20 }, (_, i) => camp(String(i), `C${i}`, 100 - i));
    render(<ComparisonBars rows={many} metric="spend" maxRows={5} />);
    expect(screen.getAllByTestId("comparison-row")).toHaveLength(5);
  });

  it("falls back to the campaign id when Meta gave no name", () => {
    render(<ComparisonBars rows={[camp("cid-9", null, 10)]} metric="spend" />);
    expect(screen.getByText("cid-9")).toBeInTheDocument();
  });

  it("renders nothing when no row has a value", () => {
    const { container } = render(<ComparisonBars rows={[camp("1", "A", null)]} metric="spend" />);
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Chart panel: states, metric selection, table view
// ---------------------------------------------------------------------------

describe("ChartPanel", () => {
  const base = {
    title: "Performance over time",
    metric: "spend" as const,
    metrics: METRIC_SPECS,
    onMetricChange: vi.fn(),
    loading: false,
    error: null,
    isEmpty: false,
    emptyTitle: "No data",
    emptyMessage: "Meta returned no rows.",
    tableRows: [{ label: "1 Aug", value: 10 }],
  };

  it("shows the chart when there is data", () => {
    render(
      <ChartPanel {...base}>
        <p data-testid="the-chart">chart</p>
      </ChartPanel>
    );
    expect(screen.getByTestId("the-chart")).toBeInTheDocument();
    expect(screen.queryByTestId("loading-state")).toBeNull();
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("shows the loading state instead of a half-drawn chart", () => {
    render(
      <ChartPanel {...base} loading>
        <p data-testid="the-chart">chart</p>
      </ChartPanel>
    );
    expect(screen.getByTestId("loading-state")).toBeInTheDocument();
    expect(screen.queryByTestId("the-chart")).toBeNull();
  });

  it("shows a retryable error state on API failure", () => {
    const onRetry = vi.fn();
    render(
      <ChartPanel {...base} error="Meta rate limit reached" onRetry={onRetry}>
        <p data-testid="the-chart">chart</p>
      </ChartPanel>
    );
    expect(screen.getByTestId("error-state")).toBeInTheDocument();
    expect(screen.getByTestId("error-message").textContent).toBe("Meta rate limit reached");
    fireEvent.click(screen.getByTestId("error-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("the-chart")).toBeNull();
  });

  it("explains an empty window without substituting anything", () => {
    render(
      <ChartPanel {...base} isEmpty>
        <p data-testid="the-chart">chart</p>
      </ChartPanel>
    );
    const empty = screen.getByTestId("empty-state");
    expect(within(empty).getByText("No data")).toBeInTheDocument();
    expect(screen.queryByTestId("the-chart")).toBeNull();
  });

  it("offers a metric selector rather than a second y-axis", () => {
    const onMetricChange = vi.fn();
    render(
      <ChartPanel {...base} onMetricChange={onMetricChange}>
        <p>chart</p>
      </ChartPanel>
    );
    const select = screen.getByTestId("metric-select");
    fireEvent.change(select, { target: { value: "roas" } });
    expect(onMetricChange).toHaveBeenCalledWith("roas");
  });

  it("offers the same figures as a table, so the chart is not the only way in", () => {
    render(
      <ChartPanel {...base}>
        <p data-testid="the-chart">chart</p>
      </ChartPanel>
    );

    expect(screen.queryByTestId("chart-table")).toBeNull();
    fireEvent.click(screen.getByTestId("toggle-table"));

    const table = screen.getByTestId("chart-table");
    expect(within(table).getByText("1 Aug")).toBeInTheDocument();
    expect(within(table).getByText("10.00")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-table").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("the-chart")).toBeNull();
  });

  it("writes a missing table value as an em dash", () => {
    render(
      <ChartPanel {...base} tableRows={[{ label: "2 Aug", value: null }]}>
        <p>chart</p>
      </ChartPanel>
    );
    fireEvent.click(screen.getByTestId("toggle-table"));
    expect(within(screen.getByTestId("chart-table")).getByText("—")).toBeInTheDocument();
  });
});
