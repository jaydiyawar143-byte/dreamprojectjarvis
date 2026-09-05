import { describe, it, expect } from "vitest";
import { WhatsAppCloudProvider } from "../src/provider.js";
import { createWhatsAppConfig, WHATSAPP_MAX_TEXT_LENGTH } from "../src/config.js";
import { classifyWhatsAppError, redactSensitiveInfo, maskPhoneNumber } from "../src/error-handler.js";
import { parseWebhookPayload, parseTimestamp, isFresh } from "../src/webhook-parser.js";
import type { WhatsAppHttpClient } from "../src/client.js";

const config = createWhatsAppConfig({
  phoneNumberId: "109876543210",
  accessToken: "EAAtest-access-token",
  appSecret: "test-app-secret",
  verifyToken: "test-verify-token",
  timeoutMs: 1000,
});

function makeHttp(status: number, body: unknown): WhatsAppHttpClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      return { status, body };
    },
  } as any;
}

const SEND_OK = { messages: [{ id: "wamid.HBgLMTU1NTAxMDEyMzQV" }] };

describe("Sprint 5.3 — outbound send", () => {
  it("sends a text message and returns the provider message id", async () => {
    const http = makeHttp(200, SEND_OK);
    const provider = new WhatsAppCloudProvider({ config, httpClient: http });

    const result = await provider.sendText("+1 (555) 010-1234", "Hello from JARVIS");

    expect(result.providerMessageId).toBe("wamid.HBgLMTU1NTAxMDEyMzQV");
    expect(result.to).toBe("15550101234");
  });

  it("posts to the configured phone number id with the Cloud API envelope", async () => {
    const http = makeHttp(200, SEND_OK);
    await new WhatsAppCloudProvider({ config, httpClient: http }).sendText("15550101234", "hi");

    const call = http.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("109876543210/messages");
    expect(call.body).toMatchObject({
      messaging_product: "whatsapp",
      to: "15550101234",
      type: "text",
    });
  });

  it("disables link previews so the API never fetches URLs from message text", async () => {
    const http = makeHttp(200, SEND_OK);
    await new WhatsAppCloudProvider({ config, httpClient: http }).sendText(
      "15550101234",
      "see https://example.com"
    );
    expect(http.calls[0].body.text.preview_url).toBe(false);
  });

  it("normalises the recipient before sending", async () => {
    const http = makeHttp(200, SEND_OK);
    await new WhatsAppCloudProvider({ config, httpClient: http }).sendText(
      "+91-98765-43210",
      "hi"
    );
    expect(http.calls[0].body.to).toBe("919876543210");
  });

  describe("input validation happens before any network call", () => {
    it.each([["12345"], [""], ["not-a-number"]])("rejects recipient %s", async (bad) => {
      const http = makeHttp(200, SEND_OK);
      const provider = new WhatsAppCloudProvider({ config, httpClient: http });
      await expect(provider.sendText(bad, "hi")).rejects.toThrow(/recipient/i);
      expect(http.calls).toHaveLength(0);
    });

    it("rejects an empty body", async () => {
      const http = makeHttp(200, SEND_OK);
      const provider = new WhatsAppCloudProvider({ config, httpClient: http });
      await expect(provider.sendText("15550101234", "   ")).rejects.toThrow(/empty/i);
      expect(http.calls).toHaveLength(0);
    });

    it("rejects a body over the API limit", async () => {
      const http = makeHttp(200, SEND_OK);
      const provider = new WhatsAppCloudProvider({ config, httpClient: http });
      await expect(
        provider.sendText("15550101234", "x".repeat(WHATSAPP_MAX_TEXT_LENGTH + 1))
      ).rejects.toThrow(/exceeds/i);
      expect(http.calls).toHaveLength(0);
    });
  });

  describe("provider failures", () => {
    it.each([
      [401, { error: { code: 190, message: "Invalid OAuth access token" } }, /invalid oauth/i],
      [403, { error: { code: 200, message: "Permission denied" } }, /permission/i],
      [429, { error: { code: 80007, message: "Rate limit hit" } }, /rate limit/i],
      [500, { error: { code: 2, message: "Temporary outage" } }, /outage/i],
      [400, { error: { code: 131047, message: "Re-engagement message" } }, /re-engagement/i],
    ])("maps HTTP %i to a thrown JarvisError", async (status, body, match) => {
      const provider = new WhatsAppCloudProvider({
        config,
        httpClient: makeHttp(status as number, body),
      });
      await expect(provider.sendText("15550101234", "hi")).rejects.toThrow(match as RegExp);
    });

    it("throws when a 200 carries no message id", async () => {
      const provider = new WhatsAppCloudProvider({ config, httpClient: makeHttp(200, {}) });
      await expect(provider.sendText("15550101234", "hi")).rejects.toThrow(/no message id/i);
    });

    it("treats a 200 containing an error object as a failure", async () => {
      const provider = new WhatsAppCloudProvider({
        config,
        httpClient: makeHttp(200, { error: { code: 131026, message: "Undeliverable" } }),
      });
      await expect(provider.sendText("15550101234", "hi")).rejects.toThrow(/undeliverable/i);
    });
  });
});

