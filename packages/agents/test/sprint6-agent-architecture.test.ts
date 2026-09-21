// ---------------------------------------------------------------------------
// Sprint 6.11 — Agent architecture: registration, resolution, allowlists.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import type { AgentPolicy } from "@jarvis/core";
import { AgentRegistry } from "../src/registry.js";
import {
  AGENT_IDS,
  AGENT_POLICIES,
  getAgentPolicy,
  isToolAllowed,
  resolveAllowedToolId,
  sanitizeToolName,
  scopedToolRegistry,
} from "../src/agent-policy.js";
import { KnowledgeAgent } from "../src/agents/knowledge-agent.js";
import { AnalyticsAgent } from "../src/agents/analytics-agent.js";
import { AutomationAgent } from "../src/agents/automation-agent.js";
import { CommunicationAgent } from "../src/agents/communication-agent.js";
import { GoogleAdsAgent } from "../src/agents/google-ads-agent.js";
import { BrowserAgent } from "../src/agents/browser-agent.js";
import { LocationAgent } from "../src/agents/location-agent.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { MetaAdsAgent } from "../src/agents/meta-ads-agent.js";
import {
  ScriptedAIProvider,
  fakeTool,
  productionLikeTools,
  toolRegistryOf,
} from "./helpers/sprint6-harness.js";
import { INTEGRATION_READ_TOOLS, CAPABILITY_TOOLS, SELF_TOOLS } from "../src/agent-policy.js";

