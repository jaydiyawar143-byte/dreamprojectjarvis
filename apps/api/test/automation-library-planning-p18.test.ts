// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — workflow matching and drafts, end to end on fakes:
// the real AutomationLibraryService (authorization, scope, catalog), the real
// AutomationPlanningService, the real router, the real tools and ToolExecutor,
// over an in-memory catalog, tenancy and draft store.
//
// Proven here:
//   • matching ranks and explains from the catalog, says "no match" and
//     "insufficient evidence" plainly, and never reads n8n;
//   • a new draft is refused while the library already covers the request,
//     unless the requester overrides it; a retry returns the same draft;
//   • a customization is bound to its source entry and version, and goes stale
//     when the source moves on — and a stale draft cannot be revised;
//   • versions are immutable: a revision appends; the version it was based on
//     never changes; a revision of an older version is refused; a retry and
//     two revisions at once leave one new version;
//   • invalid structures, n8n parameters, credentials, secrets and expressions
//     are refused and nothing is stored;
//   • the Organization decides: members match and read, owners and admins
//     draft; an outsider, another Organization or another instance sees none;
//   • the routes and the tools (through ToolExecutor) answer alike, voice may
//     ask, and nothing here creates an approval, touches the allow-list,
//     reaches n8n or runs a workflow.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AUTOMATION_PLANNING_TOOL_IDS,
  DRAFT_CHECK_MESSAGES,
  libraryInstanceKey,
  type AuditLogger,
  type DraftView,
  type ITool,
  type InputMode,
  type LibraryRemoteWorkflow,
} from "@jarvis/core";
import { ApprovalService, PermissionService } from "@jarvis/security";
import { ToolExecutor, ToolRegistry, createAutomationPlanningTools } from "@jarvis/tools";
import { createAutomationPlanningRouter } from "../src/routes/automation-planning.js";
import { AutomationLibraryService } from "../src/services/automation-library/library-service.js";
import { AutomationPlanningService } from "../src/services/automation-library/planning-service.js";
import { createSharedConnectionToolGate } from "../src/services/tenancy/shared-connection-access.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "./helpers/shared-access.js";
import { fakeN8nCatalog, memoryLibraryStore, type FakeN8nCatalog, type MemoryLibraryStore } from "./helpers/memory-library.js";
import { MemoryDraftStore } from "./helpers/memory-drafts.js";
import { MemoryOrgApprovals } from "./helpers/memory-org-approvals.js";

const ORG = "org-plan";
const OTHER = "org-other";
const INSTANCE = libraryInstanceKey("https://n8n.internal.example.test")!;
const OTHER_INSTANCE = libraryInstanceKey("https://n8n-two.internal.example.test")!;
const { match: MATCH, draftCreate: CREATE, draftRevise: REVISE, draftGet: GET } = AUTOMATION_PLANNING_TOOL_IDS;

const wf = (id: string, name: string, nodeTypes: string[] | null, extra: Partial<LibraryRemoteWorkflow> = {}): LibraryRemoteWorkflow => ({
  id,
  name,
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  versionId: "v-1",
  tags: [],
  nodeTypes,
  nodeCount: nodeTypes?.length ?? null,
  ...extra,
});

function workflows(): LibraryRemoteWorkflow[] {
  return [
    wf("wf-lead", "Lead form to Slack and Sheets", ["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack", "n8n-nodes-base.googleSheets"]),
    wf("wf-alerts", "Form alerts", ["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack"], { tags: ["lead"] }),
    wf("wf-report", "Nightly report", ["n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.gmail"]),
    wf("wf-blind", "Lead intake", null),
    wf("wf-hostile", "Ops https://evil.example/steal?id=1", ["n8n-nodes-base.webhook", "n8n-nodes-base.httpRequest"], { tags: ["SECRET-TAG-VALUE"] }),
  ];
}

/** Every request in these tests answers all its questions, so a draft's status is the checks'. */
const LEADS = {
  goal: "When a lead form is submitted, post it to Slack and add a row to Google Sheets",
  inputs: ["email"],
  outcome: "The team sees each lead",
};

let server: Server;
let base = "";
let tenancy: MemoryTenancy;
let store: MemoryLibraryStore;
let catalog: FakeN8nCatalog;
let drafts: MemoryDraftStore;
let library: AutomationLibraryService;
let planning: AutomationPlanningService;
let executor: ToolExecutor;
let approvals: MemoryOrgApprovals;
let audits: Array<{ userId: string; action: string; result: string; metadata?: Record<string, unknown> }>;
let logs: string[];
let triggered: number;
let n8nReadsAfterSync: number;

