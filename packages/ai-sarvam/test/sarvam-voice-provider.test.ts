// ---------------------------------------------------------------------------
// Sarvam speech synthesis.
//
// Same priorities as the ElevenLabs tests. First containment: the API key may
// appear in exactly one place, the `api-subscription-key` header — not a URL,
// not an error, not a serialised provider. Then the failure mapping, because a
// user who hears nothing needs to know whether to wait, tell someone, or retry.
// Then the contract: the request shape the vendor documents and the base64
// response it returns.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { JarvisError } from "@jarvis/core";
import { SarvamVoiceProvider } from "../src/sarvam-voice-provider.js";
import { FallbackTtsProvider } from "../src/fallback-tts-provider.js";

const API_KEY = "sk_SARVAM_SECRET_KEY_VALUE_do_not_leak_0001";

const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(64, 1)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 2)]);

function okResponse(audio: Buffer = WAV) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ request_id: "r1", audios: [audio.toString("base64")] }),
    text: async () => "",
  } as unknown as Response;
}

function errorResponse(status: number, body = '{"error":{"message":"detail with sk_leak"}}') {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

function provider(over: Record<string, unknown> = {}, fetchImpl?: typeof fetch) {
  return new SarvamVoiceProvider({
    apiKey: API_KEY,
    speaker: "Shubh",
    fetchImpl: fetchImpl ?? (vi.fn(async () => okResponse()) as unknown as typeof fetch),
    ...over,
  });
}

describe("configuration", () => {
  it("requires a key and a speaker", () => {
    const keep = { k: process.env.SARVAM_API_KEY, s: process.env.SARVAM_SPEAKER };
    delete process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_SPEAKER;
    try {
      expect(() => new SarvamVoiceProvider({ speaker: "shubh" })).toThrow(JarvisError);
      expect(() => new SarvamVoiceProvider({ apiKey: API_KEY })).toThrow(JarvisError);
    } finally {
      if (keep.k !== undefined) process.env.SARVAM_API_KEY = keep.k;
      if (keep.s !== undefined) process.env.SARVAM_SPEAKER = keep.s;
    }
  });

  it("lowercases the speaker, which the vendor treats as case-sensitive", () => {
    expect(provider().defaultVoice).toBe("shubh");
  });

  it("clamps pace into the documented 0.5–2.0 range instead of failing to boot", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await provider({ pace: 9 }, fetchImpl as unknown as typeof fetch).synthesize({ text: "Hi" });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.pace).toBe(2);
  });
});

describe("synthesis", () => {
  it("sends the documented request and decodes the base64 audio", async () => {
    const fetchImpl = vi.fn(async () => okResponse(MP3));
    const out = await provider({}, fetchImpl as unknown as typeof fetch).synthesize({
      text: "Namaste, main JARVIS hoon.",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sarvam.ai/text-to-speech");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      text: "Namaste, main JARVIS hoon.",
      language_code: "hi-IN",
      speaker: "shubh",
      model: "bulbul:v3",
      output_audio_codec: "mp3",
    });
    expect(out.audio.equals(MP3)).toBe(true);
    expect(out.mimeType).toBe("audio/mpeg");
    expect(out.format).toBe("mp3");
    expect(out.voice).toBe("shubh");
    expect(out.model).toBe("bulbul:v3");
  });

  it("reports what the bytes really are, not what was asked for", async () => {
    // Asked for mp3, the vendor returned WAV (its docs describe WAV output).
    const out = await provider().synthesize({ text: "Hi", format: "mp3" });
    expect(out.mimeType).toBe("audio/wav");
    expect(out.format).toBe("wav");
  });

  it("never asks v3 or v4-flash for opus, which they refuse", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await provider({}, fetchImpl as unknown as typeof fetch).synthesize({ text: "Hi", format: "opus" });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.output_audio_codec).not.toBe("opus");
  });

  it("refuses empty text and text over the per-request limit without calling the vendor", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const p = provider({}, fetchImpl as unknown as typeof fetch);
    await expect(p.synthesize({ text: "   " })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(p.synthesize({ text: "a".repeat(2501) })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats an empty or malformed payload as a failure", async () => {
    const empty = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ audios: [] }), text: async () => "" }) as unknown as Response);
    await expect(provider({}, empty as unknown as typeof fetch).synthesize({ text: "Hi" })).rejects.toBeInstanceOf(JarvisError);
    const bad = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error("x"); }, text: async () => "" }) as unknown as Response);
    await expect(provider({}, bad as unknown as typeof fetch).synthesize({ text: "Hi" })).rejects.toBeInstanceOf(JarvisError);
  });
});

