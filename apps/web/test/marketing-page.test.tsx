// ---------------------------------------------------------------------------
// Phase 15 — the Marketing screen.
//
// The screen is a client for the marketing API, so these tests check that it
// calls it correctly and words what it returns. Three rules are asserted again
// and again because they are the point of the screen:
//
//   1. SAVING IS NOT PUBLISHING, and the screen never says otherwise. An item
//      is shown as published only when the API says how that is known, and
//      the two ways it can be known are never worded alike.
//
//   2. A PUBLISH IS ASKED FOR, DECIDED, THEN RUN. Pressing Publish posts
//      nothing; it shows the server's own text and Page. The post goes out
//      only after "Approve and publish" — and "Published" appears only when
//      the reply says `published: true`. An unknown outcome is shown as that.
//
//   3. NO CONTROL THAT CANNOT DO ANYTHING. What the server says is unavailable
//      — to this deployment or to this role — is not drawn.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type {
  ContentItemView,
  MarketingCampaignView,
  MarketingRecommendationSet,
  MarketingReportDocument,
  MarketingReportView,
  MarketingResearchView,
  PageFacts,
  PublishPreparation,
} from "@jarvis/core/marketing";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/marketing",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    getMarketingStatus: vi.fn(),
    listProjects: vi.fn(),
    listMarketingCampaigns: vi.fn(),
    createMarketingCampaign: vi.fn(),
    getMarketingCampaign: vi.fn(),
    updateMarketingCampaign: vi.fn(),
    getMarketingCalendar: vi.fn(),
    getMarketingContent: vi.fn(),
    planMarketingContent: vi.fn(),
    updateMarketingContent: vi.fn(),
    markMarketingContentPublished: vi.fn(),
    requestMarketingPublish: vi.fn(),
    executeMarketingPublish: vi.fn(),
    approveApproval: vi.fn(),
    rejectApproval: vi.fn(),
    listMarketingResearch: vi.fn(),
    getMarketingResearch: vi.fn(),
    runSeoAudit: vi.fn(),
    runCompetitorAnalysis: vi.fn(),
    listMarketingReports: vi.fn(),
    generateMarketingReport: vi.fn(),
    getMarketingReport: vi.fn(),
    downloadMarketingReport: vi.fn(),
    getMarketingRecommendations: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import MarketingPage from "../src/app/marketing/page";
import { NAV_ITEMS, activeNavHref } from "../src/components/dashboard/nav";
import { publicationOf } from "../src/components/marketing/format";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();
const ok = <T,>(data: T) => ({ success: true as const, data, timestamp: ts() });
const refused = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  success: false as const,
  error: { code, message, ...extra },
  timestamp: ts(),
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TODAY = new Date().toISOString().slice(0, 10);

const STATUS = (over: Partial<api.MarketingStatus> = {}): api.MarketingStatus => ({
  research: { available: true, reason: null },
  publishing: { available: true, channels: ["FACEBOOK"], reason: null },
  adAccount: { available: true },
  caller: { canEdit: true, canResearch: true, canPublish: true },
  ...over,
});

const ITEM = (over: Partial<ContentItemView> = {}): ContentItemView => ({
  id: "item-1",
  campaignId: null,
  projectId: null,
  title: "Teaser",
  channel: "FACEBOOK",
  format: "POST",
  body: "Something festive is coming.",
  link: null,
  notes: null,
  status: "DRAFT",
  scheduledDate: TODAY,
  scheduledTime: null,
  publication: null,
  publishAttempt: null,
  publishUnconfirmed: false,
  createdBy: "user",
  createdAt: ts(),
  updatedAt: ts(),
  ...over,
});

function CALENDAR(items: ContentItemView[]): api.MarketingCalendar {
  const dated = new Map<string, ContentItemView[]>();
  for (const item of items) if (item.scheduledDate) dated.set(item.scheduledDate, [...(dated.get(item.scheduledDate) ?? []), item]);
  return {
    from: TODAY,
    to: TODAY,
    days: [...dated.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => ({ date, items: list })),
    unscheduled: items.filter((item) => !item.scheduledDate),
    total: items.length,
    truncated: false,
  };
}

const CAMPAIGN = (over: Partial<MarketingCampaignView> = {}): MarketingCampaignView => ({
  id: "camp-1",
  name: "Diwali Sale",
  objective: "Sell the gift sets",
  brief: null,
  status: "PLANNING",
  channels: ["FACEBOOK"],
  startDate: "2026-11-01",
  endDate: "2026-11-12",
  projectId: null,
  metaCampaignIds: [],
  createdAt: ts(),
  updatedAt: ts(),
  ...over,
});

const ASK = (over: Partial<api.MarketingPublishAsk> = {}): api.MarketingPublishAsk => ({
  status: "APPROVAL_REQUIRED",
  published: false,
  ask: "REQUESTED",
  approvalId: "appr-1",
  expiresAt: "2026-10-12T10:10:00.000Z",
  // Deliberately NOT the words the calendar fixture shows: what a person
  // approves must be what the server says it will post.
  params: { contentId: "item-1", targetId: "page-1", targetName: "Shop Page", message: "THE SERVER'S COPY OF THE TEXT" },
  summary: {
    actionSummary: "Publish this post publicly to Shop Page. JARVIS cannot undo it.",
    detailLines: [
      { label: "Publish to", value: "Shop Page" },
      { label: "Text to be posted", value: "THE SERVER'S COPY OF THE TEXT" },
    ],
  },
  ...over,
});

const DONE = (over: Partial<api.MarketingPublishDone> = {}): api.MarketingPublishDone => ({
  status: "PUBLISHED",
  published: true,
  message: "Published to Shop Page and read back from the Page.",
  alreadyPublished: false,
  item: null,
  ...over,
});

