// ---------------------------------------------------------------------------
// UEE-3 — the deterministic execution router.
//
// `routeExecution` is a pure policy over two things: what a model PROPOSED (a
// list of capability names) and the UEE-2 catalogue built for the asking user.
// It answers one question — "which single capability, if any, may be handed to
// the existing execution path" — and never goes further: it runs nothing,
// creates no approval, grants no permission and reads nothing outside its
// arguments. ToolExecutor, the permission checker, the access gate and the
// approval store still decide, as they always did.
//
// Real here: the tool registry (real `BaseTool`s whose `execute`/`validate`
// COUNT calls), the UEE-2 `CapabilityRegistry` that builds every catalogue, the
// compiled-in agent policies and ids, the schedulable-tool table and the voice
// table. A double: the n8n workflow repository (rows by user).
//
// Properties pinned, in the order of the brief:
//   1. native beats n8n beats MCP, whatever order the model names them in;
//   2. a workflow routes only for the user who owns it, active and allow-listed;
//   3. foreign and inactive workflows never route;
//   4. disabled and non-allowlisted tools never route;
//   5. MCP routes only on the existing authorized path, and never as autonomy;
//   6. the sandbox is always refused, `sandbox_not_exposed`;
//   7. an unresolved scope is refused;
//   8. nothing a model says about permissions, approval or scope changes the answer;
//   9. same inputs, same decision, in any order;
//  10. routing executes, grants, approves and reaches nothing.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_IDS, AGENT_POLICIES, routeExecution, schedulableToolIds } from "@jarvis/agents";
import type { ExecutionRouteDecision, ExecutionRouteRequest, RoutingCatalogue } from "@jarvis/agents";
import { BaseTool, CsvAnalyzerTool, ToolRegistry } from "@jarvis/tools";
import { VOICE_REFUSED_TOOLS, deriveCapabilities } from "@jarvis/core";
import type { AgentPolicy, RiskLevel, ToolPermission } from "@jarvis/core";

import { CapabilityRegistry } from "../src/services/capabilities/capability-registry.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GENERAL = AGENT_IDS.general;
const AUTOMATION = AGENT_IDS.automation;
const META = AGENT_IDS.metaAds;

