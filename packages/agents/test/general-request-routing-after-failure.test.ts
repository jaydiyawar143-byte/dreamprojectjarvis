// ---------------------------------------------------------------------------
// R-30 — a plain request never lands on the Meta Ads agent by accident.
//
// The router always ranks the general assistant last, as the terminal choice.
// When every agent the router named is registered but unavailable, the
// orchestrator used to take the FIRST ready agent in the registry instead —
// in the production registry, the Meta Ads agent — and answer a general
// question with its prompt and tool allowlist, telling nobody.
//
// A structured error is the answer now. A provider failure no longer takes the
// general assistant out of service in the first place.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { AICompletionResponse, AuditLogger, IAIProvider, IToolExecutor, SessionContext } from "@jarvis/core";
import { JarvisError } from "@jarvis/core";

import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { AGENT_IDS } from "../src/agent-policy.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { MetaAdsAgent } from "../src/agents/meta-ads-agent.js";

/** A provider that throws the given failures in order, then answers. */
function scriptedProvider(failures: unknown[]) {
  let calls = 0;
  const provider: IAIProvider = {
    id: "scripted",
    name: "Scripted",
    defaultModel: "scripted-model",
    async complete(): Promise<AICompletionResponse> {
      const failure = failures[calls];
      calls++;
      if (failure !== undefined) throw failure;
      return { message: { role: "assistant", content: "answered" }, finishReason: "stop", model: "scripted-model" };
    },
    async listModels() {
      return [];
    },
    async isAvailable() {
      return true;
    },
  };
  return { provider, calls: () => calls };
}

function build(generalFailures: unknown[]) {
  const general = scriptedProvider(generalFailures);
  const meta = scriptedProvider([]);
  const registry = new AgentRegistry({ requirePolicy: true });
  registry.register(new ConversationalAssistant({ provider: general.provider }));
  registry.register(new MetaAdsAgent({ provider: meta.provider }));

  const auditLogger = { log: async () => {}, query: async () => [] } as unknown as AuditLogger;
  const executor = {
    execute: async () => {
      throw new Error("no tool may run in this test");
    },
  } as unknown as IToolExecutor;

  return { orchestrator: new Orchestrator(registry, executor, auditLogger, {}), general, meta };
}

function session(): SessionContext {
  return {
    auth: { userId: "user-r30", role: "member", email: "r30@example.com" },
    conversationId: "conv-r30",
    traceId: "00000000-0000-0000-0000-000000000030",
  };
}

describe("R-30 — general requests after a failure", () => {
  it("answers a structured error, never the Meta Ads agent, when the general assistant is out of service", async () => {
    // An unexpected error still takes an agent out of service, as before.
    const { orchestrator, meta } = build([new TypeError("Cannot read properties of undefined")]);

    await orchestrator.process({ message: "hello" }, session());
    const second = await orchestrator.process({ message: "hello again" }, session());

    expect(second.success).toBe(false);
    expect(second.error?.code).toBe("AGENT_ERROR");
    expect(second.data?.agentId).toBeUndefined();
    expect(meta.calls()).toBe(0);
  });

  it("keeps the general assistant answering after a permanent provider failure", async () => {
    const { orchestrator, meta } = build([
      new JarvisError("AI_PROVIDER_AUTH_FAILED", "The AI provider rejected this server's API key."),
    ]);

    const first = await orchestrator.process({ message: "hello" }, session());
    const second = await orchestrator.process({ message: "hello again" }, session());

    expect(first.error?.code).toBe("AI_PROVIDER_AUTH_FAILED");
    expect(second.data?.agentId).toBe(AGENT_IDS.general);
    expect(meta.calls()).toBe(0);
  });

  it("still sends a Meta Ads question to the Meta Ads agent", async () => {
    const { orchestrator, meta } = build([]);

    const response = await orchestrator.process({ message: "Meta campaign check" }, session());

    expect(response.data?.agentId).toBe(AGENT_IDS.metaAds);
    expect(meta.calls()).toBe(1);
  });
});
