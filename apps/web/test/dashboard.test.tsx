// ---------------------------------------------------------------------------
// Sprint 4.2 — Dashboard foundation.
//
// Covers the four things the shell must get right: the route renders, it is
// reachable only with a resolved session, the persistent navigation behaves at
// both breakpoints, and every reusable state renders what it promises.
//
// lib/api is mocked throughout — no network, and the page's data shape is
// controlled so loading, populated and failed all get exercised.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

const routerReplace = vi.fn();
let pathname = "/dashboard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, prefetch: vi.fn() }),
  usePathname: () => pathname,
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    getDashboardSummary: vi.fn(),
    getMetaOverview: vi.fn(),
    getMetaTimeseries: vi.fn(),
    getMetaCampaigns: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import { DashboardShell } from "../src/components/dashboard/dashboard-shell";
import { DashboardSidebar } from "../src/components/dashboard/dashboard-sidebar";
import { Panel, StatPanel } from "../src/components/dashboard/panel";
import { PageContainer, PageHeader, PanelGrid } from "../src/components/dashboard/page-container";
import { EmptyState, ErrorState, LoadingState, Skeleton } from "../src/components/dashboard/states";
import { NAV_ITEMS, NAV_GROUPS, activeNavHref } from "../src/components/dashboard/nav";
import { RequireAuth } from "../src/components/require-auth";
import DashboardPage from "../src/app/dashboard/page";
import DashboardLayout from "../src/app/dashboard/layout";
import { AuthProvider } from "../src/lib/auth";

const mockedApi = vi.mocked(api);

const ts = () => new Date().toISOString();

const NULL_TOTALS = {
  spend: null, impressions: null, clicks: null, reach: null, conversions: null,
  revenue: null, ctr: null, cpc: null, cpm: null, cpa: null, roas: null,
};

const point = (date: string, spend: number, clicks: number) => ({
  ...NULL_TOTALS, date, spend, clicks, impressions: spend * 100,
});

function seedHappyApi() {
  mockedApi.getDashboardSummary.mockResolvedValue({
    success: true,
    data: {
      pendingApprovals: 4,
      conversations: 2,
      knowledgeDocuments: 6,
      knowledgeProcessed: 5,
      openOpportunities: 7,
      metaConfigured: true,
    },
    timestamp: ts(),
  });
  mockedApi.getMetaOverview.mockResolvedValue({
    success: true,
    data: {
      accountId: "act_1",
      dateRange: { start: "2026-08-06", end: "2026-09-04" },
      totals: { ...NULL_TOTALS, spend: 1234, impressions: 98000, clicks: 4300, roas: 2.5 },
      rowCount: 1,
    },
    timestamp: ts(),
  });
  mockedApi.getMetaTimeseries.mockResolvedValue({
    success: true,
    data: {
      accountId: "act_1",
      dateRange: { start: "2026-08-06", end: "2026-09-04" },
      series: [point("2026-08-06", 10, 5), point("2026-08-07", 20, 9), point("2026-08-08", 15, 7)],
      pointCount: 3,
    },
    timestamp: ts(),
  });
  mockedApi.getMetaCampaigns.mockResolvedValue({
    success: true,
    data: {
      accountId: "act_1",
      dateRange: { start: "2026-08-06", end: "2026-09-04" },
      campaigns: [
        { ...NULL_TOTALS, date: null, campaignId: "1", campaignName: "Summer", spend: 900, clicks: 40 },
        { ...NULL_TOTALS, date: null, campaignId: "2", campaignName: "Winter", spend: 300, clicks: 12 },
      ],
      campaignCount: 2,
    },
    timestamp: ts(),
  });
}

/** A resolved, authenticated session for components that read useAuth(). */
function seedSession() {
  sessionStorage.setItem("jarvis_access", "token-abc");
  sessionStorage.setItem("jarvis_refresh", "token-ref");
  global.fetch = vi.fn(() =>
    Promise.resolve({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { id: "u1", email: "op@jarvis.local", name: "Operator", role: "member", createdAt: ts(), updatedAt: ts() },
          timestamp: ts(),
        }),
    } as Response)
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  routerReplace.mockClear();
  pathname = "/dashboard";
  sessionStorage.clear();
  seedHappyApi();
  seedSession();
});

// ---------------------------------------------------------------------------
// Route rendering
// ---------------------------------------------------------------------------

