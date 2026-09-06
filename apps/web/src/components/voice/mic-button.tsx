"use client";

// ---------------------------------------------------------------------------
// Sprint 8.6 — The microphone control.
//
// Click to start, click again to stop. Not hold-to-talk: on the web a
// `pointerup` can be lost to a dragged cursor, a context menu or a tab switch,
// and the failure mode is a microphone left open — the exact thing Sprint 8 is
// meant to avoid. A toggle makes both edges explicit user actions.
//
// The button hides itself entirely when the deployment has voice switched off,
// rather than offering a control that answers 404.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import { Loader2, Mic, MicOff, Square } from "lucide-react";
import { isVoiceBusy } from "@jarvis/core/voice";
import { useVoiceStore } from "@/lib/voice/voice-store";
import { cn } from "@/lib/utils";

interface Props {
  /** True while the chat pipeline is busy with a typed message. */
  disabled?: boolean;
}

export function MicButton({ disabled = false }: Props) {
  const state = useVoiceStore((s) => s.state);
  const available = useVoiceStore((s) => s.available);
  const checkAvailability = useVoiceStore((s) => s.checkAvailability);
  const startListening = useVoiceStore((s) => s.startListening);
  const stopListening = useVoiceStore((s) => s.stopListening);
  const stopSpeaking = useVoiceStore((s) => s.stopSpeaking);

  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  // Escape abandons a take. A user who started recording by accident should
  // not have to complete the turn to get out of it.
  useEffect(() => {
    if (state !== "listening") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") useVoiceStore.getState().cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  if (available === false) return null;

  const listening = state === "listening";
  const speaking = state === "speaking";
  const unsupported = state === "unsupported";
  // Transcribing and processing are not interruptible: the request is already
  // with the server and cancelling the button would not recall it.
  const working = state === "transcribing" || state === "processing";

  function handleClick() {
    if (speaking) {
      stopSpeaking();
      return;
    }
    if (listening) {
      void stopListening();
      return;
    }
    void startListening();
  }

  const label = listening
    ? "Stop recording"
    : speaking
      ? "Stop speaking"
      : unsupported
        ? "Voice is not supported in this browser"
        : "Start voice input";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || working || unsupported}
      aria-label={label}
      title={label}
      data-voice-state={state}
      data-testid="mic-button"
      className={cn(
        "p-2 rounded-lg transition-colors shrink-0 relative",
        listening && "bg-red-600 hover:bg-red-700 text-white",
        speaking && "bg-indigo-500 hover:bg-indigo-600 text-white",
        !listening && !speaking && !working && !unsupported &&
          "bg-gray-800 hover:bg-gray-700 text-gray-300",
        (working || unsupported || disabled) && "bg-gray-800 text-gray-600 cursor-not-allowed"
      )}
    >
      {working ? (
        <Loader2 size={16} className="animate-spin" />
      ) : unsupported ? (
        <MicOff size={16} />
      ) : listening ? (
        <Square size={16} />
      ) : speaking ? (
        <Square size={16} />
      ) : (
        <Mic size={16} />
      )}

      {listening && (
        // A calm pulse, not a countdown. Reduced-motion users get a static ring
        // via the global brake in globals.css.
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-lg ring-2 ring-red-400/60 animate-pulse"
        />
      )}
    </button>
  );
}

/** Whether the composer should be locked while a voice turn is underway. */
export function useVoiceLocksComposer(): boolean {
  const state = useVoiceStore((s) => s.state);
  return isVoiceBusy(state) && state !== "speaking";
}
