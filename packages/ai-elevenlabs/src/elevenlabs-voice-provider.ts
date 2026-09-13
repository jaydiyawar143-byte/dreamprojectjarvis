// ---------------------------------------------------------------------------
// ElevenLabs speech synthesis.
//
// TTS ONLY, DELIBERATELY. `IVoiceProvider` covers both directions, but this
// class implements only `synthesize`. Transcription stays on whisper-1, and
// that is not inertia: the STT model was chosen after measuring it. This
// operator speaks Hinglish, and a faster alternative rendered it in Devanagari
// on 10 of 18 fixture runs where whisper-1 with a language hint managed 18 of
// 18 in Latin script. Every downstream intent rule matches Latin text, so
// swapping the recognizer to chase a new TTS vendor would break routing to fix
// nothing. `CompositeVoiceProvider` pairs the two.
//
// WHY A DIRECT FETCH RATHER THAN THE SDK. The ElevenLabs SDK pulls a large
// dependency tree for what is one POST returning audio bytes. `fetch` is
// already available, the request is fully specified below, and the failure
// classification we need is per-status — which the SDK would wrap and hide.
//
// THE API KEY NEVER LEAVES THIS PROCESS. It is read from the environment, held
// on the instance, sent only in the `xi-api-key` request header, and is never
// returned, logged, or included in an error. `toVoiceError` maps a provider
// failure to a coarse category precisely so that a provider body — which can
// echo request details — never travels outward.
// ---------------------------------------------------------------------------

import {
  JarvisError,
  SPEECH_FORMAT_MIME_TYPES,
  type SpeechAudioFormat,
  type TranscriptionResult,
} from "@jarvis/core";

const API_BASE = "https://api.elevenlabs.io/v1";

/**
 * Multilingual, because the operator speaks Hinglish and a monolingual English
 * model mangles the Hindi words in a Latin-script sentence.
 */
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

/** 128 kbps at 44.1 kHz — indistinguishable from higher for speech, half the bytes. */
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Delivery settings.
 *
 * `stability` low enough to stay expressive, high enough not to wander between
 * sentences. `similarityBoost` high, so the chosen voice stays recognisably
 * itself. `style` deliberately restrained — this is an assistant giving
 * answers, not a performance. `speed` fractionally under 1 because the voice
 * reads numbers and dates, and those need a moment to land.
 */
const DEFAULT_SETTINGS = {
  stability: 0.62,
  similarityBoost: 0.88,
  style: 0.18,
  useSpeakerBoost: true,
  speed: 0.94,
} as const;

/** Output formats mapped to what the browser must be told they are. */
const FORMAT_MIME: Readonly<Record<string, string>> = Object.freeze({
  mp3_44100_128: "audio/mpeg",
  mp3_44100_64: "audio/mpeg",
  mp3_22050_32: "audio/mpeg",
  pcm_16000: "audio/wave",
  pcm_22050: "audio/wave",
  pcm_44100: "audio/wave",
  ulaw_8000: "audio/basic",
});

export interface ElevenLabsVoiceConfig {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speakerBoost?: boolean;
  speed?: number;
  timeoutMs?: number;
  /** Injected in tests. Never set in production. */
  fetchImpl?: typeof fetch;
}

/**
 * Maps a provider failure onto a JarvisError.
 *
 * Only a coarse classification crosses this boundary. An ElevenLabs error body
 * can restate the request and name the voice and model; none of that belongs in
 * front of a user, and a 401 body in particular must never be echoed because it
 * is a response to a credential.
 */
