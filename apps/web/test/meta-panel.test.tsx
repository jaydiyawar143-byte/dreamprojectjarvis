// ---------------------------------------------------------------------------
// Sprint 4.6 — Meta Ads panel.
//
// The load-bearing test in this file is the last describe block: rendering the
// panel, in any state, must never call a write. That is asserted by mocking the
// WHOLE api module and checking that only the read functions were touched —
// so a future edit that wires an execute button into this screen fails here.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";

const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, prefetch: vi.fn() }),
  usePathname: () => "/meta-ads",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    getMetaAccount: vi.fn(),
    getMetaOverview: vi.fn(),
    getMetaTimeseries: vi.fn(),
    getMetaCampaigns: vi.fn(),
    listOpportunities: vi.fn(),
    // Writes — must never be called by this screen.
    approveApproval: vi.fn(),
    rejectApproval: vi.fn(),
    confirmPendingAction: vi.fn(),
    rejectPendingActionApi: vi.fn(),
    modifyPendingAction: vi.fn(),
    uploadKnowledgeDocument: vi.fn(),
    deleteKnowledgeDocument: vi.fn(),
    sendChatMessage: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import MetaAdsPage from "../src/app/meta-ads/page";
import MetaAdsLayout from "../src/app/meta-ads/layout";
import { OpportunityPanel } from "../src/components/dashboard/meta/opportunity-panel";
import { AuthProvider } from "../src/lib/auth";
import { NAV_ITEMS } from "../src/components/dashboard/nav";

const mockedApi = vi.mocked(api);
const ts = () => new Date().toISOString();

const NULLS = {
  spend: null, impressions: null, clicks: null, reach: null, conversions: null,
  revenue: null, ctr: null, cpc: null, cpm: null, cpa: null, roas: null,
};

const ACCOUNT = {
  accountId: "act_2478566669291624",
  name: "Zephyrine Dynamics Ads",
  currency: "INR",
  timezone: "Asia/Kolkata",
  status: "1",
};

function seedSession() {
  sessionStorage.setItem("jarvis_access", "t");
  sessionStorage.setItem("jarvis_refresh", "r");
  global.fetch = vi.fn(() =>
    Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: { id: "u1", email: "a@b.c", name: "Op", role: "member", createdAt: ts(), updatedAt: ts() },
        timestamp: ts(),
      }),
    } as Response)
  ) as unknown as typeof fetch;
}

