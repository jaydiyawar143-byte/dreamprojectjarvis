// ---------------------------------------------------------------------------
// Phase 18, Stage 18.3B — inspecting one library workflow, and proposing it
// for the trigger allow-list, end to end without a database.
//
// The real service, sync engine, tools, ToolExecutor (with the shared-
// connection gate), apply flow and router. Fakes for the catalog source (n8n's
// listing), the one live read an approved change makes, the allow-list, and an
// approval store with the Phase 17 Organization rules (helpers/
// memory-org-approvals). No network; nothing is activated, edited, run or
// published — a spy `n8n.trigger` tool proves the trigger is never reached.
//
// Pinned here:
//   • inspection is sanitized, built from the catalog alone (n8n is not
//     called), and fails closed outside the caller's Organization/connection;
//   • stale, missing and unsupported metadata are reported, never filled in;
//   • the tools run through ToolExecutor and answer as the routes do;
//   • a proposal is ONE approval row, bound to the Organization (from the
//     owner record) and to {entryId, versionId}; a retry returns it;
//   • only ANOTHER owner or admin approves it; applying re-checks the role,
//     the entry, the catalog version and n8n's live version and webhook, and
//     only then consumes the approval — once — and writes the row;
//   • a spoken apply never reaches the change; rejected, expired, used and
//     waiting proposals change nothing; every step is audited, with no secret.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AUTOMATION_LIBRARY_TOOL_IDS,
  VOICE_CONFIRMATION_REFUSED_MESSAGE,
  libraryInstanceKey,
  type AuditLogger,
  type ITool,
  type InputMode,
  type LibraryAllowlistRegistry,
  type LibraryTriggerTarget,
  type LibraryTriggerTargetSource,
  type Role,
} from "@jarvis/core";
import { ApprovalService, PermissionService } from "@jarvis/security";
import { MemoryExecutionJournal, ToolExecutor, ToolRegistry, createAutomationLibraryAllowlistTool, createAutomationLibraryTools } from "@jarvis/tools";
import { AGENT_POLICIES } from "@jarvis/agents";
import { createAutomationLibraryRouter } from "../src/routes/automation-library.js";
import { AutomationLibraryService } from "../src/services/automation-library/library-service.js";
import { LibraryAllowlistFlow } from "../src/services/automation-library/allowlist-flow.js";
import { createSharedConnectionToolGate } from "../src/services/tenancy/shared-connection-access.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "./helpers/shared-access.js";
import { fakeN8nCatalog, fakeWorkflow, memoryLibraryStore, type FakeN8nCatalog, type MemoryLibraryStore } from "./helpers/memory-library.js";
import { MemoryOrgApprovals } from "./helpers/memory-org-approvals.js";
import { buildApprovalSummary } from "../src/services/approval-summary.js";

const ORG = "org-lib";
const OTHER = "org-other";
const INSTANCE = libraryInstanceKey("https://n8n.internal.example.test")!;
const OTHER_INSTANCE = libraryInstanceKey("https://n8n-two.internal.example.test")!;
const { inspect: INSPECT, propose: PROPOSE, allowlistAdd: ADD } = AUTOMATION_LIBRARY_TOOL_IDS;
const HOOK = "wf-hook";
const SECRET_PATH = "invoice-hook-5f3c";
const http = globalThis.fetch.bind(globalThis);

const tokenService = {
  verifyAccessToken: (token: string) => {
    const userId = token.replace(/^tok-/, "");
    return userId ? { userId, role: "owner", email: `${userId}@test.local` } : null;
  },
};

/** The catalog n8n lists: names and node types an author typed, some of them hostile. */
function workflows() {
  return [
    fakeWorkflow(1, {
      id: HOOK,
      name: "Invoice sync — see https://evil.example/steal?token=abc123 or www.evil.example",
      versionId: "v-1",
      nodeTypes: ["n8n-nodes-base.webhook", "n8n-nodes-base.slack", "n8n-nodes-base.httpRequest", "community-nodes.unknownThing"],
      nodeCount: 6,
    }),
    fakeWorkflow(2, { id: "wf-cron", name: "Nightly report", versionId: "v-2", nodeTypes: ["n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.gmail"] }),
    fakeWorkflow(3, { id: "wf-nonodes", name: "Listed without nodes", versionId: "v-3", nodeTypes: null }),
    fakeWorkflow(4, { id: "wf-noversion", name: "No version", versionId: null, nodeTypes: ["n8n-nodes-base.webhook"] }),
  ];
}

