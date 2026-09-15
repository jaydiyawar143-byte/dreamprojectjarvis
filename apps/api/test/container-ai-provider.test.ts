// ---------------------------------------------------------------------------
// R-21 — the composition root with and without an OpenAI key.
//
// Before this, `getContainer()` constructed the chat OpenAIAdapter
// unconditionally and its constructor threw, so a server without the key never
// opened its port — health checks included. The rule that production REQUIRES
// the key lives in `checkProductionConfig`; this file covers what the container
// does once startup has allowed the process to continue.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIAdapter } from "@jarvis/ai-openai";
import { FallbackAIProvider } from "@jarvis/core";
import { getContainer, resetContainer } from "../src/services/container.js";

const JWT_SECRET = "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA";
const FAKE_KEY = "sk-test-r21-not-a-real-key";

let logged: string[];

function useEnvironment(openAIKey: string | undefined) {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("JWT_SECRET", JWT_SECRET);
  vi.stubEnv("BROWSER_ENABLED", "false");
  vi.stubEnv("OPENAI_API_KEY", openAIKey);
}

function generalAssistant() {
  const agent = getContainer().agentRegistry.get("conversational-assistant");
  expect(agent, "the general assistant should always be registered").toBeDefined();
  return agent!;
}

beforeEach(() => {
  resetContainer();
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("R-21 — no OpenAI key in development", () => {
  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["whitespace only", "   "],
  ])("builds the container when the key is %s", (_label, key) => {
    useEnvironment(key);

    expect(() => getContainer()).not.toThrow();
  });

  it.each([
    ["missing", undefined],
    ["whitespace only", "   "],
  ])("gives the assistant a provider that refuses with AI_PROVIDER_NOT_CONFIGURED when the key is %s", async (_label, key) => {
    useEnvironment(key);

    await expect(
      generalAssistant().process({ message: "hello", conversationHistory: [] })
    ).rejects.toMatchObject({ code: "AI_PROVIDER_NOT_CONFIGURED", statusCode: 503 });
  });

  it.each([
    ["missing", undefined],
    ["whitespace only", "   "],
  ])("keeps memory and knowledge retrieval switched off when the key is %s", (_label, key) => {
    useEnvironment(key);

    const container = getContainer();

    expect(container.memoryStore).toBeNull();
    expect(container.embeddingProvider).toBeNull();
    expect(container.memoryExtractor).toBeNull();
    expect(container.knowledgeRetriever).toBeNull();
  });

  it("says once at startup that chat is off, naming the variable", () => {
    useEnvironment(undefined);

    getContainer();

    const lines = logged.filter((line) => line.includes('"ai_provider_disabled"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "warn",
      event: "ai_provider_disabled",
      reason: "OPENAI_API_KEY is not set",
    });
  });
});

describe("R-21 — a key is set (behaviour unchanged)", () => {
  it("wires the real OpenAIAdapter, inside the provider chain, and the memory stack", () => {
    useEnvironment(FAKE_KEY);

    const provider = (generalAssistant() as unknown as { provider: unknown }).provider;
    const container = getContainer();

    // R-30 — one provider in the chain until a fallback is chosen (D-3).
    expect(provider).toBeInstanceOf(FallbackAIProvider);
    expect((provider as FallbackAIProvider).providers).toHaveLength(1);
    expect((provider as FallbackAIProvider).providers[0]).toBeInstanceOf(OpenAIAdapter);
    expect(container.memoryExtractor).not.toBeNull();
    expect(container.embeddingProvider).not.toBeNull();
  });

  it("does not log that chat is off", () => {
    useEnvironment(FAKE_KEY);

    getContainer();

    expect(logged.some((line) => line.includes('"ai_provider_disabled"'))).toBe(false);
  });
});