const FACTS: PageFacts = {
  title: "Kiln & Clay",
  titleLength: 11,
  metaDescription: null,
  metaDescriptionLength: 0,
  canonical: null,
  robotsMeta: null,
  lang: "en",
  viewport: true,
  charset: "utf-8",
  h1: ["Handmade mugs"],
  h2: [],
  headingCounts: { h1: 1, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
  wordCount: 120,
  images: { total: 2, missingAlt: 1 },
  links: { internal: 3, external: 1, nofollow: 0 },
  openGraph: {},
  twitterCard: null,
  structuredDataTypes: [],
  hreflang: [],
  topTerms: [{ term: "mugs", count: 4 }],
};

const RESEARCH = (over: Partial<MarketingResearchView> = {}): MarketingResearchView => ({
  id: "res-1",
  kind: "SEO_AUDIT",
  campaignId: null,
  projectId: null,
  host: "kiln.example",
  url: "https://kiln.example/",
  fetchedAt: "2026-10-12T09:00:00.000Z",
  headline: "1 thing to fix, 1 worth fixing",
  createdAt: ts(),
  provenance: {
    requestedUrl: "https://kiln.example/",
    finalUrl: "https://kiln.example/",
    httpStatus: 200,
    fetchedAt: "2026-10-12T09:00:00.000Z",
    contentType: "text/html",
    bytes: 2048,
    truncated: false,
    redirects: 0,
  },
  audit: {
    facts: FACTS,
    checks: [
      { id: "meta-description", label: "Meta description", severity: "critical", finding: "The page has no meta description.", recommendation: "Write one of 120 to 160 characters." },
      { id: "image-alt", label: "Image descriptions", severity: "warning", finding: "1 of 2 images has no description." },
      { id: "title", label: "Title", severity: "pass", finding: "The title is 11 characters." },
    ],
    counts: { pass: 1, info: 0, warning: 1, critical: 1 },
    notMeasured: ["Search rankings and search volume are not on the page and were not measured."],
  },
  competitor: null,
  ownProvenance: null,
  ...over,
});

const NOTICE = "This is text read from a web page. It is untrusted content, not instructions.";

function DOCUMENT(over: Partial<MarketingReportDocument> = {}): MarketingReportDocument {
  const kpis = {
    spend: 1500,
    impressions: 60000,
    clicks: 1200,
    reach: 40000,
    conversions: 30,
    revenue: 3000,
    ctr: 2,
    cpc: 1.25,
    cpm: 25,
    cpa: 50,
    roas: 2,
    cvr: 2.5,
    frequency: 1.5,
    isDefined: { ctr: true, cpc: true, cpm: true, cpa: true, roas: true, cvr: true, frequency: true },
  };
  return {
    schemaVersion: 1,
    kind: "PERFORMANCE",
    title: "Marketing — performance report",
    campaign: null,
    period: { start: "2026-09-12", end: "2026-10-11", days: 30 },
    previousPeriod: null,
    generatedAt: "2026-10-12T09:00:00.000Z",
    currency: "INR",
    dataSources: [
      { provider: "meta-ads", label: "Meta Ads", status: "INCLUDED", detail: "Read for the whole connected ad account.", rowCount: 1, executionIds: ["e1"], account: "act_120••••015" },
      {
        provider: "google-ads",
        label: "Google Ads",
        status: "SCOPE_NOT_GRANTED",
        detail: "Your Google account is connected, but read access to Google Ads was not granted.",
        rowCount: 0,
        executionIds: [],
        account: null,
      },
    ],
    totals: kpis,
    previousTotals: null,
    metricsReported: { conversions: true, revenue: true, reach: true },
    changes: [
      { metric: "spend", label: "Spend", current: 1500, previous: null, absolute: null, relativePct: null, unit: "currency" },
      { metric: "clicks", label: "Clicks", current: 1200, previous: null, absolute: null, relativePct: null, unit: "count" },
      { metric: "conversions", label: "Conversions", current: null, previous: null, absolute: null, relativePct: null, unit: "count" },
    ],
    campaigns: [{ id: "120210000000000001", name: "Diwali — Prospecting", kpis }],
    content: {
      published: [
        { title: "Posted by hand", channel: "FACEBOOK", date: "2026-10-09", status: "PUBLISHED", publication: "REPORTED_BY_USER", url: null },
        { title: "Teaser", channel: "FACEBOOK", date: "2026-10-10", status: "PUBLISHED", publication: "VERIFIED", url: null },
      ],
      planned: [{ title: "Offer", channel: "INSTAGRAM", date: null, status: "DRAFT", publication: null, url: null }],
      counts: { published: 2, verified: 1, reportedByUser: 1, planned: 1 },
    },
    notes: ["Google Ads figures are not in this report."],
    disclaimer: "This report states what was read. It changed nothing and was sent to no one.",
    ...over,
  };
}

const REPORT = (over: Partial<MarketingReportDocument> = {}): MarketingReportView => {
  const document = DOCUMENT(over);
  return {
    id: "rep-1",
    kind: document.kind,
    title: document.title,
    campaignId: null,
    projectId: null,
    periodStart: document.period.start,
    periodEnd: document.period.end,
    generatedAt: document.generatedAt,
    sourcesIncluded: document.dataSources.filter((source) => source.status === "INCLUDED").length,
    sourcesTotal: document.dataSources.length,
    document,
  };
};

const RECOMMENDATIONS = (): MarketingRecommendationSet & { count: number } => ({
  generatedAt: "2026-10-12T09:00:00.000Z",
  basis: { campaign: null, contentItems: 4, hasReport: true, seoAudits: 1 },
  recommendations: [
    {
      id: "ready-not-published",
      area: "PUBLISHING",
      priority: "HIGH",
      title: "2 items are ready and have not gone out",
      rationale: "They were marked ready and their planned date has passed.",
      evidence: ["“Teaser” was planned for 2026-10-05 and is still ready."],
      suggestedAction: "Publish them, or move them to a later date.",
      needsApproval: true,
      executed: false,
    },
    {
      id: "seo-meta-description",
      area: "SEO",
      priority: "LOW",
      title: "kiln.example has no meta description",
      rationale: "The last audit of the page found none.",
      evidence: ["Audit of kiln.example on 2026-10-12: no meta description."],
      suggestedAction: "Write a meta description for the page.",
      needsApproval: false,
      executed: false,
    },
  ],
  note: "These are recommendations based on what is in the workspace. Nothing was changed, published or sent by producing them.",
  count: 2,
});

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getMarketingStatus.mockResolvedValue(ok(STATUS()));
  mocked.listProjects.mockResolvedValue(ok({ projects: [] }));
  mocked.listMarketingCampaigns.mockResolvedValue(ok({ campaigns: [], count: 0, inOtherProjects: 0 }));
  mocked.getMarketingCalendar.mockResolvedValue(ok(CALENDAR([ITEM()])));
  mocked.listMarketingResearch.mockResolvedValue(ok({ research: [], count: 0 }));
  mocked.listMarketingReports.mockResolvedValue(ok({ reports: [], count: 0 }));
  mocked.getMarketingRecommendations.mockResolvedValue(ok(RECOMMENDATIONS()));
});

const items = () => screen.findAllByTestId("content-item");
const item = async (title: string) => (await items()).find((node) => within(node).queryByText(title))!;
const button = (scope: HTMLElement, name: string | RegExp) => within(scope).getByRole("button", { name });
const hasButton = (scope: HTMLElement, name: string | RegExp) => within(scope).queryByRole("button", { name }) !== null;
const openView = async (name: string) => fireEvent.click(await screen.findByRole("tab", { name }));
const panel = () => screen.findByTestId("publish-panel");

/** Render with one READY Facebook item, and press its Publish button. */
async function startPublish(itemOver: Partial<ContentItemView> = {}) {
  mocked.getMarketingCalendar.mockResolvedValue(ok(CALENDAR([ITEM({ status: "READY", ...itemOver })])));
  render(<MarketingPage />);
  fireEvent.click(button(await item("Teaser"), /^(Publish|Check and publish)$/));
  return panel();
}

// ---------------------------------------------------------------------------

