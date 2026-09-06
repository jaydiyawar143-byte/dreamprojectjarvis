// ---------------------------------------------------------------------------
// Sprint 6.11 — Orchestration: intent routing and error handling.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import type { AgentPolicy, ConversationMessage } from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { AGENT_IDS, AGENT_POLICIES } from "../src/agent-policy.js";
import { rankAgentCandidates, isAmbiguous } from "../src/agent-router.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { MetaAdsAgent } from "../src/agents/meta-ads-agent.js";
import { KnowledgeAgent } from "../src/agents/knowledge-agent.js";
import { AnalyticsAgent } from "../src/agents/analytics-agent.js";
import { AutomationAgent } from "../src/agents/automation-agent.js";
import { CommunicationAgent } from "../src/agents/communication-agent.js";
import { GoogleAdsAgent } from "../src/agents/google-ads-agent.js";
import {
  FailingAIProvider,
  FakePermissionChecker,
  RecordingAuditLogger,
  RecordingToolExecutor,
  ScriptedAIProvider,
  productionLikeTools,
  sessionFor,
  toolRegistryOf,
} from "./helpers/sprint6-harness.js";

function history(...contents: string[]): ConversationMessage[] {
  return contents.map((content, i) => ({
    id: String(i),
    role: i % 2 === 0 ? "user" : "assistant",
    content,
    createdAt: new Date().toISOString(),
  })) as ConversationMessage[];
}

