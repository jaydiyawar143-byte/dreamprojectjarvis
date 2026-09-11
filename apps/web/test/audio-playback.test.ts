// ---------------------------------------------------------------------------
// Reply playback: the queue and the generation guard.
//
// `stop()` used to stop the audio ELEMENT and nothing else, which is only half
// of what "stop speaking" means. A reply is synthesized several awaits after
// the question was asked, so at the moment the user presses stop the audio they
// want silenced very often does not exist yet — and when it arrived a moment
// later, it played. The guard makes the newest caller the only one allowed to
// make sound.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AudioPlayback } from "@/lib/voice/audio-playback";

/** Order the segments actually reached the media element, in sequence. */
let played: string[];
let createdUrls: string[];

/** Resolves the "ended" event for whichever segment is currently loaded. */
let finishCurrent: (() => void) | null = null;

beforeEach(() => {
  played = [];
  createdUrls = [];
  finishCurrent = null;

  // jsdom has no media stack. These stubs stand in for the parts the queue
  // depends on: a source can be attached, playback can start, and it ends when
  // the test says it does.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const url = `blob:${createdUrls.length}`;
      createdUrls.push(url);
      void blob;
      return url;
    },
    revokeObjectURL: () => undefined,
  });

  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function play(
    this: HTMLMediaElement
  ) {
    played.push(this.src);
    finishCurrent = () => this.onended?.(new Event("ended"));
    return Promise.resolve();
  });

  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Lets the queue advance past its awaits. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the generation guard", () => {
  it("refuses audio queued under a token that stop() has invalidated", async () => {
    const playback = new AudioPlayback();
    const generation = playback.claim();

    // The user presses stop while the reply is still being synthesized.
    playback.stop();

    // The synthesis lands afterwards and tries to speak.
    await playback.enqueue("QUJD", "audio/mpeg", generation);
    await settle();

    expect(played).toEqual([]);
  });

  it("plays audio queued under the live token", async () => {
    const playback = new AudioPlayback();
    const generation = playback.claim();

    const done = playback.enqueue("QUJD", "audio/mpeg", generation);
    await settle();
    expect(played).toHaveLength(1);

    finishCurrent?.();
    await done;
  });

  it("gives a newer claim a token the older one cannot match", () => {
    const playback = new AudioPlayback();
    const first = playback.claim();
    const second = playback.claim();

    expect(playback.isCurrent(first)).toBe(false);
    expect(playback.isCurrent(second)).toBe(true);
  });

  it("resolves a dropped segment rather than leaving its caller waiting", async () => {
    const playback = new AudioPlayback();
    const generation = playback.claim();

    const first = playback.enqueue("QUJD", "audio/mpeg", generation);
    await settle();
    const second = playback.enqueue("REVG", "audio/mpeg", generation);

    // Barge-in while the first segment is playing and the second is waiting.
    playback.stop();

    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });
});

describe("the queue", () => {
  it("plays segments in the order they were added", async () => {
    const playback = new AudioPlayback();
    const generation = playback.claim();

    const first = playback.enqueue("QUJD", "audio/mpeg", generation);
    const second = playback.enqueue("REVG", "audio/mpeg", generation);

    await settle();
    expect(played).toHaveLength(1);
    finishCurrent?.();
    await first;
    await settle();

    expect(played).toHaveLength(2);
    finishCurrent?.();
    await second;

    expect(played[0]).not.toBe(played[1]);
  });

  it("discards the tail of a reply the user interrupted", async () => {
    const playback = new AudioPlayback();
    const generation = playback.claim();

    const first = playback.enqueue("QUJD", "audio/mpeg", generation);
    playback.enqueue("REVG", "audio/mpeg", generation);
    await settle();
    expect(played).toHaveLength(1);

    playback.stop();
    await first;
    await settle();

    // The second segment never starts: half an abandoned answer is worse than
    // none of it.
    expect(played).toHaveLength(1);
  });

  it("counts the gap between two segments as still speaking", async () => {
    const playback = new AudioPlayback();
    const generation = playback.claim();

    playback.enqueue("QUJD", "audio/mpeg", generation);
    playback.enqueue("REVG", "audio/mpeg", generation);
    await settle();

    expect(playback.isPlaying).toBe(true);
  });
});