describe("Sprint 5.3 — error classification", () => {
  it("marks quota and outages retryable, auth failures not", () => {
    expect(classifyWhatsAppError(429, {}).retryable).toBe(true);
    expect(classifyWhatsAppError(500, {}).retryable).toBe(true);
    expect(classifyWhatsAppError(401, {}).retryable).toBe(false);
    expect(classifyWhatsAppError(403, {}).retryable).toBe(false);
  });

  it("marks permanent send failures as non-retryable INVALID_REQUEST", () => {
    // Retrying 131047 wastes quota and can read as abuse to Meta.
    for (const code of [131047, 131026, 132000]) {
      const classified = classifyWhatsAppError(400, { error: { code, message: "nope" } });
      expect(classified.retryable).toBe(false);
      expect(classified.code).toBe("INVALID_REQUEST");
    }
  });

  it("maps token errors to AUTHENTICATION_REQUIRED", () => {
    expect(classifyWhatsAppError(200, { error: { code: 190, message: "bad token" } }).code).toBe(
      "AUTHENTICATION_REQUIRED"
    );
  });

  it("redacts tokens from classified messages", () => {
    const classified = classifyWhatsAppError(401, {
      error: { code: 190, message: "token EAAsecretTokenValue123 is invalid" },
    });
    expect(classified.message).not.toContain("EAAsecretTokenValue123");
    expect(classified.message).toContain("[REDACTED_TOKEN]");
  });

  it("redacts named secrets and bearer headers", () => {
    expect(redactSensitiveInfo("Authorization: Bearer abc.def")).not.toContain("abc.def");
    expect(redactSensitiveInfo('app_secret="hunter2"')).not.toContain("hunter2");
    expect(redactSensitiveInfo('verify_token: my-token')).not.toContain("my-token");
  });

  it("masks phone numbers for logging", () => {
    expect(maskPhoneNumber("15550101234")).toBe("***1234");
    expect(maskPhoneNumber("12")).toBe("***");
  });
});

