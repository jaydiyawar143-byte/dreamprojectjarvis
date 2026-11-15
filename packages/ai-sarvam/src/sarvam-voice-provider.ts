// ---------------------------------------------------------------------------
// Sarvam speech synthesis (Bulbul), for Hindi, Hinglish and Indian English.
//
// SPEAKS ONLY. Like the ElevenLabs provider, this is the TTS half of a
// `CompositeVoiceProvider`; transcription stays on whisper-1, chosen by
// measurement for this operator's Hinglish (see composite-voice-provider.ts).
//
// THE KEY. Same discipline as ElevenLabs: it is read from the environment (or
// the constructor), held in a true private field so `JSON.stringify(provider)`
// cannot leak it, sent only in the `api-subscription-key` header, and never
// placed in a URL, an error message or a log line. A provider error body is
// read and DISCARDED — `toVoiceError` maps a status to a coarse category and
// nothing the vendor wrote travels outward.
//
// THE CONTRACT (https://docs.sarvam.ai/api/text-to-speech/convert):
//   POST https://api.sarvam.ai/text-to-speech
//   header  api-subscription-key
//   body    { text, language_code, speaker, model, pace, speech_sample_rate,
//             output_audio_codec }
//   200     { request_id, audios: [ <base64 audio> ] }
//
// Speakers are lowercase and MUST match the model (`shubh` is a bulbul:v3
// speaker; bulbul:v4-flash personas look like `shubh_enhi_companion`). A
// mismatch is a 4xx from the vendor, which this class reports as "rejected".
// ---------------------------------------------------------------------------

import {
  JarvisError,
  SPEECH_FORMAT_MIME_TYPES,
  type SpeechAudioFormat,
  type TranscriptionResult,
} from "@jarvis/core";

const ENDPOINT = "https://api.sarvam.ai/text-to-speech";
const DEFAULT_MODEL = "bulbul:v3";
const DEFAULT_LANGUAGE_CODE = "hi-IN";
const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const PROBE_TTL_MS = 60_000;

/** Per-request ceiling documented by the vendor: 2500 (v3, v4-flash), 1500 (v2). */
function maxCharsFor(model: string): number {
  return model.includes("v2") ? 1_500 : 2_500;
}

/** JARVIS-level format → the vendor's `output_audio_codec`. `opus` is refused by v3 and v4-flash. */
const CODEC: Readonly<Record<SpeechAudioFormat, { codec: string; actual: SpeechAudioFormat }>> =
  Object.freeze({
    mp3: { codec: "mp3", actual: "mp3" },
    wav: { codec: "wav", actual: "wav" },
    aac: { codec: "aac", actual: "aac" },
    flac: { codec: "flac", actual: "flac" },
    pcm: { codec: "linear16", actual: "pcm" },
    opus: { codec: "mp3", actual: "mp3" },
  });

export interface SarvamVoiceConfig {
  apiKey?: string;
  speaker?: string;
  model?: string;
  languageCode?: string;
  pace?: number;
  sampleRate?: number;
  timeoutMs?: number;
  /** Injected in tests. Never set in production. */
  fetchImpl?: typeof fetch;
}

/**
 * Maps a provider failure onto a JarvisError. Only a coarse category crosses
 * this boundary; a Sarvam error body can restate the request.
 */