describe("dashboard route", () => {
  it("renders the queue counts and the Meta KPIs from the API", async () => {
    render(<DashboardPage />);

    expect(screen.getByTestId("page-title").textContent).toBe("Dashboard");
    expect(screen.getByTestId("page-container")).toBeInTheDocument();

    await waitFor(() => {
      const values = screen.getAllByTestId("stat-value").map((n) => n.textContent);
      // Four queue counts, then four Meta KPIs.
      expect(values.slice(0, 4)).toEqual(["4", "7", "6", "2"]);
      expect(values.slice(4)).toEqual(["1.2k", "98.0k", "4.3k", "2.50×"]);
    });
  });

  it("shows loading placeholders before the data arrives", async () => {
    let release: (v: unknown) => void = () => {};
    mockedApi.getDashboardSummary.mockReturnValue(new Promise((r) => { release = r; }) as never);

    render(<DashboardPage />);
    expect(screen.getAllByTestId("stat-loading").length).toBeGreaterThan(0);

    release({ success: true, data: { pendingApprovals: 0, conversations: 0, knowledgeDocuments: 0, knowledgeProcessed: 0, openOpportunities: 0, metaConfigured: true }, timestamp: ts() });
    await waitFor(() => expect(screen.queryByTestId("stat-loading")).toBeNull());
  });

  it("surfaces a retryable error when the summary fails", async () => {
    mockedApi.getDashboardSummary.mockResolvedValue({
      success: false,
      error: { code: "NETWORK_ERROR", message: "Network request failed" },
      timestamp: ts(),
    } as never);

    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByTestId("error-state")).toBeInTheDocument());
    expect(screen.getByTestId("error-message").textContent).toBe("Network request failed");

    seedHappyApi();
    fireEvent.click(screen.getByTestId("error-retry"));
    await waitFor(() => expect(screen.queryByTestId("error-state")).toBeNull());
  });

  it("writes an em dash, never a zero, when Meta reports no figures", async () => {
    mockedApi.getMetaOverview.mockResolvedValue({
      success: true,
      data: { accountId: "act_1", dateRange: { start: "a", end: "b" }, totals: NULL_TOTALS, rowCount: 0 },
      timestamp: ts(),
    } as never);
    mockedApi.getMetaTimeseries.mockResolvedValue({
      success: true,
      data: { accountId: "act_1", dateRange: { start: "a", end: "b" }, series: [], pointCount: 0 },
      timestamp: ts(),
    } as never);

    render(<DashboardPage />);

    await waitFor(() => {
      const values = screen.getAllByTestId("stat-value").map((n) => n.textContent);
      expect(values.slice(4)).toEqual(["—", "—", "—", "—"]);
    });
    expect(screen.queryByText("0")).toBeNull();
  });

  it("says the account is not connected rather than showing empty charts", async () => {
    mockedApi.getDashboardSummary.mockResolvedValue({
      success: true,
      data: { pendingApprovals: 0, conversations: 0, knowledgeDocuments: 0, knowledgeProcessed: 0, openOpportunities: 0, metaConfigured: false },
      timestamp: ts(),
    } as never);
    mockedApi.getMetaOverview.mockResolvedValue({
      success: false,
      error: { code: "ACCOUNT_NOT_CONFIGURED", message: "Ad account not configured on this server" },
      timestamp: ts(),
    } as never);

    render(<DashboardPage />);

    await waitFor(() =>
      expect(screen.getByText("No ad account connected")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("metric-select")).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Authenticated access
// ---------------------------------------------------------------------------

describe("authenticated access", () => {
  it("mounts the shell and page once the session resolves", async () => {
    render(
      <AuthProvider>
        <DashboardLayout>
          <p data-testid="dash-child">child</p>
        </DashboardLayout>
      </AuthProvider>
    );

    expect(screen.queryByTestId("dashboard-shell")).toBeNull();
    expect(screen.getByTestId("session-pending")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("dashboard-shell")).toBeInTheDocument());
    expect(screen.getByTestId("dash-child")).toBeInTheDocument();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("never mounts the shell without a session, and redirects", async () => {
    sessionStorage.clear();
    global.fetch = vi.fn(() =>
      Promise.resolve({
        status: 401,
        ok: false,
        json: () => Promise.resolve({ success: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" }, timestamp: ts() }),
      } as Response)
    ) as unknown as typeof fetch;

    render(
      <AuthProvider>
        <DashboardLayout>
          <p data-testid="dash-child">child</p>
        </DashboardLayout>
      </AuthProvider>
    );

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByTestId("dashboard-shell")).toBeNull();
    expect(screen.queryByTestId("dash-child")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Navigation and layout
// ---------------------------------------------------------------------------

describe("navigation model", () => {
  it("marks the longest matching route active, so nested paths light the parent", () => {
    expect(activeNavHref("/dashboard")).toBe("/dashboard");
    expect(activeNavHref("/opportunities")).toBe("/opportunities");
    expect(activeNavHref("/opportunities/opp-123")).toBe("/opportunities");
    expect(activeNavHref("/login")).toBeNull();
    expect(activeNavHref(null)).toBeNull();
  });

  it("resolves every built destination, including the ones added later", () => {
    // Knowledge Base went live in Sprint 4.5, Meta Ads in Sprint 4.6.
    expect(activeNavHref("/knowledge")).toBe("/knowledge");
    expect(activeNavHref("/meta-ads")).toBe("/meta-ads");
  });

  it("never resolves a destination that is not built", () => {
    // Asserted against the model rather than a hard-coded route, so this keeps
    // holding as panels ship. Today every item is built, so the guard is
    // exercised with a synthetic one.
    const unbuilt = NAV_ITEMS.filter((i) => !i.available);
    for (const item of unbuilt) {
      expect(activeNavHref(item.href)).toBeNull();
    }
    expect(activeNavHref("/not-a-route")).toBeNull();
  });

  it("groups destinations by what they are for", () => {
    expect(NAV_GROUPS.map((g) => g.title)).toEqual(["Overview", "Operate", "Intelligence"]);
    // Intelligence is where the Knowledge Base and Meta Ads panels live.
    const intelligence = NAV_GROUPS.find((g) => g.title === "Intelligence")!;
    expect(intelligence.items.map((i) => i.label)).toEqual(["Knowledge Base", "Meta Ads"]);
  });

  it("every destination in the model is reachable", () => {
    // As of Sprint 4.6 every reserved slot has been filled.
    expect(NAV_ITEMS.filter((i) => !i.available)).toEqual([]);
    expect(NAV_ITEMS.every((i) => i.href.startsWith("/"))).toBe(true);
  });
});

describe("dashboard sidebar", () => {
  it("links the built routes and flags the current one", () => {
    render(<AuthProvider><DashboardSidebar /></AuthProvider>);

    const dash = screen.getByTestId("nav-dashboard");
    expect(dash).toHaveAttribute("href", "/dashboard");
    expect(dash).toHaveAttribute("aria-current", "page");

    expect(screen.getByTestId("nav-assistant")).toHaveAttribute("href", "/chat");
    expect(screen.getByTestId("nav-approvals")).not.toHaveAttribute("aria-current");
  });

  it("renders every built panel as a real link", () => {
    render(<AuthProvider><DashboardSidebar /></AuthProvider>);

    expect(screen.getByTestId("nav-knowledge-base")).toHaveAttribute("href", "/knowledge");
    expect(screen.getByTestId("nav-meta-ads")).toHaveAttribute("href", "/meta-ads");
    // Nothing is marked "Soon" any more.
    expect(screen.queryByText("Soon")).toBeNull();
  });

  it("shows the signed-in operator", async () => {
    render(<AuthProvider><DashboardSidebar /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("sidebar-user").textContent).toBe("Operator"));
  });
});

describe("dashboard shell", () => {
  it("renders persistent chrome around its children", () => {
    render(<AuthProvider><DashboardShell><p data-testid="content">page</p></DashboardShell></AuthProvider>);

    expect(screen.getByTestId("dashboard-topbar")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-desktop")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-main")).toBeInTheDocument();
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("names the current section in the top bar", () => {
    pathname = "/approvals";
    render(<AuthProvider><DashboardShell><p>page</p></DashboardShell></AuthProvider>);
    expect(screen.getByTestId("topbar-section").textContent).toBe("Approvals");
  });

  it("keeps the drawer shut until asked, then opens and closes it", () => {
    render(<AuthProvider><DashboardShell><p>page</p></DashboardShell></AuthProvider>);

    expect(screen.queryByTestId("nav-drawer")).toBeNull();

    fireEvent.click(screen.getByTestId("open-nav"));
    expect(screen.getByTestId("nav-drawer")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("close-nav"));
    expect(screen.queryByTestId("nav-drawer")).toBeNull();
  });

  it("closes the drawer on backdrop click and on Escape", () => {
    render(<AuthProvider><DashboardShell><p>page</p></DashboardShell></AuthProvider>);

    fireEvent.click(screen.getByTestId("open-nav"));
    fireEvent.click(screen.getByTestId("nav-backdrop"));
    expect(screen.queryByTestId("nav-drawer")).toBeNull();

    fireEvent.click(screen.getByTestId("open-nav"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("nav-drawer")).toBeNull();
  });

  it("closes the drawer when a destination is chosen", () => {
    render(<AuthProvider><DashboardShell><p>page</p></DashboardShell></AuthProvider>);

    fireEvent.click(screen.getByTestId("open-nav"));
    const drawer = screen.getByTestId("nav-drawer");
    fireEvent.click(within(drawer).getByTestId("nav-approvals"));
    expect(screen.queryByTestId("nav-drawer")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reusable primitives
// ---------------------------------------------------------------------------

describe("layout primitives", () => {
  it("Panel renders a header only when given one", () => {
    const { rerender } = render(<Panel>body</Panel>);
    expect(screen.queryByTestId("panel-title")).toBeNull();

    rerender(<Panel title="Spend" action={<button>act</button>}>body</Panel>);
    expect(screen.getByTestId("panel-title").textContent).toBe("Spend");
    expect(screen.getByRole("button", { name: "act" })).toBeInTheDocument();
  });

  it("Panel carries its semantic tone as data, not just colour", () => {
    render(<Panel tone="danger">body</Panel>);
    expect(screen.getByTestId("panel")).toHaveAttribute("data-tone", "danger");
  });

  it("StatPanel swaps its figure for a placeholder while loading", () => {
    const { rerender } = render(<StatPanel label="Pending" value={12} />);
    expect(screen.getByTestId("stat-value").textContent).toBe("12");

    rerender(<StatPanel label="Pending" value={12} loading />);
    expect(screen.queryByTestId("stat-value")).toBeNull();
    expect(screen.getByTestId("stat-loading")).toBeInTheDocument();
  });

  it("PageHeader and PanelGrid render their content", () => {
    render(
      <PageContainer>
        <PageHeader title="Knowledge" description="Your documents" actions={<button>Upload</button>} />
        <PanelGrid columns={2}>
          <Panel>a</Panel>
          <Panel>b</Panel>
        </PanelGrid>
      </PageContainer>
    );

    expect(screen.getByTestId("page-title").textContent).toBe("Knowledge");
    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
    expect(screen.getAllByTestId("panel")).toHaveLength(2);
  });
});

describe("shared states", () => {
  it("LoadingState announces itself and draws the requested number of bars", () => {
    render(<LoadingState label="Loading documents" lines={4} />);
    const region = screen.getByTestId("loading-state");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveAttribute("role", "status");
    expect(screen.getAllByTestId("skeleton")).toHaveLength(4);
  });

  it("ErrorState is an alert and only offers retry when it can", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState message="Upload failed" />);
    expect(screen.getByTestId("error-state")).toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("error-retry")).toBeNull();

    rerender(<ErrorState message="Upload failed" onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId("error-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("EmptyState explains the absence and can carry an action", () => {
    render(<EmptyState title="No documents" message="Upload one to get started." action={<button>Upload</button>} />);
    const empty = screen.getByTestId("empty-state");
    expect(within(empty).getByText("No documents")).toBeInTheDocument();
    expect(within(empty).getByText("Upload one to get started.")).toBeInTheDocument();
    expect(within(empty).getByRole("button", { name: "Upload" })).toBeInTheDocument();
  });

  it("EmptyState is not an alert — an empty queue is a healthy outcome", () => {
    render(<EmptyState title="All clear" />);
    expect(screen.getByTestId("empty-state")).not.toHaveAttribute("role", "alert");
  });

  it("Skeleton is hidden from assistive technology", () => {
    render(<Skeleton className="h-4 w-10" />);
    expect(screen.getByTestId("skeleton")).toHaveAttribute("aria-hidden", "true");
  });
});