let server: Server;
let base = "";
let tenancy: MemoryTenancy;
let store: MemoryLibraryStore;
let catalog: FakeN8nCatalog;
let approvals: MemoryOrgApprovals;
let journal: MemoryExecutionJournal;
let service: AutomationLibraryService;
let executor: ToolExecutor;
let flow: LibraryAllowlistFlow;
let registry: ToolRegistry;
let instanceKey: string;
let targets: Map<string, LibraryTriggerTarget>;
let targetCalls: string[];
let targetFails: boolean;
let allowRows: Array<{ userId: string; name: string; webhookPath: string; entryRef: string; versionId: string }>;
let audits: Array<{ userId: string; action: string; result: string; metadata?: Record<string, unknown> }>;
let logs: string[];
let triggered: number;

const allowlist: LibraryAllowlistRegistry = {
  registerLibraryWorkflow: vi.fn(async (input) => {
    const same = allowRows.find((r) => r.userId === input.userId && r.entryRef === input.entryRef);
    if (same && same.webhookPath === input.webhookPath && same.versionId === input.versionId) return { outcome: "unchanged" as const };
    if (same) {
      Object.assign(same, input);
      return { outcome: "updated" as const };
    }
    if (allowRows.some((r) => r.userId === input.userId && r.webhookPath === input.webhookPath)) return { outcome: "conflict" as const };
    allowRows.push({ ...input });
    return { outcome: "created" as const };
  }),
  findLibraryRegistrations: async (userId, refs) =>
    allowRows.filter((r) => r.userId === userId && refs.includes(r.entryRef)).map((r) => ({ entryRef: r.entryRef, versionId: r.versionId })),
};

const triggerTargets: LibraryTriggerTargetSource = {
  async fetchTriggerTarget(entryId) {
    targetCalls.push(entryId);
    if (targetFails) return { ok: false, error: { code: "TOOL_TIMEOUT" } };
    const target = targets.get(entryId);
    return target ? { ok: true, target: structuredClone(target) } : { ok: false, error: { code: "INVALID_REQUEST", httpStatus: 404 } };
  },
};