describe("Sprint 6.1 — agent architecture", () => {
  let provider: ScriptedAIProvider;

  beforeEach(() => {
    provider = new ScriptedAIProvider();
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe("agent registration", () => {
    it("registers every specialized agent and exposes its policy", () => {
      const registry = new AgentRegistry({ requirePolicy: true });

      registry.register(new ConversationalAssistant({ provider }));
      registry.register(new MetaAdsAgent({ provider }));
      registry.register(new KnowledgeAgent({ provider }));
      registry.register(new AnalyticsAgent({ provider }));
      registry.register(new AutomationAgent({ provider }));
      registry.register(new CommunicationAgent({ provider }));
      registry.register(new GoogleAdsAgent({ provider }));
      // Sprint 7 added the eighth, maps the ninth. The loop below is the real
      // assertion: every id declared in AGENT_IDS must resolve to a registered
      // agent AND a policy, so a new agent cannot be declared without being
      // wired.
      registry.register(new BrowserAgent({ provider }));
      registry.register(new LocationAgent({ provider }));

      expect(registry.getAll()).toHaveLength(9);
      for (const id of Object.values(AGENT_IDS)) {
        expect(registry.get(id), `agent ${id}`).toBeDefined();
        expect(registry.getPolicy(id), `policy ${id}`).toBeDefined();
      }
    });

    it("refuses an agent with no policy when requirePolicy is set", () => {
      const registry = new AgentRegistry({ requirePolicy: true });
      const rogue = new (class extends KnowledgeAgent {
        override id = "rogue-agent";
      })({ provider });

      expect(() => registry.register(rogue)).toThrow(/no policy/i);
      expect(registry.get("rogue-agent")).toBeUndefined();
    });

    it("allows a policy-less agent when requirePolicy is off (Sprint 1-5 path)", () => {
      const registry = new AgentRegistry();
      registry.register(new ConversationalAssistant({ provider }));

      expect(registry.get(AGENT_IDS.general)).toBeDefined();
      expect(registry.getPolicy(AGENT_IDS.general)).toBeUndefined();
    });

    it("rejects a policy whose agentId does not match the agent", () => {
      const registry = new AgentRegistry();
      const mismatched: AgentPolicy = {
        ...AGENT_POLICIES[AGENT_IDS.automation]!,
        agentId: "some-other-agent",
      };

      expect(() =>
        registry.register(new KnowledgeAgent({ provider }), mismatched)
      ).toThrow(/policy mismatch/i);
    });

    it("rejects duplicate registration", () => {
      const registry = new AgentRegistry({ requirePolicy: true });
      registry.register(new KnowledgeAgent({ provider }));

      expect(() => registry.register(new KnowledgeAgent({ provider }))).toThrow(
        /already registered/i
      );
    });

    it("drops the policy when an agent is unregistered", () => {
      const registry = new AgentRegistry({ requirePolicy: true });
      registry.register(new AnalyticsAgent({ provider }));
      registry.unregister(AGENT_IDS.analytics);

      expect(registry.get(AGENT_IDS.analytics)).toBeUndefined();
      expect(registry.getPolicy(AGENT_IDS.analytics)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  describe("agent resolution", () => {
    it("resolves a known agent id to its policy", () => {
      expect(getAgentPolicy(AGENT_IDS.metaAds)?.domain).toBe("meta-ads");
      expect(getAgentPolicy(AGENT_IDS.knowledge)?.domain).toBe("knowledge");
    });

    it("returns undefined for an unknown agent id", () => {
      // "browser-agent" was one of these until Sprint 7 registered it. The
      // remaining three are still non-goals and still must not resolve.
      expect(getAgentPolicy("developer-agent")).toBeUndefined();
      expect(getAgentPolicy("autopilot-agent")).toBeUndefined();
      expect(getAgentPolicy("voice-agent")).toBeUndefined();
      expect(getAgentPolicy("")).toBeUndefined();
    });

    it("cannot be tricked into resolving an inherited Object property", () => {
      // A naive `AGENT_POLICIES[id]` lookup would hand back Object.prototype
      // members for these, producing a truthy "policy" that is not one.
      expect(getAgentPolicy("constructor")).toBeUndefined();
      expect(getAgentPolicy("toString")).toBeUndefined();
      expect(getAgentPolicy("__proto__")).toBeUndefined();
    });

    it("groups agents by domain", () => {
      const registry = new AgentRegistry({ requirePolicy: true });
      registry.register(new MetaAdsAgent({ provider }));
      registry.register(new AnalyticsAgent({ provider }));

      expect(registry.getByDomain("meta-ads").map((a) => a.id)).toEqual([
        AGENT_IDS.metaAds,
      ]);
      expect(registry.getByDomain("automation")).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Allowlists
  // -------------------------------------------------------------------------

  describe("tool allowlists", () => {
    it("gives each agent only the tools its domain needs", () => {
      const meta = AGENT_POLICIES[AGENT_IDS.metaAds]!;
      expect(meta.allowedTools).toContain("meta.insights");
      expect(meta.allowedTools).toContain("meta.campaign.pause");
      expect(meta.allowedTools).not.toContain("whatsapp.send");
      expect(meta.allowedTools).not.toContain("n8n.trigger");
      expect(meta.allowedTools).not.toContain("google.insights");

      // The specialised agents each hold their own domain tool plus the
      // integration READS. The reads are what let an agent answer "is this
      // still connected?" from the system instead of from the conversation;
      // they are READ_ONLY and cannot change any provider.
      const automation = AGENT_POLICIES[AGENT_IDS.automation]!;
      expect(automation.allowedTools).toEqual([
        "n8n.trigger",
        ...INTEGRATION_READ_TOOLS,
        ...CAPABILITY_TOOLS,
        ...SELF_TOOLS,
      ]);

      const communication = AGENT_POLICIES[AGENT_IDS.communication]!;
      expect(communication.allowedTools).toEqual([
        "whatsapp.send",
        ...INTEGRATION_READ_TOOLS,
        ...CAPABILITY_TOOLS,
        ...SELF_TOOLS,
      ]);

      const google = AGENT_POLICIES[AGENT_IDS.googleAds]!;
      expect(google.allowedTools).not.toContain("whatsapp.send");
      // Google Ads additionally owns the connection lifecycle for its OWN
      // provider, because "Google Ads reconnect karo" routes here rather than
      // to the fallback.
      // Google Ads owns its own provider, its connection lifecycle, capability
      // discovery, and — from Phase 12 — the Google Workspace reads, since
      // anything naming Google may route here.
      expect(
        google.allowedTools.every(
          (t) =>
            t.startsWith("google.") ||
            t.startsWith("gmail.") ||
            t.startsWith("drive.") ||
            t.startsWith("calendar.") ||
            t.startsWith("integration.") ||
            t.startsWith("capabilities.") ||
            t === "self.describe"
        )
      ).toBe(true);
      // It still cannot reach another provider's data.
      expect(google.allowedTools).not.toContain("meta.insights");
      expect(google.allowedTools).not.toContain("whatsapp.send");
    });

    it("gives the knowledge agent no EXECUTION tools, only capability discovery", () => {
      // Retrieval already happened before this agent ran, so it still owns no
      // search tool. Capability discovery is the one exception: a "what can you
      // do?" landing here must reach the registry rather than this agent's
      // prompt, which is the failure the capability tools exist to remove.
      const allowed = AGENT_POLICIES[AGENT_IDS.knowledge]!.allowedTools;
      // Core V1 — `self.describe` joins capability discovery: READ_ONLY,
      // reaches no provider, held by every agent for the same reason.
      expect([...allowed].sort()).toEqual([...CAPABILITY_TOOLS, ...SELF_TOOLS].sort());
      expect(
        allowed.every((t) => t.startsWith("capabilities.") || t === "self.describe")
      ).toBe(true);
    });

    it("keeps the analytics agent read-only", () => {
      const analytics = AGENT_POLICIES[AGENT_IDS.analytics]!;
      for (const tool of analytics.allowedTools) {
        expect(tool, `${tool} must not be a write tool`).not.toMatch(
          /\.(pause|resume|create|update)$/
        );
      }
      expect(analytics.allowedTools).not.toContain("whatsapp.send");
      expect(analytics.allowedTools).not.toContain("n8n.trigger");
    });

    it("no policy grants a tool that is not a real registry id", () => {
      const real = new Set(productionLikeTools().map((t) => t.id));
      for (const policy of Object.values(AGENT_POLICIES)) {
        for (const tool of policy.allowedTools) {
          expect(real.has(tool), `${policy.agentId} grants unknown tool ${tool}`).toBe(
            true
          );
        }
      }
    });

    it("every policy requires approval for writes", () => {
      for (const policy of Object.values(AGENT_POLICIES)) {
        expect(policy.writesRequireApproval, policy.agentId).toBe(true);
      }
    });

    it("matches a tool by registry id and by its sanitized name", () => {
      const allowed = ["meta.insights", "n8n.trigger"];

      expect(isToolAllowed("meta.insights", allowed)).toBe(true);
      expect(isToolAllowed("meta-insights", allowed)).toBe(true);
      expect(resolveAllowedToolId("meta-insights", allowed)).toBe("meta.insights");
      expect(sanitizeToolName("meta.campaign.budget.update")).toBe(
        "meta-campaign-budget-update"
      );
    });

    it("rejects a tool outside the allowlist in either spelling", () => {
      const allowed = ["meta.insights"];

      expect(isToolAllowed("whatsapp.send", allowed)).toBe(false);
      expect(isToolAllowed("whatsapp-send", allowed)).toBe(false);
      expect(isToolAllowed("meta.insights.evil", allowed)).toBe(false);
      expect(isToolAllowed("", allowed)).toBe(false);
      expect(resolveAllowedToolId("whatsapp-send", allowed)).toBeNull();
    });

    it("declares the same allowlist on the agent instance as in the policy", () => {
      // The instance value is convenience only — the Orchestrator reads the
      // registry — but a drift between the two would be confusing, so it is
      // pinned.
      const cases = [
        [new KnowledgeAgent({ provider }), AGENT_IDS.knowledge],
        [new AnalyticsAgent({ provider }), AGENT_IDS.analytics],
        [new AutomationAgent({ provider }), AGENT_IDS.automation],
        [new CommunicationAgent({ provider }), AGENT_IDS.communication],
        [new GoogleAdsAgent({ provider }), AGENT_IDS.googleAds],
        [new BrowserAgent({ provider }), AGENT_IDS.browser],
      ] as const;

      for (const [agent, id] of cases) {
        expect(agent.tools).toEqual([...AGENT_POLICIES[id]!.allowedTools]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scoped registry
  // -------------------------------------------------------------------------

  describe("scoped tool registry", () => {
    const base = toolRegistryOf(productionLikeTools());

    it("returns allowed tools and hides everything else", () => {
      const scoped = scopedToolRegistry(base, ["meta.accounts", "meta.insights"]);

      expect(scoped.get("meta.accounts")?.id).toBe("meta.accounts");
      expect(scoped.get("whatsapp.send")).toBeUndefined();
      expect(scoped.get("n8n.trigger")).toBeUndefined();
      expect(scoped.get("google.insights")).toBeUndefined();
    });

    it("enumerates only the allowed tools", () => {
      const scoped = scopedToolRegistry(base, ["n8n.trigger"]);

      expect(scoped.getAll().map((t) => t.id)).toEqual(["n8n.trigger"]);
    });

    it("hides everything for an empty allowlist", () => {
      const scoped = scopedToolRegistry(base, []);

      expect(scoped.getAll()).toEqual([]);
      expect(scoped.get("meta.insights")).toBeUndefined();
    });

    it("resolves a sanitized name to the underlying tool", () => {
      const scoped = scopedToolRegistry(base, ["meta.insights"]);

      expect(scoped.get("meta-insights")?.id).toBe("meta.insights");
    });

    it("does not return a tool that is absent from the base registry", () => {
      const sparse = toolRegistryOf([fakeTool({ id: "meta.accounts" })]);
      const scoped = scopedToolRegistry(sparse, ["meta.accounts", "n8n.trigger"]);

      expect(scoped.get("meta.accounts")).toBeDefined();
      expect(scoped.get("n8n.trigger")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Immutability
  // -------------------------------------------------------------------------

  describe("policy immutability", () => {
    it("cannot be widened at runtime", () => {
      const policy = AGENT_POLICIES[AGENT_IDS.knowledge]!;
      const before = [...policy.allowedTools];

      expect(() => {
        (policy.allowedTools as string[]).push("whatsapp.send");
      }).toThrow();

      // The property is IMMUTABILITY, not emptiness: the list is unchanged and
      // the tool the push tried to add is still absent.
      expect([...AGENT_POLICIES[AGENT_IDS.knowledge]!.allowedTools]).toEqual(before);
      expect(AGENT_POLICIES[AGENT_IDS.knowledge]!.allowedTools).not.toContain("whatsapp.send");
    });

    it("cannot have an agent swapped into the table", () => {
      expect(() => {
        (AGENT_POLICIES as Record<string, unknown>)["developer-agent"] = {};
      }).toThrow();

      expect(getAgentPolicy("developer-agent")).toBeUndefined();
    });
  });
});
