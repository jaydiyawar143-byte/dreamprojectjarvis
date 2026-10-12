// ---------------------------------------------------------------------------
// Phase 15 — the Marketing page's router.
//
// The real router, mounted on a real Express app on an ephemeral port and
// driven over HTTP. Its two collaborators are stand-ins that record what they
// were asked: the executor (so this proves WHICH tool each endpoint runs, with
// WHICH parameters, as WHOM) and the publish flow.
//
// THE CLAIM THIS FILE EXISTS TO PIN. The router implements nothing: every
// endpoint is one tool call through the executor, the same tool the marketing
// agent proposes in chat. If a handler ever grew logic of its own — a second
// validation, a direct repository read, a publish that skips the flow — the
// table below is where it would show.
//
// What a client can and cannot influence is the other half: the caller is the
// verified token and nothing else, and a body's unknown keys never reach a
// tool.
// ---------------------------------------------------------------------------

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MARKETING_TOOL_IDS,
  buildMarketingReport,
  type ITokenService,
  type ITool,
  type MarketingReportView,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolPermission,
} from "@jarvis/core";
import { PermissionService } from "@jarvis/security";
import { createMarketingRouter } from "../src/routes/marketing.js";
import type { MarketingPublishFlow, PublishCaller, PublishFlowResult } from "../src/services/marketing/publish-flow.js";

const T = MARKETING_TOOL_IDS;

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

const TOKENS: Record<string, { userId: string; role: string; email: string }> = {
  "token-owner": { userId: "user-owner", role: "owner", email: "owner@test.local" },
  "token-member": { userId: "user-member", role: "member", email: "member@test.local" },
  "token-viewer": { userId: "user-viewer", role: "viewer", email: "viewer@test.local" },
};

const tokenService = { verifyAccessToken: (token: string) => TOKENS[token] ?? null } as unknown as ITokenService;

const completed = (data: unknown): ToolExecutionResult => ({
  executionId: "exec-1",
  toolId: "x",
  status: "completed",
  result: { success: true, data },
  startedAt: new Date(),
});

/** A refusal from the marketing service, as the tool reports it. */
const refused = (code: string, message: string): ToolExecutionResult => ({
  executionId: "exec-1",
  toolId: "x",
  status: "failed",
  error: message,
  result: { success: false, error: message, metadata: { code } },
  startedAt: new Date(),
});

let executed: ToolExecutionRequest[];
let nextResult: ToolExecutionResult;
const executor = {
  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    executed.push(request);
    return nextResult;
  },
};

let registeredTools: Set<string>;
/** What each registered tool asks of a role — the real tools' own requirements. */
const REQUIRES: Record<string, ToolPermission[]> = {
  [MARKETING_TOOL_IDS.contentUpdate]: ["read", "write"],
  [MARKETING_TOOL_IDS.contentPublish]: ["read", "write"],
  [MARKETING_TOOL_IDS.seoAudit]: ["read"],
};
const toolRegistry = {
  get: (toolId: string) => (registeredTools.has(toolId) ? ({ id: toolId, requiredPermissions: REQUIRES[toolId] ?? ["read"] } as ITool) : undefined),
};

let researchAvailable: boolean;
const marketing = {
  researchAvailable: () => researchAvailable,
  publishableChannels: () => ["FACEBOOK" as const],
};

let flowCalls: Array<{ method: "request" | "execute"; caller: PublishCaller; contentId: string; arg: string | undefined }>;
let flowResult: PublishFlowResult;
const publishFlow = {
  async request(caller: PublishCaller, contentId: string, targetId?: string) {
    flowCalls.push({ method: "request", caller, contentId, arg: targetId });
    return flowResult;
  },
  async execute(caller: PublishCaller, contentId: string, approvalId: string) {
    flowCalls.push({ method: "execute", caller, contentId, arg: approvalId });
    return flowResult;
  },
} as unknown as MarketingPublishFlow;

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

let server: Server;
let base: string;

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  body: { success?: boolean; data?: any; error?: { code: string; message: string; [key: string]: unknown } };
}

