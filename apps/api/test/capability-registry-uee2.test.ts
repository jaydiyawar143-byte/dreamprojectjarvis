// ---------------------------------------------------------------------------
// UEE-2 — the read-only capability registry, and the planner's view of it.
//
// What is real here: the tool registry (`ToolRegistry` holding real `BaseTool`
// subclasses, whose `execute` and `validate` COUNT their calls), the agent
// registry and the compiled-in agent policies (`AGENT_POLICIES`), the UEE-1
// derivation, the planner, and — in the last group — the container. What is a
// double: the model, and the n8n workflow repository (a map of rows by user,
// which records who it was asked about).
//
// The properties, in the order of the brief:
//   1. native capabilities come from registered tools and the policies of the
//      agents this process registered — and only an allowlist grants;
//   2. workflows come only from the asking user's own ACTIVE allow-listed rows;
//   3. MCP stays its own origin;
//   4. the sandbox is explicitly unavailable, and never available;
//   5. no provider health is read or invented;
//   6. discovery cannot execute a tool, grant a permission or widen an allowlist;
//   7. the planner can read the catalogue, and planning is exactly what it was.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_IDS, AGENT_POLICIES } from "@jarvis/agents";
import { AgentRegistry } from "@jarvis/agents";
import { BaseTool, CsvAnalyzerTool, ToolRegistry } from "@jarvis/tools";
import type { AgentPolicy, AICompletionRequest, AICompletionResponse, IAgent, IAIProvider, RiskLevel, ToolPermission } from "@jarvis/core";

import {
  CapabilityRegistry,
  policiesOfRegisteredAgents,
  type CapabilityCatalogue,
  type CapabilityRegistryDeps,
} from "../src/services/capabilities/capability-registry.js";
import { TaskPlannerService } from "../src/services/tasks/task-planner-service.js";
import { getContainer, resetContainer } from "../src/services/container.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real tool that records every call to the two methods discovery must never make. */
class ProbeTool extends BaseTool {
  public executed = 0;
  public validated = 0;
  constructor(
    id: string,
    over: { risk?: RiskLevel; requiresApproval?: boolean; permissions?: ToolPermission[]; enabled?: boolean } = {}
  ) {
    super(
      id,
      `Probe ${id}`,
      `Probe tool ${id}`,
      "integration",
      [],
      over.requiresApproval ?? false,
      over.permissions ?? ["read"],
      over.risk ?? "READ_ONLY",
      "1.0.0",
      over.enabled ?? true
    );
  }
  async execute() {
    this.executed += 1;
    return this.success({});
  }
  validate(params: Record<string, unknown>): boolean {
    this.validated += 1;
    return super.validate(params);
  }
}

const policy = (agentId: string, allowedTools: string[], writesRequireApproval = true): AgentPolicy => ({
  agentId,
  domain: "general",
  allowedTools,
  requiredPermissions: ["read"],
  writesRequireApproval,
  clientSelectable: true,
  description: `Test agent ${agentId}`,
});

interface Row {
  id: string;
  userId: string;
  name: string;
  isActive: boolean;
  webhookPath: string;
  createdAt: Date;
}
const row = (id: string, userId: string, over: Partial<Row> = {}): Row => ({
  id,
  userId,
  name: `Workflow ${id}`,
  isActive: true,
  webhookPath: `hook-path-${id}-SECRET`,
  createdAt: new Date(0),
  ...over,
});

/** The workflow repository double: rows by user, and a record of who was asked about. */
function workflowRepo(byUser: Record<string, Row[]>, failWith?: Error) {
  const asked: string[] = [];
  return {
    asked,
    async listWorkflowsForUser(userId: string) {
      asked.push(userId);
      if (failWith) throw failWith;
      return byUser[userId] ?? [];
    },
  };
}

const RUNNER_POLICY = policy("automation", ["n8n.trigger"]);

function registry(tools: ProbeTool[]): ToolRegistry {
  const tr = new ToolRegistry();
  for (const tool of tools) tr.register(tool);
  return tr;
}

function build(over: Omit<Partial<CapabilityRegistryDeps>, "tools"> & { tools?: ToolRegistry | ProbeTool[] } = {}) {
  const tools = Array.isArray(over.tools) ? registry(over.tools) : (over.tools ?? new ToolRegistry());
  return new CapabilityRegistry({
    tools,
    agentPolicies: over.agentPolicies ?? (() => []),
    ...(over.workflows ? { workflows: over.workflows } : {}),
  });
}

