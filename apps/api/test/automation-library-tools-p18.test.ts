// ---------------------------------------------------------------------------
// Phase 18, Stage 18.2 — the library's JARVIS tools, through the ToolExecutor,
// against the same service instance the API router serves.
//
// What is pinned:
//   • each tool runs through the real ToolExecutor pipeline (registry, role
//     check, shared-connection gate) and reaches the one AutomationLibraryService;
//   • a sentence and a button get the same answer — and every refusal the same
//     status, code and sentence: outsider, role, unreadable authorization, not
//     configured, budget, a run already going, a server-only field, a bad query;
//   • the platform role decides nothing: a platform "viewer" who owns the
//     Organization may sync, a platform "owner" who is a member may not;
//   • a spoken turn is refused the sync by the executor itself — the tool and
//     the service are never reached, nothing is spent and n8n is not called —
//     under either spelling of the tool's name, while the reads stay open.
// No network, no workflow is activated, edited or run.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AUTOMATION_LIBRARY_TOOL_IDS,
  VOICE_REFUSED_TOOLS,
  VOICE_TOOL_REFUSED_CODE,
  libraryInstanceKey,
  type AuditLogger,
  type IApprovalManager,
  type ITool,
  type InputMode,
  type Role,
  type ToolExecutionResult,
} from "@jarvis/core";
import { PermissionService } from "@jarvis/security";
import { SyncAutomationLibraryTool, ToolExecutor, ToolRegistry, createAutomationLibraryTools } from "@jarvis/tools";
import { createAutomationLibraryRouter } from "../src/routes/automation-library.js";
import {
  AutomationLibraryService,
  type LibraryChainOutcome,
  type LibrarySyncBudgetPort,
} from "../src/services/automation-library/library-service.js";
import type { LibraryRunOutcome } from "../src/services/automation-library/sync-engine.js";
import { createSharedConnectionToolGate } from "../src/services/tenancy/shared-connection-access.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "./helpers/shared-access.js";
import { fakeN8nCatalog, memoryLibraryStore, type FakeN8nCatalog } from "./helpers/memory-library.js";

const ORG = "org-lib";
const INSTANCE = libraryInstanceKey("https://n8n.internal.example.test")!;
const { search: SEARCH, status: STATUS, sync: SYNC } = AUTOMATION_LIBRARY_TOOL_IDS;
const http = globalThis.fetch.bind(globalThis);

const tokenService = {
  // Every HTTP caller is a platform owner: the platform role must decide nothing.
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
let budget: LibrarySyncBudgetPort & { counts: { user: number; org: number }; refuseUser: boolean };
let service: AutomationLibraryService;
let executor: ToolExecutor;
let registry: ToolRegistry;
let completions: Array<Promise<unknown>>;

function build(): void {
  const built = new AutomationLibraryService({
    store: memoryLibraryStore(),
    access: accessOver(tenancy),
    source: configured ? { pages: catalog, instanceKey: INSTANCE } : null,
    budget,
    audit: { log: async () => undefined },
    limits: { pageSize: 50, maxPagesPerRun: 2 },
    sleep: async () => undefined,
  });
  // Every accepted run's and chain's end, so a test can wait for it.
  const requestSync = built.requestSync.bind(built);
  built.requestSync = async (...args) => {
    const result = await requestSync(...args);
    if (result.ok) completions.push(result.value.completion as Promise<LibraryRunOutcome>);
    return result;
  };
  const startContinuation = built.startContinuation.bind(built);
  built.startContinuation = async (...args) => {
    const result = await startContinuation(...args);
    if (result.ok && result.value.completion) completions.push(result.value.completion as Promise<LibraryChainOutcome>);
    return result;
  };
  service = built;
  registry = new ToolRegistry();
  for (const tool of createAutomationLibraryTools(built)) registry.register(tool);
  executor = new ToolExecutor(
    registry,
    new PermissionService(),
    {} as IApprovalManager, // no library tool needs an approval: never consulted
    { log: async () => undefined } as unknown as AuditLogger,
    { accessGate: createSharedConnectionToolGate(accessOver(tenancy)) }
  );
}

beforeAll(() => {
  const app = express();
  app.use(express.json());
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
      { userId: "admin-1", tenantId: ORG, role: "admin" },
      { userId: "member-1", tenantId: ORG, role: "member" },
      { userId: "viewer-1", tenantId: ORG, role: "viewer" },
      { userId: "owner-other", tenantId: "org-other", role: "owner" },
    ],
  });
  catalog = fakeN8nCatalog(230);
  configured = true;
  completions = [];
  budget = {
    counts: { user: 0, org: 0 },
    refuseUser: false,
    async reserveForUser() {
      this.counts.user += 1;
      return this.refuseUser ? { allowed: false, reason: "LIMIT" } : { allowed: true };
    },
    async reserveForOrganization() {
      this.counts.org += 1;
      return { allowed: true };
    },
  };
  build();
});

