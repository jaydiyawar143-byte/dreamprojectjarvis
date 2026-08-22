// PHASE 10.4 — AI provider cancellation (OpenAI adapter).
// The SDK is mocked; proves the caller's AbortSignal is forwarded into
// client.chat.completions.create() options and that aborting the signal
// surfaces as a rejected completion (never silently retried).
import { describe, it, expect, vi, beforeEach } from "vitest";

const createSpy = vi.fn();

vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: createSpy } };
    models = {
      list: async () => ({ data: [{ id: "gpt-4o" }] }),
    };
    constructor(_opts: unknown) {}
  }
  return { default: FakeOpenAI };
});

const { OpenAIAdapter } = await import("../src/openai-adapter.js");

function okResponse() {
  return {
    id: "resp-1",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finish_reason: "stop",
      },
    ],
  };
}

beforeEach(() => {
  createSpy.mockReset();
});

describe("Phase 10.4 — AI provider cancellation", () => {
  it("forwards the caller's AbortSignal to the OpenAI SDK call", async () => {
    createSpy.mockResolvedValue(okResponse());
    const adapter = new OpenAIAdapter({ apiKey: "test-key" });
    const controller = new AbortController();
    await adapter.complete({
      messages: [{ role: "user", content: "hello" }],
      signal: controller.signal,
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    const options = createSpy.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborted signal rejects the completion (SDK abort propagates)", async () => {
    createSpy.mockImplementation(
      (_params: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new Error("Request was aborted."))
          );
        })
    );
    const adapter = new OpenAIAdapter({ apiKey: "test-key", maxRetries: 3 });
    const controller = new AbortController();
    const pending = adapter.complete({
      messages: [{ role: "user", content: "hello" }],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow();
  });

  it("completion without signal still works (backwards compatible)", async () => {
    createSpy.mockResolvedValue(okResponse());
    const adapter = new OpenAIAdapter({ apiKey: "test-key" });
    const res = await adapter.complete({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.message.content).toBe("hi");
    const options = createSpy.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(options.signal).toBeUndefined();
  });
});
