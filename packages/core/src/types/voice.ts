// ---------------------------------------------------------------------------
// Sprint 8.0 — Voice contracts.
//
// Voice is an INTERACTION LAYER over the existing JARVIS pipeline, not a second
// AI system. Nothing in this file knows about agents, tools, memory or
// approvals: a spoken turn becomes text, that text goes through the same
// `POST /api/v1/chat` a typed turn goes through, and the reply comes back out
// as audio. Every security property — routing, tool allowlists, permissions,
// approval gates, tenant isolation, audit — is inherited from that pipeline
// precisely because voice does not reimplement it.
//
// This module is types and pure data only. Providers, routes and UI arrive in
// later phases and consume what is declared here.
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Approval safety policy — LOCKED Sprint 8 decision
// ---------------------------------------------------------------------------

/**
 * Voice may propose an approval-gated action. It may never confirm one.
 *
 * `detectIntent` treats "yes" / "haan" / "go ahead" as CONFIRM, which executes
 * a real external write — a Meta budget change, a WhatsApp send. Speech
 * recognition is lossy in exactly the way that matters here: "no" misheard as
 * "yo", a second person talking in the room, a television in the background.
 * A typed confirmation carries a keystroke behind it; a transcribed one does
 * not, and the action is irreversible.
 *
 * So the approval boundary keeps a hand on it. Voice can read the proposal
 * aloud; committing to it requires an explicit on-screen action.
 *
 * This is a locked decision, not a default to be tuned away. Any future
 * relaxation is a deliberate product change with its own security review.
 */
export const VOICE_APPROVAL_POLICY = Object.freeze({
  /** Voice input can never resolve a pending action into an execution. */
  canConfirmPendingActions: false,
  /** Approval-gated operations require an explicit on-screen confirmation. */
  requiresOnScreenConfirmation: true,
} as const);

// ---------------------------------------------------------------------------
// Client state machine
// ---------------------------------------------------------------------------

/**
 * The states a voice turn can occupy on the client.
 *
 * Sprint 8 is push-to-talk only: every transition out of `idle` begins with a
 * deliberate user gesture. There is no wake word and no always-listening mode,
 * so there is no state for "waiting to be addressed".
 */
export const VoiceStateSchema = z.enum([
  /** Nothing happening. The microphone is released. */
  "idle",
  /** `getUserMedia` has been called and the browser is prompting. */
  "requesting-permission",
  /** Recording. The user is speaking. */
  "listening",
  /** Audio captured; waiting on speech-to-text. */
  "transcribing",
  /** Transcript submitted to the chat pipeline; waiting on the reply. */
  "processing",
  /** Reply audio is playing. Interruptible. */
  "speaking",
  /** The user refused microphone access, or the browser blocked it. */
  "permission-denied",
  /** This browser cannot capture audio at all. */
  "unsupported",
  /** A recoverable failure. Carries a `VoiceErrorCode`. */
  "error",
]);

export type VoiceState = z.infer<typeof VoiceStateSchema>;

/**
 * Legal transitions.
 *
 * Declared as data rather than left to whichever component calls `setState`,
 * so the UI cannot land somewhere incoherent — "speaking" while the microphone
 * is still open, or "listening" straight out of an unhandled error.
 *
 * Note `speaking -> listening` is absent on purpose: barge-in stops playback
 * and returns to `idle`, and starting a new turn is then a fresh user gesture.
 * Chaining straight from speaking into listening is what turns push-to-talk
 * into open-mic by accident.
 */
export const VOICE_STATE_TRANSITIONS: Readonly<
  Record<VoiceState, readonly VoiceState[]>
> = Object.freeze({
  idle: ["requesting-permission", "listening", "unsupported", "error"],
  "requesting-permission": ["listening", "permission-denied", "error", "idle"],
  listening: ["transcribing", "idle", "error"],
  transcribing: ["processing", "idle", "error"],
  processing: ["speaking", "idle", "error"],
  // Barge-in and natural end both land on idle.
  speaking: ["idle", "error"],
  "permission-denied": ["idle", "requesting-permission"],
  // Terminal for the session: a browser without capture support will not gain
  // it on the next click.
  unsupported: [],
  error: ["idle", "requesting-permission"],
} as const);