const ids = (list: readonly { id: string }[]): string[] => list.map((c) => c.id);

const runner = () => new ProbeTool("n8n.trigger", { risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: true, permissions: ["read", "write"] });

const SANDBOX_ID = "sandbox.exec";

// ---------------------------------------------------------------------------
// 1. Native capabilities
// ---------------------------------------------------------------------------

describe("native capabilities, from registered tools and the policies of registered agents", () => {
  it("derives a capability for a real registered tool that a real agent policy holds", async () => {
    const catalogue = await build({
      tools: [new ProbeTool("placeholder")],
      agentPolicies: () => [AGENT_POLICIES[AGENT_IDS.general]!, AGENT_POLICIES[AGENT_IDS.analytics]!],
    }).catalogue("u1");
    // The real CsvAnalyzerTool, and the real policies that name it.
    const real = new ToolRegistry();
    real.register(new CsvAnalyzerTool());
    const withReal = await new CapabilityRegistry({
      tools: real,
      agentPolicies: () => [AGENT_POLICIES[AGENT_IDS.general]!, AGENT_POLICIES[AGENT_IDS.analytics]!, AGENT_POLICIES[AGENT_IDS.metaAds]!],
    }).catalogue("u1");

    expect(catalogue.available).toEqual([]);
    const csv = withReal.available.find((c) => c.id === "data.csv.analyze");
    expect(csv).toMatchObject({ kind: "native", origin: "tool_registry", risk: "READ_ONLY", approval: "not_required", scope: { kind: "user" } });
    // Held by exactly the agents whose real allowlist names it.
    expect(csv!.agents).toEqual(
      [AGENT_IDS.analytics, AGENT_IDS.general].sort()
    );
    expect(csv!.agents).not.toContain(AGENT_IDS.metaAds);
  });

  it("lists a registered tool that no agent holds as unavailable, not granted — never as available", async () => {
    const catalogue = await build({
      tools: [new ProbeTool("held.tool"), new ProbeTool("orphan.tool")],
      agentPolicies: () => [policy("a", ["held.tool"])],
    }).catalogue("u1");

    expect(ids(catalogue.available)).toEqual(["held.tool"]);
    expect(catalogue.unavailable).toEqual([expect.objectContaining({ id: "orphan.tool", kind: "native", reason: "not_granted" })]);
  });

  it("does not trust a tool's own claim to be enabled and unrestricted: only an allowlist grants", async () => {
    const catalogue = await build({
      tools: [new ProbeTool("self.declared", { enabled: true, requiresApproval: false })],
      agentPolicies: () => [policy("a", ["something.else"])],
    }).catalogue("u1");
    expect(catalogue.available).toEqual([]);
    expect(catalogue.unavailable.map((u) => u.reason)).toEqual(["not_granted"]);
  });

  it("lists a disabled tool as unavailable even where an agent holds it", async () => {
    const catalogue = await build({
      tools: [new ProbeTool("off.tool", { enabled: false })],
      agentPolicies: () => [policy("a", ["off.tool"])],
    }).catalogue("u1");
    expect(catalogue.unavailable).toEqual([expect.objectContaining({ id: "off.tool", reason: "disabled" })]);
  });

  it("refuses an allowlisted id that no tool registered", async () => {
    const catalogue = await build({ tools: [new ProbeTool("real.tool")], agentPolicies: () => [policy("a", ["real.tool", "ghost.tool"])] }).catalogue("u1");
    expect(ids(catalogue.available)).toEqual(["real.tool"]);
    expect(catalogue.rejected).toContainEqual({ id: "ghost.tool", reason: "not_registered", source: "agent_allowlist" });
  });

  it("takes the strict approval rule from the policy, as the UEE-1 derivation does", async () => {
    const catalogue = await build({
      tools: [new ProbeTool("x.write", { risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: false })],
      agentPolicies: () => [policy("a", ["x.write"], true)],
    }).catalogue("u1");
    expect(catalogue.available[0]).toMatchObject({ id: "x.write", approval: "required" });
  });

  it("keeps a shared connection's Organization scope, and gives a tool outside the table the caller's own", async () => {
    const catalogue = await build({
      tools: [new ProbeTool("meta.campaign.pause", { risk: "HIGH_IMPACT", requiresApproval: true, permissions: ["read", "write"] }), new ProbeTool("meta.accounts"), new ProbeTool("plain.read")],
      agentPolicies: () => [policy("a", ["meta.campaign.pause", "meta.accounts", "plain.read"])],
    }).catalogue("u1");
    const byId = (id: string) => catalogue.available.find((c) => c.id === id)!;
    expect(byId("meta.campaign.pause").scope).toEqual({ kind: "organization", integration: "meta", access: "write" });
    expect(byId("meta.accounts").scope).toEqual({ kind: "organization", integration: "meta", access: "read" });
    expect(byId("plain.read").scope).toEqual({ kind: "user" });
  });
});

