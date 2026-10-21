// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — the Automation Library's API, over HTTP.
//
// The real router, the real service, the real access reader and policy table;
// the catalog store in memory and n8n faked. What is pinned: who may read and
// who may start a run, decided before anything else and the same whether or
// not n8n is configured; nothing in a request can name a scope or a cursor;
// budgets refuse before n8n is called; one run at a time; and what leaves —
// no cursor, no instance, no Organization id, no provider words.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { libraryInstanceKey } from "@jarvis/core";
import { createAutomationLibraryRouter, parseLibraryQuery } from "../src/routes/automation-library.js";
import {
  AutomationLibraryService,
  type LibrarySyncBudgetPort,
} from "../src/services/automation-library/library-service.js";
import type { LibraryRunOutcome } from "../src/services/automation-library/sync-engine.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "./helpers/shared-access.js";
import { fakeN8nCatalog, memoryLibraryStore, type FakeN8nCatalog } from "./helpers/memory-library.js";

const ORG = "org-lib";
const INSTANCE = libraryInstanceKey("https://n8n.internal.example.test")!;
const http = globalThis.fetch.bind(globalThis);

const tokenService = {
  verifyAccessToken: (token: string) => {
    const userId = token.replace(/^tok-/, "");
    return userId ? { userId, role: "owner", email: `${userId}@test.local` } : null;
  },
};

let server: Server;
let base = "";
let tenancy: MemoryTenancy;
let catalog: FakeN8nCatalog;
let configured: boolean;
let budget: LibrarySyncBudgetPort;
let service: AutomationLibraryService;
let completions: Array<Promise<LibraryRunOutcome>>;

function build(): AutomationLibraryService {
  const built = new AutomationLibraryService({
    store: memoryLibraryStore(),
    access: accessOver(tenancy),
    source: configured ? { pages: catalog, instanceKey: INSTANCE } : null,
    budget,
    audit: { log: async () => undefined },
    limits: { pageSize: 100, maxPagesPerRun: 3 },
  });
  // Every accepted run's completion, so a test can wait for it.
  const requestSync = built.requestSync.bind(built);
  built.requestSync = async (...args) => {
    const result = await requestSync(...args);
    if (result.ok) completions.push(result.value.completion);
    return result;
  };
  return built;
}