async function call(userId: string, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await http(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer tok-${userId}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as { success: boolean; data?: any; error?: { code: string; message: string } } };
}

function run(
  toolId: string,
  userId: string,
  params: Record<string, unknown> = {},
  options: { role?: Role; inputMode?: InputMode } = {}
): Promise<ToolExecutionResult> {
  return executor.execute({
    toolId,
    params,
    userId,
    role: options.role ?? "member",
    traceId: `trace-${userId}`,
    ...(options.inputMode ? { inputMode: options.inputMode } : {}),
  });
}

/** A refusal as both arms report it: HTTP status, code, sentence. */
const fromApi = (res: Awaited<ReturnType<typeof call>>) => ({ status: res.status, code: res.body.error?.code, message: res.body.error?.message });
const fromTool = (res: ToolExecutionResult) => ({
  status: res.result?.metadata?.status,
  code: res.result?.metadata?.code,
  message: res.result?.error ?? res.error,
});

/** Holds the fake n8n's next call until released. */
function holdNextFetch(): { release: () => void; reached: Promise<void> } {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  const fetch = catalog.fetchPage.bind(catalog);
  let held = false;
  catalog.fetchPage = async (input) => {
    if (!held) {
      held = true;
      reached();
      await gate;
    }
    return fetch(input);
  };
  return { release, reached: arrived };
}

