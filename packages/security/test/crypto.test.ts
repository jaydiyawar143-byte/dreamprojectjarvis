import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  EncryptionService,
  EncryptionError,
  parseKey,
  generateKey,
  safeEqual,
} from "../src/crypto.js";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

function svc(keys = [parseKey(1, KEY_A)], active?: number) {
  return new EncryptionService(keys, active);
}

describe("Sprint 5.2 — EncryptionService", () => {
  describe("round trip", () => {
    it("decrypts what it encrypted", () => {
      const s = svc();
      const secret = "1//0abcdefghijklmnop-refresh-token";
      expect(s.decrypt(s.encrypt(secret))).toBe(secret);
    });

    it("handles unicode and empty strings", () => {
      const s = svc();
      for (const value of ["", "ünïcødé — ✓", "a".repeat(5000)]) {
        expect(s.decrypt(s.encrypt(value))).toBe(value);
      }
    });

    it("produces a different ciphertext each time (random IV)", () => {
      const s = svc();
      const a = s.encrypt("same-plaintext");
      const b = s.encrypt("same-plaintext");
      expect(a).not.toBe(b);
      // ...but both still decrypt correctly.
      expect(s.decrypt(a)).toBe("same-plaintext");
      expect(s.decrypt(b)).toBe("same-plaintext");
    });

    it("never emits the plaintext inside the envelope", () => {
      const s = svc();
      const envelope = s.encrypt("SUPER_SECRET_VALUE");
      expect(envelope).not.toContain("SUPER_SECRET_VALUE");
      expect(envelope.startsWith("v1:")).toBe(true);
      expect(envelope.split(":")).toHaveLength(4);
    });
  });

  describe("authentication (GCM)", () => {
    it("rejects a tampered ciphertext instead of returning garbage", () => {
      const s = svc();
      const parts = s.encrypt("balance=100").split(":");
      // Flip a byte in the ciphertext segment.
      const ct = Buffer.from(parts[3], "base64url");
      ct[0] ^= 0xff;
      parts[3] = ct.toString("base64url");

      expect(() => s.decrypt(parts.join(":"))).toThrow(EncryptionError);
      try {
        s.decrypt(parts.join(":"));
      } catch (e) {
        expect((e as EncryptionError).code).toBe("DECRYPTION_FAILED");
      }
    });

    it("rejects a tampered auth tag", () => {
      const s = svc();
      const parts = s.encrypt("value").split(":");
      const tag = Buffer.from(parts[2], "base64url");
      tag[0] ^= 0xff;
      parts[2] = tag.toString("base64url");
      expect(() => s.decrypt(parts.join(":"))).toThrow(/authentication/i);
    });

    it("cannot decrypt with the wrong key", () => {
      const a = svc([parseKey(1, KEY_A)]);
      const b = svc([parseKey(1, KEY_B)]);
      expect(() => b.decrypt(a.encrypt("secret"))).toThrow(EncryptionError);
    });
  });

  describe("malformed input", () => {
    it.each([
      ["not-an-envelope"],
      ["v1:only:three"],
      ["v1:a:b:c:d:e"],
      ["x1:aaaa:bbbb:cccc"],
      [""],
    ])("rejects %s", (bad) => {
      expect(() => svc().decrypt(bad)).toThrow(EncryptionError);
    });

    it("rejects a truncated IV", () => {
      const s = svc();
      const parts = s.encrypt("v").split(":");
      parts[1] = Buffer.from("short").toString("base64url");
      expect(() => s.decrypt(parts.join(":"))).toThrow(/Malformed/);
    });
  });

  describe("key management and rotation", () => {
    it("rejects keys that are not 32 bytes", () => {
      expect(() => parseKey(1, Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    });

    it("rejects a non-positive key version", () => {
      expect(() => parseKey(0, KEY_A)).toThrow(/positive integer/);
    });

    it("generateKey produces a usable 32-byte key", () => {
      const k = generateKey();
      expect(Buffer.from(k, "base64")).toHaveLength(32);
      expect(() => parseKey(1, k)).not.toThrow();
    });

    it("decrypts data written under a retired key", () => {
      const old = svc([parseKey(1, KEY_A)]);
      const envelope = old.encrypt("written-under-v1");

      // v2 is active, v1 retained for reads.
      const rotated = svc([parseKey(1, KEY_A), parseKey(2, KEY_B)], 2);
      expect(rotated.decrypt(envelope)).toBe("written-under-v1");
      // New writes use v2.
      expect(rotated.encrypt("x").startsWith("v2:")).toBe(true);
      expect(rotated.keyVersion).toBe(2);
    });

    it("flags retired-key envelopes as needing rotation", () => {
      const old = svc([parseKey(1, KEY_A)]);
      const envelope = old.encrypt("x");
      const rotated = svc([parseKey(1, KEY_A), parseKey(2, KEY_B)], 2);
      expect(rotated.needsRotation(envelope)).toBe(true);
      expect(rotated.needsRotation(rotated.encrypt("y"))).toBe(false);
    });

    it("fails loudly when the key version is unknown", () => {
      const envelope = svc([parseKey(9, KEY_A)]).encrypt("x");
      try {
        svc([parseKey(1, KEY_B)]).decrypt(envelope);
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as EncryptionError).code).toBe("UNKNOWN_KEY_VERSION");
      }
    });

    it("requires at least one key", () => {
      expect(() => new EncryptionService([])).toThrow(/At least one/);
    });

    it("rejects an active version missing from the keyring", () => {
      expect(() => svc([parseKey(1, KEY_A)], 7)).toThrow(/not present/);
    });
  });

  describe("fromEnv", () => {
    it("throws when the key is absent rather than degrading to plaintext", () => {
      expect(() => EncryptionService.fromEnv({} as NodeJS.ProcessEnv)).toThrow(
        /JARVIS_ENCRYPTION_KEY is required/
      );
    });

    it("builds from the active key", () => {
      const s = EncryptionService.fromEnv({
        JARVIS_ENCRYPTION_KEY: KEY_A,
      } as NodeJS.ProcessEnv);
      expect(s.keyVersion).toBe(1);
      expect(s.decrypt(s.encrypt("ok"))).toBe("ok");
    });

    it("loads retired keys so old rows stay readable", () => {
      const v1 = svc([parseKey(1, KEY_A)]);
      const envelope = v1.encrypt("old-row");

      const s = EncryptionService.fromEnv({
        JARVIS_ENCRYPTION_KEY: KEY_B,
        JARVIS_ENCRYPTION_KEY_VERSION: "2",
        JARVIS_ENCRYPTION_KEY_RETIRED: `1:${KEY_A}`,
      } as unknown as NodeJS.ProcessEnv);

      expect(s.keyVersion).toBe(2);
      expect(s.decrypt(envelope)).toBe("old-row");
    });

    it("rejects a malformed retired-key entry", () => {
      expect(() =>
        EncryptionService.fromEnv({
          JARVIS_ENCRYPTION_KEY: KEY_A,
          JARVIS_ENCRYPTION_KEY_RETIRED: "no-colon-here",
        } as unknown as NodeJS.ProcessEnv)
      ).toThrow(/version:base64/);
    });
  });

  describe("safeEqual", () => {
    it("matches identical strings and rejects others", () => {
      expect(safeEqual("abc", "abc")).toBe(true);
      expect(safeEqual("abc", "abd")).toBe(false);
      expect(safeEqual("abc", "abcd")).toBe(false);
      expect(safeEqual("", "")).toBe(true);
    });
  });
});
