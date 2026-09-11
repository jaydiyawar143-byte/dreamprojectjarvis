"use client";

// ---------------------------------------------------------------------------
// Sprint 8.5 — Voice turn orchestration.
//
// This store owns the state machine and nothing else. It does not talk to an
// agent, does not decide which tool runs, and does not touch memory: it turns
// speech into text, hands that text to the EXISTING `useChatStore.sendMessage`,
// and reads the reply back out to speak it.
//
//   mic → transcribe → sendMessage → /api/v1/chat → reply → speak
//
// Everything between `sendMessage` and `reply` is the pipeline that was
// already there. Voice is a shell around it.
//
// A turn HAS AN IDENTITY. That is not decoration: every stage below is an
// await, and during any of them the user can press stop, barge in, or ask
// something else. Without an identity the continuations kept running anyway —
// each one reading the mutable "current" state, each one free to move the
// machine or start audio — and a reply that nobody was waiting for any more
// still got spoken. The fix is small and applies uniformly: take a token at the
// top of the turn, and check it is still the live one before touching anything
// shared. Abandoned work is dropped, loudly enough to show up in the trace.
// ---------------------------------------------------------------------------

import { create } from "zustand";
import {
  VOICE_APPROVAL_POLICY,
  canTransitionVoiceState,
  type VoiceState,
} from "@jarvis/core/voice";
import { getVoiceStatus, synthesizeSpeech, transcribeAudio } from "../api";
import { useChatStore, type ChatTurnResult } from "../chat-store";
import {
  AudioCapture,
  CaptureError,
  isCaptureSupported,
  type CapturedAudio,
} from "./audio-capture";
import { AudioPlayback, PlaybackError } from "./audio-playback";
import { VoiceTurnTrace, nextVoiceRequestId } from "./voice-trace";

// Module-level singletons: the microphone and the audio element are hardware
// and browser resources, not per-render values.
//
// UI V2 — exported so the Orb can analyse the SAME stream and element the voice
// turn is using. Sharing the instances is the point: a second getUserMedia call
// would open a second microphone, and a second audio element would play the
// reply twice.
export const capture = new AudioCapture();
export const playback = new AudioPlayback();

/** A short, plain sentence explaining a failure the user can act on. */
export interface VoiceNotice {
  message: string;
  /** True when nothing went wrong — silence, a mis-tap, a blocked approval. */
  benign: boolean;
}

interface VoiceStoreState {
  state: VoiceState;
  /**
   * Whether this deployment has voice at all.
   *
   * `null` until checked. The routes are feature-gated server-side, so a
   * deployment with voice off answers 404 and the microphone never appears —
   * the UI asks rather than assuming.
   */
  available: boolean | null;
  maxTtsChars: number;
  /** What the recognizer heard on the current or most recent turn. */
  transcript: string;
  notice: VoiceNotice | null;
  /** Whether replies are read aloud. Persists across turns. */
  autoSpeak: boolean;

  checkAvailability: () => Promise<void>;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  cancel: () => void;
  stopSpeaking: () => void;
  toggleAutoSpeak: () => void;
  dismissNotice: () => void;
}

// ---------------------------------------------------------------------------
// Turn identity
// ---------------------------------------------------------------------------

/**
 * One spoken turn, from the microphone press to the last word of the reply.
 *
 * `abort` is not a nicety. A turn the user has replaced is still holding a
 * transcription, a chat round trip and a synthesis open; cancelling them frees
 * the provider budget and, more importantly, makes it impossible for their
 * continuations to do anything at all.
 */
interface VoiceTurn {
  requestId: string;
  conversationId: string | null;
  trace: VoiceTurnTrace;
  abort: AbortController;
  endTurn: (detail?: Record<string, unknown>) => number;
}

/**
 * The turn currently entitled to move the state machine and make sound.
 *
 * Module-level rather than in the store: it is machinery, not view state, and
 * nothing should re-render because a turn was superseded.
 */
let activeTurn: VoiceTurn | null = null;