describe("the policies of the agents this process registered", () => {
  const agent = (id: string) => ({ id, name: id, description: id }) as unknown as IAgent;

  it("are read from the agent registry: a policy of an agent that is not registered grants nothing", () => {
    const agents = new AgentRegistry();
    agents.register(agent("general"), policy("general", ["a.tool"]));
    // `automation` has a compiled-in policy and is NOT registered here, as when n8n is unconfigured.
    expect(policiesOfRegisteredAgents(agents).map((p) => p.agentId)).toEqual(["general"]);
  });

  it("skip an agent registered without a policy, rather than treating it as unrestricted", () => {
    const agents = new AgentRegistry();
    agents.register(agent("bare"));
    agents.register(agent("governed"), policy("governed", ["a.tool"]));
    expect(policiesOfRegisteredAgents(agents).map((p) => p.agentId)).toEqual(["governed"]);
  });

  it("are read at the time of the call, so an agent registered later (some register conditionally) counts", async () => {
    const agents = new AgentRegistry();
    const reg = new CapabilityRegistry({ tools: registry([new ProbeTool("a.tool")]), agentPolicies: () => policiesOfRegisteredAgents(agents) });
    expect((await reg.catalogue("u1")).available).toEqual([]);

    agents.register(agent("late"), policy("late", ["a.tool"]));
    expect(ids((await reg.catalogue("u1")).available)).toEqual(["a.tool"]);
  });

  it("make a tool registered after the registry was built visible on the next call", async () => {
    const tools = new ToolRegistry();
    const reg = new CapabilityRegistry({ tools, agentPolicies: () => [policy("a", ["late.tool"])] });
    expect((await reg.catalogue("u1")).available).toEqual([]);
    tools.register(new ProbeTool("late.tool"));
    expect(ids((await reg.catalogue("u1")).available)).toEqual(["late.tool"]);
  });
});

// ---------------------------------------------------------------------------
// 2. n8n workflows
// ---------------------------------------------------------------------------