function toVoiceError(status: number | undefined, detail?: string): JarvisError {
  if (status === 401 || status === 403) {
    return new JarvisError(
      "TOOL_UNAVAILABLE",
      "Speech synthesis is not authorized. Check the ElevenLabs API key on the server."
    );
  }
  if (status === 404) {
    // Almost always a voice id that does not exist on this account.
    return new JarvisError(
      "INVALID_REQUEST",
      "The configured ElevenLabs voice was not found for this account."
    );
  }
  if (status === 422) {
    return new JarvisError("INVALID_REQUEST", "ElevenLabs rejected the speech request.");
  }
  if (status === 429) {
    return new JarvisError(
      "TOOL_RATE_LIMITED",
      "Speech synthesis is rate limited or the ElevenLabs quota is exhausted."
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

export class ElevenLabsVoiceProvider {
  readonly id = "elevenlabs-voice";
  readonly name = "ElevenLabs";
  /** No STT here. See the header — transcription stays on whisper-1. */
  readonly sttModel = "unsupported";
  readonly ttsModel: string;
  readonly defaultVoice: string;

  /**
   * A TRUE private field, not `private readonly`.
   *
   * TypeScript's `private` is compile-time only: the property is an ordinary
   * enumerable own-property at runtime, so `JSON.stringify(provider)` includes
   * the API key. That is one careless debug endpoint or error dump away from
   * leaking a credential. `#apiKey` is invisible to `JSON.stringify`,
   * `Object.keys` and spread, so the leak is impossible rather than merely
   * avoided. Caught by the test that serialises the instance.
   */
  #apiKey: string;
  private readonly outputFormat: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly settings: {
    stability: number;
    similarity_boost: number;
    style: number;
    use_speaker_boost: boolean;
    speed: number;
  };

  constructor(config: ElevenLabsVoiceConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "ElevenLabs API key is required. Set ELEVENLABS_API_KEY on the server."
      );
    }
    const voiceId = config.voiceId ?? process.env.ELEVENLABS_VOICE_ID;
    if (!voiceId) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "ElevenLabs voice id is required. Set ELEVENLABS_VOICE_ID on the server."
      );
    }

    this.#apiKey = apiKey;
    this.defaultVoice = voiceId;
    this.ttsModel = config.modelId ?? process.env.ELEVENLABS_MODEL_ID ?? DEFAULT_MODEL_ID;
    this.outputFormat =
      config.outputFormat ?? process.env.ELEVENLABS_OUTPUT_FORMAT ?? DEFAULT_OUTPUT_FORMAT;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as typeof fetch);

    const num = (v: number | undefined, env: string | undefined, fallback: number): number => {
      const raw = v ?? (env !== undefined ? Number(env) : undefined);
      return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
    };

    this.settings = {
      stability: num(config.stability, process.env.ELEVENLABS_STABILITY, DEFAULT_SETTINGS.stability),
      similarity_boost: num(
        config.similarityBoost,
        process.env.ELEVENLABS_SIMILARITY_BOOST,
        DEFAULT_SETTINGS.similarityBoost
      ),
      style: num(config.style, process.env.ELEVENLABS_STYLE, DEFAULT_SETTINGS.style),
      use_speaker_boost:
        config.speakerBoost ??
        (process.env.ELEVENLABS_SPEAKER_BOOST
          ? process.env.ELEVENLABS_SPEAKER_BOOST !== "false"
          : DEFAULT_SETTINGS.useSpeakerBoost),
      speed: num(config.speed, process.env.ELEVENLABS_SPEED, DEFAULT_SETTINGS.speed),
    };
  }

  /**
   * Not supported here, and it says so rather than pretending.
   *
   * `CompositeVoiceProvider` routes transcription to whisper-1, so this is only
   * reachable if something wires ElevenLabs up alone by mistake — in which case
   * a clear error is far better than a silent empty transcript.
   */
  async transcribe(): Promise<TranscriptionResult> {
    throw new JarvisError(
      "TOOL_UNAVAILABLE",
      "ElevenLabs is configured for speech synthesis only; transcription uses a different provider."
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
    const voice = input.voice ?? this.defaultVoice;

    // The caller's `format` is the JARVIS-level format (mp3/opus/…). The
    // provider takes its own richer string, so the configured output format
    // wins unless the caller explicitly asked for something else.
    const format: SpeechAudioFormat = input.format ?? "mp3";
    const providerFormat = input.format && input.format !== "mp3" ? input.format : this.outputFormat;

    // Timeout and caller cancellation are combined: whichever fires first
    // aborts the request. Without the caller's signal a stopped playback would
    // leave the request running and still be billed for.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    const onAbort = () => controller.abort(new Error("aborted"));
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.fetchImpl(
        `${API_BASE}/text-to-speech/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(providerFormat)}`,
        {
          method: "POST",
          headers: {
            // The ONLY place the key appears. Never a query parameter, which
            // would land in provider access logs and in any proxy in between.
            "xi-api-key": this.#apiKey,
            "content-type": "application/json",
            accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: input.text,
            model_id: this.ttsModel,
            voice_settings: this.settings,
          }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        // The body is READ AND DISCARDED. Reading it frees the socket; keeping
        // it would risk a provider message reaching a user.
        await response.text().catch(() => "");
        throw toVoiceError(response.status);
      }

      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) {
        throw toVoiceError(undefined, "empty");
      }

      return {
        audio,
        mimeType: FORMAT_MIME[providerFormat] ?? SPEECH_FORMAT_MIME_TYPES[format],
        model: this.ttsModel,
        voice,
        format,
      };
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
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Cheap reachability probe.
   *
   * `GET /user` rather than synthesizing a sample: a health check should not
   * consume character quota, and the credential and network failures this is
   * asked about show up identically either way.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${API_BASE}/user`, {
        headers: { "xi-api-key": this.#apiKey },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
