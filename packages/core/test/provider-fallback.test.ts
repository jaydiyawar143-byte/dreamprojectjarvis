// ---------------------------------------------------------------------------
// R-30 — an explicit, ordered chain of model providers.
//
// The chain tries its providers in the order it was given and nothing else:
//
//   success                          answered; later providers are not called
//   rejected key, no access,         the provider is skipped for a cooldown,
//   unknown model (permanent)        then probed by ONE request; the next
//                                    provider is tried now
//   open circuit, exhausted          the next provider is tried now; no cooldown
//   transient retries                (the adapter's own breaker handles health)
//   context length, invalid request  returned as-is; no other provider is tried
//   abort, unexpected error          returned as-is
//   nothing usable                   503 AI_PROVIDER_UNAVAILABLE, a fixed message
//                                    and the original code in `details.cause`
//
// Every provider is called at most once per request, so there is no loop.
// Time is injected; nothing here waits on a real cooldown.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import type { AICompletionRequest, AICompletionResponse, IAIProvider } from "../src/types/ai-provider.js";
import { JarvisError } from "../src/types/errors.js";
import {
  FallbackAIProvider,
  classifyProviderFailure,
  type ProviderChainEvent,
} from "../src/provider-fallback.js";

const FAKE_KEY = "sk-test-r30-not-a-real-key";

const reply = (from: string): AICompletionResponse => ({
  message: { role: "assistant", content: `answer from ${from}` },
  finishReason: "stop",
  model: `${from}-model`,
});

type Step = () => Promise<AICompletionResponse>;
const ok = (from: string): Step => async () => reply(from);
const fail = (error: unknown): Step => async () => {
  throw error;
};

/** A provider that plays its steps in order, then answers. */
class ScriptedProvider implements IAIProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly requests: AICompletionRequest[] = [];

  constructor(
    readonly id: string,
    private readonly steps: Step[] = []
  ) {
    this.name = `Provider ${id}`;
    this.defaultModel = `${id}-model`;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    const step = this.steps.shift() ?? ok(this.id);
    return step();
  }

  async listModels() {
    return [this.defaultModel];
  }

  async isAvailable() {
    return true;
  }
}

const rejectedKey = () => new JarvisError("AI_PROVIDER_AUTH_FAILED", "The AI provider rejected this server's API key.");
const unknownModel = () =>
  new JarvisError("INVALID_REQUEST", "The model `gpt-unknown` does not exist", { scope: "provider" });
const circuitOpen = () =>
  new JarvisError("AI_PROVIDER_UNAVAILABLE", "The AI service is temporarily unavailable.", { transient: true });
const overloaded = () =>
  new JarvisError(
    "INTERNAL_ERROR",
    `503 The server is overloaded at https://internal.provider.example/v1 using ${FAKE_KEY}`,
    { transient: true }
  );
const contextTooLong = () => new JarvisError("CONTEXT_LENGTH_EXCEEDED", "This conversation is too long for the AI model.");
const invalidRequest = () => new JarvisError("INVALID_REQUEST", "Invalid value for 'temperature'");
const notConfigured = () => new JarvisError("AI_PROVIDER_NOT_CONFIGURED", "AI chat is not configured on this server.");
const aborted = () => new JarvisError("INTERNAL_ERROR", "Request was aborted", { aborted: true });

const REQUEST: AICompletionRequest = { messages: [{ role: "user", content: "hello" }], model: "gpt-4o" };

function setup(providers: IAIProvider[], permanentCooldownMs = 1000) {
  let clock = 0;
  const events: ProviderChainEvent[] = [];
  const chain = new FallbackAIProvider(
    providers,
    { permanentCooldownMs },
    { now: () => clock, onEvent: (event) => events.push(event) }
  );
  return {
    chain,
    events,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function failureOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => null,
    (error: unknown) => error
  );
}

describe("R-30 — the success path is unchanged", () => {
  it("answers from the primary, passes the request through untouched, and never calls the fallback", async () => {
    const primary = new ScriptedProvider("primary");
    const fallback = new ScriptedProvider("fallback");
    const { chain } = setup([primary, fallback]);

    const response = await chain.complete(REQUEST);

    expect(response.message.content).toBe("answer from primary");
    expect(primary.requests).toEqual([REQUEST]);
    expect(fallback.requests).toHaveLength(0);
  });

  it("keeps the primary's identity and default model", () => {
    const { chain } = setup([new ScriptedProvider("primary"), new ScriptedProvider("fallback")]);

    expect(chain.id).toBe("primary");
    expect(chain.defaultModel).toBe("primary-model");
  });
});

