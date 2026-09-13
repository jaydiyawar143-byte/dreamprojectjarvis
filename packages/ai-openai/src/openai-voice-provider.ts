// ---------------------------------------------------------------------------
// Sprint 8.1 / 8.2 — OpenAI speech provider.
//
// Implements the `IVoiceProvider` contract Sprint 8.0 declared: audio in,
// transcript out; text in, audio out. Nothing here knows about conversations,
// agents or approvals — a transcript is handed back to the caller, and the
// caller sends it through the ordinary chat pipeline.
//
// Built alongside `OpenAIEmbeddingProvider` and constructed the same way, on
// the same `OPENAI_API_KEY`. No second credential and no new dependency: the
// `openai` package already carries both audio endpoints.
// ---------------------------------------------------------------------------

import OpenAI from "openai";
import {
  JarvisError,
  SPEECH_FORMAT_MIME_TYPES,
  type IVoiceProvider,
  type SpeechAudioFormat,
  type TranscriptionResult,
} from "@jarvis/core";

export interface OpenAIVoiceConfig {
  apiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  defaultVoice?: string;
  /** Delivery direction for the voice. Ignored by the older tts-1 models. */
  ttsInstructions?: string;
  /**
   * Playback rate, 0.25–4.0. Applied ONLY on models that accept it — see
   * `MODELS_SUPPORTING_SPEED`. On `gpt-4o-mini-tts` pace is steered through
   * `ttsInstructions` instead, because the parameter is rejected there.
   */
  ttsSpeed?: number;
  /** Default BCP-47 hint. A per-request `language` still wins. */
  sttLanguage?: string;
  timeoutMs?: number;
}

/**
 * Speech-to-text default.
 *
 * Kept as `whisper-1` after measuring the alternatives — see
 * DEFAULT_STT_LANGUAGE, which is where the accuracy problem actually was.
 *
 * `gpt-4o-mini-transcribe` is about 550ms faster per turn, and was tried for
 * exactly that reason. It transcribed this operator's Hinglish into DEVANAGARI
 * on 10 of 18 fixture runs, with or without a language hint, where whisper-1
 * with the hint managed 18 of 18 in Latin script. Half a second is not worth a
 * transcript the intent rules cannot read.
 */
const DEFAULT_STT_MODEL = "whisper-1";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";

/**
 * Text-to-speech default.
 *
 * WHY THIS CHANGED. `onyx` was chosen for gravitas, and it delivers gravitas —
 * but paired with the old "measured, unhurried" instructions it read as tired.
 * Deep timbre plus a slow directive plus a downward inflection on every clause
 * is, acoustically, what a sleepy person sounds like. The operator's report was
 * "sleepy, slow, monotone", and that is the combination that produced it.
 *
 * `ash` keeps the professional, grounded register without the heaviness: a
 * brighter fundamental with clear articulation, which reads as alert rather
 * than either drowsy or chirpy. Override with `OPENAI_TTS_VOICE` — this is a
 * taste decision and an operator may disagree.
 */
const DEFAULT_VOICE = "ash";

/**
 * How the voice should carry, not what it should say.
 *
 * This steers DELIVERY only — pace, weight, inflection — and is fixed
 * server-side. It is never assembled from a request, because it is text going
 * into a provider call and a caller-supplied one would be a way to put words
 * in JARVIS's mouth.
 *
 * THE TIRED VOICE WAS WRITTEN HERE. The previous direction opened "Speak with
 * calm authority... Measured, unhurried pace" and closed "never chirpy". Every
 * clause of it pushes the same way — slower, lower, flatter — and
 * `gpt-4o-mini-tts` follows delivery direction closely, so it did exactly as it
 * was told. Nothing was broken; the model was faithfully performing a
 * description of someone winding down. An operator can still restore any
 * delivery they prefer via `OPENAI_TTS_INSTRUCTIONS`.
 */
const DEFAULT_TTS_INSTRUCTIONS =
  "Speak with confident, energetic, alert delivery. Maintain a natural conversational rhythm " +
  "with clear pronunciation and short intentional pauses. Sound like a highly capable personal " +
  "AI assistant who is ready to help immediately. Avoid sounding sleepy, tired, sad, monotone, " +
  "robotic, or overly dramatic. Keep a medium-fast pace — brisk and purposeful, never rushed " +
  "and never dragging. Land statements with assurance. Read numbers, dates and names crisply " +
  "and distinctly. Stay professional and engaged; do not shout and do not gush.";