function toVoiceError(status: number | undefined, detail?: string): JarvisError {
  if (status === 401 || status === 403) {
    return new JarvisError(
      "TOOL_UNAVAILABLE",
      "Speech synthesis is not authorized. Check the Sarvam API key on the server."
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    // Usually a speaker that does not exist for the chosen model.
    return new JarvisError(
      "INVALID_REQUEST",
      "Sarvam rejected the speech request. Check the configured speaker and model."
    );
  }
  if (status === 429) {
    return new JarvisError(
      "TOOL_RATE_LIMITED",
      "Speech synthesis is rate limited or the Sarvam credit is exhausted."
    );
  }
  if (status !== undefined && status >= 500) {
    return new JarvisError("TOOL_UNAVAILABLE", "The speech provider is temporarily unavailable.");
  }
  if (detail === "timeout") {
    return new JarvisError("TOOL_UNAVAILABLE", "Speech synthesis timed out.");
  }
  if (detail === "aborted") {
    return new JarvisError("INVALID_REQUEST", "Speech synthesis was cancelled.");
  }
  return new JarvisError("TOOL_EXECUTION_FAILED", "Speech synthesis failed.");
}

/**
 * What the bytes really are. The docs describe the payload as base64 WAV, and
 * also offer a codec switch; rather than trust either, the container is read
 * from the first bytes so the browser is always told the truth.
 */
function sniff(audio: Buffer): { mimeType: string; format: SpeechAudioFormat } | undefined {
  if (audio.length < 4) return undefined;
  const head = audio.subarray(0, 4).toString("latin1");
  if (head === "RIFF") return { mimeType: SPEECH_FORMAT_MIME_TYPES.wav, format: "wav" };
  if (head === "fLaC") return { mimeType: SPEECH_FORMAT_MIME_TYPES.flac, format: "flac" };
  if (head.startsWith("ID3") || (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0)) {
    return { mimeType: SPEECH_FORMAT_MIME_TYPES.mp3, format: "mp3" };
  }
  return undefined;
}

export class SarvamVoiceProvider {
  readonly id = "sarvam-voice";
  readonly name = "Sarvam";
  /** No STT here — transcription stays on whisper-1. */
  readonly sttModel = "unsupported";
  readonly ttsModel: string;
  readonly defaultVoice: string;

  /** A TRUE private field: invisible to JSON.stringify, Object.keys and spread. */
  #apiKey: string;
  private readonly languageCode: string;
  private readonly pace: number;
  private readonly sampleRate: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private probe: { at: number; ok: boolean } | undefined;

  constructor(config: SarvamVoiceConfig = {}) {
    const apiKey = config.apiKey ?? process.env.SARVAM_API_KEY;
    if (!apiKey) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "Sarvam API key is required. Set SARVAM_API_KEY on the server."
      );
    }
    const speaker = config.speaker ?? process.env.SARVAM_SPEAKER;
    if (!speaker) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "Sarvam speaker is required. Set SARVAM_SPEAKER on the server."
      );
    }

    const num = (v: number | undefined, env: string | undefined, fallback: number): number => {
      const raw = v ?? (env !== undefined && env !== "" ? Number(env) : undefined);
      return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
    };

    this.#apiKey = apiKey;
    // Case-sensitive and lowercase on the vendor side.
    this.defaultVoice = speaker.trim().toLowerCase();
    this.ttsModel = config.model ?? process.env.SARVAM_MODEL ?? DEFAULT_MODEL;
    this.languageCode =
      config.languageCode ?? process.env.SARVAM_LANGUAGE_CODE ?? DEFAULT_LANGUAGE_CODE;
    // 0.5–2.0 is the documented range for v3 and v4-flash; clamp rather than fail to boot.
    this.pace = Math.min(2, Math.max(0.5, num(config.pace, process.env.SARVAM_PACE, 1)));
    this.sampleRate = num(config.sampleRate, process.env.SARVAM_SAMPLE_RATE, DEFAULT_SAMPLE_RATE);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as typeof fetch);
  }

  async transcribe(): Promise<TranscriptionResult> {
    throw new JarvisError(
      "TOOL_UNAVAILABLE",
      "Sarvam is configured for speech synthesis only; transcription uses a different provider."
    );
  }

  async synthesize(input: {
    text: string;
    voice?: string;
    format?: SpeechAudioFormat;
    signal?: AbortSignal;
  }): Promise<{
    audio: Buffer;
    mimeType: string;
    model: string;
    voice: string;
    format: SpeechAudioFormat;
  }> {
    const text = input.text.trim();
    if (text.length === 0) {
      throw new JarvisError("INVALID_REQUEST", "There is no text to speak.");
    }
    if (text.length > maxCharsFor(this.ttsModel)) {
      throw new JarvisError("INVALID_REQUEST", "That text is too long for one speech request.");
    }

    const voice = (input.voice ?? this.defaultVoice).trim().toLowerCase();
    const requested = input.format ?? "mp3";
    const { codec, actual } = CODEC[requested];

    const response = await this.post(
      {
        text,
        language_code: this.languageCode,
        speaker: voice,
        model: this.ttsModel,
        pace: this.pace,
        speech_sample_rate: this.sampleRate,
        output_audio_codec: codec,
      },
      input.signal
    );

    let payload: { audios?: unknown };
    try {
      payload = (await response.json()) as { audios?: unknown };
    } catch {
      throw toVoiceError(undefined, "empty");
    }
    const first = Array.isArray(payload.audios) ? payload.audios[0] : undefined;
    const audio = typeof first === "string" ? Buffer.from(first, "base64") : Buffer.alloc(0);
    if (audio.length === 0) {
      throw toVoiceError(undefined, "empty");
    }

    const detected = sniff(audio);
    return {
      audio,
      mimeType: detected?.mimeType ?? SPEECH_FORMAT_MIME_TYPES[actual],
      model: this.ttsModel,
      voice,
      format: detected?.format ?? actual,
    };
  }

  /**
   * Reachability probe.
   *
   * Sarvam documents no free "who am I" call, so this sends a one-character
   * request and reads only the STATUS. Any answer that proves the key was
   * accepted (200, or a 400/422 about the request itself) counts as available;
   * a 403, a 5xx or a network failure does not. The result is cached for a
   * minute so a polling status page cannot turn into a billing line.
   */
  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.probe && now - this.probe.at < PROBE_TTL_MS) return this.probe.ok;
    let ok = false;
    try {
      const res = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          text: ".",
          language_code: this.languageCode,
          speaker: this.defaultVoice,
          model: this.ttsModel,
          output_audio_codec: "mp3",
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.text().catch(() => "");
      ok = res.ok || res.status === 400 || res.status === 422;
    } catch {
      ok = false;
    }
    this.probe = { at: now, ok };
    return ok;
  }

  private headers(): Record<string, string> {
    return {
      // The ONLY place the key appears.
      "api-subscription-key": this.#apiKey,
      "content-type": "application/json",
    };
  }

  /** One POST with the timeout and the caller's cancellation combined. */
  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    const onAbort = () => controller.abort(new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        // Read and DISCARD: frees the socket, keeps vendor text from travelling.
        await response.text().catch(() => "");
        throw toVoiceError(response.status);
      }
      return response;
    } catch (err) {
      if (err instanceof JarvisError) throw err;
      const reason =
        (err as { message?: string })?.message === "timeout"
          ? "timeout"
          : controller.signal.aborted
            ? "aborted"
            : undefined;
      throw toVoiceError(undefined, reason);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