/** Whether `to` may be entered from `from`. */
export function canTransitionVoiceState(from: VoiceState, to: VoiceState): boolean {
  return VOICE_STATE_TRANSITIONS[from].includes(to);
}

/**
 * States in which a turn is underway.
 *
 * Used to disable the composer and to decide whether a mic press means "start"
 * or "stop", so the two paths cannot disagree about what busy means.
 */
export function isVoiceBusy(state: VoiceState): boolean {
  return (
    state === "requesting-permission" ||
    state === "listening" ||
    state === "transcribing" ||
    state === "processing" ||
    state === "speaking"
  );
}

// ---------------------------------------------------------------------------
// Audio formats
// ---------------------------------------------------------------------------

/**
 * Container types accepted for upload.
 *
 * Browsers disagree about what `MediaRecorder` produces — Chromium gives
 * WebM/Opus, Safari gives MP4/AAC — so both have to be first-class rather than
 * one being the format and the other a workaround.
 */
export const SUPPORTED_AUDIO_MIME_TYPES = Object.freeze([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/mpga",
  "audio/wav",
  "audio/x-wav",
  "audio/m4a",
  "audio/x-m4a",
  "audio/flac",
] as const);

export type SupportedAudioMimeType = (typeof SUPPORTED_AUDIO_MIME_TYPES)[number];

/**
 * Strips codec and other parameters from a media type.
 *
 * `MediaRecorder` reports `audio/webm;codecs=opus`, which is a correct media
 * type and not a member of the list above. Comparing the raw string would
 * reject every real recording Chromium produces.
 */
export function normalizeAudioMimeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const base = value.split(";")[0]?.trim().toLowerCase();
  return base && base.length > 0 ? base : null;
}

/** Whether an upload's media type is one this system will send to a provider. */
export function isSupportedAudioMimeType(value: unknown): boolean {
  const normalized = normalizeAudioMimeType(value);
  if (normalized === null) return false;
  return (SUPPORTED_AUDIO_MIME_TYPES as readonly string[]).includes(normalized);
}

/** Output containers a synthesis request may ask for. */
export const SpeechAudioFormatSchema = z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]);
export type SpeechAudioFormat = z.infer<typeof SpeechAudioFormatSchema>;

/** Media type to serve each synthesis format back as. */
export const SPEECH_FORMAT_MIME_TYPES: Readonly<Record<SpeechAudioFormat, string>> =
  Object.freeze({
    mp3: "audio/mpeg",
    opus: "audio/ogg",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    pcm: "audio/L16",
  } as const);

// ---------------------------------------------------------------------------
// Transcription (speech -> text)
// ---------------------------------------------------------------------------

/**
 * An upload of captured audio.
 *
 * Audio travels as base64 inside a JSON body, matching the Sprint 3 knowledge
 * upload: it needs no multipart dependency and works with the app-wide
 * `express.json` parser already mounted.
 *
 * `conversationId` is carried for audit correlation ONLY. Transcription does
 * not read or write conversation state — the transcript reaches the pipeline
 * through the ordinary chat endpoint, which is what keeps memory, routing and
 * approvals in one place.
 */
export const TranscriptionRequestSchema = z.object({
  /** Base64-encoded audio bytes. */
  audio: z.string().min(1, "audio is required"),
  /** Media type as reported by the recorder, codec parameters permitted. */
  mimeType: z.string().min(1, "mimeType is required"),
  /** Recorded length, when the client measured it. Audit and telemetry only. */
  durationMs: z.number().int().nonnegative().optional(),
  /** BCP-47 hint for the recognizer. Omit to let the provider detect. */
  language: z.string().min(2).max(16).optional(),
  /** For audit correlation. Never used to load or mutate conversation state. */
  conversationId: z.string().optional(),
  /**
   * The client's id for the spoken turn this upload belongs to.
   *
   * Audit correlation only, and bounded so it cannot be used to write arbitrary
   * text into the audit log. It lets a client-side trace — "this turn was
   * retired before its transcript came back" — be matched against the server's
   * record of the same request, which is the only way to tell a dropped reply
   * from one that was never produced.
   */
  requestId: z.string().max(64).optional(),
});

