// ---------------------------------------------------------------------------
// Conversation mode — deciding that the person has finished speaking.
//
// A pure function of (microphone level, time). No Web Audio, no timers, no
// store: the caller samples the level and says what time it is, and this says
// whether the take is still waiting, in speech, over, or never started. That
// keeps the one judgement that decides when JARVIS stops listening testable
// with a clock the test controls.
//
// THREE OUTCOMES BESIDES "KEEP GOING"
//   ended      speech happened, then silence lasted long enough
//   no-speech  nothing resembling speech arrived in the allowed time
//
// A take that never contains speech must end the conversation, not loop: an
// open microphone that keeps reopening on an empty room is exactly the thing
// conversation mode must never become.
//
// THE THRESHOLD ADAPTS, WITHIN A CEILING. A quiet room has a floor near 0.01
// and speech well above 0.12; a fan or a street raises the floor and a fixed
// threshold would then call the noise "speech" forever and never end the take.
// The threshold is the larger of the base level and three times the quietest
// level seen in this take — but never above `NOISE_THRESHOLD_CEILING`. The cap
// matters because in conversation mode the microphone opens as the person is
// already speaking, so the take may contain no quiet frame at all; without it
// the first loud frame would set the floor and speech would be mistaken for
// noise.
// ---------------------------------------------------------------------------

export type EndOfSpeechEvent = "waiting" | "speaking" | "ended" | "no-speech";

export interface EndOfSpeechOptions {
  /** Level (0–1, as `AudioTap.read().level`) at or above which a frame counts as voice. */
  speechLevel?: number;
  /** Silence after speech that ends the take. */
  silenceMs?: number;
  /** How long to wait for speech to begin before giving up. */
  noSpeechMs?: number;
  /** Voiced time needed before it counts as speech and not a click or a cough. */
  minSpeechMs?: number;
}

export const END_OF_SPEECH_DEFAULTS = Object.freeze({
  speechLevel: 0.12,
  silenceMs: 1_200,
  noSpeechMs: 8_000,
  minSpeechMs: 250,
});

/** Multiple of the quietest level seen that a frame must exceed to count as voice. */
const NOISE_FLOOR_FACTOR = 3;

/** However loud the floor looks, a frame at or above this is always voice. */
const NOISE_THRESHOLD_CEILING = 0.3;

export class EndOfSpeechDetector {
  private readonly speechLevel: number;
  private readonly silenceMs: number;
  private readonly noSpeechMs: number;
  private readonly minSpeechMs: number;

  private startedAt: number | null = null;
  private lastAt: number | null = null;
  private lastVoiceAt: number | null = null;
  private voicedMs = 0;
  private quietest = Number.POSITIVE_INFINITY;
  private established = false;
  private final: "ended" | "no-speech" | null = null;

  constructor(options: EndOfSpeechOptions = {}) {
    const o = { ...END_OF_SPEECH_DEFAULTS, ...options };
    this.speechLevel = o.speechLevel;
    this.silenceMs = o.silenceMs;
    this.noSpeechMs = o.noSpeechMs;
    this.minSpeechMs = o.minSpeechMs;
  }

  /** Whether speech has been established in this take. */
  get hasSpeech(): boolean {
    return this.established;
  }

  /**
   * Feed one sample.
   *
   * @param level  0–1 loudness of the microphone right now
   * @param nowMs  any monotonic clock, in milliseconds
   */
  feed(level: number, nowMs: number): EndOfSpeechEvent {
    // A verdict, once given, is final: a late sample must not un-end a take.
    if (this.final) return this.final;

    const l = Number.isFinite(level) ? Math.max(0, level) : 0;
    if (this.startedAt === null) this.startedAt = nowMs;
    const dt = this.lastAt === null ? 0 : Math.max(0, nowMs - this.lastAt);
    this.lastAt = nowMs;

    if (l < this.quietest) this.quietest = l;
    const threshold = Math.max(
      this.speechLevel,
      Math.min(this.quietest * NOISE_FLOOR_FACTOR, NOISE_THRESHOLD_CEILING)
    );
    const voiced = l >= threshold;

    if (voiced) {
      this.lastVoiceAt = nowMs;
      this.voicedMs += dt;
      if (!this.established && this.voicedMs >= this.minSpeechMs) this.established = true;
    }

    if (!this.established) {
      if (nowMs - this.startedAt >= this.noSpeechMs) {
        this.final = "no-speech";
        return this.final;
      }
      return "waiting";
    }

    if (this.lastVoiceAt !== null && nowMs - this.lastVoiceAt >= this.silenceMs) {
      this.final = "ended";
      return this.final;
    }
    return "speaking";
  }
}
