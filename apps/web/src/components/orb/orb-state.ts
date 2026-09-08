// ---------------------------------------------------------------------------
// UI V2 — what the Orb is expressing, and how that looks.
//
// The Orb is a STATUS DISPLAY, not decoration. Every state here corresponds to
// something the system is actually doing, so a user can read JARVIS at a glance
// without opening a log.
//
// This file is deliberately free of React and of Three.js. It is the contract
// both renderers implement — the WebGL orb and the 2D fallback — which is what
// keeps the fallback a genuine substitute rather than a different product.
// ---------------------------------------------------------------------------

import type { VoiceState } from "@jarvis/core/voice";

export type OrbState =
  /** Nothing to do. Slow drift. */
  | "idle"
  /** Microphone open. Particles gather inward, waiting. */
  | "listening"
  /** Transcribing or reasoning. Fast internal churn, little outward motion. */
  | "processing"
  /** A tool is running. Deliberate orbital motion. */
  | "executing"
  /** Reading a reply aloud. Driven by the output audio. */
  | "speaking"
  /** A write is waiting on a human. Restrained, unmistakable, not alarming. */
  | "awaiting-approval"
  /** Something completed. A brief bloom, then back to idle. */
  | "success"
  /** A recoverable failure. Controlled, not frantic. */
  | "error"
  /** No connection, or voice unavailable. Visibly reduced. */
  | "offline";

/** Per-state visual constants. Consumed identically by both renderers. */
export interface OrbAppearance {
  /** Core and particle hue, as an HSL hue in degrees. */
  hue: number;
  /** Baseline emissive strength before audio is added, 0..1. */
  intensity: number;
  /** Radians per second about Y. */
  spin: number;
  /** How strongly particles are pushed out from the shell, 0..1. */
  turbulence: number;
  /** Resting radius multiplier. */
  scale: number;
  /** How much the audio level is allowed to modulate the look, 0..1. */
  audioResponse: number;
  /** Slow breathing amplitude used when there is no audio. */
  pulse: number;
}

// The palette is one family — cyan through violet — so state reads as a change
// in ENERGY rather than as an unrelated colour scheme. Error steps outside it
// on purpose, because that is the one state that must not be mistaken.
export const ORB_APPEARANCE: Record<OrbState, OrbAppearance> = {
  idle: { hue: 188, intensity: 0.62, spin: 0.07, turbulence: 0.1, scale: 1, audioResponse: 0.15, pulse: 0.05 },
  listening: { hue: 196, intensity: 0.72, spin: 0.16, turbulence: 0.34, scale: 1.03, audioResponse: 1, pulse: 0.02 },
  processing: { hue: 258, intensity: 0.66, spin: 0.72, turbulence: 0.6, scale: 0.97, audioResponse: 0.1, pulse: 0.11 },
  executing: { hue: 214, intensity: 0.78, spin: 0.46, turbulence: 0.44, scale: 1.02, audioResponse: 0.1, pulse: 0.07 },
  speaking: { hue: 176, intensity: 0.88, spin: 0.22, turbulence: 0.42, scale: 1.05, audioResponse: 1, pulse: 0.02 },
  "awaiting-approval": { hue: 42, intensity: 0.6, spin: 0.05, turbulence: 0.12, scale: 1, audioResponse: 0.05, pulse: 0.22 },
  success: { hue: 152, intensity: 0.9, spin: 0.3, turbulence: 0.3, scale: 1.06, audioResponse: 0.1, pulse: 0.05 },
  error: { hue: 6, intensity: 0.66, spin: 0.09, turbulence: 0.2, scale: 0.96, audioResponse: 0.05, pulse: 0.16 },
  offline: { hue: 210, intensity: 0.18, spin: 0.02, turbulence: 0.03, scale: 0.9, audioResponse: 0, pulse: 0.02 },
};

/** A short, plain sentence naming the state. Also the accessible label. */
export const ORB_CAPTION: Record<OrbState, string> = {
  idle: "Ready",
  listening: "Listening",
  processing: "Thinking",
  executing: "Working",
  speaking: "Speaking",
  "awaiting-approval": "Waiting for your approval",
  success: "Done",
  error: "Something went wrong",
  offline: "Offline",
};

/**
 * Everything that can decide what the Orb shows, in priority order.
 *
 * Priority is the whole point of doing this in one function: an approval that
 * is waiting outranks a voice turn, because it is the only one of the two that
 * needs a human. Voice outranks a generic "busy" because it is more specific.
 */
export interface OrbInputs {
  voice: VoiceState;
  /** True while a chat turn is in flight (typed OR spoken). */
  thinking?: boolean;
  /** True while a tool is executing. */
  executing?: boolean;
  /** True when a write is parked on a human decision. */
  awaitingApproval?: boolean;
  /** True when the transport is down. */
  offline?: boolean;
  /** Set briefly after something completes. */
  succeeded?: boolean;
  /** A recoverable failure worth showing. */
  failed?: boolean;
}

export function resolveOrbState(input: OrbInputs): OrbState {
  // Offline first: nothing else is true if the app cannot reach the server, and
  // showing "thinking" over a dead connection is a lie.
  if (input.offline) return "offline";

  // A pending approval outranks activity. It is the only state that is BLOCKED
  // on a person, so it must not be buried under a spinner.
  if (input.awaitingApproval) return "awaiting-approval";

  switch (input.voice) {
    case "listening":
    case "requesting-permission":
      return "listening";
    case "transcribing":
      return "processing";
    case "processing":
      return input.executing ? "executing" : "processing";
    case "speaking":
      return "speaking";
    case "error":
      return "error";
    case "permission-denied":
    case "unsupported":
      // Not an error state for the ORB: voice is unavailable, but JARVIS is
      // perfectly usable by typing. Showing red would misreport that.
      return input.thinking ? "processing" : "idle";
    case "idle":
      break;
  }

  if (input.failed) return "error";
  if (input.executing) return "executing";
  if (input.thinking) return "processing";
  if (input.succeeded) return "success";
  return "idle";
}
