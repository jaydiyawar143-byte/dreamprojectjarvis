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
  timeoutMs?: number;
}

const DEFAULT_STT_MODEL = "whisper-1";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "alloy";
const DEFAULT_TIMEOUT_MS = 30_000;

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
          ...(input.language ? { language: input.language } : {}),
          response_format: "json",
        },
        { signal: input.signal }
      );

      return {
        // Trimmed because the recognizer pads short utterances with leading
        // whitespace, and the transcript is shown to the user verbatim.
        text: (response.text ?? "").trim(),
        model: this.sttModel,
        ...(input.language ? { language: input.language } : {}),
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
