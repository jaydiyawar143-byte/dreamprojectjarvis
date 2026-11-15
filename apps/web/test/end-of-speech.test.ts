// ---------------------------------------------------------------------------
// Deciding that the person has finished speaking.
//
// The detector is a pure function of (level, time), so every case here drives
// it with a clock the test owns. What matters: it ends a take after real
// speech and a pause; it never ends one that had no speech by calling it
// "ended" (that is "no-speech", and the conversation stops); a cough is not
// speech; a noisy room still ends; and a verdict is final.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { EndOfSpeechDetector } from "@/lib/voice/end-of-speech";

const QUIET = 0.01;
const VOICE = 0.4;

/** Feeds `level` every `step` ms for `durationMs`, returning the last verdict. */
function run(
  d: EndOfSpeechDetector,
  from: number,
  durationMs: number,
  level: number,
  step = 100
): { event: string; now: number } {
  let event = "waiting";
  let now = from;
  for (let t = 0; t <= durationMs; t += step) {
    now = from + t;
    event = d.feed(level, now);
    if (event === "ended" || event === "no-speech") break;
  }
  return { event, now };
}

describe("EndOfSpeechDetector", () => {
  it("waits while it is quiet and nothing has been said", () => {
    const d = new EndOfSpeechDetector();
    expect(run(d, 0, 3_000, QUIET).event).toBe("waiting");
    expect(d.hasSpeech).toBe(false);
  });

  it("ends the take after speech followed by a pause", () => {
    const d = new EndOfSpeechDetector();
    expect(run(d, 0, 1_500, VOICE).event).toBe("speaking");
    expect(d.hasSpeech).toBe(true);
    // Not yet: 1,000 ms of quiet is shorter than the 1,200 ms pause.
    expect(run(d, 1_600, 1_000, QUIET).event).toBe("speaking");
    // Now it has been quiet long enough.
    expect(run(d, 2_700, 1_000, QUIET).event).toBe("ended");
  });

  it("does not cut a speaker off in a short pause between words", () => {
    const d = new EndOfSpeechDetector();
    run(d, 0, 1_000, VOICE);
    expect(run(d, 1_100, 700, QUIET).event).toBe("speaking");
    // Speaking resumes; the pause clock restarts.
    expect(run(d, 1_900, 1_000, VOICE).event).toBe("speaking");
    expect(run(d, 3_000, 700, QUIET).event).toBe("speaking");
  });

  it("gives up with no-speech when nothing is said in time — it never reports ended", () => {
    const d = new EndOfSpeechDetector({ noSpeechMs: 5_000 });
    const out = run(d, 0, 10_000, QUIET);
    expect(out.event).toBe("no-speech");
    expect(out.now).toBe(5_000);
  });

  it("does not take a cough or a click for speech", () => {
    const d = new EndOfSpeechDetector({ noSpeechMs: 4_000 });
    d.feed(QUIET, 0);
    d.feed(VOICE, 100); // one loud frame
    d.feed(QUIET, 200);
    expect(d.hasSpeech).toBe(false);
    expect(run(d, 300, 6_000, QUIET).event).toBe("no-speech");
  });

  it("still ends in a noisy room where the floor is above the base threshold", () => {
    const d = new EndOfSpeechDetector();
    const NOISE = 0.09; // under the fixed 0.12, but a steady hum
    run(d, 0, 500, NOISE);
    // Speech well above the hum.
    expect(run(d, 600, 1_000, 0.6).event).toBe("speaking");
    expect(d.hasSpeech).toBe(true);
    // Back to hum only: it must read as silence, not as endless speech.
    expect(run(d, 1_700, 2_000, NOISE).event).toBe("ended");
  });

  it("treats the room's own constant noise as silence, not as speech", () => {
    const d = new EndOfSpeechDetector({ noSpeechMs: 3_000 });
    // A constant 0.2 would be "voice" against a fixed threshold of 0.12.
    expect(run(d, 0, 5_000, 0.2).event).toBe("no-speech");
  });

  it("a verdict is final", () => {
    const d = new EndOfSpeechDetector({ noSpeechMs: 1_000 });
    expect(run(d, 0, 2_000, QUIET).event).toBe("no-speech");
    expect(d.feed(VOICE, 3_000)).toBe("no-speech");
    expect(d.feed(VOICE, 3_100)).toBe("no-speech");
  });

  it("ignores garbage samples rather than throwing", () => {
    const d = new EndOfSpeechDetector();
    expect(() => {
      d.feed(Number.NaN, 0);
      d.feed(-1, 100);
      d.feed(Number.POSITIVE_INFINITY, 200);
    }).not.toThrow();
  });
});
