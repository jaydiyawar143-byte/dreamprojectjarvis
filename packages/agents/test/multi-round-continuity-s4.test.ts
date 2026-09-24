// ---------------------------------------------------------------------------
// Skill System V1 — Phase S4: multi-round continuity.
//
// THE DEFECT. The orchestration loop runs five rounds; before S4 the model's
// working memory across them was one. Each round rebuilt the message list from
// the LAST assistant turn and the LAST results, so a four-step objective threw
// away its own evidence:
//
//   round 1  read the numbers     -> R1
//   round 2  sees R1, analyses    -> R2
//   round 3  sees R2. R1 is gone.
//
// S4 replays every completed round instead. That is the whole change — no
// workflow engine, no skill graph, no second planner. Multi-skill composition
// already worked; the model simply could not remember what it had found.
//
// WHAT THESE TESTS HOLD DOWN. Continuity is the easy half. The hard half is
// that nothing else moved: the same depth limit, the same execution cap, the
// same allowlist check on every single call, the same approval behaviour, the
// same failure envelopes, and the S3 skill block still in front of it all.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import type { AIMessage, ITool, SkillContext } from "@jarvis/core";
import { skillsForToolIds } from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { AGENT_IDS } from "../src/agent-policy.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import {
  FakePermissionChecker,
  GatingApprovalService,
  RecordingAuditLogger,
  RecordingToolExecutor,
  ScriptedAIProvider,
  fakeTool,
  productionLikeTools,
  sessionFor,
  toolRegistryOf,
} from "./helpers/sprint6-harness.js";

/** A read-only tool whose result carries a value the test can look for. */
function echoingTool(id: string, payload: string): ITool {
  return fakeTool({
    id,
    risk: "READ_ONLY",
    execute: async () => ({ success: true, data: { marker: payload } }),
  });
}

