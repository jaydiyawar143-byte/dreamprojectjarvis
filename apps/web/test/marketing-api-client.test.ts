// Phase 15 — what the browser actually sends for the marketing workspace.
// The real client functions, over a recorded fetch.
//
// Two things are pinned harder than the rest, because they are what the screen
// must not be able to do: send the TEXT of a post (the server reads it from the
// saved item), or mark something published by editing it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkMarketingPublish,
  clearTokens,
  createMarketingCampaign,
  downloadMarketingReport,
  executeMarketingPublish,
  generateMarketingReport,
  getMarketingCalendar,
  getMarketingCampaign,
  getMarketingContent,
  getMarketingRecommendations,
  getMarketingReport,
  getMarketingResearch,
  getMarketingStatus,
  listMarketingCampaigns,
  listMarketingReports,
  listMarketingResearch,
  markMarketingContentPublished,
  planMarketingContent,
  requestMarketingPublish,
  resolveUnconfirmedPublish,
  runCompetitorAnalysis,
  runSeoAudit,
  setAccessToken,
  updateMarketingCampaign,
  updateMarketingContent,
} from "../src/lib/api";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const json = (body: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body), headers: new Headers() });

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(json({ success: true, data: {}, timestamp: new Date().toISOString() }));
  clearTokens();
});