function build(instanceKey = INSTANCE) {
  const audit = { log: async (entry: (typeof audits)[number]) => void audits.push(entry) };
  const log = { info: (e: string, f?: unknown) => void logs.push(JSON.stringify([e, f])), warn: (e: string, f?: unknown) => void logs.push(JSON.stringify([e, f])) };
  library = new AutomationLibraryService({
    store,
    access: accessOver(tenancy),
    source: { pages: catalog, instanceKey },
    budget: { reserveForUser: async () => ({ allowed: true }), reserveForOrganization: async () => ({ allowed: true }) },
    audit,
    limits: { pageSize: 50, maxPagesPerRun: 5 },
    log,
  });
  planning = new AutomationPlanningService({ catalog: library, entries: store, drafts, audit, log });
  const registry = new ToolRegistry();
  for (const tool of createAutomationPlanningTools(planning)) registry.register(tool);
  // The trigger exists beside them, and must never be reached by any of this.
  registry.register({
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
  } satisfies ITool);
  executor = new ToolExecutor(registry, new PermissionService(), new ApprovalService(approvals), { log: async () => undefined } as unknown as AuditLogger, {
    accessGate: createSharedConnectionToolGate(accessOver(tenancy)),
  });
}

const tokenService = {
  verifyAccessToken: (token: string) => {
    const userId = token.replace(/^tok-/, "");
    return userId ? { userId, role: "owner", email: `${userId}@test.local` } : null;
  },
};

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use("/planning", (req, res, next) => createAutomationPlanningRouter({ tokenService, automationPlanning: planning } as never)(req, res, next));
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
  drafts = new MemoryDraftStore();
  approvals = new MemoryOrgApprovals(tenancy);
  audits = [];
  logs = [];
  triggered = 0;
  build();
  await resync();
  n8nReadsAfterSync = catalog.calls.length;
});

async function resync() {
  const synced = await library.requestSync("owner-1", { restart: true });
  if (!synced.ok) throw new Error(synced.code);
  await synced.value.completion;
}

async function call(userId: string, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${base}/planning${path}`, {
    method,
    headers: { authorization: `Bearer tok-${userId}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as { success: boolean; data?: any; error?: { code: string; message: string; issues?: Array<{ code: string; path: string }> } } };
}

const run = (toolId: string, userId: string, params: Record<string, unknown>, inputMode?: InputMode) =>
  executor.execute({ toolId, params, userId, role: "member", traceId: `trace-${userId}`, ...(inputMode ? { inputMode } : {}) });

async function created(userId: string, input: Record<string, unknown>): Promise<DraftView> {
  const result = await planning.createDraft(userId, input);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value.draft;
}

/** No n8n read beyond the sync that filled the catalog, and nothing triggered. */
const nothingReachedN8n = () => {
  expect(catalog.calls.length).toBe(n8nReadsAfterSync);
  expect(triggered).toBe(0);
};

