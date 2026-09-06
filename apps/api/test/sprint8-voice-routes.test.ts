// ---------------------------------------------------------------------------
// Sprint 8.1 / 8.2 — Voice route tests.
//
// The provider is a fake throughout: no OpenAI key, no network, no audio
// hardware. What is under test is the route's own behaviour — validation,
// limits, auditing, and the promise that a recording never becomes durable
// state anywhere.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Response } from "express";
import type { AuditEntry } from "@jarvis/core";
import { JarvisError } from "@jarvis/core";
import { createVoiceConfig } from "@jarvis/config";
import { createVoiceRouter } from "../src/routes/voice.js";
import { VOICE_RATE_LIMITS } from "../src/services/rate-limiter.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A valid, tiny base64 payload. Content is irrelevant to the fake provider. */
const SAMPLE_AUDIO = Buffer.from("fake-audio-bytes").toString("base64");

class FakeVoiceProvider {
  readonly id = "fake-voice";
  readonly name = "Fake Voice";
  readonly sttModel = "whisper-1";
  readonly ttsModel = "gpt-4o-mini-tts";
  readonly defaultVoice = "alloy";

  transcribeCalls: Array<{ bytes: number; mimeType: string }> = [];
  synthesizeCalls: Array<{ text: string; voice?: string }> = [];

  constructor(
    private behaviour: {
      text?: string;
      transcribeError?: unknown;
      synthesizeError?: unknown;
    } = {}
  ) {}

  async transcribe(input: { audio: Buffer; mimeType: string }) {
    this.transcribeCalls.push({ bytes: input.audio.length, mimeType: input.mimeType });
    if (this.behaviour.transcribeError) throw this.behaviour.transcribeError;
    return {
      text: this.behaviour.text ?? "pause the summer campaign",
      model: this.sttModel,
      latencyMs: 12,
    };
  }

  async synthesize(input: { text: string; voice?: string }) {
    this.synthesizeCalls.push({ text: input.text, voice: input.voice });
    if (this.behaviour.synthesizeError) throw this.behaviour.synthesizeError;
    return {
      audio: Buffer.from("fake-mp3"),
      mimeType: "audio/mpeg",
      model: this.ttsModel,
      voice: input.voice ?? this.defaultVoice,
      format: "mp3" as const,
    };
  }

  async isAvailable() {
    return true;
  }
}

interface CapturedResponse {
  status: number;
  body: Record<string, unknown>;
}

function fakeRes(): { res: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: {} };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

/**
 * Runs one request through the router without an HTTP server.
 *
 * The auth middleware is bypassed by injecting `req.auth` directly — token
 * verification is the middleware's own tested concern, and reproducing it here
 * would test `jsonwebtoken` rather than these routes. The unauthenticated case
 * below exercises the real guard.
 */
async function invoke(
  router: ReturnType<typeof createVoiceRouter>,
  method: "get" | "post",
  path: string,
  body: unknown,
  auth: { userId: string; role: string; email: string } | null
): Promise<CapturedResponse> {
  const layer = (router as unknown as {
    stack: Array<{
      route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> };
    }>;
  }).stack.find((l) => l.route?.path === path && l.route.methods[method]);

  if (!layer?.route) throw new Error(`No ${method.toUpperCase()} ${path} route`);

  const { res, captured } = fakeRes();
  const req = { body, ip: "127.0.0.1", auth: auth ?? undefined, headers: {} } as never;

  // The last handler in the stack is the route body; earlier ones are the auth
  // middleware, which is exercised separately.
  const handlers = layer.route.stack.map((s) => s.handle);
  const handler = auth ? handlers[handlers.length - 1]! : handlers[0]!;
  await handler(req, res, () => undefined);
  return captured;
}