function build(key = INSTANCE) {
  instanceKey = key;
  const audit = { log: async (entry: (typeof audits)[number]) => void audits.push(entry) };
  service = new AutomationLibraryService({
    store,
    access: accessOver(tenancy),
    source: { pages: catalog, instanceKey: key },
    budget: { reserveForUser: async () => ({ allowed: true }), reserveForOrganization: async () => ({ allowed: true }) },
    audit,
    limits: { pageSize: 50, maxPagesPerRun: 5 },
    log: { info: (e, f) => void logs.push(JSON.stringify([e, f])), warn: (e, f) => void logs.push(JSON.stringify([e, f])) },
    approvals,
    allowlist,
    triggerTargets,
  });
  registry = new ToolRegistry();
  for (const tool of createAutomationLibraryTools(service)) registry.register(tool);
  registry.register(createAutomationLibraryAllowlistTool(service, journal, approvals));
  // The trigger exists beside them, and must never be reached by any of this.
  const trigger: ITool = {
    id: "n8n.trigger",
    name: "trigger",
    description: "trigger",
    category: "integration",
    risk: "EXTERNAL_SIDE_EFFECT",
    parameters: [],
    requiresApproval: true,
    requiredPermissions: ["read", "write"],
    version: "1",
    enabled: true,
    validate: () => true,
    execute: async () => {
      triggered += 1;
      return { success: true };
    },
  };
  registry.register(trigger);
  executor = new ToolExecutor(registry, new PermissionService(), new ApprovalService(approvals), { log: async () => undefined } as unknown as AuditLogger, {
    accessGate: createSharedConnectionToolGate(accessOver(tenancy)),
  });
  flow = new LibraryAllowlistFlow({ executor, approvals, audit, now: () => new Date(approvals.now()) });
}

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use("/library", (req, res, next) =>
    createAutomationLibraryRouter({ tokenService, automationLibrary: service, automationLibraryAllowlist: flow } as never)(req, res, next)
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(async () => {
  tenancy = memoryTenancy({
    owners: { "n8n/rest": ORG },
    members: [
      { userId: "owner-1", tenantId: ORG, role: "owner" },
      { userId: "admin-1", tenantId: ORG, role: "admin" },
      { userId: "member-1", tenantId: ORG, role: "member" },
      { userId: "viewer-1", tenantId: ORG, role: "viewer" },
      { userId: "owner-other", tenantId: OTHER, role: "owner" },
    ],
  });
  store = memoryLibraryStore();
  catalog = fakeN8nCatalog(0);
  catalog.workflows = workflows();
  approvals = new MemoryOrgApprovals(tenancy);
  journal = new MemoryExecutionJournal();
  targets = new Map([[HOOK, { versionId: "v-1", webhooks: [{ path: SECRET_PATH, method: "POST", authentication: "none" }] }]]);
  targetCalls = [];
  targetFails = false;
  allowRows = [];
  audits = [];
  logs = [];
  triggered = 0;
  vi.mocked(allowlist.registerLibraryWorkflow).mockClear();
  build();
  const synced = await service.requestSync("owner-1");
  if (!synced.ok) throw new Error(synced.code);
  await synced.value.completion;
});

async function call(userId: string, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await http(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer tok-${userId}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as { success: boolean; data?: any; error?: { code: string; message: string } } };
}

const run = (toolId: string, userId: string, params: Record<string, unknown>, options: { role?: Role; inputMode?: InputMode; approvalId?: string } = {}) =>
  executor.execute({
    toolId,
    params,
    userId,
    role: options.role ?? "member",
    traceId: `trace-${userId}`,
    ...(options.approvalId ? { approvalId: options.approvalId } : {}),
    ...(options.inputMode ? { inputMode: options.inputMode } : {}),
  });

/** A proposal by the owner, approved by the admin. */
async function approvedProposal(): Promise<string> {
  const proposed = await service.proposeAllowlist("owner-1", HOOK);
  if (!proposed.ok) throw new Error(proposed.code);
  expect(await approvals.decide(proposed.value.approvalId, "admin-1", "approved")).toBe("ok");
  return proposed.value.approvalId;
}

const apply = (approvalId: string, options: { userId?: string; inputMode?: InputMode } = {}) =>
  flow.apply({ userId: options.userId ?? "owner-1", role: "owner", traceId: "t", ...(options.inputMode ? { inputMode: options.inputMode } : {}) }, HOOK, approvalId);

const SECRETS = ["https://evil", "www.evil", "abc123", SECRET_PATH, "token="];
const noSecrets = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
};