describe("matching", () => {
  it("recommends reuse with its reasons — the route and the tool alike — and reads no n8n", async () => {
    const viaRoute = await call("member-1", "POST", "/match", LEADS);
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.body.data).toMatchObject({ outcome: "reuse", canDraft: false, candidates: [{ entryId: "wf-lead", fit: "reuse" }, { entryId: "wf-alerts", fit: "customize" }] });
    expect(viaRoute.body.data.searched).toEqual({ compared: 5, catalogTotal: 5, method: "full", complete: true });

    const viaTool = await run(MATCH, "owner-1", LEADS);
    expect(viaTool.status).toBe("completed");
    const { canDraft, ...toolMatch } = viaTool.result!.data as Record<string, unknown>;
    const { canDraft: _member, ...routeMatch } = viaRoute.body.data;
    expect(toolMatch).toEqual(routeMatch);
    expect(canDraft).toBe(true);
    nothingReachedN8n();
  });

  it("says no match, and insufficient evidence, plainly", async () => {
    const none = await planning.match("member-1", { goal: "Every hour send a Telegram message", trigger: "schedule" });
    expect(none).toMatchObject({ ok: true, value: { outcome: "no_match", candidates: [] } });
    const vague = await planning.match("member-1", { goal: "do it" });
    expect(vague).toMatchObject({ ok: true, value: { outcome: "insufficient_evidence" } });
  });

  it("names what it could not compare, and never echoes a link or a tag", async () => {
    const result = await planning.match("member-1", { goal: "When a webhook arrives, call an HTTP request for ops" });
    expect(result.ok && result.value.limitations).toEqual(expect.arrayContaining([expect.stringMatching(/carried no node types/)]));
    const text = JSON.stringify(result);
    for (const leak of ["evil.example", "SECRET-TAG-VALUE"]) expect(text, leak).not.toContain(leak);
  });

  it("refuses an outsider, a scope field, and a server without n8n", async () => {
    expect(await call("owner-other", "POST", "/match", LEADS)).toMatchObject({ status: 403, body: { error: { code: "NOT_AVAILABLE" } } });
    expect(await call("owner-1", "POST", "/match", { ...LEADS, tenantId: OTHER })).toMatchObject({ status: 400, body: { error: { code: "REQUEST_SCOPE_REFUSED" } } });
    library = new AutomationLibraryService({ store, access: accessOver(tenancy), source: null, budget: undefined, audit: { log: async () => undefined } });
    const unconfigured = new AutomationPlanningService({ catalog: library, entries: store, drafts, audit: { log: async () => undefined } });
    expect(await unconfigured.match("owner-1", LEADS)).toMatchObject({ ok: false, status: 503, code: "N8N_NOT_CONFIGURED" });
  });
});

describe("drafts — reuse first, then a versioned plan in JARVIS", () => {
  it("refuses a new draft the library already covers, unless overridden — and a retry is the same draft", async () => {
    const refused = await call("owner-1", "POST", "/drafts", { ...LEADS, kind: "new" });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "REUSE_AVAILABLE" } } });
    expect(refused.body.error!.message).toMatch(/^"Lead form to Slack and Sheets" \(wf-lead\) in the library appears to cover this request/);
    expect(drafts.drafts.size).toBe(0);

    const first = await call("owner-1", "POST", "/drafts", { ...LEADS, kind: "new", overrideReuse: true });
    const again = await call("owner-1", "POST", "/drafts", { ...LEADS, kind: "new", overrideReuse: true });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.data.existing).toBe(true);
    expect(again.body.data.draft.draftId).toBe(first.body.data.draft.draftId);
    expect(drafts.drafts.size).toBe(1);

    const draft = first.body.data.draft as DraftView;
    expect(draft.content.nodes.map((n) => n.type)).toEqual(["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack", "n8n-nodes-base.googleSheets"]);
    expect(draft.status).toBe("unverified");
    expect(draft.checks.find((c) => c.id === "configuration_schema")).toMatchObject({ status: "not_run", message: DRAFT_CHECK_MESSAGES.configurationSchema });
    expect(draft.checks.find((c) => c.id === "scope")!.status).toBe("passed");
    expect(draft.version).toMatchObject({ number: 1, isLatest: true, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(audits.filter((a) => a.action === "automation_planning.draft_create").map((a) => [a.result, a.metadata?.code ?? a.metadata?.existing])).toEqual([
      ["rejected", "REUSE_AVAILABLE"],
      ["success", false],
      ["success", true],
    ]);
    nothingReachedN8n();
  });

  it("binds a customization to its source entry and version, and shows it stale when the source moves on", async () => {
    const draft = await created("admin-1", { ...LEADS, kind: "customization", sourceEntryId: "wf-alerts" });
    expect(draft.content.source).toMatchObject({ entryId: "wf-alerts", versionId: "v-1", nodeTypes: ["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack"] });
    expect(draft.diff.nodesAdded.map((n) => n.type)).toEqual(["n8n-nodes-base.googleSheets"]);
    expect(draft.diff.connectionsAdded).toEqual([expect.objectContaining({ from: "source-trigger", to: "googlesheets" })]);
    expect(draft.source).toMatchObject({ drift: "none", currentVersionId: "v-1" });
    expect(draft.checks.find((c) => c.id === "source_graph")!.status).toBe("not_run");

    catalog.workflows = workflows().map((w) => (w.id === "wf-alerts" ? { ...w, versionId: "v-2" } : w));
    await resync();
    const read = await planning.getDraft("viewer-1", draft.draftId);
    expect(read).toMatchObject({ ok: true, value: { status: "stale", canRevise: false, source: { drift: "changed", currentVersionId: "v-2" } } });
    expect(await planning.reviseDraft("admin-1", draft.draftId, { baseVersion: 1, answers: { "question.x": "y" } })).toMatchObject({ ok: false, status: 409, code: "DRAFT_STALE" });

    catalog.workflows = workflows().filter((w) => w.id !== "wf-alerts");
    await resync();
    expect(await planning.getDraft("viewer-1", draft.draftId)).toMatchObject({ ok: true, value: { status: "stale", source: { drift: "missing" } } });
  });

  it("refuses to customize what it cannot bind to", async () => {
    expect(await planning.createDraft("owner-1", { ...LEADS, kind: "customization", sourceEntryId: "wf-nope" })).toMatchObject({ ok: false, status: 404, code: "ENTRY_NOT_FOUND" });
    expect(await planning.createDraft("owner-1", { ...LEADS, kind: "customization", sourceEntryId: "wf-blind" })).toMatchObject({ ok: false, status: 409, code: "NODE_TYPES_UNKNOWN" });
  });
});