/**
 * Default language hint.
 *
 * This is the fix for the transcription defect, and it costs nothing.
 *
 * The operator speaks Hinglish — Hindi words, Latin script, English nouns. Left
 * to detect the language itself, whisper-1 decided the speech was URDU and
 * wrote it in Arabic script: "Balaghat mein best restaurants dikhao" came back
 * as "بلگ ہاتھ میں بیسٹ ریسٹرانٹز دکھاؤ". Every downstream intent rule matches
 * on Latin text, so that is not a cosmetic problem — a perfectly clear request
 * became unroutable, and the user got an answer to something they had not
 * asked. Measured over 18 fixture runs: 12 of 18 in Latin script without the
 * hint, 18 of 18 with it, at the same latency.
 *
 * A per-request `language` still wins, and `OPENAI_STT_LANGUAGE` sets a
 * different default for a deployment whose operator speaks something else.
 */
const DEFAULT_STT_LANGUAGE = "en";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Which TTS models actually accept `speed`.
 *
 * `gpt-4o-mini-tts` — the default here — does NOT: OpenAI documents speed as
 * not supported on it, and sending it earns a 400 that fails the whole
 * synthesis. So this is a real provider limitation, not an oversight, and the
 * parameter is gated rather than "supported everywhere" and silently breaking
 * the default path. Pace on that model is a delivery instruction, which is why
 * DEFAULT_TTS_INSTRUCTIONS names a medium-fast pace explicitly.
 */
const MODELS_SUPPORTING_SPEED: ReadonlySet<string> = new Set(["tts-1", "tts-1-hd"]);

/** Provider-documented bounds. Anything outside is a 400 from the API. */
const MIN_SPEED = 0.25;
const MAX_SPEED = 4.0;

/**
 * Energetic but not comic. Only ever reaches a model that accepts it, so the
 * default path (gpt-4o-mini-tts) is unaffected by this value.
 */
const DEFAULT_SPEED = 1.1;

export function supportsSpeed(model: string): boolean {
  return MODELS_SUPPORTING_SPEED.has(model);
}

/** Clamped rather than rejected: a bad env var should not disable speech. */
function clampSpeed(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, value));
}

/**
 * Extension the upload is presented to the provider with.
 *
 * Whisper decides how to decode from the FILENAME, not from the multipart
 * content type, so a WebM recording sent as `audio.bin` is rejected as an
 * unsupported format even though the bytes are fine.
 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mpga": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/flac": "flac",
});

function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_EXTENSIONS[base] ?? "webm";
}

/**
 * Maps a provider failure onto a JarvisError.
 *
 * Provider errors carry request ids, org ids and occasionally fragments of the
 * request itself. Only a coarse classification crosses this boundary; the
 * detail stays in the server log where it belongs.
 */
function toVoiceError(err: unknown, operation: "transcription" | "synthesis"): JarvisError {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status: unknown }).status)
      : undefined;

  if (status === 401 || status === 403) {
    return new JarvisError("TOOL_UNAVAILABLE", `Speech ${operation} is not authorized`);
  }
  if (status === 429) {
    return new JarvisError("TOOL_RATE_LIMITED", `Speech ${operation} was rate limited`);
  }
  if (status !== undefined && status >= 500) {
    return new JarvisError("TOOL_UNAVAILABLE", `Speech ${operation} provider is unavailable`);
  }
  if (status === 400 || status === 415) {
    return new JarvisError("INVALID_REQUEST", `Speech ${operation} rejected the input`);
  }
  return new JarvisError("TOOL_EXECUTION_FAILED", `Speech ${operation} failed`);
}

export class OpenAIVoiceProvider implements IVoiceProvider {
  readonly id = "openai-voice";
  readonly name = "OpenAI Voice";
  readonly sttModel: string;
  readonly ttsModel: string;
  readonly defaultVoice: string;

  private readonly client: OpenAI;
  private readonly ttsInstructions: string;
  private readonly ttsSpeed: number | undefined;
  private readonly sttLanguage: string;

