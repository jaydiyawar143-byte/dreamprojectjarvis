// ---------------------------------------------------------------------------
// What the speech provider actually sends.
//
// Both parameters pinned here were added to fix a reported defect, and both are
// invisible from the outside — nothing about the response shape changes, so a
// regression would show up only as "voice sounds weak again" or "it answered
// the wrong question again" weeks later.
//
//   - `language` is the fix for transcription. Left to detect, whisper-1 wrote
//     this operator's Hinglish in Urdu script, which no downstream intent rule
//     matches. Measured over 18 fixture runs: 12 of 18 in Latin script without
//     the hint, 18 of 18 with it, at the same latency.
//
//   - `instructions` is the fix for delivery. Without it the voice reads
//     factual answers tentatively, which is what "weak, lacks presence" means.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

const transcriptionsCreate = vi.fn();
const speechCreate = vi.fn();

vi.mock("openai", () => {
  class MockOpenAI {
    audio = {
      transcriptions: { create: (...args: unknown[]) => transcriptionsCreate(...args) },
      speech: { create: (...args: unknown[]) => speechCreate(...args) },
    };
    models = { list: async () => ({ data: [] }) };
    static toFile = async (audio: unknown, fileName: string) => ({ audio, fileName });
  }
  return { default: MockOpenAI, OpenAI: MockOpenAI };
});

import { OpenAIVoiceProvider } from "../src/openai-voice-provider.js";

const AUDIO = Buffer.from("not really audio");

beforeEach(() => {
  vi.clearAllMocks();
  transcriptionsCreate.mockResolvedValue({ text: "  what time is it  " });
  speechCreate.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(8) });
});

function provider(config: Record<string, unknown> = {}) {
  return new OpenAIVoiceProvider({ apiKey: "sk-test", ...config });
}

describe("transcription", () => {
  it("sends a language hint by default", async () => {
    await provider().transcribe({ audio: AUDIO, mimeType: "audio/webm" });

    const [params] = transcriptionsCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.language).toBe("en");
    expect(params.model).toBe("whisper-1");
  });

  it("lets a caller override the language for a single request", async () => {
    await provider().transcribe({ audio: AUDIO, mimeType: "audio/webm", language: "fr" });

    const [params] = transcriptionsCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.language).toBe("fr");
  });

  it("takes a deployment-wide default from configuration", async () => {
    await provider({ sttLanguage: "de" }).transcribe({ audio: AUDIO, mimeType: "audio/webm" });

    const [params] = transcriptionsCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.language).toBe("de");
  });

  it("sends no prompt", async () => {
    // A prompt was tried and removed. An instruction-shaped one made the
    // recognizer ANSWER the audio instead of transcribing it: "How many widgets
    // do you have?" came back as "Kitne widgets tumhare paas hain?", and one
    // fixture produced several sentences that were never spoken. Corrupting the
    // user's request is a worse failure than the script problem it was meant to
    // solve, and the language hint solves that without this.
    await provider().transcribe({ audio: AUDIO, mimeType: "audio/webm" });

    const [params] = transcriptionsCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.prompt).toBeUndefined();
  });

  it("reports the language it actually sent", async () => {
    const result = await provider().transcribe({ audio: AUDIO, mimeType: "audio/webm" });
    expect(result.language).toBe("en");
  });
});

describe("synthesis", () => {
  it("uses a voice with presence but without the heaviness that read as tired", async () => {
    await provider().synthesize({ text: "The current time is 12:46." });

    const [params] = speechCreate.mock.calls[0] as [Record<string, unknown>];
    // Was `onyx`. Deep timbre plus the old "measured, unhurried" direction is
    // acoustically what a sleepy person sounds like, which is exactly what was
    // reported.
    expect(params.voice).toBe("ash");
  });

  it("directs an energetic, alert delivery rather than a measured one", async () => {
    await provider().synthesize({ text: "The current time is 12:46." });

    const [params] = speechCreate.mock.calls[0] as [Record<string, unknown>];
    const instructions = String(params.instructions);

    expect(instructions).toMatch(/energetic/i);
    expect(instructions).toMatch(/alert/i);
    expect(instructions).toMatch(/confident/i);

    // The regression that matters: the direction must never again ASK for the
    // delivery that was reported as sleepy.
    expect(instructions).not.toMatch(/unhurried/i);
    expect(instructions).toMatch(/avoid sounding sleepy/i);
  });

  it("never sends speed on the default model, which rejects it", async () => {
    await provider().synthesize({ text: "hello" });

    const [params] = speechCreate.mock.calls[0] as [Record<string, unknown>];
    // gpt-4o-mini-tts 400s on `speed`. Sending it would fail every synthesis.
    expect(params.speed).toBeUndefined();
  });

  it("does send speed on a model that accepts it", async () => {
    await provider({ ttsModel: "tts-1", ttsSpeed: 1.2 }).synthesize({ text: "hello" });

    const [params] = speechCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.speed).toBe(1.2);
  });

  it("clamps an out-of-range speed instead of failing the request", async () => {
    await provider({ ttsModel: "tts-1", ttsSpeed: 99 }).synthesize({ text: "hello" });

    const [params] = speechCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.speed).toBe(4);
  });

  it("still withholds a configured speed from a model that does not support it", async () => {
    await provider({ ttsModel: "gpt-4o-mini-tts", ttsSpeed: 1.5 }).synthesize({ text: "hello" });

    const [params] = speechCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.speed).toBeUndefined();
  });

  it("lets an operator replace the delivery direction", async () => {
    await provider({ ttsInstructions: "Speak like a pirate." }).synthesize({ text: "hello" });

    const [params] = speechCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.instructions).toBe("Speak like a pirate.");
  });

  it("still honours a per-request voice", async () => {
    await provider().synthesize({ text: "hello", voice: "nova" });

    const [params] = speechCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.voice).toBe("nova");
  });
});