describe("Marketing screen — the shell", () => {
  it("is in the navigation, and lights up for its own route", () => {
    expect(NAV_ITEMS.find((entry) => entry.href === "/marketing")).toMatchObject({ label: "Marketing", available: true });
    expect(activeNavHref("/marketing")).toBe("/marketing");
  });

  it("offers the five views, opening on the calendar", async () => {
    render(<MarketingPage />);

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Calendar", "Campaigns", "Research", "Reports", "Recommendations"]);
    expect(screen.getByRole("tab", { name: "Calendar" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Content calendar")).toBeInTheDocument();
  });

  it("says saving is not publishing, before anything else", async () => {
    render(<MarketingPage />);

    expect(await screen.findByText(/Saving is not publishing: a post goes out only when you approve its exact text\./)).toBeInTheDocument();
  });

  it("shows nothing but the failure when the workspace cannot be loaded", async () => {
    mocked.getMarketingStatus.mockResolvedValue(refused("INTERNAL_ERROR", "The marketing workspace is not responding."));

    render(<MarketingPage />);

    expect(await screen.findByText("The marketing workspace is not responding.")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("offers a project filter only when the user has projects, and reads again for the chosen one", async () => {
    mocked.listProjects.mockResolvedValue(ok({ projects: [{ id: "proj-1", name: "Alpha", description: null, createdAt: ts(), updatedAt: ts() }] }));

    render(<MarketingPage />);
    fireEvent.change(await screen.findByLabelText("Project"), { target: { value: "proj-1" } });

    await waitFor(() => expect(mocked.listMarketingCampaigns).toHaveBeenLastCalledWith({ projectId: "proj-1" }));
    await waitFor(() => expect(mocked.getMarketingCalendar).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "proj-1" })));
  });

  it("draws no project filter for a user with none", async () => {
    render(<MarketingPage />);
    await items();

    expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("Marketing screen — a role that can only read", () => {
  beforeEach(() => {
    mocked.getMarketingStatus.mockResolvedValue(ok(STATUS({ caller: { canEdit: false, canResearch: true, canPublish: false } })));
    mocked.getMarketingCalendar.mockResolvedValue(ok(CALENDAR([ITEM({ status: "READY" })])));
  });

  it("is told so, once, in words", async () => {
    render(<MarketingPage />);

    expect(await screen.findByTestId("marketing-read-only")).toHaveTextContent("Your role can view the marketing workspace. It cannot change it or publish.");
  });

  it("is shown the calendar with no control that would be refused", async () => {
    render(<MarketingPage />);
    const node = await item("Teaser");

    expect(within(node).queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("form", { name: "Add content" })).not.toBeInTheDocument();
  });

  it("is shown campaigns with no way to create or change one", async () => {
    mocked.listMarketingCampaigns.mockResolvedValue(ok({ campaigns: [CAMPAIGN()], count: 1, inOtherProjects: 0 }));

    render(<MarketingPage />);
    await openView("Campaigns");

    expect(await screen.findByTestId("campaign-row")).toHaveTextContent("Diwali Sale");
    expect(screen.queryByRole("form", { name: "New campaign" })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("Marketing screen — the calendar", () => {
  it("lays items out by day, and keeps the undated ones apart", async () => {
    mocked.getMarketingCalendar.mockResolvedValue(ok(CALENDAR([ITEM(), ITEM({ id: "item-2", title: "Someday", scheduledDate: null, status: "IDEA", body: "" })])));

    render(<MarketingPage />);

    expect(within(await screen.findByTestId("calendar-day")).getByText("Teaser")).toBeInTheDocument();
    expect(within(await screen.findByTestId("calendar-unscheduled")).getByText("Someday")).toBeInTheDocument();
  });

  it("says a date is a plan and that nothing publishes because it arrives", async () => {
    render(<MarketingPage />);

    expect(await screen.findByText(/A date is a plan — nothing is published because a date arrives\./)).toBeInTheDocument();
  });

  it("never words the two kinds of published alike, and never calls an unknown outcome published", async () => {
    mocked.getMarketingCalendar.mockResolvedValue(
      ok(
        CALENDAR([
          ITEM({
            id: "v",
            title: "Verified",
            status: "PUBLISHED",
            publication: { mode: "VERIFIED", publishedAt: ts(), provider: "meta-graph", targetName: "Shop Page", externalId: "1_2", url: "https://facebook.example/1_2", verifiedAt: ts() },
          }),
          ITEM({
            id: "r",
            title: "Reported",
            status: "PUBLISHED",
            publication: { mode: "REPORTED_BY_USER", publishedAt: ts(), provider: null, targetName: null, externalId: null, url: null, verifiedAt: null },
          }),
          ITEM({ id: "u", title: "Unknown", status: "READY", publishUnconfirmed: true }),
          ITEM({ id: "d", title: "Draft only" }),
        ])
      )
    );

    render(<MarketingPage />);

    expect(within(await item("Verified")).getByText("Published · verified")).toBeInTheDocument();
    expect(within(await item("Verified")).getByText("Published by JARVIS to Shop Page and read back from it.")).toBeInTheDocument();

    const reported = await item("Reported");
    expect(within(reported).getByText("Published · reported by you")).toBeInTheDocument();
    expect(within(reported).getByText(/JARVIS did not publish it and has not checked that it is live\./)).toBeInTheDocument();
    expect(within(reported).queryByText(/verified/i)).not.toBeInTheDocument();

    const unknown = await item("Unknown");
    expect(within(unknown).getByText("Publish not confirmed")).toBeInTheDocument();
    expect(within(unknown).getByText(/This item is NOT marked as published\./)).toBeInTheDocument();
    expect(within(unknown).queryByText(/^Published/)).not.toBeInTheDocument();

    expect(within(await item("Draft only")).getByText("Draft")).toBeInTheDocument();
  });

  it("the wording rule itself: published means a recorded publication, and nothing else does", () => {
    expect(publicationOf(ITEM())).toBeNull();
    expect(publicationOf(ITEM({ status: "READY" }))).toBeNull();
    // A status alone is never enough: with no record of how it is known, it is not shown as published.
    expect(publicationOf(ITEM({ status: "PUBLISHED" }))).toBeNull();
    expect(publicationOf(ITEM({ publishUnconfirmed: true }))!.tone).toBe("warn");
    expect(publicationOf(ITEM({ publishUnconfirmed: true }))!.label).not.toMatch(/published/i);
  });

  it("adds an item as a draft, and says nothing was published", async () => {
    mocked.planMarketingContent.mockResolvedValue(ok({ campaign: null, saved: 1, items: [ITEM()] }));
    render(<MarketingPage />);
    const form = await screen.findByRole("form", { name: "Add content" });

    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "  Offer  " } });
    fireEvent.change(within(form).getByLabelText("Text — exactly what would be posted"), { target: { value: "Gift sets are live." } });
    fireEvent.change(within(form).getByLabelText("Planned for (optional)"), { target: { value: "2026-11-05" } });
    fireEvent.click(button(form, "Add to calendar"));

    await waitFor(() =>
      expect(mocked.planMarketingContent).toHaveBeenCalledWith({ items: [{ title: "Offer", channel: "FACEBOOK", body: "Gift sets are live.", scheduledDate: "2026-11-05" }] }, null)
    );
    expect(await screen.findByText("Saved to the calendar as a draft. Nothing was published.")).toBeInTheDocument();
    expect(mocked.requestMarketingPublish).not.toHaveBeenCalled();
  });

  it("cannot add an item with no title", async () => {
    render(<MarketingPage />);
    const form = await screen.findByRole("form", { name: "Add content" });

    expect(button(form, "Add to calendar")).toBeDisabled();
  });

  it("shows the server's refusal when a save is refused, and claims nothing", async () => {
    mocked.planMarketingContent.mockResolvedValue(refused("LIMIT", "At most 5000 content items can be kept."));
    render(<MarketingPage />);
    const form = await screen.findByRole("form", { name: "Add content" });

    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Offer" } });
    fireEvent.click(button(form, "Add to calendar"));

    expect(await screen.findByText("At most 5000 content items can be kept.")).toBeInTheDocument();
    expect(screen.queryByText(/Saved to the calendar/)).not.toBeInTheDocument();
  });

  it("opens an item for editing from the WHOLE item, never from the shortened one in the list", async () => {
    const whole = `${"A long post. ".repeat(40)}The end.`;
    mocked.getMarketingCalendar.mockResolvedValue(ok(CALENDAR([ITEM({ body: `${whole.slice(0, 280)}…` })])));
    mocked.getMarketingContent.mockResolvedValue(ok({ ...CALENDAR([ITEM({ body: whole })]), item: ITEM({ body: whole }) }));
    mocked.updateMarketingContent.mockResolvedValue(ok({ item: ITEM({ body: whole }) }));

    render(<MarketingPage />);
    fireEvent.click(button(await item("Teaser"), "Edit"));

    const form = await screen.findByRole("form", { name: "Edit Teaser" });
    expect(mocked.getMarketingContent).toHaveBeenCalledWith("item-1");
    expect(within(form).getByLabelText("Text — exactly what would be posted")).toHaveValue(whole);

    fireEvent.click(button(form, "Save"));
    await waitFor(() => expect(mocked.updateMarketingContent).toHaveBeenCalledTimes(1));
    // What is saved is the whole text, not the 280 characters the list showed.
    expect(mocked.updateMarketingContent.mock.calls[0]![1]).toMatchObject({ body: whole });
  });

  it("does not open the editor at all when the whole item cannot be read", async () => {
    mocked.getMarketingContent.mockResolvedValue(refused("NOT_FOUND", "That content item was not found."));

    render(<MarketingPage />);
    fireEvent.click(button(await item("Teaser"), "Edit"));

    expect(await screen.findByText("That content item was not found.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Edit Teaser" })).not.toBeInTheDocument();
    expect(mocked.updateMarketingContent).not.toHaveBeenCalled();
  });

  it("warns that changing a ready item's words makes it a draft again", async () => {
    mocked.getMarketingCalendar.mockResolvedValue(ok(CALENDAR([ITEM({ status: "READY" })])));
    mocked.getMarketingContent.mockResolvedValue(ok({ ...CALENDAR([]), item: ITEM({ status: "READY" }) }));

    render(<MarketingPage />);
    fireEvent.click(button(await item("Teaser"), "Edit"));

    expect(await screen.findByText(/Changing its words returns it to a draft, and it must be marked ready again\./)).toBeInTheDocument();
  });

  it("marks a draft ready — and says that is not publishing", async () => {
    mocked.updateMarketingContent.mockResolvedValue(ok({ item: ITEM({ status: "READY" }) }));

    render(<MarketingPage />);
    fireEvent.click(button(await item("Teaser"), "Mark ready"));

    await waitFor(() => expect(mocked.updateMarketingContent).toHaveBeenCalledWith("item-1", { status: "READY" }));
    expect(await screen.findByText("Marked ready. It has not been published.")).toBeInTheDocument();
  });

  it("offers no 'Mark ready' for an item with no words", async () => {
    mocked.getMarketingCalendar.mockResolvedValue(ok(CALENDAR([ITEM({ status: "IDEA", body: "" })])));

    render(<MarketingPage />);

    expect(hasButton(await item("Teaser"), "Mark ready")).toBe(false);
  });

  it("records a post the user made themselves as reported, in those words", async () => {
    mocked.markMarketingContentPublished.mockResolvedValue(ok({ item: ITEM({ status: "PUBLISHED" }), note: "x" }));

    render(<MarketingPage />);
    fireEvent.click(button(await item("Teaser"), "I posted this myself"));
    const form = await screen.findByRole("form", { name: "Record Teaser as posted" });
    fireEvent.change(within(form).getByLabelText("Link to the post (optional)"), { target: { value: "https://facebook.example/p/1" } });
    fireEvent.click(button(form, "Record as posted"));

    await waitFor(() => expect(mocked.markMarketingContentPublished).toHaveBeenCalledWith("item-1", { url: "https://facebook.example/p/1" }));
    expect(await screen.findByText("Recorded as posted by you. JARVIS did not publish it and has not checked that it is live.")).toBeInTheDocument();
    expect(mocked.requestMarketingPublish).not.toHaveBeenCalled();
  });

  it("gives a published item no controls: it is a record", async () => {
    mocked.getMarketingCalendar.mockResolvedValue(
      ok(
        CALENDAR([
          ITEM({
            status: "PUBLISHED",
            publication: { mode: "VERIFIED", publishedAt: ts(), provider: "meta-graph", targetName: "Shop Page", externalId: "1_2", url: null, verifiedAt: ts() },
          }),
        ])
      )
    );

    render(<MarketingPage />);

    expect(within(await item("Teaser")).queryAllByRole("button")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("Marketing screen — where a Publish button is, and is not", () => {
  const withItem = (over: Partial<ContentItemView>, status: Partial<api.MarketingStatus> = {}) => {
    mocked.getMarketingStatus.mockResolvedValue(ok(STATUS(status)));
    mocked.getMarketingCalendar.mockResolvedValue(ok(CALENDAR([ITEM(over)])));
    render(<MarketingPage />);
  };

  it("is on a ready item for a channel this server can publish to", async () => {
    withItem({ status: "READY" });

    expect(hasButton(await item("Teaser"), "Publish")).toBe(true);
  });

  it("is not on a draft", async () => {
    withItem({ status: "DRAFT" });

    expect(hasButton(await item("Teaser"), "Publish")).toBe(false);
  });

  it("is not on a channel there is no publisher for — and the item says why", async () => {
    withItem({ status: "READY", channel: "INSTAGRAM" });
    const node = await item("Teaser");

    expect(hasButton(node, "Publish")).toBe(false);
    expect(within(node).getByText("JARVIS cannot publish to Instagram. Post it yourself, then record it here.")).toBeInTheDocument();
    expect(hasButton(node, "I posted this myself")).toBe(true);
  });

  it("is not there when the server has no publisher at all", async () => {
    withItem({ status: "READY" }, { publishing: { available: false, channels: [], reason: "No publishing connection is configured on this server." } });
    const node = await item("Teaser");

    expect(hasButton(node, "Publish")).toBe(false);
    expect(within(node).getByText("JARVIS cannot publish from this server. Post it yourself, then record it here.")).toBeInTheDocument();
  });

  it("is not there for a role that can edit and cannot publish", async () => {
    withItem({ status: "READY" }, { caller: { canEdit: true, canResearch: true, canPublish: false } });
    const node = await item("Teaser");

    expect(hasButton(node, "Publish")).toBe(false);
    expect(within(node).getByText("Your role cannot publish.")).toBeInTheDocument();
  });

  it("says 'Check and publish' when an earlier attempt's outcome is unknown", async () => {
    withItem({ status: "READY", publishUnconfirmed: true });

    expect(hasButton(await item("Teaser"), "Check and publish")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("Marketing screen — publishing is asked for, decided, then run", () => {
  it("pressing Publish only ASKS: it shows the server's text and Page, and posts nothing", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));

    const node = await startPublish();
    const confirmation = await within(node).findByTestId("publish-confirmation");

    expect(mocked.requestMarketingPublish).toHaveBeenCalledWith("item-1", undefined);
    expect(within(confirmation).getByText("Publish this post publicly to Shop Page. JARVIS cannot undo it.")).toBeInTheDocument();
    // The words shown are the approval's, not this screen's copy of the item.
    expect(within(confirmation).getByText("THE SERVER'S COPY OF THE TEXT")).toBeInTheDocument();
    expect(within(confirmation).queryByText("Something festive is coming.")).not.toBeInTheDocument();
    expect(within(confirmation).getByText("Shop Page")).toBeInTheDocument();
    expect(mocked.approveApproval).not.toHaveBeenCalled();
    expect(mocked.executeMarketingPublish).not.toHaveBeenCalled();
  });

  it("asks once per press, not once per render", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));

    const node = await startPublish();
    await within(node).findByTestId("publish-confirmation");

    expect(mocked.requestMarketingPublish).toHaveBeenCalledTimes(1);
  });

  it("'Approve and publish' approves THAT approval, then publishes with it — in that order", async () => {
    const order: string[] = [];
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));
    mocked.approveApproval.mockImplementation(async () => {
      order.push("approve");
      return ok({ approvalId: "appr-1", status: "approved" });
    });
    mocked.executeMarketingPublish.mockImplementation(async () => {
      order.push("execute");
      return ok(DONE());
    });

    const node = await startPublish();
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Approve and publish"));

    expect(await within(node).findByText("Published to Shop Page and read back from the Page.")).toBeInTheDocument();
    expect(order).toEqual(["approve", "execute"]);
    expect(mocked.approveApproval).toHaveBeenCalledWith("appr-1");
    expect(mocked.executeMarketingPublish).toHaveBeenCalledWith("item-1", "appr-1");
    expect(node).toHaveAttribute("data-step", "published");
  });

  it("does not publish when the approval could not be recorded", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));
    mocked.approveApproval.mockResolvedValue(refused("APPROVAL_EXPIRED", "Approval has expired"));

    const node = await startPublish();
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Approve and publish"));

    expect(await within(node).findByText("Approval has expired")).toBeInTheDocument();
    expect(mocked.executeMarketingPublish).not.toHaveBeenCalled();
    expect(node).toHaveAttribute("data-step", "confirm");
  });

  it("shows an unknown outcome as NOT confirmed — never as published, never as a plain failure", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));
    mocked.approveApproval.mockResolvedValue(ok({ approvalId: "appr-1", status: "approved" }));
    mocked.executeMarketingPublish.mockResolvedValue(
      refused("UNCONFIRMED", "The post was sent to Shop Page, but the answer never arrived. It is NOT marked as published. Check the Page before trying again.", { published: false })
    );

    const node = await startPublish();
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Approve and publish"));

    const warning = await within(node).findByTestId("publish-unconfirmed");
    expect(within(warning).getByText("Not confirmed — do not assume it was posted")).toBeInTheDocument();
    expect(within(warning).getByText(/It is NOT marked as published\. Check the Page before trying again\./)).toBeInTheDocument();
    expect(node).toHaveAttribute("data-step", "unconfirmed");
    expect(within(node).queryByText(/^Published to/)).not.toBeInTheDocument();
    expect(within(node).queryByText("Not published")).not.toBeInTheDocument();
  });

  it("shows a refusal by the Page as not published, in the server's words", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));
    mocked.approveApproval.mockResolvedValue(ok({ approvalId: "appr-1", status: "approved" }));
    mocked.executeMarketingPublish.mockResolvedValue(refused("FAILED", "Facebook refused the post. Nothing was published.", { published: false, reason: "FAILED" }));

    const node = await startPublish();
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Approve and publish"));

    expect(await within(node).findByText("Facebook refused the post. Nothing was published.")).toBeInTheDocument();
    expect(within(node).getByText("Not published")).toBeInTheDocument();
    expect(node).toHaveAttribute("data-step", "refused");
  });

  it("when the words changed after the request, says so and publishes nothing", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));
    mocked.approveApproval.mockResolvedValue(ok({ approvalId: "appr-1", status: "approved" }));
    mocked.executeMarketingPublish.mockResolvedValue(
      refused("NOT_READY", "The saved text is no longer the text that was approved, so nothing was published. Check the item and ask again.", { published: false, reason: "STALE" })
    );

    const node = await startPublish();
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Approve and publish"));

    expect(await within(node).findByText(/no longer the text that was approved, so nothing was published/)).toBeInTheDocument();
    expect(within(node).getByText("This cannot be published yet")).toBeInTheDocument();
  });

  it("when the approval ran out of time, shows the NEW request instead of publishing", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));
    mocked.approveApproval.mockResolvedValue(ok({ approvalId: "appr-1", status: "approved" }));
    mocked.executeMarketingPublish.mockResolvedValue(ok(ASK({ ask: "EXPIRED", approvalId: "appr-2" })));

    const node = await startPublish();
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Approve and publish"));

    expect(await within(node).findByText(/The earlier request ran out of time, so nothing was posted\./)).toBeInTheDocument();
    expect(node).toHaveAttribute("data-step", "confirm");

    // Approving now decides the NEW approval, not the spent one.
    mocked.executeMarketingPublish.mockResolvedValue(ok(DONE()));
    fireEvent.click(button(within(node).getByTestId("publish-confirmation"), "Approve and publish"));
    await waitFor(() => expect(mocked.approveApproval).toHaveBeenLastCalledWith("appr-2"));
    await waitFor(() => expect(mocked.executeMarketingPublish).toHaveBeenLastCalledWith("item-1", "appr-2"));
  });

  it("does not call a reply published unless it says published: true", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));
    mocked.approveApproval.mockResolvedValue(ok({ approvalId: "appr-1", status: "approved" }));
    // A reply that names the status and does not carry the flag.
    mocked.executeMarketingPublish.mockResolvedValue(ok({ ...DONE(), published: false } as never));

    const node = await startPublish();
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Approve and publish"));

    await waitFor(() => expect(node).not.toHaveAttribute("data-step", "confirm"));
    expect(node).not.toHaveAttribute("data-step", "published");
    expect(within(node).queryByText("Published to Shop Page and read back from the Page.")).not.toBeInTheDocument();
  });

  it("'Decline' rejects the approval and posts nothing", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));
    mocked.rejectApproval.mockResolvedValue(ok({ approvalId: "appr-1", status: "rejected" }));

    const node = await startPublish();
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Decline"));

    expect(await within(node).findByText("Declined. Nothing was posted.")).toBeInTheDocument();
    expect(mocked.rejectApproval).toHaveBeenCalledWith("appr-1");
    expect(mocked.approveApproval).not.toHaveBeenCalled();
    expect(mocked.executeMarketingPublish).not.toHaveBeenCalled();
  });

  it("says 'declined' only when the server recorded it", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));
    mocked.rejectApproval.mockResolvedValue(refused("NETWORK_ERROR", "Network request failed"));

    const node = await startPublish();
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Decline"));

    expect(await within(node).findByText("Network request failed")).toBeInTheDocument();
    expect(within(node).queryByText("Declined. Nothing was posted.")).not.toBeInTheDocument();
  });

  it("'Not now' closes the panel without deciding anything", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));

    const node = await startPublish();
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Not now"));

    await waitFor(() => expect(screen.queryByTestId("publish-panel")).not.toBeInTheDocument());
    expect(mocked.approveApproval).not.toHaveBeenCalled();
    expect(mocked.rejectApproval).not.toHaveBeenCalled();
    expect(mocked.executeMarketingPublish).not.toHaveBeenCalled();
  });

  it("shows why an item cannot be published, with nothing to approve", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(refused("NOT_READY", "This item is not marked ready.", { published: false, preparation: null }));

    const node = await startPublish();

    expect(await within(node).findByText("This item is not marked ready.")).toBeInTheDocument();
    expect(hasButton(node, "Approve and publish")).toBe(false);
    expect(mocked.approveApproval).not.toHaveBeenCalled();
  });

  it("asks which Page when there is more than one, and asks the server again for that one", async () => {
    const preparation: PublishPreparation = {
      ready: false,
      blockers: ["Choose where to publish it: Shop Page, Studio Page."],
      channel: "FACEBOOK",
      targets: [
        { id: "page-1", name: "Shop Page", channel: "FACEBOOK", provider: "meta-graph" },
        { id: "page-2", name: "Studio Page", channel: "FACEBOOK", provider: "meta-graph" },
      ],
      publishParams: null,
      warning: null,
    };
    mocked.requestMarketingPublish.mockResolvedValueOnce(refused("NOT_READY", preparation.blockers[0]!, { published: false, preparation }));
    mocked.requestMarketingPublish.mockResolvedValueOnce(ok(ASK({ params: { contentId: "item-1", targetId: "page-2", targetName: "Studio Page", message: "x" } })));

    const node = await startPublish();
    fireEvent.change(await within(node).findByLabelText("Where to publish"), { target: { value: "page-2" } });
    fireEvent.click(button(node, "Continue"));

    await within(node).findByTestId("publish-confirmation");
    expect(mocked.requestMarketingPublish).toHaveBeenLastCalledWith("item-1", "page-2");
    expect(mocked.executeMarketingPublish).not.toHaveBeenCalled();
  });

  it("when these exact words were already approved, the request itself publishes — and is shown as published", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(DONE({ alreadyPublished: true, message: "An earlier attempt had already published this to Shop Page. Nothing new was posted." })));

    const node = await startPublish({ publishUnconfirmed: true });

    expect(await within(node).findByText(/Nothing new was posted\./)).toBeInTheDocument();
    expect(node).toHaveAttribute("data-step", "published");
  });

  it("reads the calendar again after a publish, so the item shows what the server now says", async () => {
    mocked.requestMarketingPublish.mockResolvedValue(ok(ASK()));
    mocked.approveApproval.mockResolvedValue(ok({ approvalId: "appr-1", status: "approved" }));
    mocked.executeMarketingPublish.mockResolvedValue(ok(DONE()));

    const node = await startPublish();
    const before = mocked.getMarketingCalendar.mock.calls.length;
    fireEvent.click(button(await within(node).findByTestId("publish-confirmation"), "Approve and publish"));

    await within(node).findByText("Published to Shop Page and read back from the Page.");
    await waitFor(() => expect(mocked.getMarketingCalendar.mock.calls.length).toBeGreaterThan(before));
  });
});