function isCurrentTurn(turn: VoiceTurn): boolean {
  return activeTurn === turn;
}

/**
 * Ends whatever turn is in flight.
 *
 * Called before a new turn starts and by every explicit stop. Aborting the
 * controller is what actually stops the pending network work; clearing
 * `activeTurn` is what stops its continuations from being believed.
 */
function retireActiveTurn(reason: string): void {
  const turn = activeTurn;
  if (!turn) return;
  activeTurn = null;
  // A turn that ran to the end is not a dropped one. The distinction matters:
  // a `drop` record is the evidence that abandoned work was caught, and it
  // would mean nothing if every normal turn produced one too.
  if (reason !== "completed") turn.trace.drop("turn", reason);
  turn.endTurn({ outcome: reason });
  turn.abort.abort();
}

/**
 * Whether the conversation is waiting on an approval decision.
 *
 * Read from the chat store's own messages rather than tracked separately, so
 * there is one source of truth about whether an action is pending.
 */
function hasPendingApproval(): boolean {
  const messages = useChatStore.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const pending = (message.metadata as Record<string, unknown> | undefined)
      ?.pendingAction as { state?: string } | undefined;
    if (pending) return pending.state === "WAITING_CONFIRMATION";
  }
  return false;
}

// The reply used to be located here, by scanning `useChatStore.messages`
// backwards for the last assistant message with content. That is an
// association by POSITION, and position is not identity:
//
//   - a turn whose reply was empty skipped past its own answer and read the
//     PREVIOUS one aloud;
//   - a turn whose chat leg was slow (and the chat leg is measured in seconds,
//     occasionally in tens of seconds) found a newer turn's answer instead.
//
// `sendMessage` now returns the reply it produced, so a turn speaks its own
// answer and no other. Nothing scans the array any more.

/**
 * Strips the markdown a reply is written in.
 *
 * Speaking raw markdown produces "star star Summary star star", which is worse
 * than useless. This is presentation, not content: the message shown on screen
 * is untouched.
 */
export function textForSpeech(markdown: string, limit = 4000): string {
  const spoken = markdown
    .replace(/```[\s\S]*?```/g, " (code block omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (spoken.length <= limit) return spoken;
  // Cut at a sentence boundary so the reply does not stop mid-word.
  const truncated = spoken.slice(0, limit);
  const lastStop = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? ")
  );
  return lastStop > limit * 0.5 ? truncated.slice(0, lastStop + 1) : truncated;
}

// ---------------------------------------------------------------------------
// Speaking a reply in pieces
// ---------------------------------------------------------------------------

/**
 * Below this a reply is spoken in one piece.
 *
 * Splitting it would spend a second request and an audible seam to save a few
 * hundred milliseconds nobody would notice.
 */
const SPLIT_THRESHOLD_CHARS = 200;

/**
 * How much the opening segment must carry before it is worth sending alone.
 *
 * "Yes." is a complete sentence and a terrible segment: a whole round trip for
 * a third of a second of audio, and a seam right at the start of the answer.
 * Sentences are gathered until the opening is at least this substantial, then
 * it goes — it is the piece the user is waiting through silence for.
 */
const LEAD_MIN_CHARS = 25;
/** Later segments are large — they are synthesized while the lead is playing. */
const TAIL_SEGMENT_CHARS = 1500;
/**
 * Cap on requests per reply.
 *
 * Each segment is a rate-limited, billed synthesis call. Two or three buys
 * nearly all of the latency there is to win; a dozen would only multiply the
 * cost and the chance of one of them failing mid-sentence.
 */
const MAX_SEGMENTS = 3;

/**
 * Splits a reply so the first sentence can be spoken while the rest is still
 * being generated.
 *
 * Measured: a 245-character answer took 3134ms to synthesize whole, and 1720ms
 * for its first sentence alone — the user hears JARVIS begin 45% sooner, and
 * the remainder is generated during the seconds the opening takes to say, so
 * nothing is added to the end.
 *
 * Splits only at sentence boundaries. A segment that ended mid-clause would be
 * audible as a wrong-sounding pause, which is worse than the wait it saved.
 */
