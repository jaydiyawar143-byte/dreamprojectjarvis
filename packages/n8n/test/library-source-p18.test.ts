// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — the n8n side of an Automation Library sync.
//
//   • The workflow listing keeps the catalog metadata a listing carries —
//     version id, tag names, node TYPES and count — and nothing else of a
//     workflow: no node parameters, credentials, settings, static or pinned
//     data. A listing without them stays exactly what it was.
//   • The page source is one call of the existing cursor listing, and a
//     failure crosses as its classification only — never n8n's words.
//
// No network: fetch is a stub.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";
import { createN8nConfig } from "../src/config.js";
import { createN8nApiClient } from "../src/api-client.js";
import { createN8nLibraryPageSource } from "../src/library-source.js";
import { createN8nProvider } from "../src/provider.js";

const API_KEY = "SECRET-API-KEY-VALUE";
const config = createN8nConfig({ baseUrl: "https://n8n.cloud.test", apiKey: API_KEY, callbackSecret: "cb", timeoutMs: 200 });

function stub(status: number, body: unknown) {
  const payload = JSON.stringify(body);
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => payload } as Response);
}

afterEach(() => vi.restoreAllMocks());

const FULL_WORKFLOW = {
  id: "wf-1",
  name: "Leads to Slack",
  active: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
  versionId: "a1b2c3",
  tags: [{ id: "t1", name: "sales" }, { id: "t2", name: " ops " }],
  nodes: [
    { type: "n8n-nodes-base.webhook", parameters: { path: "leads" } },
    {
      type: "n8n-nodes-base.httpRequest",
      parameters: { headerParameters: { parameters: [{ name: "Authorization", value: "Bearer SECRET-NODE-TOKEN" }] } },
      credentials: { httpHeaderAuth: { id: "9", name: "SECRET-CREDENTIAL-NAME" } },
    },
    { type: "n8n-nodes-base.slack" },
  ],
  connections: { Webhook: { main: [[{ node: "Slack" }]] } },
  settings: { errorWorkflow: "SECRET-SETTING" },
  staticData: { lastToken: "SECRET-STATIC" },
  pinData: { Webhook: [{ json: { password: "SECRET-PIN" } }] },
};

describe("the workflow listing's catalog metadata", () => {
  it("keeps version id, tag names and node types — and nothing secret", async () => {
    stub(200, { data: [FULL_WORKFLOW], nextCursor: null });
    const result = await createN8nApiClient(config).listWorkflows();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.workflows).toEqual([
      {
        id: "wf-1",
        name: "Leads to Slack",
        active: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        versionId: "a1b2c3",
        tags: ["sales", "ops"],
        nodeTypes: ["n8n-nodes-base.httpRequest", "n8n-nodes-base.slack", "n8n-nodes-base.webhook"],
        nodeCount: 3,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
  });

  it("adds nothing to a listing that carried none of it", async () => {
    stub(200, { data: [{ id: "wf-2", name: "Plain", active: false }], nextCursor: null });
    const result = await createN8nApiClient(config).listWorkflows();
    expect(result.ok && result.data.workflows[0]).toEqual({ id: "wf-2", name: "Plain", active: false, createdAt: null, updatedAt: null });
  });
});

describe("createN8nLibraryPageSource", () => {
  it("is one call of the existing cursor listing, with the cursor and page size it is given", async () => {
    const spy = stub(200, { data: [FULL_WORKFLOW], nextCursor: "eyJvZmZzZXQiOjI1MH0=" });
    const source = createN8nLibraryPageSource(createN8nProvider({ config }));

    const page = await source.fetchPage({ cursor: "eyJvZmZzZXQiOjB9", limit: 100 });

    expect(spy).toHaveBeenCalledTimes(1);
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/workflows");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("cursor")).toBe("eyJvZmZzZXQiOjB9");
    expect(url.toString()).not.toContain(API_KEY);
    expect(page).toMatchObject({ ok: true, nextCursor: "eyJvZmZzZXQiOjI1MH0=" });
  });

  it("sends no cursor for a scan's first page", async () => {
    const spy = stub(200, { data: [], nextCursor: null });
    await createN8nLibraryPageSource(createN8nProvider({ config })).fetchPage({ cursor: null, limit: 250 });
    expect(new URL(String(spy.mock.calls[0]![0])).searchParams.has("cursor")).toBe(false);
  });

  it("passes a failure on as its classification — code and status — and never n8n's words", async () => {
    stub(400, { message: `Invalid cursor; ${API_KEY} x-n8n-api-key: ${API_KEY}` });
    const page = await createN8nLibraryPageSource(createN8nProvider({ config })).fetchPage({ cursor: "stale", limit: 250 });
    expect(page).toEqual({ ok: false, error: { code: "INVALID_REQUEST", httpStatus: 400 } });
  });

  it("reports a transport failure without a status", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(`connect ECONNREFUSED ${API_KEY}`));
    const page = await createN8nLibraryPageSource(createN8nProvider({ config })).fetchPage({ cursor: null, limit: 250 });
    expect(page).toEqual({ ok: false, error: { code: "NETWORK_ERROR" } });
  });
});
