"use client";

// ---------------------------------------------------------------------------
// UI V2 — real audio analysis for the Orb.
//
// The Orb must react to what is ACTUALLY happening, so this reads the same
// microphone stream the recorder is using and the same element the reply plays
// through. Nothing here synthesises motion; when there is no audio to measure
// it reports zero and the Orb settles into its idle state on its own.
//
// TWO RULES KEEP THIS FROM BREAKING VOICE.
//
// 1. `createMediaElementSource` is IRREVERSIBLE and single-use. Once an element
//    is routed into a Web Audio graph, it stops going to the speakers on its
//    own — if the graph is not connected to a destination, or the context is
//    suspended, the reply goes SILENT. So the element is tapped only once
//    playback is already running on a running context, the source is cached per
//    element, and it is always wired through to `destination`. On any failure
//    the tap is abandoned and audio is left exactly as it was.
//
// 2. The microphone tap is read-only. `createMediaStreamSource` does not
//    consume the stream and does not disturb the MediaRecorder reading the same
//    tracks. This never stops, mutes or reconfigures a track — recording owns
//    that lifecycle.
//
// Everything degrades to "no reactivity", never to "no audio".
// ---------------------------------------------------------------------------

/** A reading of the current audio, normalised to 0..1. */
export interface AudioLevels {
  /** Overall loudness (RMS). Drives scale and brightness. */
  level: number;
  /** Low band — vowels, body. Drives the core's swell. */
  bass: number;
  /** Mid band — most of the voice. Drives particle displacement. */
  mid: number;
  /** High band — consonants, sibilance. Drives sparkle and jitter. */
  treble: number;
}

export const SILENT: AudioLevels = { level: 0, bass: 0, mid: 0, treble: 0 };

/** Small FFT: the Orb needs bands, not a spectrogram, and this is cheap. */
const FFT_SIZE = 256;

let sharedContext: AudioContext | null = null;

/**
 * The one AudioContext for the page.
 *
 * Browsers cap how many can exist, and each holds an audio thread, so a context
 * per component would leak until the tab was closed.
 */
function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  if (!sharedContext || sharedContext.state === "closed") {
    try {
      sharedContext = new Ctor();
    } catch {
      return null;
    }
  }
  return sharedContext;
}

// One source per element, forever: calling createMediaElementSource twice on
// the same element throws, and the error is unrecoverable for that element.
const elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

/**
 * Reads bands off an AnalyserNode.
 *
 * Kept as a standalone function so both taps share one definition of what
 * "bass" and "treble" mean.
 */
function makeReader(analyser: AnalyserNode): () => AudioLevels {
  const freq = new Uint8Array(analyser.frequencyBinCount);
  const time = new Uint8Array(analyser.fftSize);

  // Band edges as fractions of the spectrum. The useful voice energy sits well
  // below Nyquist, so the top of the range is deliberately not sampled.
  const bassEnd = Math.floor(freq.length * 0.12);
  const midEnd = Math.floor(freq.length * 0.45);
  const trebleEnd = Math.floor(freq.length * 0.8);

  const average = (from: number, to: number): number => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += freq[i] ?? 0;
    const span = Math.max(1, to - from);
    return sum / span / 255;
  };

  return () => {
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(time);

    // RMS from the time domain rather than the spectrum: it tracks perceived
    // loudness, and it is what makes a whisper and a shout look different
    // rather than merely differently coloured.
    let sumSquares = 0;
    for (let i = 0; i < time.length; i++) {
      const centred = ((time[i] ?? 128) - 128) / 128;
      sumSquares += centred * centred;
    }
    const rms = Math.sqrt(sumSquares / time.length);

    return {
      // Scaled so ordinary speech lands near the middle of the range instead
      // of barely moving the Orb.
      level: Math.min(1, rms * 3.2),
      bass: Math.min(1, average(0, bassEnd) * 1.3),
      mid: Math.min(1, average(bassEnd, midEnd) * 1.6),
      treble: Math.min(1, average(midEnd, trebleEnd) * 2.2),
    };
  };
}

/** A live tap. `read()` is safe to call every frame; `stop()` releases it. */
export interface AudioTap {
  read: () => AudioLevels;
  stop: () => void;
}

/**
 * Analyses a live microphone stream.
 *
 * Returns null when Web Audio is unavailable, which the Orb treats as "no
 * reactivity" rather than as an error.
 */
export function tapStream(stream: MediaStream): AudioTap | null {
  const ctx = getContext();
  if (!ctx) return null;

  try {
    // A suspended context yields all-zero data. Resuming is safe here because
    // this is reached from the microphone press, which is a user gesture.
    if (ctx.state === "suspended") void ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    // Some smoothing in the node itself: the Orb does its own easing on top,
    // but raw frame-to-frame values are jittery enough to look like noise.
    analyser.smoothingTimeConstant = 0.75;

    source.connect(analyser);
    // Deliberately NOT connected to destination — routing the microphone to
    // the speakers is feedback, not monitoring.

    const read = makeReader(analyser);
    return {
      read,
      stop: () => {
        try {
          source.disconnect();
          analyser.disconnect();
        } catch {
          // Already torn down.
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Analyses the reply audio as it plays.
 *
 * Returns null unless it is genuinely safe to tap: the element must already be
 * playing and the context must be running. That ordering is what guarantees a
 * failure here can never silence a reply — see rule 1 in the file header.
 */
export function tapElement(element: HTMLMediaElement): AudioTap | null {
  const ctx = getContext();
  if (!ctx) return null;

  // Refuse to tap audio that is not already audible. If the context cannot run,
  // routing the element through it would mute the reply outright.
  if (element.paused || ctx.state !== "running") return null;

  try {
    let source = elementSources.get(element);
    if (!source) {
      source = ctx.createMediaElementSource(element);
      elementSources.set(element, source);
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.75;

    source.connect(analyser);
    // The reply must still reach the speakers. Connecting the SOURCE straight
    // to the destination (rather than chaining through the analyser) means the
    // audio path does not depend on the analyser surviving.
    source.connect(ctx.destination);

    const read = makeReader(analyser);
    return {
      read,
      stop: () => {
        try {
          // Only the analyser is released. The source stays connected to the
          // destination for the life of the element: disconnecting it would
          // permanently silence every later reply, because the element can
          // never be un-routed from the graph.
          analyser.disconnect();
          source!.disconnect(analyser);
        } catch {
          // Already torn down.
        }
      },
    };
  } catch {
    return null;
  }
}

/** True when this browser can analyse audio at all. */
export function isAnalysisSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext
  );
}