describe("R-30 — a primary that fails permanently", () => {
  it.each([
    ["a rejected key", rejectedKey],
    ["an unknown model", unknownModel],
  ])("after %s, the fallback answers the same request with its own model", async (_label, makeFailure) => {
    const primary = new ScriptedProvider("primary", [fail(makeFailure())]);
    const fallback = new ScriptedProvider("fallback");
    const { chain } = setup([primary, fallback]);

    const response = await chain.complete(REQUEST);

    expect(response.message.content).toBe("answer from fallback");
    expect(fallback.requests[0]!.messages).toEqual(REQUEST.messages);
    // The primary's model id means nothing to another provider.
    expect(fallback.requests[0]!.model).toBeUndefined();
  });

  it("is skipped, without being called, until its cooldown ends", async () => {
    const primary = new ScriptedProvider("primary", [fail(rejectedKey())]);
    const fallback = new ScriptedProvider("fallback");
    const { chain, advance } = setup([primary, fallback]);

    await chain.complete(REQUEST);
    advance(999);
    const second = await chain.complete(REQUEST);

    expect(second.message.content).toBe("answer from fallback");
    expect(primary.requests).toHaveLength(1);
  });

  it("is probed by one request after the cooldown, and a successful probe restores it", async () => {
    const primary = new ScriptedProvider("primary", [fail(rejectedKey())]);
    const fallback = new ScriptedProvider("fallback");
    const { chain, advance, events } = setup([primary, fallback]);

    await chain.complete(REQUEST);
    advance(1000);
    const probe = await chain.complete(REQUEST);
    const after = await chain.complete(REQUEST);

    expect(probe.message.content).toBe("answer from primary");
    expect(after.message.content).toBe("answer from primary");
    expect(fallback.requests).toHaveLength(1);
    expect(events.map((e) => e.event)).toContain("provider_recovered");
  });

  it("is disabled for another full cooldown when the probe fails", async () => {
    const primary = new ScriptedProvider("primary", [fail(rejectedKey()), fail(rejectedKey())]);
    const fallback = new ScriptedProvider("fallback");
    const { chain, advance } = setup([primary, fallback]);

    await chain.complete(REQUEST);
    advance(1000);
    await chain.complete(REQUEST); // failed probe
    advance(999);
    await chain.complete(REQUEST);
    expect(primary.requests).toHaveLength(2);

    advance(1);
    const restored = await chain.complete(REQUEST);
    expect(restored.message.content).toBe("answer from primary");
    expect(primary.requests).toHaveLength(3);
  });

  it("is probed by only one request at a time", async () => {
    let finishProbe!: (response: AICompletionResponse) => void;
    const slowProbe: Step = () => new Promise((resolve) => (finishProbe = resolve));
    const primary = new ScriptedProvider("primary", [fail(rejectedKey()), slowProbe]);
    const fallback = new ScriptedProvider("fallback");
    const { chain, advance } = setup([primary, fallback]);

    await chain.complete(REQUEST);
    advance(1000);
    const probing = chain.complete(REQUEST);
    const during = await chain.complete(REQUEST);
    finishProbe(reply("primary"));

    expect(during.message.content).toBe("answer from fallback");
    expect((await probing).message.content).toBe("answer from primary");
    expect(primary.requests).toHaveLength(2);
  });
});

describe("R-30 — a primary that is unavailable for now", () => {
  it.each([
    ["an open circuit", circuitOpen],
    ["a transient failure its retries could not clear", overloaded],
  ])("after %s, the fallback answers, and the primary is tried again on the next request", async (_label, makeFailure) => {
    const primary = new ScriptedProvider("primary", [fail(makeFailure())]);
    const fallback = new ScriptedProvider("fallback");
    const { chain } = setup([primary, fallback]);

    const first = await chain.complete(REQUEST);
    const second = await chain.complete(REQUEST);

    expect(first.message.content).toBe("answer from fallback");
    expect(second.message.content).toBe("answer from primary");
    expect(primary.requests).toHaveLength(2);
  });
});