describe("each tool runs through the ToolExecutor, onto the one service", () => {
  it("is registered with an honest risk, needs only the platform's read, and asks for no approval", () => {
    const tools = new Map(createAutomationLibraryTools(service).map((t) => [t.id, t]));
    // Stage 18.3B added inspect (a read) and propose (an approval row); the change itself is a separate, page-only tool.
    expect([...tools.keys()]).toEqual([SEARCH, STATUS, SYNC, AUTOMATION_LIBRARY_TOOL_IDS.inspect, AUTOMATION_LIBRARY_TOOL_IDS.propose]);
    expect(tools.get(AUTOMATION_LIBRARY_TOOL_IDS.inspect)).toMatchObject({ risk: "READ_ONLY", requiresApproval: false, requiredPermissions: ["read"] });
    expect(tools.get(AUTOMATION_LIBRARY_TOOL_IDS.propose)).toMatchObject({ risk: "LOW_IMPACT", requiresApproval: false, requiredPermissions: ["read"] });
    expect(tools.get(SEARCH)).toMatchObject({ risk: "READ_ONLY", requiresApproval: false, requiredPermissions: ["read"] });
    expect(tools.get(STATUS)).toMatchObject({ risk: "READ_ONLY", requiresApproval: false, requiredPermissions: ["read"] });
    expect(tools.get(SYNC)).toMatchObject({ risk: "LOW_IMPACT", requiresApproval: false, requiredPermissions: ["read"] });
    // Nothing names a scope a caller could set: these parameters, and only these.
    expect(tools.get(SEARCH)!.parameters.map((p) => p.name)).toEqual(["search", "active", "presence", "page", "limit"]);
    expect(tools.get(STATUS)!.parameters).toEqual([]);
    expect(tools.get(SYNC)!.parameters.map((p) => p.name)).toEqual(["continueUntilComplete", "restart", "idempotencyKey"]);
  });

  it("syncs as the button does, and both read back the same catalog and status", async () => {
    const started = await run(SYNC, "admin-1", { continueUntilComplete: true }, { role: "viewer" });
    expect(started).toMatchObject({ status: "completed", result: { success: true, data: { mode: "continue", existing: false, state: "running" } } });
    await Promise.all(completions);

    const apiStatus = await call("member-1", "GET", "/library/status");
    const toolStatus = await run(STATUS, "member-1");
    expect(toolStatus.status).toBe("completed");
    expect(toolStatus.result?.data).toEqual(apiStatus.body.data);
    expect(apiStatus.body.data).toMatchObject({ state: "complete", lastCompleteScan: { records: 230 }, continuation: { status: "COMPLETE" } });

    const apiPage = await call("viewer-1", "GET", "/library/workflows?search=slack&active=true&limit=10&page=2");
    const toolPage = await run(SEARCH, "viewer-1", { search: "slack", active: true, limit: 10, page: 2 }, { role: "viewer" });
    expect(toolPage.result?.data).toEqual(apiPage.body.data);
    expect(apiPage.body.data.items.length).toBeGreaterThan(0);
  });

  it("starts one bounded run when not asked to continue, exactly as POST /sync does", async () => {
    const tool = await run(SYNC, "owner-1");
    expect(tool.result?.data).toMatchObject({ mode: "run", resumed: false, state: "running" });
    await Promise.all(completions);
    const api = await call("owner-1", "POST", "/library/sync", {});
    expect(api.status).toBe(202);
    expect(api.body.data).toMatchObject({ mode: "run", resumed: true, state: "running" });
    await Promise.all(completions);
  });

  it("lets the Organization role decide, never the platform role", async () => {
    // A platform viewer who owns the Organization may sync…
    expect((await run(SYNC, "owner-1", {}, { role: "viewer" })).status).toBe("completed");
    await Promise.all(completions);
    // …and a platform owner who is only a member may not.
    const refused = await run(SYNC, "member-1", {}, { role: "owner" });
    expect(fromTool(refused)).toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
  });
});

