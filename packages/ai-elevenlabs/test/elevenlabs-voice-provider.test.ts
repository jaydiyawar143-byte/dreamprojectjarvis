// ---------------------------------------------------------------------------
// ElevenLabs speech synthesis.
//
// The security block is the one that matters most. This class holds an API key
// and talks to a third party, so the tests that earn their keep are the ones
// asserting the key never travels anywhere except the request header — not into
// a URL, not into an error, not into a log line, not into a thrown provider
// body. Everything else here is behaviour; that block is containment.
//
// The failure mapping is second. A user who cannot hear anything needs to know
// whether to wait (rate limited), tell someone (bad key), or try again
// (timeout), and those are three different sentences. Collapsing them into
// "speech failed" turns a fixable problem into a mystery.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { ElevenLabsVoiceProvider } from "../src/elevenlabs-voice-provider.js";
import { JarvisError } from "@jarvis/core";

const API_KEY = "sk_elevenlabs_SECRET_KEY_VALUE_do_not_leak_0001";
const VOICE_ID = "tmbml5fDfdur7yY0gzHA";

function audioResponse(bytes = 2048) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array(bytes).fill(7).buffer,
    text: async () => "",
  } as unknown as Response;
}

function errorResponse(status: number, body = '{"detail":{"message":"nope"}}') {
  return {
    ok: false,
    status,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => body,
  } as unknown as Response;
}

function provider(over: Record<string, unknown> = {}, fetchImpl?: typeof fetch) {
  return new ElevenLabsVoiceProvider({
    apiKey: API_KEY,
    voiceId: VOICE_ID,
    fetchImpl: fetchImpl ?? (vi.fn(async () => audioResponse()) as unknown as typeof fetch),
    ...over,
  });
}

// ---------------------------------------------------------------------------