describe("the key stays contained", () => {
  it("is sent only in the api-subscription-key header", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await provider({}, fetchImpl as unknown as typeof fetch).synthesize({ text: "Hi" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(API_KEY);
    expect(init.body as string).not.toContain(API_KEY);
    expect((init.headers as Record<string, string>)["api-subscription-key"]).toBe(API_KEY);
  });

  it("does not appear when the provider is serialised or spread", () => {
    const p = provider();
    expect(JSON.stringify(p)).not.toContain(API_KEY);
    expect(JSON.stringify(Object.keys(p))).not.toContain(API_KEY);
    expect(JSON.stringify({ ...p })).not.toContain(API_KEY);
  });

  it("never echoes a vendor error body", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(403));
    const err = await provider({}, fetchImpl as unknown as typeof fetch)
      .synthesize({ text: "Hi" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(JarvisError);
    expect(String(err.message)).not.toContain("sk_leak");
    expect(String(err.message)).not.toContain(API_KEY);
  });
});

describe("failure mapping", () => {
  const cases: Array<[number, string]> = [
    [403, "TOOL_UNAVAILABLE"],
    [400, "INVALID_REQUEST"],
    [422, "INVALID_REQUEST"],
    [429, "TOOL_RATE_LIMITED"],
    [500, "TOOL_UNAVAILABLE"],
  ];
  for (const [status, code] of cases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const fetchImpl = vi.fn(async () => errorResponse(status));
      await expect(
        provider({}, fetchImpl as unknown as typeof fetch).synthesize({ text: "Hi" })
      ).rejects.toMatchObject({ code });
    });
  }

  it("maps a network failure to a generic execution failure", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(
      provider({}, fetchImpl as unknown as typeof fetch).synthesize({ text: "Hi" })
    ).rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
  });

  it("reports a caller cancellation as a cancellation", async () => {
    const ctl = new AbortController();
    const fetchImpl = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal!.addEventListener("abort", () => rej(new Error("aborted")));
        })
    );
    const pending = provider({}, fetchImpl as unknown as typeof fetch).synthesize({
      text: "Hi",
      signal: ctl.signal,
    });
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("availability probe", () => {
  it("counts a 200 or a request-level 4xx as reachable, and a 403 as not", async () => {
    expect(await provider({}, vi.fn(async () => okResponse()) as unknown as typeof fetch).isAvailable()).toBe(true);
    expect(await provider({}, vi.fn(async () => errorResponse(422)) as unknown as typeof fetch).isAvailable()).toBe(true);
    expect(await provider({}, vi.fn(async () => errorResponse(403)) as unknown as typeof fetch).isAvailable()).toBe(false);
    expect(await provider({}, vi.fn(async () => { throw new Error("x"); }) as unknown as typeof fetch).isAvailable()).toBe(false);
  });

  it("caches the answer so a polling status page does not bill every poll", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const p = provider({}, fetchImpl as unknown as typeof fetch);
    await p.isAvailable();
    await p.isAvailable();
    await p.isAvailable();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("FallbackTtsProvider", () => {
  function fake(name: string, behaviour: () => Promise<unknown>) {
    return {
      name,
      ttsModel: `${name}-model`,
      defaultVoice: `${name}-voice`,
      synthesize: vi.fn(behaviour as never),
      isAvailable: vi.fn(async () => true),
    };
  }
  const audio = { audio: Buffer.from("x"), mimeType: "audio/mpeg", model: "m", voice: "v", format: "mp3" as const };

  it("uses the primary when it works", async () => {
    const a = fake("a", async () => audio);
    const b = fake("b", async () => audio);
    await new FallbackTtsProvider(a, b).synthesize({ text: "Hi" });
    expect(a.synthesize).toHaveBeenCalledTimes(1);
    expect(b.synthesize).not.toHaveBeenCalled();
  });

  it("falls back on an outage, and drops the primary vendor's speaker name", async () => {
    const a = fake("a", async () => { throw new JarvisError("TOOL_UNAVAILABLE", "down"); });
    const b = fake("b", async () => audio);
    const seen = vi.fn();
    await new FallbackTtsProvider(a, b, seen).synthesize({ text: "Hi", voice: "shubh" });
    expect(b.synthesize).toHaveBeenCalledWith({ text: "Hi" });
    expect(seen).toHaveBeenCalledWith({ from: "a", to: "b", code: "TOOL_UNAVAILABLE" });
  });

  it("does not fall back for a bad request or a cancellation", async () => {
    const a = fake("a", async () => { throw new JarvisError("INVALID_REQUEST", "cancelled"); });
    const b = fake("b", async () => audio);
    await expect(new FallbackTtsProvider(a, b).synthesize({ text: "Hi" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(b.synthesize).not.toHaveBeenCalled();
  });

  it("does not speak through the fallback once the caller has aborted", async () => {
    const ctl = new AbortController();
    const a = fake("a", async () => { ctl.abort(); throw new JarvisError("TOOL_UNAVAILABLE", "down"); });
    const b = fake("b", async () => audio);
    await expect(
      new FallbackTtsProvider(a, b).synthesize({ text: "Hi", signal: ctl.signal })
    ).rejects.toBeInstanceOf(JarvisError);
    expect(b.synthesize).not.toHaveBeenCalled();
  });

  it("is available when either side is", async () => {
    const a = fake("a", async () => audio);
    const b = fake("b", async () => audio);
    a.isAvailable.mockResolvedValue(false);
    expect(await new FallbackTtsProvider(a, b).isAvailable()).toBe(true);
    b.isAvailable.mockResolvedValue(false);
    expect(await new FallbackTtsProvider(a, b).isAvailable()).toBe(false);
  });
});
