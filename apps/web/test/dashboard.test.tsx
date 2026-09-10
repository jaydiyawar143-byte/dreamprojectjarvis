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
    // UI V2 — the command centre reads pending approvals directly.
    listApprovals: vi.fn(),
    approveApproval: vi.fn(),
    rejectApproval: vi.fn(),
    // V3 — the dashboard now renders the live widget grid, so every provider
    // the grid touches must be stubbed here or a widget throws and takes the
    // whole tree (including the approval panel) down with it.
    getCapabilities: vi.fn(),
    getPreferences: vi.fn(),
    savePreferences: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    getWeather: vi.fn(),
    getCrypto: vi.fn(),
    getIndices: vi.fn(),
    getRoute: vi.fn(),
    searchPlaces: vi.fn(),
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

/**
 * A resolved, authenticated session for components that read useAuth().
 *
 * UI V2 — the session is an HttpOnly refresh cookie, not stored tokens, so it
 * is seeded by making the refresh exchange succeed. Nothing goes into web
 * storage because the app no longer puts anything there.
 */
function seedSession() {
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/auth/refresh")
      ? { accessToken: "token-abc", expiresIn: 900 }
      : { id: "u1", email: "op@jarvis.local", name: "Operator", role: "member", createdAt: ts(), updatedAt: ts() };
    return Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ success: true, data: body, timestamp: ts() }),
    } as Response);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  routerReplace.mockClear();
  pathname = "/dashboard";
  sessionStorage.clear();
  seedHappyApi();
  seedSession();
  mockedApi.listApprovals.mockResolvedValue({
    success: true,
    data: [],
    pagination: { page: 1, limit: 3, total: 0, totalPages: 1 },
    timestamp: ts(),
  } as never);

  // V3 widget grid defaults: everything resolves to an empty-but-valid state so
  // these tests stay about the dashboard, not about the widgets.
  const unavailable = {
    freshness: "UNAVAILABLE" as const,
    observedAt: ts(),
    ageSeconds: 0,
    source: "Test",
    reason: "Not configured in this test",
  };
  mockedApi.getCapabilities.mockResolvedValue({
    success: true,
    data: { weather: true, crypto: true, indices: false, geo: true, system: true, tasks: true },
    timestamp: ts(),
  } as never);
  mockedApi.getPreferences.mockResolvedValue({
    success: true, data: { preferences: {} }, timestamp: ts(),
  } as never);
  mockedApi.savePreferences.mockResolvedValue({
    success: true, data: { preferences: {} }, timestamp: ts(),
  } as never);
  mockedApi.listTasks.mockResolvedValue({ success: true, data: { tasks: [] }, timestamp: ts() } as never);
  mockedApi.getWeather.mockResolvedValue({ success: true, data: { value: null, meta: unavailable }, timestamp: ts() } as never);
  mockedApi.getCrypto.mockResolvedValue({ success: true, data: { value: [], meta: unavailable }, timestamp: ts() } as never);
  mockedApi.getIndices.mockResolvedValue({ success: true, data: { value: null, meta: unavailable }, timestamp: ts() } as never);
});

// ---------------------------------------------------------------------------
// Route rendering — the dashboard IS the command centre
//
// The queue counts, Meta KPIs and charts that used to be asserted here moved to
// the pages that own them. Their behaviour is still covered, in meta-panel
// tests: "renders KPI cards from real totals", "writes an em dash for a metric
// Meta did not report", "says the deployment has no account rather than showing
// zeros", "offers a retry when the metric endpoints all fail". Nothing was
// dropped — the duplicates were.
// ---------------------------------------------------------------------------

