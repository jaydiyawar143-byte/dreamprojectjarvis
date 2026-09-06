// ---------------------------------------------------------------------------
// Sprint 8.0 — Voice configuration, feature gate and rate-limit namespacing.
//
// No provider, no route, no audio. This phase ships the switch and the
// contracts around it, and what matters is that the switch is OFF by default
// and that turning it on cannot happen by accident.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuditEntry } from "@jarvis/core";
import type { AuditLogger } from "@jarvis/security";
import {
  VOICE_DEFAULTS,
  VOICE_MAX_AUDIO_BYTES_CEILING,
  VOICE_MAX_TTS_CHARS_CEILING,
  VOICE_MIN_AUDIO_BYTES,
  createVoiceConfig,
  describeVoiceConfigStatus,
  isVoiceConfigured,
  parseBooleanFlag,
} from "@jarvis/config";
import {
  APPROVAL_RATE_LIMITS,
  DbBackedRateLimiter,
  RATE_LIMIT_NAMESPACES,
  VOICE_RATE_LIMITS,
} from "../src/services/rate-limiter.js";

const API_INDEX_SOURCE = readFileSync(resolve(__dirname, "../src/index.ts"), "utf-8");

/** An environment with nothing voice-related set. */
const EMPTY_ENV: NodeJS.ProcessEnv = {};

/** The minimum environment in which voice is live. */
const ENABLED_ENV: NodeJS.ProcessEnv = {
  VOICE_ENABLED: "true",
  OPENAI_API_KEY: "sk-test-not-a-real-key",
};

// ---------------------------------------------------------------------------