const lastCall = () => {
  const [url, init] = mockFetch.mock.calls.at(-1)! as [string, RequestInit | undefined];
  const [path, query] = url.replace(/^.*\/api\/v1/, "").split("?");
  return {
    path,
    query: Object.fromEntries(new URLSearchParams(query ?? "")),
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
};

describe("marketing client — reading", () => {
  it("asks what this server and this role can do", async () => {
    await getMarketingStatus();
    expect(lastCall()).toEqual({ path: "/marketing/status", query: {}, method: "GET", body: undefined });
  });

  it("lists campaigns, sending a project only when one is chosen", async () => {
    await listMarketingCampaigns();
    expect(lastCall()).toMatchObject({ path: "/marketing/campaigns", query: {} });

    await listMarketingCampaigns({ projectId: null });
    expect(lastCall().query).toEqual({});

    await listMarketingCampaigns({ projectId: "proj_1", includeArchived: true });
    expect(lastCall().query).toEqual({ projectId: "proj_1", includeArchived: "true" });
  });

  it("opens a campaign workspace by its id, encoded", async () => {
    await getMarketingCampaign("camp 1/x");
    expect(lastCall()).toMatchObject({ path: "/marketing/campaigns/camp%201%2Fx", method: "GET" });
  });

  it("reads the calendar with only the filters that were set", async () => {
    await getMarketingCalendar();
    expect(lastCall()).toMatchObject({ path: "/marketing/content", query: {} });

    await getMarketingCalendar({ from: "2026-11-01", to: "2026-11-30", campaign: "camp_1", projectId: "proj_1", limit: 100, status: "", channel: undefined });
    expect(lastCall().query).toEqual({ from: "2026-11-01", to: "2026-11-30", campaign: "camp_1", projectId: "proj_1", limit: "100" });
  });

  it("reads one item whole, by id", async () => {
    await getMarketingContent("item_1");
    expect(lastCall()).toMatchObject({ path: "/marketing/content/item_1", method: "GET" });
  });

  it("lists and opens research and reports, and asks for recommendations", async () => {
    await listMarketingResearch({ kind: "SEO_AUDIT", projectId: "proj_1" });
    expect(lastCall()).toMatchObject({ path: "/marketing/research", query: { kind: "SEO_AUDIT", projectId: "proj_1" } });
    await getMarketingResearch("res_1");
    expect(lastCall().path).toBe("/marketing/research/res_1");
    await listMarketingReports({ campaign: "camp_1" });
    expect(lastCall()).toMatchObject({ path: "/marketing/reports", query: { campaign: "camp_1" } });
    await getMarketingReport("rep_1");
    expect(lastCall().path).toBe("/marketing/reports/rep_1");
    await getMarketingRecommendations({ projectId: "proj_1", campaign: "camp_1" });
    expect(lastCall()).toMatchObject({ path: "/marketing/recommendations", method: "GET", query: { projectId: "proj_1", campaign: "camp_1" } });
  });
});

describe("marketing client — saving to JARVIS's own store", () => {
  it("creates a campaign workspace in the chosen project", async () => {
    await createMarketingCampaign({ name: "Diwali Sale", objective: "Leads", startDate: "2026-11-01" }, "proj_1");
    expect(lastCall()).toEqual({
      path: "/marketing/campaigns",
      query: { projectId: "proj_1" },
      method: "POST",
      body: { name: "Diwali Sale", objective: "Leads", startDate: "2026-11-01" },
    });
  });

  it("changes a campaign workspace with a PATCH of only what changed", async () => {
    await updateMarketingCampaign("camp_1", { status: "ACTIVE" });
    expect(lastCall()).toEqual({ path: "/marketing/campaigns/camp_1", query: {}, method: "PATCH", body: { status: "ACTIVE" } });
  });

  it("saves drafts to the calendar", async () => {
    await planMarketingContent({ campaign: "camp_1", items: [{ title: "Teaser", channel: "FACEBOOK", body: "Soon." }] }, null);
    expect(lastCall()).toEqual({
      path: "/marketing/content",
      query: {},
      method: "POST",
      body: { campaign: "camp_1", items: [{ title: "Teaser", channel: "FACEBOOK", body: "Soon." }] },
    });
  });

  it("edits a draft with a PATCH", async () => {
    await updateMarketingContent("item_1", { body: "New words", scheduledDate: "2026-11-05", status: "READY" });
    expect(lastCall()).toEqual({
      path: "/marketing/content/item_1",
      query: {},
      method: "PATCH",
      body: { body: "New words", scheduledDate: "2026-11-05", status: "READY" },
    });
  });

  it("records a post the user made themselves, on its own endpoint", async () => {
    await markMarketingContentPublished("item_1", { url: "https://example.com/p/1" });
    expect(lastCall()).toEqual({ path: "/marketing/content/item_1/mark-published", query: {}, method: "POST", body: { url: "https://example.com/p/1" } });

    await markMarketingContentPublished("item_1");
    expect(lastCall().body).toEqual({});
  });
});

describe("marketing client — research and reports", () => {
  it("asks for an SEO audit of one address", async () => {
    await runSeoAudit({ url: "https://example.com/", campaign: "camp_1" }, "proj_1");
    expect(lastCall()).toEqual({
      path: "/marketing/research/seo-audit",
      query: { projectId: "proj_1" },
      method: "POST",
      body: { url: "https://example.com/", campaign: "camp_1" },
    });
  });

  it("asks for a competitor's page, with the user's own page when given", async () => {
    await runCompetitorAnalysis({ competitorUrl: "https://rival.example/", ownUrl: "https://example.com/" });
    expect(lastCall()).toEqual({
      path: "/marketing/research/competitor",
      query: {},
      method: "POST",
      body: { competitorUrl: "https://rival.example/", ownUrl: "https://example.com/" },
    });
  });

  it("asks for a report by kind and period — and sends no figures of its own", async () => {
    await generateMarketingReport({ kind: "CLIENT", campaign: "camp_1", from: "2026-09-01", to: "2026-09-30", compare: false }, "proj_1");
    const call = lastCall();
    expect(call).toMatchObject({ path: "/marketing/reports", query: { projectId: "proj_1" }, method: "POST" });
    expect(call.body).toEqual({ kind: "CLIENT", campaign: "camp_1", from: "2026-09-01", to: "2026-09-30", compare: false });
  });
});

describe("marketing client — publishing is asked for, decided, then run", () => {
  it("the publish check is a GET: it changes nothing", async () => {
    await checkMarketingPublish("item_1", "1234567890");
    expect(lastCall()).toEqual({ path: "/marketing/content/item_1/publish", query: { targetId: "1234567890" }, method: "GET", body: undefined });
  });

  it("asking sends the item and, at most, which place — never the text", async () => {
    await requestMarketingPublish("item_1");
    expect(lastCall()).toEqual({ path: "/marketing/content/item_1/publish", query: {}, method: "POST", body: {} });

    await requestMarketingPublish("item_1", "1234567890");
    expect(lastCall().body).toEqual({ targetId: "1234567890" });
  });

  it("publishing sends the approval's id and nothing else", async () => {
    await executeMarketingPublish("item_1", "appr_1");
    expect(lastCall()).toEqual({ path: "/marketing/content/item_1/publish", query: {}, method: "POST", body: { approvalId: "appr_1" } });
  });

  it("settling an unconfirmed publish sends the one decision there is, for the item in the path", async () => {
    await resolveUnconfirmedPublish("item_1");
    expect(lastCall()).toEqual({ path: "/marketing/content/item_1/publish/resolve", query: {}, method: "POST", body: { decision: "NOT_PUBLISHED" } });
    // One parameter: which item. A caller cannot choose another decision, a Page or any words.
    expect(resolveUnconfirmedPublish.length).toBe(1);
  });

  it("hands back what the server found when it settled it", async () => {
    mockFetch.mockResolvedValue(json({ success: true, data: { resolution: "FOUND_PUBLISHED", message: "The post IS on Shop Page.", item: { id: "item_1" } }, timestamp: "t" }));

    const reply = await resolveUnconfirmedPublish("item_1");

    expect(reply.data).toMatchObject({ resolution: "FOUND_PUBLISHED", message: "The post IS on Shop Page." });
  });

  it("no publish call can carry words: neither function has a parameter for them", async () => {
    await requestMarketingPublish("item_1", "1234567890");
    await executeMarketingPublish("item_1", "appr_1");
    for (const [, init] of mockFetch.mock.calls as Array<[string, RequestInit]>) {
      const keys = Object.keys(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
      for (const key of keys) expect(["targetId", "approvalId"]).toContain(key);
    }
    expect(requestMarketingPublish.length).toBeLessThanOrEqual(2);
    expect(executeMarketingPublish.length).toBe(2);
  });

  it("nothing in this client deletes: every call is GET, POST or PATCH", async () => {
    await getMarketingStatus();
    await updateMarketingContent("item_1", { status: "ARCHIVED" });
    await markMarketingContentPublished("item_1");
    await executeMarketingPublish("item_1", "appr_1");
    const methods = new Set((mockFetch.mock.calls as Array<[string, RequestInit | undefined]>).map(([, init]) => init?.method ?? "GET"));
    expect([...methods].sort()).toEqual(["GET", "PATCH", "POST"]);
  });

  it("hands back the server's refusal as it is, with what was not published", async () => {
    mockFetch.mockResolvedValue(
      json({ success: false, error: { code: "UNCONFIRMED", message: "It is not known whether the post went out.", published: false }, timestamp: "t" }, 502)
    );

    const reply = await executeMarketingPublish("item_1", "appr_1");

    expect(reply.success).toBe(false);
    expect(reply.error).toMatchObject({ code: "UNCONFIRMED", published: false });
  });
});

describe("marketing client — downloading a report", () => {
  const file = (text: string, name: string) => ({
    status: 200,
    ok: true,
    headers: new Headers({ "content-disposition": `attachment; filename="${name}"` }),
    blob: () => Promise.resolve(new Blob([text], { type: "text/html" })),
    json: () => Promise.reject(new Error("not json")),
  });

  it("fetches the export with the access token in a header, never in the address", async () => {
    setAccessToken("access-token-p15");
    mockFetch.mockResolvedValue(file("<html></html>", "marketing-report-2026-09-30.html"));

    const result = await downloadMarketingReport("rep_1", "html");

    const [url, init] = mockFetch.mock.calls.at(-1)! as [string, RequestInit];
    expect(url).toMatch(/\/marketing\/reports\/rep_1\/export\?format=html$/);
    expect(url).not.toContain("access-token-p15");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token-p15");
    expect(result).toMatchObject({ ok: true, fileName: "marketing-report-2026-09-30.html" });
  });

  it("asks for Markdown when asked", async () => {
    mockFetch.mockResolvedValue(file("# Report", "marketing-report.md"));

    const result = await downloadMarketingReport("rep_1", "md");

    expect((mockFetch.mock.calls.at(-1)![0] as string).endsWith("format=md")).toBe(true);
    expect(result).toMatchObject({ ok: true, fileName: "marketing-report.md" });
  });

  it("falls back to a plain name when the server's is not a safe file name", async () => {
    mockFetch.mockResolvedValue({ ...file("x", "x"), headers: new Headers({ "content-disposition": 'attachment; filename="../../evil name.html"' }) });

    const result = await downloadMarketingReport("rep_1", "html");

    expect(result).toMatchObject({ ok: true, fileName: "report.html" });
  });

  it("reports a refusal in the server's words, and hands over no file", async () => {
    mockFetch.mockResolvedValue(json({ success: false, error: { code: "NOT_FOUND", message: "That report was not found." }, timestamp: "t" }, 404));

    expect(await downloadMarketingReport("rep_other", "html")).toEqual({ ok: false, message: "That report was not found." });
  });

  it("reports a failed request without inventing a reason", async () => {
    mockFetch.mockRejectedValue(new Error("socket hang up"));

    expect(await downloadMarketingReport("rep_1", "html")).toEqual({ ok: false, message: "The report could not be downloaded." });
  });
});