describe("versions are immutable", () => {
  const graph = {
    nodes: [
      { key: "form", type: "n8n-nodes-base.formTrigger" },
      { key: "slack", type: "n8n-nodes-base.slack", settings: [{ key: "channel", label: "Which channel?" }] },
    ],
    connections: [{ from: "form", to: "slack" }],
  };

  it("appends a version for each revision, and never changes the one it was based on", async () => {
    const draft = await created("owner-1", { goal: "When a support form is submitted, notify Slack", inputs: ["ticket"], outcome: "Support sees it", kind: "new", overrideReuse: true, ...graph });
    expect(draft.status).toBe("needs_input");
    const v1Hash = draft.version.contentHash;

    const revised = await call("admin-1", "POST", `/drafts/${draft.draftId}/versions`, { baseVersion: 1, answers: { "slack.channel": "#support" } });
    expect(revised.status).toBe(201);
    expect(revised.body.data.draft).toMatchObject({ status: "unverified", latestVersion: 2, version: { number: 2, isLatest: true } });
    expect(revised.body.data.draft.history.map((h: { version: number }) => h.version)).toEqual([2, 1]);

    const v1 = await call("viewer-1", "GET", `/drafts/${draft.draftId}?version=1`);
    expect(v1.body.data).toMatchObject({ version: { number: 1, isLatest: false, contentHash: v1Hash }, canRevise: false });
    expect(v1.body.data.content.nodes[1].settings[0].value).toBeNull();

    // A revision of the older version is refused, not merged.
    expect(await call("owner-1", "POST", `/drafts/${draft.draftId}/versions`, { baseVersion: 1, answers: { "slack.channel": "#other" } })).toMatchObject({
      status: 409,
      body: { error: { code: "DRAFT_CHANGED" } },
    });
    // The same revision again — a retry — is the version already stored.
    const retry = await call("admin-1", "POST", `/drafts/${draft.draftId}/versions`, { baseVersion: 1, answers: { "slack.channel": "#support" } });
    expect(retry).toMatchObject({ status: 200, body: { data: { unchanged: true, draft: { version: { number: 2 } } } } });
    expect(drafts.versions.get(draft.draftId)!.length).toBe(2);
  });

  it("stores one of two revisions made at once", async () => {
    const draft = await created("owner-1", { goal: "When a support form is submitted, notify Slack", inputs: ["ticket"], outcome: "Support sees it", kind: "new", overrideReuse: true, ...graph });
    const [a, b] = await Promise.all([
      planning.reviseDraft("owner-1", draft.draftId, { baseVersion: 1, answers: { "slack.channel": "#a" } }),
      planning.reviseDraft("admin-1", draft.draftId, { baseVersion: 1, answers: { "slack.channel": "#b" } }),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ status: 409, code: "DRAFT_CHANGED" });
    expect(drafts.versions.get(draft.draftId)!.map((v) => v.version)).toEqual([1, 2]);
  });

  it("cannot be given a version number, a hash or a status by its caller", async () => {
    const draft = await created("owner-1", { goal: "When a support form is submitted, notify Slack", inputs: ["ticket"], outcome: "Support sees it", kind: "new", overrideReuse: true, ...graph });
    for (const field of ["version", "contentHash", "status"]) {
      expect(await planning.reviseDraft("owner-1", draft.draftId, { baseVersion: 1, answers: { "slack.channel": "#x" }, [field]: "validated" }), field).toMatchObject({
        ok: false,
        code: "REQUEST_SCOPE_REFUSED",
      });
    }
  });
});