describe("inspection — sanitized, from the catalog alone", () => {
  it("shows exactly the allowed fields, with links removed and nothing guessed — and n8n is not called", async () => {
    const callsBefore = catalog.calls.length;
    const result = await service.inspect("member-1", HOOK);
    if (!result.ok) throw new Error(result.code);
    const view = result.value;
    expect(Object.keys(view).sort()).toEqual(
      [
        "entryId", "name", "active", "presence", "versionId", "observedAt", "trigger", "nodeTypes", "integrations", "inputs",
        "stale", "limitations", "inspectedAt", "source", "allowlist", "proposal", "canPropose", "proposeBlockedReason",
      ].sort()
    );
    expect(view.name).toBe("Invoice sync — see [link removed] or [link removed]");
    expect(view.trigger).toEqual({ status: "derived", kinds: [{ kind: "webhook", nodeType: "n8n-nodes-base.webhook" }] });
    expect(view.integrations.categories.map((c) => c.category)).toEqual(["http", "messaging"]);
    expect(view.integrations.unrecognized).toEqual(["community-nodes.unknownThing"]);
    expect(view.inputs.available).toBe(false);
    expect(view.source).toBe("catalog");
    expect(view.canPropose).toBe(false); // a member
    expect(targetCalls).toEqual([]);
    expect(catalog.calls.length).toBe(callsBefore);
    noSecrets(view);
  });

  it("refuses an outsider, and shows nothing of another Organization's catalog", async () => {
    expect(await service.inspect("owner-other", HOOK)).toMatchObject({ ok: false, status: 403, code: "NOT_AVAILABLE" });
    tenancy.setOwner("n8n", "rest", OTHER);
    expect(await service.inspect("owner-1", HOOK)).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });
    // The new owner's catalog is its own, and holds nothing yet.
    expect(await service.inspect("owner-other", HOOK)).toMatchObject({ ok: false, status: 404, code: "ENTRY_NOT_FOUND" });
  });

  it("finds nothing on another n8n instance — the catalog is per connection", async () => {
    build(OTHER_INSTANCE);
    expect(await service.inspect("owner-1", HOOK)).toMatchObject({ ok: false, status: 404, code: "ENTRY_NOT_FOUND" });
  });

  it("refuses an id that is not one, and says plainly when there is no such entry", async () => {
    expect(await service.inspect("owner-1", "../etc")).toMatchObject({ ok: false, status: 400, code: "INVALID_ENTRY" });
    expect(await service.inspect("owner-1", "wf-unknown")).toMatchObject({ ok: false, status: 404, code: "ENTRY_NOT_FOUND" });
  });

  it("reports unsupported metadata as unavailable, never filled in", async () => {
    const noNodes = await service.inspect("owner-1", "wf-nonodes");
    expect(noNodes.ok && noNodes.value).toMatchObject({
      trigger: { status: "unavailable", kinds: [] },
      nodeTypes: { status: "unavailable" },
      integrations: { status: "unavailable" },
      canPropose: false,
    });
    const noVersion = await service.inspect("owner-1", "wf-noversion");
    expect(noVersion.ok && noVersion.value).toMatchObject({ versionId: null, canPropose: false });
    expect(await service.proposeAllowlist("owner-1", "wf-noversion")).toMatchObject({ ok: false, code: "VERSION_UNKNOWN" });
    expect(await service.proposeAllowlist("owner-1", "wf-cron")).toMatchObject({ ok: false, code: "NO_WEBHOOK_TRIGGER" });
  });

  it("marks an entry missing from the last complete scan as stale, and will not propose it", async () => {
    catalog.workflows = workflows().filter((w) => w.id !== HOOK);
    const again = await service.requestSync("owner-1");
    if (again.ok) await again.value.completion;
    const view = await service.inspect("owner-1", HOOK);
    expect(view.ok && view.value).toMatchObject({ presence: "missing", stale: { stale: true }, canPropose: false });
    expect(await service.proposeAllowlist("owner-1", HOOK)).toMatchObject({ ok: false, code: "ENTRY_STALE" });
  });

  it("lets an owner or admin propose, and tells others why not", async () => {
    const owner = await service.inspect("owner-1", HOOK);
    const member = await service.inspect("member-1", HOOK);
    expect(owner.ok && owner.value.canPropose).toBe(true);
    expect(member.ok && member.value).toMatchObject({ canPropose: false, proposeBlockedReason: expect.stringMatching(/owner or admin/) });
  });
});

