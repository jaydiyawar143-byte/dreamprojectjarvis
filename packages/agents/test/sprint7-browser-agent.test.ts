// ---------------------------------------------------------------------------
// Sprint 7.10 — Browser Agent: policy, routing and enforcement.
//
// Reuses the Sprint 6 harness in full, because the point of Sprint 7 is that
// browsing is subject to the SAME machinery Sprint 6 built — not that it has
// machinery of its own. If the browser agent needed a different harness, that
// would itself be the bug.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";

import { BROWSER_READ_TOOL_IDS, BROWSER_ACTION_TOOL_IDS } from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { AGENT_IDS, AGENT_POLICIES, getAgentPolicy } from "../src/agent-policy.js";
import { rankAgentCandidates } from "../src/agent-router.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { MetaAdsAgent } from "../src/agents/meta-ads-agent.js";
import { KnowledgeAgent } from "../src/agents/knowledge-agent.js";
import { AnalyticsAgent } from "../src/agents/analytics-agent.js";
import { AutomationAgent } from "../src/agents/automation-agent.js";
import { CommunicationAgent } from "../src/agents/communication-agent.js";
import { GoogleAdsAgent } from "../src/agents/google-ads-agent.js";
import { BrowserAgent } from "../src/agents/browser-agent.js";
import {
  FakePermissionChecker,
  GatingApprovalService,
  RecordingAuditLogger,
  RecordingToolExecutor,
  ScriptedAIProvider,
  productionLikeTools,
  sessionFor,
  toolRegistryOf,
} from "./helpers/sprint6-harness.js";