export type TranscriptionRequest = z.infer<typeof TranscriptionRequestSchema>;

/**
 * What the recognizer heard.
 *
 * An empty `text` is a legitimate outcome — silence, a stray tap, a cough —
 * and is reported as such rather than as a failure, so the UI can say "I didn't
 * catch that" instead of showing an error.
 */
export const TranscriptionResultSchema = z.object({
  text: z.string(),
  model: z.string(),
  /** Length of the audio the provider processed, when it reports one. */
  durationMs: z.number().int().nonnegative().optional(),
  language: z.string().optional(),
  /** Wall-clock time spent in transcription, for telemetry. */
  latencyMs: z.number().int().nonnegative().optional(),
});

export type TranscriptionResult = z.infer<typeof TranscriptionResultSchema>;

// ---------------------------------------------------------------------------
// Synthesis (text -> speech)
// ---------------------------------------------------------------------------

/**
 * A request to speak some text.
 *
 * Deliberately stateless. It does not resolve a message id, does not touch the
 * conversation, and grants no capability — which also means an authenticated
 * caller could use it as a general text-to-speech service. That is why the
 * character ceiling, rate limiting and audit trail around it are not optional.
 */
export const SpeechSynthesisRequestSchema = z.object({
  text: z.string().min(1, "text is required"),
  /** Provider voice name. Falls back to the server default when omitted. */
  voice: z.string().optional(),
  format: SpeechAudioFormatSchema.optional(),
  /** For audit correlation only. */
  conversationId: z.string().optional(),
  /** The client's id for the spoken turn. Audit correlation only. */
  requestId: z.string().max(64).optional(),
});

export type SpeechSynthesisRequest = z.infer<typeof SpeechSynthesisRequestSchema>;

export const SpeechSynthesisResultSchema = z.object({
  /** Base64-encoded audio bytes. */
  audio: z.string(),
  mimeType: z.string(),
  model: z.string(),
  voice: z.string(),
  format: SpeechAudioFormatSchema,
  /** Characters actually synthesized, after any server-side clamping. */
  characterCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative().optional(),
});

export type SpeechSynthesisResult = z.infer<typeof SpeechSynthesisResultSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every way a voice turn can fail.
 *
 * Enumerated rather than left to free-text messages because the UI owes the
 * user a different response to each one: a denied microphone needs browser
 * instructions, an empty transcript needs "say that again", a provider outage
 * needs "try again shortly", and an unsupported browser needs the composer.
 */
export const VoiceErrorCodeSchema = z.enum([
  /** The deployment has voice switched off, or it is not configured. */
  "VOICE_DISABLED",
  /** The user declined microphone access, or policy blocked it. */
  "VOICE_PERMISSION_DENIED",
  /** No capture API, or an insecure context. */
  "VOICE_UNSUPPORTED_BROWSER",
  /** The upload's container type is not one we accept. */
  "VOICE_UNSUPPORTED_FORMAT",
  /** Upload exceeds the configured byte ceiling. */
  "VOICE_AUDIO_TOO_LARGE",
  /** Upload decoded to nothing, or was not valid base64. */
  "VOICE_AUDIO_INVALID",
  /** Recognition succeeded but heard no words. Not an error condition. */
  "VOICE_TRANSCRIPTION_EMPTY",
  /** The recognizer failed. */
  "VOICE_TRANSCRIPTION_FAILED",
  /** Text to speak was empty. */
  "VOICE_TEXT_EMPTY",
  /** Text to speak exceeds the configured character ceiling. */
  "VOICE_TEXT_TOO_LONG",
  /** Synthesis failed. */
  "VOICE_SYNTHESIS_FAILED",
  /** The upstream speech provider is unreachable or erroring. */
  "VOICE_PROVIDER_UNAVAILABLE",
  /** Too many voice requests in the window. */
  "VOICE_RATE_LIMITED",
  /**
   * A spoken turn tried to confirm an approval-gated action.
   * See `VOICE_APPROVAL_POLICY`.
   */
  "VOICE_APPROVAL_REQUIRES_UI",
]);

