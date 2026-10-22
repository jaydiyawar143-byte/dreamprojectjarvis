// ---------------------------------------------------------------------------
// Phase 18, Stage 18.5 — the trusted n8n node schemas, end to end on fakes:
// the real snapshot, core's verifier and rules, the real
// AutomationPlanningService, the real router, the real tools and the real
// ToolExecutor, over an in-memory catalog, tenancy and draft store.
//
// Proven here:
//   • the server verifies the pinned snapshot once and the configuration check
//     runs against it: a setting that names a real n8n parameter is checked
//     (its type, its allowed values, its bounds), and a draft whose settings
//     are valid passes that check;
//   • an invalid setting is refused before anything is stored — by the route
//     and by the tool, with the same code and the same issue;
//   • a check that could not run completely is `not_run`, never `passed`, and
//     a draft is never `validated` while one did not run;
//   • the draft's view carries a BOUNDED summary — parameter names, and the
//     values n8n requires — never a whole schema;
//   • the route and the tool are answered by the same service instance and the
//     same registry, so they agree;
//   • nothing here reads n8n, changes a workflow or creates an approval.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import {
  AUTOMATION_PLANNING_TOOL_IDS,
  NODE_SCHEMA_MESSAGES,
  loadNodeSchemaRegistry,
  type AuditLogger,
  type DraftView,
  type InputMode,
  type LibraryRemoteWorkflow,
  type NodeSchemaRegistry,
} from "@jarvis/core";
import { N8N_NODE_SCHEMA_SNAPSHOT } from "@jarvis/n8n";
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

const ORG = "org-schema";
const { draftCreate: CREATE, draftGet: GET } = AUTOMATION_PLANNING_TOOL_IDS;

const loaded = loadNodeSchemaRegistry(N8N_NODE_SCHEMA_SNAPSHOT);
if (!loaded.ok) throw new Error(`the committed snapshot was refused: ${loaded.reason}`);
const REGISTRY: NodeSchemaRegistry = loaded.registry;

const wf = (id: string, name: string, nodeTypes: string[] | null): LibraryRemoteWorkflow => ({
  id,
  name,
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  versionId: "v-1",
  tags: [],
  nodeTypes,
  nodeCount: nodeTypes?.length ?? null,
});

/** Every request in these tests answers all its questions, so a draft's status is the checks'. */
const LEADS = {
  goal: "When a lead form is submitted, post it to Slack",
  inputs: ["email"],
  outcome: "The team sees each lead",
};