describe("a sentence and a button are refused alike", () => {
  const same = (api: Awaited<ReturnType<typeof call>>, tool: ToolExecutionResult) => {
    expect(api.body.success).toBe(false);
    expect(tool.result?.success).toBe(false);
    expect(fromTool(tool)).toEqual(fromApi(api));
  };

  it("an outsider: one answer, whatever is configured", async () => {
    same(await call("owner-other", "GET", "/library/status"), await run(STATUS, "owner-other"));
    same(await call("owner-other", "GET", "/library/workflows"), await run(SEARCH, "owner-other"));
    same(await call("owner-other", "POST", "/library/sync", {}), await run(SYNC, "owner-other"));
    expect(fromApi(await call("owner-other", "GET", "/library/status")).code).toBe("NOT_AVAILABLE");
  });

  it("a member or viewer asking to sync", async () => {
    same(await call("member-1", "POST", "/library/sync", { continueUntilComplete: true }), await run(SYNC, "member-1", { continueUntilComplete: true }));
    same(await call("viewer-1", "POST", "/library/sync", {}), await run(SYNC, "viewer-1", {}, { role: "viewer" }));
  });

  it("authorization that cannot be checked", async () => {
    tenancy.setFailing(true);
    same(await call("owner-1", "GET", "/library/status"), await run(STATUS, "owner-1"));
    same(await call("owner-1", "POST", "/library/sync", {}), await run(SYNC, "owner-1"));
    expect(catalog.calls).toHaveLength(0);
  });

  it("n8n not configured", async () => {
    configured = false;
    build();
    same(await call("owner-1", "GET", "/library/workflows"), await run(SEARCH, "owner-1"));
    same(await call("owner-1", "POST", "/library/sync", {}), await run(SYNC, "owner-1"));
    expect((await run(STATUS, "member-1")).result?.data).toEqual((await call("member-1", "GET", "/library/status")).body.data);
  });

  it("a spent budget", async () => {
    budget.refuseUser = true;
    same(await call("owner-1", "POST", "/library/sync", {}), await run(SYNC, "owner-1"));
    same(await call("owner-1", "POST", "/library/sync", { continueUntilComplete: true }), await run(SYNC, "owner-1", { continueUntilComplete: true }));
    expect(catalog.calls).toHaveLength(0);
  });

  it("a synchronization already running", async () => {
    const held = holdNextFetch();
    await run(SYNC, "owner-1");
    await held.reached;
    same(await call("admin-1", "POST", "/library/sync", {}), await run(SYNC, "admin-1"));
    expect(fromApi(await call("admin-1", "POST", "/library/sync", {})).code).toBe("SYNC_ALREADY_RUNNING");
    held.release();
    await Promise.all(completions);
  });

  it("a field only the server decides, and a query out of bounds", async () => {
    same(await call("owner-1", "GET", "/library/workflows?tenantId=org-other"), await run(SEARCH, "owner-1", { tenantId: "org-other" }));
    same(await call("owner-1", "POST", "/library/sync", { cursor: "eyJvZmZzZXQiOjB9" }), await run(SYNC, "owner-1", { cursor: "eyJvZmZzZXQiOjB9" }));
    same(await call("owner-1", "POST", "/library/sync", { baseUrl: "https://evil.example" }), await run(SYNC, "owner-1", { baseUrl: "https://evil.example" }));
    same(await call("owner-1", "GET", "/library/workflows?limit=500"), await run(SEARCH, "owner-1", { limit: 500 }));
    same(await call("owner-1", "GET", "/library/workflows?presence=gone"), await run(SEARCH, "owner-1", { presence: "gone" }));
    same(await call("owner-1", "POST", "/library/sync", { restart: "yes" }), await run(SYNC, "owner-1", { restart: "yes" }));
    same(await call("owner-1", "POST", "/library/sync", { idempotencyKey: "x" }), await run(SYNC, "owner-1", { idempotencyKey: "x" }));
    expect(fromApi(await call("owner-1", "GET", "/library/workflows?tenantId=org-other")).code).toBe("REQUEST_SCOPE_REFUSED");
    expect(catalog.calls).toHaveLength(0);
    expect(budget.counts).toEqual({ user: 0, org: 0 });
  });
});