export type VoiceErrorCode = z.infer<typeof VoiceErrorCodeSchema>;

/**
 * HTTP status for each failure, so 8.1 and 8.2 answer consistently.
 *
 * `VOICE_TRANSCRIPTION_EMPTY` maps to 200: hearing silence is a successful
 * request whose answer happens to be "nothing was said".
 */
export const VOICE_ERROR_STATUS: Readonly<Record<VoiceErrorCode, number>> =
  Object.freeze({
    VOICE_DISABLED: 404,
    VOICE_PERMISSION_DENIED: 403,
    VOICE_UNSUPPORTED_BROWSER: 400,
    VOICE_UNSUPPORTED_FORMAT: 415,
    VOICE_AUDIO_TOO_LARGE: 413,
    VOICE_AUDIO_INVALID: 400,
    VOICE_TRANSCRIPTION_EMPTY: 200,
    VOICE_TRANSCRIPTION_FAILED: 502,
    VOICE_TEXT_EMPTY: 400,
    VOICE_TEXT_TOO_LONG: 413,
    VOICE_SYNTHESIS_FAILED: 502,
    VOICE_PROVIDER_UNAVAILABLE: 503,
    VOICE_RATE_LIMITED: 429,
    VOICE_APPROVAL_REQUIRES_UI: 409,
  } as const);

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * How a message came to exist, recorded on the existing `Message.metadata`
 * JSON column. No schema migration is needed, and no new table holds anything
 * about a voice turn.
 *
 * `.strict()` is the point of this schema rather than a detail: it rejects any
 * key it does not name, which is what structurally guarantees a recording
 * cannot be smuggled into the conversation record. Sprint 8 stores transcripts
 * and telemetry — never audio.
 */
export const VoiceProvenanceSchema = z
  .object({
    /** Which modality produced the turn. */
    source: z.enum(["voice", "text"]),
    /** Recognizer that produced the transcript. */
    sttModel: z.string().optional(),
    /** Length of the captured audio. */
    audioDurationMs: z.number().int().nonnegative().optional(),
    /** Time spent transcribing. */
    transcriptionMs: z.number().int().nonnegative().optional(),
    /** Whether the assistant reply was read aloud. */
    spoken: z.boolean().optional(),
    ttsModel: z.string().optional(),
    ttsVoice: z.string().optional(),
    ttsCharacterCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export type VoiceProvenance = z.infer<typeof VoiceProvenanceSchema>;

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

/**
 * The speech capabilities the API depends on.
 *
 * Declared here so Sprint 8.1 and 8.2 implement against a contract the routes
 * already expect, and so tests can substitute a fake without a network call or
 * a provider credential. Implementations belong in a provider package, never
 * in a route.
 */
export interface IVoiceProvider {
  readonly id: string;
  readonly name: string;
  readonly sttModel: string;
  readonly ttsModel: string;
  readonly defaultVoice: string;

  transcribe(input: {
    audio: Buffer;
    mimeType: string;
    fileName?: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult>;

  synthesize(input: {
    text: string;
    voice?: string;
    format?: SpeechAudioFormat;
    signal?: AbortSignal;
  }): Promise<{ audio: Buffer; mimeType: string; model: string; voice: string; format: SpeechAudioFormat }>;

  isAvailable(): Promise<boolean>;
}