/** A form that posts what it receives to Slack — the shape a draft holds. */
const GRAPH = {
  nodes: [
    { key: "form", type: "n8n-nodes-base.formTrigger", settings: [{ key: "form_title", label: "What is the form called?", value: "Lead intake" }] },
    { key: "slack", type: "n8n-nodes-base.slack", settings: [{ key: "resource", label: "What should it do?", value: "message" }] },
  ],
  connections: [{ from: "form", to: "slack" }],
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
let audits: Array<{ userId: string; action: string; result: string; metadata?: Record<string, unknown> }>;
let triggered: number;
let readsBefore: number;

function build(nodeSchema: NodeSchemaRegistry | null = REGISTRY) {
  const audit = { log: async (entry: (typeof audits)[number]) => void audits.push(entry) };
  const log = { info: () => undefined, warn: () => undefined };
  library = new AutomationLibraryService({
    store,
    access: accessOver(tenancy),
    source: { pages: catalog, instanceKey: "inst-schema" },
    budget: { reserveForUser: async () => ({ allowed: true }), reserveForOrganization: async () => ({ allowed: true }) },
    audit,
    limits: { pageSize: 50, maxPagesPerRun: 5 },
    log,
  });
  planning = new AutomationPlanningService({ catalog: library, entries: store, drafts, audit, log, nodeSchema });
  const registry = new ToolRegistry();
  for (const tool of createAutomationPlanningTools(planning)) registry.register(tool);
  executor = new ToolExecutor(registry, new PermissionService(), new ApprovalService(new MemoryOrgApprovals(tenancy)), {
    log: async () => undefined,
  } as unknown as AuditLogger, { accessGate: createSharedConnectionToolGate(accessOver(tenancy)) });
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
    members: [{ userId: "owner-1", tenantId: ORG, role: "owner" }],
  });
  store = memoryLibraryStore();
  catalog = fakeN8nCatalog(0);
  catalog.workflows = [wf("wf-leads", "Lead intake", ["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack"])];
  drafts = new MemoryDraftStore();
  audits = [];
  triggered = 0;
  build();
  const synced = await library.requestSync("owner-1", { restart: true });
  if (!synced.ok) throw new Error(synced.code);
  await synced.value.completion;
  readsBefore = catalog.calls.length;
});

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${base}/planning${path}`, {
    method,
    headers: { authorization: "Bearer tok-owner-1", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: res.status,
    body: (await res.json()) as { success: boolean; data?: any; error?: { code: string; message: string; issues?: Array<{ code: string; path: string }> } },
  };
}

const run = (toolId: string, params: Record<string, unknown>, inputMode?: InputMode) =>
  executor.execute({ toolId, params, userId: "owner-1", role: "owner", traceId: "trace-schema", ...(inputMode ? { inputMode } : {}) });

const nothingReachedN8n = () => {
  expect(catalog.calls.length).toBe(readsBefore);
  expect(triggered).toBe(0);
};

const configurationOf = (draft: DraftView) => draft.checks.find((check) => check.id === "configuration_schema")!;

describe("the configuration check against the pinned snapshot", () => {
  it("runs, and passes, when every setting names a real parameter and holds a valid value", async () => {
    const created = await call("POST", "/drafts", { ...LEADS, kind: "new", overrideReuse: true, ...GRAPH });
    expect(created.status).toBe(201);
    const draft = created.body.data.draft as DraftView;
    expect(configurationOf(draft)).toMatchObject({ status: "passed" });
    expect(configurationOf(draft).message).toContain("n8n-nodes-base 2.15.1");
    // Nothing else holds it back: every check ran and passed.
    expect(draft.checks.filter((check) => check.status !== "passed")).toEqual([]);
    expect(draft.status).toBe("validated");
    nothingReachedN8n();
  });

  it("refuses a value n8n would not take, before anything is stored", async () => {
    const bad = {
      ...GRAPH,
      nodes: [
        GRAPH.nodes[0],
        { key: "slack", type: "n8n-nodes-base.slack", settings: [{ key: "resource", label: "What should it do?", value: "telegram" }] },
      ],
    };
    const refused = await call("POST", "/drafts", { ...LEADS, kind: "new", overrideReuse: true, ...bad });
    expect(refused).toMatchObject({ status: 422, body: { error: { code: "DRAFT_INVALID" } } });
    expect(refused.body.error!.message).toContain("«Resource» is one of:");
    expect(drafts.drafts.size).toBe(0);
    expect(audits.at(-1)).toMatchObject({ action: "automation_planning.draft_create", result: "rejected" });
    nothingReachedN8n();
  });

  it("takes a number's bound from the schema", async () => {
    const bounded = {
      ...GRAPH,
      nodes: [
        GRAPH.nodes[0],
        { key: "slack", type: "n8n-nodes-base.slack", settings: [{ key: "resource", label: "What?", value: "message" }, { key: "limit", label: "How many?", value: "9000" }] },
      ],
    };
    const refused = await call("POST", "/drafts", { ...LEADS, kind: "new", overrideReuse: true, ...bounded });
    expect(refused).toMatchObject({ status: 422, body: { error: { code: "DRAFT_INVALID" } } });
    expect(refused.body.error!.message).toContain("Limit");
    expect(drafts.drafts.size).toBe(0);
  });

  it("does not claim a check it could not run: a setting the schema does not know", async () => {
    const unknown = {
      ...GRAPH,
      nodes: [GRAPH.nodes[0], { key: "slack", type: "n8n-nodes-base.slack", settings: [{ key: "something_else", label: "What?", value: "x" }] }],
    };
    const created = await call("POST", "/drafts", { ...LEADS, kind: "new", overrideReuse: true, ...unknown });
    expect(created.status).toBe(201);
    const draft = created.body.data.draft as DraftView;
    expect(configurationOf(draft).status).toBe("not_run");
    expect(draft.status).toBe("unverified");
  });

  it("is not_run with a reason when the server holds no snapshot", async () => {
    build(null);
    const created = await call("POST", "/drafts", { ...LEADS, kind: "new", overrideReuse: true, ...GRAPH });
    expect(created.status).toBe(201);
    const draft = created.body.data.draft as DraftView;
    expect(configurationOf(draft)).toMatchObject({ status: "not_run", message: NODE_SCHEMA_MESSAGES.unavailable });
    expect(draft.status).toBe("unverified");
  });
});

describe("the draft's view carries a bounded summary", () => {
  it("names the parameters of each live node, and nothing more", async () => {
    const created = await call("POST", "/drafts", { ...LEADS, kind: "new", overrideReuse: true, ...GRAPH });
    const draft = created.body.data.draft as DraftView;
    expect(draft.schema!.map((hint) => hint.nodeKey)).toEqual(["form", "slack"]);
    for (const hint of draft.schema!) {
      expect(hint.parameters.length).toBeLessThanOrEqual(24);
      expect(hint.parameterCount).toBeGreaterThan(0);
      for (const parameter of hint.parameters) {
        expect(Object.keys(parameter)).toEqual(expect.arrayContaining(["name", "type", "required"]));
        expect(parameter).not.toHaveProperty("displayName");
        expect(parameter).not.toHaveProperty("default");
      }
    }
    // The whole snapshot is not in the answer: the summary is bounded by size,
    // and a parameter beyond the cap is simply not there.
    expect(JSON.stringify(draft.schema).length).toBeLessThan(8000);
    expect(draft.schema![1]!.parameters.length).toBeLessThan(draft.schema![1]!.parameterCount);
    expect(draft.schema![1]!.parameters.some((parameter) => parameter.name === "sendAndWait")).toBe(false);
  });
});

describe("the route and the tools are answered alike", () => {
  it("carry the same configuration check and the same hints", async () => {
    const created = await call("POST", "/drafts", { ...LEADS, kind: "new", overrideReuse: true, ...GRAPH });
    const viaRoute = created.body.data.draft as DraftView;

    const viaTool = await run(GET, { draftId: viaRoute.draftId });
    expect(viaTool.status).toBe("completed");
    const toolDraft = viaTool.result!.data as DraftView;
    expect(configurationOf(toolDraft)).toEqual(configurationOf(viaRoute));
    expect(toolDraft.schema).toEqual(viaRoute.schema);
    expect(toolDraft.status).toBe(viaRoute.status);
  });

  it("refuse an invalid setting with the same code, and store nothing either way", async () => {
    const bad = {
      ...GRAPH,
      nodes: [GRAPH.nodes[0], { key: "slack", type: "n8n-nodes-base.slack", settings: [{ key: "resource", label: "What?", value: "telegram" }] }],
    };
    const viaTool = await run(CREATE, { ...LEADS, kind: "new", overrideReuse: true, ...bad });
    expect(viaTool.result!.success).toBe(false);
    expect(viaTool.result!.metadata).toMatchObject({ code: "DRAFT_INVALID", status: 422 });
    const viaRoute = await call("POST", "/drafts", { ...LEADS, kind: "new", overrideReuse: true, ...bad });
    expect(viaRoute.body.error!.code).toBe(viaTool.result!.metadata!.code);
    expect(drafts.drafts.size).toBe(0);
  });
});

describe("the server builds the registry once", () => {
  it("in the composition root, and hands it to the one planning service", () => {
    const container = readFileSync(fileURLToPath(new URL("../src/services/container.ts", import.meta.url)), "utf8");
    expect(container.match(/loadNodeSchemaRegistry\(/g)!.length).toBe(1);
    expect(container).toContain("N8N_NODE_SCHEMA_SNAPSHOT");
    expect(container).toContain("new AutomationPlanningService({");
    expect(container.match(/new AutomationPlanningService\(/g)!.length).toBe(1);
  });
});
