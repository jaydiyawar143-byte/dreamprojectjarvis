"use client";

// ---------------------------------------------------------------------------
// Sprint 8.6 / 8.7 — What voice is doing, and what went wrong.
//
// Every state the machine can occupy has a visible answer here. A voice
// interface that goes quiet is indistinguishable from one that has crashed, so
// "nothing is shown" is never an acceptable rendering of a state.
//
// Notices are split into benign and real. Silence, a mis-tap, or an approval
// that needs a button press are ordinary moments in a conversation and are
// shown in a neutral tone; a denied microphone or a provider outage is a
// problem and is shown as one.
// ---------------------------------------------------------------------------

import { AlertTriangle, Info, Loader2, Mic, Volume2, VolumeX, X } from "lucide-react";
import { useVoiceStore } from "@/lib/voice/voice-store";
import { cn } from "@/lib/utils";

export function VoiceStatus() {
  const state = useVoiceStore((s) => s.state);
  const transcript = useVoiceStore((s) => s.transcript);
  const notice = useVoiceStore((s) => s.notice);
  const available = useVoiceStore((s) => s.available);
  const autoSpeak = useVoiceStore((s) => s.autoSpeak);
  const toggleAutoSpeak = useVoiceStore((s) => s.toggleAutoSpeak);
  const stopSpeaking = useVoiceStore((s) => s.stopSpeaking);
  const dismissNotice = useVoiceStore((s) => s.dismissNotice);

  if (available === false) return null;

  const showsActivity = state !== "idle" && state !== "error" && state !== "permission-denied";
  if (!showsActivity && !notice && !transcript) return null;

  return (
    <div className="max-w-3xl mx-auto mb-2 space-y-2" data-testid="voice-status">
      {notice && (
        <div
          role={notice.benign ? "status" : "alert"}
          data-testid="voice-notice"
          className={cn(
            "flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
            notice.benign
              ? "border-gray-700 bg-gray-900 text-gray-300"
              : "border-amber-800 bg-amber-900/30 text-amber-200"
          )}
        >
          <div className="flex items-start gap-2">
            {notice.benign ? (
              <Info size={15} className="mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            )}
            <span>{notice.message}</span>
          </div>
          <button
            onClick={dismissNotice}
            aria-label="Dismiss"
            className="text-gray-500 hover:text-gray-300 shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {showsActivity && (
        <div
          role="status"
          aria-live="polite"
          data-testid="voice-activity"
          data-voice-state={state}
          className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/70 px-3 py-2"
        >
          <div className="flex items-center gap-2 text-sm text-gray-300 min-w-0">
            <StateIcon state={state} />
            <span className="shrink-0">{stateLabel(state)}</span>
            {transcript && (state === "processing" || state === "speaking") && (
              <span className="truncate text-gray-500 italic">“{transcript}”</span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={toggleAutoSpeak}
              aria-label={autoSpeak ? "Mute replies" : "Unmute replies"}
              title={autoSpeak ? "Mute replies" : "Unmute replies"}
              className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800"
            >
              {autoSpeak ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>
            {state === "speaking" && (
              <button
                onClick={stopSpeaking}
                data-testid="stop-speaking"
                className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300"
              >
                Stop
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function stateLabel(state: string): string {
  switch (state) {
    case "requesting-permission":
      return "Waiting for microphone permission…";
    case "listening":
      return "Listening… click the microphone to stop";
    case "transcribing":
      return "Transcribing…";
    case "processing":
      return "JARVIS is thinking…";
    case "speaking":
      return "Speaking";
    default:
      return "";
  }
}

function StateIcon({ state }: { state: string }) {
  if (state === "listening") {
    return <Mic size={15} className="text-red-400 animate-pulse shrink-0" />;
  }
  if (state === "speaking") {
    return <Volume2 size={15} className="text-indigo-400 shrink-0" />;
  }
  return <Loader2 size={15} className="animate-spin text-gray-400 shrink-0" />;
}
