// ---------------------------------------------------------------------------
// VO-3.1 — which agent a task is assigned to.
//
// Pinned against the REAL compiled policies, so a policy change that moves a
// tool between agents shows up here as a changed assignment, not silently in
// the office.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { AgentPolicy } from "@jarvis/core";

import { AGENT_IDS, AGENT_POLICIES, assignAgentForTool, schedulableToolIds } from "../src/index.js";

const ALL = new Set(Object.values(AGENT_IDS));

describe("assignAgentForTool — the compiled policies", () => {
  it("gives a tool held by one specialist to that specialist", () => {
    expect(assignAgentForTool("maps.route", { registeredAgentIds: ALL })).toEqual({
      agentId: AGENT_IDS.location,
      reason: "only_specialist",
    });
  });

  it("gives a tool several specialists hold to the one its namespace names", () => {
    // meta.insights: Meta Ads, Analytics and Marketing all hold it.
    expect(assignAgentForTool("meta.insights", { registeredAgentIds: ALL })).toEqual({
      agentId: AGENT_IDS.metaAds,
      reason: "domain_specialist",
    });
    expect(assignAgentForTool("google.insights", { registeredAgentIds: ALL })).toEqual({
      agentId: AGENT_IDS.googleAds,
      reason: "domain_specialist",
    });
  });

  it("gives a cross-cutting tool to the general assistant", () => {
    expect(assignAgentForTool("integration.status", { registeredAgentIds: ALL })).toEqual({
      agentId: AGENT_IDS.general,
      reason: "general_assistant",
    });
  });

  it("never assigns an unregistered agent, and falls through to the next rule", () => {
    const withoutMeta = new Set([...ALL].filter((id) => id !== AGENT_IDS.metaAds));
    const assigned = assignAgentForTool("meta.insights", { registeredAgentIds: withoutMeta });
    // Analytics and Marketing still hold it; neither is named by `meta`.
    expect(assigned?.agentId).toBe(AGENT_IDS.general);
    expect(assigned?.agentId).not.toBe(AGENT_IDS.metaAds);
  });

  it("returns null for a tool no registered agent holds, and for nonsense", () => {
    expect(assignAgentForTool("no.such.tool", { registeredAgentIds: ALL })).toBeNull();
    expect(assignAgentForTool("maps.route", { registeredAgentIds: new Set() })).toBeNull();
    expect(assignAgentForTool("", { registeredAgentIds: ALL })).toBeNull();
  });

  it("assigns every schedulable tool to an agent whose policy grants it", () => {
    for (const toolId of schedulableToolIds()) {
      const assigned = assignAgentForTool(toolId, { registeredAgentIds: ALL });
      expect(assigned, toolId).not.toBeNull();
      expect(AGENT_POLICIES[assigned!.agentId]!.allowedTools, toolId).toContain(toolId);
    }
  });

  it("is deterministic", () => {
    const first = assignAgentForTool("integration.status", { registeredAgentIds: ALL });
    for (let i = 0; i < 5; i += 1) {
      expect(assignAgentForTool("integration.status", { registeredAgentIds: ALL })).toEqual(first);
    }
  });
});

describe("assignAgentForTool — the rule on its own", () => {
  const policy = (agentId: string, domain: string, tools: string[]): AgentPolicy =>
    ({ agentId, domain, allowedTools: tools }) as unknown as AgentPolicy;

  it("takes the first specialist in policy order when no rule singles one out and there is no generalist", () => {
    const policies = {
      a: policy("a", "alpha", ["shared.tool"]),
      b: policy("b", "beta", ["shared.tool"]),
    };
    expect(
      assignAgentForTool("shared.tool", { registeredAgentIds: new Set(["a", "b"]), policies })
    ).toEqual({ agentId: "a", reason: "first_specialist" });
  });

  it("treats a namespace equal to a domain as naming it", () => {
    const policies = {
      a: policy("a", "alpha", ["beta.tool"]),
      b: policy("b", "beta", ["beta.tool"]),
    };
    expect(
      assignAgentForTool("beta.tool", { registeredAgentIds: new Set(["a", "b"]), policies })
    ).toEqual({ agentId: "b", reason: "domain_specialist" });
  });
});