export function splitForSpeech(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= SPLIT_THRESHOLD_CHARS) return [trimmed];

  // Sentence ends, plus paragraph breaks — a heading followed by a line of
  // prose has no full stop between them but is certainly a place to breathe.
  // `।` is the Devanagari full stop; replies here are routinely Hinglish.
  const boundary = /(?<=[.!?।])\s+|\n{2,}/g;
  const sentences = trimmed.split(boundary).filter((s) => s.trim().length > 0);
  if (sentences.length <= 1) return [trimmed];

  const segments: string[] = [];
  let current = "";

  for (const raw of sentences) {
    const sentence = raw.trim();

    // The opening: close it at the first sentence end that carries enough to
    // be worth saying on its own.
    if (segments.length === 0) {
      if (current.length >= LEAD_MIN_CHARS) {
        segments.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
      continue;
    }

    // The remainder: large pieces, because they are generated during the
    // seconds the opening takes to say and cost the listener nothing.
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (current && candidate.length > TAIL_SEGMENT_CHARS && segments.length < MAX_SEGMENTS - 1) {
      segments.push(current);
      current = sentence;
      continue;
    }
    current = candidate;
  }

  if (current) segments.push(current);
  return segments;
}

export const useVoiceStore = create<VoiceStoreState>((set, get) => {
  /**
   * Moves the machine, refusing illegal moves.
   *
   * The transition table lives in @jarvis/core, so the UI cannot invent a
   * state the contract does not allow — "listening" straight out of
   * "speaking", for instance, which is how push-to-talk quietly becomes an
   * open microphone.
   */
  const go = (next: VoiceState, patch: Partial<VoiceStoreState> = {}): boolean => {
    const current = get().state;
    if (current === next) {
      set(patch);
      return true;
    }
    if (!canTransitionVoiceState(current, next)) return false;
    set({ state: next, ...patch });
    return true;
  };

  const toIdle = (notice: VoiceNotice | null = null) => {
    if (!go("idle", { notice })) set({ state: "idle", notice });
  };

  const toError = (message: string) => {
    if (!go("error", { notice: { message, benign: false } })) {
      set({ state: "error", notice: { message, benign: false } });
    }
  };

  return {
    state: "idle",
    available: null,
    maxTtsChars: 4000,
    transcript: "",
    notice: null,
    autoSpeak: true,

    checkAvailability: async () => {
      if (get().available !== null) return;
      const status = await getVoiceStatus();
      if (status.success && status.data?.enabled) {
        set({ available: true, maxTtsChars: status.data.maxTtsChars });
      } else {
        set({ available: false });
      }
    },

    toggleAutoSpeak: () => {
      const next = !get().autoSpeak;
      if (!next) {
        // Muting must also cancel a synthesis already on its way, or the reply
        // the user just muted arrives and speaks anyway.
        retireActiveTurn("muted");
        playback.stop();
        if (get().state === "speaking") toIdle();
      }
      set({ autoSpeak: next });
    },

    dismissNotice: () => set({ notice: null }),

    startListening: async () => {
      const { state } = get();
      if (state === "unsupported") return;

      // Barge-in: pressing the microphone while JARVIS is talking stops it.
      //
      // Retiring the turn first is the whole of the fix for "it answered my
      // previous question". `playback.stop()` alone only silences sound that
      // has already started; the previous turn's synthesis was still in flight
      // and would arrive moments later and speak over the new one.
      if (state === "speaking" || state === "processing" || state === "transcribing") {
        retireActiveTurn("barge-in");
        playback.stop();
        toIdle();
      }

      if (!isCaptureSupported()) {
        set({
          state: "unsupported",
          notice: {
            message:
              "This browser cannot record audio. Voice needs a recent Chrome, Edge or Safari on a secure (https or localhost) connection.",
            benign: false,
          },
        });
        return;
      }

      // Synchronously, while the click is still a user gesture — after the
      // first await the browser stops counting it and the reply is muted.
      playback.unlock();

      if (!go("requesting-permission", { notice: null, transcript: "" })) return;

      // The turn is born here, at the press, so the trace measures the wait the
      // user actually experiences rather than starting the clock at the upload.
      retireActiveTurn("replaced");
      const requestId = nextVoiceRequestId();
      const conversationId = useChatStore.getState().activeConversationId ?? null;
      const trace = new VoiceTurnTrace(requestId, conversationId);
      const turn: VoiceTurn = {
        requestId,
        conversationId,
        trace,
        abort: new AbortController(),
        endTurn: trace.stage("turn", { conversationId }),
      };
      activeTurn = turn;
      // Measures getting the microphone OPEN, not how long the user spoke —
      // the recorded length is reported separately once the take is in hand.
      const endCapture = trace.stage("capture", { phase: "open" });

      try {
        await capture.start(() => {
          // Safety timeout fired; finish the turn rather than hanging.
          void get().stopListening();
        });
        if (!isCurrentTurn(turn)) {
          // Superseded while the permission prompt was open. The microphone
          // that just opened belongs to nobody; release it.
          trace.drop("capture", "superseded-while-opening");
          capture.cancel();
          return;
        }
        endCapture({ opened: true });
        go("listening");
      } catch (err) {
        endCapture({ opened: false });
        if (isCurrentTurn(turn)) retireActiveTurn("capture-failed");
        if (err instanceof CaptureError && err.reason === "permission-denied") {
          set({
            state: "permission-denied",
            notice: {
              message:
                "Microphone access was blocked. Allow it in your browser's address bar, then try again.",
              benign: false,
            },
          });
          return;
        }
        if (err instanceof CaptureError && err.reason === "no-audio") {
          toIdle({ message: "No microphone was found.", benign: false });
          return;
        }
        if (err instanceof CaptureError && err.reason === "unsupported") {
          set({
            state: "unsupported",
            notice: { message: "This browser cannot record audio.", benign: false },
          });
          return;
        }
        toError("Could not start recording.");
      }
    },

    stopListening: async () => {
      if (get().state !== "listening") return;

      const turn = activeTurn;
      if (!turn) {
        // No turn owns this recording — it was retired while the microphone
        // was open. Release the hardware and leave the machine alone.
        capture.cancel();
        toIdle();
        return;
      }
      const { trace } = turn;

      let captured: CapturedAudio;
      try {
        if (!go("transcribing")) return;
        captured = await capture.stop();
      } catch (err) {
        if (isCurrentTurn(turn)) retireActiveTurn("capture-stop-failed");
        if (err instanceof CaptureError && err.reason === "no-audio") {
          toIdle({ message: "I didn't catch that — hold the button while you speak.", benign: true });
          return;
        }
        toError("Could not finish the recording.");
        return;
      }

      if (!isCurrentTurn(turn)) {
        trace.drop("stt", "superseded-before-upload");
        return;
      }

      trace.info("capture", {
        recordedMs: captured.durationMs,
        bytes: captured.bytes,
        mimeType: captured.mimeType,
      });

      const conversationId = turn.conversationId ?? undefined;

      const endStt = trace.stage("stt", { bytes: captured.bytes });
      const transcription = await transcribeAudio(
        {
          audio: captured.base64,
          mimeType: captured.mimeType,
          durationMs: captured.durationMs,
          requestId: turn.requestId,
          ...(conversationId ? { conversationId } : {}),
        },
        turn.abort.signal
      );

      // ---------------------------------------------------------------------
      // Every stage ends the same way: prove this turn is still the one being
      // waited for BEFORE acting on what came back. A result that arrives for a
      // retired turn is recorded and dropped — never shown, never spoken.
      // ---------------------------------------------------------------------
      if (!isCurrentTurn(turn)) {
        endStt({ dropped: true });
        trace.drop("stt", "superseded", { ok: transcription.success });
        return;
      }

      if (!transcription.success || !transcription.data) {
        endStt({ ok: false, code: transcription.error?.code });
        retireActiveTurn("stt-failed");
        const code = transcription.error?.code;
        if (code === "ABORTED") return;
        if (code === "VOICE_RATE_LIMITED") {
          toIdle({ message: "Too many voice requests. Give it a moment.", benign: true });
        } else if (code === "VOICE_PROVIDER_UNAVAILABLE") {
          toError("Speech recognition is unavailable right now. You can still type.");
        } else if (code === "VOICE_AUDIO_TOO_LARGE") {
          toIdle({ message: "That recording was too long. Try a shorter one.", benign: true });
        } else {
          toError(transcription.error?.message ?? "Could not transcribe that.");
        }
        return;
      }

      const text = transcription.data.text.trim();
      endStt({
        ok: true,
        // The transcript IS the request, so it is recorded verbatim: a turn
        // that answered the wrong question cannot be diagnosed without knowing
        // what the recognizer actually heard.
        transcript: text,
        model: transcription.data.model,
        providerLatencyMs: transcription.data.latencyMs,
      });

      if (text.length === 0) {
        retireActiveTurn("empty-transcript");
        toIdle({ message: "I didn't catch that. Try again?", benign: true });
        return;
      }

      set({ transcript: text });

      // ---------------------------------------------------------------------
      // Locked Sprint 8 approval rule.
      //
      // A pending write is waiting on a human. "Yes" is one recognition error
      // away from "yo", and the action on the other side is irreversible — a
      // budget change, a message to a customer. The transcript is shown so the
      // user can see it was understood, and the decision stays on the buttons.
      // ---------------------------------------------------------------------
      if (VOICE_APPROVAL_POLICY.requiresOnScreenConfirmation && hasPendingApproval()) {
        retireActiveTurn("approval-pending");
        toIdle({
          message:
            "There's an action waiting for your approval. Please confirm or reject it on screen — voice can't approve actions.",
          benign: true,
        });
        return;
      }

      if (!go("processing")) return;

      // ---------------------------------------------------------------------
      // The chat leg.
      //
      // `sendMessage` RETURNS this turn's reply. It is also the slowest stage
      // by a wide margin — a few seconds typically, occasionally tens of
      // seconds when a provider stalls — which is precisely the window in which
      // the user gives up, asks again, and a turn they have forgotten about
      // comes back to answer out loud.
      // ---------------------------------------------------------------------
      const endChat = trace.stage("chat", { transcriptChars: text.length });
      let result: ChatTurnResult;
      try {
        result = await useChatStore.getState().sendMessage(text, {
          requestId: turn.requestId,
          signal: turn.abort.signal,
        });
      } catch {
        endChat({ ok: false });
        if (isCurrentTurn(turn)) {
          retireActiveTurn("chat-threw");
          toError("Could not send that message.");
        }
        return;
      }

      turn.trace.bindConversation(result.conversationId);

      if (!isCurrentTurn(turn)) {
        endChat({ dropped: true });
        trace.drop("chat", "superseded", { chatRequestId: result.requestId });
        return;
      }

      endChat({
        ok: !result.error,
        // The association the whole exercise is about: this reply came back
        // for THIS request id, and no other.
        chatRequestId: result.requestId,
        conversationId: result.conversationId,
        replyPreview: result.reply.slice(0, 120),
        replyChars: result.reply.length,
      });

      if (result.error) {
        retireActiveTurn("chat-failed");
        toIdle({ message: result.error, benign: false });
        return;
      }

      const reply = result.reply.trim();
      if (!reply || !get().autoSpeak) {
        retireActiveTurn(reply ? "muted" : "empty-reply");
        toIdle();
        return;
      }

      if (!go("speaking")) {
        retireActiveTurn("speak-transition-refused");
        toIdle();
        return;
      }

      // -----------------------------------------------------------------------
      // Speaking.
      //
      // The reply is split at sentence boundaries and pipelined: the opening is
      // synthesized and started while the remainder is still being generated,
      // which is where roughly half the wait before the first word goes. The
      // playback token is taken ONCE, here, and every segment is played under
      // it — so a stop, a barge-in or a newer turn silences the whole reply,
      // including the parts that had not been generated yet.
      // -----------------------------------------------------------------------
      const spoken = textForSpeech(reply, get().maxTtsChars);
      const segments = splitForSpeech(spoken);
      const generation = playback.claim();

      let firstAudio = true;
      playback.setSegmentListeners(
        () => {
          if (!firstAudio) return;
          firstAudio = false;
          trace.info("playback", { firstAudio: true });
        },
        null
      );

      const synth = (segment: string, index: number) => {
        const endTts = trace.stage("tts", { segment: index, chars: segment.length });
        return synthesizeSpeech(
          {
            text: segment,
            requestId: turn.requestId,
            ...(conversationId ? { conversationId } : {}),
          },
          turn.abort.signal
        ).then((res) => {
          endTts({
            segment: index,
            ok: res.success,
            ...(res.success && res.data
              ? { voice: res.data.voice, model: res.data.model, bytes: res.data.audio.length }
              : { code: res.error?.code }),
          });
          return res;
        });
      };

      const endPlayback = trace.stage("playback", { segments: segments.length });
      let pending = segments.length > 0 ? synth(segments[0]!, 0) : null;
      let lastSegment: Promise<void> = Promise.resolve();
      let spokeAnything = false;
      let failureCode: string | undefined;

      for (let i = 0; i < segments.length; i++) {
        const speech = await pending!;

        if (!isCurrentTurn(turn) || !playback.isCurrent(generation)) {
          trace.drop("tts", "superseded", { segment: i });
          endPlayback({ dropped: true, spokeAnything });
          return;
        }

        if (!speech.success || !speech.data) {
          failureCode = speech.error?.code;
          break;
        }

        // Requested BEFORE this segment is queued, so the next one is being
        // generated while this one plays rather than after it.
        pending = i + 1 < segments.length ? synth(segments[i + 1]!, i + 1) : null;

        lastSegment = playback.enqueue(speech.data.audio, speech.data.mimeType, generation);
        spokeAnything = true;
      }

      try {
        await lastSegment;
      } catch (err) {
        playback.setSegmentListeners(null, null);
        if (!isCurrentTurn(turn)) return;
        retireActiveTurn("playback-failed");
        endPlayback({ ok: false });
        if (err instanceof PlaybackError && err.reason === "blocked") {
          toIdle({
            message: "Your browser blocked audio playback. Tap the microphone once to allow it.",
            benign: true,
          });
          return;
        }
        toIdle({ message: "Couldn't play the reply.", benign: true });
        return;
      }

      playback.setSegmentListeners(null, null);
      if (!isCurrentTurn(turn)) return;

      endPlayback({ ok: true, spokeAnything, segments: segments.length });
      retireActiveTurn("completed");

      // The answer is already on screen. A synthesis failure costs the audio,
      // never the reply — so this ends quietly rather than as an error.
      if (failureCode && !spokeAnything) {
        toIdle(
          failureCode === "VOICE_RATE_LIMITED" || failureCode === "ABORTED"
            ? null
            : { message: "Couldn't read that reply aloud.", benign: true }
        );
        return;
      }
      toIdle();
    },

    cancel: () => {
      retireActiveTurn("cancelled");
      capture.cancel();
      playback.stop();
      toIdle();
    },

    stopSpeaking: () => {
      // Stops the audio AND anything still on its way to becoming audio.
      //
      // Nothing upstream is undone: by the time a reply is being spoken any
      // tool has already run and been audited, and pretending otherwise would
      // tell the user something false. But the SPEAKING is cancelled in full —
      // previously an unfinished synthesis landed a moment later and spoke the
      // reply the user had just silenced.
      retireActiveTurn("stopped-speaking");
      playback.stop();
      if (get().state === "speaking") toIdle();
    },
  };
});