describe("speech does not start a sync — refused by the executor itself", () => {
  it("refuses a spoken sync before the tool or the service is reached, spending nothing", async () => {
    const startSync = vi.spyOn(service, "startSync");
    const requestSync = vi.spyOn(service, "requestSync");
    const startContinuation = vi.spyOn(service, "startContinuation");
    const execute = vi.spyOn(registry.get(SYNC)!, "execute");
    for (const params of [{}, { continueUntilComplete: true }, { restart: true }]) {
      const refused = await run(SYNC, "owner-1", params, { role: "owner", inputMode: "voice" });
      expect(refused).toMatchObject({
        status: "permission_denied",
        error: VOICE_REFUSED_TOOLS[SYNC],
        result: { success: false, metadata: { code: VOICE_TOOL_REFUSED_CODE, status: 403 } },
      });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    expect(requestSync).not.toHaveBeenCalled();
    expect(startContinuation).not.toHaveBeenCalled();
    expect(catalog.calls).toHaveLength(0);
    expect(budget.counts).toEqual({ user: 0, org: 0 });
    // Nothing started: the library is as it was.
    expect((await call("owner-1", "GET", "/library/status")).body.data).toMatchObject({ state: "never_synced", runs: [], continuation: null });
  });

  it("refuses it under the model's sanitized spelling too", async () => {
    const resolving = { get: (id: string) => registry.get(id === "automation-library-sync" ? SYNC : id) };
    const viaAlias = new ToolExecutor(resolving, new PermissionService(), {} as IApprovalManager, { log: async () => undefined } as unknown as AuditLogger);
    const refused = await viaAlias.execute({ toolId: "automation-library-sync", params: {}, userId: "owner-1", role: "owner", traceId: "t", inputMode: "voice" });
    expect(refused).toMatchObject({ status: "permission_denied", error: VOICE_REFUSED_TOOLS[SYNC] });
    expect(catalog.calls).toHaveLength(0);
  });

  it("is refused by the tool too, should anything call it with a spoken context", async () => {
    const port = { list: vi.fn(), status: vi.fn(), startSync: vi.fn(), inspect: vi.fn(), proposeAllowlist: vi.fn() };
    const tool = new SyncAutomationLibraryTool(port);
    const refused = await tool.execute({ continueUntilComplete: true }, { userId: "owner-1", inputMode: "voice" });
    expect(refused).toMatchObject({ success: false, error: VOICE_REFUSED_TOOLS[SYNC], metadata: { code: VOICE_TOOL_REFUSED_CODE } });
    expect(port.startSync).not.toHaveBeenCalled();
  });

  it("leaves the reads open to voice, and the same sync typed runs", async () => {
    expect((await run(STATUS, "member-1", {}, { inputMode: "voice" })).status).toBe("completed");
    expect((await run(SEARCH, "member-1", { search: "x" }, { inputMode: "voice" })).status).toBe("completed");
    expect((await run(SYNC, "owner-1", {}, { inputMode: "text" })).status).toBe("completed");
    await Promise.all(completions);
  });

  it("hands every tool the turn's input mode, and nothing when there is none", async () => {
    const seen: Array<string | undefined> = [];
    const probe: ITool = {
      id: "probe.read",
      name: "probe",
      description: "probe",
      category: "system",
      risk: "READ_ONLY",
      parameters: [],
      requiresApproval: false,
      requiredPermissions: ["read"],
      version: "1",
      enabled: true,
      validate: () => true,
      execute: async (_params, context) => {
        seen.push(context.inputMode);
        return { success: true, data: { has: "inputMode" in context } };
      },
    };
    registry.register(probe);
    await run("probe.read", "member-1", {}, { inputMode: "voice" });
    const typed = await run("probe.read", "member-1");
    expect(seen).toEqual(["voice", undefined]);
    expect(typed.result?.data).toEqual({ has: false });
  });
});

describe("POST /sync with continueUntilComplete", () => {
  it("answers 202 while it runs, the same chain to a double click, and 200 with its end to a retry of a finished one", async () => {
    const key = "click-0001-aaaa-bbbb";
    const held = holdNextFetch();
    const a = await call("owner-1", "POST", "/library/sync", { continueUntilComplete: true, idempotencyKey: key });
    await held.reached;
    // A second click — another key, another admin — while the chain is alive.
    const b = await call("admin-1", "POST", "/library/sync", { continueUntilComplete: true, idempotencyKey: "click-0002-cccc-dddd" });
    // The same click retried.
    const again = await call("owner-1", "POST", "/library/sync", { continueUntilComplete: true, idempotencyKey: key });
    expect([a.status, b.status, again.status]).toEqual([202, 202, 202]);
    expect(a.body.data).toMatchObject({ mode: "continue", existing: false, state: "running" });
    expect(b.body.data).toEqual({ mode: "continue", chainId: a.body.data.chainId, existing: true, state: "running" });
    expect(again.body.data).toEqual(b.body.data);
    // A single run is refused meanwhile.
    expect((await call("admin-1", "POST", "/library/sync", {})).body.error?.code).toBe("SYNC_ALREADY_RUNNING");
    held.release();
    await Promise.all(completions);

    const retry = await call("owner-1", "POST", "/library/sync", { continueUntilComplete: true, idempotencyKey: key });
    expect(retry.status).toBe(200);
    expect(retry.body.data).toEqual({ mode: "continue", chainId: a.body.data.chainId, existing: true, state: "COMPLETE" });
    const status = (await call("viewer-1", "GET", "/library/status")).body.data;
    expect(status).toMatchObject({ state: "complete", canSync: false, continuation: { status: "COMPLETE" } });
    expect(JSON.stringify(status)).not.toContain(key);
  });
});
