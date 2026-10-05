// S8.7 — the model's tool budget.
//
// Every tool an agent may call is handed to the model on every turn, and the
// provider refuses a request that carries more than MAX_TOOLS_PER_MODEL_REQUEST
// of them. The general assistant is the one agent that also receives every
// reviewed MCP tool, and the manifest may grow to MCP_LIMITS.toolsTotal of them.
//
// So the budget is held as a census, against the CEILINGS rather than today's
// deployment: the general assistant's native allowlist plus the most MCP tools
// the review contract can ever admit must fit. Growth on either side that would
// break a request fails here, at review time, instead of in production.
import { describe, expect, it } from "vitest";
import { MAX_TOOLS_PER_MODEL_REQUEST, MCP_LIMITS, MCP_MANIFEST } from "@jarvis/core";
import { AGENT_IDS, AGENT_POLICIES, MCP_READ_TOOLS } from "../src/agent-policy.js";

const mcp = new Set(MCP_READ_TOOLS);
/** The tools an agent is granted outside the reviewed MCP group. */
const nativeOf = (agentId: string): string[] => [
  ...new Set(AGENT_POLICIES[agentId]!.allowedTools.filter((id) => !mcp.has(id))),
];

describe("the model's per-request tool budget", () => {
  it("is the provider's limit: 128 tool definitions per request", () => {
    expect(MAX_TOOLS_PER_MODEL_REQUEST).toBe(128);
  });

  it("fits the general assistant's native tools plus every MCP tool the review contract could ever admit", () => {
    const native = nativeOf(AGENT_IDS.general);
    expect(native.length + MCP_LIMITS.toolsTotal).toBeLessThanOrEqual(MAX_TOOLS_PER_MODEL_REQUEST);
  });

  it("holds the shipped review — every reviewed server — inside the MCP ceilings and inside the budget (S8.8)", () => {
    expect(MCP_MANIFEST.servers.length).toBeLessThanOrEqual(MCP_LIMITS.servers);
    for (const server of MCP_MANIFEST.servers) {
      expect(server.tools.length, server.id).toBeLessThanOrEqual(MCP_LIMITS.toolsPerServer);
    }
    const reviewed = MCP_MANIFEST.servers.flatMap((server) => server.tools.filter((tool) => tool.enabled));
    expect(reviewed).toHaveLength(MCP_READ_TOOLS.length);
    expect(nativeOf(AGENT_IDS.general).length + reviewed.length).toBeLessThanOrEqual(MAX_TOOLS_PER_MODEL_REQUEST);
  });

  it("counts the reviewed MCP grant inside that ceiling, never beside it", () => {
    expect(MCP_READ_TOOLS.length).toBeLessThanOrEqual(MCP_LIMITS.toolsTotal);
    for (const id of MCP_READ_TOOLS) {
      expect(AGENT_POLICIES[AGENT_IDS.general]!.allowedTools, id).toContain(id);
    }
  });

  it("fits every other agent, which receives no MCP tool at all", () => {
    for (const agentId of Object.keys(AGENT_POLICIES)) {
      if (agentId === AGENT_IDS.general) continue;
      expect(AGENT_POLICIES[agentId]!.allowedTools.some((id) => mcp.has(id)), agentId).toBe(false);
      expect(nativeOf(agentId).length, agentId).toBeLessThanOrEqual(MAX_TOOLS_PER_MODEL_REQUEST);
    }
  });
});