describe("Sprint 7 — browser agent", () => {
  let provider: ScriptedAIProvider;
  let audit: RecordingAuditLogger;
  let executor: RecordingToolExecutor;
  let registry: AgentRegistry;
  let approvals: GatingApprovalService;
  const tools = toolRegistryOf(productionLikeTools());

  beforeEach(() => {
    provider = new ScriptedAIProvider();
    audit = new RecordingAuditLogger();
    executor = new RecordingToolExecutor(tools);
    approvals = new GatingApprovalService();

    registry = new AgentRegistry({ requirePolicy: true });
    registry.register(new ConversationalAssistant({ provider }));
    registry.register(new MetaAdsAgent({ provider }));
    registry.register(new KnowledgeAgent({ provider }));
    registry.register(new AnalyticsAgent({ provider }));
    registry.register(new AutomationAgent({ provider }));
    registry.register(new CommunicationAgent({ provider }));
    registry.register(new GoogleAdsAgent({ provider }));
    registry.register(new BrowserAgent({ provider }));
  });

  function orchestrator(overrides: Record<string, unknown> = {}) {
    return new Orchestrator(registry, executor, audit, {
      toolRegistry: tools,
      permissionChecker: new FakePermissionChecker(),
      toolApprovalService: approvals,
      ...overrides,
    });
  }

  async function attempt(
    toolName: string,
    args: Record<string, unknown> = {},
    userId = "user-1"
  ) {
    provider.pushToolCall(toolName, args).pushText("done");
    return orchestrator().process(
      { message: "do the thing", agentId: AGENT_IDS.browser },
      sessionFor(userId)
    );
  }

  // -------------------------------------------------------------------------

  describe("policy", () => {
    it("is registered with a policy and is resolvable", () => {
      expect(getAgentPolicy(AGENT_IDS.browser)).toBeDefined();
      expect(registry.get(AGENT_IDS.browser)).toBeDefined();
    });

    it("declares the browser domain and requires approval for writes", () => {
      const policy = getAgentPolicy(AGENT_IDS.browser)!;
      expect(policy.domain).toBe("browser");
      expect(policy.writesRequireApproval).toBe(true);
      expect(policy.clientSelectable).toBe(true);
      expect(policy.requiredPermissions).toEqual(["read", "write"]);
    });

    it("holds exactly the ten browser tools, plus capability discovery", () => {
      const allowed = [...getAgentPolicy(AGENT_IDS.browser)!.allowedTools];

      // Capability discovery is granted to every agent so "what can you do?"
      // reaches the registry instead of this agent's system prompt. The
      // browser-specific assertion is that nothing ELSE leaked in.
      const browserOnly = allowed.filter((id) => !id.startsWith("capabilities."));
      expect(browserOnly.slice().sort()).toEqual(
        [...BROWSER_READ_TOOL_IDS, ...BROWSER_ACTION_TOOL_IDS].slice().sort()
      );
      for (const id of browserOnly) expect(id.startsWith("browser.")).toBe(true);

      // It can describe other domains; it cannot reach them.
      for (const off of ["meta.insights", "whatsapp.send", "n8n.trigger", "maps.route"]) {
        expect(allowed, off).not.toContain(off);
      }
    });

    it("is frozen, like every other policy", () => {
      expect(() => {
        (AGENT_POLICIES[AGENT_IDS.browser]!.allowedTools as string[]).push("meta.campaigns");
      }).toThrow();
    });

    it("grants NO other domain's tools", () => {
      const allowed = getAgentPolicy(AGENT_IDS.browser)!.allowedTools;
      for (const foreign of ["meta.campaigns", "google.accounts", "whatsapp.send", "n8n.trigger"]) {
        expect(allowed).not.toContain(foreign);
      }
    });

    it("does not appear in any OTHER agent's allowlist", () => {
      // Browsing is a domain, not a capability sprinkled across agents.
      for (const [agentId, policy] of Object.entries(AGENT_POLICIES)) {
        if (agentId === AGENT_IDS.browser) continue;
        for (const id of policy.allowedTools) {
          expect(id.startsWith("browser."), `${agentId} -> ${id}`).toBe(false);
        }
      }
    });
  });

  describe("tool boundary", () => {
    it("ALLOWS a browser read tool", async () => {
      await attempt("browser.navigate", { url: "https://example.com/" });
      expect(executor.toolIds()).toEqual(["browser.navigate"]);
    });

    it.each([
      ["Meta", "meta.campaigns"],
      ["Google", "google.accounts"],
      ["WhatsApp", "whatsapp.send"],
      ["n8n", "n8n.trigger"],
    ])("REFUSES a %s tool and never reaches the executor", async (_label, toolId) => {
      await attempt(toolId, {});
      // The executor is the boundary that matters: a denied tool must not be
      // dispatched at all, not merely reported as failed afterwards.
      expect(executor.toolIds()).toEqual([]);
      expect(audit.byAction("agent.tool_denied").length).toBeGreaterThan(0);
    });

    it("audits a refused tool as agent.tool_denied", async () => {
      await attempt("whatsapp.send", {});
      expect(audit.byAction("agent.tool_denied").length).toBeGreaterThan(0);
    });

    it("REFUSES a browser tool that does not exist", async () => {
      await attempt("browser.execute_script", {});
      expect(executor.toolIds()).toEqual([]);
    });
  });

  describe("approval boundary", () => {
    it.each(BROWSER_ACTION_TOOL_IDS.map((id) => [id]))(
      "%s is gated and does NOT reach the executor",
      async (toolId) => {
        await attempt(toolId, { url: "https://example.com/", selector: "#x" });
        expect(approvals.checked).toContain(toolId);
        expect(executor.toolIds()).toHaveLength(0);
      }
    );

    it.each(BROWSER_READ_TOOL_IDS.map((id) => [id]))(
      "%s runs straight through",
      async (toolId) => {
        // The gate is consulted for every tool; what distinguishes a read is
        // that it is allowed through and actually executes.
        await attempt(toolId, { url: "https://example.com/" });
        expect(executor.toolIds()).toEqual([toolId]);
      }
    );
  });

  describe("tenant isolation", () => {
    it("executes under the caller's user id, never one the model supplied", async () => {
      await attempt("browser.navigate", { url: "https://example.com/", userId: "user-999" }, "user-7");
      expect(executor.requests[0]?.userId).toBe("user-7");
    });
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("Sprint 7 — routing to the browser agent", () => {
  const top = (message: string) => rankAgentCandidates(message)[0]?.agentId;
  const ids = (message: string) => rankAgentCandidates(message).map((c) => c.agentId);

  it.each([
    ["a bare link", "https://example.com/pricing"],
    ["a link with a request", "please read https://example.com and summarise it"],
    ["an http link", "check http://example.com/status"],
  ])("routes %s to the browser agent first", (_label, message) => {
    expect(top(message)).toBe(AGENT_IDS.browser);
  });

  it.each([
    ["open this website", "open this website for me"],
    ["scrape", "scrape the pricing table"],
    ["fill a form", "fill in the form on that page"],
    ["submit a form", "submit the form for me"],
    ["read the page", "read that web page"],
  ])("offers the browser agent for %s", (_label, message) => {
    expect(ids(message)).toContain(AGENT_IDS.browser);
  });

  // The regression half: adding a router tier must not steal existing traffic.
  it.each([
    ["Meta ads", "how are my facebook campaigns doing?", AGENT_IDS.metaAds],
    ["Meta by metric", "what is my ROAS this week", AGENT_IDS.metaAds],
    ["Google ads", "show me my google ads spend", AGENT_IDS.googleAds],
    ["n8n", "trigger the onboarding workflow", AGENT_IDS.automation],
    ["WhatsApp", "send a whatsapp message to the client", AGENT_IDS.communication],
    ["knowledge", "what does my employee handbook say about leave?", AGENT_IDS.knowledge],
  ])("still routes %s to its own agent", (_label, message, expected) => {
    expect(top(message)).toBe(expected);
  });

  it.each([
    ["a plain greeting", "hello there"],
    ["a Meta question", "pause my worst performing campaign"],
    ["a document question", "summarise my uploaded notes"],
  ])("does NOT offer the browser agent for %s", (_label, message) => {
    expect(ids(message)).not.toContain(AGENT_IDS.browser);
  });

  it("falls back to the general assistant when nothing matches", () => {
    expect(top("hello")).toBe(AGENT_IDS.general);
  });
});