describe("the tools, through ToolExecutor", () => {
  it("inspect and propose answer as the routes do, and need only the platform's read", async () => {
    const tool = await run(INSPECT, "member-1", { entryId: HOOK }, { role: "viewer" });
    const route = await call("member-1", "GET", `/library/workflows/${HOOK}/inspection`);
    expect(tool.status).toBe("completed");
    const { inspectedAt: _a, ...fromTool } = tool.result!.data as Record<string, unknown>;
    const { inspectedAt: _b, ...fromRoute } = route.body.data;
    expect(fromTool).toEqual(fromRoute);

    const refused = await run(PROPOSE, "member-1", { entryId: HOOK }, { role: "owner" });
    const refusedRoute = await call("member-1", "POST", `/library/workflows/${HOOK}/allowlist-proposals`, {});
    expect({ code: refused.result?.metadata?.code, message: refused.result?.error }).toEqual({ code: refusedRoute.body.error?.code, message: refusedRoute.body.error?.message });
    expect(refused.result?.metadata?.code).toBe("PERMISSION_DENIED");
  });

  it("accept only the entry id — no scope, no workflow data, no options", async () => {
    expect((await run(INSPECT, "owner-1", { entryId: HOOK, tenantId: OTHER })).result?.metadata?.code).toBe("REQUEST_SCOPE_REFUSED");
    expect((await run(INSPECT, "owner-1", { entryId: HOOK, workflow: { nodes: [{ parameters: { token: "x" } }] } })).result?.metadata?.code).toBe("INVALID_REQUEST");
    expect((await run(PROPOSE, "owner-1", { entryId: HOOK, versionId: "v-9" })).result?.metadata?.code).toBe("INVALID_REQUEST");
    expect(approvals.rows.size).toBe(0);
  });

  it("never gives an agent the change itself", () => {
    for (const policy of Object.values(AGENT_POLICIES)) expect(policy.allowedTools, policy.agentId).not.toContain(ADD);
    expect(AGENT_POLICIES["automation-agent"]!.allowedTools).toEqual(expect.arrayContaining([INSPECT, PROPOSE]));
  });

  it("runs the change only with an approval: without one it is only asked for", async () => {
    const asked = await run(ADD, "owner-1", { entryId: HOOK, versionId: "v-1" }, { role: "owner" });
    expect(asked.status).toBe("approval_pending");
    expect(allowRows).toEqual([]);
    expect(targetCalls).toEqual([]);
  });
});

describe("a proposal is one Organization-bound approval", () => {
  it("is bound to the Organization from the owner record, and to the exact entry and version — a retry returns it", async () => {
    const first = await service.proposeAllowlist("owner-1", HOOK);
    const again = await service.proposeAllowlist("owner-1", HOOK);
    expect(first).toMatchObject({ ok: true, value: { existing: false, status: "awaiting_approval", entryId: HOOK, versionId: "v-1" } });
    expect(again).toMatchObject({ ok: true, value: { existing: true } });
    if (!first.ok || !again.ok) return;
    expect(again.value.approvalId).toBe(first.value.approvalId);
    expect(approvals.rows.size).toBe(1);
    const row = approvals.rows.get(first.value.approvalId)!;
    expect(row).toMatchObject({ toolId: ADD, tenantId: ORG, params: { entryId: HOOK, versionId: "v-1" }, riskLevel: "HIGH_IMPACT" });
    expect(audits.filter((a) => a.action === "automation_library.allowlist_propose")).toEqual([
      expect.objectContaining({ result: "success", metadata: expect.objectContaining({ approvalId: first.value.approvalId, entryId: HOOK, versionId: "v-1", tenantId: ORG }) }),
    ]);
  });

  it("is approved only by ANOTHER owner or admin", async () => {
    const proposed = await service.proposeAllowlist("owner-1", HOOK);
    if (!proposed.ok) throw new Error(proposed.code);
    expect(await approvals.decide(proposed.value.approvalId, "owner-1", "approved")).toBe("self_approval_forbidden");
    expect(await approvals.decide(proposed.value.approvalId, "member-1", "approved")).toBe("not_an_approver");
    expect(await apply(proposed.value.approvalId)).toMatchObject({ ok: false, status: 409, code: "PROPOSAL_AWAITING_APPROVAL" });
    expect(await approvals.decide(proposed.value.approvalId, "admin-1", "approved")).toBe("ok");
  });

  it("tells the approver what the change is and is not — from the ids alone", async () => {
    const proposed = await service.proposeAllowlist("owner-1", HOOK);
    if (!proposed.ok) throw new Error(proposed.code);
    const row = approvals.rows.get(proposed.value.approvalId)!;
    const summary = buildApprovalSummary(row.toolId, row.params);
    expect(summary.actionSummary).toMatch(/trigger allow-list/);
    expect(summary.actionSummary).toMatch(/Nothing in n8n changes and nothing runs/);
    expect(summary.detailLines).toEqual([
      { label: "Workflow", value: HOOK },
      { label: "Version", value: "v-1" },
    ]);
    noSecrets(summary);
  });
});

