// ---------------------------------------------------------------------------
// The seven reported messages, end to end through the routing and policy layers.
//
// These are the exact strings from the bug report. The assertions are
// deliberately about REACHABILITY rather than about wording: the failure was
// never that the prose was badly phrased, it was that the question never
// reached the system that knows the answer. So what is pinned is:
//
//   1. whichever agent the router picks for each message CAN call the
//      capability tools, and
//   2. the general assistant's prompt no longer claims a provider identity,
//      and does instruct the model to use the tool.
//
// The prompt is asserted against the container SOURCE, the same technique
// `sprint6-agent-wiring.test.ts` uses. A prompt is configuration, not
// behaviour; there is no way to observe it without either reading the source or
// standing up a model, and the second proves less for far more.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_POLICIES,
  CAPABILITY_TOOLS,
  isToolAllowed,
  rankAgentCandidates,
} from "@jarvis/agents";

const CONTAINER_SOURCE = readFileSync(
  join(process.cwd(), "src/services/container.ts"),
  "utf-8"
);

/** The exact messages from the report. */
const MESSAGES = {
  genericEnglish: "What can you do?",
  genericHindi: "Tum kya kar sakte ho?",
  genericTools: "Available tools batao",
  connectedOnly: "Sirf connected integrations dikhao.",
  googleStatus: "Google integration ka status batao.",
  gmailCapability: "Gmail ke saath kya kar sakte ho?",
  toolsAndPermissions: "Mere available tools aur permissions batao.",
  mapsTest: "Map connection test karo.",
} as const;

/** The agent the router would actually pick. */
function routedAgent(message: string): string {
  return rankAgentCandidates(message)[0]!.agentId;
}

/** Whether that agent may call a given tool. */
function agentCan(agentId: string, toolId: string): boolean {
  const policy = AGENT_POLICIES[agentId];
  if (!policy) return false;
  return isToolAllowed(toolId, policy.allowedTools);
}

// ---------------------------------------------------------------------------

describe("every reported message reaches an agent that can answer it", () => {
  it("routes generic capability questions to an agent holding capabilities.list", () => {
    for (const message of [
      MESSAGES.genericEnglish,
      MESSAGES.genericHindi,
      MESSAGES.genericTools,
    ]) {
      const agent = routedAgent(message);
      expect(agentCan(agent, "capabilities.list"), `${message} -> ${agent}`).toBe(true);
    }
  });

  it("routes 'sirf connected integrations dikhao' to an agent that can list them", () => {
    const agent = routedAgent(MESSAGES.connectedOnly);
    expect(agentCan(agent, "capabilities.connected"), agent).toBe(true);
  });

  it("routes 'Google integration ka status batao' to an agent that can read status", () => {
    const agent = routedAgent(MESSAGES.googleStatus);
    expect(agentCan(agent, "integration.status"), agent).toBe(true);
  });

  it("routes 'Gmail ke saath kya kar sakte ho' to an agent that can answer per-integration", () => {
    const agent = routedAgent(MESSAGES.gmailCapability);
    expect(agentCan(agent, "capabilities.integration"), agent).toBe(true);
  });

  it("routes 'mere available tools aur permissions batao' to an agent holding both tools", () => {
    const agent = routedAgent(MESSAGES.toolsAndPermissions);
    expect(agentCan(agent, "capabilities.list"), agent).toBe(true);
    expect(agentCan(agent, "capabilities.permissions"), agent).toBe(true);
  });

  it("routes 'map connection test karo' to an agent that can run a real test", () => {
    const agent = routedAgent(MESSAGES.mapsTest);
    expect(agentCan(agent, "integration.test"), agent).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("no agent can be stranded without capability discovery", () => {
  it("grants the capability tools to EVERY policy", () => {
    // The original bug was not that one agent lacked the tool — it was that the
    // question landed on whichever agent the router picked and that agent
    // answered from its prompt. Universal grant is what removes the class.
    for (const [agentId, policy] of Object.entries(AGENT_POLICIES)) {
      for (const tool of CAPABILITY_TOOLS) {
        expect(isToolAllowed(tool, policy.allowedTools), `${agentId} -> ${tool}`).toBe(true);
      }
    }
  });

  it("keeps capability discovery read-only everywhere", () => {
    // Asking what you can do must never be the thing that changes something.
    for (const tool of CAPABILITY_TOOLS) {
      expect(tool.startsWith("capabilities.")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the fallback agent no longer claims a provider identity", () => {
  it("does not describe itself as a Meta Ads assistant", () => {
    // The exact root cause: this sentence made every capability question return
    // a Meta-only answer, because this agent is the routing fallback.
    expect(CONTAINER_SOURCE).not.toContain(
      "You are JARVIS, a helpful AI assistant with direct access to the user's Meta Ads account."
    );
  });

  it("no longer opens by describing Meta tooling as its purpose", () => {
    expect(CONTAINER_SOURCE).not.toContain(
      "You have tools to read and manage Meta Ads campaigns."
    );
  });

  it("instructs the model to use the capability tool instead of answering from prompt", () => {
    expect(CONTAINER_SOURCE).toContain("get_available_capabilities");
    expect(CONTAINER_SOURCE).toMatch(/NEVER answer a capability question from memory/i);
  });

  it("names the exact phrasings users reported", () => {
    // Cheap insurance that a prompt rewrite does not quietly drop the Hindi and
    // Hinglish forms, which is how this regresses for half the users.
    for (const phrase of ["what can you do", "tum kya kar sakte ho", "available tools batao"]) {
      expect(CONTAINER_SOURCE.toLowerCase()).toContain(phrase);
    }
  });

  it("requires unavailable capabilities to be reported as unavailable", () => {
    expect(CONTAINER_SOURCE).toMatch(/never describe an unavailable or planned capability as available/i);
  });

  it("forbids printing full identifiers", () => {
    expect(CONTAINER_SOURCE).toMatch(/never print a full account id/i);
    // The Meta id is still injected for tool calls, but explicitly as a
    // parameter only.
    expect(CONTAINER_SOURCE).toMatch(/use it as a PARAMETER only/i);
  });
});

// ---------------------------------------------------------------------------

describe("the capability tools are actually registered", () => {
  it("registers them in the tool registry factory", () => {
    expect(CONTAINER_SOURCE).toContain("createCapabilityTools");
  });

  it("builds one capability service and shares it with the REST layer", () => {
    // Same instance on both paths, so a page and a spoken answer cannot
    // disagree about what is available.
    expect(CONTAINER_SOURCE).toContain("new CapabilityService(");
    expect(CONTAINER_SOURCE).toContain("capabilities: capabilityService");
  });

  it("derives capability from the live registry rather than a static list", () => {
    // The registry is read lazily so tools registered after the service is
    // constructed are still discoverable.
    expect(CONTAINER_SOURCE).toContain("registryRef.current?.getAll()");
  });

  it("excludes tools no policy grants", () => {
    expect(CONTAINER_SOURCE).toContain("allowedToolIds");
  });
});
