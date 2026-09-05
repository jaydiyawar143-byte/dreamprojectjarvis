import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyWebhookSignature,
  verifyWebhookChallenge,
  signPayload,
} from "../src/signature.js";
import {
  createWhatsAppConfig,
  isWhatsAppConfigured,
  normalizePhoneNumber,
} from "../src/config.js";

const APP_SECRET = "test-app-secret-value";
const OTHER_SECRET = "a-different-app-secret";
const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

describe("Sprint 5.3 — webhook signature verification", () => {
  describe("valid signatures", () => {
    it("accepts a correctly signed body", () => {
      expect(verifyWebhookSignature(BODY, signPayload(BODY, APP_SECRET), APP_SECRET).valid).toBe(
        true
      );
    });

    it("accepts a Buffer body identically to a string", () => {
      const buf = Buffer.from(BODY, "utf8");
      expect(verifyWebhookSignature(buf, signPayload(buf, APP_SECRET), APP_SECRET).valid).toBe(true);
    });

    it("accepts an uppercase hex digest", () => {
      const hex = createHmac("sha256", APP_SECRET).update(BODY).digest("hex").toUpperCase();
      expect(verifyWebhookSignature(BODY, `sha256=${hex}`, APP_SECRET).valid).toBe(true);
    });

    it("matches the digest Meta would compute", () => {
      const expected = createHmac("sha256", APP_SECRET).update(BODY).digest("hex");
      expect(signPayload(BODY, APP_SECRET)).toBe(`sha256=${expected}`);
    });
  });

  describe("invalid signatures", () => {
    it("REJECTS a body signed with a different secret", () => {
      const result = verifyWebhookSignature(BODY, signPayload(BODY, OTHER_SECRET), APP_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("MISMATCH");
    });

    it("REJECTS a tampered body under a valid-looking signature", () => {
      const signature = signPayload(BODY, APP_SECRET);
      const tampered = JSON.stringify({ object: "whatsapp_business_account", entry: [{ evil: 1 }] });
      expect(verifyWebhookSignature(tampered, signature, APP_SECRET).valid).toBe(false);
    });

    it("rejects a single-byte change", () => {
      const signature = signPayload(BODY, APP_SECRET);
      expect(verifyWebhookSignature(BODY + " ", signature, APP_SECRET).valid).toBe(false);
    });

    it("rejects a missing header", () => {
      expect(verifyWebhookSignature(BODY, undefined, APP_SECRET).reason).toBe("MISSING_HEADER");
      expect(verifyWebhookSignature(BODY, "", APP_SECRET).reason).toBe("MISSING_HEADER");
    });

    it.each([
      ["no prefix", "abc123"],
      ["wrong algorithm", "sha1=abc123"],
      ["short digest", "sha256=abcd"],
      ["non-hex digest", "sha256=" + "z".repeat(64)],
      ["prefix only", "sha256="],
    ])("rejects a malformed header (%s)", (_label, header) => {
      const result = verifyWebhookSignature(BODY, header, APP_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("MALFORMED_HEADER");
    });

    it("rejects an absent body rather than treating it as empty", () => {
      expect(verifyWebhookSignature(undefined, signPayload("", APP_SECRET), APP_SECRET).reason).toBe(
        "EMPTY_BODY"
      );
    });

    it("does not throw on a length-mismatched digest", () => {
      // timingSafeEqual throws when buffers differ in length; the shape check
      // must catch that first so a forged header cannot raise instead of fail.
      expect(() => verifyWebhookSignature(BODY, "sha256=ab", APP_SECRET)).not.toThrow();
    });
  });

  describe("byte-exactness", () => {
    it("fails when the body is re-serialised rather than passed raw", () => {
      // This is the bug the raw-body plumbing exists to prevent. Meta escapes
      // non-ASCII as a \u sequence; JSON.parse decodes it and JSON.stringify
      // re-emits the literal character, so the bytes — and the digest — change.
      const original = String.raw`{"text":"caf\u00e9"}`;
      const signature = signPayload(original, APP_SECRET);
      const reserialised = JSON.stringify(JSON.parse(original));

      expect(reserialised).not.toBe(original);
      expect(verifyWebhookSignature(original, signature, APP_SECRET).valid).toBe(true);
      expect(verifyWebhookSignature(reserialised, signature, APP_SECRET).valid).toBe(false);
    });

    it("preserves unicode exactly", () => {
      const body = JSON.stringify({ text: "héllo — 👋" });
      expect(verifyWebhookSignature(body, signPayload(body, APP_SECRET), APP_SECRET).valid).toBe(
        true
      );
    });
  });
});

describe("Sprint 5.3 — GET webhook verification handshake", () => {
  const TOKEN = "my-verify-token";

  it("echoes the challenge for a correct token", () => {
    const result = verifyWebhookChallenge(
      { "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "1158201444" },
      TOKEN
    );
    expect(result.ok).toBe(true);
    expect(result.challenge).toBe("1158201444");
  });

  it("REJECTS a wrong token", () => {
    expect(
      verifyWebhookChallenge(
        { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "c" },
        TOKEN
      ).ok
    ).toBe(false);
  });

  it("rejects a token that is a prefix of the real one", () => {
    expect(
      verifyWebhookChallenge(
        { "hub.mode": "subscribe", "hub.verify_token": TOKEN.slice(0, 5), "hub.challenge": "c" },
        TOKEN
      ).ok
    ).toBe(false);
  });

  it("rejects a non-subscribe mode", () => {
    expect(
      verifyWebhookChallenge(
        { "hub.mode": "unsubscribe", "hub.verify_token": TOKEN, "hub.challenge": "c" },
        TOKEN
      ).ok
    ).toBe(false);
  });

  it("rejects missing parameters", () => {
    expect(verifyWebhookChallenge({}, TOKEN).ok).toBe(false);
    expect(verifyWebhookChallenge({ "hub.mode": "subscribe" }, TOKEN).ok).toBe(false);
  });

  it("rejects non-string parameters", () => {
    expect(
      verifyWebhookChallenge(
        { "hub.mode": "subscribe", "hub.verify_token": 12345, "hub.challenge": "c" },
        TOKEN
      ).ok
    ).toBe(false);
  });

  it("never returns a challenge when verification fails", () => {
    const result = verifyWebhookChallenge(
      { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "secret" },
      TOKEN
    );
    expect(result.challenge).toBeUndefined();
  });
});

describe("Sprint 5.3 — config validation", () => {
  it("reports unconfigured when any secret is missing", () => {
    expect(isWhatsAppConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isWhatsAppConfigured({
        WHATSAPP_PHONE_NUMBER_ID: "1",
        WHATSAPP_ACCESS_TOKEN: "2",
        WHATSAPP_APP_SECRET: "3",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("reports configured only with all four secrets", () => {
    expect(
      isWhatsAppConfigured({
        WHATSAPP_PHONE_NUMBER_ID: "1",
        WHATSAPP_ACCESS_TOKEN: "2",
        WHATSAPP_APP_SECRET: "3",
        WHATSAPP_VERIFY_TOKEN: "4",
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it("names missing fields WITHOUT echoing secret values", () => {
    try {
      createWhatsAppConfig({ phoneNumberId: "12345", accessToken: "SUPER-SECRET-TOKEN" });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/appSecret|verifyToken/);
      expect(msg).not.toContain("SUPER-SECRET-TOKEN");
    }
  });

  it("applies safe defaults for version and freshness window", () => {
    const config = createWhatsAppConfig({
      phoneNumberId: "1",
      accessToken: "2",
      appSecret: "3",
      verifyToken: "4",
    });
    expect(config.apiVersion).toMatch(/^v\d+\.\d+$/);
    expect(config.maxEventAgeMs).toBeGreaterThan(0);
  });

  describe("normalizePhoneNumber", () => {
    it.each([
      ["+1 (555) 010-1234", "15550101234"],
      ["15550101234", "15550101234"],
      ["+91-98765-43210", "919876543210"],
    ])("normalises %s", (input, expected) => {
      expect(normalizePhoneNumber(input)).toBe(expected);
    });

    it.each([["12345"], [""], ["not-a-number"], ["1".repeat(16)], ["+1-555-CALL-NOW"]])(
      "rejects %s",
      (bad) => {
        expect(normalizePhoneNumber(bad)).toBeNull();
      }
    );
  });
});