describe("Sprint 5.3 — webhook payload parsing", () => {
  const textPayload = (overrides: Record<string, unknown> = {}) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550009999", phone_number_id: "109876543210" },
              contacts: [{ profile: { name: "Alice" }, wa_id: "15550101234" }],
              messages: [
                {
                  from: "15550101234",
                  id: "wamid.TEST1",
                  timestamp: "1788000000",
                  type: "text",
                  text: { body: "Hello JARVIS" },
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  });

  it("parses a text message", () => {
    const event = parseWebhookPayload(textPayload());
    expect(event.messages).toHaveLength(1);
    expect(event.messages[0]).toMatchObject({
      providerMessageId: "wamid.TEST1",
      from: "15550101234",
      phoneNumberId: "109876543210",
      type: "TEXT",
      body: "Hello JARVIS",
      contactName: "Alice",
    });
  });

  it("converts the timestamp from SECONDS, not milliseconds", () => {
    // Reading seconds as milliseconds dates everything to 1970 and would
    // silently defeat the freshness window.
    const event = parseWebhookPayload(textPayload());
    expect(event.messages[0].timestamp.getTime()).toBe(1788000000 * 1000);
    expect(event.messages[0].timestamp.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("records an unknown type as UNSUPPORTED rather than dropping it", () => {
    const event = parseWebhookPayload(textPayload({ type: "reaction", text: undefined }));
    expect(event.messages[0].type).toBe("UNSUPPORTED");
    expect(event.messages[0].body).toBeNull();
  });

  it("extracts media captions and interactive replies", () => {
    const image = parseWebhookPayload(
      textPayload({ type: "image", text: undefined, image: { caption: "a photo" } })
    );
    expect(image.messages[0]).toMatchObject({ type: "IMAGE", body: "a photo" });

    const interactive = parseWebhookPayload(
      textPayload({
        type: "interactive",
        text: undefined,
        interactive: { button_reply: { title: "Yes" } },
      })
    );
    expect(interactive.messages[0]).toMatchObject({ type: "INTERACTIVE", body: "Yes" });
  });

  it("parses delivery statuses", () => {
    const event = parseWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "109876543210" },
                statuses: [
                  {
                    id: "wamid.OUT1",
                    status: "delivered",
                    timestamp: "1788000100",
                    recipient_id: "15550101234",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(event.statuses).toHaveLength(1);
    expect(event.statuses[0]).toMatchObject({
      providerMessageId: "wamid.OUT1",
      status: "delivered",
    });
  });

  describe("hostile and malformed input is skipped, never thrown", () => {
    it.each([
      ["null", null],
      ["empty object", {}],
      ["wrong product", { object: "instagram", entry: [{ changes: [] }] }],
      ["entry not an array", { object: "whatsapp_business_account", entry: "nope" }],
      ["missing metadata", { object: "whatsapp_business_account", entry: [{ changes: [{ value: {} }] }] }],
      ["null changes", { object: "whatsapp_business_account", entry: [{ changes: null }] }],
    ])("handles %s", (_label, payload) => {
      expect(() => parseWebhookPayload(payload)).not.toThrow();
      expect(parseWebhookPayload(payload).messages).toHaveLength(0);
    });

    it("skips a message with no id — there would be no dedup key", () => {
      const payload = textPayload();
      delete (payload.entry[0].changes[0].value.messages[0] as any).id;
      expect(parseWebhookPayload(payload).messages).toHaveLength(0);
    });

    it("skips a message with no sender", () => {
      const payload = textPayload();
      delete (payload.entry[0].changes[0].value.messages[0] as any).from;
      expect(parseWebhookPayload(payload).messages).toHaveLength(0);
    });
  });

  describe("freshness window", () => {
    const now = new Date("2026-09-05T12:00:00Z");

    it("accepts a recent event", () => {
      expect(isFresh(new Date(now.getTime() - 60_000), 300_000, now)).toBe(true);
    });

    it("REJECTS a replayed old event even with a valid signature", () => {
      expect(isFresh(new Date(now.getTime() - 3_600_000), 300_000, now)).toBe(false);
    });

    it("tolerates small clock skew from Meta", () => {
      expect(isFresh(new Date(now.getTime() + 30_000), 300_000, now)).toBe(true);
    });

    it("rejects an implausibly future timestamp", () => {
      expect(isFresh(new Date(now.getTime() + 3_600_000), 300_000, now)).toBe(false);
    });

    it("falls back to now for an unparseable timestamp", () => {
      const fallback = new Date("2026-01-01T00:00:00Z");
      expect(parseTimestamp("not-a-number", fallback)).toEqual(fallback);
      expect(parseTimestamp(undefined, fallback)).toEqual(fallback);
    });
  });
});
