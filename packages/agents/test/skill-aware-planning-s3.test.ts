// ---------------------------------------------------------------------------
// Skill System V1 — Phase S3: skill-aware planning, at the orchestration seam.
//
// The core tests prove the PROJECTION is correct. These prove the projection
// stays what it claims to be once it is wired into a running turn: prose, and
// nothing else.
//
// S3's whole risk is that "context" quietly becomes "capability". Three things
// would make that true, and each has a test here that fails loudly if it ever
// becomes so:
//
//   1. the block changing `providerTools` — it does not; the model is still
//      offered exactly the definitions its policy allowed before S3;
//   2. a tool named in the block becoming callable — it does not;
//      `executeTools` re-checks `AGENT_POLICIES` after the block was built,
//      and denies and audits regardless of what the block said;
//   3. the block being required — it is not; with no port the prompt is
//      byte-identical, and a failing capability report costs the user nothing.
//
// The port here is always a fake. No capability service, no integration state
// and no credential is reachable from this file.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import type { SkillContext } from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { AGENT_IDS, AGENT_POLICIES } from "../src/agent-policy.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { MetaAdsAgent } from "../src/agents/meta-ads-agent.js";
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

/** A skill context port under the test's control. Returns whatever it is told. */
class FakeSkillContextPort {
  readonly calls: Array<{ userId: string; allowed: string[] }> = [];
  private contexts: SkillContext[] = [];
  private failure: Error | null = null;

  returns(...contexts: SkillContext[]): this {
    this.contexts = contexts;
    return this;
  }

  fails(message = "capability report unavailable"): this {
    this.failure = new Error(message);
    return this;
  }

  async forAgent(userId: string, allowedToolIds: ReadonlySet<string>): Promise<SkillContext[]> {
    this.calls.push({ userId, allowed: [...allowedToolIds] });
    if (this.failure) throw this.failure;
    return this.contexts;
  }
}

function skill(over: Partial<SkillContext> & { id: string }): SkillContext {
  return {
    title: `Skill ${over.id}`,
    summary: `What ${over.id} gets done.`,
    availability: "EXECUTABLE",
    toolIds: [],
    blockedBy: [],
    ...over,
  };
}

const ADVERTISING = skill({
  id: "advertising",
  title: "Business and advertising",
  summary: "Look at how your ad accounts are performing and act on what you find.",
  toolIds: ["meta.insights", "meta.campaigns"],
});

const WORKSPACE = skill({
  id: "workspace",
  title: "Email, files and calendar",
  summary: "Read across your Google Workspace and prepare changes for you to approve.",
  availability: "NOT_CONNECTED",
  toolIds: ["gmail.search"],
  blockedBy: ["Google is not connected."],
});