beforeAll(() => {
  const app = express();
  app.use(express.json());
  // A router per request, so each test's service is the one served.
  app.use("/library", (req, res, next) =>
    createAutomationLibraryRouter({ tokenService, automationLibrary: service } as never)(req, res, next)
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  tenancy = memoryTenancy({
    owners: { "n8n/rest": ORG },
    members: [
      { userId: "owner-1", tenantId: ORG, role: "owner" },
      { userId: "member-1", tenantId: ORG, role: "member" },
      { userId: "viewer-1", tenantId: ORG, role: "viewer" },
      { userId: "outsider-1", tenantId: "org-b", role: "owner" },
    ],
  });
  catalog = fakeN8nCatalog(450);
  configured = true;
  budget = { reserveForUser: async () => ({ allowed: true }), reserveForOrganization: async () => ({ allowed: true }) };
  completions = [];
  service = build();
});

async function call(userId: string | null, method: string, path: string, body?: unknown) {
  const response = await http(base + path, {
    method,
    headers: {
      ...(userId ? { authorization: `Bearer tok-${userId}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as { success: boolean; data?: any; error?: { code: string; message: string } } };
}

describe("who may read and who may start a run", () => {
  it("refuses a request without a session", async () => {
    expect((await call(null, "GET", "/library/status")).status).toBe(401);
  });

  it("answers an outsider with one sentence — the same whether n8n is configured or not", async () => {
    const whenConfigured = await call("outsider-1", "GET", "/library/workflows");
    configured = false;
    service = build();
    const whenNot = await call("outsider-1", "GET", "/library/workflows");
    for (const res of [whenConfigured, whenNot]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toEqual({ code: "NOT_AVAILABLE", message: "n8n is not available to your account." });
    }
    expect((await call("outsider-1", "POST", "/library/sync", {})).body.error?.code).toBe("NOT_AVAILABLE");
    expect(catalog.calls).toHaveLength(0);
  });

  it("refuses everyone while nobody owns the connection, and an account-wide owner who is not a member", async () => {
    tenancy.setOwner("n8n", "rest", null);
    for (const userId of ["owner-1", "member-1"]) {
      expect((await call(userId, "GET", "/library/status")).body.error?.code).toBe("NOT_AVAILABLE");
      expect((await call(userId, "POST", "/library/sync", {})).body.error?.code).toBe("NOT_AVAILABLE");
    }
    expect(catalog.calls).toHaveLength(0);
  });

  it("lets members and viewers read; refuses their sync before n8n is called", async () => {
    for (const userId of ["member-1", "viewer-1"]) {
      expect((await call(userId, "GET", "/library/status")).status).toBe(200);
      expect((await call(userId, "GET", "/library/workflows")).status).toBe(200);
      const sync = await call(userId, "POST", "/library/sync", {});
      expect(sync.status).toBe(403);
      expect(sync.body.error).toEqual({
        code: "PERMISSION_DENIED",
        message: "Only an owner or admin of your organization can synchronize the n8n workflow library.",
      });
    }
    expect(catalog.calls).toHaveLength(0);
  });

  it("refuses — AUTHORIZATION_UNAVAILABLE — when ownership or membership cannot be read, reaching nothing", async () => {
    tenancy.setFailing(true);
    for (const [method, path] of [["GET", "/library/status"], ["GET", "/library/workflows"], ["POST", "/library/sync"]] as const) {
      const res = await call("owner-1", method, path, method === "POST" ? {} : undefined);
      expect(res.status).toBe(503);
      expect(res.body.error?.code).toBe("AUTHORIZATION_UNAVAILABLE");
    }
    expect(catalog.calls).toHaveLength(0);
  });

  it("tells a member — and only a member — that n8n is not configured here", async () => {
    configured = false;
    service = build();
    expect((await call("member-1", "GET", "/library/status")).body.data).toMatchObject({ configured: false, state: "never_synced" });
    expect((await call("owner-1", "GET", "/library/workflows")).body.error?.code).toBe("N8N_NOT_CONFIGURED");
    expect((await call("owner-1", "POST", "/library/sync", {})).body.error?.code).toBe("N8N_NOT_CONFIGURED");
  });
});

describe("a run, from the API", () => {
  it("starts a bounded run (202), follows it to partial, resumes it to complete, and lists the catalog", async () => {
    const started = await call("owner-1", "POST", "/library/sync", {});
    expect(started.status).toBe(202);
    expect(started.body.data).toEqual({ mode: "run", runId: expect.any(String), resumed: false, state: "running" });
    await Promise.all(completions);

    let status = await call("member-1", "GET", "/library/status");
    expect(status.body.data).toMatchObject({
      configured: true,
      state: "partial",
      catalog: { present: 300, missing: 0, removed: 0 },
      currentScan: { pagesFetched: 3, recordsObserved: 300 },
      lastCompleteScan: null,
    });

    expect((await call("owner-1", "POST", "/library/sync", {})).body.data.resumed).toBe(true);
    await Promise.all(completions);
    status = await call("member-1", "GET", "/library/status");
    expect(status.body.data).toMatchObject({ state: "complete", lastCompleteScan: { records: 450 }, currentScan: null });
    expect(status.body.data.runs.map((r: { status: string }) => r.status)).toEqual(["COMPLETE", "PARTIAL"]);

    const page = await call("viewer-1", "GET", "/library/workflows?limit=20&page=2&search=SLACK&active=true");
    expect(page.status).toBe(200);
    expect(page.body.data).toMatchObject({ page: 2, limit: 20 });
    for (const item of page.body.data.items) {
      expect(item.active).toBe(true);
      expect(item.nodeTypes).toContain("n8n-nodes-base.slack");
      expect(item.presence).toBe("present");
      expect(item.source).toBe("rest");
    }
  });

  it("refuses a second start while one runs — 409, and nothing more reaches n8n", async () => {
    // n8n holds its first answer until both requests have been answered, so
    // the first run is certainly still running when the second arrives.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchPage = catalog.fetchPage.bind(catalog);
    catalog.fetchPage = async (input) => {
      await gate;
      return fetchPage(input);
    };

    const [a, b] = await Promise.all([call("owner-1", "POST", "/library/sync", {}), call("owner-1", "POST", "/library/sync", {})]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error?.code).toBe("SYNC_ALREADY_RUNNING");
    release();
    await Promise.all(completions);
    expect(completions).toHaveLength(1);
    expect(catalog.calls).toHaveLength(3);
  });

  it("refuses over a budget — and when no budget can be checked — before n8n is called", async () => {
    budget = { reserveForUser: async () => ({ allowed: false, reason: "LIMIT" }), reserveForOrganization: async () => ({ allowed: true }) };
    service = build();
    expect((await call("owner-1", "POST", "/library/sync", {})).status).toBe(429);
    budget = { reserveForUser: async () => ({ allowed: true }), reserveForOrganization: async () => ({ allowed: false, reason: "LIMIT" }) };
    service = build();
    const org = await call("owner-1", "POST", "/library/sync", {});
    expect(org.status).toBe(429);
    expect(org.body.error?.message).toMatch(/Your organization has started/);
    budget = { reserveForUser: async () => ({ allowed: false, reason: "UNAVAILABLE" }), reserveForOrganization: async () => ({ allowed: true }) };
    service = build();
    expect((await call("owner-1", "POST", "/library/sync", {})).body.error?.message).toMatch(/could not be checked/);
    expect(catalog.calls).toHaveLength(0);
  });
});

describe("nothing in a request names a scope or a position", () => {
  it.each([
    ["GET", "/library/workflows?tenantId=org-b"],
    ["GET", "/library/workflows?organization_id=org-b"],
    ["GET", "/library/status?Instance-Key=x"],
    ["GET", "/library/workflows?cursor=eyJvZmZzZXQiOjB9"],
  ])("%s %s is refused outright", async (method, path) => {
    const res = await call("owner-1", method, path);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("REQUEST_SCOPE_REFUSED");
  });

  it.each([{ cursor: "eyJvZmZzZXQiOjUwMH0=" }, { baseUrl: "https://evil.example" }, { tenantId: "org-b" }, { scanId: "x" }])(
    "a sync body carrying %j is refused before anything runs",
    async (body) => {
      const res = await call("owner-1", "POST", "/library/sync", body);
      expect(res.status).toBe(400);
      expect(catalog.calls).toHaveLength(0);
    }
  );

  it("refuses a restart that is not true or false", async () => {
    expect((await call("owner-1", "POST", "/library/sync", { restart: "yes" })).body.error?.code).toBe("INVALID_REQUEST");
  });

  it("validates and bounds the catalog query", () => {
    expect(parseLibraryQuery({})).toEqual({ page: 1, limit: 50 });
    expect(parseLibraryQuery({ page: "2", limit: "100", search: " Slack ", active: "false", presence: "removed" })).toEqual({
      page: 2,
      limit: 100,
      search: "Slack",
      active: false,
      presence: "removed",
    });
    for (const bad of [{ limit: "101" }, { limit: "0" }, { page: "-1" }, { page: "1.5" }, { active: "yes" }, { presence: "deleted" }, { search: "x".repeat(101) }, { page: ["1", "2"] }]) {
      expect(parseLibraryQuery(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("what leaves the server", () => {
  it("never a cursor, the instance, the Organization's id, or n8n's words", async () => {
    catalog.intercept = ({ index }, real) =>
      index === 1 ? ({ ok: false, error: { code: "RATE_LIMITED", httpStatus: 429, message: "x-n8n-api-key: SECRET" } } as never) : real();
    await call("owner-1", "POST", "/library/sync", {});
    await Promise.all(completions);

    const status = await call("member-1", "GET", "/library/status");
    const list = await call("member-1", "GET", "/library/workflows?presence=all");
    expect(status.body.data.state).toBe("failed");
    expect(status.body.data.runs[0].failure.code).toBe("PROVIDER_RATE_LIMITED");
    const shown = status.text + list.text;
    expect(shown).not.toMatch(/SECRET|api-key|eyJ|n8n\.internal/);
    expect(shown).not.toContain(INSTANCE);
    expect(shown).not.toContain(ORG);
  });
});
