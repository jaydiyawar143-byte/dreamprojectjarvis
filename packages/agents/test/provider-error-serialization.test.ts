// ---------------------------------------------------------------------------
// R-31 — the orchestrator's error response.
//
// `buildErrorResponse` copied `error.details` into the response as-is, so any
// `cause` a provider put there reached the browser verbatim. R-30's chain puts
// an error code there, which is safe and stays; anything else is dropped.
//
// And a provider failure, now carrying only a fixed message, still never sends
// a plain request to the Meta Ads agent (R-30).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { AICompletionResponse, AuditLogger, IAIProvider, IToolExecutor, SessionContext } from "@jarvis/core";
import { JarvisError } from "@jarvis/core";

import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { AGENT_IDS } from "../src/agent-policy.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { MetaAdsAgent } from "../src/agents/meta-ads-agent.js";

const FAKE_KEY = "sk-test-r31-not-a-real-key";

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

  return { orchestrator: new Orchestrator(registry, executor, auditLogger, {}), meta };
}

function session(): SessionContext {
  return {
    auth: { userId: "user-r31", role: "member", email: "r31@example.com" },
    conversationId: "conv-r31",
    traceId: "00000000-0000-0000-0000-000000000031",
  };
}

const UNAVAILABLE = "The AI provider is temporarily unavailable. Please try again shortly.";

describe("R-31 — details.cause in the orchestrator's error response", () => {
  it("keeps an error-code cause exactly, as R-30 answers it", async () => {
    const { orchestrator } = build([
      new JarvisError("AI_PROVIDER_UNAVAILABLE", UNAVAILABLE, { transient: true, cause: "AI_PROVIDER_AUTH_FAILED" }),
    ]);

    const response = await orchestrator.process({ message: "hello" }, session());

    expect(response.error).toEqual({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: UNAVAILABLE,
      details: { transient: true, cause: "AI_PROVIDER_AUTH_FAILED" },
    });
  });

  it.each([
    ["provider text", "The model `gpt-r31-secret` does not exist at https://internal-gateway.example/v1"],
    ["a key", `Incorrect API key provided: ${FAKE_KEY}`],
    ["an object", { status: 401, body: `Incorrect API key provided: ${FAKE_KEY}` }],
    ["a stack trace", "Error: boom\n    at handler (/srv/jarvis/packages/ai-openai/dist/index.js:1:1)"],
  ])("drops a cause that is %s", async (_label, cause) => {
    const { orchestrator } = build([new JarvisError("AI_PROVIDER_UNAVAILABLE", UNAVAILABLE, { transient: true, cause })]);

    const response = await orchestrator.process({ message: "hello" }, session());
    const body = JSON.stringify(response);

    expect(response.error?.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(response.error?.details).toEqual({ transient: true });
    for (const leak of ["gpt-r31-secret", "internal-gateway", FAKE_KEY, "/srv/jarvis", "Incorrect API key"]) {
      expect(body).not.toContain(leak);
    }
  });
});

describe("R-31 — a provider failure never sends the next plain request to the Meta Ads agent", () => {
  it.each([
    ["an invalid request", new JarvisError("INVALID_REQUEST", "The AI provider could not process this request.")],
    ["a rate limit", new JarvisError("RATE_LIMITED", "The AI service is receiving too many requests.", { transient: true })],
    ["a timeout", new JarvisError("INTERNAL_ERROR", "The AI service took too long to respond.", { transient: true })],
    ["an exhausted provider chain", new JarvisError("AI_PROVIDER_UNAVAILABLE", UNAVAILABLE, { transient: true, cause: "INVALID_REQUEST" })],
  ])("after %s, the general assistant answers", async (_label, failure) => {
    const { orchestrator, meta } = build([failure]);

    const first = await orchestrator.process({ message: "hello" }, session());
    const second = await orchestrator.process({ message: "hello again" }, session());

    expect(first.error?.code).toBe(failure.code);
    expect(second.success).toBe(true);
    expect(second.data?.agentId).toBe(AGENT_IDS.general);
    expect(meta.calls()).toBe(0);
  });
});