async function call(method: string, path: string, options: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const token = options.token === undefined ? "token-member" : options.token;
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body: Reply["body"] = {};
  try {
    body = JSON.parse(text) as Reply["body"];
  } catch {
    // Not JSON: an exported file.
  }
  return { status: response.status, headers: response.headers, text, body };
}

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use("/marketing", createMarketingRouter({ tokenService, executor, toolRegistry, marketing, publishFlow, permissions: new PermissionService() }));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/marketing`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  executed = [];
  nextResult = completed({ ok: true });
  registeredTools = new Set<string>(Object.values(T));
  researchAvailable = true;
  flowCalls = [];
  flowResult = { status: "UNAVAILABLE", message: "unset" };
});

// ---------------------------------------------------------------------------
// One endpoint, one tool
// ---------------------------------------------------------------------------

interface Row {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  tool: string;
  params: Record<string, unknown>;
  status: number;
}

const ROWS: Row[] = [
  { name: "list campaigns", method: "GET", path: "/campaigns", tool: T.campaignList, params: { includeArchived: false }, status: 200 },
  { name: "list campaigns, archived too", method: "GET", path: "/campaigns?includeArchived=true", tool: T.campaignList, params: { includeArchived: true }, status: 200 },
  {
    name: "create a campaign",
    method: "POST",
    path: "/campaigns",
    body: { name: "Diwali", objective: "Leads", channels: ["FACEBOOK"], startDate: "2026-11-01", endDate: "2026-11-12" },
    tool: T.campaignCreate,
    params: { name: "Diwali", objective: "Leads", channels: ["FACEBOOK"], startDate: "2026-11-01", endDate: "2026-11-12" },
    status: 201,
  },
  { name: "open a campaign workspace", method: "GET", path: "/campaigns/camp_1", tool: T.campaignGet, params: { campaign: "camp_1" }, status: 200 },
  {
    name: "update a campaign",
    method: "PATCH",
    path: "/campaigns/camp_1",
    body: { status: "ACTIVE", metaCampaignIds: ["120210000000000001"] },
    tool: T.campaignUpdate,
    params: { campaign: "camp_1", status: "ACTIVE", metaCampaignIds: ["120210000000000001"] },
    status: 200,
  },
  { name: "the calendar, default window", method: "GET", path: "/content", tool: T.contentList, params: { limit: 100 }, status: 200 },
  {
    name: "the calendar, filtered",
    method: "GET",
    path: "/content?campaign=camp_1&from=2026-11-01&to=2026-11-30&status=READY&channel=facebook&limit=20",
    tool: T.contentList,
    params: { campaign: "camp_1", from: "2026-11-01", to: "2026-11-30", status: "READY", channel: "facebook", limit: 20 },
    status: 200,
  },
  {
    name: "plan content",
    method: "POST",
    path: "/content",
    body: { campaign: " camp_1 ", items: [{ title: "Teaser", channel: "FACEBOOK", body: "Soon." }] },
    tool: T.contentPlan,
    params: { campaign: "camp_1", items: [{ title: "Teaser", channel: "FACEBOOK", body: "Soon." }] },
    status: 201,
  },
  { name: "one content item", method: "GET", path: "/content/item_1", tool: T.contentList, params: { contentId: "item_1" }, status: 200 },
  {
    name: "edit a content item",
    method: "PATCH",
    path: "/content/item_1",
    body: { body: "New text", scheduledDate: "2026-11-05", scheduledTime: "09:30", status: "READY" },
    tool: T.contentUpdate,
    params: { contentId: "item_1", body: "New text", scheduledDate: "2026-11-05", scheduledTime: "09:30", status: "READY" },
    status: 200,
  },
  {
    name: "record that I published it myself",
    method: "POST",
    path: "/content/item_1/mark-published",
    body: { url: "https://example.com/p/1", publishedOn: "2026-10-10" },
    tool: T.contentMarkPublished,
    params: { contentId: "item_1", url: "https://example.com/p/1", publishedOn: "2026-10-10" },
    status: 200,
  },
  { name: "the publish check", method: "GET", path: "/content/item_1/publish", tool: T.publishPrepare, params: { contentId: "item_1" }, status: 200 },
  { name: "the publish check for one Page", method: "GET", path: "/content/item_1/publish?targetId=1234567890", tool: T.publishPrepare, params: { contentId: "item_1", targetId: "1234567890" }, status: 200 },
  { name: "list research", method: "GET", path: "/research?kind=SEO_AUDIT&campaign=camp_1", tool: T.researchList, params: { kind: "SEO_AUDIT", campaign: "camp_1" }, status: 200 },
  { name: "one research result", method: "GET", path: "/research/res_1", tool: T.researchList, params: { researchId: "res_1" }, status: 200 },
  {
    name: "run an SEO audit",
    method: "POST",
    path: "/research/seo-audit",
    body: { url: "https://example.com/", campaign: "camp_1" },
    tool: T.seoAudit,
    params: { url: "https://example.com/", campaign: "camp_1" },
    status: 201,
  },
  {
    name: "compare a competitor's page",
    method: "POST",
    path: "/research/competitor",
    body: { competitorUrl: "https://rival.example/", ownUrl: "https://example.com/" },
    tool: T.competitorAnalyze,
    params: { competitorUrl: "https://rival.example/", ownUrl: "https://example.com/" },
    status: 201,
  },
  { name: "list reports", method: "GET", path: "/reports?campaign=camp_1", tool: T.reportList, params: { campaign: "camp_1" }, status: 200 },
  {
    name: "generate a report",
    method: "POST",
    path: "/reports",
    body: { kind: "CLIENT", campaign: "camp_1", from: "2026-09-01", to: "2026-09-30", title: "September", compare: false },
    tool: T.reportGenerate,
    params: { kind: "CLIENT", campaign: "camp_1", from: "2026-09-01", to: "2026-09-30", title: "September", compare: false },
    status: 201,
  },
  { name: "one report", method: "GET", path: "/reports/rep_1", tool: T.reportGet, params: { reportId: "rep_1" }, status: 200 },
  { name: "recommendations", method: "GET", path: "/recommendations?campaign=camp_1", tool: T.recommendations, params: { campaign: "camp_1" }, status: 200 },
];

describe("Phase 15 routes — each endpoint is one tool call through the executor", () => {
  it.each(ROWS)("$name → $tool", async (row) => {
    const reply = await call(row.method, row.path, { body: row.body });

    expect(reply.status).toBe(row.status);
    expect(reply.body.success).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.toolId).toBe(row.tool);
    expect(executed[0]!.params).toEqual(row.params);
  });

  it("covers every marketing tool except the one that publishes", () => {
    // The publish tool is reached only through the publish flow, which names
    // an approval. No endpoint hands it to the executor directly.
    const reached = new Set(ROWS.map((row) => row.tool));
    const expected = Object.values(T).filter((id) => id !== T.contentPublish);

    expect([...reached].sort()).toEqual([...expected].sort());
  });

  it("returns the tool's data as the envelope's data, unchanged", async () => {
    nextResult = completed({ campaigns: [{ id: "camp_1", name: "Diwali" }], inOtherProjects: 2 });

    const reply = await call("GET", "/campaigns");

    expect(reply.body.data).toEqual({ campaigns: [{ id: "camp_1", name: "Diwali" }], inOtherProjects: 2 });
  });
});

// ---------------------------------------------------------------------------
// Who the caller is
// ---------------------------------------------------------------------------

describe("Phase 15 routes — the caller is the token and nothing else", () => {
  const EVERY_ENDPOINT: Array<[string, string]> = [
    ["GET", "/status"],
    ...ROWS.map((row): [string, string] => [row.method, row.path]),
    ["POST", "/content/item_1/publish"],
    ["GET", "/reports/rep_1/export"],
  ];

  it.each(EVERY_ENDPOINT)("%s %s is refused without a token, and runs nothing", async (method, path) => {
    const reply = await call(method, path, { token: null, ...(method === "GET" ? {} : { body: {} }) });

    expect(reply.status).toBe(401);
    expect(reply.body.error?.code).toBe("AUTHENTICATION_REQUIRED");
    expect(executed).toHaveLength(0);
    expect(flowCalls).toHaveLength(0);
  });

  it("is refused with a token nobody issued", async () => {
    const reply = await call("GET", "/campaigns", { token: "token-forged" });

    expect(reply.status).toBe(401);
    expect(executed).toHaveLength(0);
  });

  it("runs the tool as the token's user and role", async () => {
    await call("GET", "/campaigns", { token: "token-viewer" });

    expect(executed[0]).toMatchObject({ userId: "user-viewer", role: "viewer" });
  });

  it("ignores a user id and a role sent in the body", async () => {
    await call("POST", "/campaigns", { token: "token-member", body: { name: "Mine", userId: "user-owner", role: "owner" } });

    expect(executed[0]).toMatchObject({ userId: "user-member", role: "member" });
    expect(executed[0]!.params).toEqual({ name: "Mine" });
  });

  it("ignores a user id and a role sent in the query", async () => {
    await call("GET", "/campaigns?userId=user-owner&role=owner", { token: "token-member" });

    expect(executed[0]).toMatchObject({ userId: "user-member", role: "member" });
    expect(executed[0]!.params).toEqual({ includeArchived: false });
  });

  it("never passes a conversation or an agent, so the call cannot borrow a conversation's scope", async () => {
    await call("POST", "/campaigns", { body: { name: "Mine", conversationId: "conv-of-someone", agentId: "marketing-agent" } });

    expect(executed[0]!.conversationId).toBeUndefined();
    expect(executed[0]!.agentId).toBeUndefined();
    expect(executed[0]!.params).toEqual({ name: "Mine" });
  });

  it("never passes an approval id to a tool it runs directly", async () => {
    await call("PATCH", "/content/item_1", { body: { body: "x", approvalId: "appr_1" } });

    expect(executed[0]!.approvalId).toBeUndefined();
    expect(executed[0]!.params).toEqual({ contentId: "item_1", body: "x" });
  });

  it("uses the caller's trace id when one is sent, and makes one otherwise", async () => {
    await call("GET", "/campaigns", { headers: { "x-trace-id": "trace-from-client" } });
    await call("GET", "/campaigns");

    expect(executed[0]!.traceId).toBe("trace-from-client");
    expect(executed[1]!.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ---------------------------------------------------------------------------
// What a body can carry
// ---------------------------------------------------------------------------

describe("Phase 15 routes — only the named fields of a body reach a tool", () => {
  it("drops the fields that record a publication from a content edit", async () => {
    await call("PATCH", "/content/item_1", {
      body: {
        title: "Kept",
        // Each of these would be a way to assert a publish that never happened.
        publication: { mode: "VERIFIED", externalId: "1_2" },
        publicationMode: "VERIFIED",
        publishedAt: "2026-10-01T00:00:00.000Z",
        externalId: "1_2",
        publishState: "NONE",
        verifiedAt: "2026-10-01T00:00:00.000Z",
        id: "item_2",
        userId: "user-owner",
      },
    });

    expect(executed[0]!.params).toEqual({ contentId: "item_1", title: "Kept" });
  });

  it("takes the item's id from the path, never from the body", async () => {
    await call("PATCH", "/content/item_1", { body: { contentId: "item_999", title: "Kept" } });

    expect(executed[0]!.params).toEqual({ contentId: "item_1", title: "Kept" });
  });

  it("takes the campaign's id from the path, never from the body", async () => {
    await call("PATCH", "/campaigns/camp_1", { body: { campaign: "camp_999", id: "camp_999", name: "Renamed" } });

    expect(executed[0]!.params).toEqual({ campaign: "camp_1", name: "Renamed" });
  });

  it("drops everything but the address and the date from a self-reported publish", async () => {
    await call("POST", "/content/item_1/mark-published", { body: { url: "https://example.com/p/1", externalId: "1_2", mode: "VERIFIED", provider: "meta-graph" } });

    expect(executed[0]!.params).toEqual({ contentId: "item_1", url: "https://example.com/p/1" });
  });

  it("drops a document a client tries to supply for a report", async () => {
    await call("POST", "/reports", { body: { kind: "CLIENT", document: { totals: { spend: 1 } }, metrics: { spend: 999 }, sourcesIncluded: 5 } });

    expect(executed[0]!.params).toEqual({ kind: "CLIENT" });
  });

  it("drops audit findings a client tries to supply for research", async () => {
    await call("POST", "/research/seo-audit", { body: { url: "https://example.com/", audit: { score: 100 }, html: "<title>x</title>" } });

    expect(executed[0]!.params).toEqual({ url: "https://example.com/" });
  });

  it("treats a body that is a list as an empty one", async () => {
    await call("POST", "/campaigns", { body: [{ name: "Smuggled" }] });

    // The tool is still the one that refuses it: validation is not done here.
    expect(executed).toHaveLength(1);
    expect(executed[0]!.params).toEqual({});
  });

  it.each([
    ["a bare string", JSON.stringify("just a string")],
    ["null", "null"],
    ["not JSON at all", "{name: Diwali"],
  ])("never reaches a tool with a body that is %s", async (_label, body) => {
    // The application's JSON parser refuses these before any router runs.
    const reply = await call("POST", "/campaigns", { body });

    expect(reply.status).toBe(400);
    expect(executed).toHaveLength(0);
  });

  it("passes the selected project from the query", async () => {
    await call("GET", "/campaigns?projectId=proj_1");

    expect(executed[0]!.params).toEqual({ includeArchived: false, projectId: "proj_1" });
  });

  it("passes the selected project from the body", async () => {
    await call("POST", "/campaigns", { body: { name: "Mine", projectId: " proj_1 " } });

    expect(executed[0]!.params).toEqual({ name: "Mine", projectId: "proj_1" });
  });

  it("does not turn a repeated query value into a value", async () => {
    await call("GET", "/content?status=READY&status=DRAFT&campaign[x]=1");

    // An array and an object are not a single value, so neither is passed.
    expect(executed[0]!.params).toEqual({ limit: 100 });
  });

  it("falls back to the default page size for a limit that is not a whole number", async () => {
    await call("GET", "/content?limit=abc");
    await call("GET", "/content?limit=2.5");

    expect(executed[0]!.params).toEqual({ limit: 100 });
    expect(executed[1]!.params).toEqual({ limit: 100 });
  });
});

// ---------------------------------------------------------------------------
// Ids in a path
// ---------------------------------------------------------------------------

describe("Phase 15 routes — an id that could not be one is a 404 and runs nothing", () => {
  const LONG = "a".repeat(65);

  it.each([
    ["GET", `/campaigns/${LONG}`],
    ["PATCH", `/campaigns/${LONG}`],
    ["GET", "/campaigns/has%20space"],
    ["GET", "/content/semi%3Bcolon"],
    ["PATCH", "/content/dot.dot"],
    ["POST", "/content/quote%27/mark-published"],
    ["GET", "/content/a%2Fb/publish"],
    ["POST", `/content/${LONG}/publish`],
    ["GET", "/research/%3Cscript%3E"],
    ["GET", `/reports/${LONG}`],
    ["GET", "/reports/dot.dot/export"],
  ])("%s %s", async (method, path) => {
    const reply = await call(method, path, method === "GET" ? {} : { body: {} });

    expect(reply.status).toBe(404);
    expect(reply.body.error?.code).toBe("NOT_FOUND");
    expect(executed).toHaveLength(0);
    expect(flowCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// How an outcome maps onto HTTP
// ---------------------------------------------------------------------------

describe("Phase 15 routes — a refusal keeps its meaning on the way out", () => {
  it.each([
    ["NOT_FOUND", 404],
    ["INVALID", 400],
    ["LIMIT", 409],
    ["CONFLICT", 409],
    ["OUT_OF_SCOPE", 403],
    ["UNAVAILABLE", 503],
    ["PROVIDER_FAILED", 502],
    ["RATE_LIMITED", 429],
  ])("the service's %s becomes HTTP %i with the service's own sentence", async (code, status) => {
    nextResult = refused(code, `A sentence about ${code}.`);

    const reply = await call("GET", "/campaigns");

    expect(reply.status).toBe(status);
    expect(reply.body.success).toBe(false);
    expect(reply.body.error).toMatchObject({ code, message: `A sentence about ${code}.` });
  });

  it("a failure with no code is a 500, never a success", async () => {
    nextResult = { executionId: "e", toolId: "x", status: "failed", error: "boom", startedAt: new Date() };

    const reply = await call("GET", "/campaigns");

    expect(reply.status).toBe(500);
    expect(reply.body.success).toBe(false);
    expect(reply.body.error?.code).toBe("FAILED");
  });

  it("a role the executor refuses is a 403", async () => {
    nextResult = { executionId: "e", toolId: "x", status: "permission_denied", error: "Insufficient permissions", startedAt: new Date() };

    const reply = await call("POST", "/campaigns", { token: "token-viewer", body: { name: "x" } });

    expect(reply.status).toBe(403);
    expect(reply.body.error?.code).toBe("FORBIDDEN");
  });

  it("a deadline is a 504", async () => {
    nextResult = { executionId: "e", toolId: "x", status: "timed_out", error: "Execution timed out", startedAt: new Date() };

    expect((await call("POST", "/reports", { body: {} })).status).toBe(504);
  });

  it("a tool this server did not register is a 503, not a 404 about the user's data", async () => {
    nextResult = { executionId: "e", toolId: "x", status: "failed", error: "Tool not found", startedAt: new Date() };

    const reply = await call("POST", "/research/seo-audit", { body: { url: "https://example.com/" } });

    expect(reply.status).toBe(503);
    expect(reply.body.error?.code).toBe("UNAVAILABLE");
  });

  it("parameters the tool's schema rejects are a 400", async () => {
    nextResult = { executionId: "e", toolId: "x", status: "failed", error: "Invalid input parameters", startedAt: new Date() };

    const reply = await call("POST", "/content", { body: { items: "not-a-list" } });

    expect(reply.status).toBe(400);
    expect(reply.body.error?.code).toBe("INVALID");
  });

  it.each(["approval_pending", "approval_required", "approval_denied"] as const)(
    "a tool that answers %s is a refusal — never data, and never run around",
    async (status) => {
      nextResult = { executionId: "e", toolId: "x", status, approvalId: "appr_1", startedAt: new Date() };

      const reply = await call("PATCH", "/content/item_1", { body: { title: "x" } });

      expect(reply.status).toBe(409);
      expect(reply.body.success).toBe(false);
      expect(reply.body.error?.code).toBe("APPROVAL_REQUIRED");
      expect(executed).toHaveLength(1);
    }
  );

  it("a completed run whose tool reported failure is not a 200", async () => {
    nextResult = { executionId: "e", toolId: "x", status: "completed", result: { success: false, error: "No.", metadata: { code: "CONFLICT" } }, startedAt: new Date() };

    const reply = await call("PATCH", "/content/item_1", { body: { title: "x" } });

    expect(reply.status).toBe(409);
    expect(reply.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

const PARAMS = { contentId: "item_1", targetId: "1234567890", targetName: "Test Page", message: "Hello." };
const ASK: PublishFlowResult = {
  status: "APPROVAL_REQUIRED",
  ask: "REQUESTED",
  approvalId: "appr_1",
  expiresAt: "2026-10-12T10:10:00.000Z",
  params: PARAMS,
  summary: { actionSummary: "Publish this post publicly to Test Page. JARVIS cannot undo it.", detailLines: [] },
};

describe("Phase 15 routes — publishing goes through the flow, and only the flow", () => {
  it("asks the flow to request a publish, as the token's user", async () => {
    flowResult = ASK;

    await call("POST", "/content/item_1/publish", { token: "token-owner", body: {} });

    expect(flowCalls).toHaveLength(1);
    expect(flowCalls[0]).toMatchObject({ method: "request", contentId: "item_1", arg: undefined });
    expect(flowCalls[0]!.caller).toMatchObject({ userId: "user-owner", role: "owner" });
    // The publish tool is never handed to the executor from here.
    expect(executed).toHaveLength(0);
  });

  it("answers 202 with published:false while an approval is waiting", async () => {
    flowResult = ASK;

    const reply = await call("POST", "/content/item_1/publish", { body: {} });

    expect(reply.status).toBe(202);
    expect(reply.body.success).toBe(true);
    expect(reply.body.data).toMatchObject({ status: "APPROVAL_REQUIRED", published: false, approvalId: "appr_1", ask: "REQUESTED", params: PARAMS });
  });

  it("passes the chosen target by its id", async () => {
    flowResult = ASK;

    await call("POST", "/content/item_1/publish", { body: { targetId: "1234567890" } });

    expect(flowCalls[0]!.arg).toBe("1234567890");
  });

  it("takes no text, no target name and no link from the body", async () => {
    flowResult = ASK;

    await call("POST", "/content/item_1/publish", {
      body: { targetId: "1234567890", message: "Something else entirely", targetName: "Another Page", link: "https://evil.example/", params: { message: "x" } },
    });

    // The flow is given the item and the target's id. What is posted is read
    // from the saved item on the server; there is nowhere for these to go.
    expect(flowCalls).toHaveLength(1);
    expect(flowCalls[0]).toEqual({
      method: "request",
      contentId: "item_1",
      arg: "1234567890",
      caller: expect.objectContaining({ userId: "user-member", role: "member" }),
    });
    expect(JSON.stringify(flowCalls[0])).not.toContain("Something else entirely");
    expect(JSON.stringify(flowCalls[0])).not.toContain("evil.example");
  });

  it("ignores a target id that could not be one, and lets the check decide", async () => {
    flowResult = ASK;

    await call("POST", "/content/item_1/publish", { body: { targetId: "../../etc" } });
    await call("POST", "/content/item_1/publish", { body: { targetId: 42 } });

    expect(flowCalls.map((entry) => entry.arg)).toEqual([undefined, undefined]);
  });

  it("executes with the approval the user decided", async () => {
    flowResult = { status: "PUBLISHED", message: "Published to Test Page and read back from the Page.", alreadyPublished: false, item: null };

    const reply = await call("POST", "/content/item_1/publish", { body: { approvalId: "appr_1" } });

    expect(flowCalls).toEqual([{ method: "execute", contentId: "item_1", arg: "appr_1", caller: expect.objectContaining({ userId: "user-member" }) }]);
    expect(reply.status).toBe(200);
    expect(reply.body.data).toMatchObject({ status: "PUBLISHED", published: true, alreadyPublished: false });
  });

  it.each([
    ["a number", 7],
    ["an object", { id: "appr_1" }],
    ["text that could not be an id", "appr 1; drop"],
    ["an empty string", ""],
  ])("refuses an approval id that is %s without asking the flow", async (_label, approvalId) => {
    const reply = await call("POST", "/content/item_1/publish", { body: { approvalId } });

    expect(reply.status).toBe(404);
    expect(reply.body.error?.code).toBe("NOT_FOUND");
    expect(flowCalls).toHaveLength(0);
  });

  it("carries the selected project to the flow", async () => {
    flowResult = ASK;

    await call("POST", "/content/item_1/publish?projectId=proj_1", { body: {} });

    expect(flowCalls[0]!.caller).toMatchObject({ projectId: "proj_1" });
  });

  /** Every answer that is not a publish and not a request for approval. */
  type Refusal = Exclude<PublishFlowResult, { status: "APPROVAL_REQUIRED" | "PUBLISHED" }>;
  const REFUSALS: Array<[Refusal, number]> = [
    [{ status: "NOT_READY", message: "This item is not marked ready.", preparation: null }, 409],
    [{ status: "DECLINED", message: "You declined this publish, so nothing was posted." }, 409],
    [{ status: "NOT_FOUND", message: "That approval was not found for this item." }, 404],
    [{ status: "FORBIDDEN", message: "Your role cannot publish content." }, 403],
    [{ status: "UNAVAILABLE", message: "Publishing is not available on this server." }, 503],
    [{ status: "NOT_READY", reason: "STALE", message: "The saved text is no longer the text that was approved, so nothing was published.", preparation: null }, 409],
    [{ status: "FAILED", reason: "FAILED", message: "The Page refused the post. Nothing was published." }, 502],
    [{ status: "UNCONFIRMED", message: "It is not known whether the post went out. It is NOT marked as published." }, 502],
  ];

  it.each(REFUSALS.map(([result, status]) => ({ result, status, name: "reason" in result && result.reason ? result.status + " (" + result.reason + ")" : result.status })))(
    "$name is not a success and says published:false",
    async ({ result, status }) => {
      flowResult = result;

      const reply = await call("POST", "/content/item_1/publish", { body: { approvalId: "appr_1" } });

      expect(reply.status).toBe(status);
      expect(reply.body.success).toBe(false);
      expect(reply.body.error?.code).toBe(result.status);
      expect(reply.body.error?.message).toBe(result.message);
      expect(reply.body.error?.published).toBe(false);
      expect(reply.body.data).toBeUndefined();
    }
  );

  it("keeps the flow's status as the error code, and gives the specific failure beside it", async () => {
    flowResult = { status: "FAILED", reason: "APPROVAL_ALREADY_USED", message: "That approval was already used. Nothing new was posted." };

    const reply = await call("POST", "/content/item_1/publish", { body: { approvalId: "appr_1" } });

    expect(reply.body.error).toMatchObject({ code: "FAILED", reason: "APPROVAL_ALREADY_USED", published: false });
  });

  it("lets nothing in a result replace the error's code or its message", async () => {
    // A result is data from further in. Whatever it carries, the envelope's
    // code is the flow's status and its message is the flow's sentence.
    flowResult = { status: "FAILED", reason: "X", message: "The real sentence.", code: "PUBLISHED", published: true } as unknown as PublishFlowResult;

    const reply = await call("POST", "/content/item_1/publish", { body: { approvalId: "appr_1" } });

    expect(reply.status).toBe(502);
    expect(reply.body.success).toBe(false);
    expect(reply.body.error?.code).toBe("FAILED");
    expect(reply.body.error?.message).toBe("The real sentence.");
    expect(reply.body.error?.published).toBe(false);
  });

  it("says published:true for exactly one outcome", async () => {
    const outcomes: PublishFlowResult[] = [ASK, ...REFUSALS.map(([result]) => result)];
    const published: unknown[] = [];
    for (const outcome of outcomes) {
      flowResult = outcome;
      const reply = await call("POST", "/content/item_1/publish", { body: {} });
      published.push(reply.body.data?.published ?? reply.body.error?.published);
    }

    expect(published).toEqual(outcomes.map(() => false));

    flowResult = { status: "PUBLISHED", message: "Published.", alreadyPublished: true, item: null };
    expect((await call("POST", "/content/item_1/publish", { body: {} })).body.data.published).toBe(true);
  });

  it("an outcome that is not known is never reported with a success status", async () => {
    flowResult = { status: "UNCONFIRMED", message: "Not known." };

    const reply = await call("POST", "/content/item_1/publish", { body: { approvalId: "appr_1" } });

    expect(reply.status).toBeGreaterThanOrEqual(500);
    expect(reply.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What this deployment can do
// ---------------------------------------------------------------------------

describe("Phase 15 routes — /status reports what was registered, so the page can leave a control out", () => {
  it("reports everything available when everything is registered", async () => {
    registeredTools.add("meta.insights");

    const reply = await call("GET", "/status");

    expect(reply.status).toBe(200);
    expect(reply.body.data).toEqual({
      research: { available: true, reason: null },
      publishing: { available: true, channels: ["FACEBOOK"], reason: null },
      adAccount: { available: true },
      caller: { canEdit: true, canResearch: true, canPublish: true },
    });
    // It reads the registry. It runs no tool.
    expect(executed).toHaveLength(0);
  });

  it("reports research off, with what an administrator would have to do", async () => {
    researchAvailable = false;
    registeredTools.delete(T.seoAudit);
    registeredTools.delete(T.competitorAnalyze);

    const { research } = (await call("GET", "/status")).body.data;

    expect(research.available).toBe(false);
    expect(research.reason).toContain("BROWSER_ENABLED=true");
  });

  it("reports publishing off, and no channels, when the publish tool is not registered", async () => {
    registeredTools.delete(T.contentPublish);

    const { publishing } = (await call("GET", "/status")).body.data;

    expect(publishing).toEqual({ available: false, channels: [], reason: "No publishing connection is configured on this server." });
  });

  it("reports no ad account when the Meta reads are not registered", async () => {
    expect((await call("GET", "/status")).body.data.adAccount).toEqual({ available: false });
  });

  it("says the same about the SERVER to every role", async () => {
    const [owner, viewer] = await Promise.all([call("GET", "/status", { token: "token-owner" }), call("GET", "/status", { token: "token-viewer" })]);

    for (const key of ["research", "publishing", "adAccount"]) expect(viewer.body.data[key], key).toEqual(owner.body.data[key]);
  });

  it.each([
    ["token-owner", { canEdit: true, canResearch: true, canPublish: true }],
    ["token-member", { canEdit: true, canResearch: true, canPublish: true }],
    // A viewer holds read and nothing else: it may run a page read, and no write.
    ["token-viewer", { canEdit: false, canResearch: true, canPublish: false }],
  ])("tells %s what its own role could run, from the executor's role table", async (token, expected) => {
    expect((await call("GET", "/status", { token })).body.data.caller).toEqual(expected);
  });

  it("never says a role could use a tool that is not registered", async () => {
    registeredTools.delete(T.contentPublish);
    registeredTools.delete(T.seoAudit);

    expect((await call("GET", "/status", { token: "token-owner" })).body.data.caller).toEqual({ canEdit: true, canResearch: false, canPublish: false });
  });

  it("takes the role from the token: a role named in the query changes nothing", async () => {
    const reply = await call("GET", "/status?role=owner", { token: "token-viewer" });

    expect(reply.body.data.caller.canPublish).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A report as a file
// ---------------------------------------------------------------------------

function savedReport(title: string): MarketingReportView {
  const document = buildMarketingReport({
    kind: "CLIENT",
    title,
    campaign: null,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    previousPeriod: null,
    generatedAt: "2026-10-01T08:00:00.000Z",
    currency: null,
    performance: null,
    otherSources: [{ provider: "meta-ads", label: "Meta Ads", status: "NOT_CONFIGURED", detail: "Meta Ads is not set up on this server.", rowCount: 0, executionIds: [], account: null }],
    content: [],
  });
  return {
    id: "rep_1",
    kind: "CLIENT",
    title: document.title,
    campaignId: null,
    campaignName: null,
    projectId: null,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    sourcesIncluded: 0,
    sourcesTotal: 1,
    generatedAt: "2026-10-01T08:00:00.000Z",
    document,
  } as MarketingReportView;
}

describe("Phase 15 routes — exporting a report", () => {
  it("sends the saved report as an HTML download that can run nothing", async () => {
    nextResult = completed({ report: savedReport("September report") });

    const reply = await call("GET", "/reports/rep_1/export");

    expect(reply.status).toBe(200);
    expect(executed[0]).toMatchObject({ toolId: T.reportGet, params: { reportId: "rep_1" } });
    expect(reply.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(reply.headers.get("content-disposition")).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.html"$/);
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reply.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(reply.headers.get("cache-control")).toBe("private, no-store");
    expect(reply.text).toContain("September report");
    expect(reply.text).not.toMatch(/<script/i);
  });

  it("sends Markdown when asked", async () => {
    nextResult = completed({ report: savedReport("September report") });

    const reply = await call("GET", "/reports/rep_1/export?format=md");

    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(reply.headers.get("content-disposition")).toMatch(/\.md"$/);
    expect(reply.text).toContain("September report");
  });

  it("says what was not read, in the file as on the screen", async () => {
    nextResult = completed({ report: savedReport("September report") });

    const reply = await call("GET", "/reports/rep_1/export?format=md");

    expect(reply.text).toContain("Meta Ads is not set up on this server.");
  });

  it("escapes a title that is markup, in the document and in the file name", async () => {
    nextResult = completed({ report: savedReport('<img src=x onerror=alert(1)>"; rm -rf') });

    const reply = await call("GET", "/reports/rep_1/export");

    expect(reply.text).not.toContain("<img src=x");
    expect(reply.text).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // A file name is letters, digits, dots, dashes and underscores — nothing
    // that could close the header's quotes or add a second header.
    expect(reply.headers.get("content-disposition")).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.html"$/);
  });

  it.each(["pdf", "docx", "HTML", "../x"])("refuses the format %s without reading the report", async (format) => {
    const reply = await call("GET", `/reports/rep_1/export?format=${encodeURIComponent(format)}`);

    expect(reply.status).toBe(400);
    expect(reply.body.error?.code).toBe("INVALID");
    expect(executed).toHaveLength(0);
  });

  it("is a JSON 404, not an empty file, for a report that is not the caller's", async () => {
    nextResult = refused("NOT_FOUND", "That report was not found.");

    const reply = await call("GET", "/reports/rep_other/export");

    expect(reply.status).toBe(404);
    expect(reply.body.error).toMatchObject({ code: "NOT_FOUND", message: "That report was not found." });
    expect(reply.headers.get("content-disposition")).toBeNull();
  });

  it("reads the report as the token's user, so another user's id finds nothing", async () => {
    nextResult = completed({ report: savedReport("Mine") });

    await call("GET", "/reports/rep_1/export?userId=user-owner", { token: "token-viewer" });

    expect(executed[0]).toMatchObject({ userId: "user-viewer", role: "viewer" });
  });
});