function seedHappy() {
  mockedApi.getMetaAccount.mockResolvedValue({
    success: true, data: { account: ACCOUNT }, timestamp: ts(),
  } as never);
  mockedApi.getMetaOverview.mockResolvedValue({
    success: true,
    data: {
      accountId: ACCOUNT.accountId,
      dateRange: { start: "2026-08-06", end: "2026-09-04" },
      totals: { ...NULLS, spend: 45200, impressions: 1_200_000, clicks: 18400, ctr: 1.53, roas: 3.1, cpa: 240 },
      rowCount: 30,
    },
    timestamp: ts(),
  } as never);
  mockedApi.getMetaTimeseries.mockResolvedValue({
    success: true,
    data: {
      accountId: ACCOUNT.accountId,
      dateRange: { start: "2026-08-06", end: "2026-09-04" },
      series: [
        { ...NULLS, date: "2026-08-06", spend: 1400 },
        { ...NULLS, date: "2026-08-07", spend: 1600 },
      ],
      pointCount: 2,
    },
    timestamp: ts(),
  } as never);
  mockedApi.getMetaCampaigns.mockResolvedValue({
    success: true,
    data: {
      accountId: ACCOUNT.accountId,
      dateRange: { start: "2026-08-06", end: "2026-09-04" },
      campaigns: [
        { ...NULLS, date: null, campaignId: "1", campaignName: "Prospecting", spend: 30000 },
        { ...NULLS, date: null, campaignId: "2", campaignName: "Retargeting", spend: 15200 },
      ],
      campaignCount: 2,
    },
    timestamp: ts(),
  } as never);
  mockedApi.listOpportunities.mockResolvedValue({
    success: true, items: [], totalEligible: 0, ineligibleCount: 0, timestamp: ts(),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  routerReplace.mockClear();
  sessionStorage.clear();
  seedSession();
  seedHappy();
});

// ---------------------------------------------------------------------------
// Account context
// ---------------------------------------------------------------------------

describe("account context", () => {
  it("names the account, its id, currency and timezone from the server", async () => {
    render(<MetaAdsPage />);

    await waitFor(() => expect(screen.getByTestId("account-context")).toBeInTheDocument());
    const ctx = screen.getByTestId("account-context");
    expect(within(ctx).getByText("Zephyrine Dynamics Ads")).toBeInTheDocument();
    expect(within(ctx).getByText("act_2478566669291624")).toBeInTheDocument();
    expect(within(ctx).getByText("INR")).toBeInTheDocument();
    expect(within(ctx).getByText("Asia/Kolkata")).toBeInTheDocument();
  });

  it("never lets the client choose an account id", async () => {
    render(<MetaAdsPage />);
    await waitFor(() => expect(mockedApi.getMetaAccount).toHaveBeenCalled());
    // The account endpoint takes no arguments at all — the id is server-side.
    expect(mockedApi.getMetaAccount).toHaveBeenCalledWith();
    for (const call of mockedApi.getMetaOverview.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("act_");
    }
  });

  it("states the window the figures cover", async () => {
    render(<MetaAdsPage />);
    await waitFor(() =>
      expect(screen.getByText(/2026-08-06 to 2026-09-04/)).toBeInTheDocument()
    );
  });
});

// ---------------------------------------------------------------------------
// KPIs and charts
// ---------------------------------------------------------------------------

describe("performance", () => {
  it("renders KPI cards from real totals", async () => {
    render(<MetaAdsPage />);
    await waitFor(() => {
      const values = screen.getAllByTestId("stat-value").map((n) => n.textContent);
      expect(values).toEqual(["45k", "1.2M", "18.4k", "3.10×"]);
    });
  });

  it("plots the series it was given", async () => {
    const { container } = render(<MetaAdsPage />);
    await waitFor(() => expect(container.querySelector("svg[role='img']")).toBeInTheDocument());
    expect(container.querySelector("title")!.textContent).toContain("Spend per day");
  });

  it("shows an empty state instead of an empty chart when Meta has no rows", async () => {
    mockedApi.getMetaTimeseries.mockResolvedValue({
      success: true,
      data: { accountId: ACCOUNT.accountId, dateRange: { start: "a", end: "b" }, series: [], pointCount: 0 },
      timestamp: ts(),
    } as never);
    mockedApi.getMetaCampaigns.mockResolvedValue({
      success: true,
      data: { accountId: ACCOUNT.accountId, dateRange: { start: "a", end: "b" }, campaigns: [], campaignCount: 0 },
      timestamp: ts(),
    } as never);

    render(<MetaAdsPage />);
    await waitFor(() =>
      expect(screen.getByText("No performance data in this window")).toBeInTheDocument()
    );
    expect(screen.getByText("No campaigns to compare")).toBeInTheDocument();
  });

  it("writes an em dash for a metric Meta did not report", async () => {
    mockedApi.getMetaOverview.mockResolvedValue({
      success: true,
      data: { accountId: ACCOUNT.accountId, dateRange: { start: "a", end: "b" }, totals: NULLS, rowCount: 0 },
      timestamp: ts(),
    } as never);

    render(<MetaAdsPage />);
    await waitFor(() => {
      const values = screen.getAllByTestId("stat-value").map((n) => n.textContent);
      expect(values).toEqual(["—", "—", "—", "—"]);
    });
  });

  it("offers a retry when the metric endpoints all fail", async () => {
    const failure = { success: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Meta is unavailable" }, timestamp: ts() };
    mockedApi.getMetaOverview.mockResolvedValue(failure as never);
    mockedApi.getMetaTimeseries.mockResolvedValue(failure as never);
    mockedApi.getMetaCampaigns.mockResolvedValue(failure as never);

    render(<MetaAdsPage />);
    await waitFor(() => expect(screen.getAllByTestId("error-message")[0]!.textContent).toBe("Meta is unavailable"));
  });
});

// ---------------------------------------------------------------------------
// Authorization gates
// ---------------------------------------------------------------------------

describe("authorization gates", () => {
  it("says the deployment has no account rather than showing zeros", async () => {
    mockedApi.getMetaAccount.mockResolvedValue({
      success: false,
      error: { code: "ACCOUNT_NOT_CONFIGURED", message: "Ad account not configured on this server" },
      timestamp: ts(),
    } as never);

    render(<MetaAdsPage />);
    await waitFor(() => expect(screen.getByText("No ad account connected")).toBeInTheDocument());
    // And it does not go on to ask for data it cannot have.
    expect(mockedApi.getMetaOverview).not.toHaveBeenCalled();
    expect(mockedApi.listOpportunities).not.toHaveBeenCalled();
  });

  it("refuses to show another account's figures when the user is not authorized", async () => {
    mockedApi.getMetaAccount.mockResolvedValue({
      success: false,
      error: { code: "ACCOUNT_NOT_AUTHORIZED", message: "You are not authorized to view this ad account" },
      timestamp: ts(),
    } as never);

    render(<MetaAdsPage />);
    await waitFor(() => expect(screen.getByText("Not authorized for this account")).toBeInTheDocument());
    expect(mockedApi.getMetaOverview).not.toHaveBeenCalled();
    expect(mockedApi.getMetaCampaigns).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stat-value")).toBeNull();
  });

  it("does not mount the panel at all without a session", async () => {
    sessionStorage.clear();
    global.fetch = vi.fn(() =>
      Promise.resolve({
        status: 401,
        ok: false,
        json: () => Promise.resolve({ success: false, error: { code: "AUTHENTICATION_REQUIRED", message: "x" }, timestamp: ts() }),
      } as Response)
    ) as unknown as typeof fetch;

    render(
      <AuthProvider>
        <MetaAdsLayout>
          <p data-testid="meta-child">child</p>
        </MetaAdsLayout>
      </AuthProvider>
    );

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByTestId("meta-child")).toBeNull();
    expect(mockedApi.getMetaAccount).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Opportunities / anomalies / diagnosis
// ---------------------------------------------------------------------------

describe("opportunities panel", () => {
  const OPP = {
    id: "opp-1",
    priority: "CRITICAL",
    title: "Reduce budget on an underperforming ad set",
    entityName: "Retargeting — 30d",
    anomalies: [{ metric: "cpa", severity: "HIGH" }, { metric: "roas", severity: "MEDIUM" }],
  };

  it("ranks by priority and shows the anomaly count", () => {
    render(<OpportunityPanel items={[OPP as never]} loading={false} error={null} onRetry={vi.fn()} />);

    const row = screen.getByTestId("opportunity-row");
    expect(screen.getByTestId("opportunity-priority").textContent).toBe("CRITICAL");
    expect(within(row).getByText("Reduce budget on an underperforming ad set")).toBeInTheDocument();
    expect(screen.getByTestId("opportunity-anomalies").textContent).toContain("2 anomalies");
  });

  it("links into the existing review flow rather than acting in place", () => {
    render(<OpportunityPanel items={[OPP as never]} loading={false} error={null} onRetry={vi.fn()} />);

    const review = screen.getByTestId("review-opp-1");
    expect(review).toHaveAttribute("href", "/opportunities/opp-1");
    // No control on this panel performs an action.
    expect(screen.queryByRole("button", { name: /approve|execute|apply|pause|resume/i })).toBeNull();
  });

  it("says nothing is flagged rather than inventing a suggestion", () => {
    render(<OpportunityPanel items={[]} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.getByText("Nothing flagged")).toBeInTheDocument();
  });

  it("surfaces a load failure with a retry", () => {
    const onRetry = vi.fn();
    render(<OpportunityPanel items={[]} loading={false} error="boom" onRetry={onRetry} />);
    expect(screen.getByTestId("error-message").textContent).toBe("boom");
  });

  it("shows a loading state", () => {
    render(<OpportunityPanel items={[]} loading error={null} onRetry={vi.fn()} />);
    expect(screen.getByTestId("loading-state")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The approval boundary — the point of this sprint
// ---------------------------------------------------------------------------

describe("write boundary", () => {
  const WRITE_FNS = [
    "approveApproval",
    "rejectApproval",
    "confirmPendingAction",
    "rejectPendingActionApi",
    "modifyPendingAction",
    "uploadKnowledgeDocument",
    "deleteKnowledgeDocument",
    "sendChatMessage",
  ] as const;

  it("triggers no write of any kind while rendering", async () => {
    render(<MetaAdsPage />);
    await waitFor(() => expect(screen.getByTestId("account-context")).toBeInTheDocument());

    for (const fn of WRITE_FNS) {
      expect(mockedApi[fn], fn).not.toHaveBeenCalled();
    }
  });

  it("triggers no write even when every read fails", async () => {
    const failure = { success: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "down" }, timestamp: ts() };
    mockedApi.getMetaOverview.mockResolvedValue(failure as never);
    mockedApi.getMetaTimeseries.mockResolvedValue(failure as never);
    mockedApi.getMetaCampaigns.mockResolvedValue(failure as never);
    mockedApi.listOpportunities.mockResolvedValue(failure as never);

    render(<MetaAdsPage />);
    await waitFor(() => expect(screen.getByTestId("account-context")).toBeInTheDocument());

    for (const fn of WRITE_FNS) {
      expect(mockedApi[fn], fn).not.toHaveBeenCalled();
    }
  });

  it("ships no client wrapper for any Meta write or recommendation execution", async () => {
    // Sprint 4.6 deliberately never wrapped POST /recommendations/:id/execute,
    // and there has never been a client function that calls a Meta write tool.
    // Reading the real module (not the mock) keeps this honest.
    const real = await vi.importActual<Record<string, unknown>>("../src/lib/api");
    const exported = Object.keys(real).filter((k) => typeof real[k] === "function");

    // ALLOWLIST, not a loosened pattern.
    //
    // The rule this test protects is "the browser cannot trigger a Meta write
    // or run a recommendation". It was written as "no export whose name
    // contains `execute`", which was the same thing until Phase 13 added an
    // approval-gated Google Workspace write path — `executeGoogleWrite` then
    // tripped a Meta boundary check by name alone.
    //
    // Widening the regex would have quietly stopped guarding `executeX` for
    // Meta too. Naming the one permitted export keeps the guard absolute for
    // everything else: a new Meta write wrapper still fails this test, and so
    // does a second Google one added without a deliberate edit here.
    //
    // What makes this export safe is not its name: it POSTs to
    // /integrations/google/writes/:approvalId/execute, which spends a durable
    // APPROVED approval the user created on this page. It cannot originate a
    // write, and it carries no parameters — the payload is the approved plan.
    const ALLOWED_WRITE_WRAPPERS = ["executeGoogleWrite"];

    const forbidden = exported.filter(
      (name) =>
        /execute|pause|resume|budget|createCampaign|updateCampaign/i.test(name) &&
        !ALLOWED_WRITE_WRAPPERS.includes(name)
    );
    expect(forbidden).toEqual([]);
  });

  it("has no Meta write wrapper hiding behind the Google allowance", async () => {
    // The allowlist above is exact, so this pins the thing it must never
    // become: a Meta write reachable from the browser.
    const real = await vi.importActual<Record<string, unknown>>("../src/lib/api");
    const metaWriteShaped = Object.keys(real).filter(
      (k) => typeof real[k] === "function" && /^(execute|pause|resume|update|create).*meta/i.test(k)
    );
    expect(metaWriteShaped).toEqual([]);
  });

  it("tells the user where changes actually get approved", async () => {
    render(<MetaAdsPage />);
    await waitFor(() => expect(screen.getByTestId("read-only-badge")).toBeInTheDocument());
    expect(screen.getByTestId("read-only-badge").textContent).toContain("Read only");
    expect(screen.getByRole("link", { name: "Open approvals" })).toHaveAttribute("href", "/approvals");
  });

  it("is now a navigable destination", () => {
    expect(NAV_ITEMS.find((i) => i.href === "/meta-ads")?.available).toBe(true);
  });
});
