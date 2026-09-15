// ---------------------------------------------------------------------------
// R-21 / R-24 / R-25 / R-30 — an agent's status after a turn fails.
//
// The orchestrator never selects an agent whose status is "error", and nothing
// resets that status. So the status an agent takes after a failure decides
// whether it serves the next request or stays out of service until restart:
//
//   any classified provider failure   ready   the provider's health is tracked
//   (not configured, transient,               by the provider chain (R-30) and
//   rejected key, no access, unknown          the adapter's breaker (R-27), not
//   model, invalid request, context           by the agent
//   length, circuit open, abort)
//   anything else                     error   unchanged
//
// Before R-30 a rejected key, missing access or an invalid model marked the
// agent "error", which is how a plain request ended up with the Meta Ads agent.
//
// All three classes that call a provider are covered, because each has its own
// catch block. The failures are built the way the provider adapters build them.
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
  // R-27 / R-30 — the circuit is open, or no provider in the chain is usable.
  [
    "no provider is usable right now",
    () => new JarvisError("AI_PROVIDER_UNAVAILABLE", "The AI provider is temporarily unavailable.", { transient: true }),
  ],
  // R-25 — a property of one conversation, not of the agent.
  [
    "the conversation exceeds the model's context window",
    () => new JarvisError("CONTEXT_LENGTH_EXCEEDED", "This conversation is too long for the AI model."),
  ],
  // R-26 — the caller cancelled.
  ["the request was aborted", () => new JarvisError("INTERNAL_ERROR", "Request was aborted", { aborted: true })],
  // R-30 — permanent provider failures: the chain disables the provider for a
  // cooldown, and the agent stays in service.
  [
    "the provider rejects the server's API key",
    () => new JarvisError("AI_PROVIDER_AUTH_FAILED", "The AI provider rejected this server's API key."),
  ],
  ["an authentication failure is reported the older way", () => new JarvisError("AUTHENTICATION_REQUIRED", "401 Incorrect API key provided")],
  ["the key has no access", () => new JarvisError("AUTHORIZATION_FAILED", "403 Project does not have access")],
  [
    "the model is unknown",
    () => new JarvisError("INVALID_REQUEST", "404 The model does not exist", { scope: "provider" }),
  ],
  ["the request is invalid", () => new JarvisError("INVALID_REQUEST", "Invalid value for 'temperature'")],
];

const MARKS_ERROR: Array<[string, () => unknown]> = [
  ["an internal error carries no marker", () => new JarvisError("INTERNAL_ERROR", "upstream 500")],
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
