import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  createN8nConfig,
  isN8nConfigured,
  validateWebhookPath,
  buildWebhookUrl,
  truncateSummary,
  N8N_MAX_SUMMARY_LENGTH,
} from "../src/config.js";
import {
  verifyCallbackSignature,
  signCallback,
  hashPayload,
  buildIdempotencyKey,
} from "../src/signature.js";
import { parseCallbackPayload, isCallbackFresh } from "../src/callback-parser.js";
import { classifyN8nError, classifyTransportError, redactSensitiveInfo } from "../src/error-handler.js";
import { N8nCloudProvider } from "../src/provider.js";
import { N8nRequestError, type N8nHttpClient } from "../src/client.js";

const API_KEY = "test-n8n-api-key";
const CALLBACK_SECRET = "test-callback-secret";

const config = createN8nConfig({
  baseUrl: "https://n8n.internal.test",
  apiKey: API_KEY,
  callbackSecret: CALLBACK_SECRET,
  timeoutMs: 1000,
});

describe("Sprint 5.4 — configuration and secret separation", () => {
  it("reports unconfigured until all three settings are present", () => {
    expect(isN8nConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isN8nConfigured({ N8N_BASE_URL: "http://x", N8N_API_KEY: "k" } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      isN8nConfigured({
        N8N_BASE_URL: "http://x",
        N8N_API_KEY: "k",
        N8N_CALLBACK_SECRET: "s",
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it("names missing fields WITHOUT echoing secret values", () => {
    try {
      createN8nConfig({ baseUrl: "https://n8n.test", apiKey: "SUPER-SECRET-KEY" });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/callbackSecret/);
      expect(msg).not.toContain("SUPER-SECRET-KEY");
    }
  });

  it("rejects a non-URL base", () => {
    expect(() =>
      createN8nConfig({ baseUrl: "not-a-url", apiKey: "k", callbackSecret: "s" })
    ).toThrow(/baseUrl/);
  });

  it("keeps the API key and the callback secret distinct", () => {
    // The two secrets authenticate opposite directions; a payload signed with
    // the outbound API key must NOT validate as an inbound callback.
    const body = JSON.stringify({ eventId: "e1" });
    const signedWithApiKey = signCallback(body, API_KEY);
    expect(verifyCallbackSignature(body, signedWithApiKey, CALLBACK_SECRET).valid).toBe(false);
  });
});

describe("Sprint 5.4 — webhook path validation (SSRF containment)", () => {
  it.each([["abc-123"], ["path/sub"], ["a.b_c~d"], ["/leading-slash"], ["trailing/"]])(
    "accepts %s",
    (good) => {
      expect(validateWebhookPath(good)).not.toBeNull();
    }
  );

  it.each([
    ["traversal", "../../admin"],
    ["scheme", "http://evil.test/x"],
    ["authority", "//evil.test/x"],
    ["colon", "a:b"],
    ["empty", ""],
    ["query", "path?x=1"],
    ["space", "a b"],
    ["too long", "a".repeat(201)],
  ])("REJECTS %s", (_label, bad) => {
    expect(validateWebhookPath(bad)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(validateWebhookPath(null)).toBeNull();
    expect(validateWebhookPath(42)).toBeNull();
  });

  it("builds a URL confined to the configured host", () => {
    expect(buildWebhookUrl(config, "abc-123")).toBe("https://n8n.internal.test/webhook/abc-123");
  });

  it("REFUSES to build a URL that would leave the configured host", () => {
    // A self-hosted n8n usually sits inside the same network, so escaping the
    // base URL would turn the trigger into an SSRF primitive.
    for (const bad of ["//evil.test/x", "http://evil.test", "../../etc/passwd"]) {
      expect(() => buildWebhookUrl(config, bad)).toThrow(/Invalid n8n webhook path/);
    }
  });
});

describe("Sprint 5.4 — callback signature verification", () => {
  const BODY = JSON.stringify({ eventId: "e1", executionId: "x1", status: "success" });

  it("accepts a correctly signed body", () => {
    expect(verifyCallbackSignature(BODY, signCallback(BODY, CALLBACK_SECRET), CALLBACK_SECRET).valid).toBe(true);
  });

  it("matches the digest an n8n workflow would compute", () => {
    const expected = createHmac("sha256", CALLBACK_SECRET).update(BODY).digest("hex");
    expect(signCallback(BODY, CALLBACK_SECRET)).toBe(`sha256=${expected}`);
  });

  it("REJECTS a wrong secret", () => {
    const result = verifyCallbackSignature(BODY, signCallback(BODY, "attacker"), CALLBACK_SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("MISMATCH");
  });

  it("REJECTS a tampered body under a captured signature", () => {
    const signature = signCallback(BODY, CALLBACK_SECRET);
    const tampered = JSON.stringify({ eventId: "e1", executionId: "OTHER", status: "success" });
    expect(verifyCallbackSignature(tampered, signature, CALLBACK_SECRET).valid).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyCallbackSignature(BODY, undefined, CALLBACK_SECRET).reason).toBe("MISSING_HEADER");
  });

  it.each([["abc"], ["sha1=abc"], ["sha256=short"], ["sha256=" + "z".repeat(64)]])(
    "rejects malformed header %s",
    (header) => {
      expect(verifyCallbackSignature(BODY, header, CALLBACK_SECRET).reason).toBe("MALFORMED_HEADER");
    }
  );

  it("does not throw on a length-mismatched digest", () => {
    expect(() => verifyCallbackSignature(BODY, "sha256=ab", CALLBACK_SECRET)).not.toThrow();
  });

  it("is byte-exact: a re-serialised body no longer validates", () => {
    const original = String.raw`{"eventId":"caf\u00e9"}`;
    const signature = signCallback(original, CALLBACK_SECRET);
    const reserialised = JSON.stringify(JSON.parse(original));
    expect(reserialised).not.toBe(original);
    expect(verifyCallbackSignature(original, signature, CALLBACK_SECRET).valid).toBe(true);
    expect(verifyCallbackSignature(reserialised, signature, CALLBACK_SECRET).valid).toBe(false);
  });
});

describe("Sprint 5.4 — idempotency key derivation", () => {
  it("is stable for an identical payload", () => {
    const a = hashPayload({ x: 1, y: 2 });
    const b = hashPayload({ x: 1, y: 2 });
    expect(a).toBe(b);
    expect(buildIdempotencyKey("u", "w", a)).toBe(buildIdempotencyKey("u", "w", b));
  });

  it("differs for a different payload, user, or workflow", () => {
    const h1 = hashPayload({ x: 1 });
    const h2 = hashPayload({ x: 2 });
    expect(h1).not.toBe(h2);
    expect(buildIdempotencyKey("u", "w", h1)).not.toBe(buildIdempotencyKey("u", "w", h2));
    expect(buildIdempotencyKey("u1", "w", h1)).not.toBe(buildIdempotencyKey("u2", "w", h1));
    expect(buildIdempotencyKey("u", "w1", h1)).not.toBe(buildIdempotencyKey("u", "w2", h1));
  });

  it("does not embed the payload in the key", () => {
    const key = buildIdempotencyKey("u", "w", hashPayload({ secret: "hunter2" }));
    expect(key).not.toContain("hunter2");
  });
});

describe("Sprint 5.4 — callback payload parsing", () => {
  const good = {
    eventId: "evt-1",
    executionId: "exec-1",
    status: "success",
    summary: "done",
    timestamp: new Date().toISOString(),
  };

  it("parses a well-formed success callback", () => {
    const result = parseCallbackPayload(good);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toMatchObject({
        eventId: "evt-1",
        executionId: "exec-1",
        status: "success",
        summary: "done",
      });
    }
  });

  it("parses an error callback", () => {
    const result = parseCallbackPayload({ ...good, status: "error", errorMessage: "boom" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.errorMessage).toBe("boom");
  });

  it.each([
    ["missing eventId", { ...good, eventId: undefined }, "MISSING_EVENT_ID"],
    ["missing executionId", { ...good, executionId: undefined }, "MISSING_EXECUTION_ID"],
    ["bad status", { ...good, status: "maybe" }, "INVALID_STATUS"],
    ["not an object", "a string", "MALFORMED"],
    ["array", [], "MALFORMED"],
    ["null", null, "MALFORMED"],
  ])("rejects %s", (_label, payload, reason) => {
    const result = parseCallbackPayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("rejects an over-long id rather than letting it reach an index", () => {
    const result = parseCallbackPayload({ ...good, eventId: "x".repeat(201) });
    expect(result.ok).toBe(false);
  });

  it("truncates an oversized summary", () => {
    const result = parseCallbackPayload({ ...good, summary: "x".repeat(N8N_MAX_SUMMARY_LENGTH + 500) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.summary!.length).toBeLessThanOrEqual(N8N_MAX_SUMMARY_LENGTH + 20);
      expect(result.event.summary).toMatch(/truncated/);
    }
  });

  describe("freshness window", () => {
    const now = new Date("2026-09-05T12:00:00Z");

    it("accepts a recent callback", () => {
      expect(isCallbackFresh(new Date(now.getTime() - 30_000), 300_000, now)).toBe(true);
    });

    it("REJECTS a replayed old callback even when correctly signed", () => {
      expect(isCallbackFresh(new Date(now.getTime() - 3_600_000), 300_000, now)).toBe(false);
    });

    it("tolerates clock skew but not an implausible future", () => {
      expect(isCallbackFresh(new Date(now.getTime() + 30_000), 300_000, now)).toBe(true);
      expect(isCallbackFresh(new Date(now.getTime() + 3_600_000), 300_000, now)).toBe(false);
    });
  });
});

describe("Sprint 5.4 — error classification", () => {
  it("treats auth failures as non-retryable with no side effect", () => {
    for (const status of [401, 403]) {
      const c = classifyN8nError(status, { message: "denied" });
      expect(c.retryable).toBe(false);
      expect(c.sideEffectPossible).toBe(false);
    }
  });

  it("explains a 404 as an inactive workflow", () => {
    expect(classifyN8nError(404, {}).message).toMatch(/not found or not active/);
  });

  it("marks a gateway timeout as POSSIBLY having side effects", () => {
    // The socket died, but the workflow behind it may still be running — so it
    // must never be auto-retried.
    const c = classifyN8nError(504, {});
    expect(c.code).toBe("TOOL_TIMEOUT");
    expect(c.sideEffectPossible).toBe(true);
    expect(c.retryable).toBe(false);
  });

  it("marks a 500 as a workflow failure that may have run", () => {
    const c = classifyN8nError(500, { message: "workflow error" });
    expect(c.code).toBe("WORKFLOW_FAILED");
    expect(c.sideEffectPossible).toBe(true);
  });

  it("allows retry only for rate limiting", () => {
    expect(classifyN8nError(429, {}).retryable).toBe(true);
    expect(classifyN8nError(429, {}).sideEffectPossible).toBe(false);
  });

  describe("transport failures", () => {
    it("an untransmitted request cannot have started a workflow", () => {
      const c = classifyTransportError(new Error("ECONNREFUSED"), false);
      expect(c.code).toBe("NETWORK_ERROR");
      expect(c.sideEffectPossible).toBe(false);
    });

    it("a transmitted request might have", () => {
      expect(classifyTransportError(new Error("socket hang up"), true).sideEffectPossible).toBe(true);
    });

    it("classifies an abort as a timeout", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      expect(classifyTransportError(err, true).code).toBe("TOOL_TIMEOUT");
    });
  });

  describe("redaction", () => {
    it("redacts API keys, bearer tokens and URL credentials", () => {
      expect(redactSensitiveInfo("x-n8n-api-key: secret123")).not.toContain("secret123");
      expect(redactSensitiveInfo("Authorization: Bearer abc.def")).not.toContain("abc.def");
      expect(redactSensitiveInfo("https://user:pass@n8n.test/webhook")).not.toContain("pass");
    });

    it("classification passes messages through the redactor", () => {
      const c = classifyN8nError(401, { message: "apiKey=leakedvalue rejected" });
      expect(c.message).not.toContain("leakedvalue");
    });
  });
});

describe("Sprint 5.4 — provider", () => {
  function makeHttp(status: number, body: unknown) {
    const calls: any[] = [];
    const client: N8nHttpClient & { calls: any[] } = {
      calls,
      async trigger(req) {
        calls.push(req);
        return { status, body };
      },
    } as any;
    return client;
  }

  const correlation = { executionId: "exec-1", traceId: "trace-1" };

  it("triggers a workflow and returns the remote execution id", async () => {
    const http = makeHttp(200, { executionId: "n8n-99" });
    const provider = new N8nCloudProvider({ config, httpClient: http });

    const result = await provider.triggerWorkflow("abc-123", { foo: "bar" }, correlation);

    expect(result.remoteExecutionId).toBe("n8n-99");
    expect(http.calls[0].webhookPath).toBe("abc-123");
  });

  it("passes correlation ids in BOTH body and headers", async () => {
    // A workflow author may read either when building the callback.
    const http = makeHttp(200, {});
    await new N8nCloudProvider({ config, httpClient: http }).triggerWorkflow(
      "abc",
      { foo: 1 },
      correlation
    );
    expect(http.calls[0].payload).toMatchObject({
      foo: 1,
      jarvisExecutionId: "exec-1",
      jarvisTraceId: "trace-1",
    });
    expect(http.calls[0].headers["X-Jarvis-Execution-Id"]).toBe("exec-1");
  });

  it("throws a classified error on a failure status", async () => {
    const provider = new N8nCloudProvider({
      config,
      httpClient: makeHttp(401, { message: "unauthorized" }),
    });
    await expect(provider.triggerWorkflow("abc", {}, correlation)).rejects.toThrow(N8nRequestError);
  });

  it("surfaces sideEffectPossible for a 5xx", async () => {
    const provider = new N8nCloudProvider({
      config,
      httpClient: makeHttp(500, { message: "workflow threw" }),
    });
    try {
      await provider.triggerWorkflow("abc", {}, correlation);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as N8nRequestError).classified.sideEffectPossible).toBe(true);
    }
  });

  it("bounds a large response before it can be persisted", async () => {
    const http = makeHttp(200, { blob: "x".repeat(N8N_MAX_SUMMARY_LENGTH * 2) });
    const result = await new N8nCloudProvider({ config, httpClient: http }).triggerWorkflow(
      "abc",
      {},
      correlation
    );
    expect(result.responseSummary!.length).toBeLessThan(N8N_MAX_SUMMARY_LENGTH + 50);
  });

  it("returns a null remote id when n8n reports none", async () => {
    const result = await new N8nCloudProvider({
      config,
      httpClient: makeHttp(200, { ok: true }),
    }).triggerWorkflow("abc", {}, correlation);
    expect(result.remoteExecutionId).toBeNull();
  });
});

describe("Sprint 5.4 — truncateSummary", () => {
  it("returns null for empty input", () => {
    expect(truncateSummary(null)).toBeNull();
    expect(truncateSummary(undefined)).toBeNull();
  });

  it("serialises objects and marks truncation", () => {
    expect(truncateSummary({ a: 1 })).toBe('{"a":1}');
    expect(truncateSummary("x".repeat(50), 10)).toMatch(/truncated/);
  });
});