// ---------------------------------------------------------------------------

describe("Marketing screen — campaign workspaces", () => {
  it("creates a workspace, and says it creates nothing in an ad account", async () => {
    mocked.createMarketingCampaign.mockResolvedValue(ok({ campaign: CAMPAIGN() }));
    render(<MarketingPage />);
    await openView("Campaigns");
    const form = await screen.findByRole("form", { name: "New campaign" });

    expect(screen.getByText(/It creates nothing in an ad account\./)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Diwali Sale" } });
    fireEvent.click(button(form, "Create workspace"));

    await waitFor(() => expect(mocked.createMarketingCampaign).toHaveBeenCalledWith({ name: "Diwali Sale" }, null));
    expect(await screen.findByText("Campaign workspace created. Nothing was published or changed outside JARVIS.")).toBeInTheDocument();
  });

  it("opens a workspace and shows what is in it, with unconfirmed publishes counted apart", async () => {
    mocked.listMarketingCampaigns.mockResolvedValue(ok({ campaigns: [CAMPAIGN()], count: 1, inOtherProjects: 0 }));
    mocked.getMarketingCampaign.mockResolvedValue(
      ok({
        campaign: CAMPAIGN(),
        content: { total: 6, byStatus: { IDEA: 1, DRAFT: 2, READY: 2, PUBLISHED: 1, ARCHIVED: 0 }, upcoming: [ITEM({ title: "Offer", scheduledDate: "2026-11-05" })], unconfirmed: 1 },
        latestReport: null,
        latestResearch: [],
      })
    );

    render(<MarketingPage />);
    await openView("Campaigns");
    fireEvent.click(button(await screen.findByTestId("campaign-row"), "Open workspace"));

    const workspace = await screen.findByTestId("campaign-workspace");
    expect(mocked.getMarketingCampaign).toHaveBeenCalledWith("camp-1");
    const stats = within(workspace).getAllByTestId("stat-panel");
    expect(stats.map((stat) => stat.textContent)).toEqual([
      expect.stringContaining("Ideas & drafts3"),
      expect.stringContaining("Ready2"),
      expect.stringContaining("Published1"),
      expect.stringContaining("Not confirmed1"),
    ]);
    expect(within(workspace).getByText("No report has been generated for this campaign.")).toBeInTheDocument();
    expect(within(workspace).getByText("Offer")).toBeInTheDocument();
  });

  it("offers to link Meta campaigns only where there is an ad account to read", async () => {
    mocked.getMarketingStatus.mockResolvedValue(ok(STATUS({ adAccount: { available: false } })));
    mocked.listMarketingCampaigns.mockResolvedValue(ok({ campaigns: [CAMPAIGN()], count: 1, inOtherProjects: 0 }));
    mocked.getMarketingCampaign.mockResolvedValue(
      ok({ campaign: CAMPAIGN(), content: { total: 0, byStatus: { IDEA: 0, DRAFT: 0, READY: 0, PUBLISHED: 0, ARCHIVED: 0 }, upcoming: [], unconfirmed: 0 }, latestReport: null, latestResearch: [] })
    );

    render(<MarketingPage />);
    await openView("Campaigns");
    fireEvent.click(button(await screen.findByTestId("campaign-row"), "Open workspace"));
    await screen.findByTestId("campaign-workspace");

    expect(screen.queryByRole("form", { name: "Linked Meta campaigns" })).not.toBeInTheDocument();
  });

  it("links Meta campaigns as ids, and says it changes nothing in the ad account", async () => {
    mocked.listMarketingCampaigns.mockResolvedValue(ok({ campaigns: [CAMPAIGN()], count: 1, inOtherProjects: 0 }));
    mocked.getMarketingCampaign.mockResolvedValue(
      ok({ campaign: CAMPAIGN(), content: { total: 0, byStatus: { IDEA: 0, DRAFT: 0, READY: 0, PUBLISHED: 0, ARCHIVED: 0 }, upcoming: [], unconfirmed: 0 }, latestReport: null, latestResearch: [] })
    );
    mocked.updateMarketingCampaign.mockResolvedValue(ok({ campaign: CAMPAIGN({ metaCampaignIds: ["120210000000000001", "120210000000000002"] }) }));

    render(<MarketingPage />);
    await openView("Campaigns");
    fireEvent.click(button(await screen.findByTestId("campaign-row"), "Open workspace"));
    const form = await screen.findByRole("form", { name: "Linked Meta campaigns" });

    expect(screen.getByText(/It changes nothing in the ad account\./)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Meta campaign ids"), { target: { value: " 120210000000000001,  120210000000000002 " } });
    fireEvent.click(button(form, "Save"));

    await waitFor(() => expect(mocked.updateMarketingCampaign).toHaveBeenCalledWith("camp-1", { metaCampaignIds: ["120210000000000001", "120210000000000002"] }));
  });

  it("says campaigns exist in other projects rather than showing an unexplained empty list", async () => {
    mocked.listMarketingCampaigns.mockResolvedValue(ok({ campaigns: [], count: 0, inOtherProjects: 2 }));

    render(<MarketingPage />);
    await openView("Campaigns");

    expect(await screen.findByText(/2 campaigns are in other projects\./)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("Marketing screen — research", () => {
  it("where page reads are switched off, says so and draws no form", async () => {
    mocked.getMarketingStatus.mockResolvedValue(
      ok(STATUS({ research: { available: false, reason: "Reading web pages is switched off on this server. An administrator can switch it on by setting BROWSER_ENABLED=true and restarting." } }))
    );
    mocked.listMarketingResearch.mockResolvedValue(ok({ research: [RESEARCH()], count: 1 }));

    render(<MarketingPage />);
    await openView("Research");

    expect(await screen.findByTestId("research-unavailable")).toHaveTextContent("BROWSER_ENABLED=true");
    expect(screen.queryByRole("form", { name: "SEO audit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Competitor page" })).not.toBeInTheDocument();
    // What was read before is still there to be read.
    expect(await screen.findByTestId("research-row")).toHaveTextContent("kiln.example");
  });

  it("audits a page and shows where and when it was read, what was found, and what was not measured", async () => {
    mocked.runSeoAudit.mockResolvedValue(ok({ research: RESEARCH(), notice: NOTICE }));
    render(<MarketingPage />);
    await openView("Research");
    const form = await screen.findByRole("form", { name: "SEO audit" });

    fireEvent.change(within(form).getByLabelText("Page address"), { target: { value: " https://kiln.example/ " } });
    fireEvent.click(button(form, "Audit this page"));

    const detail = await screen.findByTestId("research-detail");
    expect(mocked.runSeoAudit).toHaveBeenCalledWith({ url: "https://kiln.example/" }, null);
    expect(within(detail).getByText(/from https:\/\/kiln\.example\/ · HTTP 200/)).toBeInTheDocument();
    expect(within(detail).getByText(NOTICE)).toBeInTheDocument();

    const checks = within(detail).getAllByTestId("seo-check");
    expect(checks.map((check) => check.getAttribute("data-severity"))).toEqual(["critical", "warning", "pass"]);
    expect(within(checks[0]!).getByText("Fix this")).toBeInTheDocument();
    expect(within(checks[0]!).getByText("The page has no meta description.")).toBeInTheDocument();
    expect(within(checks[0]!).getByText("Write one of 120 to 160 characters.")).toBeInTheDocument();

    expect(within(within(detail).getByTestId("not-measured")).getByText(/Search rankings and search volume are not on the page and were not measured\./)).toBeInTheDocument();
  });

  it("shows a page that could not be read as a failure, in the server's words, with no result", async () => {
    mocked.runSeoAudit.mockResolvedValue(refused("PROVIDER_FAILED", "That address is not one JARVIS is allowed to read."));
    render(<MarketingPage />);
    await openView("Research");
    const form = await screen.findByRole("form", { name: "SEO audit" });

    fireEvent.change(within(form).getByLabelText("Page address"), { target: { value: "http://10.0.0.1/" } });
    fireEvent.click(button(form, "Audit this page"));

    expect(await screen.findByText("That address is not one JARVIS is allowed to read.")).toBeInTheDocument();
    expect(screen.queryByTestId("research-detail")).not.toBeInTheDocument();
  });

  it("when the user's own page could not be read, says the comparison is missing — not that there were no differences", async () => {
    mocked.runCompetitorAnalysis.mockResolvedValue(
      ok({
        research: RESEARCH({
          kind: "COMPETITOR_SNAPSHOT",
          host: "mudhouse.example",
          headline: "your page could not be read; first read of this page",
          audit: null,
          competitor: {
            competitor: { ...FACTS, title: "Mudhouse — pottery studio" },
            own: null,
            comparedWithOwn: [],
            changesSinceLast: [],
            previousFetchedAt: null,
            ownPageError: "That address could not be reached.",
            notMeasured: ["A web page cannot show traffic, rankings, ad spend or sales."],
          },
        }),
        notice: NOTICE,
      })
    );
    render(<MarketingPage />);
    await openView("Research");
    const form = await screen.findByRole("form", { name: "Competitor page" });

    fireEvent.change(within(form).getByLabelText("Their page"), { target: { value: "https://mudhouse.example/" } });
    fireEvent.change(within(form).getByLabelText("Your page, to compare with (optional)"), { target: { value: "https://down.example/" } });
    fireEvent.click(button(form, "Read their page"));

    const detail = await screen.findByTestId("research-detail");
    expect(mocked.runCompetitorAnalysis).toHaveBeenCalledWith({ competitorUrl: "https://mudhouse.example/", ownUrl: "https://down.example/" }, null);
    expect(within(detail).getByRole("alert")).toHaveTextContent("Your own page could not be read, so there is no comparison with it: That address could not be reached.");
    expect(within(detail).queryByText("No differences in the fields compared.")).not.toBeInTheDocument();
    expect(within(detail).getByText("Mudhouse — pottery studio")).toBeInTheDocument();
    expect(within(detail).getByText(/first time this page has been read/)).toBeInTheDocument();
  });

  it("shows what changed on a competitor's page since it was last read", async () => {
    mocked.listMarketingResearch.mockResolvedValue(ok({ research: [RESEARCH({ id: "res-2", kind: "COMPETITOR_SNAPSHOT", host: "mudhouse.example", headline: "1 change since the last read" })], count: 1 }));
    mocked.getMarketingResearch.mockResolvedValue(
      ok({
        research: RESEARCH({
          id: "res-2",
          kind: "COMPETITOR_SNAPSHOT",
          host: "mudhouse.example",
          audit: null,
          competitor: {
            competitor: FACTS,
            own: null,
            comparedWithOwn: [],
            changesSinceLast: [{ field: "Title", left: "Mudhouse — pottery studio", right: "Mudhouse — Diwali gift sets", note: "changed" }],
            previousFetchedAt: "2026-10-01T09:00:00.000Z",
            ownPageError: null,
            notMeasured: [],
          },
        }),
        notice: NOTICE,
      })
    );

    render(<MarketingPage />);
    await openView("Research");
    fireEvent.click(button(await screen.findByTestId("research-row"), "Open"));

    const detail = await screen.findByTestId("research-detail");
    expect(mocked.getMarketingResearch).toHaveBeenCalledWith("res-2");
    expect(within(detail).getByText("Mudhouse — pottery studio")).toBeInTheDocument();
    expect(within(detail).getByText("Mudhouse — Diwali gift sets")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("Marketing screen — reports", () => {
  it("does not put the no-data notice on a report that has data", async () => {
    mocked.generateMarketingReport.mockResolvedValue(ok({ report: REPORT(), note: "Saved." }));
    render(<MarketingPage />);
    await openView("Reports");
    fireEvent.click(button(await screen.findByRole("form", { name: "Generate a report" }), "Generate report"));

    const document = await screen.findByTestId("report-document");
    expect(within(document).queryByTestId("report-no-sources")).not.toBeInTheDocument();
  });

  it("generates a report and shows where every figure came from", async () => {
    mocked.generateMarketingReport.mockResolvedValue(ok({ report: REPORT(), note: "Saved. Every figure is in the report's document." }));
    render(<MarketingPage />);
    await openView("Reports");

    fireEvent.click(button(await screen.findByRole("form", { name: "Generate a report" }), "Generate report"));

    const document = await screen.findByTestId("report-document");
    expect(mocked.generateMarketingReport).toHaveBeenCalledWith({ kind: "PERFORMANCE", compare: true }, null);
    const sources = within(document).getAllByTestId("report-source");
    expect(sources.map((source) => source.getAttribute("data-status"))).toEqual(["INCLUDED", "SCOPE_NOT_GRANTED"]);
    expect(within(sources[0]!).getByText("Included")).toBeInTheDocument();
    expect(within(sources[0]!).getByText("act_120••••015")).toBeInTheDocument();
    expect(within(sources[1]!).getByText("Access not granted")).toBeInTheDocument();
    expect(within(sources[1]!).getByText(/read access to Google Ads was not granted/)).toBeInTheDocument();
  });

  it("words figures as the exported file does, and a metric nobody reported as not available", async () => {
    mocked.generateMarketingReport.mockResolvedValue(ok({ report: REPORT(), note: "Saved." }));
    render(<MarketingPage />);
    await openView("Reports");
    fireEvent.click(button(await screen.findByRole("form", { name: "Generate a report" }), "Generate report"));

    const document = await screen.findByTestId("report-document");
    const totals = within(document).getByRole("table", { name: "Totals for the period" });
    const rows = within(totals).getAllByTestId("data-row");
    expect(rows[0]).toHaveTextContent(/Spend.*1,500\.00/);
    expect(rows[1]).toHaveTextContent("Clicks1,200");
    // Conversions were not reported: shown as unknown, never as 0.
    expect(rows[2]!.textContent).not.toMatch(/Conversions0$/);
    expect(rows[2]).toHaveTextContent(/Conversions(—|n\/a|not available)/i);
  });

  it("says how each published item is known, and keeps planned ones apart", async () => {
    mocked.generateMarketingReport.mockResolvedValue(ok({ report: REPORT(), note: "Saved." }));
    render(<MarketingPage />);
    await openView("Reports");
    fireEvent.click(button(await screen.findByRole("form", { name: "Generate a report" }), "Generate report"));

    const document = await screen.findByTestId("report-document");
    const published = within(document).getByRole("table", { name: "Published in this period" });
    expect(within(published).getByText("Reported as posted by you")).toBeInTheDocument();
    expect(within(published).getByText("Published by JARVIS, verified")).toBeInTheDocument();
    const planned = within(document).getByRole("table", { name: "Planned, not published" });
    expect(within(planned).getByText("Offer")).toBeInTheDocument();
    expect(within(published).queryByText("Offer")).not.toBeInTheDocument();
  });

  it("a report with no advertising data says so, and shows no figures", async () => {
    const empty = REPORT({
      totals: null,
      changes: [],
      campaigns: [],
      dataSources: [
        { provider: "meta-ads", label: "Meta Ads", status: "FAILED", detail: "The ad account could not be read. Nothing from it is in this report.", rowCount: 0, executionIds: [], account: null },
      ],
    });
    mocked.generateMarketingReport.mockResolvedValue(ok({ report: empty, note: "The report was saved, but no advertising data could be included — see its data sources for why." }));
    render(<MarketingPage />);
    await openView("Reports");
    fireEvent.click(button(await screen.findByRole("form", { name: "Generate a report" }), "Generate report"));

    const document = await screen.findByTestId("report-document");
    expect(within(document).getByTestId("report-no-data")).toHaveTextContent("No advertising data is included in this report.");
    expect(within(document).queryByRole("table", { name: "Totals for the period" })).not.toBeInTheDocument();
    expect(within(document).getByText("Could not be read")).toBeInTheDocument();
    expect(within(document).getByTestId("report-no-sources")).toHaveTextContent("No advertising data could be included in this report. The data sources below say why.");
  });

  it("says a report will cover content only where no ad account is connected", async () => {
    mocked.getMarketingStatus.mockResolvedValue(ok(STATUS({ adAccount: { available: false } })));

    render(<MarketingPage />);
    await openView("Reports");

    expect(await screen.findByText(/No ad account is connected to this server, so a report will cover this workspace's content only/)).toBeInTheDocument();
  });

  it("sends the chosen kind, campaign and dates", async () => {
    mocked.listMarketingCampaigns.mockResolvedValue(ok({ campaigns: [CAMPAIGN()], count: 1, inOtherProjects: 0 }));
    mocked.generateMarketingReport.mockResolvedValue(ok({ report: REPORT(), note: "Saved." }));
    render(<MarketingPage />);
    await openView("Reports");
    const form = await screen.findByRole("form", { name: "Generate a report" });

    fireEvent.change(within(form).getByLabelText("Report kind"), { target: { value: "CLIENT" } });
    fireEvent.change(await within(form).findByLabelText("Report campaign"), { target: { value: "camp-1" } });
    fireEvent.change(within(form).getByLabelText("From (optional)"), { target: { value: "2026-09-01" } });
    fireEvent.change(within(form).getByLabelText("To (optional)"), { target: { value: "2026-09-30" } });
    fireEvent.click(within(form).getByLabelText("Compare with the period before"));
    fireEvent.click(button(form, "Generate report"));

    await waitFor(() =>
      expect(mocked.generateMarketingReport).toHaveBeenCalledWith({ kind: "CLIENT", compare: false, campaign: "camp-1", from: "2026-09-01", to: "2026-09-30" }, null)
    );
  });

  it("downloads a report as a file, and says so plainly when it cannot", async () => {
    const createObjectURL = vi.fn(() => "blob:report");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    mocked.listMarketingReports.mockResolvedValue(ok({ reports: [REPORT()], count: 1 }));
    mocked.getMarketingReport.mockResolvedValue(ok({ report: REPORT() }));
    mocked.downloadMarketingReport.mockResolvedValueOnce({ ok: true, blob: new Blob(["<html></html>"]), fileName: "marketing-report.html" });

    render(<MarketingPage />);
    await openView("Reports");
    fireEvent.click(button(await screen.findByTestId("report-row"), "Open"));
    const document = await screen.findByTestId("report-document");
    fireEvent.click(button(document, "Download HTML"));

    await waitFor(() => expect(mocked.downloadMarketingReport).toHaveBeenCalledWith("rep-1", "html"));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
    // Named from the document on screen — a browser hides the server's header
    // from a page on another origin, so the name cannot come from there.
    expect(names).toEqual(["marketing-performance-report-2026-09-12-to-2026-10-11.html"]);

    mocked.downloadMarketingReport.mockResolvedValueOnce({ ok: false, message: "That report was not found." });
    fireEvent.click(button(document, "Download Markdown"));
    expect(await screen.findByText("That report was not found.")).toBeInTheDocument();
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("offers nothing that would send a report to anyone", async () => {
    mocked.generateMarketingReport.mockResolvedValue(ok({ report: REPORT(), note: "Saved." }));
    render(<MarketingPage />);
    await openView("Reports");
    fireEvent.click(button(await screen.findByRole("form", { name: "Generate a report" }), "Generate report"));

    const document = await screen.findByTestId("report-document");
    const names = within(document)
      .getAllByRole("button")
      .map((node) => node.textContent);
    expect(names).toEqual(["Download HTML", "Download Markdown", "Close"]);
    expect(within(document).getByText("This report states what was read. It changed nothing and was sent to no one.")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("Marketing screen — recommendations", () => {
  it("marks every one as advice that has not been carried out, with the facts it rests on", async () => {
    render(<MarketingPage />);
    await openView("Recommendations");

    const cards = await screen.findAllByTestId("recommendation");
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(within(card).getByText("Advice · not carried out")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("“Teaser” was planned for 2026-10-05 and is still ready.")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Would need your approval")).toBeInTheDocument();
    expect(within(cards[1]!).queryByText("Would need your approval")).not.toBeInTheDocument();
  });

  it("gives no way to carry one out from here", async () => {
    render(<MarketingPage />);
    await openView("Recommendations");

    for (const card of await screen.findAllByTestId("recommendation")) expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(mocked.requestMarketingPublish).not.toHaveBeenCalled();
    expect(mocked.updateMarketingContent).not.toHaveBeenCalled();
  });

  it("says what they were worked out from, and repeats that nothing was changed", async () => {
    render(<MarketingPage />);
    await openView("Recommendations");

    expect(await screen.findByTestId("recommendations-basis")).toHaveTextContent("from 4 content items, the latest saved report and 1 saved page audit.");
    expect(screen.getByText("These are recommendations based on what is in the workspace. Nothing was changed, published or sent by producing them.")).toBeInTheDocument();
  });

  it("says there is nothing to recommend rather than filling the space", async () => {
    mocked.getMarketingRecommendations.mockResolvedValue(
      ok({ ...RECOMMENDATIONS(), recommendations: [], count: 0, basis: { campaign: null, contentItems: 0, hasReport: false, seoAudits: 0 } })
    );

    render(<MarketingPage />);
    await openView("Recommendations");

    expect(await screen.findByText("Nothing to recommend")).toBeInTheDocument();
    expect(screen.getByTestId("recommendations-basis")).toHaveTextContent("from 0 content items, no saved report and 0 saved page audits.");
  });
});
