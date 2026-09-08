"use client";

// ---------------------------------------------------------------------------
// UI V2 — the Orb as the app uses it.
//
// Owns three things the renderers deliberately do not: which renderer can run,
// where the audio comes from, and what state the system is in.
//
// AUDIO LIFECYCLE. A tap is opened when a state begins that has audio to
// analyse, and closed the moment it ends. It follows the voice state machine
// rather than running continuously, so the microphone analyser exists only
// while the microphone is already open for recording — the Orb never causes a
// permission prompt and never holds a stream the voice pipeline has released.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { useVoiceStore, capture, playback } from "@/lib/voice/voice-store";
import {
  SILENT,
  isAnalysisSupported,
  tapElement,
  tapStream,
  type AudioLevels,
  type AudioTap,
} from "@/lib/voice/audio-analyser";
import { ORB_CAPTION, resolveOrbState, type OrbInputs, type OrbState } from "./orb-state";
import { CanvasOrb } from "./canvas-orb";
import { WebGLOrb } from "./webgl-orb";

/**
 * Whether this browser can give us a WebGL context.
 *
 * Probed with a throwaway canvas rather than by feature-sniffing the UA: a
 * driver can refuse a context on hardware that claims support, and the only
 * reliable question is whether asking for one actually works.
 */
function detectWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (!gl) return false;
    // Release it immediately; contexts are a capped resource.
    (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export interface JarvisOrbProps {
  /** Non-voice activity the Orb should also express. */
  status?: Omit<OrbInputs, "voice">;
  className?: string;
  /** Rendered under the orb. Usually the caption. */
  showCaption?: boolean;
}

export function JarvisOrb({ status, className, showCaption = true }: JarvisOrbProps) {
  const voice = useVoiceStore((s) => s.state);

  // `null` until probed, so nothing renders on the server and the two
  // renderers never both mount.
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  // Audio is written every frame by the analyser and read every frame by the
  // renderer. A ref, never state: this must not re-render React 60 times a
  // second.
  const levelsRef = useRef<AudioLevels>({ ...SILENT });

  useEffect(() => {
    setWebgl(detectWebGL());

    // `matchMedia` is absent in some embedding contexts and in jsdom. Its
    // absence means "no stated preference", which is the same as not reducing
    // motion — never a reason to fail to render the Orb at all.
    if (typeof window.matchMedia !== "function") return;

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);

    // Safari below 14 only has the deprecated addListener form.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    query.addListener?.(onChange);
    return () => query.removeListener?.(onChange);
  }, []);

  const state: OrbState = useMemo(
    () => resolveOrbState({ voice, ...(status ?? {}) }),
    [voice, status]
  );

  // -------------------------------------------------------------------------
  // Audio taps, opened and closed with the voice state.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!isAnalysisSupported()) return;

    const wantsMic = voice === "listening";
    const wantsOutput = voice === "speaking";
    if (!wantsMic && !wantsOutput) {
      levelsRef.current = { ...SILENT };
      return;
    }

    let tap: AudioTap | null = null;
    let raf = 0;
    let cancelled = false;
    let attempts = 0;

    /**
     * Attaches as soon as the source is genuinely available.
     *
     * Both sources appear a moment AFTER the state changes — the recorder is
     * still opening, or playback has not begun — and tapping an element that is
     * not yet playing is refused by design (it would mute the reply). So this
     * retries for a short window and then gives up quietly, leaving the Orb on
     * its idle animation rather than faking a reaction.
     */
    const attach = () => {
      if (cancelled || tap) return;

      const source = wantsMic ? capture.getStream() : playback.getElement();
      if (source) {
        tap = wantsMic
          ? tapStream(source as MediaStream)
          : tapElement(source as HTMLMediaElement);
      }

      if (!tap) {
        attempts += 1;
        // ~2s at 60fps. Long enough for playback to start, short enough that a
        // genuinely absent source stops costing frames.
        if (attempts < 120) raf = requestAnimationFrame(attach);
        return;
      }
      raf = requestAnimationFrame(pump);
    };

    const pump = () => {
      if (cancelled || !tap) return;
      levelsRef.current = tap.read();
      raf = requestAnimationFrame(pump);
    };

    attach();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      tap?.stop();
      // Back to silence, so a stale reading cannot keep the Orb lit after the
      // turn has ended.
      levelsRef.current = { ...SILENT };
    };
  }, [voice]);

  const caption = ORB_CAPTION[state];

  return (
    <div className={className}>
      <div className="relative aspect-square w-full">
        {webgl === true && (
          <WebGLOrb
            state={state}
            levelsRef={levelsRef}
            reducedMotion={reducedMotion}
            className="absolute inset-0 h-full w-full"
          />
        )}
        {webgl === false && (
          <CanvasOrb
            state={state}
            levelsRef={levelsRef}
            reducedMotion={reducedMotion}
            className="absolute inset-0 h-full w-full"
          />
        )}

        {/*
          The state in text, for screen readers and for anyone who cannot read
          a colour change. `aria-live` is polite so it never interrupts.
        */}
        <p className="sr-only" role="status" aria-live="polite">
          JARVIS status: {caption}
        </p>
      </div>

      {showCaption && (
        <p
          data-testid="orb-caption"
          data-orb-state={state}
          className="mt-3 text-center font-mono text-[0.58rem] uppercase tracking-hud text-sys-dim"
        >
          {caption}
        </p>
      )}
    </div>
  );
}