  constructor(config: OpenAIVoiceConfig = {}) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "OpenAI API key is required. Set OPENAI_API_KEY environment variable."
      );
    }

    this.sttModel = config.sttModel ?? process.env.OPENAI_STT_MODEL ?? DEFAULT_STT_MODEL;
    this.ttsModel = config.ttsModel ?? process.env.OPENAI_TTS_MODEL ?? DEFAULT_TTS_MODEL;
    this.defaultVoice =
      config.defaultVoice ?? process.env.OPENAI_TTS_VOICE ?? DEFAULT_VOICE;
    this.ttsInstructions =
      config.ttsInstructions ??
      process.env.OPENAI_TTS_INSTRUCTIONS ??
      DEFAULT_TTS_INSTRUCTIONS;
    this.sttLanguage =
      config.sttLanguage ?? process.env.OPENAI_STT_LANGUAGE ?? DEFAULT_STT_LANGUAGE;

    const envSpeed = process.env.OPENAI_TTS_SPEED
      ? Number(process.env.OPENAI_TTS_SPEED)
      : undefined;
    this.ttsSpeed = clampSpeed(config.ttsSpeed ?? envSpeed ?? DEFAULT_SPEED);

    this.client = new OpenAI({
      apiKey,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Retries are the caller's decision. A speech request sits in front of a
      // waiting human, and a silent internal retry doubles the latency they
      // experience with no way to cancel it.
      maxRetries: 0,
    });
  }

  async transcribe(input: {
    audio: Buffer;
    mimeType: string;
    fileName?: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult> {
    const startedAt = Date.now();

    try {
      const file = await OpenAI.toFile(
        input.audio,
        input.fileName ?? `speech.${extensionFor(input.mimeType)}`,
        { type: input.mimeType.split(";")[0]?.trim() }
      );

      const response = await this.client.audio.transcriptions.create(
        {
          file,
          model: this.sttModel,
          // A caller-supplied language wins; otherwise the configured default.
          ...(input.language || this.sttLanguage
            ? { language: input.language || this.sttLanguage }
            : {}),
          response_format: "json",
        },
        { signal: input.signal }
      );

      return {
        // Trimmed because the recognizer pads short utterances with leading
        // whitespace, and the transcript is shown to the user verbatim.
        text: (response.text ?? "").trim(),
        model: this.sttModel,
        // The language actually SENT, not merely the one asked for — a caller
        // reading this back should see what the recognizer was told.
        ...(input.language || this.sttLanguage
          ? { language: input.language || this.sttLanguage }
          : {}),
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (err instanceof JarvisError) throw err;
      throw toVoiceError(err, "transcription");
    }
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
    const format: SpeechAudioFormat = input.format ?? "mp3";
    const voice = input.voice ?? this.defaultVoice;

    try {
      const response = await this.client.audio.speech.create(
        {
          model: this.ttsModel,
          voice,
          input: input.text,
          response_format: format,
          // The two delivery controls are mutually exclusive by provider
          // support, so each is sent only where it exists.
          //
          // `instructions` is a gpt-4o-mini-tts capability; tts-1 and tts-1-hd
          // ignore it, so sending it costs an operator on an older model
          // nothing.
          //
          // `speed` is the inverse: accepted by the tts-1 family, REJECTED with
          // a 400 by gpt-4o-mini-tts. Gating it on the model is what lets an
          // operator on tts-1 tune the rate without breaking the default.
          ...(this.ttsInstructions ? { instructions: this.ttsInstructions } : {}),
          ...(this.ttsSpeed !== undefined && supportsSpeed(this.ttsModel)
            ? { speed: this.ttsSpeed }
            : {}),
        },
        { signal: input.signal }
      );

      const audio = Buffer.from(await response.arrayBuffer());

      return {
        audio,
        mimeType: SPEECH_FORMAT_MIME_TYPES[format],
        model: this.ttsModel,
        voice,
        format,
      };
    } catch (err) {
      if (err instanceof JarvisError) throw err;
      throw toVoiceError(err, "synthesis");
    }
  }

  /**
   * Cheap reachability probe.
   *
   * Lists models rather than synthesizing a sample: a health check should not
   * bill for audio, and credential or network failures — the things this is
   * asked about — show up identically on either call.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
