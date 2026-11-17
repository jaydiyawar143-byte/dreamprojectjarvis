// ---------------------------------------------------------------------------
// UEE-1 — execution capability descriptors and the unified outcome contract.
//
// Pure, like the module under test: no registry, no database, no executor, no
// network. The tools, agents and workflows here are plain objects handed to
// `deriveCapabilities`; the tools carry an `execute` that THROWS, so a
// derivation that ever ran one would fail loudly instead of passing quietly.
//
// What is pinned, in the order of the brief:
//   1. native capabilities derive from registered tools, with their real risk,
//      approval, scope and voice rules;
//   2. n8n workflows derive from the caller's own allow-list, behind the one
//      runner tool, and never carry their webhook path;
//   3. the sandbox is NEVER available in this release, however it is registered,
//      allowlisted, enabled, asked for or "unlocked" by a fact;
//   4. an unknown or unregistered capability is rejected, never available;
//   5. an agent's allowlist decides who may have it;
//   6. a shared connection's Organization scope survives derivation, and nothing
//      here can invent one;
//   7. missing or invalid metadata fails safely: refused, listed, never thrown;
//   8. an uncertain outcome stays uncertain: never success, never an ordinary
//      failure, never retryable;
//   9. nothing here executes or reaches anything outside its arguments.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  EXECUTION_KINDS,
  deriveCapabilities,
  isExecutionKind,
  isSafeToRetryOutcome,
  isUncertainOutcome,
  outcomeFromToolExecution,
  resolveCapability,
  type CapabilityDescriptor,
  type CapabilityToolInput,
  type DeriveCapabilitiesInput,
  type UnifiedExecutionOutcome,
} from "../src/execution-capability.js";
import { SHARED_CONNECTION_TOOLS } from "../src/types/tenant.js";
import { VOICE_REFUSED_TOOLS } from "../src/voice-tool-policy.js";
import type { ToolExecutionResult } from "../src/types/execution.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A tool whose methods throw: derivation must read its metadata and nothing else. */
type TrapTool = CapabilityToolInput & { execute: () => never; validate: () => never };

function tool(id: string, over: Partial<CapabilityToolInput> = {}): TrapTool {
  return {
    id,
    name: `Tool ${id}`,
    description: `Does ${id}`,
    category: "integration",
    risk: "READ_ONLY",
    requiresApproval: false,
    requiredPermissions: ["read"],
    enabled: true,
    execute: () => {
      throw new Error(`derivation executed ${id}`);
    },
    validate: () => {
      throw new Error(`derivation validated ${id}`);
    },
    ...over,
  };
}

const agent = (agentId: string, allowedTools: string[], writesRequireApproval = true) => ({ agentId, allowedTools, writesRequireApproval });

const RUNNER = "n8n.trigger";
const runnerTool = (over: Partial<CapabilityToolInput> = {}) =>
  tool(RUNNER, { category: "integration", risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: true, requiredPermissions: ["read", "write"], ...over });

const workflow = (id: string, over: Partial<{ userId: string; name: string; isActive: boolean }> = {}) => ({
  id,
  userId: "user-1",
  name: `Workflow ${id}`,
  isActive: true,
  ...over,
});

function derive(over: Partial<DeriveCapabilitiesInput> = {}) {
  return deriveCapabilities({ tools: [], agents: [], ...over });
}

const byId = (capabilities: readonly CapabilityDescriptor[], id: string): CapabilityDescriptor => {
  const found = capabilities.find((capability) => capability.id === id);
  expect(found, `no capability ${id}`).toBeDefined();
  return found!;
};

/** The sandbox tool id the future wiring would use. Written here only; the module under test has no such literal. */
const SANDBOX_ID = "sandbox.exec";

// ---------------------------------------------------------------------------
// 1. Native capabilities
// ---------------------------------------------------------------------------

