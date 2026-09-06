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

export class AudioPlayback {
  private element: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private unlocked = false;

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

  get isPlaying(): boolean {
    return Boolean(this.element && !this.element.paused && !this.element.ended);
  }

  /** Plays base64 audio, resolving when it finishes or is stopped. */
  async play(base64: string, mimeType: string): Promise<void> {
    const element = this.ensureElement();
    this.stop();

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
        this.revoke();
      };

      element.onended = () => {
        cleanup();
        resolve();
      };
      element.onerror = () => {
        cleanup();
        reject(new PlaybackError("failed", "Could not play the reply"));
      };

      element.play().then(
        () => undefined,
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

  /** Barge-in. Stops immediately and resolves any in-flight `play()`. */
  stop(): void {
    const element = this.element;
    if (!element) return;

    const wasPlaying = !element.paused;
    try {
      element.pause();
      element.currentTime = 0;
    } catch {
      // Nothing loaded yet.
    }

    if (wasPlaying && element.onended) {
      const onended = element.onended;
      element.onended = null;
      element.onerror = null;
      this.revoke();
      onended.call(element, new Event("ended"));
    } else {
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
