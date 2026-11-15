import { describe, it, expect } from "vitest";
import { isSarvamConfigured, selectTtsProvider } from "../src/index.js";

const SARVAM = { SARVAM_API_KEY: "k", SARVAM_SPEAKER: "shubh" };
const ELEVEN = { ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v" };

describe("selectTtsProvider", () => {
  it("falls back to OpenAI when nothing is configured", () => {
    expect(selectTtsProvider({})).toBe("openai");
  });

  it("needs both a key and a speaker before Sarvam counts as configured", () => {
    expect(isSarvamConfigured({ SARVAM_API_KEY: "k" })).toBe(false);
    expect(isSarvamConfigured({ SARVAM_SPEAKER: "shubh" })).toBe(false);
    expect(isSarvamConfigured(SARVAM)).toBe(true);
  });

  it("keeps ElevenLabs when both are configured and nothing is chosen", () => {
    expect(selectTtsProvider({ ...SARVAM, ...ELEVEN })).toBe("elevenlabs");
  });

  it("uses Sarvam when it is the only upgrade configured", () => {
    expect(selectTtsProvider(SARVAM)).toBe("sarvam");
  });

  it("switches to Sarvam only when asked", () => {
    expect(selectTtsProvider({ ...SARVAM, ...ELEVEN, VOICE_TTS_PROVIDER: "sarvam" })).toBe("sarvam");
    expect(selectTtsProvider({ ...SARVAM, ...ELEVEN, VOICE_TTS_PROVIDER: " Sarvam " })).toBe("sarvam");
  });

  it("an explicit choice that is not configured does not leave JARVIS silent", () => {
    expect(selectTtsProvider({ ...ELEVEN, VOICE_TTS_PROVIDER: "sarvam" })).toBe("elevenlabs");
    expect(selectTtsProvider({ VOICE_TTS_PROVIDER: "sarvam" })).toBe("openai");
  });

  it("openai forces the OpenAI voice even when others are configured", () => {
    expect(selectTtsProvider({ ...SARVAM, ...ELEVEN, VOICE_TTS_PROVIDER: "openai" })).toBe("openai");
  });
});