describe("Sprint 8.1/8.2 — voice routes", () => {
  let audit: Array<Omit<AuditEntry, "id" | "timestamp">>;
  let container: Parameters<typeof createVoiceRouter>[0];
  const config = createVoiceConfig({}, {});
  const AUTH = { userId: "user-alpha", role: "member", email: "a@test.local" };

  function build(provider: FakeVoiceProvider, auditEntries: string[] = []) {
    audit = [];
    container = {
      tokenService: { verifyAccessToken: () => null },
      auditLogger: {
        log: async (entry: Omit<AuditEntry, "id" | "timestamp">) => {
          audit.push(entry);
        },
        query: async () =>
          auditEntries.map((action) => ({ action, userId: AUTH.userId }) as AuditEntry),
      },
    } as unknown as Parameters<typeof createVoiceRouter>[0];

    return createVoiceRouter(container, { provider, config });
  }

  beforeEach(() => {
    audit = [];
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Transcription
  // -------------------------------------------------------------------------

  describe("POST /transcribe", () => {
    it("returns the transcript", async () => {
      const provider = new FakeVoiceProvider({ text: "show me campaign performance" });
      const router = build(provider);

      const result = await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm;codecs=opus" },
        AUTH
      );

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect((result.body.data as Record<string, unknown>).text).toBe(
        "show me campaign performance"
      );
      expect((result.body.data as Record<string, unknown>).empty).toBe(false);
    });

    it("accepts a codec-qualified media type", async () => {
      const provider = new FakeVoiceProvider();
      const router = build(provider);

      const result = await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm;codecs=opus" },
        AUTH
      );

      expect(result.status).toBe(200);
      expect(provider.transcribeCalls).toHaveLength(1);
    });

    it("reports silence as success, not failure", async () => {
      const router = build(new FakeVoiceProvider({ text: "" }));

      const result = await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm" },
        AUTH
      );

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect((result.body.data as Record<string, unknown>).empty).toBe(true);
    });

    it("rejects an unsupported container", async () => {
      const provider = new FakeVoiceProvider();
      const router = build(provider);

      const result = await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "video/mp4" },
        AUTH
      );

      expect(result.status).toBe(415);
      expect((result.body.error as Record<string, unknown>).code).toBe(
        "VOICE_UNSUPPORTED_FORMAT"
      );
      expect(provider.transcribeCalls).toHaveLength(0);
    });

    it("rejects an oversized upload before decoding it", async () => {
      const provider = new FakeVoiceProvider();
      const router = build(provider);
      const huge = "A".repeat(config.maxAudioBytes * 2);

      const result = await invoke(
        router,
        "post",
        "/transcribe",
        { audio: huge, mimeType: "audio/webm" },
        AUTH
      );

      expect(result.status).toBe(413);
      expect((result.body.error as Record<string, unknown>).code).toBe(
        "VOICE_AUDIO_TOO_LARGE"
      );
      expect(provider.transcribeCalls).toHaveLength(0);
    });

    it("rejects invalid base64", async () => {
      const router = build(new FakeVoiceProvider());

      const result = await invoke(
        router,
        "post",
        "/transcribe",
        { audio: "!!!not-base64!!!", mimeType: "audio/webm" },
        AUTH
      );

      expect(result.status).toBe(400);
      expect((result.body.error as Record<string, unknown>).code).toBe(
        "VOICE_AUDIO_INVALID"
      );
    });

    it("rejects a missing body", async () => {
      const router = build(new FakeVoiceProvider());

      const result = await invoke(router, "post", "/transcribe", {}, AUTH);

      expect(result.status).toBe(400);
    });

    it("requires authentication", async () => {
      const router = build(new FakeVoiceProvider());

      const result = await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm" },
        null
      );

      expect(result.status).toBe(401);
    });

    it("reports a provider outage as unavailable, not as a client error", async () => {
      const router = build(
        new FakeVoiceProvider({
          transcribeError: new JarvisError("TOOL_UNAVAILABLE", "provider down"),
        })
      );

      const result = await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm" },
        AUTH
      );

      expect(result.status).toBe(503);
      expect((result.body.error as Record<string, unknown>).code).toBe(
        "VOICE_PROVIDER_UNAVAILABLE"
      );
    });

    it("does not leak provider detail to the client", async () => {
      const router = build(
        new FakeVoiceProvider({
          transcribeError: Object.assign(new Error("org-abc123 quota exceeded req_xyz"), {
            status: 500,
          }),
        })
      );

      const result = await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm" },
        AUTH
      );

      const serialized = JSON.stringify(result.body);
      expect(serialized).not.toContain("org-abc123");
      expect(serialized).not.toContain("req_xyz");
    });

    it("throttles once the voice budget is spent", async () => {
      const spent = Array.from(
        { length: VOICE_RATE_LIMITS.transcribe.limit },
        () => "voice.transcribe"
      );
      const provider = new FakeVoiceProvider();
      const router = build(provider, spent);

      const result = await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm" },
        AUTH
      );

      expect(result.status).toBe(429);
      expect(provider.transcribeCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Synthesis
  // -------------------------------------------------------------------------

  describe("POST /speak", () => {
    it("returns base64 audio", async () => {
      const router = build(new FakeVoiceProvider());

      const result = await invoke(router, "post", "/speak", { text: "Hello" }, AUTH);

      expect(result.status).toBe(200);
      const data = result.body.data as Record<string, unknown>;
      expect(typeof data.audio).toBe("string");
      expect(data.mimeType).toBe("audio/mpeg");
      expect(data.characterCount).toBe(5);
    });

    it("rejects empty text", async () => {
      const router = build(new FakeVoiceProvider());

      expect((await invoke(router, "post", "/speak", { text: "" }, AUTH)).status).toBe(400);
      expect((await invoke(router, "post", "/speak", { text: "   " }, AUTH)).status).toBe(
        400
      );
    });

    it("rejects text past the ceiling rather than truncating it", async () => {
      // Speaking half a reply while the user believes they heard all of it is
      // worse than refusing.
      const provider = new FakeVoiceProvider();
      const router = build(provider);

      const result = await invoke(
        router,
        "post",
        "/speak",
        { text: "x".repeat(config.maxTtsChars + 1) },
        AUTH
      );

      expect(result.status).toBe(413);
      expect((result.body.error as Record<string, unknown>).code).toBe(
        "VOICE_TEXT_TOO_LONG"
      );
      expect(provider.synthesizeCalls).toHaveLength(0);
    });

    it("requires authentication", async () => {
      const router = build(new FakeVoiceProvider());

      expect((await invoke(router, "post", "/speak", { text: "Hi" }, null)).status).toBe(
        401
      );
    });

    it("reports a synthesis failure as a server-side problem", async () => {
      const router = build(
        new FakeVoiceProvider({
          synthesizeError: new JarvisError("TOOL_EXECUTION_FAILED", "boom"),
        })
      );

      const result = await invoke(router, "post", "/speak", { text: "Hi" }, AUTH);

      expect(result.status).toBe(502);
      expect((result.body.error as Record<string, unknown>).code).toBe(
        "VOICE_SYNTHESIS_FAILED"
      );
    });

    it("throttles once the speak budget is spent", async () => {
      const spent = Array.from(
        { length: VOICE_RATE_LIMITS.speak.limit },
        () => "voice.speak"
      );
      const router = build(new FakeVoiceProvider(), spent);

      expect((await invoke(router, "post", "/speak", { text: "Hi" }, AUTH)).status).toBe(
        429
      );
    });
  });

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  describe("GET /status", () => {
    it("advertises the configuration and the approval rule", async () => {
      const router = build(new FakeVoiceProvider());

      const result = await invoke(router, "get", "/status", undefined, AUTH);

      expect(result.status).toBe(200);
      const data = result.body.data as Record<string, unknown>;
      expect(data.enabled).toBe(true);
      expect(data.canConfirmApprovals).toBe(false);
      expect(data.maxTtsChars).toBe(config.maxTtsChars);
    });
  });

  // -------------------------------------------------------------------------
  // Audit and data handling
  // -------------------------------------------------------------------------

  describe("audit and data handling", () => {
    it("audits a transcription without recording the transcript", async () => {
      const secret = "my card number is four two four two";
      const router = build(new FakeVoiceProvider({ text: secret }));

      await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm" },
        AUTH
      );

      const entry = audit.find((e) => e.action === "voice.transcribe");
      expect(entry).toBeDefined();
      expect(entry!.userId).toBe(AUTH.userId);
      expect(entry!.result).toBe("success");

      // Length, yes. Content, never — the transcript belongs in the Message
      // row, not scattered through the audit log.
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(SAMPLE_AUDIO);
      expect((entry!.metadata as Record<string, unknown>).transcriptLength).toBe(
        secret.length
      );
    });

    it("never writes audio into the audit trail", async () => {
      const router = build(new FakeVoiceProvider());

      await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm" },
        AUTH
      );
      await invoke(router, "post", "/speak", { text: "Hello" }, AUTH);

      for (const entry of audit) {
        const serialized = JSON.stringify(entry);
        expect(serialized).not.toContain(SAMPLE_AUDIO);
        expect(serialized).not.toContain("fake-mp3");
      }
    });

    it("audits a failure as well as a success", async () => {
      const router = build(
        new FakeVoiceProvider({
          transcribeError: new JarvisError("TOOL_UNAVAILABLE", "down"),
        })
      );

      await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm" },
        AUTH
      );

      const entry = audit.find((e) => e.action === "voice.transcribe");
      expect(entry?.result).toBe("failure");
    });

    it("audits a throttled attempt, so the counter cannot be starved", async () => {
      const spent = Array.from(
        { length: VOICE_RATE_LIMITS.transcribe.limit },
        () => "voice.transcribe"
      );
      const router = build(new FakeVoiceProvider(), spent);

      await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm" },
        AUTH
      );

      expect(audit.some((e) => (e.metadata as Record<string, unknown>)?.rateLimited)).toBe(
        true
      );
    });

    it("binds every call to the authenticated user", async () => {
      const router = build(new FakeVoiceProvider());

      await invoke(
        router,
        "post",
        "/transcribe",
        { audio: SAMPLE_AUDIO, mimeType: "audio/webm", userId: "user-victim" },
        AUTH
      );

      for (const entry of audit) {
        expect(entry.userId).toBe(AUTH.userId);
      }
    });
  });
});
