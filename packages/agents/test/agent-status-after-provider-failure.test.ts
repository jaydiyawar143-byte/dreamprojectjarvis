// ---------------------------------------------------------------------------
// R-21 / R-24 — an agent's status after a turn fails.
//
// The orchestrator never selects an agent whose status is "error", and nothing
// resets that status. So the status an agent takes after a failure decides
// whether it serves the next request or stays out of service until restart:
//
//   AI_PROVIDER_NOT_CONFIGURED   ready   R-21 — a deployment state; every request
//                                        gets the same 503
//   transient provider failure   ready   R-24 — timeout, rate limit, 5xx: the next
//                                        request may well succeed
//   permanent provider failure   error   invalid key, no access, bad model or
//                                        request — unchanged
//   anything else                error   unchanged
//
// All three classes that call a provider are covered, because each has its own
// catch block. The failures are built the way `@jarvis/ai-openai` builds them;
// apps/api/test/agent-recovery-after-provider-failure.test.ts proves that
// against the real SDK.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { IAgent, IAIProvider, AICompletionResponse } from "@jarvis/core";
import { JarvisError } from "@jarvis/core";

import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { CommunicationAgent } from "../src/agents/communication-agent.js";
import { MetaAdsAgent } from "../src/agents/meta-ads-agent.js";

function refusingProvider(failure: unknown): IAIProvider {
  return {
    id: "test-provider",
    name: "Test provider",
    defaultModel: "test-model",
    async complete(): Promise<AICompletionResponse> {
      throw failure;
    },
    async listModels() {
      return [];
    },
    async isAvailable() {
      return false;
    },
  };
}

const STAYS_READY: Array<[string, () => unknown]> = [
  [
    "the provider is not configured",
    () => new JarvisError("AI_PROVIDER_NOT_CONFIGURED", "AI chat is not configured on this server."),
  ],
  ["the provider rate-limits the request", () => new JarvisError("RATE_LIMITED", "Rate limit reached")],
  [
    "the provider times out",
    () => new JarvisError("INTERNAL_ERROR", "Request timed out.", { transient: true }),
  ],
  [
    "the provider answers with a temporary 5xx",
    () => new JarvisError("INTERNAL_ERROR", "503 The server is overloaded", { transient: true }),
  ],
  // R-27 — the adapter's circuit is open; the provider was not even called.
  [
    "the provider circuit is open",
    () => new JarvisError("AI_PROVIDER_UNAVAILABLE", "The AI service is temporarily unavailable.", { transient: true }),
  ],
  // R-25 — a property of one conversation, not of the agent.
  [
    "the conversation exceeds the model's context window",
    () => new JarvisError("CONTEXT_LENGTH_EXCEEDED", "This conversation is too long for the AI model."),
  ],
  // R-26 — the caller cancelled.
  ["the request was aborted", () => new JarvisError("INTERNAL_ERROR", "Request was aborted", { aborted: true })],
];

const MARKS_ERROR: Array<[string, () => unknown]> = [
  ["the API key is invalid", () => new JarvisError("AUTHENTICATION_REQUIRED", "401 Incorrect API key provided")],
  // R-29 — how `@jarvis/ai-openai` now reports a rejected key.
  [
    "the provider rejects the server's API key",
    () => new JarvisError("AI_PROVIDER_AUTH_FAILED", "The AI provider rejected this server's API key."),
  ],
  ["the key has no access", () => new JarvisError("AUTHORIZATION_FAILED", "403 Project does not have access")],
  ["the model or request is invalid", () => new JarvisError("INVALID_REQUEST", "404 The model does not exist")],
  ["an internal error carries no transient marker", () => new JarvisError("INTERNAL_ERROR", "upstream 500")],
  ["the failure is not a JarvisError at all", () => new TypeError("Cannot read properties of undefined")],
];

const AGENTS: Array<[string, (provider: IAIProvider) => IAgent]> = [
  ["ConversationalAssistant", (provider) => new ConversationalAssistant({ provider })],
  ["a DomainAgent (CommunicationAgent)", (provider) => new CommunicationAgent({ provider })],
  ["MetaAdsAgent", (provider) => new MetaAdsAgent({ provider })],
];

describe.each(AGENTS)("%s after a failed turn", (_name, build) => {
  it.each(STAYS_READY)("stays ready when %s", async (_label, makeFailure) => {
    const failure = makeFailure();
    const agent = build(refusingProvider(failure));

    await expect(agent.process({ message: "hello", conversationHistory: [] })).rejects.toBe(failure);
    expect(agent.getStatus()).toBe("ready");
  });

  it.each(MARKS_ERROR)("marks itself errored when %s", async (_label, makeFailure) => {
    const failure = makeFailure();
    const agent = build(refusingProvider(failure));

    await expect(agent.process({ message: "hello", conversationHistory: [] })).rejects.toBe(failure);
    expect(agent.getStatus()).toBe("error");
  });
});