describe("n8n workflow capabilities, from the asking user's own active rows", () => {
  const withRunner = (repo: ReturnType<typeof workflowRepo>) => build({ tools: [runner()], agentPolicies: () => [RUNNER_POLICY], workflows: repo });

  it("derives one capability per active workflow the user registered", async () => {
    const repo = workflowRepo({ alice: [row("wf-1", "alice"), row("wf-2", "alice", { name: "Lead capture" })] });
    const catalogue = await withRunner(repo).catalogue("alice");

    expect(ids(catalogue.available)).toEqual(["n8n.workflow:wf-1", "n8n.workflow:wf-2"]);
    expect(catalogue.available[1]).toMatchObject({ kind: "n8n_workflow", origin: "n8n_allowlist", name: "Lead capture", toolId: "n8n.trigger", approval: "required", scope: { kind: "user" } });
  });

  it("records whom it was built for, so a consumer can refuse it for anyone else (UEE-3)", async () => {
    const repo = workflowRepo({ alice: [row("a", "alice")], bob: [row("b", "bob")] });
    const reg = withRunner(repo);
    expect((await reg.catalogue("alice")).forUser).toBe("alice");
    expect((await reg.catalogue("bob")).forUser).toBe("bob");
    expect((await reg.catalogue("")).forUser).toBe("");
    expect((await reg.catalogue(undefined as never)).forUser).toBe("");
  });

  it("asks the repository about the caller and no one else", async () => {
    const repo = workflowRepo({ alice: [row("a", "alice")], bob: [row("b", "bob")] });
    await withRunner(repo).catalogue("alice");
    expect(repo.asked).toEqual(["alice"]);
  });

  it("leaves an inactive workflow out entirely", async () => {
    const repo = workflowRepo({ alice: [row("on", "alice"), row("off", "alice", { isActive: false })] });
    const catalogue = await withRunner(repo).catalogue("alice");
    expect(ids(catalogue.available)).toEqual(["n8n.workflow:on"]);
    expect(JSON.stringify(catalogue)).not.toContain("n8n.workflow:off");
  });

  it("does not offer another user's workflow, even if the repository returns it: it is rejected, not available", async () => {
    const repo = workflowRepo({ alice: [row("mine", "alice"), row("theirs", "bob", { name: "Bob private flow" })] });
    const catalogue = await withRunner(repo).catalogue("alice");

    expect(ids(catalogue.available)).toEqual(["n8n.workflow:mine"]);
    expect(catalogue.rejected).toContainEqual({ id: "n8n.workflow:theirs", reason: "foreign_workflow", source: "n8n_allowlist" });
    expect(JSON.stringify(catalogue)).not.toContain("Bob private flow");
  });

  it("gives each user their own workflows from the same registry", async () => {
    const repo = workflowRepo({ alice: [row("a1", "alice")], bob: [row("b1", "bob")] });
    const reg = withRunner(repo);
    expect(ids((await reg.catalogue("alice")).available)).toEqual(["n8n.workflow:a1"]);
    expect(ids((await reg.catalogue("bob")).available)).toEqual(["n8n.workflow:b1"]);
  });

  it("never carries a webhook path", async () => {
    const repo = workflowRepo({ alice: [row("wf-1", "alice")] });
    const text = JSON.stringify(await withRunner(repo).catalogue("alice"));
    expect(text).not.toContain("hook-path");
    expect(text).not.toContain("SECRET");
  });

  it("does not query the repository when the runner tool is not registered", async () => {
    const repo = workflowRepo({ alice: [row("wf-1", "alice")] });
    const catalogue = await build({ tools: [], agentPolicies: () => [RUNNER_POLICY], workflows: repo }).catalogue("alice");
    expect(repo.asked).toEqual([]);
    expect(ids(catalogue.available)).toEqual([]);
  });

  it("offers no workflow as available when no registered agent may run the runner", async () => {
    const repo = workflowRepo({ alice: [row("wf-1", "alice")] });
    const catalogue = await build({ tools: [runner()], agentPolicies: () => [policy("general", ["something.else"])], workflows: repo }).catalogue("alice");
    expect(catalogue.available).toEqual([]);
    expect(catalogue.unavailable).toEqual([expect.objectContaining({ id: "n8n.workflow:wf-1", reason: "workflow_runner_unavailable" })]);
  });

  it.each(["", "   ", undefined, null, 7])("does not query for a caller that is not a real user id (%s), and still derives native capabilities", async (caller) => {
    const repo = workflowRepo({});
    const reg = build({ tools: [runner(), new ProbeTool("plain.read")], agentPolicies: () => [RUNNER_POLICY, policy("a", ["plain.read"])], workflows: repo });
    const catalogue = await reg.catalogue(caller as never);
    expect(repo.asked).toEqual([]);
    expect(ids(catalogue.available)).toEqual(["plain.read"]);
  });

  it("degrades to no workflows when the repository fails, says so, and leaks nothing of the failure", async () => {
    const repo = workflowRepo({}, new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"));
    const reg = build({ tools: [runner(), new ProbeTool("plain.read")], agentPolicies: () => [RUNNER_POLICY, policy("a", ["plain.read"])], workflows: repo });
    const catalogue = await reg.catalogue("alice");

    expect(ids(catalogue.available)).toEqual(["plain.read"]);
    expect(catalogue.degraded).toEqual(["n8n_workflows_unreadable"]);
    expect(JSON.stringify(catalogue)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
  });

  it("derives no workflows when no repository was given", async () => {
    const catalogue = await build({ tools: [runner()], agentPolicies: () => [RUNNER_POLICY] }).catalogue("alice");
    expect(catalogue.available).toEqual([]);
    expect(catalogue.degraded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. MCP stays distinct
// ---------------------------------------------------------------------------

describe("MCP capabilities stay their own origin", () => {
  it("are native-kind with the mcp origin, beside a registry tool and a workflow, and never merged with either", async () => {
    const repo = workflowRepo({ alice: [row("wf-1", "alice")] });
    const catalogue = await build({
      tools: [new ProbeTool("mcp.pilot.lookup"), new ProbeTool("plain.read"), runner()],
      agentPolicies: () => [policy("general", ["mcp.pilot.lookup", "plain.read"]), RUNNER_POLICY],
      workflows: repo,
    }).catalogue("alice");

    const shape = Object.fromEntries(catalogue.available.map((c) => [c.id, `${c.kind}/${c.origin}`]));
    expect(shape).toEqual({
      "mcp.pilot.lookup": "native/mcp",
      "plain.read": "native/tool_registry",
      "n8n.workflow:wf-1": "n8n_workflow/n8n_allowlist",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The sandbox
// ---------------------------------------------------------------------------

describe("the sandbox is explicitly unavailable", () => {
  it("is stated in the catalogue even when no sandbox tool exists, with the one reason", async () => {
    const catalogue = await build({ tools: [new ProbeTool("plain.read")], agentPolicies: () => [policy("a", ["plain.read"])] }).catalogue("u1");
    expect(catalogue.sandbox).toEqual({ status: "unavailable", reason: "sandbox_not_exposed" });
    expect(catalogue.available.filter((c) => c.kind === "sandbox")).toEqual([]);
  });

  it("is unavailable, not exposed, and never listed available, when a sandbox-shaped tool is registered, enabled and allowlisted", async () => {
    const catalogue = await build({
      tools: [new ProbeTool(SANDBOX_ID, { risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: true, permissions: ["read", "write"] })],
      agentPolicies: () => [policy("general", [SANDBOX_ID])],
    }).catalogue("u1");

    expect(catalogue.available).toEqual([]);
    expect(catalogue.unavailable).toEqual([expect.objectContaining({ id: SANDBOX_ID, kind: "sandbox", origin: "sandbox", reason: "sandbox_not_exposed" })]);
    expect(catalogue.sandbox).toEqual({ status: "unavailable", reason: "sandbox_not_exposed" });
  });

  it("has an unresolved scope: no Organization is mapped to it", async () => {
    const catalogue = await build({ tools: [new ProbeTool(SANDBOX_ID)], agentPolicies: () => [policy("general", [SANDBOX_ID])] }).catalogue("u1");
    expect(catalogue.unavailable[0]).toMatchObject({ id: SANDBOX_ID, scope: { kind: "unresolved" } });
  });

  it.each(["sandbox.run", "sandbox:exec", "n8n.sandbox.run", "N8N-SANDBOX-RUN"])("is recognised by its id however it is spelled: %s", async (id) => {
    const catalogue = await build({ tools: [new ProbeTool(id, { risk: "READ_ONLY" })], agentPolicies: () => [policy("a", [id])] }).catalogue("u1");
    expect(catalogue.available).toEqual([]);
    expect(catalogue.unavailable).toEqual([expect.objectContaining({ id, kind: "sandbox", reason: "sandbox_not_exposed" })]);
  });
});

// ---------------------------------------------------------------------------
// 5. No provider health is read or invented
// ---------------------------------------------------------------------------

describe("no provider connection or health is inferred", () => {
  it("takes no integration reader, and the catalogue carries no connection, health or credential field", async () => {
    const catalogue = await build({ tools: [new ProbeTool("meta.accounts")], agentPolicies: () => [policy("a", ["meta.accounts"])] }).catalogue("u1");

    expect(Object.keys(catalogue).sort()).toEqual(["available", "degraded", "forUser", "rejected", "sandbox", "unavailable"]);
    expect(Object.keys(catalogue.available[0]!).sort()).toEqual(
      ["agents", "approval", "availability", "dataEgress", "description", "id", "idempotency", "kind", "name", "origin", "requiredPermissions", "risk", "scope", "spokenTurn", "timeoutClass", "toolId"].sort()
    );
    expect(JSON.stringify(catalogue)).not.toMatch(/connected|health|credential|token|NOT_CONNECTED|EXECUTABLE/i);
  });

  it("reports a Meta tool as available on structure alone: whether Meta is connected is not this registry's to say", async () => {
    const catalogue = await build({ tools: [new ProbeTool("meta.accounts")], agentPolicies: () => [policy("a", ["meta.accounts"])] }).catalogue("u1");
    expect(catalogue.available[0]!.availability).toEqual({ status: "available" });
  });

  it("has no dependency that could read an integration: its deps are tools, policies and a workflow source", () => {
    const deps: CapabilityRegistryDeps = { tools: new ToolRegistry(), agentPolicies: () => [] };
    expect(Object.keys(deps).sort()).toEqual(["agentPolicies", "tools"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Discovery executes nothing, grants nothing, widens nothing
// ---------------------------------------------------------------------------

describe("capability discovery cannot execute a tool or grant a permission", () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    }
    return value;
  };

  it("never calls a tool's execute or validate, however many capabilities it derives", async () => {
    const tools = [new ProbeTool("a.read"), new ProbeTool("b.write", { risk: "HIGH_IMPACT", requiresApproval: true }), runner(), new ProbeTool("mcp.pilot.lookup"), new ProbeTool(SANDBOX_ID)];
    const repo = workflowRepo({ alice: [row("wf-1", "alice")] });
    const reg = build({ tools, agentPolicies: () => [policy("g", ["a.read", "b.write", "mcp.pilot.lookup", SANDBOX_ID]), RUNNER_POLICY], workflows: repo });

    await reg.catalogue("alice");
    await reg.catalogue("alice");

    for (const tool of tools) {
      expect(tool.executed, `${tool.id} executed`).toBe(0);
      expect(tool.validated, `${tool.id} validated`).toBe(0);
    }
  });

  it("hands the derivation a snapshot of metadata, never the tool objects", async () => {
    const seen: unknown[] = [];
    const tool = new ProbeTool("a.read");
    const tools = { getAll: () => [tool] };
    const reg = new CapabilityRegistry({ tools, agentPolicies: () => [policy("a", ["a.read"])] });
    const catalogue = await reg.catalogue("u1");
    seen.push(...catalogue.available, ...catalogue.unavailable);
    for (const item of seen) {
      expect(item).not.toBe(tool);
      expect(typeof (item as { execute?: unknown }).execute).toBe("undefined");
    }
  });

  it("does not change the agent policies it reads, nor the tool registry", async () => {
    const policies = [deepFreeze(policy("a", ["a.read"]))];
    const tools = registry([new ProbeTool("a.read"), new ProbeTool("orphan")]);
    const before = tools.getAll().map((t) => t.id);

    const catalogue = await build({ tools, agentPolicies: () => policies }).catalogue("u1");

    expect(policies[0]!.allowedTools).toEqual(["a.read"]);
    expect(tools.getAll().map((t) => t.id)).toEqual(before);
    // An allowlist was not widened to make the orphan reachable.
    expect(ids(catalogue.available)).toEqual(["a.read"]);
  });

  it("returns a frozen catalogue, so one reader cannot alter what another sees", async () => {
    const catalogue = await build({ tools: [new ProbeTool("a.read")], agentPolicies: () => [policy("a", ["a.read"])] }).catalogue("u1");
    expect(Object.isFrozen(catalogue)).toBe(true);
    expect(Object.isFrozen(catalogue.available)).toBe(true);
    expect(Object.isFrozen(catalogue.available[0])).toBe(true);
    expect(Object.isFrozen(catalogue.unavailable)).toBe(true);
    expect(Object.isFrozen(catalogue.rejected)).toBe(true);
    expect(() => (catalogue.available as unknown as unknown[]).push({})).toThrow();
  });

  it("is a snapshot: a later registration does not change a catalogue already returned", async () => {
    const tools = new ToolRegistry();
    tools.register(new ProbeTool("a.read"));
    const reg = new CapabilityRegistry({ tools, agentPolicies: () => [policy("a", ["a.read", "b.read"])] });
    const first = await reg.catalogue("u1");
    tools.register(new ProbeTool("b.read"));
    expect(ids(first.available)).toEqual(["a.read"]);
  });

  it("does not make a capability available by being asked about it: a catalogue answers, it does not authorize", async () => {
    const reg = build({ tools: [new ProbeTool("orphan.tool")], agentPolicies: () => [] });
    for (let i = 0; i < 3; i++) expect((await reg.catalogue("u1")).available).toEqual([]);
  });

  it("has no method that runs or authorizes anything", () => {
    const methods = Object.getOwnPropertyNames(CapabilityRegistry.prototype).sort();
    expect(methods).toEqual(["catalogue", "constructor"]);
  });
});

describe("the registry's own source", () => {
  const source = readFileSync(new URL("../src/services/capabilities/capability-registry.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("imports only the core derivation and the tool-registry port type", () => {
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!).sort();
    expect(specifiers).toEqual(["./capability-service.js", "@jarvis/core"]);
  });

  it("gives the derivation a copy of each tool's metadata: the tool objects go no further than metadataOf", () => {
    expect(source).toMatch(/getAll\(\)\.map\(metadataOf\)/);
    // `tools` is only ever the metadata list from there on.
    expect(source).not.toMatch(/deriveCapabilities\(\{\s*tools:\s*this\.deps/);
  });

  it("calls no tool method, and reaches no database, network, environment or clock", () => {
    expect(source).not.toMatch(/\.\s*execute\s*\(|\.\s*validate\s*\(|\[\s*["']execute["']\s*\]/);
    expect(source).not.toMatch(/\b(?:fetch\s*\(|process\.|Date\.now|new Date|Math\.random|setTimeout|console\.|prisma|Prisma)/);
  });

  it("awaits exactly one thing: the caller's workflow rows", () => {
    expect(source.match(/\bawait\b/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/await this\.deps\.workflows\.listWorkflowsForUser\(userId\)/);
  });

  it("reads no integration, health or credential source", () => {
    expect(source).not.toMatch(/IntegrationStateReader|listIntegrations|CapabilityService|isUsable|credential|health/i);
  });
});

// ---------------------------------------------------------------------------
// 7. The planner
// ---------------------------------------------------------------------------

describe("the planner's read-only view of the catalogue", () => {
  /** A model double that records every request and answers with one fixed plan. */
  function provider(answer: string) {
    const requests: AICompletionRequest[] = [];
    const impl: IAIProvider = {
      name: "scripted",
      complete: async (request: AICompletionRequest): Promise<AICompletionResponse> => {
        requests.push(request);
        return { message: { role: "assistant", content: answer }, model: "scripted", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" } as unknown as AICompletionResponse;
      },
    } as unknown as IAIProvider;
    return { requests, impl };
  }

  const PLAN = '{"executable":true,"toolId":"web.fetch","params":{"url":"https://example.com"},"reason":"Fetch the page."}';

  function world() {
    const tools = new ToolRegistry();
    const fetchTool = new ProbeTool("web.fetch");
    // A real tool with a required parameter, so the plan validates like production's.
    Object.defineProperty(fetchTool, "parameters", { value: [{ name: "url", type: "string", description: "page", required: true }] });
    tools.register(fetchTool);
    tools.register(new ProbeTool("mcp.pilot.lookup"));
    const allowedToolIds = new Set(["web.fetch"]); // schedulable: MCP is not
    const catalogueSource = new CapabilityRegistry({ tools, agentPolicies: () => [policy("general", ["web.fetch", "mcp.pilot.lookup"])] });
    return { tools, fetchTool, allowedToolIds, catalogueSource };
  }

  it("offers the catalogue for the asking user, read-only", async () => {
    const { tools, allowedToolIds, catalogueSource } = world();
    const spy = vi.spyOn(catalogueSource, "catalogue");
    const planner = new TaskPlannerService({ provider: provider(PLAN).impl, registry: tools, allowedToolIds, capabilities: catalogueSource });

    const view = await planner.capabilityCatalogue("user-9");

    expect(spy).toHaveBeenCalledWith("user-9");
    expect(ids(view!.available)).toEqual(["mcp.pilot.lookup", "web.fetch"]);
    expect(view!.sandbox).toEqual({ status: "unavailable", reason: "sandbox_not_exposed" });
  });

  it("marks which available capabilities the planner could actually plan: an MCP tool is discoverable and not plannable", async () => {
    const { tools, allowedToolIds, catalogueSource } = world();
    const view = await new TaskPlannerService({ provider: provider(PLAN).impl, registry: tools, allowedToolIds, capabilities: catalogueSource }).capabilityCatalogue("u");
    expect(view!.plannable).toEqual(["web.fetch"]);
  });

  it("offers nothing where the planner was built without a catalogue source", async () => {
    const { tools, allowedToolIds } = world();
    expect(await new TaskPlannerService({ provider: provider(PLAN).impl, registry: tools, allowedToolIds }).capabilityCatalogue("u")).toBeNull();
  });

  it("offers nothing, rather than failing, when the catalogue cannot be read", async () => {
    const { tools, allowedToolIds } = world();
    const broken = { catalogue: async () => { throw new Error("boom"); } };
    expect(await new TaskPlannerService({ provider: provider(PLAN).impl, registry: tools, allowedToolIds, capabilities: broken }).capabilityCatalogue("u")).toBeNull();
  });

  it("changes nothing about planning: the model is sent the same request, and the plan is the same", async () => {
    const without = world();
    const withCatalogue = world();
    const a = provider(PLAN);
    const b = provider(PLAN);
    const input = { userId: "u1", title: "Check the page", description: "https://example.com", traceId: "t-1" };

    const planA = await new TaskPlannerService({ provider: a.impl, registry: without.tools, allowedToolIds: without.allowedToolIds }).planTask(input);
    const planB = await new TaskPlannerService({ provider: b.impl, registry: withCatalogue.tools, allowedToolIds: withCatalogue.allowedToolIds, capabilities: withCatalogue.catalogueSource }).planTask(input);

    expect(planB).toEqual(planA);
    expect(planA).toMatchObject({ executable: true, toolId: "web.fetch" });
    const strip = (request: AICompletionRequest) => ({ ...request, signal: undefined });
    expect(b.requests.map(strip)).toEqual(a.requests.map(strip));
  });

  it("never reads the catalogue while planning, and never puts it in front of the model", async () => {
    const { tools, allowedToolIds, catalogueSource } = world();
    const spy = vi.spyOn(catalogueSource, "catalogue");
    const model = provider(PLAN);

    await new TaskPlannerService({ provider: model.impl, registry: tools, allowedToolIds, capabilities: catalogueSource }).planTask({ userId: "u1", title: "t" });

    expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(model.requests)).not.toContain("mcp.pilot.lookup");
    expect(JSON.stringify(model.requests)).not.toMatch(/sandbox|n8n\.workflow|plannable/i);
  });

  it("executes nothing, whether planning or discovering", async () => {
    const { tools, fetchTool, allowedToolIds, catalogueSource } = world();
    const planner = new TaskPlannerService({ provider: provider(PLAN).impl, registry: tools, allowedToolIds, capabilities: catalogueSource });
    await planner.planTask({ userId: "u1", title: "t" });
    await planner.capabilityCatalogue("u1");
    expect(fetchTool.executed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. The real container
// ---------------------------------------------------------------------------

describe("the container wires the real registry", () => {
  afterEach(() => {
    resetContainer();
    vi.unstubAllEnvs();
  });

  function realContainer() {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("JWT_SECRET", "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA");
    vi.stubEnv("BROWSER_ENABLED", "false");
    vi.stubEnv("N8N_SANDBOX_API_URL", "");
    vi.stubEnv("N8N_SANDBOX_API_KEY", "");
    return getContainer();
  }

  it("holds one registry, and hands the planner the same one", async () => {
    const container = realContainer();
    expect(container.capabilityRegistry).toBeInstanceOf(CapabilityRegistry);

    const direct = await container.capabilityRegistry.catalogue("user-1");
    const viaPlanner = await container.taskPlanner.capabilityCatalogue("user-1");
    expect(viaPlanner).toMatchObject({ available: direct.available, unavailable: direct.unavailable, sandbox: direct.sandbox });
  });

  it("derives the real deployment's capabilities from its real registry and policies: each available one is registered, enabled and held by a registered agent", async () => {
    const container = realContainer();
    const catalogue = await container.capabilityRegistry.catalogue("user-1");

    expect(catalogue.available.length).toBeGreaterThan(0);
    const registered = new Map(container.toolRegistry.getAll().map((tool) => [tool.id, tool]));
    const registeredAgents = new Set(container.agentRegistry.getAll().map((agent) => agent.id));
    for (const capability of catalogue.available) {
      expect(registered.has(capability.toolId), `${capability.id} is not registered`).toBe(true);
      expect(registered.get(capability.toolId)!.enabled).toBe(true);
      expect(capability.agents.length).toBeGreaterThan(0);
      for (const agentId of capability.agents) expect(registeredAgents.has(agentId), `${agentId} is not a registered agent`).toBe(true);
    }
  });

  it("states the sandbox unavailable, offers none, and lists no sandbox-kind capability as available", async () => {
    const catalogue = await realContainer().capabilityRegistry.catalogue("user-1");
    expect(catalogue.sandbox).toEqual({ status: "unavailable", reason: "sandbox_not_exposed" });
    expect(catalogue.available.filter((c) => c.kind === "sandbox")).toEqual([]);
    expect(catalogue.unavailable.filter((c) => c.kind === "sandbox")).toEqual([]);
  });

  it("keeps every real MCP tool, if any, in its own origin", async () => {
    const catalogue: CapabilityCatalogue = await realContainer().capabilityRegistry.catalogue("user-1");
    for (const capability of [...catalogue.available, ...catalogue.unavailable]) {
      expect(capability.id.startsWith("mcp.")).toBe(capability.origin === "mcp");
    }
  });

  it("does not read an integration: building the catalogue touches no provider", async () => {
    const container = realContainer();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await container.capabilityRegistry.catalogue("user-1");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