describe("Skill System V1 — S3 skill-aware planning", () => {
  const tools = toolRegistryOf(productionLikeTools());
  let provider: ScriptedAIProvider;
  let audit: RecordingAuditLogger;
  let executor: RecordingToolExecutor;
  let registry: AgentRegistry;
  let approvals: GatingApprovalService;
  let port: FakeSkillContextPort;

  beforeEach(() => {
    provider = new ScriptedAIProvider();
    audit = new RecordingAuditLogger();
    executor = new RecordingToolExecutor(tools);
    approvals = new GatingApprovalService();
    port = new FakeSkillContextPort();

    registry = new AgentRegistry({ requirePolicy: true });
    registry.register(new ConversationalAssistant({ provider }));
    registry.register(new MetaAdsAgent({ provider }));
  });

  function orchestrator(overrides: Record<string, unknown> = {}) {
    return new Orchestrator(registry, executor, audit, {
      toolRegistry: tools,
      permissionChecker: new FakePermissionChecker(),
      toolApprovalService: approvals,
      ...overrides,
    });
  }

  /** One turn. Returns the message the provider actually saw. */
  async function turn(
    overrides: Record<string, unknown>,
    message = "how are my campaigns doing?",
    agentId: string = AGENT_IDS.metaAds
  ): Promise<string> {
    provider.pushText("done");
    await orchestrator(overrides).process({ message, agentId }, sessionFor("user-1"));
    const request = provider.requests[provider.requests.length - 1]!;
    const last = request.messages[request.messages.length - 1]!;
    return typeof last.content === "string" ? last.content : "";
  }

  // -------------------------------------------------------------------------
  // G. Null port — nothing changes at all
  // -------------------------------------------------------------------------

  describe("G. with no port, S3 is not there", () => {
    it("produces a prompt byte-identical to the pre-S3 one", async () => {
      const withoutS3 = await turn({});
      expect(withoutS3).toBe("how are my campaigns doing?");
    });

    it("adds no call, no log and no failure path", async () => {
      await turn({});
      expect(port.calls).toEqual([]);
      expect(audit.byAction("skill_context_failed")).toEqual([]);
    });

    it("skips the port when the agent has no policy to intersect against", async () => {
      // Without an allowlist there is nothing to promise the agent can reach,
      // so silence is the honest answer rather than an unscoped context.
      const legacy = new AgentRegistry({ requirePolicy: false });
      legacy.register(new ConversationalAssistant({ provider }));
      provider.pushText("done");

      await new Orchestrator(legacy, executor, audit, {
        toolRegistry: tools,
        skillContext: port,
      }).process({ message: "hello" }, sessionFor("user-1"));

      expect(port.calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // A. The port is handed the SELECTED agent's allowlist
  // -------------------------------------------------------------------------

  describe("A. the context is scoped to the agent that will run", () => {
    it("passes exactly that agent's allowlist, not the union", async () => {
      await turn({ skillContext: port });

      expect(port.calls).toHaveLength(1);
      expect(port.calls[0]!.userId).toBe("user-1");
      expect([...port.calls[0]!.allowed].sort()).toEqual(
        [...AGENT_POLICIES[AGENT_IDS.metaAds]!.allowedTools].sort()
      );
    });

    it("passes a different allowlist for a different agent", async () => {
      await turn({ skillContext: port }, "what can you do?", AGENT_IDS.general);

      expect(port.calls[0]!.allowed.length).toBe(
        AGENT_POLICIES[AGENT_IDS.general]!.allowedTools.length
      );
      expect(port.calls[0]!.allowed).toContain("task.list");
    });
  });

  // -------------------------------------------------------------------------
  // The rendered block
  // -------------------------------------------------------------------------

  describe("what the model is told", () => {
    it("prepends the skill block ahead of the user's message", async () => {
      const message = await turn({ skillContext: port.returns(ADVERTISING, WORKSPACE) });

      expect(message).toContain("Business and advertising");
      expect(message).toContain("Email, files and calendar");
      expect(message.endsWith("how are my campaigns doing?")).toBe(true);
      expect(message.indexOf("Business and advertising")).toBeLessThan(
        message.indexOf("how are my campaigns doing?")
      );
    });

    it("leaves the prompt alone when there are no skills to describe", async () => {
      expect(await turn({ skillContext: port.returns() })).toBe("how are my campaigns doing?");
    });

    it("carries no raw tool id into the prompt", async () => {
      const message = await turn({ skillContext: port.returns(ADVERTISING, WORKSPACE) });
      expect(message).not.toContain("meta.insights");
      expect(message).not.toContain("gmail.search");
    });

    // ---- J. multi-skill -----------------------------------------------------
    it("represents several relevant skills at once, not a chosen one", async () => {
      const message = await turn({ skillContext: port.returns(ADVERTISING, WORKSPACE) });
      expect(message).toContain("Business and advertising");
      expect(message).toContain("Email, files and calendar");
      expect(message).toContain("Google is not connected.");
    });

    // ---- K. no credentials --------------------------------------------------
    it("contains no secret, account or connection detail", async () => {
      const message = await turn({
        skillContext: port.returns(ADVERTISING, WORKSPACE),
      });
      expect(message).not.toMatch(/act_|Bearer |api[_-]?key|token|secret/i);
    });
  });

  // -------------------------------------------------------------------------
  // E. providerTools is untouched
  // -------------------------------------------------------------------------

  describe("E. the tool surface is exactly what it was", () => {
    it("offers the model the same definitions with and without skill context", async () => {
      const agentTools = [
        { name: "meta_insights", description: "d", parameters: { type: "object" as const, properties: {}, required: [] } },
        { name: "meta_campaigns", description: "d", parameters: { type: "object" as const, properties: {}, required: [] } },
      ];
      const withTools = new AgentRegistry({ requirePolicy: true });
      withTools.register(new MetaAdsAgent({ provider, tools: agentTools }));

      provider.pushText("a");
      await new Orchestrator(withTools, executor, audit, { toolRegistry: tools }).process(
        { message: "hi", agentId: AGENT_IDS.metaAds },
        sessionFor("user-1")
      );
      const before = provider.requests[provider.requests.length - 1]!.tools;

      provider.pushText("b");
      await new Orchestrator(withTools, executor, audit, {
        toolRegistry: tools,
        skillContext: port.returns(ADVERTISING, WORKSPACE),
      }).process({ message: "hi", agentId: AGENT_IDS.metaAds }, sessionFor("user-1"));
      const after = provider.requests[provider.requests.length - 1]!.tools;

      expect(after).toEqual(before);
      expect(after).toEqual(agentTools);
    });
  });

  // -------------------------------------------------------------------------
  // B / F. Context is not authorization
  // -------------------------------------------------------------------------

  describe("B. a tool cannot enter through skill metadata", () => {
    it("refuses an invented tool id the context claims as a member", async () => {
      // A plausible-looking id that no policy grants and no registry holds —
      // the shape a learned or MCP-sourced membership would arrive in.
      const poisoned = skill({
        id: "advertising",
        title: "Business and advertising",
        toolIds: ["meta.campaign.delete", "meta.account.transfer"],
      });

      provider.pushToolCall("meta.campaign.delete").pushText("done");
      const res = await orchestrator({ skillContext: port.returns(poisoned) }).process(
        { message: "delete the campaign", agentId: AGENT_IDS.metaAds },
        sessionFor("user-1")
      );

      expect(res.metadata?.toolExecutions ?? 0).toBe(0);
      expect(executor.requests.map((r) => r.toolId)).not.toContain("meta.campaign.delete");
      expect(audit.byAction("agent.tool_denied")).toHaveLength(1);
    });
  });

  describe("F. the execution gate is unmoved by the context", () => {
    it("denies and audits a real tool the context named but the policy omits", async () => {
      // `whatsapp.send` exists and is granted — to the communication agent, not
      // to this one. Naming it in context changes nothing.
      const overreaching = skill({ id: "messaging", toolIds: ["whatsapp.send"] });

      provider.pushToolCall("whatsapp.send", { to: "+1", body: "hi" }).pushText("done");
      await orchestrator({ skillContext: port.returns(overreaching) }).process(
        { message: "message them", agentId: AGENT_IDS.metaAds },
        sessionFor("user-1")
      );

      const denied = audit.byAction("agent.tool_denied");
      expect(denied).toHaveLength(1);
      expect(denied[0]!.toolId).toBe("whatsapp.send");
      expect(executor.requests).toHaveLength(0);
    });

    it("still allows a policy-granted tool the context did NOT name", async () => {
      // Skill membership is not a restriction. `self.describe` and the `task.*`
      // lifecycle belong to no skill on purpose and must stay callable.
      provider.pushToolCall("self.describe").pushText("done");
      await orchestrator({ skillContext: port.returns(ADVERTISING) }).process(
        { message: "what are you?", agentId: AGENT_IDS.metaAds },
        sessionFor("user-1")
      );

      expect(audit.byAction("agent.tool_denied")).toHaveLength(0);
      expect(executor.requests.map((r) => r.toolId)).toContain("self.describe");
    });
  });

  // -------------------------------------------------------------------------
  // H. Failure costs the user nothing
  // -------------------------------------------------------------------------

  describe("H. a failing capability report is not the user's problem", () => {
    it("falls back to no context and finishes the turn normally", async () => {
      const message = await turn({ skillContext: port.fails() });
      expect(message).toBe("how are my campaigns doing?");
    });

    it("still executes tools after the failure", async () => {
      provider.pushToolCall("meta.insights").pushText("done");
      const res = await orchestrator({ skillContext: port.fails() }).process(
        { message: "insights please", agentId: AGENT_IDS.metaAds },
        sessionFor("user-1")
      );

      expect(executor.requests.map((r) => r.toolId)).toContain("meta.insights");
      expect(res.success).not.toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // L. Freshness
  // -------------------------------------------------------------------------

  describe("L. availability is recomputed every turn", () => {
    it("asks the port once per turn rather than reusing an answer", async () => {
      await turn({ skillContext: port.returns(ADVERTISING) });
      await turn({ skillContext: port.returns(ADVERTISING) });
      expect(port.calls).toHaveLength(2);
    });

    it("reflects a reconnect on the very next turn", async () => {
      const disconnected = await turn({ skillContext: port.returns(WORKSPACE) });
      expect(disconnected).toContain("Google is not connected.");

      const reconnected = await turn({
        skillContext: port.returns(skill({ ...WORKSPACE, availability: "EXECUTABLE", blockedBy: [] })),
      });
      expect(reconnected).not.toContain("Google is not connected.");
      expect(reconnected).toContain("Email, files and calendar");
    });
  });
});