describe("S4 — earlier tool results stay available", () => {
  let provider: ScriptedAIProvider;
  let audit: RecordingAuditLogger;
  let executor: RecordingToolExecutor;
  let registry: AgentRegistry;
  let tools: ReturnType<typeof toolRegistryOf>;

  beforeEach(() => {
    provider = new ScriptedAIProvider();
    audit = new RecordingAuditLogger();
    tools = toolRegistryOf([
      ...productionLikeTools().filter(
        (t) => !["meta.insights", "meta.analyze", "meta.campaigns"].includes(t.id)
      ),
      echoingTool("meta.insights", "ROUND-ONE-SPEND-4271"),
      echoingTool("meta.analyze", "ROUND-TWO-VERDICT-WEAK"),
      echoingTool("meta.campaigns", "ROUND-THREE-CAMPAIGNS"),
    ]);
    executor = new RecordingToolExecutor(tools);

    registry = new AgentRegistry({ requirePolicy: true });
    registry.register(new ConversationalAssistant({ provider }));
  });

  function orchestrator(overrides: Record<string, unknown> = {}) {
    return new Orchestrator(registry, executor, audit, {
      toolRegistry: tools,
      permissionChecker: new FakePermissionChecker(),
      toolApprovalService: new GatingApprovalService(),
      ...overrides,
    });
  }

  /** Every message the provider saw on call `n` (0-based). */
  function messagesAt(n: number): AIMessage[] {
    return provider.requests[n]!.messages;
  }

  /** The concatenated content of every `tool` message on call `n`. */
  function toolContextAt(n: number): string {
    return messagesAt(n)
      .filter((m) => m.role === "tool")
      .map((m) => m.content)
      .join("\n");
  }

  async function run(message = "check, analyse, then list") {
    return orchestrator().process(
      { message, agentId: AGENT_IDS.general },
      sessionFor("user-1")
    );
  }

  // -------------------------------------------------------------------------
  // A / B. The chain
  // -------------------------------------------------------------------------

  describe("A. a three-round dependent chain keeps round one", () => {
    it("shows round 1's result again on round 3", async () => {
      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("meta.analyze", {}, "c2")
        .pushToolCall("meta.campaigns", {}, "c3")
        .pushText("done");

      await run();

      // Round 2 saw round 1 — true before S4 as well.
      expect(toolContextAt(1)).toContain("ROUND-ONE-SPEND-4271");

      // Round 3 sees BOTH. This is what was lost.
      const round3 = toolContextAt(2);
      expect(round3).toContain("ROUND-ONE-SPEND-4271");
      expect(round3).toContain("ROUND-TWO-VERDICT-WEAK");
    });

    it("replays each round as its own assistant turn, in order", async () => {
      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("meta.analyze", {}, "c2")
        .pushToolCall("meta.campaigns", {}, "c3")
        .pushText("done");

      await run();

      const roles = messagesAt(2).map((m) => m.role);
      // system, user, then assistant/tool per completed round.
      expect(roles.filter((r) => r === "assistant")).toHaveLength(2);
      expect(roles.filter((r) => r === "tool")).toHaveLength(2);
      expect(roles.indexOf("assistant")).toBeLessThan(roles.indexOf("tool"));
    });

    it("keeps the ORIGINAL question as the user turn, not the last round's text", async () => {
      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("meta.analyze", {}, "c2")
        .pushText("done");

      await run("what happened to my spend?");

      const user = messagesAt(1).filter((m) => m.role === "user");
      expect(user[user.length - 1]!.content).toBe("what happened to my spend?");
    });

    it("pairs every tool message with a preceding assistant call id", async () => {
      // The provider protocol rejects a `tool` message that answers nothing.
      // This is why an over-budget result is elided rather than removed.
      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("meta.analyze", {}, "c2")
        .pushToolCall("meta.campaigns", {}, "c3")
        .pushText("done");

      await run();

      const msgs = messagesAt(2);
      const announced = new Set(
        msgs.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((tc) => tc.id) : []))
      );
      for (const m of msgs.filter((x) => x.role === "tool")) {
        expect(announced.has(m.toolCallId!), `unanswered tool message ${m.name}`).toBe(true);
      }
    });
  });

  describe("B. continuity holds past the old depth-2 ceiling", () => {
    it("still has round 1 in view on round 4", async () => {
      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("meta.analyze", {}, "c2")
        .pushToolCall("meta.campaigns", {}, "c3")
        .pushToolCall("meta.accounts", {}, "c4")
        .pushText("done");

      await run();

      const round4 = toolContextAt(3);
      expect(round4).toContain("ROUND-ONE-SPEND-4271");
      expect(round4).toContain("ROUND-TWO-VERDICT-WEAK");
      expect(round4).toContain("ROUND-THREE-CAMPAIGNS");
    });
  });

  // -------------------------------------------------------------------------
  // C / D. The limits do not move
  // -------------------------------------------------------------------------

  describe("C. orchestration depth is still 5", () => {
    it("refuses a sixth round", async () => {
      for (let i = 0; i < 8; i++) provider.pushToolCall("meta.insights", {}, `c${i}`);

      const res = await run();

      expect(res.success).toBe(false);
      expect(res.error?.message).toContain("Orchestration depth limit exceeded");
      expect(provider.requests).toHaveLength(5);
    });
  });

  describe("D. the total execution cap is still 10", () => {
    it("refuses the call that would cross it", async () => {
      // Four rounds of three calls each: 3, 6, 9, then 12 — the fourth round
      // is refused before anything runs.
      const three = (n: number) => ({
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            { id: `a${n}`, name: "meta.insights", arguments: {} },
            { id: `b${n}`, name: "meta.analyze", arguments: {} },
            { id: `c${n}`, name: "meta.campaigns", arguments: {} },
          ],
        },
        finishReason: "tool_calls" as const,
        model: "scripted-model",
      });
      provider.push(three(1), three(2), three(3), three(4));

      const res = await run();

      expect(res.success).toBe(false);
      expect(res.error?.message).toContain("Tool execution limit exceeded");
      expect(executor.requests).toHaveLength(9);
    });
  });

  // -------------------------------------------------------------------------
  // E / F / H. Failure, approval, emptiness
  // -------------------------------------------------------------------------

  describe("E. a failed round does not erase the successful ones", () => {
    it("carries the earlier success AND the failure into the next round", async () => {
      tools = toolRegistryOf([
        ...productionLikeTools().filter((t) => !["meta.insights"].includes(t.id)),
        echoingTool("meta.insights", "ROUND-ONE-SPEND-4271"),
        fakeTool({
          id: "meta.analyze",
          risk: "READ_ONLY",
          execute: async () => ({ success: false, error: "provider refused" }),
        }),
      ]);
      executor = new RecordingToolExecutor(tools);

      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("meta.analyze", {}, "c2")
        .pushToolCall("meta.campaigns", {}, "c3")
        .pushText("done");

      await run();

      const round3 = toolContextAt(2);
      expect(round3).toContain("ROUND-ONE-SPEND-4271");
      expect(round3).toContain("STATUS: FAILED");
    });
  });

  describe("F. approval mid-chain behaves as it did", () => {
    it("surfaces the approval envelope and does not abort the turn", async () => {
      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("meta.campaign.pause", { campaignId: "c_1" }, "c2")
        .pushText("waiting on you");

      const res = await orchestrator().process(
        { message: "look, then pause it", agentId: AGENT_IDS.general },
        sessionFor("user-1")
      );

      expect(res.success).not.toBe(false);
      // The read from round 1 is still in view when the write is proposed.
      expect(toolContextAt(1)).toContain("ROUND-ONE-SPEND-4271");
    });
  });

  describe("H. no tool results at all", () => {
    it("answers in one round without touching the round machinery", async () => {
      provider.pushText("no tools needed");
      const res = await run("just say hello");

      expect(res.success).not.toBe(false);
      expect(provider.requests).toHaveLength(1);
      expect(messagesAt(0).filter((m) => m.role === "tool")).toHaveLength(0);
    });

    it("starts a fresh turn with no memory of the previous one's rounds", async () => {
      provider.pushToolCall("meta.insights", {}, "c1").pushText("done");
      await run("first question");

      provider.pushText("second answer");
      await run("second question");

      const last = messagesAt(provider.requests.length - 1);
      expect(last.filter((m) => m.role === "tool")).toHaveLength(0);
      expect(JSON.stringify(last)).not.toContain("ROUND-ONE-SPEND-4271");
    });
  });

  // -------------------------------------------------------------------------
  // I / J / K. Nothing else moved
  // -------------------------------------------------------------------------

  describe("I. the S3 skill block is untouched", () => {
    it("still prefixes the question, and survives every round", async () => {
      const contexts: SkillContext[] = [
        {
          id: "advertising",
          title: "Business and advertising",
          summary: "Look at how your ad accounts are performing.",
          availability: "EXECUTABLE",
          toolIds: ["meta.insights"],
          blockedBy: [],
        },
      ];

      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("meta.analyze", {}, "c2")
        .pushText("done");

      await orchestrator({
        skillContext: { forAgent: async () => contexts },
      }).process({ message: "how are ads doing?", agentId: AGENT_IDS.general }, sessionFor("user-1"));

      for (let round = 0; round < 3; round++) {
        const user = messagesAt(round).filter((m) => m.role === "user");
        expect(user[user.length - 1]!.content).toContain("Business and advertising");
      }
    });
  });

  describe("J. accumulation grants nothing", () => {
    it("checks the allowlist on every call of every round", async () => {
      // `whatsapp.send` is not on the general assistant's policy. Asking for it
      // on round 2 — after a legitimate round 1 — must still be refused.
      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("whatsapp.send", { to: "+1", body: "hi" }, "c2")
        .pushText("done");

      await run();

      const denied = audit.byAction("agent.tool_denied");
      expect(denied).toHaveLength(1);
      expect(denied[0]!.toolId).toBe("whatsapp.send");
      expect(executor.requests.map((r) => r.toolId)).not.toContain("whatsapp.send");
    });

    it("leaves a denial visible to the next round rather than hiding it", async () => {
      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("whatsapp.send", { to: "+1", body: "hi" }, "c2")
        .pushToolCall("meta.analyze", {}, "c3")
        .pushText("done");

      await run();

      expect(toolContextAt(2)).toContain("PERMISSION_DENIED");
    });
  });

  describe("K. ToolExecutor is still the only thing that runs a tool", () => {
    it("routes every executed call through the executor, once each", async () => {
      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("meta.analyze", {}, "c2")
        .pushToolCall("meta.campaigns", {}, "c3")
        .pushText("done");

      await run();

      expect(executor.requests.map((r) => r.toolId)).toEqual([
        "meta.insights",
        "meta.analyze",
        "meta.campaigns",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // L. Skill attribution, derived
  // -------------------------------------------------------------------------

  describe("L. which skills took part, derived from the tool ids", () => {
    it("maps executed tools to their skills, in order of first appearance", async () => {
      provider
        .pushToolCall("meta.insights", {}, "c1")
        .pushToolCall("integration.list", {}, "c2")
        .pushText("done");

      await run();

      expect(skillsForToolIds(executor.requests.map((r) => r.toolId))).toEqual([
        "advertising",
        "integrations",
      ]);
    });

    it("attributes nothing to an intentionally unlisted tool", () => {
      expect(skillsForToolIds(["self.describe", "task.create", "system.echo"])).toEqual([]);
    });

    it("invents no skill for an id it does not know", () => {
      expect(skillsForToolIds(["totally.unknown", "meta.insights"])).toEqual(["advertising"]);
    });

    it("is deterministic and de-duplicated", () => {
      const ids = ["meta.insights", "meta.campaigns", "maps.nearby", "meta.ads"];
      expect(skillsForToolIds(ids)).toEqual(["advertising", "places"]);
      expect(skillsForToolIds(ids)).toEqual(skillsForToolIds(ids));
    });
  });
});
