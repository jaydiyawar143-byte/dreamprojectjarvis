"use client";

// ---------------------------------------------------------------------------
// Sprint 8.4 — Reply playback and barge-in.
//
// One reused <audio> element rather than one per reply. Browsers only permit
// playback that traces back to a user gesture, and a fresh element created
// several awaits after the microphone press has lost that lineage — the reply
// would be silently blocked. `unlock()` is called during the press, on the
// element that will later carry the answer.
//
// Stopping playback stops PLAYBACK. It never cancels the turn that produced
// it: by the time audio is playing, any tool has already run and been audited,
// and pretending otherwise would tell the user something false about the state
// of the system. This mirrors the rule the API already applies to a socket
// disconnect.
// ---------------------------------------------------------------------------

export type PlaybackFailure = "blocked" | "decode" | "failed";

export class PlaybackError extends Error {
  constructor(readonly reason: PlaybackFailure, message: string) {
    super(message);
    this.name = "PlaybackError";
  }
}

/** A 1-sample silent WAV, used only to satisfy the gesture requirement. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

interface QueuedSegment {
  base64: string;
  mimeType: string;
  generation: number;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class AudioPlayback {
  private element: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private unlocked = false;

  /**
   * Bumped by every `stop()`. Playback is a race the newest caller must win.
   *
   * A reply is synthesized several awaits after the question was asked, and
   * during those awaits the user can barge in, press stop, or ask something
   * else. Stopping the ELEMENT cannot help with audio that has not started
   * yet: the pending synthesis still resolves and its continuation still calls
   * `play()`, which is how a question about widgets was answered aloud with a
   * crypto price from the turn before. A caller takes a generation before it
   * starts waiting and hands it back here; if `stop()` has run since, the audio
   * is dropped instead of played.
   */
  private generation = 0;

  /** Segments waiting behind the one currently playing. */
  private queue: QueuedSegment[] = [];
  private draining = false;
  /** Ends the segment currently loaded on the element, whatever its state. */
  private settleActive: (() => void) | null = null;
  private onSegmentStart: (() => void) | null = null;
  private onSegmentEnd: (() => void) | null = null;

  /** Whether `generation` is still the live one. */
  isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  /**
   * Takes ownership of playback and returns the token that proves it.
   *
   * Called once at the top of a reply, before any synthesis is requested. Every
   * segment of that reply is then played under the same token, and anything
   * that happens afterwards — a barge-in, a stop, a newer turn claiming in its
   * turn — invalidates all of them at once.
   */
  claim(): number {
    this.stop();
    return this.generation;
  }

  private ensureElement(): HTMLAudioElement {
    if (!this.element) {
      this.element = new Audio();
      this.element.preload = "auto";
    }
    return this.element;
  }

  /**
   * Satisfies the browser's autoplay policy while a user gesture is in scope.
   *
   * Must be called synchronously from the event handler — after the first
   * `await` the gesture no longer counts. Failure is ignored on purpose:
   * some browsers need no unlocking, and the real playback attempt reports
   * the problem properly if there is one.
   */
  unlock(): void {
    if (this.unlocked) return;
    const element = this.ensureElement();
    try {
      element.src = SILENT_WAV;
      element.muted = true;
      void element.play().then(
        () => {
          element.pause();
          element.muted = false;
          this.unlocked = true;
        },
        () => {
          element.muted = false;
        }
      );
    } catch {
      element.muted = false;
    }
  }

  /**
   * The underlying media element, or null before anything has been prepared.
   *
   * UI V2 — exposed so the Orb can analyse the REPLY audio while JARVIS speaks.
   * The caller must not alter playback through it; see audio-analyser.ts, which
   * taps it only once playback is already running.
   */
  getElement(): HTMLAudioElement | null {
    return this.element;
  }

  get isPlaying(): boolean {
    // A reply between two segments is still a reply in progress, even though
    // the element is momentarily idle — the Orb must not fall asleep in the gap.
    if (this.draining || this.queue.length > 0) return true;
    return Boolean(this.element && !this.element.paused && !this.element.ended);
  }

  /**
   * Notified as each queued segment starts and finishes.
   *
   * Used for the playback timings in the voice trace; a reply spoken in two
   * segments should report when the FIRST sound reached the user, which is the
   * number that describes the wait they actually experienced.
   */
  setSegmentListeners(onStart: (() => void) | null, onEnd: (() => void) | null): void {
    this.onSegmentStart = onStart;
    this.onSegmentEnd = onEnd;
  }

  /**
   * Adds a segment to the reply currently being spoken.
   *
   * Long replies are synthesized in pieces so the first sentence can start
   * while the rest is still being generated. The queue keeps them in order; a
   * `stop()` between segments discards whatever is left rather than letting the
   * tail of an abandoned answer play on its own.
   *
   * Resolves when THIS segment has finished playing, or immediately if it was
   * dropped for being stale — so a caller can await the last segment to know
   * the reply is over, and a dropped reply never leaves anyone waiting.
   */
  enqueue(base64: string, mimeType: string, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ base64, mimeType, generation, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const next = this.queue.shift();
        if (!next) break;
        if (!this.isCurrent(next.generation)) {
          next.resolve();
          continue;
        }
        try {
          await this.playSegment(next.base64, next.mimeType, next.generation);
          next.resolve();
        } catch (err) {
          next.reject(err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Plays base64 audio, resolving when it finishes or is stopped. */
  async play(base64: string, mimeType: string, generation?: number): Promise<void> {
    // A caller that passes no generation is asking for "play this now", which
    // is what the single-shot path has always meant.
    const token = generation ?? this.generation;
    if (!this.isCurrent(token)) return;
    this.stop();
    // `stop()` invalidated the token it was just checked against; the caller
    // won the race, so it owns the generation that follows.
    return this.playSegment(base64, mimeType, this.generation);
  }

  private async playSegment(
    base64: string,
    mimeType: string,
    generation: number
  ): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const element = this.ensureElement();
    this.clearElement();

    let url: string;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    } catch {
      throw new PlaybackError("decode", "Could not decode the reply audio");
    }

    this.objectUrl = url;
    element.src = url;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        element.onended = null;
        element.onerror = null;
        this.settleActive = null;
        this.revoke();
      };

      // Held on the instance so a stop can END this segment deterministically.
      //
      // It used to be ended by re-firing `onended`, but only when the element
      // reported itself as playing — and between `play()` being called and
      // sound actually starting it does not. A stop in that window left this
      // promise unsettled forever, and the voice turn awaiting it stayed in
      // "speaking" with nothing to speak.
      this.settleActive = () => {
        cleanup();
        resolve();
      };

      element.onended = () => {
        cleanup();
        this.onSegmentEnd?.();
        resolve();
      };
      element.onerror = () => {
        cleanup();
        reject(new PlaybackError("failed", "Could not play the reply"));
      };

      element.play().then(
        () => this.onSegmentStart?.(),
        (err: unknown) => {
          cleanup();
          // NotAllowedError means the gesture chain was lost — the reply is
          // fine, the browser simply refused to start it on its own.
          const name = (err as { name?: string })?.name;
          reject(
            name === "NotAllowedError"
              ? new PlaybackError("blocked", "Playback was blocked by the browser")
              : new PlaybackError("failed", "Could not play the reply")
          );
        }
      );
    });
  }

  /**
   * Barge-in. Stops immediately and resolves any in-flight `play()`.
   *
   * Also invalidates the current generation, which is what stops audio that has
   * not started yet — a synthesis still in flight, or a queued segment. Before
   * this existed, "stop speaking" stopped only the sound already playing and
   * the rest of the abandoned reply arrived moments later and spoke anyway.
   */
  stop(): void {
    this.generation += 1;
    // Resolved, not rejected: a segment dropped because the user moved on is
    // not a failure, and nobody awaiting the reply should be left hanging.
    const dropped = this.queue.splice(0);
    this.clearElement();
    for (const segment of dropped) segment.resolve();
  }

  /** Halts and unbinds the element without touching the generation. */
  private clearElement(): void {
    const element = this.element;
    if (!element) {
      this.settleActive?.();
      return;
    }

    try {
      element.pause();
      element.currentTime = 0;
    } catch {
      // Nothing loaded yet.
    }

    const settle = this.settleActive;
    if (settle) {
      // Clears the handlers, revokes the URL and resolves the waiting caller.
      settle();
    } else {
      element.onended = null;
      element.onerror = null;
      this.revoke();
    }
  }

  private revoke(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  dispose(): void {
    this.stop();
    this.element = null;
    this.unlocked = false;
  }
}