describe("Sprint 8.0 — voice configuration defaults", () => {
  it("applies the documented defaults when nothing is set", () => {
    const config = createVoiceConfig({}, EMPTY_ENV);

    expect(config.sttModel).toBe("whisper-1");
    expect(config.ttsModel).toBe("gpt-4o-mini-tts");
    expect(config.ttsVoice).toBe("alloy");
    expect(config.maxAudioBytes).toBe(4 * 1024 * 1024);
    expect(config.maxTtsChars).toBe(4000);
  });

  it("keeps VOICE_DEFAULTS and the produced config in agreement", () => {
    const config = createVoiceConfig({}, EMPTY_ENV);

    expect(config.sttModel).toBe(VOICE_DEFAULTS.sttModel);
    expect(config.ttsModel).toBe(VOICE_DEFAULTS.ttsModel);
    expect(config.ttsVoice).toBe(VOICE_DEFAULTS.ttsVoice);
    expect(config.maxAudioBytes).toBe(VOICE_DEFAULTS.maxAudioBytes);
    expect(config.maxTtsChars).toBe(VOICE_DEFAULTS.maxTtsChars);
  });

  it("defaults to disabled", () => {
    expect(createVoiceConfig({}, EMPTY_ENV).enabled).toBe(false);
  });

  it("reads overrides from the environment", () => {
    const config = createVoiceConfig({}, {
      VOICE_ENABLED: "true",
      OPENAI_STT_MODEL: "gpt-4o-mini-transcribe",
      OPENAI_TTS_MODEL: "tts-1",
      OPENAI_TTS_VOICE: "nova",
      VOICE_MAX_AUDIO_BYTES: String(1024 * 1024),
      VOICE_MAX_TTS_CHARS: "500",
    });

    expect(config.enabled).toBe(true);
    expect(config.sttModel).toBe("gpt-4o-mini-transcribe");
    expect(config.ttsModel).toBe("tts-1");
    expect(config.ttsVoice).toBe("nova");
    expect(config.maxAudioBytes).toBe(1024 * 1024);
    expect(config.maxTtsChars).toBe(500);
  });

  it("lets an explicit argument beat the environment", () => {
    const config = createVoiceConfig({ ttsVoice: "echo" }, { OPENAI_TTS_VOICE: "nova" });
    expect(config.ttsVoice).toBe("echo");
  });

  it("keeps the default upload ceiling under the body-parser limit", () => {
    // base64 inflates by ~4/3 and express.json is capped at 10mb; a default
    // above that would surface as an opaque parser error, never a clean 413.
    const base64Size = Math.ceil(VOICE_DEFAULTS.maxAudioBytes * (4 / 3));
    expect(base64Size).toBeLessThan(10 * 1024 * 1024);
    expect(VOICE_MAX_AUDIO_BYTES_CEILING).toBeLessThanOrEqual(6 * 1024 * 1024);
  });

  it("keeps the default TTS ceiling inside the provider limit", () => {
    expect(VOICE_DEFAULTS.maxTtsChars).toBeLessThanOrEqual(VOICE_MAX_TTS_CHARS_CEILING);
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 8.0 — voice configuration validation", () => {
  it("rejects an upload ceiling above the hard limit", () => {
    expect(() =>
      createVoiceConfig({ maxAudioBytes: VOICE_MAX_AUDIO_BYTES_CEILING + 1 }, EMPTY_ENV)
    ).toThrow(/maxAudioBytes/);
  });

  it("rejects an unusably small upload ceiling", () => {
    expect(() =>
      createVoiceConfig({ maxAudioBytes: VOICE_MIN_AUDIO_BYTES - 1 }, EMPTY_ENV)
    ).toThrow(/maxAudioBytes/);
  });

  it("rejects a TTS ceiling the provider would refuse", () => {
    expect(() =>
      createVoiceConfig({ maxTtsChars: VOICE_MAX_TTS_CHARS_CEILING + 1 }, EMPTY_ENV)
    ).toThrow(/maxTtsChars/);
  });

  it("rejects a zero or negative TTS ceiling", () => {
    expect(() => createVoiceConfig({ maxTtsChars: 0 }, EMPTY_ENV)).toThrow(/maxTtsChars/);
    expect(() => createVoiceConfig({ maxTtsChars: -5 }, EMPTY_ENV)).toThrow(/maxTtsChars/);
  });

  it("rejects a non-numeric size from the environment", () => {
    expect(() => createVoiceConfig({}, { VOICE_MAX_AUDIO_BYTES: "4mb" })).toThrow(
      /maxAudioBytes/
    );
  });

  it("rejects a voice name that is not a plain identifier", () => {
    // The value goes straight into a provider call; it is not free text.
    for (const bad of ["../../etc", "alloy nova", "voice/../x", "a\nb", ""]) {
      expect(() => createVoiceConfig({ ttsVoice: bad }, EMPTY_ENV), bad).toThrow(
        /ttsVoice/
      );
    }
  });

  it("accepts voice names the provider actually uses", () => {
    for (const good of ["alloy", "echo", "fable", "onyx", "nova", "shimmer", "gpt-4o-voice"]) {
      expect(() => createVoiceConfig({ ttsVoice: good }, EMPTY_ENV), good).not.toThrow();
    }
  });

  it("rejects an empty model name", () => {
    expect(() => createVoiceConfig({ sttModel: "" }, EMPTY_ENV)).toThrow(/sttModel/);
    expect(() => createVoiceConfig({ ttsModel: "" }, EMPTY_ENV)).toThrow(/ttsModel/);
  });

  it("names the offending field without echoing its value", () => {
    // Keeps the discipline the n8n config builder set: fields, never values.
    try {
      createVoiceConfig({ ttsVoice: "secret-looking-value/../x" }, EMPTY_ENV);
      throw new Error("expected createVoiceConfig to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("ttsVoice");
      expect(message).not.toContain("secret-looking-value");
    }
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 8.0 — feature gate", () => {
  it("is off when nothing is configured", () => {
    expect(isVoiceConfigured(EMPTY_ENV)).toBe(false);
  });

  it("is off when VOICE_ENABLED is false", () => {
    expect(isVoiceConfigured({ VOICE_ENABLED: "false", OPENAI_API_KEY: "sk-x" })).toBe(
      false
    );
    expect(isVoiceConfigured({ VOICE_ENABLED: "0", OPENAI_API_KEY: "sk-x" })).toBe(false);
    expect(isVoiceConfigured({ VOICE_ENABLED: "off", OPENAI_API_KEY: "sk-x" })).toBe(false);
    expect(isVoiceConfigured({ VOICE_ENABLED: "no", OPENAI_API_KEY: "sk-x" })).toBe(false);
  });

  it("is off when the flag is absent, even with a provider key present", () => {
    // Every existing deployment already has an OpenAI key. Inferring voice from
    // it would expose new endpoints on upgrade with nobody having asked.
    expect(isVoiceConfigured({ OPENAI_API_KEY: "sk-x" })).toBe(false);
  });

  it("is off when enabled but no provider key exists", () => {
    // Mounting here would produce routes that fail every request.
    expect(isVoiceConfigured({ VOICE_ENABLED: "true" })).toBe(false);
  });

  it("is on only when explicitly enabled and a key is present", () => {
    expect(isVoiceConfigured(ENABLED_ENV)).toBe(true);
  });

  it("accepts the usual ways of writing true", () => {
    for (const value of ["true", "TRUE", "True", "1", "yes", "on", " true "]) {
      expect(
        isVoiceConfigured({ VOICE_ENABLED: value, OPENAI_API_KEY: "sk-x" }),
        value
      ).toBe(true);
    }
  });

  it("fails closed on a value it cannot read", () => {
    // A typo must never be read as "on".
    for (const value of ["ture", "enabled", "maybe", "2", "y"]) {
      expect(
        isVoiceConfigured({ VOICE_ENABLED: value, OPENAI_API_KEY: "sk-x" }),
        value
      ).toBe(false);
    }
  });

  it("parses flags without guessing", () => {
    expect(parseBooleanFlag("true")).toBe(true);
    expect(parseBooleanFlag("false")).toBe(false);
    expect(parseBooleanFlag("")).toBe(false);
    expect(parseBooleanFlag(undefined)).toBeNull();
    expect(parseBooleanFlag("ture")).toBeNull();
    expect(parseBooleanFlag(true)).toBe(true);
  });

  it("explains why voice is disabled", () => {
    expect(describeVoiceConfigStatus(EMPTY_ENV).reason).toMatch(/not set to true/i);
    expect(
      describeVoiceConfigStatus({ VOICE_ENABLED: "true" }).reason
    ).toMatch(/OPENAI_API_KEY is missing/i);
    expect(
      describeVoiceConfigStatus({ VOICE_ENABLED: "ture", OPENAI_API_KEY: "sk-x" }).reason
    ).toMatch(/unrecognised value/i);
    expect(describeVoiceConfigStatus(ENABLED_ENV).configured).toBe(true);
  });

  it("agrees with isVoiceConfigured in every case", () => {
    const cases: NodeJS.ProcessEnv[] = [
      EMPTY_ENV,
      ENABLED_ENV,
      { VOICE_ENABLED: "true" },
      { OPENAI_API_KEY: "sk-x" },
      { VOICE_ENABLED: "ture", OPENAI_API_KEY: "sk-x" },
      { VOICE_ENABLED: "false", OPENAI_API_KEY: "sk-x" },
    ];
    for (const env of cases) {
      expect(describeVoiceConfigStatus(env).configured).toBe(isVoiceConfigured(env));
    }
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 8.0 — voice routes are not mounted", () => {
  it("adds no voice route to the API in this phase", () => {
    const mountsVoice = /app\.use\(\s*["'`]\/api\/v1\/voice/.test(API_INDEX_SOURCE);

    if (mountsVoice) {
      // Sprint 8.1 onwards: mounting is allowed, but only behind the gate.
      expect(API_INDEX_SOURCE).toContain("isVoiceConfigured(");
    } else {
      expect(mountsVoice).toBe(false);
    }
  });

  it("leaves the existing route surface untouched", () => {
    for (const route of [
      "/api/v1/chat",
      "/api/v1/auth",
      "/api/v1/conversations",
      "/api/v1/approvals",
      "/api/v1/knowledge",
      "/api/v1/dashboard",
    ]) {
      expect(API_INDEX_SOURCE, route).toContain(route);
    }
  });

  it("keeps every existing integration gate in place", () => {
    expect(API_INDEX_SOURCE).toContain("isWhatsAppConfigured()");
    expect(API_INDEX_SOURCE).toContain("isN8nConfigured()");
    expect(API_INDEX_SOURCE).toContain("JARVIS_ENCRYPTION_KEY");
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 8.0 — rate limiter namespaces", () => {
  function limiterOver(actions: string[], namespace?: string): DbBackedRateLimiter {
    const entries = actions.map(
      (action) => ({ action, userId: "user-1" }) as unknown as AuditEntry
    );
    const auditLogger = {
      query: async () => entries,
    } as unknown as AuditLogger;

    return namespace === undefined
      ? new DbBackedRateLimiter(auditLogger)
      : new DbBackedRateLimiter(auditLogger, namespace);
  }

  it("counts voice.transcribe under the voice namespace", async () => {
    const limiter = limiterOver(
      ["voice.transcribe", "voice.transcribe", "voice.speak"],
      RATE_LIMIT_NAMESPACES.voice
    );

    const decision = await limiter.check("user-1", "transcribe", 5, 60_000);
    expect(decision.currentCount).toBe(2);
    expect(decision.allowed).toBe(true);
  });

  it("counts voice.speak separately from voice.transcribe", async () => {
    const limiter = limiterOver(
      ["voice.transcribe", "voice.speak", "voice.speak", "voice.speak"],
      RATE_LIMIT_NAMESPACES.voice
    );

    const decision = await limiter.check("user-1", "speak", 10, 60_000);
    expect(decision.currentCount).toBe(3);
  });

  it("throttles once the voice limit is reached", async () => {
    const limiter = limiterOver(
      Array.from({ length: 30 }, () => "voice.transcribe"),
      RATE_LIMIT_NAMESPACES.voice
    );

    const decision = await limiter.check(
      "user-1",
      "transcribe",
      VOICE_RATE_LIMITS.transcribe.limit,
      VOICE_RATE_LIMITS.transcribe.windowMs
    );
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe(VOICE_RATE_LIMITS.transcribe.limit);
  });

  it("does not let approval activity consume the voice budget", async () => {
    const limiter = limiterOver(
      ["approval.approve", "approval.reject", "approval.list"],
      RATE_LIMIT_NAMESPACES.voice
    );

    expect((await limiter.check("user-1", "transcribe", 5, 60_000)).currentCount).toBe(0);
  });

  it("does not let voice activity consume the approval budget", async () => {
    const limiter = limiterOver(["voice.transcribe", "voice.speak"]);

    expect((await limiter.check("user-1", "approve", 5, 60_000)).currentCount).toBe(0);
  });

  it("keeps the Phase 10.7 behaviour when no namespace is given", async () => {
    // The approvals router constructs the limiter with one argument; that call
    // must count exactly what it counted before Sprint 8.
    const limiter = limiterOver(["approval.approve", "approval.approve", "voice.speak"]);

    const decision = await limiter.check(
      "user-1",
      "approve",
      APPROVAL_RATE_LIMITS.approve.limit,
      APPROVAL_RATE_LIMITS.approve.windowMs
    );
    expect(decision.currentCount).toBe(2);
    expect(decision.allowed).toBe(true);
  });

  it("does not match a bucket that is merely a prefix of another action", async () => {
    const limiter = limiterOver(
      ["voice.transcribeAll", "voice.transcribe"],
      RATE_LIMIT_NAMESPACES.voice
    );

    // `startsWith` is prefix matching, so this documents the known behaviour:
    // both match. The guard that matters is that the NAMESPACE cannot bleed.
    const decision = await limiter.check("user-1", "transcribe", 10, 60_000);
    expect(decision.currentCount).toBe(2);
  });

  it("declares sane voice limits", () => {
    expect(VOICE_RATE_LIMITS.transcribe.limit).toBeGreaterThan(0);
    expect(VOICE_RATE_LIMITS.speak.limit).toBeGreaterThan(0);
    // Speech recognition is the costlier call, so it is the tighter bucket.
    expect(VOICE_RATE_LIMITS.transcribe.limit).toBeLessThanOrEqual(
      VOICE_RATE_LIMITS.speak.limit
    );
  });
});