describe("R-30 — no usable provider", () => {
  it("answers 503 AI_PROVIDER_UNAVAILABLE, explains recovery, and keeps the primary's code as the cause", async () => {
    const primary = new ScriptedProvider("primary", [fail(rejectedKey())]);
    const fallback = new ScriptedProvider("fallback", [fail(overloaded())]);
    const { chain } = setup([primary, fallback]);

    const error = (await failureOf(chain.complete(REQUEST))) as JarvisError;

    expect(error).toBeInstanceOf(JarvisError);
    expect(error.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(error.statusCode).toBe(503);
    expect(error.details).toEqual({ transient: true, cause: "AI_PROVIDER_AUTH_FAILED" });
    expect(error.message).toMatch(/temporarily unavailable/i);
    expect(error.message).toMatch(/recover/i);
  });

  it("with a single provider, keeps refusing without calling it during the cooldown", async () => {
    const only = new ScriptedProvider("only", [fail(rejectedKey())]);
    const { chain } = setup([only]);

    const first = (await failureOf(chain.complete(REQUEST))) as JarvisError;
    const second = (await failureOf(chain.complete(REQUEST))) as JarvisError;

    expect(first.details).toEqual({ transient: true, cause: "AI_PROVIDER_AUTH_FAILED" });
    expect(second.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(second.details).toEqual({ transient: true, cause: "AI_PROVIDER_AUTH_FAILED" });
    expect(only.requests).toHaveLength(1);
  });

  it("leaks no provider text, URL, key or stack", async () => {
    const primary = new ScriptedProvider("primary", [fail(overloaded())]);
    const fallback = new ScriptedProvider("fallback", [fail(overloaded())]);
    const { chain } = setup([primary, fallback]);

    const error = (await failureOf(chain.complete(REQUEST))) as JarvisError;
    const exposed = JSON.stringify({ code: error.code, message: error.message, details: error.details });

    expect(exposed).not.toContain(FAKE_KEY);
    expect(exposed).not.toContain("internal.provider.example");
    expect(exposed).not.toContain("overloaded");
    expect(exposed).not.toMatch(/\bat .+:\d+:\d+/);
    expect(Object.keys(error.details ?? {}).sort()).toEqual(["cause", "transient"]);
  });

  it("calls each provider at most once for one request", async () => {
    const primary = new ScriptedProvider("primary", [fail(overloaded()), fail(overloaded())]);
    const fallback = new ScriptedProvider("fallback", [fail(overloaded()), fail(overloaded())]);
    const { chain } = setup([primary, fallback]);

    await failureOf(chain.complete(REQUEST));

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
  });

  it("returns AI_PROVIDER_NOT_CONFIGURED unchanged when no provider is configured at all", async () => {
    const failure = notConfigured();
    const { chain } = setup([new ScriptedProvider("only", [fail(failure)])]);

    expect(await failureOf(chain.complete(REQUEST))).toBe(failure);
  });

  it("uses a configured fallback when the primary is not configured", async () => {
    const { chain } = setup([
      new ScriptedProvider("primary", [fail(notConfigured())]),
      new ScriptedProvider("fallback"),
    ]);

    expect((await chain.complete(REQUEST)).message.content).toBe("answer from fallback");
  });
});

describe("R-30 — failures that belong to the request, not the provider", () => {
  it.each([
    ["an exceeded context window", contextTooLong],
    ["an invalid request", invalidRequest],
    ["a cancelled request", aborted],
    ["an unexpected error", () => new TypeError("Cannot read properties of undefined")],
  ])("%s is returned as-is: no fallback, and the primary stays in use", async (_label, makeFailure) => {
    const failure = makeFailure();
    const primary = new ScriptedProvider("primary", [fail(failure)]);
    const fallback = new ScriptedProvider("fallback");
    const { chain } = setup([primary, fallback]);

    expect(await failureOf(chain.complete(REQUEST))).toBe(failure);
    const next = await chain.complete(REQUEST);

    expect(fallback.requests).toHaveLength(0);
    expect(next.message.content).toBe("answer from primary");
  });
});

describe("R-30 — observability", () => {
  it("reports events with a provider id and an error code, nothing else", async () => {
    const primary = new ScriptedProvider("primary", [fail(rejectedKey())]);
    const { chain, events } = setup([primary, new ScriptedProvider("fallback", [fail(overloaded())])]);

    await failureOf(chain.complete(REQUEST));

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(Object.keys(event).every((key) => ["event", "provider", "cause"].includes(key))).toBe(true);
      expect(JSON.stringify(event)).not.toContain(FAKE_KEY);
    }
    expect(events).toContainEqual({ event: "provider_failed_permanently", provider: "primary", cause: "AI_PROVIDER_AUTH_FAILED" });
    expect(events).toContainEqual({ event: "providers_exhausted", provider: "primary", cause: "AI_PROVIDER_AUTH_FAILED" });
  });
});

describe("R-30 — classifyProviderFailure", () => {
  it.each([
    [notConfigured(), "not_configured"],
    [aborted(), "aborted"],
    [circuitOpen(), "unavailable"],
    [overloaded(), "transient"],
    [new JarvisError("RATE_LIMITED", "Rate limit reached"), "transient"],
    [rejectedKey(), "permanent"],
    [new JarvisError("AUTHENTICATION_REQUIRED", "401"), "permanent"],
    [new JarvisError("AUTHORIZATION_FAILED", "403"), "permanent"],
    [unknownModel(), "permanent"],
    [contextTooLong(), "request"],
    [invalidRequest(), "request"],
    [new TypeError("boom"), "unexpected"],
    [new JarvisError("INTERNAL_ERROR", "no marker"), "unexpected"],
  ])("%s → %s", (failure, kind) => {
    expect(classifyProviderFailure(failure)).toBe(kind);
  });
});
