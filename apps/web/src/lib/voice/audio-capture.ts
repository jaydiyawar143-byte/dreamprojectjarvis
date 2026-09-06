"use client";

// ---------------------------------------------------------------------------
// Sprint 8.3 — Microphone capture.
//
// Push-to-talk only. Every recording begins with a deliberate user gesture and
// ends with one (or with the safety timeout below). There is no voice-activity
// detection and no wake word, so the microphone is never open while the user
// is not actively holding a turn.
//
// Deliberately a plain module rather than a React hook: the voice store drives
// the whole turn, and a hook would tie the microphone's lifetime to a
// component's render cycle — a re-render mid-recording must not drop the take.
// ---------------------------------------------------------------------------

/** Containers to try, best first. Chromium gives WebM/Opus, Safari MP4. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

/**
 * Hard stop for a single take.
 *
 * A push-to-talk turn is seconds long. This exists for the case where the
 * release event never arrives — a dropped pointerup, a tab switch mid-press —
 * so a stuck button cannot leave the microphone recording indefinitely.
 */
export const MAX_RECORDING_MS = 60_000;

/** Below this a "recording" is a mis-tap, not speech. */
const MIN_RECORDING_BYTES = 1024;

export interface CapturedAudio {
  base64: string;
  mimeType: string;
  durationMs: number;
  bytes: number;
}

export type CaptureFailure =
  | "unsupported"
  | "permission-denied"
  | "no-audio"
  | "failed";

export class CaptureError extends Error {
  constructor(readonly reason: CaptureFailure, message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

/**
 * Whether this browser can capture at all.
 *
 * `getUserMedia` is absent outside a secure context, so an app served over
 * plain HTTP on a non-localhost host reports unsupported rather than failing
 * later with a confusing permission error.
 */
export function isCaptureSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder !== "undefined"
  );
}

function pickMimeType(): string {
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // isTypeSupported throws on some older engines; treat as unsupported.
    }
  }
  return "";
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new CaptureError("failed", "Could not read the recording"));
    reader.onloadend = () => {
      const result = String(reader.result ?? "");
      // A data URL: strip the "data:<type>;base64," prefix.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export class AudioCapture {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private onAutoStop: (() => void) | null = null;

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  /**
   * Opens the microphone and begins recording.
   *
   * @param onAutoStop invoked if MAX_RECORDING_MS is reached, so the store can
   *   finish the turn rather than leaving the UI stuck in "listening".
   */
  async start(onAutoStop?: () => void): Promise<void> {
    if (!isCaptureSupported()) {
      throw new CaptureError("unsupported", "This browser cannot record audio");
    }
    if (this.isRecording) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new CaptureError("permission-denied", "Microphone access was denied");
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        throw new CaptureError("no-audio", "No microphone was found");
      }
      throw new CaptureError("failed", "Could not open the microphone");
    }

    const mimeType = pickMimeType();
    try {
      this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      throw new CaptureError("unsupported", "This browser cannot record audio");
    }

    this.stream = stream;
    this.chunks = [];
    this.startedAt = Date.now();
    this.onAutoStop = onAutoStop ?? null;

    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };

    // A timeslice makes the recorder emit as it goes, so a take that is cut
    // short still has whatever was already captured.
    this.recorder.start(250);

    this.timeout = setTimeout(() => {
      if (this.isRecording) this.onAutoStop?.();
    }, MAX_RECORDING_MS);
  }

  /** Stops recording and returns the take, encoded for upload. */
  async stop(): Promise<CapturedAudio> {
    const recorder = this.recorder;
    if (!recorder) {
      throw new CaptureError("failed", "Nothing was being recorded");
    }

    const durationMs = Date.now() - this.startedAt;
    const mimeType = recorder.mimeType || "audio/webm";

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: mimeType }));
      if (recorder.state !== "inactive") {
        recorder.stop();
      } else {
        resolve(new Blob(this.chunks, { type: mimeType }));
      }
    });

    this.release();

    if (blob.size < MIN_RECORDING_BYTES) {
      throw new CaptureError("no-audio", "That recording was too short");
    }

    return {
      base64: await toBase64(blob),
      mimeType,
      durationMs,
      bytes: blob.size,
    };
  }

  /** Abandons the take and releases the microphone. */
  cancel(): void {
    try {
      if (this.recorder && this.recorder.state !== "inactive") {
        this.recorder.onstop = null;
        this.recorder.stop();
      }
    } catch {
      // Already stopped; releasing below is what matters.
    }
    this.release();
  }

  /**
   * Drops the tracks.
   *
   * Not optional housekeeping: while a track is live the browser shows the
   * recording indicator, and on most systems keeps the microphone reserved.
   */
  private release(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.onAutoStop = null;
  }
}