describe("dashboard route", () => {
  it("is the command centre and nothing else", async () => {
    render(<DashboardPage />);

    expect(screen.getByTestId("command-center")).toBeInTheDocument();
    expect(screen.getByTestId("command-input")).toBeInTheDocument();
    // V4 — the greeting headline is gone. The Orb is a widget the user can drag
    // and resize now, so a line of copy sized to it would be sized to nothing
    // the moment they shrank it; the status readout under the Orb says what the
    // system is doing, and the command bar below says what to do about it.
    expect(screen.getByTestId("command-readout")).toBeInTheDocument();
    expect(screen.getByTestId("command-bar")).toBeInTheDocument();

    // The BI surface must NOT be here. This is the assertion that keeps the
    // dashboard from silently growing back into a card wall.
    expect(screen.queryAllByTestId("stat-value")).toHaveLength(0);
    expect(screen.queryByTestId("metric-select")).toBeNull();
    expect(screen.queryByText("Pending approvals")).toBeNull();
  });

  it("reports readiness rather than inventing activity", async () => {
    render(<DashboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId("command-readout").textContent).toContain(
        "Ask a question"
      )
    );
  });

  it("fetches its own pending approvals rather than guessing from the chat", async () => {
    // An approval can be raised by a background worker or in another tab, so
    // the panel is driven by the approvals endpoint, not by conversation state.
    render(<DashboardPage />);
    await waitFor(() => expect(mockedApi.listApprovals).toHaveBeenCalled());
    expect(mockedApi.listApprovals).toHaveBeenCalledWith("pending", 1, 3);
  });

  it("shows no approval panel when nothing is waiting", async () => {
    render(<DashboardPage />);
    await waitFor(() => expect(mockedApi.listApprovals).toHaveBeenCalled());
    expect(screen.queryByTestId("command-approvals")).toBeNull();
  });

  it("surfaces a waiting approval, and says voice cannot decide it", async () => {
    mockedApi.listApprovals.mockResolvedValue({
      success: true,
      data: [
        {
          approvalId: "ap-1",
          toolId: "meta.campaign.budget",
          status: "pending",
          createdAt: ts(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          params: {},
          actionSummary: "Increase campaign budget",
          detailLines: [],
          risk: "FINANCIAL",
        },
      ],
      pagination: { page: 1, limit: 3, total: 1, totalPages: 1 },
      timestamp: ts(),
    } as never);

    render(<DashboardPage />);

    await waitFor(() =>
      expect(screen.getByTestId("command-approvals")).toBeInTheDocument()
    );
    expect(screen.getByText("Action requires approval")).toBeInTheDocument();
    expect(screen.getByText(/Voice can never approve an action/i)).toBeInTheDocument();

    // The Orb must report the blocked state rather than "ready".
    await waitFor(() =>
      expect(screen.getByTestId("command-readout").textContent).toContain(
        "waiting for your decision"
      )
    );
  });

  it("keeps a stale approval on screen when the refresh fails", async () => {
    // Blanking the panel on a transient network error would hide a decision
    // that is still genuinely waiting.
    mockedApi.listApprovals.mockResolvedValueOnce({
      success: true,
      data: [
        {
          approvalId: "ap-2",
          toolId: "meta.campaign.pause",
          status: "pending",
          createdAt: ts(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          params: {},
          actionSummary: "Pause campaign",
          detailLines: [],
        },
      ],
      pagination: { page: 1, limit: 3, total: 1, totalPages: 1 },
      timestamp: ts(),
    } as never);
    mockedApi.listApprovals.mockResolvedValue({
      success: false,
      error: { code: "NETWORK_ERROR", message: "Network request failed" },
      timestamp: ts(),
    } as never);

    render(<DashboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId("command-approvals")).toBeInTheDocument()
    );
    expect(screen.getByTestId("command-approvals")).toBeInTheDocument();
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
    // UI V2 regrouped these around what JARVIS actually does: what you drive
    // (Command), what it knows (Intelligence), what it can do (Capabilities),
    // what needs a human (Control), and the machine itself (System). The
    // guarantee is unchanged — groups are named by what the destinations are
    // FOR, and each holds only items that belong to it.
    expect(NAV_GROUPS.map((g) => g.title)).toEqual([
      "Command",
      "Intelligence",
      "Capabilities",
      "Control",
      "System",
    ]);

    const command = NAV_GROUPS.find((g) => g.title === "Command")!;
    expect(command.items.map((i) => i.label)).toEqual(["Dashboard", "Assistant"]);

    const intelligence = NAV_GROUPS.find((g) => g.title === "Intelligence")!;
    expect(intelligence.items.map((i) => i.label)).toEqual([
      "Opportunities",
      "Knowledge Base",
      "Meta Ads",
    ]);

    const capabilities = NAV_GROUPS.find((g) => g.title === "Capabilities")!;
    expect(capabilities.items.map((i) => i.label)).toEqual([
      "Agents",
      "Automations",
      "Integrations",
      "Browser",
    ]);

    // Approvals and Activity are the two places a human is in the loop, so
    // they are grouped together rather than filed under "System".
    const control = NAV_GROUPS.find((g) => g.title === "Control")!;
    expect(control.items.map((i) => i.label)).toEqual(["Approvals", "Activity"]);

    const system = NAV_GROUPS.find((g) => g.title === "System")!;
    expect(system.items.map((i) => i.label)).toEqual(["Health", "Settings"]);

    // Browser is now present because /browser now EXISTS. The rule is unchanged
    // — the nav links only to pages that exist — so this asserts the page is
    // really behind it rather than that the label is merely absent.
    const browser = NAV_ITEMS.find((i) => i.href === "/browser");
    expect(browser?.available).toBe(true);
  });

  it("every UI V2 destination has a page behind it", () => {
    // A nav entry pointing at a route with no page is a dead link the sidebar
    // still advertises. This is the check that would have caught the five
    // layout-without-page folders created mid-implementation.
    const uiV2 = ["/agents", "/automations", "/integrations", "/activity", "/system", "/settings"];
    for (const href of uiV2) {
      const item = NAV_ITEMS.find((i) => i.href === href);
      expect(item, `nav entry for ${href}`).toBeDefined();
      expect(item!.available, href).toBe(true);
    }
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