/** A real tool that counts every call to the methods routing must never make. */
class ProbeTool extends BaseTool {
  public executed = 0;
  public validated = 0;
  constructor(id: string, over: { risk?: RiskLevel; requiresApproval?: boolean; permissions?: ToolPermission[]; enabled?: boolean } = {}) {
    super(id, `Probe ${id}`, `Probe tool ${id}`, "integration", [], over.requiresApproval ?? false, over.permissions ?? ["read"], over.risk ?? "READ_ONLY", "1.0.0", over.enabled ?? true);
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

const policy = (agentId: string, allowedTools: string[]): AgentPolicy => ({
  agentId,
  domain: "general",
  allowedTools,
  requiredPermissions: ["read"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: `Test agent ${agentId}`,
});

interface Row {
  id: string;
  userId: string;
  name: string;
  isActive: boolean;
  webhookPath: string;
}
const row = (id: string, userId: string, over: Partial<Row> = {}): Row => ({ id, userId, name: `Workflow ${id}`, isActive: true, webhookPath: `hook-${id}`, ...over });

const repoOf = (byUser: Record<string, Row[]>) => ({ listWorkflowsForUser: async (userId: string) => byUser[userId] ?? [] });

const runner = () => new ProbeTool("n8n.trigger", { risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: true, permissions: ["read", "write"] });

/** The world every scenario starts from. */
function world(over: { tools?: ProbeTool[]; policies?: AgentPolicy[]; rows?: Record<string, Row[]> } = {}) {
  const tools = over.tools ?? [
    new ProbeTool("native.read"),
    new ProbeTool("native.read2"),
    new ProbeTool("native.write", { risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: true, permissions: ["read", "write"] }),
    new ProbeTool("mcp.pilot.lookup"),
    new ProbeTool("sandbox.exec", { risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: true, permissions: ["read", "write"] }),
    new ProbeTool("disabled.tool", { enabled: false }),
    new ProbeTool("orphan.tool"),
    runner(),
  ];
  const policies = over.policies ?? [
    policy(GENERAL, ["native.read", "native.read2", "native.write", "mcp.pilot.lookup", "sandbox.exec", "disabled.tool"]),
    policy(AUTOMATION, ["n8n.trigger", "native.read"]),
    policy(META, ["native.read"]),
  ];
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const capabilities = new CapabilityRegistry({
    tools: registry,
    agentPolicies: () => policies,
    workflows: repoOf(over.rows ?? { alice: [row("wf-1", "alice"), row("wf-off", "alice", { isActive: false })], bob: [row("wf-bob", "bob")] }),
  });
  return { tools, capabilities };
}

const request = (over: Partial<ExecutionRouteRequest> = {}): ExecutionRouteRequest => ({
  userId: "alice",
  surface: "conversation",
  agentId: GENERAL,
  grantedPermissions: ["read", "write"],
  candidates: [],
  ...over,
});

async function route(candidates: string[], over: Partial<ExecutionRouteRequest> = {}, setup = world()): Promise<ExecutionRouteDecision> {
  const catalogue = await setup.capabilities.catalogue(over.userId ?? "alice");
  return routeExecution(request({ ...over, candidates }), catalogue);
}

const routed = (decision: ExecutionRouteDecision) => {
  expect(decision.outcome, JSON.stringify(decision)).toBe("routed");
  return decision as Extract<ExecutionRouteDecision, { outcome: "routed" }>;
};
const refused = (decision: ExecutionRouteDecision) => {
  expect(decision.outcome, JSON.stringify(decision)).toBe("refused");
  return decision as Extract<ExecutionRouteDecision, { outcome: "refused" }>;
};

// ---------------------------------------------------------------------------
// 1. Precedence
// ---------------------------------------------------------------------------

describe("routing prefers native, then an n8n workflow, then MCP", () => {
  it("routes an available native capability", async () => {
    expect(routed(await route(["native.read"]))).toMatchObject({ capabilityId: "native.read", kind: "native", origin: "tool_registry", toolId: "native.read", precedence: 0 });
  });

  it("prefers a native capability over an n8n workflow, whichever the model names first", async () => {
    for (const candidates of [["native.read", "n8n.workflow:wf-1"], ["n8n.workflow:wf-1", "native.read"]]) {
      expect(routed(await route(candidates, { agentId: AUTOMATION })), candidates.join()).toMatchObject({ capabilityId: "native.read", kind: "native" });
    }
  });

  it("prefers an n8n workflow over an MCP tool, and a native one over both", async () => {
    const setup = world({ policies: [policy(GENERAL, ["native.read", "mcp.pilot.lookup", "n8n.trigger"]), policy(AUTOMATION, ["n8n.trigger"])] });
    expect(routed(await route(["mcp.pilot.lookup", "n8n.workflow:wf-1"], { agentId: GENERAL }, setup))).toMatchObject({ capabilityId: "n8n.workflow:wf-1", precedence: 1 });
    expect(routed(await route(["mcp.pilot.lookup", "n8n.workflow:wf-1", "native.read"], { agentId: GENERAL }, setup))).toMatchObject({ capabilityId: "native.read", precedence: 0 });
  });

  it("routes a workflow, through the one runner tool, when it is the only match", async () => {
    expect(routed(await route(["n8n.workflow:wf-1"], { agentId: AUTOMATION }))).toMatchObject({ capabilityId: "n8n.workflow:wf-1", kind: "n8n_workflow", origin: "n8n_allowlist", toolId: "n8n.trigger", precedence: 1 });
  });

  it("skips a refused candidate and routes the one that is eligible", async () => {
    const decision = routed(await route(["sandbox.exec", "disabled.tool", "orphan.tool", "native.read"]));
    expect(decision.capabilityId).toBe("native.read");
    expect(decision.considered.filter((c) => !c.eligible).map((c) => c.reason).sort()).toEqual(["disabled", "not_granted", "sandbox_not_exposed"]);
  });
});

// ---------------------------------------------------------------------------
// 2-3. Workflows: the user's own, active, allow-listed
// ---------------------------------------------------------------------------

describe("an n8n workflow routes only for the user who owns it", () => {
  it("routes the owner's active workflow", async () => {
    expect(routed(await route(["n8n.workflow:wf-1"], { agentId: AUTOMATION, userId: "alice" })).capabilityId).toBe("n8n.workflow:wf-1");
  });

  it("refuses another user's workflow, by name, even when the repository handed it over", async () => {
    // The repository wrongly returns bob's row among alice's: the catalogue rejects it, the router refuses it.
    const setup = world({ rows: { alice: [row("wf-1", "alice"), row("wf-bob", "bob")] } });
    expect(refused(await route(["n8n.workflow:wf-bob"], { agentId: AUTOMATION }, setup)).reason).toBe("foreign_workflow");
  });

  it("does not know another user's workflow at all: it is unknown to alice, though real for bob", async () => {
    expect(refused(await route(["n8n.workflow:wf-bob"], { agentId: AUTOMATION })).reason).toBe("unknown_capability");
    expect(routed(await route(["n8n.workflow:wf-bob"], { agentId: AUTOMATION, userId: "bob" })).capabilityId).toBe("n8n.workflow:wf-bob");
  });

  it("refuses an inactive workflow: it is not in the catalogue, so it is unknown", async () => {
    expect(refused(await route(["n8n.workflow:wf-off"], { agentId: AUTOMATION })).reason).toBe("unknown_capability");
  });

  it("refuses a workflow that was never registered", async () => {
    expect(refused(await route(["n8n.workflow:made-up"], { agentId: AUTOMATION })).reason).toBe("unknown_capability");
  });

  it("refuses a catalogue built for a different user, so one account's capabilities cannot be routed for another", async () => {
    const setup = world();
    const bobsCatalogue = await setup.capabilities.catalogue("bob");
    const decision = routeExecution(request({ userId: "alice", agentId: AUTOMATION, candidates: ["n8n.workflow:wf-bob"] }), bobsCatalogue);
    expect(refused(decision).reason).toBe("catalogue_user_mismatch");
    // Nor can bob's catalogue route anything at all for alice.
    expect(refused(routeExecution(request({ userId: "alice", agentId: GENERAL, candidates: ["native.read"] }), bobsCatalogue)).reason).toBe("catalogue_user_mismatch");
  });

  it("refuses a workflow when no agent may run the runner, or the asking agent is not one that may", async () => {
    expect(refused(await route(["n8n.workflow:wf-1"], { agentId: GENERAL })).reason).toBe("agent_not_permitted");
    const noRunner = world({ policies: [policy(GENERAL, ["native.read"])] });
    expect(refused(await route(["n8n.workflow:wf-1"], { agentId: AUTOMATION }, noRunner)).reason).toBe("workflow_runner_unavailable");
  });
});

// ---------------------------------------------------------------------------
// 4. Disabled, non-allowlisted, and the asking agent
// ---------------------------------------------------------------------------

describe("a capability that is not available is refused, with the reason", () => {
  it.each([
    ["a disabled tool", "disabled.tool", "disabled"],
    ["a tool no agent holds", "orphan.tool", "not_granted"],
    ["a tool nothing registered", "ghost.tool", "unknown_capability"],
  ])("%s", async (_label, id, reason) => {
    expect(refused(await route([id])).reason).toBe(reason);
  });

  it("refuses a tool that exists and is held by other agents, but not by the one asking", async () => {
    expect(refused(await route(["native.write"], { agentId: META })).reason).toBe("agent_not_permitted");
    expect(routed(await route(["native.write"], { agentId: GENERAL })).capabilityId).toBe("native.write");
  });

  it("refuses an agent that has no policy, rather than routing for it", async () => {
    expect(refused(await route(["native.read"], { agentId: "agent-that-does-not-exist" })).reason).toBe("agent_not_permitted");
  });

  it("refuses a conversation turn that names no agent", async () => {
    const decision = refused(await route(["native.read"], { agentId: undefined }));
    expect(decision.reason).toBe("invalid_request");
  });
});

// ---------------------------------------------------------------------------
// 5. MCP
// ---------------------------------------------------------------------------

describe("MCP cannot bypass the existing authorization", () => {
  it("routes only on the path that exists: an agent whose allowlist names it, in a conversation", async () => {
    expect(routed(await route(["mcp.pilot.lookup"], { agentId: GENERAL }))).toMatchObject({ capabilityId: "mcp.pilot.lookup", kind: "native", origin: "mcp", precedence: 2 });
  });

  it("is refused for an agent whose allowlist does not name it", async () => {
    expect(refused(await route(["mcp.pilot.lookup"], { agentId: AUTOMATION })).reason).toBe("agent_not_permitted");
    expect(refused(await route(["mcp.pilot.lookup"], { agentId: META })).reason).toBe("agent_not_permitted");
  });

  it("is never routed for unattended work: a task cannot run it", async () => {
    expect(refused(await route(["mcp.pilot.lookup"], { surface: "task", agentId: undefined })).reason).toBe("not_schedulable");
  });

  it("is refused when the caller's permissions do not cover its own", async () => {
    expect(refused(await route(["mcp.pilot.lookup"], { grantedPermissions: [] })).reason).toBe("missing_permission");
  });

  it("is refused when it is disabled, as any tool is", async () => {
    const setup = world({ tools: [new ProbeTool("mcp.pilot.lookup", { enabled: false })], policies: [policy(GENERAL, ["mcp.pilot.lookup"])] });
    expect(refused(await route(["mcp.pilot.lookup"], {}, setup)).reason).toBe("disabled");
  });

  it("is not treated as a native capability: it loses to one, and is never chosen for being first", async () => {
    expect(routed(await route(["mcp.pilot.lookup", "native.read"], { agentId: GENERAL })).capabilityId).toBe("native.read");
  });
});

// ---------------------------------------------------------------------------
// 6. The sandbox
// ---------------------------------------------------------------------------

describe("the sandbox is always refused", () => {
  const everythingPermitted = { grantedPermissions: ["read", "write", "execute", "admin"] as ToolPermission[] };

  it("is refused when registered, enabled, allowlisted, permitted and asked for by the agent that holds it", async () => {
    const decision = refused(await route(["sandbox.exec"], { agentId: GENERAL, ...everythingPermitted }));
    expect(decision.reason).toBe("sandbox_not_exposed");
    expect(decision.considered).toEqual([{ capabilityId: "sandbox.exec", eligible: false, reason: "sandbox_not_exposed" }]);
  });

  it.each(["sandbox.run", "sandbox:exec", "n8n.sandbox.run", "N8N-SANDBOX-RUN", "sandbox-exec"])("is refused by its id alone, though nothing registered it: %s", async (id) => {
    expect(refused(await route([id], { ...everythingPermitted })).reason).toBe("sandbox_not_exposed");
  });

  it("is refused on a task surface and for a spoken turn too", async () => {
    expect(refused(await route(["sandbox.exec"], { surface: "task", agentId: undefined, ...everythingPermitted })).reason).toBe("sandbox_not_exposed");
    expect(refused(await route(["sandbox.exec"], { inputMode: "voice", ...everythingPermitted })).reason).toBe("sandbox_not_exposed");
  });

  it("is refused even when a corrupt catalogue lists it as available", async () => {
    const real = await world().capabilities.catalogue("alice");
    const sandboxLike = { ...real.available.find((c) => c.id === "native.read")!, id: "sandbox.exec", toolId: "sandbox.exec", kind: "sandbox" as const, origin: "sandbox" as const };
    const corrupt: RoutingCatalogue = { ...real, available: [...real.available, sandboxLike] };
    expect(refused(routeExecution(request({ candidates: ["sandbox.exec"], ...everythingPermitted }), corrupt)).reason).toBe("sandbox_not_exposed");
  });

  it("does not stop a real capability from routing when it is named beside it", async () => {
    expect(routed(await route(["sandbox.exec", "native.read"], { agentId: GENERAL })).capabilityId).toBe("native.read");
  });

  it("agrees with the UEE-1 derivation about what the sandbox is", () => {
    const ids = ["sandbox.run", "sandbox:exec", "n8n.sandbox.run", "N8N-SANDBOX-RUN", "sandbox-exec", "native.read", "n8n.workflow:sandbox-1", "mcp.sandboxish.tool", "data.csv.analyze"];
    const tool = (id: string) => ({ id, name: id, description: id, category: "integration" as const, risk: "READ_ONLY" as const, requiresApproval: false, requiredPermissions: ["read" as const], enabled: true });
    const derived = deriveCapabilities({ tools: ids.map(tool), agents: [{ agentId: "a", allowedTools: ids, writesRequireApproval: true }] });
    for (const capability of derived.capabilities) {
      const catalogue: RoutingCatalogue = { forUser: "u", available: [], unavailable: [], rejected: [], sandbox: { status: "unavailable", reason: "sandbox_not_exposed" } };
      const decision = routeExecution(request({ userId: "u", candidates: [capability.id], grantedPermissions: ["read", "write", "execute", "admin"] }), catalogue);
      const refusedAsSandbox = decision.outcome === "refused" && decision.reason === "sandbox_not_exposed";
      expect(refusedAsSandbox, capability.id).toBe(capability.kind === "sandbox");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Scope
// ---------------------------------------------------------------------------

describe("an unresolved tenant scope is refused", () => {
  it("is refused for any capability whose scope is unresolved, whatever its kind", async () => {
    const real = await world().capabilities.catalogue("alice");
    const unscoped = { ...real.available.find((c) => c.id === "native.read")!, scope: { kind: "unresolved" as const } };
    const catalogue: RoutingCatalogue = { ...real, available: [unscoped] };
    expect(refused(routeExecution(request({ candidates: ["native.read"] }), catalogue)).reason).toBe("unresolved_scope");
  });

  it("passes a resolved scope through unchanged, and does not claim to have checked an Organization", async () => {
    const setup = world({ tools: [new ProbeTool("meta.campaign.pause", { risk: "HIGH_IMPACT", requiresApproval: true, permissions: ["read", "write"] })], policies: [policy(GENERAL, ["meta.campaign.pause"])] });
    const decision = routed(await route(["meta.campaign.pause"], {}, setup));
    expect(decision.scope).toEqual({ kind: "organization", integration: "meta", access: "write" });
    // Membership is the access gate's to decide at execution; the decision says so rather than pretending.
    expect(decision.approval.decidedBy).toBe("tool_executor");
  });
});

// ---------------------------------------------------------------------------
// 8. The model proposes; policy decides
// ---------------------------------------------------------------------------

describe("what a model says cannot change the decision", () => {
  const CLAIMS = {
    approval: "not_required",
    skipApproval: true,
    requiresApproval: false,
    kind: "native",
    origin: "tool_registry",
    scope: { kind: "user" },
    route: "sandbox",
    // Every one of these would flip the answer below if it were read: write is what the caller lacks.
    permissions: ["read", "write", "execute", "admin"],
    role: "owner",
    available: true,
    eligible: true,
  };

  it("ignores every claim about permissions, approval, kind and scope: it reads the candidates and nothing else of a proposal", async () => {
    const catalogue = await world().capabilities.catalogue("alice");
    const honest = routeExecution(request({ candidates: ["native.write"], grantedPermissions: ["read"] }), catalogue);
    const lying = routeExecution({ ...request({ candidates: ["native.write"], grantedPermissions: ["read"] }), ...CLAIMS } as never, catalogue);
    expect(lying).toEqual(honest);
    // The caller's permissions are the caller's, not the proposal's: write was not granted.
    expect(refused(lying).reason).toBe("missing_permission");
  });

  it("does not let a proposal change which user it is for", async () => {
    const catalogue = await world().capabilities.catalogue("alice");
    const decision = routeExecution({ ...request({ candidates: ["n8n.workflow:wf-bob"], agentId: AUTOMATION }), user: "bob", actingAs: "bob" } as never, catalogue);
    expect(refused(decision).reason).toBe("unknown_capability");
  });

  it("does not let a proposal name a capability's way past an unavailable one: candidates are names, and unknown names are refused", async () => {
    const decision = refused(await route(["native.read; sandbox.exec", "native.read\u0000", " native.read", "NATIVE.READ"]));
    expect(decision.considered.every((c) => !c.eligible)).toBe(true);
  });

  it("still says an approval-gated capability is approval-gated, and says the executor decides", async () => {
    const decision = routed(await route(["native.write"], { agentId: GENERAL }));
    expect(decision.approval).toEqual({ decidedBy: "tool_executor", described: "required" });
  });

  it("reports an ordinary read as not described as needing one, still decided by the executor", async () => {
    expect(routed(await route(["native.read"])).approval).toEqual({ decidedBy: "tool_executor", described: "not_required" });
  });

  it("does not choose by the order the model named things in", async () => {
    const decisions = await Promise.all([["native.read", "native.read2"], ["native.read2", "native.read"]].map((c) => route(c)));
    expect(decisions[0]).toEqual(decisions[1]);
    expect(refused(decisions[0]!).reason).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// 9. Determinism
// ---------------------------------------------------------------------------

describe("the same inputs always give the same decision", () => {
  const permutations = <T,>(items: readonly T[]): T[][] =>
    items.length <= 1 ? [[...items]] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));

  it("repeats exactly", async () => {
    const setup = world();
    const catalogue = await setup.capabilities.catalogue("alice");
    const req = request({ candidates: ["native.read", "n8n.workflow:wf-1", "mcp.pilot.lookup", "sandbox.exec"], agentId: AUTOMATION });
    const first = routeExecution(req, catalogue);
    for (let i = 0; i < 40; i++) expect(routeExecution(req, catalogue)).toEqual(first);
  });

  it("is the same in every order of the candidates, and of the catalogue's own lists", async () => {
    const catalogue = await world().capabilities.catalogue("alice");
    const reversed: RoutingCatalogue = { ...catalogue, available: [...catalogue.available].reverse(), unavailable: [...catalogue.unavailable].reverse(), rejected: [...catalogue.rejected].reverse() };
    const names = ["native.read", "n8n.workflow:wf-1", "mcp.pilot.lookup", "disabled.tool"];
    const base = routeExecution(request({ candidates: names, agentId: AUTOMATION }), catalogue);
    for (const order of permutations(names)) {
      expect(routeExecution(request({ candidates: order, agentId: AUTOMATION }), reversed), order.join()).toEqual(base);
    }
  });

  it("gives the same decision for an equal request built twice", async () => {
    const catalogue = await world().capabilities.catalogue("alice");
    const a = routeExecution(request({ candidates: ["native.write"] }), catalogue);
    const b = routeExecution(JSON.parse(JSON.stringify(request({ candidates: ["native.write"] }))), JSON.parse(JSON.stringify(catalogue)));
    expect(b).toEqual(a);
  });

  it("returns a frozen decision, and changes nothing it was given", async () => {
    const deepFreeze = <T,>(value: T): T => {
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
      }
      return value;
    };
    const catalogue = deepFreeze(await world().capabilities.catalogue("alice"));
    const req = deepFreeze(request({ candidates: ["native.write", "native.read"], grantedPermissions: ["read", "write"] }));
    // Both kinds of decision: this one is ambiguous (two natives), the next is routed.
    const ambiguous = routeExecution(req, catalogue);
    expect(ambiguous.outcome).toBe("refused");
    expect(Object.isFrozen(ambiguous)).toBe(true);
    expect(Object.isFrozen(ambiguous.considered)).toBe(true);

    const single = routeExecution(deepFreeze(request({ candidates: ["native.write"], grantedPermissions: ["read", "write"] })), catalogue);
    expect(single.outcome).toBe("routed");
    expect(Object.isFrozen(single)).toBe(true);
    expect(Object.isFrozen(single.considered)).toBe(true);
    if (single.outcome === "routed") expect(Object.isFrozen(single.approval)).toBe(true);
    expect(req.grantedPermissions).toEqual(["read", "write"]);
  });
});

// ---------------------------------------------------------------------------
// Permissions, voice, surface and the shape of a request
// ---------------------------------------------------------------------------

describe("the caller's permissions, the agent's floor, the turn's mode and the surface", () => {
  it("refuses a capability whose permissions the caller does not hold", async () => {
    expect(refused(await route(["native.write"], { grantedPermissions: ["read"] })).reason).toBe("missing_permission");
    expect(routed(await route(["native.write"], { grantedPermissions: ["read", "write"] })).capabilityId).toBe("native.write");
  });

  it("refuses an agent whose own permission floor the caller does not meet", async () => {
    // The automation agent's compiled-in floor is read + write.
    expect(AGENT_POLICIES[AUTOMATION]!.requiredPermissions).toEqual(["read", "write"]);
    expect(refused(await route(["native.read"], { agentId: AUTOMATION, grantedPermissions: ["read"] })).reason).toBe("agent_permission_floor");
    expect(routed(await route(["native.read"], { agentId: AUTOMATION, grantedPermissions: ["read", "write"] })).capabilityId).toBe("native.read");
  });

  it("treats a permission it does not recognise as not granted", async () => {
    expect(refused(await route(["native.write"], { grantedPermissions: ["read", "superuser" as never] })).reason).toBe("missing_permission");
  });

  it("refuses by voice what speech may not start, and allows it in text", async () => {
    const spoken = Object.keys(VOICE_REFUSED_TOOLS)[0]!;
    const setup = world({ tools: [new ProbeTool(spoken, { risk: "HIGH_IMPACT", requiresApproval: true, permissions: ["read", "write"] })], policies: [policy(GENERAL, [spoken])] });
    expect(refused(await route([spoken], { inputMode: "voice" }, setup)).reason).toBe("voice_not_allowed");
    expect(routed(await route([spoken], { inputMode: "text" }, setup)).capabilityId).toBe(spoken);
  });

  it("routes for a task only what a task may run: the schedulable table, with no agent asked", async () => {
    const real = new ToolRegistry();
    real.register(new CsvAnalyzerTool());
    real.register(new ProbeTool("orphan.read"));
    const capabilities = new CapabilityRegistry({ tools: real, agentPolicies: () => [AGENT_POLICIES[AGENT_IDS.general]!, policy(META, ["orphan.read"])] });
    const catalogue = await capabilities.catalogue("alice");

    expect(schedulableToolIds().has("data.csv.analyze")).toBe(true);
    expect(routed(routeExecution(request({ surface: "task", agentId: undefined, candidates: ["data.csv.analyze"] }), catalogue)).toolId).toBe("data.csv.analyze");
    expect(refused(routeExecution(request({ surface: "task", agentId: undefined, candidates: ["orphan.read"] }), catalogue)).reason).toBe("not_schedulable");
  });

  it.each<[string, unknown, string]>([
    ["no candidates", [], "invalid_request"],
    ["candidates that are not a list", "native.read", "invalid_request"],
    ["a candidate that is not a string", ["native.read", { id: "native.write" }], "invalid_request"],
    ["an empty candidate", [""], "invalid_request"],
    ["too many candidates", Array.from({ length: 9 }, (_, i) => `native.read${i}`), "too_many_candidates"],
  ])("refuses a proposal with %s", async (_label, candidates, reason) => {
    expect(refused(await route(candidates as never)).reason).toBe(reason);
  });

  it.each<[string, Partial<ExecutionRouteRequest>]>([
    ["no user", { userId: "" }],
    ["a user that is not a string", { userId: 7 as never }],
    ["an unknown surface", { surface: "batch" as never }],
    ["permissions that are not a list", { grantedPermissions: "read" as never }],
  ])("refuses a request with %s", async (_label, over) => {
    const catalogue = await world().capabilities.catalogue("alice");
    expect(refused(routeExecution(request({ candidates: ["native.read"], ...over }), catalogue)).reason).toBe("invalid_request");
  });

  it.each([null, undefined, {}, "x", 7, { forUser: "alice" }])("refuses safely, and never throws, for a malformed catalogue or request (%j)", (bad) => {
    expect(() => routeExecution(request({ candidates: ["native.read"] }), bad as never)).not.toThrow();
    expect(routeExecution(request({ candidates: ["native.read"] }), bad as never).outcome).toBe("refused");
    expect(() => routeExecution(bad as never, {} as never)).not.toThrow();
  });

  it("collapses a repeated candidate to one", async () => {
    const decision = routed(await route(["native.read", "native.read", "native.read"]));
    expect(decision.considered).toHaveLength(1);
  });
});

describe("a catalogue that cannot be trusted is refused, never routed from", () => {
  const base = async () => (await world().capabilities.catalogue("alice")).available.find((c) => c.id === "native.read")!;
  const catalogueOf = async (available: unknown[]): Promise<RoutingCatalogue> => ({ ...(await world().capabilities.catalogue("alice")), available: available as never });

  it("refuses the same id listed twice: it does not mean one thing", async () => {
    const d = await base();
    expect(refused(routeExecution(request({ candidates: ["native.read"] }), await catalogueOf([d, d]))).reason).toBe("ambiguous");
  });

  it("refuses a descriptor whose own availability is not available", async () => {
    const d = await base();
    const decision = routeExecution(request({ candidates: ["native.read"] }), await catalogueOf([{ ...d, availability: { status: "unavailable", reason: "disabled" } }]));
    expect(refused(decision).reason).toBe("unknown_capability");
  });

  it.each([
    ["a native capability with a workflow origin", { kind: "native", origin: "n8n_allowlist" }],
    ["a workflow with a registry origin", { kind: "n8n_workflow", origin: "tool_registry" }],
    ["a kind that does not exist", { kind: "magic", origin: "tool_registry" }],
    ["an origin that does not exist", { kind: "native", origin: "somewhere" }],
  ])("refuses %s", async (_label, over) => {
    const d = await base();
    expect(refused(routeExecution(request({ candidates: ["native.read"] }), await catalogueOf([{ ...d, ...over }]))).reason).toBe("unknown_capability");
  });

  it.each([
    ["no agents list", { agents: undefined }],
    ["no scope", { scope: undefined }],
    ["an unknown approval word", { approval: "maybe" }],
    ["no permissions list", { requiredPermissions: "read" }],
    ["an unknown spoken-turn word", { spokenTurn: "sometimes" }],
  ])("refuses a descriptor with %s", async (_label, over) => {
    const d = await base();
    expect(refused(routeExecution(request({ candidates: ["native.read"] }), await catalogueOf([{ ...d, ...over }]))).reason).toBe("unknown_capability");
  });

  it("refuses a capability that is listed as both available and unavailable: the stricter word wins", async () => {
    const real = await world().capabilities.catalogue("alice");
    const d = real.available.find((c) => c.id === "native.read")!;
    const both: RoutingCatalogue = { ...real, unavailable: [...real.unavailable, { id: "native.read", kind: "native", origin: "tool_registry", reason: "disabled", scope: d.scope }] };
    expect(refused(routeExecution(request({ candidates: ["native.read"] }), both)).reason).toBe("disabled");
  });

  it("refuses an agent the catalogue knows and the server does not: no compiled-in policy, no routing", async () => {
    const setup = world({ policies: [policy("custom-agent-without-policy", ["native.read"])] });
    expect(refused(await route(["native.read"], { agentId: "custom-agent-without-policy" }, setup)).reason).toBe("agent_not_permitted");
  });

  it("does not trust a reason it does not recognise: an unusable capability stays unusable", async () => {
    const real = await world().capabilities.catalogue("alice");
    const odd: RoutingCatalogue = { ...real, unavailable: [{ id: "weird.tool", kind: "native", origin: "tool_registry", reason: "because" as never, scope: { kind: "user" } }] };
    expect(refused(routeExecution(request({ candidates: ["weird.tool"] }), odd)).reason).toBe("unknown_capability");
  });
});

describe("ambiguity is refused, not guessed", () => {
  it("refuses two eligible capabilities of the same precedence, and lists both", async () => {
    const decision = refused(await route(["native.read", "native.read2"]));
    expect(decision.reason).toBe("ambiguous");
    expect(decision.considered.filter((c) => c.eligible).map((c) => c.capabilityId).sort()).toEqual(["native.read", "native.read2"]);
  });

  it("is not ambiguous when only one of them is eligible", async () => {
    expect(routed(await route(["native.read", "disabled.tool"])).capabilityId).toBe("native.read");
  });

  it("reports no eligible candidate, as such, when several are named and none can route", async () => {
    expect(refused(await route(["disabled.tool", "orphan.tool", "ghost.tool"])).reason).toBe("no_eligible_candidate");
  });
});

// ---------------------------------------------------------------------------
// 10. Routing is independent of execution
// ---------------------------------------------------------------------------

describe("routing executes nothing, grants nothing, approves nothing and reaches nothing", () => {
  it("never calls a tool's execute or validate, for any decision", async () => {
    const setup = world();
    const catalogue = await setup.capabilities.catalogue("alice");
    for (const candidates of [["native.read"], ["native.write"], ["n8n.workflow:wf-1"], ["mcp.pilot.lookup"], ["sandbox.exec"], ["disabled.tool"], ["native.read", "native.read2"]]) {
      routeExecution(request({ candidates, agentId: AUTOMATION }), catalogue);
      routeExecution(request({ candidates, agentId: GENERAL }), catalogue);
    }
    for (const tool of setup.tools) {
      expect(tool.executed, `${tool.id} executed`).toBe(0);
      expect(tool.validated, `${tool.id} validated`).toBe(0);
    }
  });

  it("does not grant: a decision never adds a permission, an agent or an allowlist entry", async () => {
    const setup = world();
    const catalogue = await setup.capabilities.catalogue("alice");
    const granted: ToolPermission[] = ["read"];
    routeExecution(request({ candidates: ["native.write"], grantedPermissions: granted }), catalogue);
    expect(granted).toEqual(["read"]);
    expect(refused(routeExecution(request({ candidates: ["native.write"], grantedPermissions: granted }), catalogue)).reason).toBe("missing_permission");
  });

  it("holds no function and no handle on a tool: a decision is plain data", async () => {
    const decision = await route(["native.write"]);
    const text = JSON.stringify(decision);
    expect(JSON.parse(text)).toEqual(decision);
    const walk = (value: unknown): void => {
      expect(typeof value).not.toBe("function");
      if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(decision);
  });

  // The module is read as text: what it imports and what it calls.
  const source = readFileSync(new URL("../../../packages/agents/src/execution-router.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("imports only core and the agent policy table", () => {
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!).sort();
    expect(specifiers).toEqual(["./agent-policy.js", "@jarvis/core"]);
  });

  it("is synchronous and has no clock, randomness, environment, network or console", () => {
    expect(source).not.toMatch(/\basync\b|\bawait\b|\bPromise\b|\.then\s*\(/);
    expect(source).not.toMatch(/\b(?:Date\.now|new Date|Math\.random|setTimeout|setInterval|process\.|globalThis|fetch\s*\(|console\.|crypto\.|require\s*\(|import\s*\()/);
  });

  it("calls no tool method and holds no executor, registry, approval, permission service, repository or model", () => {
    expect(source).not.toMatch(/\.\s*execute\s*\(|\.\s*validate\s*\(|\[\s*["']execute["']\s*\]/);
    expect(source).not.toMatch(/ToolExecutor|IToolExecutor|ToolRegistry|ApprovalRepository|IApprovalManager|requestApproval|PermissionService|hasPermission|IPermissionChecker|IN8nRepository|PrismaClient|IAIProvider|AuditLogger/);
  });

  it("names no sandbox tool, as the tool, agent and core packages may not", () => {
    expect(source).not.toMatch(/["'`](?:n8n[.:-])?sandbox[.:][a-z]/i);
  });
});