describe("what a draft may hold", () => {
  const SECRETS = ["xoxb-1234567890-abcdefghijkl", "sk-live-abcdefghijklmnop", "hunter2-password"];

  it("refuses invalid structure, n8n fields, credentials, secrets and expressions — storing nothing", async () => {
    const attempts: Array<[Record<string, unknown>, string]> = [
      [{ nodes: [{ key: "x", type: "n8n-nodes-base.code" }], connections: [] }, "UNSUPPORTED_NODE_TYPE"],
      [{ nodes: [{ key: "x", type: "n8n-nodes-base.webhook", parameters: { path: "x", authentication: "none" } }], connections: [] }, "N8N_FIELD_REFUSED"],
      [
        {
          nodes: [
            { key: "hook", type: "n8n-nodes-base.webhook" },
            { key: "slack", type: "n8n-nodes-base.slack", settings: [{ key: "account", label: "Slack token", kind: "credential", value: SECRETS[0] }] },
          ],
          connections: [{ from: "hook", to: "slack" }],
        },
        "CREDENTIAL_VALUE_REFUSED",
      ],
      [
        {
          nodes: [
            { key: "hook", type: "n8n-nodes-base.webhook" },
            { key: "slack", type: "n8n-nodes-base.slack", settings: [{ key: "channel", label: "Channel", value: SECRETS[1] }] },
          ],
          connections: [{ from: "hook", to: "slack" }],
        },
        "SECRET_REFUSED",
      ],
      [
        {
          nodes: [
            { key: "hook", type: "n8n-nodes-base.webhook" },
            { key: "slack", type: "n8n-nodes-base.slack", settings: [{ key: "channel", label: "Channel", value: "{{ $env.SLACK_CHANNEL }}" }] },
          ],
          connections: [{ from: "hook", to: "slack" }],
        },
        "INVALID_TEXT",
      ],
      [{ nodes: [{ key: "hook", type: "n8n-nodes-base.webhook" }, { key: "slack", type: "n8n-nodes-base.slack" }], connections: [] }, "DISCONNECTED_NODE"],
    ];
    for (const [graph, code] of attempts) {
      const result = await call("owner-1", "POST", "/drafts", { goal: "When a webhook arrives, ping Slack", kind: "new", overrideReuse: true, ...graph });
      expect(result.status, code).toBe(422);
      expect(result.body.error!.issues!.map((i) => i.code), code).toContain(code);
    }
    expect(drafts.drafts.size).toBe(0);
    expect(await call("owner-1", "POST", "/drafts", { goal: `Ping Slack with ${SECRETS[2]} password: hunter2`, kind: "new" })).toMatchObject({
      status: 400,
      body: { error: { code: "SECRET_REFUSED" } },
    });
    const everything = JSON.stringify({ audits, logs, versions: [...drafts.versions.values()] });
    for (const secret of [...SECRETS, "hunter2", "SLACK_CHANNEL"]) expect(everything, secret).not.toContain(secret);
  });

  it("keeps the goal, answers and labels out of the audit log", async () => {
    const draft = await created("owner-1", { goal: "When a Zebrafish form is submitted, notify Slack", outcome: "Aquarium team knows", kind: "new", overrideReuse: true });
    await planning.reviseDraft("owner-1", draft.draftId, { baseVersion: 1, answers: { "question.inputs": "tank number" } });
    const text = JSON.stringify(audits);
    for (const words of ["Zebrafish", "Aquarium", "tank number"]) expect(text, words).not.toContain(words);
    expect(audits.map((a) => a.action).filter((a) => a.startsWith("automation_planning."))).toEqual(["automation_planning.draft_create", "automation_planning.draft_revise"]);
  });
});