describe("applying an approved proposal", () => {
  it("re-checks everything, reads n8n once, consumes the approval and adds the row — nothing is run", async () => {
    const approvalId = await approvedProposal();
    const applied = await apply(approvalId);
    expect(applied).toEqual({ ok: true, value: { entryId: HOOK, versionId: "v-1", outcome: "created" } });
    expect(allowRows).toEqual([{ userId: "owner-1", name: expect.stringContaining("[link removed]"), webhookPath: SECRET_PATH, entryRef: `${instanceKey}:${HOOK}`, versionId: "v-1" }]);
    expect(targetCalls).toEqual([HOOK]);
    expect(approvals.status(approvalId)).toBe("consumed");
    expect(triggered).toBe(0);

    const view = await service.inspect("owner-1", HOOK);
    expect(view.ok && view.value).toMatchObject({ allowlist: { status: "on_allowlist", registeredVersionId: "v-1" }, proposal: { status: "used" }, canPropose: false });
    noSecrets(view);
    noSecrets(applied);
    expect(audits.filter((a) => a.action === "automation_library.allowlist_apply")).toEqual([
      expect.objectContaining({ result: "success", metadata: expect.objectContaining({ outcome: "created", tenantId: ORG }) }),
    ]);
  });

  it("adds once: a repeated click and two clicks at once leave one row", async () => {
    const approvalId = await approvedProposal();
    const [a, b] = await Promise.all([apply(approvalId), apply(approvalId)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await apply(approvalId)).toMatchObject({ ok: false, status: 409, code: "PROPOSAL_USED" });
    expect(allowRows).toHaveLength(1);
    expect(allowlist.registerLibraryWorkflow).toHaveBeenCalledTimes(1);
  });

  it("is bound to the version: a change in the library or in n8n refuses it, and the approval is not spent", async () => {
    const approvalId = await approvedProposal();
    targets.set(HOOK, { versionId: "v-9", webhooks: [{ path: SECRET_PATH, method: "POST", authentication: "none" }] });
    expect(await apply(approvalId)).toMatchObject({ ok: false, code: "VERSION_CHANGED" });
    expect(approvals.status(approvalId)).toBe("approved");

    // The library moved on while n8n still answers with the proposal's
    // version: the catalog's own check refuses, before n8n is read.
    targets.set(HOOK, { versionId: "v-1", webhooks: [{ path: SECRET_PATH, method: "POST", authentication: "none" }] });
    catalog.workflows = workflows().map((w) => (w.id === HOOK ? { ...w, versionId: "v-2" } : w));
    const resync = await service.requestSync("owner-1", { restart: true });
    if (resync.ok) await resync.value.completion;
    const readsBefore = targetCalls.length;
    expect(await apply(approvalId)).toMatchObject({ ok: false, code: "VERSION_CHANGED" });
    expect(targetCalls).toHaveLength(readsBefore);
    expect(approvals.status(approvalId)).toBe("approved");
    expect(allowRows).toEqual([]);
  });

  it("refuses an entry that went stale after its approval — before n8n is read", async () => {
    const approvalId = await approvedProposal();
    catalog.workflows = workflows().filter((w) => w.id !== HOOK);
    const again = await service.requestSync("owner-1");
    if (again.ok) await again.value.completion;
    expect(await apply(approvalId)).toMatchObject({ ok: false, status: 409, code: "ENTRY_STALE" });
    expect(targetCalls).toEqual([]);
    expect(approvals.status(approvalId)).toBe("approved");
    expect(allowRows).toEqual([]);
  });

  it("is refused by the service itself to anyone but an owner or admin — nothing read, nothing consumed", async () => {
    // Behind the executor's gate and the store's re-check, the service asks too.
    const consume = vi.fn(async () => ({ ok: true as const }));
    for (const userId of ["member-1", "viewer-1", "owner-other", "stranger"]) {
      const result = await service.applyAllowlist(userId, { entryId: HOOK, versionId: "v-1" }, consume);
      expect(result, userId).toMatchObject({ ok: false, status: 403 });
    }
    expect(consume).not.toHaveBeenCalled();
    expect(targetCalls).toEqual([]);
    expect(allowRows).toEqual([]);
  });

  it("refuses a webhook the trigger could not use — before the approval is spent", async () => {
    const approvalId = await approvedProposal();
    for (const webhooks of [
      [],
      [{ path: "a", method: "POST", authentication: "none" }, { path: "b", method: "POST", authentication: "none" }],
      [{ path: null, method: "POST", authentication: "none" }],
      [{ path: SECRET_PATH, method: "GET", authentication: "none" }],
      [{ path: SECRET_PATH, method: "POST", authentication: "headerAuth" }],
      [{ path: SECRET_PATH, method: "POST", authentication: null }],
    ]) {
      targets.set(HOOK, { versionId: "v-1", webhooks });
      const result = await apply(approvalId);
      expect(result).toMatchObject({ ok: false, status: 409, code: "WEBHOOK_UNUSABLE" });
      noSecrets(result);
    }
    targetFails = true;
    expect(await apply(approvalId)).toMatchObject({ ok: false, status: 503, code: "PROVIDER_UNAVAILABLE" });
    expect(approvals.status(approvalId)).toBe("approved");
    expect(allowRows).toEqual([]);
  });

  it("refuses when the requester, the approver or the Organization changed", async () => {
    const approvalId = await approvedProposal();
    tenancy.setRole("owner-1", ORG, "member");
    expect(await apply(approvalId)).toMatchObject({ ok: false, status: 403 });
    tenancy.setRole("owner-1", ORG, "owner");

    tenancy.setRole("admin-1", ORG, "member");
    expect(await apply(approvalId)).toMatchObject({ ok: false, code: "APPROVAL_REFUSED" });
    tenancy.setRole("admin-1", ORG, "admin");
    expect(allowRows).toEqual([]);

    // The same approval is still approved and unspent: refusals spend nothing.
    expect(approvals.status(approvalId)).toBe("approved");
    tenancy.setOwner("n8n", "rest", OTHER);
    expect(await apply(approvalId)).toMatchObject({ ok: false, status: 403 });
    expect(allowRows).toEqual([]);
  });

  it("changes nothing for a rejected, an expired or another person's proposal — and records why", async () => {
    const proposed = await service.proposeAllowlist("owner-1", HOOK);
    if (!proposed.ok) throw new Error(proposed.code);
    await approvals.decide(proposed.value.approvalId, "admin-1", "rejected");
    expect(await apply(proposed.value.approvalId)).toMatchObject({ ok: false, status: 409, code: "PROPOSAL_REJECTED" });

    const approvalId = await approvedProposal();
    expect(await apply(approvalId, { userId: "admin-1" })).toMatchObject({ ok: false, status: 404, code: "PROPOSAL_NOT_FOUND" });
    approvals.now = () => Date.now() + 11 * 60_000;
    expect(await apply(approvalId)).toMatchObject({ ok: false, status: 410, code: "PROPOSAL_EXPIRED" });
    expect(allowRows).toEqual([]);
    expect(audits.filter((a) => a.action === "automation_library.allowlist_apply").map((a) => a.metadata?.reason)).toEqual(["PROPOSAL_REJECTED", "PROPOSAL_EXPIRED"]);
  });
});

describe("a spoken apply never reaches the change (Stage 18.3A)", () => {
  it("is refused by the flow before the executor, by the executor, and by the tool", async () => {
    const approvalId = await approvedProposal();
    const execute = vi.spyOn(executor, "execute");
    expect(await apply(approvalId, { inputMode: "voice" })).toMatchObject({ ok: false, status: 403, code: "VOICE_NOT_ALLOWED", message: VOICE_CONFIRMATION_REFUSED_MESSAGE });
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();

    const direct = await run(ADD, "owner-1", { entryId: HOOK, versionId: "v-1" }, { role: "owner", approvalId, inputMode: "voice" });
    expect(direct).toMatchObject({ status: "permission_denied", error: VOICE_CONFIRMATION_REFUSED_MESSAGE });

    const tool = registry.get(ADD)!;
    expect(await tool.execute({ entryId: HOOK, versionId: "v-1" }, { userId: "owner-1", approvalId, inputMode: "voice" })).toMatchObject({
      success: false,
      metadata: { code: "VOICE_NOT_ALLOWED" },
    });
    expect(approvals.status(approvalId)).toBe("approved");
    expect(targetCalls).toEqual([]);
    expect(allowRows).toEqual([]);
  });
});

describe("the routes", () => {
  it("inspect, propose (201, then the same proposal), and apply on screen", async () => {
    expect((await call("member-1", "GET", `/library/workflows/${HOOK}/inspection`)).status).toBe(200);
    const proposed = await call("owner-1", "POST", `/library/workflows/${HOOK}/allowlist-proposals`, {});
    expect(proposed.status).toBe(201);
    const again = await call("owner-1", "POST", `/library/workflows/${HOOK}/allowlist-proposals`, {});
    expect(again.status).toBe(200);
    expect(again.body.data.approvalId).toBe(proposed.body.data.approvalId);
    const approvalId = proposed.body.data.approvalId as string;

    expect((await call("owner-1", "POST", `/library/workflows/${HOOK}/allowlist-proposals/${approvalId}/apply`, {})).body.error?.code).toBe("PROPOSAL_AWAITING_APPROVAL");
    await approvals.decide(approvalId, "admin-1", "approved");
    const spoken = await call("owner-1", "POST", `/library/workflows/${HOOK}/allowlist-proposals/${approvalId}/apply`, { inputMode: "voice" });
    expect(spoken.status).toBe(403);
    const applied = await call("owner-1", "POST", `/library/workflows/${HOOK}/allowlist-proposals/${approvalId}/apply`, {});
    expect(applied).toMatchObject({ status: 200, body: { data: { entryId: HOOK, outcome: "created" } } });
    noSecrets(applied.body);
  });

  it("refuses a scope field, a bad proposal id and an unknown input mode", async () => {
    expect((await call("owner-1", "POST", `/library/workflows/${HOOK}/allowlist-proposals`, { tenantId: OTHER })).body.error?.code).toBe("REQUEST_SCOPE_REFUSED");
    expect((await call("owner-1", "GET", `/library/workflows/${HOOK}/inspection?url=https://x`)).body.error?.code).toBe("REQUEST_SCOPE_REFUSED");
    expect((await call("owner-1", "POST", `/library/workflows/${HOOK}/allowlist-proposals/bad..id/apply`, {})).status).toBe(400);
    expect((await call("owner-1", "POST", `/library/workflows/${HOOK}/allowlist-proposals/apr_0001/apply`, { inputMode: "shout" })).status).toBe(400);
    expect(approvals.rows.size).toBe(0);
  });
});

describe("nothing secret leaves", () => {
  it("in any audit row or log line, across the whole lifecycle", async () => {
    await service.inspect("owner-1", HOOK);
    const approvalId = await approvedProposal();
    targets.set(HOOK, { versionId: "v-1", webhooks: [{ path: SECRET_PATH, method: "GET", authentication: "none" }] });
    await apply(approvalId);
    targets.set(HOOK, { versionId: "v-1", webhooks: [{ path: SECRET_PATH, method: "POST", authentication: "none" }] });
    await apply(approvalId);
    noSecrets(audits);
    noSecrets(logs);
    expect(triggered).toBe(0);
  });
});
