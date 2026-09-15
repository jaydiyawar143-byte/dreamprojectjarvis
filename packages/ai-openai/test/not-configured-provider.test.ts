// R-21 — the chat provider used when the server has no OpenAI key.
//
// It exists so the API can start without the key in development. Every
// completion must fail with a code the chat route can turn into 503, and a
// message a user can act on that names neither the variable nor any key.
import { describe, it, expect } from "vitest";
import { JarvisError } from "@jarvis/core";

import { NotConfiguredAIProvider } from "../src/not-configured-provider.js";

async function completionFailure(provider: NotConfiguredAIProvider): Promise<unknown> {
  return provider.complete({ messages: [{ role: "user", content: "hello" }] }).then(
    () => null,
    (error: unknown) => error
  );
}

describe("R-21 — NotConfiguredAIProvider", () => {
  it("rejects a completion with AI_PROVIDER_NOT_CONFIGURED and HTTP 503", async () => {
    const failure = await completionFailure(new NotConfiguredAIProvider());

    expect(failure).toBeInstanceOf(JarvisError);
    expect((failure as JarvisError).code).toBe("AI_PROVIDER_NOT_CONFIGURED");
    expect((failure as JarvisError).statusCode).toBe(503);
  });

  it("tells the user what is missing and what fixes it, without naming the variable or a key", async () => {
    const { message } = (await completionFailure(new NotConfiguredAIProvider())) as JarvisError;

    expect(message).toMatch(/not configured/i);
    expect(message).toMatch(/OpenAI API key/i);
    expect(message).toMatch(/restart/i);
    expect(message).not.toContain("OPENAI_API_KEY");
    expect(message).not.toContain("sk-");
  });

  it("reports itself unavailable", async () => {
    await expect(new NotConfiguredAIProvider().isAvailable()).resolves.toBe(false);
  });

  it("lists no models", async () => {
    await expect(new NotConfiguredAIProvider().listModels()).resolves.toEqual([]);
  });
});
