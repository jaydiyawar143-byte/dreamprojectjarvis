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
// ---------------------------------------------------------------------------

import { create } from "zustand";
import {
  VOICE_APPROVAL_POLICY,
  canTransitionVoiceState,
  type VoiceState,
} from "@jarvis/core/voice";
import { getVoiceStatus, synthesizeSpeech, transcribeAudio } from "../api";
import { useChatStore } from "../chat-store";
import {
  AudioCapture,
  CaptureError,
  isCaptureSupported,
  type CapturedAudio,
} from "./audio-capture";
import { AudioPlayback, PlaybackError } from "./audio-playback";

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

/** The assistant's most recent reply, for reading aloud. */
function latestAssistantText(): string | null {
  const messages = useChatStore.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.content.trim().length > 0) {
      return message.content;
    }
  }
  return null;
}

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
      if (!next) playback.stop();
      set({ autoSpeak: next });
    },

    dismissNotice: () => set({ notice: null }),

    startListening: async () => {
      const { state } = get();
      if (state === "unsupported") return;

      // Barge-in: pressing the microphone while JARVIS is talking stops it.
      if (state === "speaking") {
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

      try {
        await capture.start(() => {
          // Safety timeout fired; finish the turn rather than hanging.
          void get().stopListening();
        });
        go("listening");
      } catch (err) {
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

      let captured: CapturedAudio;
      try {
        if (!go("transcribing")) return;
        captured = await capture.stop();
      } catch (err) {
        if (err instanceof CaptureError && err.reason === "no-audio") {
          toIdle({ message: "I didn't catch that — hold the button while you speak.", benign: true });
          return;
        }
        toError("Could not finish the recording.");
        return;
      }

      const conversationId = useChatStore.getState().activeConversationId ?? undefined;

      const transcription = await transcribeAudio({
        audio: captured.base64,
        mimeType: captured.mimeType,
        durationMs: captured.durationMs,
        ...(conversationId ? { conversationId } : {}),
      });

      if (!transcription.success || !transcription.data) {
        const code = transcription.error?.code;
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
      if (text.length === 0) {
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
        toIdle({
          message:
            "There's an action waiting for your approval. Please confirm or reject it on screen — voice can't approve actions.",
          benign: true,
        });
        return;
      }

      if (!go("processing")) return;

      try {
        await useChatStore.getState().sendMessage(text);
      } catch {
        toError("Could not send that message.");
        return;
      }

      const chatError = useChatStore.getState().error;
      if (chatError) {
        toIdle({ message: chatError, benign: false });
        return;
      }

      const reply = latestAssistantText();
      if (!reply || !get().autoSpeak) {
        toIdle();
        return;
      }

      if (!go("speaking")) {
        toIdle();
        return;
      }

      const spoken = textForSpeech(reply, get().maxTtsChars);
      const speech = await synthesizeSpeech({
        text: spoken,
        ...(conversationId ? { conversationId } : {}),
      });

      // The answer is already on screen. A synthesis failure costs the audio,
      // never the reply — so this ends quietly rather than as an error.
      if (!speech.success || !speech.data) {
        toIdle(
          speech.error?.code === "VOICE_RATE_LIMITED"
            ? null
            : { message: "Couldn't read that reply aloud.", benign: true }
        );
        return;
      }

      try {
        await playback.play(speech.data.audio, speech.data.mimeType);
        toIdle();
      } catch (err) {
        if (err instanceof PlaybackError && err.reason === "blocked") {
          toIdle({
            message: "Your browser blocked audio playback. Tap the microphone once to allow it.",
            benign: true,
          });
          return;
        }
        toIdle({ message: "Couldn't play the reply.", benign: true });
      }
    },

    cancel: () => {
      capture.cancel();
      playback.stop();
      toIdle();
    },

    stopSpeaking: () => {
      // Stops the audio only. The turn already completed, any tool already ran
      // and was audited; nothing upstream is cancelled.
      playback.stop();
      if (get().state === "speaking") toIdle();
    },
  };
});