describe("native capability derivation", () => {
  it("describes a registered, granted read tool from its own metadata", () => {
    const { capabilities, rejected } = derive({
      tools: [tool("data.csv.analyze", { category: "research", description: "Analyze CSV data" })],
      agents: [agent("analytics", ["data.csv.analyze"]), agent("general", ["data.csv.analyze"])],
    });

    expect(rejected).toEqual([]);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]).toMatchObject({
      id: "data.csv.analyze",
      kind: "native",
      origin: "tool_registry",
      toolId: "data.csv.analyze",
      description: "Analyze CSV data",
      requiredPermissions: ["read"],
      risk: "READ_ONLY",
      approval: "not_required",
      scope: { kind: "user" },
      idempotency: "read_only",
      agents: ["analytics", "general"],
      availability: { status: "available" },
    });
  });

  it("takes the approval requirement from the tool", () => {
    const { capabilities } = derive({
      tools: [tool("meta.campaign.pause", { risk: "HIGH_IMPACT", requiresApproval: true, requiredPermissions: ["read", "write"] })],
      agents: [agent("meta-ads", ["meta.campaign.pause"], false)],
    });
    expect(byId(capabilities, "meta.campaign.pause")).toMatchObject({ risk: "HIGH_IMPACT", approval: "required" });
  });

  it("takes it from the agent policy too: a write an agent holds under writesRequireApproval needs one, whatever the tool says", () => {
    const written = tool("x.write", { risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: false });
    expect(byId(derive({ tools: [written], agents: [agent("a", ["x.write"], true)] }).capabilities, "x.write").approval).toBe("required");
    // Where no holding agent demands it, the tool's own word stands: nothing is added or invented.
    expect(byId(derive({ tools: [written], agents: [agent("a", ["x.write"], false)] }).capabilities, "x.write").approval).toBe("not_required");
    // A read is never made to need one by the policy.
    const read = tool("x.read");
    expect(byId(derive({ tools: [read], agents: [agent("a", ["x.read"], true)] }).capabilities, "x.read").approval).toBe("not_required");
  });

  it("treats a policy that does not say whether writes need approval as the strict one", () => {
    const written = tool("x.write", { risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: false });
    const silent = { agentId: "a", allowedTools: ["x.write"] } as never;
    expect(byId(derive({ tools: [written], agents: [silent] }).capabilities, "x.write").approval).toBe("required");
  });

  it("holds a spoken turn off exactly the tools the voice policy refuses", () => {
    const refusedId = Object.keys(VOICE_REFUSED_TOOLS)[0]!;
    const { capabilities } = derive({
      tools: [tool(refusedId, { risk: "HIGH_IMPACT", requiresApproval: true }), tool("plain.read")],
      agents: [agent("a", [refusedId, "plain.read"])],
    });
    expect(byId(capabilities, refusedId).spokenTurn).toBe("refused");
    expect(byId(capabilities, "plain.read").spokenTurn).toBe("may_start");
  });

  it("keeps an MCP tool a native-kind capability of its own origin, distinct from the registry's", () => {
    const { capabilities } = derive({
      tools: [tool("mcp.pilot.lookup"), tool("meta.accounts")],
      agents: [agent("general", ["mcp.pilot.lookup", "meta.accounts"])],
    });
    expect(byId(capabilities, "mcp.pilot.lookup")).toMatchObject({ kind: "native", origin: "mcp" });
    expect(byId(capabilities, "meta.accounts")).toMatchObject({ kind: "native", origin: "tool_registry" });
  });

  it("states what it does not know as unknown, and only accepts a verified fact to say more", () => {
    const base = derive({ tools: [tool("a.write", { risk: "LOW_IMPACT" })], agents: [agent("a", ["a.write"], false)] });
    expect(byId(base.capabilities, "a.write")).toMatchObject({ dataEgress: "unknown", idempotency: "unknown", timeoutClass: "executor_default" });

    const withFacts = derive({
      tools: [tool("a.write", { risk: "LOW_IMPACT" })],
      agents: [agent("a", ["a.write"], false)],
      facts: { "a.write": { dataEgress: "provider", idempotency: "idempotent_keyed", timeoutClass: "long_running" } },
    });
    expect(byId(withFacts.capabilities, "a.write")).toMatchObject({ dataEgress: "provider", idempotency: "idempotent_keyed", timeoutClass: "long_running" });
  });

  it("ignores a fact whose value is not one of the contract's, rather than trusting it", () => {
    const { capabilities } = derive({
      tools: [tool("a.write", { risk: "LOW_IMPACT" })],
      agents: [agent("a", ["a.write"], false)],
      facts: { "a.write": { dataEgress: "none-at-all", idempotency: 7, timeoutClass: null } as never },
    });
    expect(byId(capabilities, "a.write")).toMatchObject({ dataEgress: "unknown", idempotency: "unknown", timeoutClass: "executor_default" });
  });

  it("never describes a read as having an unknown idempotency or egress it cannot know: egress stays unknown", () => {
    const { capabilities } = derive({ tools: [tool("r.read")], agents: [agent("a", ["r.read"])] });
    expect(byId(capabilities, "r.read")).toMatchObject({ idempotency: "read_only", dataEgress: "unknown" });
  });
});

// ---------------------------------------------------------------------------
// 2. n8n workflows
// ---------------------------------------------------------------------------