describe("synthesis", () => {
  it("returns audio for the configured voice and model", async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    const out = await provider({}, fetchImpl as unknown as typeof fetch).synthesize({
      text: "Good evening. I am JARVIS. How may I assist you?",
    });

    expect(out.audio.length).toBeGreaterThan(0);
    expect(out.voice).toBe(VOICE_ID);
    expect(out.model).toBe("eleven_multilingual_v2");
    expect(out.mimeType).toBe("audio/mpeg");
  });

  it("posts to the voice endpoint with the delivery settings", async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    await provider({}, fetchImpl as unknown as typeof fetch).synthesize({ text: "hello" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/text-to-speech/${VOICE_ID}`);
    expect(init.method).toBe("POST");

    const body = JSON.parse(String(init.body));
    expect(body.text).toBe("hello");
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body.voice_settings.stability).toBeCloseTo(0.62);
    expect(body.voice_settings.similarity_boost).toBeCloseTo(0.88);
    expect(body.voice_settings.speed).toBeCloseTo(0.94);
    expect(body.voice_settings.use_speaker_boost).toBe(true);
  });

  it("honours a per-request voice override", async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    await provider({}, fetchImpl as unknown as typeof fetch).synthesize({
      text: "hi",
      voice: "other-voice-id",
    });

    expect(String(fetchImpl.mock.calls[0]![0])).toContain("other-voice-id");
  });

  it("treats an empty audio body as a failure rather than silence", async () => {
    // Returning 0 bytes as success would play nothing and report success —
    // the user hears the assistant say nothing and cannot tell why.
    const fetchImpl = vi.fn(async () => audioResponse(0));

    await expect(
      provider({}, fetchImpl as unknown as typeof fetch).synthesize({ text: "hi" })
    ).rejects.toBeInstanceOf(JarvisError);
  });
});

describe("configuration", () => {
  it("refuses to construct without an API key", () => {
    expect(() => new ElevenLabsVoiceProvider({ apiKey: "", voiceId: VOICE_ID })).toThrow(
      /API key is required/i
    );
  });

  it("refuses to construct without a voice id", () => {
    // Defaulting to some arbitrary voice would change how JARVIS sounds
    // without anyone choosing it.
    expect(() => new ElevenLabsVoiceProvider({ apiKey: API_KEY, voiceId: "" })).toThrow(
      /voice id is required/i
    );
  });

  it("does not offer transcription, and says so clearly", async () => {
    await expect(provider().transcribe()).rejects.toThrow(/synthesis only/i);
  });
});

describe("provider failures map to answers a person can act on", () => {
  const cases: Array<[number, RegExp]> = [
    [401, /not authorized/i],
    [403, /not authorized/i],
    [404, /voice was not found/i],
    [422, /rejected the speech request/i],
    [429, /rate limited|quota/i],
    [500, /temporarily unavailable/i],
    [503, /temporarily unavailable/i],
  ];

  for (const [status, expected] of cases) {
    it(`maps ${status} to a distinct message`, async () => {
      const fetchImpl = vi.fn(async () => errorResponse(status));

      await expect(
        provider({}, fetchImpl as unknown as typeof fetch).synthesize({ text: "hi" })
      ).rejects.toThrow(expected);
    });
  }

  it("reports a timeout distinctly", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("timeout")));
        })
    );

    await expect(
      provider({ timeoutMs: 20 }, fetchImpl as unknown as typeof fetch).synthesize({ text: "hi" })
    ).rejects.toThrow(/timed out/i);
  });

  it("reports caller cancellation distinctly from a timeout", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );

    const promise = provider({}, fetchImpl as unknown as typeof fetch).synthesize({
      text: "hi",
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it("passes an abort signal through, so a stopped playback stops the request", async () => {
    // Without this the request runs to completion and is billed for, after the
    // user has already pressed stop.
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeDefined();
      return audioResponse();
    });

    await provider({}, fetchImpl as unknown as typeof fetch).synthesize({
      text: "hi",
      signal: controller.signal,
    });

    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe("the API key never leaves the request header", () => {
  it("sends it in xi-api-key and nowhere else", async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    await provider({}, fetchImpl as unknown as typeof fetch).synthesize({ text: "hi" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers["xi-api-key"]).toBe(API_KEY);
    // A key in the URL lands in provider access logs and every proxy between.
    expect(String(url)).not.toContain(API_KEY);
    expect(String(init.body)).not.toContain(API_KEY);
  });

  it("never puts the key in a thrown error, for any status", async () => {
    for (const status of [401, 403, 404, 422, 429, 500]) {
      const fetchImpl = vi.fn(async () => errorResponse(status));
      const err = await provider({}, fetchImpl as unknown as typeof fetch)
        .synthesize({ text: "hi" })
        .catch((e: Error) => e);

      const serialized = `${err.message} ${JSON.stringify(err)}`;
      expect(serialized, `status ${status}`).not.toContain(API_KEY);
    }
  });

  it("never echoes the provider's error body outward", async () => {
    // A provider body can restate the request and name the voice and model.
    const fetchImpl = vi.fn(async () =>
      errorResponse(422, '{"detail":"voice tmbml5 rejected for account acct_123"}')
    );

    const err = await provider({}, fetchImpl as unknown as typeof fetch)
      .synthesize({ text: "hi" })
      .catch((e: Error) => e);

    expect(err.message).not.toContain("acct_123");
    expect(err.message).not.toContain("detail");
  });

  it("keeps the key off every own-property of the instance path a route could serialise", async () => {
    const p = provider();
    // The key is private; JSON.stringify of the instance must not carry it.
    expect(JSON.stringify(p)).not.toContain(API_KEY);
  });

  it("does not expose the key through the public provider surface", () => {
    const p = provider();
    const publicSurface = JSON.stringify({
      id: p.id,
      name: p.name,
      sttModel: p.sttModel,
      ttsModel: p.ttsModel,
      defaultVoice: p.defaultVoice,
    });

    expect(publicSurface).not.toContain(API_KEY);
    // The voice id IS public — it is not a credential and the UI shows it.
    expect(publicSurface).toContain(VOICE_ID);
  });
});

describe("availability", () => {
  it("probes the account endpoint rather than burning character quota", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    const ok = await provider({}, fetchImpl as unknown as typeof fetch).isAvailable();

    expect(ok).toBe(true);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/user");
    expect(String(fetchImpl.mock.calls[0]![0])).not.toContain("text-to-speech");
  });

  it("reports unavailable rather than throwing when the network is down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });

    await expect(
      provider({}, fetchImpl as unknown as typeof fetch).isAvailable()
    ).resolves.toBe(false);
  });
});