describe("Sprint 6.8 — orchestration", () => {
  let provider: ScriptedAIProvider;
  let registry: AgentRegistry;
  let audit: RecordingAuditLogger;
  let executor: RecordingToolExecutor;
  const tools = toolRegistryOf(productionLikeTools());

  /** A fully configured deployment: every agent registered. */
  function fullRegistry(): AgentRegistry {
    const r = new AgentRegistry({ requirePolicy: true });
    r.register(new ConversationalAssistant({ provider }));
    r.register(new MetaAdsAgent({ provider }));
    r.register(new KnowledgeAgent({ provider }));
    r.register(new AnalyticsAgent({ provider }));
    r.register(new AutomationAgent({ provider }));
    r.register(new CommunicationAgent({ provider }));
    r.register(new GoogleAdsAgent({ provider }));
    return r;
  }

  function orchestrator(reg: AgentRegistry = registry) {
    return new Orchestrator(reg, executor, audit, {
      toolRegistry: tools,
      permissionChecker: new FakePermissionChecker(),
    });
  }

  async function routedAgent(
    message: string,
    conversationHistory: ConversationMessage[] = [],
    reg: AgentRegistry = registry,
    role: Parameters<typeof sessionFor>[1] = "member"
  ): Promise<string | undefined> {
    const res = await orchestrator(reg).process(
      { message, conversationHistory },
      sessionFor("user-1", role)
    );
    return res.data?.agentId;
  }

  beforeEach(() => {
    provider = new ScriptedAIProvider();
    audit = new RecordingAuditLogger();
    executor = new RecordingToolExecutor(tools);
    registry = fullRegistry();
  });

  // -------------------------------------------------------------------------
  // Correct intent -> correct agent
  // -------------------------------------------------------------------------

  describe("correct intent routes to the correct agent", () => {
    it("routes Meta Ads questions to the Meta Ads agent", async () => {
      expect(await routedAgent("Meta campaign check karo")).toBe(AGENT_IDS.metaAds);
      expect(await routedAgent("Facebook ads ka ROAS batao")).toBe(AGENT_IDS.metaAds);
      expect(await routedAgent("CPA kyun badh raha hai?")).toBe(AGENT_IDS.metaAds);
    });

    it("routes Google Ads questions to the Google agent", async () => {
      expect(await routedAgent("Google Ads campaign analyze karo")).toBe(
        AGENT_IDS.googleAds
      );
      expect(await routedAgent("show my adwords spend")).toBe(AGENT_IDS.googleAds);
    });

    it("routes workflow requests to the automation agent", async () => {
      expect(await routedAgent("trigger the onboarding workflow")).toBe(
        AGENT_IDS.automation
      );
      expect(await routedAgent("run my n8n automation")).toBe(AGENT_IDS.automation);
    });

    it("routes WhatsApp requests to the communication agent", async () => {
      expect(await routedAgent("reply to that WhatsApp message")).toBe(
        AGENT_IDS.communication
      );
    });

    it("routes document questions to the knowledge agent", async () => {
      expect(await routedAgent("what does our refund policy document say?")).toBe(
        AGENT_IDS.knowledge
      );
      expect(await routedAgent("search my documents for the SLA")).toBe(
        AGENT_IDS.knowledge
      );
    });

    it("routes platform-neutral measurement questions to analytics", async () => {
      expect(await routedAgent("compare this month vs last month")).toBe(
        AGENT_IDS.analytics
      );
      expect(await routedAgent("any anomalies in the KPIs?")).toBe(
        AGENT_IDS.analytics
      );
    });

    it("routes anything else to the general assistant", async () => {
      expect(await routedAgent("Hello JARVIS")).toBe(AGENT_IDS.general);
      expect(await routedAgent("Python script bana do")).toBe(AGENT_IDS.general);
      expect(await routedAgent("what's the weather")).toBe(AGENT_IDS.general);
    });

    it("is deterministic across repeated calls", async () => {
      for (let i = 0; i < 5; i++) {
        expect(await routedAgent("Meta campaign check karo")).toBe(AGENT_IDS.metaAds);
        expect(await routedAgent("run my n8n workflow")).toBe(AGENT_IDS.automation);
        expect(await routedAgent("Hello")).toBe(AGENT_IDS.general);
      }
    });

    it("keeps Meta analysis on the Meta agent rather than analytics", async () => {
      // Both domains claim it; Sprint 6.4 says domain logic stays in the
      // domain agent, so Meta must win.
      expect(await routedAgent("compare Meta CPA this week vs last week")).toBe(
        AGENT_IDS.metaAds
      );
    });

    it("does not send Gmail requests to the Google Ads agent", async () => {
      // Sprint 5 implemented Google ADS only. Routing a Gmail request to an
      // agent that cannot help would produce a confident non-answer.
      expect(await routedAgent("Ab mere Gmail ka summary do")).toBe(AGENT_IDS.general);
    });
  });

  // -------------------------------------------------------------------------
  // Degraded deployments
  // -------------------------------------------------------------------------

  describe("unsupported capability", () => {
    it("falls back to the general assistant when the routed agent is absent", async () => {
      const partial = new AgentRegistry({ requirePolicy: true });
      partial.register(new ConversationalAssistant({ provider }));
      partial.register(new MetaAdsAgent({ provider }));

      // n8n and WhatsApp unconfigured, so those agents were never registered.
      expect(await routedAgent("trigger my n8n workflow", [], partial)).toBe(
        AGENT_IDS.general
      );
      expect(await routedAgent("send a WhatsApp message", [], partial)).toBe(
        AGENT_IDS.general
      );
      expect(await routedAgent("Meta campaign check", [], partial)).toBe(
        AGENT_IDS.metaAds
      );
    });

    it("skips a disabled agent and takes the next candidate", async () => {
      const automation = registry.get(AGENT_IDS.automation)!;
      await automation.shutdown(); // status -> "disabled"

      expect(await routedAgent("run my n8n workflow")).toBe(AGENT_IDS.general);
    });

    it("errors when no agent at all is available", async () => {
      const empty = new AgentRegistry({ requirePolicy: true });
      const res = await orchestrator(empty).process(
        { message: "hello" },
        sessionFor("user-1")
      );

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("AGENT_ERROR");
    });
  });

  // -------------------------------------------------------------------------
  // Ambiguity
  // -------------------------------------------------------------------------

  describe("ambiguous intent", () => {
    it("flags a message claimed by two specialized domains", () => {
      const candidates = rankAgentCandidates(
        "send a WhatsApp message about the Google Ads report"
      );

      expect(isAmbiguous(candidates)).toBe(true);
      expect(candidates.map((c) => c.domain)).toContain("communication");
      expect(candidates.map((c) => c.domain)).toContain("google-ads");
    });

    it("does not flag a single-domain message", () => {
      expect(isAmbiguous(rankAgentCandidates("Meta campaign check"))).toBe(false);
      expect(isAmbiguous(rankAgentCandidates("hello"))).toBe(false);
    });

    it("still resolves deterministically to the highest-ranked candidate", async () => {
      const message = "send a WhatsApp message about the Google Ads report";
      expect(await routedAgent(message)).toBe(AGENT_IDS.communication);
      expect(await routedAgent(message)).toBe(AGENT_IDS.communication);
    });

    it("always ends the candidate list with the general assistant", () => {
      for (const message of ["", "hello", "Meta campaign", "n8n workflow"]) {
        const candidates = rankAgentCandidates(message);
        expect(candidates.at(-1)?.agentId).toBe(AGENT_IDS.general);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Client-named agents
  // -------------------------------------------------------------------------

  describe("client-supplied agentId is validated, not trusted", () => {
    it("honours a valid, selectable agent", async () => {
      const res = await orchestrator().process(
        { message: "anything", agentId: AGENT_IDS.analytics },
        sessionFor("user-1")
      );

      expect(res.data?.agentId).toBe(AGENT_IDS.analytics);
    });

    it("rejects an unknown agent id", async () => {
      const res = await orchestrator().process(
        { message: "hi", agentId: "browser-agent" },
        sessionFor("user-1")
      );

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("AGENT_NOT_FOUND");
    });

    it("rejects an agent whose policy forbids direct selection", async () => {
      const reg = new AgentRegistry();
      const locked: AgentPolicy = {
        ...AGENT_POLICIES[AGENT_IDS.automation]!,
        clientSelectable: false,
      };
      reg.register(new ConversationalAssistant({ provider }));
      reg.register(new AutomationAgent({ provider }), locked);

      const res = await orchestrator(reg).process(
        { message: "hi", agentId: AGENT_IDS.automation },
        sessionFor("user-1")
      );

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("AUTHORIZATION_FAILED");
    });

    it("rejects an agent the caller's role may not use", async () => {
      // The automation agent requires `execute`; a viewer holds only `read`.
      const res = await orchestrator().process(
        { message: "hi", agentId: AGENT_IDS.automation },
        sessionFor("user-1", "viewer")
      );

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("AUTHORIZATION_FAILED");
    });

    it("rejects a disabled agent by id", async () => {
      await registry.get(AGENT_IDS.knowledge)!.shutdown();

      const res = await orchestrator().process(
        { message: "hi", agentId: AGENT_IDS.knowledge },
        sessionFor("user-1")
      );

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("AGENT_ERROR");
    });
  });

  // -------------------------------------------------------------------------
  // Unauthorized routing
  // -------------------------------------------------------------------------

  describe("unauthorized requests", () => {
    it("routes a viewer past the automation agent to the general assistant", async () => {
      // A viewer cannot hold `execute`, so automation is skipped rather than
      // failing the whole request.
      expect(await routedAgent("run my n8n workflow", [], registry, "viewer")).toBe(
        AGENT_IDS.general
      );
    });

    it("routes a viewer past the communication agent", async () => {
      // Communication needs `write`; a viewer has read only.
      expect(
        await routedAgent("send a WhatsApp reply", [], registry, "viewer")
      ).toBe(AGENT_IDS.general);
    });

    it("still routes a viewer to read-only specialists", async () => {
      expect(await routedAgent("Meta campaign check", [], registry, "viewer")).toBe(
        AGENT_IDS.metaAds
      );
      expect(
        await routedAgent("what does my policy document say", [], registry, "viewer")
      ).toBe(AGENT_IDS.knowledge);
    });

    it("lets an owner reach every agent", async () => {
      expect(await routedAgent("run my n8n workflow", [], registry, "owner")).toBe(
        AGENT_IDS.automation
      );
      expect(await routedAgent("send a WhatsApp reply", [], registry, "owner")).toBe(
        AGENT_IDS.communication
      );
    });
  });

  // -------------------------------------------------------------------------
  // Missing context and malformed input
  // -------------------------------------------------------------------------

  describe("missing context and malformed input", () => {
    it("routes an empty message to the general assistant without throwing", async () => {
      expect(await routedAgent("")).toBe(AGENT_IDS.general);
    });

    it("tolerates a message that is not a string", () => {
      const candidates = rankAgentCandidates(undefined as unknown as string);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.agentId).toBe(AGENT_IDS.general);
    });

    it("tolerates absent conversation history", () => {
      expect(() => rankAgentCandidates("campaign check", undefined)).not.toThrow();
    });

    it("works with no conversationId on the session", async () => {
      const res = await orchestrator().process(
        { message: "Meta campaign check" },
        sessionFor("user-1", "member", { conversationId: undefined })
      );

      expect(res.success).toBe(true);
      expect(res.data?.agentId).toBe(AGENT_IDS.metaAds);
    });
  });

  // -------------------------------------------------------------------------
  // Failure propagation
  // -------------------------------------------------------------------------

  describe("provider failure", () => {
    it("returns a structured error rather than throwing", async () => {
      const reg = new AgentRegistry({ requirePolicy: true });
      reg.register(new AnalyticsAgent({ provider: new FailingAIProvider() }));

      const res = await orchestrator(reg).process(
        { message: "compare last month" },
        sessionFor("user-1")
      );

      expect(res.success).toBe(false);
      expect(res.error?.code).toBeDefined();
      expect(res.traceId).toBeDefined();
    });

    it("records the failure in the audit trail", async () => {
      const reg = new AgentRegistry({ requirePolicy: true });
      reg.register(new AnalyticsAgent({ provider: new FailingAIProvider() }));

      await orchestrator(reg).process(
        { message: "compare last month" },
        sessionFor("user-1")
      );

      expect(audit.entries.some((e) => e.result === "failure")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // History-driven routing continuity
  // -------------------------------------------------------------------------

  describe("conversation context", () => {
    it("keeps a generic follow-up on the Meta agent after a Meta turn", async () => {
      const h = history("Meta campaign check karo", "Checking your campaigns.");
      expect(await routedAgent("Campaign optimize karo", h)).toBe(AGENT_IDS.metaAds);
    });

    it("does not let stale Meta history capture an unrelated request", async () => {
      const h = history("Meta campaign check karo");
      expect(await routedAgent("Python script bana do", h)).toBe(AGENT_IDS.general);
    });
  });
});