describe("whose drafts", () => {
  it("lets members match and read, and only owners and admins draft", async () => {
    const draft = await created("owner-1", { ...LEADS, kind: "customization", sourceEntryId: "wf-alerts" });
    for (const reader of ["member-1", "viewer-1"]) {
      expect(await planning.getDraft(reader, draft.draftId), reader).toMatchObject({ ok: true, value: { canRevise: false } });
      expect(await planning.createDraft(reader, { ...LEADS, kind: "new", overrideReuse: true })).toMatchObject({
        ok: false,
        status: 403,
        code: "PERMISSION_DENIED",
        message: "Only an owner or admin of your organization can create or revise workflow drafts.",
      });
    }
    expect(await planning.getDraft("admin-1", draft.draftId)).toMatchObject({ ok: true, value: { canRevise: true } });
    // Revising is drafting too: a member or viewer is refused, and nothing is stored.
    for (const reader of ["member-1", "viewer-1"]) {
      expect(await planning.reviseDraft(reader, draft.draftId, { baseVersion: 1, answers: { "question.outcome": "x" } }), reader).toMatchObject({
        ok: false,
        status: 403,
        code: "PERMISSION_DENIED",
      });
    }
    expect(drafts.versions.get(draft.draftId)!.length).toBe(1);
  });

  it("shows nothing to an outsider, another Organization or another instance", async () => {
    const draft = await created("owner-1", { ...LEADS, kind: "customization", sourceEntryId: "wf-alerts" });
    expect(await planning.getDraft("owner-other", draft.draftId)).toMatchObject({ ok: false, status: 403, code: "NOT_AVAILABLE" });
    expect(await planning.listDrafts("owner-other", { page: 1, limit: 20 })).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });

    // The connection moves to the other Organization: its owner reads its own catalog, which has no such draft.
    tenancy.setOwner("n8n", "rest", OTHER);
    expect(await planning.getDraft("owner-other", draft.draftId)).toMatchObject({ ok: false, status: 404, code: "DRAFT_NOT_FOUND" });
    expect(await planning.getDraft("owner-1", draft.draftId)).toMatchObject({ ok: false, status: 403 });
    tenancy.setOwner("n8n", "rest", ORG);

    // Another n8n instance is another catalog.
    build(OTHER_INSTANCE);
    expect(await planning.getDraft("owner-1", draft.draftId)).toMatchObject({ ok: false, status: 404, code: "DRAFT_NOT_FOUND" });
    expect(await planning.listDrafts("owner-1", { page: 1, limit: 20 })).toMatchObject({ ok: true, value: { total: 0 } });
  });
});

describe("through ToolExecutor", () => {
  it("drafts and revises by tool exactly as by route — voice may ask, nothing asks for an approval", async () => {
    const createdByTool = await run(CREATE, "owner-1", { ...LEADS, kind: "customization", sourceEntryId: "wf-alerts" }, "voice");
    expect(createdByTool.status).toBe("completed");
    const draft = (createdByTool.result!.data as { draft: DraftView }).draft;
    expect(draft.content.source?.entryId).toBe("wf-alerts");

    const revisedByTool = await run(REVISE, "admin-1", { draftId: draft.draftId, baseVersion: 1, answers: { "question.nope": "x" } });
    expect(revisedByTool.result).toMatchObject({ success: false, metadata: { code: "DRAFT_INVALID", status: 422 } });
    const viaRoute = await call("admin-1", "POST", `/drafts/${draft.draftId}/versions`, { baseVersion: 1, answers: { "question.nope": "x" } });
    expect(viaRoute.body.error!.code).toBe("DRAFT_INVALID");
    expect(viaRoute.body.error!.message).toBe(revisedByTool.result!.error);

    const scoped = await run(CREATE, "owner-1", { ...LEADS, kind: "new", tenantId: OTHER });
    expect(scoped.result).toMatchObject({ success: false, metadata: { code: "REQUEST_SCOPE_REFUSED" } });
    const read = await run(GET, "viewer-1", { draftId: draft.draftId });
    expect(read.status).toBe("completed");

    expect(approvals.rows.size).toBe(0);
    nothingReachedN8n();
  });

  it("answers 503 when the draft store cannot be reached, and stores nothing half-way", async () => {
    drafts.failing = true;
    expect(await planning.createDraft("owner-1", { ...LEADS, kind: "new", overrideReuse: true })).toMatchObject({ ok: false, status: 503, code: "DRAFTS_UNAVAILABLE" });
    expect(await planning.listDrafts("owner-1", { page: 1, limit: 20 })).toMatchObject({ ok: false, status: 503 });
    drafts.failing = false;
    expect(drafts.drafts.size).toBe(0);
  });

  it("has no n8n client to reach: the service is built from the library's authorization, its store and the draft store", () => {
    const deps = (planning as unknown as { deps: Record<string, unknown> }).deps;
    expect(Object.keys(deps).sort()).toEqual(["audit", "catalog", "drafts", "entries", "log"]);
    expect(vi.isMockFunction(catalog.fetchPage)).toBe(false);
  });
});