describe("n8n workflow capability derivation", () => {
  const base = (over: Partial<DeriveCapabilitiesInput> = {}): DeriveCapabilitiesInput => ({
    tools: [runnerTool()],
    agents: [agent("automation", [RUNNER])],
    n8nWorkflows: { userId: "user-1", records: [workflow("wf-1"), workflow("wf-2", { name: "Lead capture" })] },
    ...over,
  });

  it("derives one capability per workflow the caller registered, run by the one runner tool", () => {
    const { capabilities, rejected } = deriveCapabilities(base());
    expect(rejected).toEqual([]);

    expect(byId(capabilities, "n8n.workflow:wf-2")).toMatchObject({
      kind: "n8n_workflow",
      origin: "n8n_allowlist",
      toolId: RUNNER,
      name: "Lead capture",
      risk: "EXTERNAL_SIDE_EFFECT",
      approval: "required",
      requiredPermissions: ["read", "write"],
      scope: { kind: "user" },
      dataEgress: "provider",
      idempotency: "idempotent_keyed",
      agents: ["automation"],
      availability: { status: "available" },
    });
  });

  it("does not list the runner tool as a second, native capability", () => {
    const { capabilities } = deriveCapabilities(base());
    expect(capabilities.map((capability) => capability.id).sort()).toEqual(["n8n.workflow:wf-1", "n8n.workflow:wf-2"]);
    expect(capabilities.some((capability) => capability.id === RUNNER)).toBe(false);
  });

  it("carries a workflow's name and id and nothing else: no webhook path, no user id", () => {
    const records = [{ ...workflow("wf-9"), webhookPath: "secret-hook-path-123", extra: "x" }];
    const { capabilities } = deriveCapabilities(base({ n8nWorkflows: { userId: "user-1", records } }));
    const text = JSON.stringify(capabilities);
    expect(text).not.toContain("secret-hook-path-123");
    expect(text).not.toContain("user-1");
  });

  it("marks an inactive workflow unavailable, and keeps it listed", () => {
    const { capabilities } = deriveCapabilities(base({ n8nWorkflows: { userId: "user-1", records: [workflow("wf-off", { isActive: false })] } }));
    expect(byId(capabilities, "n8n.workflow:wf-off").availability).toEqual({ status: "unavailable", reason: "workflow_inactive" });
  });

  it("makes every workflow unavailable when no agent may run the runner", () => {
    const { capabilities } = deriveCapabilities(base({ agents: [agent("general", ["other.tool"])] }));
    for (const capability of capabilities) expect(capability.availability).toEqual({ status: "unavailable", reason: "workflow_runner_unavailable" });
  });

  it("makes every workflow unavailable when the runner is switched off", () => {
    const { capabilities } = deriveCapabilities(base({ tools: [runnerTool({ enabled: false })] }));
    for (const capability of capabilities) expect(capability.availability.status).toBe("unavailable");
  });

  it("derives nothing, and says why, when the runner tool is not registered at all", () => {
    const { capabilities, rejected } = deriveCapabilities(base({ tools: [] }));
    expect(capabilities).toEqual([]);
    expect(rejected.map((r) => `${r.id}:${r.reason}`).sort()).toEqual([
      // The agent's allowlist still names the runner, and nothing registered it: refused, not believed.
      "n8n.trigger:not_registered",
      "n8n.workflow:wf-1:workflow_runner_unavailable",
      "n8n.workflow:wf-2:workflow_runner_unavailable",
    ]);
  });

  it("rejects a workflow that belongs to another user, so a mixed list cannot lend one account's workflows to another", () => {
    const { capabilities, rejected } = deriveCapabilities(
      base({ n8nWorkflows: { userId: "user-1", records: [workflow("mine"), workflow("theirs", { userId: "user-2" })] } })
    );
    expect(capabilities.map((c) => c.id)).toEqual(["n8n.workflow:mine"]);
    expect(rejected).toEqual([{ id: "n8n.workflow:theirs", reason: "foreign_workflow", source: "n8n_allowlist" }]);
  });

  it("holds the workflow to the runner's voice rule and agents", () => {
    const { capabilities } = deriveCapabilities(base({ agents: [agent("automation", [RUNNER]), agent("general", [RUNNER])] }));
    expect(byId(capabilities, "n8n.workflow:wf-1").agents).toEqual(["automation", "general"]);
  });

  it("is a different kind from an MCP tool and from the sandbox", () => {
    const { capabilities } = deriveCapabilities(
      base({ tools: [runnerTool(), tool("mcp.pilot.lookup"), tool(SANDBOX_ID)], agents: [agent("automation", [RUNNER, "mcp.pilot.lookup", SANDBOX_ID])] })
    );
    expect(byId(capabilities, "n8n.workflow:wf-1")).toMatchObject({ kind: "n8n_workflow", origin: "n8n_allowlist" });
    expect(byId(capabilities, "mcp.pilot.lookup")).toMatchObject({ kind: "native", origin: "mcp" });
    expect(byId(capabilities, SANDBOX_ID)).toMatchObject({ kind: "sandbox", origin: "sandbox" });
  });

  it("derives no workflow at all when none is registered", () => {
    expect(deriveCapabilities(base({ n8nWorkflows: { userId: "user-1", records: [] } })).capabilities).toEqual([]);
    expect(deriveCapabilities(base({ n8nWorkflows: undefined })).capabilities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The sandbox stays unavailable
// ---------------------------------------------------------------------------

describe("the sandbox is never available in this release", () => {
  const registeredEverywhere = (over: Partial<DeriveCapabilitiesInput> = {}): DeriveCapabilitiesInput => ({
    tools: [tool(SANDBOX_ID, { risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: true, requiredPermissions: ["read", "write"] })],
    agents: [agent("general", [SANDBOX_ID])],
    ...over,
  });

  it("has no capability at all while no sandbox tool is registered", () => {
    const { capabilities, rejected } = derive({ agents: [agent("general", [SANDBOX_ID])] });
    expect(capabilities).toEqual([]);
    // An allowlist that names a tool nothing registered is refused, not believed.
    expect(rejected).toEqual([{ id: SANDBOX_ID, reason: "not_registered", source: "agent_allowlist" }]);
    expect(resolveCapability(deriveCapabilities({ tools: [], agents: [] }), SANDBOX_ID)).toEqual({ ok: false, reason: "unknown_capability" });
  });

  it("is unavailable when registered, enabled, allowlisted and asked for by the right agent", () => {
    const derived = deriveCapabilities(registeredEverywhere({ forAgent: "general" }));
    const capability = byId(derived.capabilities, SANDBOX_ID);

    expect(capability).toMatchObject({
      kind: "sandbox",
      origin: "sandbox",
      scope: { kind: "unresolved" },
      timeoutClass: "long_running",
      dataEgress: "unknown",
      availability: { status: "unavailable", reason: "sandbox_not_exposed" },
    });
    expect(resolveCapability(derived, SANDBOX_ID)).toEqual({ ok: false, reason: "sandbox_not_exposed" });
  });

  it.each([
    ["registered but allowlisted by no agent", registeredEverywhere({ agents: [] })],
    ["disabled", registeredEverywhere({ tools: [tool(SANDBOX_ID, { enabled: false })] })],
    ["asked for by an agent that does not hold it", registeredEverywhere({ forAgent: "someone-else" })],
  ])("is unavailable when %s, and for the one reason: it is not exposed", (_label, input) => {
    expect(byId(deriveCapabilities(input).capabilities, SANDBOX_ID).availability).toEqual({ status: "unavailable", reason: "sandbox_not_exposed" });
  });

  it.each(["sandbox.run", "sandbox:exec", "n8n.sandbox.run", "N8N-SANDBOX-RUN", "sandbox-exec"])("is recognised by its id, not its category or its description: %s", (id) => {
    const { capabilities } = deriveCapabilities({
      tools: [tool(id, { category: "research", description: "A harmless data helper", risk: "READ_ONLY" })],
      agents: [agent("general", [id])],
    });
    expect(byId(capabilities, id)).toMatchObject({ kind: "sandbox", availability: { status: "unavailable", reason: "sandbox_not_exposed" } });
  });

  it("is not unlocked by a fact, a workflow, an agent's policy or the caller's choice of agent", () => {
    const derived = deriveCapabilities(
      registeredEverywhere({
        forAgent: "general",
        agents: [agent("general", [SANDBOX_ID], false)],
        facts: { [SANDBOX_ID]: { dataEgress: "none", idempotency: "not_idempotent", timeoutClass: "executor_default" } },
        sharedConnectionTools: { [SANDBOX_ID]: { integration: "n8n", access: "write" } },
      })
    );
    const capability = byId(derived.capabilities, SANDBOX_ID);
    expect(capability.availability).toEqual({ status: "unavailable", reason: "sandbox_not_exposed" });
    // Nor does a fact describe it: its egress is chosen when a sandbox is created, so none is taken.
    expect(capability).toMatchObject({ dataEgress: "unknown", idempotency: "unknown", timeoutClass: "long_running" });
  });

  it("is never given an Organization scope it was not mapped to: its scope is unresolved", () => {
    const derived = deriveCapabilities(registeredEverywhere({ sharedConnectionTools: { [SANDBOX_ID]: { integration: "n8n", access: "write" } } }));
    expect(byId(derived.capabilities, SANDBOX_ID).scope).toEqual({ kind: "unresolved" });
  });

  it("leaves the sandbox out of every other tool's availability: nothing else is affected by its presence", () => {
    const { capabilities } = deriveCapabilities(registeredEverywhere({ tools: [tool(SANDBOX_ID), tool("plain.read")], agents: [agent("general", [SANDBOX_ID, "plain.read"])] }));
    expect(byId(capabilities, "plain.read").availability).toEqual({ status: "available" });
  });
});

// ---------------------------------------------------------------------------
// 4. Unknown capabilities
// ---------------------------------------------------------------------------

describe("unknown capabilities are rejected", () => {
  it("rejects an allowlisted id that no tool registered, and lists no capability for it", () => {
    const { capabilities, rejected } = derive({ tools: [tool("real.tool")], agents: [agent("a", ["real.tool", "ghost.tool"]), agent("b", ["ghost.tool"])] });
    expect(capabilities.map((c) => c.id)).toEqual(["real.tool"]);
    expect(rejected).toEqual([{ id: "ghost.tool", reason: "not_registered", source: "agent_allowlist" }]);
  });

  it("resolves only what was derived and is available", () => {
    const derived = derive({ tools: [tool("real.tool"), tool("orphan.tool")], agents: [agent("a", ["real.tool"])] });
    expect(resolveCapability(derived, "real.tool")).toMatchObject({ ok: true, capability: { id: "real.tool" } });
    expect(resolveCapability(derived, "orphan.tool")).toEqual({ ok: false, reason: "not_granted" });
    expect(resolveCapability(derived, "ghost.tool")).toEqual({ ok: false, reason: "unknown_capability" });
    expect(resolveCapability(derived, "")).toEqual({ ok: false, reason: "unknown_capability" });
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "prototype"])("does not resolve an inherited property name: %s", (id) => {
    expect(resolveCapability(derive({ tools: [tool("real.tool")], agents: [agent("a", ["real.tool"])] }), id)).toEqual({ ok: false, reason: "unknown_capability" });
  });

  it("does not resolve a non-string id", () => {
    expect(resolveCapability(derive(), undefined as never)).toEqual({ ok: false, reason: "unknown_capability" });
    expect(resolveCapability(derive(), 42 as never)).toEqual({ ok: false, reason: "unknown_capability" });
  });

  it("says why a derived-but-rejected id is refused", () => {
    const derived = derive({ tools: [tool("bad.tool", { risk: "NOPE" as never })], agents: [agent("a", ["bad.tool"])] });
    expect(resolveCapability(derived, "bad.tool")).toEqual({ ok: false, reason: "invalid_metadata" });
  });
});

// ---------------------------------------------------------------------------
// 5. Agent allowlists
// ---------------------------------------------------------------------------

describe("agent allowlists are respected", () => {
  const input = {
    tools: [tool("shared.read"), tool("meta.only"), tool("nobody.has")],
    agents: [agent("general", ["shared.read"]), agent("meta-ads", ["shared.read", "meta.only"])],
  };

  it("lists, for each capability, exactly the agents whose allowlist names it, in a stable order", () => {
    const { capabilities } = deriveCapabilities(input);
    expect(byId(capabilities, "shared.read").agents).toEqual(["general", "meta-ads"]);
    expect(byId(capabilities, "meta.only").agents).toEqual(["meta-ads"]);
    expect(byId(capabilities, "nobody.has").agents).toEqual([]);
  });

  it("makes a capability no agent holds unavailable: registered is not granted", () => {
    expect(byId(deriveCapabilities(input).capabilities, "nobody.has").availability).toEqual({ status: "unavailable", reason: "not_granted" });
  });

  it("judges availability for one agent when asked", () => {
    const forGeneral = deriveCapabilities({ ...input, forAgent: "general" }).capabilities;
    expect(byId(forGeneral, "shared.read").availability.status).toBe("available");
    expect(byId(forGeneral, "meta.only").availability).toEqual({ status: "unavailable", reason: "not_granted" });

    const forMeta = deriveCapabilities({ ...input, forAgent: "meta-ads" }).capabilities;
    expect(byId(forMeta, "meta.only").availability.status).toBe("available");
  });

  it("makes everything unavailable for an agent that does not exist", () => {
    for (const capability of deriveCapabilities({ ...input, forAgent: "ghost-agent" }).capabilities) {
      expect(capability.availability).toEqual({ status: "unavailable", reason: "not_granted" });
    }
  });

  it("keeps a disabled tool unavailable even where an agent holds it", () => {
    const { capabilities } = derive({ tools: [tool("off.tool", { enabled: false })], agents: [agent("a", ["off.tool"])] });
    expect(byId(capabilities, "off.tool").availability).toEqual({ status: "unavailable", reason: "disabled" });
  });

  it("makes no capability available that no allowlist names, whatever the tool says about itself", () => {
    const { capabilities } = derive({ tools: [tool("self.declared", { enabled: true, requiresApproval: false })], agents: [] });
    expect(byId(capabilities, "self.declared").availability.status).toBe("unavailable");
  });

  it("does not let an agent's approval policy widen the agents list: only an allowlist grants", () => {
    const { capabilities } = derive({ tools: [tool("a.tool")], agents: [agent("strict", [], true)] });
    expect(byId(capabilities, "a.tool").agents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Organization / tenant scope
// ---------------------------------------------------------------------------

describe("Organization scope is preserved, and never invented", () => {
  it("gives every registered shared-connection tool the scope the shared table states", () => {
    const ids = Object.keys(SHARED_CONNECTION_TOOLS);
    const { capabilities } = derive({ tools: ids.map((id) => tool(id)), agents: [agent("general", ids)] });

    expect(capabilities.length).toBe(ids.length);
    for (const id of ids) {
      const entry = SHARED_CONNECTION_TOOLS[id]!;
      expect(byId(capabilities, id).scope, id).toEqual({ kind: "organization", integration: entry.integration, access: entry.access });
    }
  });

  it("gives a write on a shared connection its write access, and a read its read access", () => {
    const { capabilities } = derive({ tools: [tool("meta.accounts"), tool("meta.campaign.pause")], agents: [agent("a", ["meta.accounts", "meta.campaign.pause"])] });
    expect(byId(capabilities, "meta.accounts").scope).toEqual({ kind: "organization", integration: "meta", access: "read" });
    expect(byId(capabilities, "meta.campaign.pause").scope).toEqual({ kind: "organization", integration: "meta", access: "write" });
  });

  it("leaves a tool the table does not name with the caller's own scope, not an Organization", () => {
    const { capabilities } = derive({ tools: [tool("whatsapp.send"), tool("data.csv.analyze")], agents: [agent("a", ["whatsapp.send", "data.csv.analyze"])] });
    expect(byId(capabilities, "whatsapp.send").scope).toEqual({ kind: "user" });
    expect(byId(capabilities, "data.csv.analyze").scope).toEqual({ kind: "user" });
  });

  it("reads the table it is given, so a deployment's own table, or none, decides", () => {
    const custom = derive({ tools: [tool("custom.tool"), tool("meta.accounts")], agents: [agent("a", ["custom.tool", "meta.accounts"])], sharedConnectionTools: { "custom.tool": { integration: "whatsapp", access: "read" } } });
    expect(byId(custom.capabilities, "custom.tool").scope).toEqual({ kind: "organization", integration: "whatsapp", access: "read" });
    expect(byId(custom.capabilities, "meta.accounts").scope).toEqual({ kind: "user" });
  });

  it("is not changed by a fact: scope comes from the table alone", () => {
    const { capabilities } = derive({
      tools: [tool("data.csv.analyze")],
      agents: [agent("a", ["data.csv.analyze"])],
      facts: { "data.csv.analyze": { scope: { kind: "organization", integration: "meta", access: "write" } } } as never,
    });
    expect(byId(capabilities, "data.csv.analyze").scope).toEqual({ kind: "user" });
  });

  // Each fault alone, so neither check can hide behind the other.
  it.each<[string, unknown]>([
    ["an integration that does not exist, with a valid access", { integration: "not-an-integration", access: "read" }],
    ["a valid integration, with an access that is not read or write", { integration: "meta", access: "root" }],
    ["an integration inherited from Object.prototype", { integration: "constructor", access: "write" }],
    ["no access at all", { integration: "meta" }],
    ["a string instead of an entry", "meta"],
  ])("ignores a table entry with %s, rather than inventing a scope from it", (_label, entry) => {
    const { capabilities } = derive({
      tools: [tool("odd.tool")],
      agents: [agent("a", ["odd.tool"])],
      sharedConnectionTools: { "odd.tool": entry } as never,
    });
    expect(byId(capabilities, "odd.tool").scope).toEqual({ kind: "user" });
  });

  it("does not let the caller's identity select a scope: workflows are the one thing keyed by a user", () => {
    const { capabilities } = deriveCapabilities({
      tools: [runnerTool()],
      agents: [agent("automation", [RUNNER])],
      n8nWorkflows: { userId: "user-1", records: [workflow("wf-1")] },
    });
    expect(byId(capabilities, "n8n.workflow:wf-1").scope).toEqual({ kind: "user" });
  });
});

// ---------------------------------------------------------------------------
// 7. Missing or invalid metadata fails safely
// ---------------------------------------------------------------------------

describe("missing or invalid metadata fails safely", () => {
  const good = tool("good.tool");
  const agents = [agent("a", ["good.tool", "broken"])];

  it.each<[string, unknown]>([
    ["no id", { ...good, id: undefined }],
    ["an empty id", { ...good, id: "" }],
    ["an id with whitespace", { ...good, id: "bad id" }],
    ["a non-string name", { ...good, id: "broken", name: 7 }],
    ["a missing description", { ...good, id: "broken", description: undefined }],
    ["an unknown risk", { ...good, id: "broken", risk: "WHATEVER" }],
    ["a missing risk", { ...good, id: "broken", risk: undefined }],
    ["an unknown category", { ...good, id: "broken", category: "gadgets" }],
    ["a non-boolean requiresApproval", { ...good, id: "broken", requiresApproval: "yes" }],
    ["a missing requiresApproval", { ...good, id: "broken", requiresApproval: undefined }],
    ["a non-boolean enabled", { ...good, id: "broken", enabled: 1 }],
    ["permissions that are not an array", { ...good, id: "broken", requiredPermissions: "read" }],
    ["an unknown permission", { ...good, id: "broken", requiredPermissions: ["read", "root"] }],
    ["null", null],
    ["a string", "good.tool"],
  ])("refuses a tool with %s, lists it, and throws nothing", (_label, bad) => {
    const result = deriveCapabilities({ tools: [good, bad as never], agents });
    expect(result.capabilities.map((c) => c.id)).toEqual(["good.tool"]);
    expect(result.rejected.every((r) => r.reason === "invalid_metadata" || r.reason === "not_registered")).toBe(true);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it("does not make a tool available that failed validation, even though an agent's allowlist names it", () => {
    const derived = deriveCapabilities({ tools: [tool("broken", { risk: "WHATEVER" as never })], agents: [agent("a", ["broken"])] });
    expect(derived.capabilities).toEqual([]);
    expect(derived.rejected).toContainEqual({ id: "broken", reason: "invalid_metadata", source: "tool_registry" });
    expect(resolveCapability(derived, "broken").ok).toBe(false);
  });

  it("refuses an id registered twice, both copies: two answers to one id is not an answer", () => {
    const derived = deriveCapabilities({ tools: [tool("dup.tool"), tool("dup.tool", { risk: "HIGH_IMPACT" })], agents: [agent("a", ["dup.tool"])] });
    expect(derived.capabilities).toEqual([]);
    expect(derived.rejected).toContainEqual({ id: "dup.tool", reason: "duplicate_id", source: "tool_registry" });
  });

  it("keeps the workflow namespace to workflows: a tool cannot register an id a workflow would have", () => {
    const derived = deriveCapabilities({ tools: [tool("n8n.workflow:wf-1"), runnerTool()], agents: [agent("a", ["n8n.workflow:wf-1", RUNNER])], n8nWorkflows: { userId: "user-1", records: [workflow("wf-1")] } });
    expect(derived.rejected).toContainEqual({ id: "n8n.workflow:wf-1", reason: "invalid_metadata", source: "tool_registry" });
    // Only the real workflow is a capability, and it is the workflow kind.
    expect(derived.capabilities.map((c) => `${c.id}:${c.kind}`)).toEqual(["n8n.workflow:wf-1:n8n_workflow"]);
  });

  it("does not throw on a malformed input object, and derives nothing from it", () => {
    for (const bad of [{}, { tools: undefined, agents: undefined }, { tools: "x", agents: 7 }, { tools: [undefined, null], agents: [null, {}] }, null, undefined]) {
      const result = deriveCapabilities(bad as never);
      expect(result.capabilities).toEqual([]);
      expect(Array.isArray(result.rejected)).toBe(true);
    }
  });

  it("ignores a malformed agent, and a malformed allowlist entry, instead of granting from them", () => {
    const { capabilities } = deriveCapabilities({
      tools: [tool("a.tool")],
      agents: [{ agentId: "ok", allowedTools: ["a.tool", 7, null, {}] as never, writesRequireApproval: true }, { agentId: 5, allowedTools: ["a.tool"] } as never, { allowedTools: ["a.tool"] } as never],
    });
    expect(byId(capabilities, "a.tool").agents).toEqual(["ok"]);
  });

  it("rejects a workflow record with no usable id or name", () => {
    const { capabilities, rejected } = deriveCapabilities({
      tools: [runnerTool()],
      agents: [agent("automation", [RUNNER])],
      n8nWorkflows: { userId: "user-1", records: [workflow("fine"), { ...workflow("x"), id: "" }, { ...workflow("y"), name: 3 } as never, null as never] },
    });
    expect(capabilities.map((c) => c.id)).toEqual(["n8n.workflow:fine"]);
    expect(rejected.filter((r) => r.reason === "invalid_metadata").length).toBeGreaterThanOrEqual(2);
  });

  it("accepts nothing through a cast: a descriptor field the tool does not state is never filled from thin air", () => {
    const { capabilities } = deriveCapabilities({ tools: [tool("t.tool", { requiredPermissions: ["read"] })], agents: [agent("a", ["t.tool"])] });
    const keys = Object.keys(capabilities[0]!).sort();
    expect(keys).toEqual(
      ["agents", "approval", "availability", "dataEgress", "description", "id", "idempotency", "kind", "name", "origin", "requiredPermissions", "risk", "scope", "spokenTurn", "timeoutClass", "toolId"].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// 8. The unified outcome
// ---------------------------------------------------------------------------

describe("the unified execution outcome", () => {
  const NATIVE_READ = { id: "data.csv.analyze", kind: "native", risk: "READ_ONLY" } as const;
  const NATIVE_WRITE = { id: "meta.campaign.pause", kind: "native", risk: "HIGH_IMPACT" } as const;

  const execution = (over: Partial<ToolExecutionResult> = {}): ToolExecutionResult => ({
    executionId: "exec-1",
    toolId: "some.tool",
    status: "completed",
    result: { success: true, data: { rows: 3 } },
    startedAt: new Date(0),
    completedAt: new Date(10),
    durationMs: 10,
    ...over,
  });

  const outcome = (over: Partial<ToolExecutionResult>, capability: Pick<CapabilityDescriptor, "id" | "kind" | "risk"> = NATIVE_READ): UnifiedExecutionOutcome =>
    outcomeFromToolExecution(execution(over), capability);

  describe("success", () => {
    it("is a success with no side effect for a read", () => {
      expect(outcome({})).toMatchObject({ status: "succeeded", sideEffect: "none", retryable: false, capabilityId: "data.csv.analyze", kind: "native" });
    });

    it("is a success with a confirmed side effect for a write", () => {
      expect(outcome({}, NATIVE_WRITE)).toMatchObject({ status: "succeeded", sideEffect: "confirmed" });
    });

    it("needs a result that says success: a completed status without one is not claimed as success", () => {
      expect(outcome({ result: undefined }).status).toBe("failed");
      expect(outcome({ result: undefined }, NATIVE_WRITE).status).toBe("uncertain");
      expect(outcome({ result: { success: false } }, NATIVE_WRITE).status).toBe("uncertain");
    });
  });

  describe("pending", () => {
    it.each([
      ["approval_required", "approval_required"],
      ["approval_pending", "approval_pending"],
      ["clarification_required", "clarification_required"],
    ] as const)("%s is pending, with nothing executed", (status, reason) => {
      expect(outcome({ status, result: undefined, approvalId: "ap-1" }, NATIVE_WRITE)).toMatchObject({ status: "pending", reason, sideEffect: "none", retryable: false });
    });

    it("keeps the approval id as evidence", () => {
      expect(outcome({ status: "approval_pending", result: undefined, approvalId: "ap-1" }, NATIVE_WRITE).evidence).toMatchObject({ approvalId: "ap-1" });
    });

    it.each(["pending", "validating", "executing"] as const)("a run still %s is pending, and for a write it is not claimed to have had no effect", (status) => {
      expect(outcome({ status, result: undefined })).toMatchObject({ status: "pending", reason: "in_progress", sideEffect: "none" });
      expect(outcome({ status, result: undefined }, NATIVE_WRITE)).toMatchObject({ status: "pending", reason: "in_progress", sideEffect: "possible" });
    });
  });

  describe("failure", () => {
    it.each(["permission_denied", "approval_denied"] as const)("%s is a refusal: nothing ran, nothing to retry", (status) => {
      expect(outcome({ status, result: undefined, error: "Missing permission: write" }, NATIVE_WRITE)).toMatchObject({
        status: "failed",
        failure: { kind: "refused" },
        sideEffect: "none",
        retryable: false,
      });
    });

    it.each(["not_requested", "unavailable"] as const)("%s is a failure that did not run", (status) => {
      expect(outcome({ status, result: undefined }, NATIVE_WRITE)).toMatchObject({ status: "failed", failure: { kind: "not_run" }, sideEffect: "none", retryable: false });
    });

    it("a read that returned a failure is a failure that can be retried", () => {
      expect(outcome({ status: "failed", result: { success: false, error: "Upstream hiccup" } })).toMatchObject({
        status: "failed",
        failure: { kind: "tool_failed" },
        sideEffect: "none",
        retryable: true,
      });
    });

    it("a write that returned a failure is a failure that may have had an effect, and is never retried automatically", () => {
      expect(outcome({ status: "failed", result: { success: false, error: "Upstream hiccup" } }, NATIVE_WRITE)).toMatchObject({
        status: "failed",
        sideEffect: "possible",
        retryable: false,
      });
    });

    it("a failure that never reached the tool says so, and is not retryable", () => {
      expect(outcome({ status: "failed", result: undefined, error: "Invalid input parameters" }, NATIVE_WRITE)).toMatchObject({
        status: "failed",
        failure: { kind: "not_run" },
        sideEffect: "none",
        retryable: false,
      });
    });

    it("tells the failure in a fixed code and sentence, never in a provider's words", () => {
      const result = outcome({ status: "failed", result: { success: false, error: 'HTTP 500 {"error":{"message":"token=abc123 stack at Object.<anonymous> (/srv/app.js:1:1)"}}' } });
      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(JSON.stringify(result)).not.toContain("abc123");
      expect(JSON.stringify(result)).not.toContain("/srv/app.js");
      expect(result.failure.code).toEqual(expect.any(String));
      expect(result.failure.message).toEqual(expect.any(String));
    });
  });

  describe("uncertain: never a success, never an ordinary failure, never retryable", () => {
    const uncertainCases: Array<[string, UnifiedExecutionOutcome]> = [
      ["a write that timed out", outcome({ status: "timed_out", result: undefined, error: "Execution timed out" }, NATIVE_WRITE)],
      ["a tool that reported its own outcome unknown", outcome({ status: "failed", result: { success: false, error: "x", metadata: { outcome: "unknown", executionId: "e" } } }, NATIVE_WRITE)],
      ["a read that reported its own outcome unknown", outcome({ status: "failed", result: { success: false, error: "x", metadata: { outcome: "unknown" } } })],
      ["a completed write with no success", outcome({ result: undefined }, NATIVE_WRITE)],
    ];

    it.each(uncertainCases)("%s is uncertain", (_label, result) => {
      expect(result.status).toBe("uncertain");
      expect(isUncertainOutcome(result)).toBe(true);
    });

    it.each(uncertainCases)("%s is never retryable, says an effect is possible, and points to reconciliation", (_label, result) => {
      expect(isSafeToRetryOutcome(result)).toBe(false);
      expect(result).toMatchObject({ retryable: false, sideEffect: "possible", resolution: "reconcile" });
    });

    it.each(uncertainCases)("%s is not a success and not a failure", (_label, result) => {
      expect(result.status).not.toBe("succeeded");
      expect(result.status).not.toBe("failed");
      expect("failure" in result).toBe(false);
    });

    it("keeps its evidence: which execution, so it can be reconciled", () => {
      const result = outcome({ status: "timed_out", result: undefined, executionId: "exec-77" }, NATIVE_WRITE);
      expect(result.evidence).toMatchObject({ executionId: "exec-77" });
    });

    it("a read that timed out is a retryable failure, not uncertain: there is no effect to be unsure of", () => {
      expect(outcome({ status: "timed_out", result: undefined })).toMatchObject({ status: "failed", failure: { kind: "timed_out" }, sideEffect: "none", retryable: true });
    });

    it("is the only outcome that asks for reconciliation", () => {
      const others = [outcome({}), outcome({ status: "approval_pending", result: undefined }, NATIVE_WRITE), outcome({ status: "permission_denied", result: undefined })];
      for (const other of others) expect("resolution" in other).toBe(false);
    });
  });

  describe("retryability", () => {
    it("is true only for a failed outcome that says so", () => {
      expect(isSafeToRetryOutcome(outcome({ status: "failed", result: { success: false, error: "x" } }))).toBe(true);
      expect(isSafeToRetryOutcome(outcome({}))).toBe(false);
      expect(isSafeToRetryOutcome(outcome({ status: "approval_pending", result: undefined }))).toBe(false);
      expect(isSafeToRetryOutcome(outcome({ status: "failed", result: { success: false, error: "x" } }, NATIVE_WRITE))).toBe(false);
    });
  });

  describe("untrusted output", () => {
    it("follows the tool's own untrusted flag for a native capability", () => {
      expect(outcome({ result: { success: true, metadata: { treatedAsUntrustedData: true } } }).untrusted).toBe(true);
      expect(outcome({ result: { success: true } }).untrusted).toBe(false);
    });

    it.each(["n8n_workflow", "sandbox"] as const)("is always untrusted for %s output, whatever the metadata says", (kind) => {
      expect(outcomeFromToolExecution(execution({ result: { success: true, metadata: { treatedAsUntrustedData: false } } }), { id: "c", kind, risk: "READ_ONLY" }).untrusted).toBe(true);
    });
  });

  describe("evidence", () => {
    it("holds ids and a duration, and none of the tool's data, text or error", () => {
      const result = outcome(
        { toolId: "meta.campaign.pause", executionId: "exec-9", durationMs: 42, approvalId: "ap-2", result: { success: true, data: { secret: "do-not-copy" }, error: undefined } },
        NATIVE_WRITE
      );
      expect(result.evidence).toEqual({ toolId: "meta.campaign.pause", executionId: "exec-9", approvalId: "ap-2", durationMs: 42 });
      expect(JSON.stringify(result)).not.toContain("do-not-copy");
    });

    it("does not read the result's data at all", () => {
      const read = vi.fn();
      const result = { success: true } as { success: boolean; data?: unknown };
      Object.defineProperty(result, "data", { get: () => { read(); throw new Error("data was read"); }, enumerable: true });
      expect(() => outcomeFromToolExecution(execution({ result }), NATIVE_READ)).not.toThrow();
      expect(read).not.toHaveBeenCalled();
    });
  });

  it("knows the three kinds and refuses others", () => {
    expect([...EXECUTION_KINDS]).toEqual(["native", "n8n_workflow", "sandbox"]);
    expect(isExecutionKind("native")).toBe(true);
    expect(isExecutionKind("mcp")).toBe(false);
    expect(isExecutionKind(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Nothing executes, nothing is reached, nothing is changed
// ---------------------------------------------------------------------------

describe("derivation performs no execution and no external access", () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    }
    return value;
  };

  const full = (): DeriveCapabilitiesInput => ({
    tools: [tool("a.read"), tool("b.write", { risk: "HIGH_IMPACT", requiresApproval: true }), runnerTool(), tool(SANDBOX_ID), tool("mcp.pilot.lookup")],
    agents: [agent("general", ["a.read", "b.write", RUNNER, SANDBOX_ID, "mcp.pilot.lookup"]), agent("automation", [RUNNER])],
    n8nWorkflows: { userId: "user-1", records: [workflow("wf-1"), workflow("wf-2", { isActive: false })] },
    facts: { "b.write": { dataEgress: "provider" } },
  });

  it("never calls a tool's execute or validate, however many capabilities it derives", () => {
    // Every tool above throws if either is called.
    expect(() => deriveCapabilities(full())).not.toThrow();
    expect(() => deriveCapabilities({ ...full(), forAgent: "general" })).not.toThrow();
  });

  it("never calls a function it was handed", () => {
    const spy = vi.fn();
    const withSpies = tool("spy.tool") as unknown as Record<string, unknown>;
    for (const key of Object.keys(withSpies)) if (typeof withSpies[key] === "function") withSpies[key] = spy;
    deriveCapabilities({ tools: [withSpies as never], agents: [agent("a", ["spy.tool"])] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not change its input", () => {
    const input = deepFreeze(full());
    expect(() => deriveCapabilities(input)).not.toThrow();
  });

  it("returns a result that cannot be changed, so one caller cannot alter what another reads", () => {
    const result = deriveCapabilities(full());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
    expect(Object.isFrozen(result.rejected)).toBe(true);
    for (const capability of result.capabilities) {
      expect(Object.isFrozen(capability)).toBe(true);
      expect(Object.isFrozen(capability.agents)).toBe(true);
      expect(Object.isFrozen(capability.requiredPermissions)).toBe(true);
      expect(Object.isFrozen(capability.scope)).toBe(true);
      expect(Object.isFrozen(capability.availability)).toBe(true);
    }
    expect(() => {
      (result.capabilities as CapabilityDescriptor[]).push({} as never);
    }).toThrow();
  });

  it("is deterministic and independent of input order", () => {
    const a = full();
    const reversed: DeriveCapabilitiesInput = {
      ...a,
      tools: [...a.tools].reverse(),
      agents: [...a.agents].reverse().map((policy) => ({ ...policy, allowedTools: [...policy.allowedTools].reverse() })),
      n8nWorkflows: { userId: "user-1", records: [...a.n8nWorkflows!.records].reverse() },
    };
    expect(deriveCapabilities(reversed)).toEqual(deriveCapabilities(a));
    expect(deriveCapabilities(a)).toEqual(deriveCapabilities(a));
  });

  it("sorts what it returns by id", () => {
    const ids = deriveCapabilities(full()).capabilities.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });

  // The module is read as text: what it IMPORTS and what it CALLS, not what it says.
  const source = readFileSync(new URL("../src/execution-capability.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("imports only core's own pure modules and type files", () => {
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!).sort();
    expect(specifiers).toEqual(
      ["./tool-failure-classifier.js", "./types/agent.js", "./types/execution.js", "./types/n8n.js", "./types/tenant.js", "./types/tool.js", "./voice-tool-policy.js"].sort()
    );
    expect(specifiers.every((specifier) => specifier.startsWith("./"))).toBe(true);
  });

  it("has no clock, randomness, timer, process, environment, filesystem, network, console or dynamic import", () => {
    expect(source).not.toMatch(
      /\b(?:Date\.now|new Date|Math\.random|setTimeout|setInterval|setImmediate|queueMicrotask|process\.|globalThis|require\s*\(|import\s*\(|fetch\s*\(|XMLHttpRequest|WebSocket|console\.|crypto\.|performance\.)/
    );
    expect(source).not.toMatch(/from\s+["'](?:node:|fs|path|http|https|net|child_process|@jarvis\/)/);
  });

  it("is synchronous: no async function, no await, no promise", () => {
    expect(source).not.toMatch(/\basync\b|\bawait\b|\bPromise\b|\.then\s*\(/);
  });

  it("never calls a tool's method: no .execute( and no .validate(", () => {
    expect(source).not.toMatch(/\.\s*execute\s*\(|\.\s*validate\s*\(|\[\s*["']execute["']\s*\]/);
  });

  it("is not told what it is not: it has no registry, no executor, no repository, no model and no audit logger", () => {
    expect(source).not.toMatch(/ToolRegistry|ToolExecutor|IToolExecutor|IN8nRepository|IAIProvider|AuditLogger|PrismaClient/);
  });
});
