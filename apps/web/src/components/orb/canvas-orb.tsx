"use client";

// ---------------------------------------------------------------------------
// UI V2 — 2D fallback Orb.
//
// Shown when WebGL is unavailable: an old GPU, a locked-down browser, a
// software-rendering VM, or a context the driver refused. It implements the
// SAME contract as the WebGL orb (orb-state.ts), so state and audio remain
// readable — this is a substitute, not a placeholder.
//
// It is still a projected particle system rather than a pulsing div: points are
// carried in 3D and projected by hand each frame, so rotation still produces
// real depth and occlusion ordering. What it drops is the per-pixel glow, which
// is the expensive part, in favour of cheap radial gradients.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import { ORB_APPEARANCE, type OrbState } from "./orb-state";
import type { AudioLevels } from "@/lib/voice/audio-analyser";

/** Far fewer than the GPU version: this loop runs on the main thread. */
const PARTICLE_COUNT = 460;
const MAX_PIXEL_RATIO = 1.5;

interface Particle {
  x: number;
  y: number;
  z: number;
  size: number;
  seed: number;
}

function seed(): Particle[] {
  const points: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Same inverse-CDF sampling as the WebGL orb, for the same reason: two
    // uniform angles would clump at the poles.
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = 1 - Math.random() * 0.25;
    points.push({
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.sin(phi) * Math.sin(theta),
      z: r * Math.cos(phi),
      size: 0.5 + Math.random() * 1.5,
      seed: Math.random(),
    });
  }
  return points;
}

export function CanvasOrb({
  state,
  levelsRef,
  className,
  reducedMotion = false,
}: {
  state: OrbState;
  levelsRef: React.MutableRefObject<AudioLevels>;
  className?: string;
  reducedMotion?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OrbState>(state);
  stateRef.current = state;
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const particles = seed();
    let frame = 0;
    let width = 0;
    let height = 0;
    let onScreen = true;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const intersection = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0.01 }
    );
    intersection.observe(canvas);

    const current = { ...ORB_APPEARANCE.idle };
    let hue = ORB_APPEARANCE.idle.hue;
    const smoothed: AudioLevels = { level: 0, bass: 0, mid: 0, treble: 0 };
    let rotation = 0;
    let time = 0;
    let last = performance.now();

    const render = (now: number) => {
      frame = requestAnimationFrame(render);

      const delta = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (!onScreen || document.visibilityState === "hidden" || width === 0) return;

      const target = ORB_APPEARANCE[stateRef.current];
      const damp = reducedRef.current ? 0.35 : 1;
      const ease = (from: number, to: number, rate: number) =>
        from + (to - from) * (1 - Math.exp(-rate * delta));

      current.intensity = ease(current.intensity, target.intensity, 4);
      current.turbulence = ease(current.turbulence, target.turbulence * damp, 3.4);
      current.scale = ease(current.scale, target.scale, 4);
      current.pulse = ease(current.pulse, target.pulse * damp, 3.4);
      current.spin = ease(current.spin, target.spin * damp, 2.6);

      let dh = target.hue - hue;
      if (dh > 180) dh -= 360;
      if (dh < -180) dh += 360;
      hue = (hue + dh * (1 - Math.exp(-3.2 * delta)) + 360) % 360;

      const live = levelsRef.current;
      const gain = target.audioResponse;
      const blend = (from: number, to: number) =>
        ease(from, to * gain, to * gain > from ? 22 : 7);
      smoothed.level = blend(smoothed.level, live.level);
      smoothed.bass = blend(smoothed.bass, live.bass);
      smoothed.mid = blend(smoothed.mid, live.mid);

      time += delta * (reducedRef.current ? 0.4 : 1);
      rotation += current.spin * delta;

      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * 0.34 * current.scale;

      ctx.clearRect(0, 0, width, height);
      // Additive, so overlapping points build a glow the way they do on the GPU.
      ctx.globalCompositeOperation = "lighter";

      // Core halo.
      const coreEnergy = current.intensity + smoothed.bass * 0.5;
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.5);
      halo.addColorStop(0, `hsla(${hue}, 90%, 72%, ${0.32 * coreEnergy})`);
      halo.addColorStop(0.45, `hsla(${hue + 20}, 85%, 60%, ${0.12 * coreEnergy})`);
      halo.addColorStop(1, "hsla(0, 0%, 0%, 0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, width, height);

      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const tilt = Math.sin(time * 0.22) * 0.16;

      // Painter's algorithm: sort back-to-front so nearer particles overlay far
      // ones. Without it the cloud loses its depth entirely.
      const projected: Array<{ x: number; y: number; z: number; size: number; energy: number }> = [];

      for (const p of particles) {
        const breathe = Math.sin(time * 1.1 + p.seed * 6.28318) * current.pulse;
        const push = smoothed.mid * current.turbulence * 0.44 + smoothed.bass * 0.3;
        const drift = Math.sin(time * 0.6 + p.seed * 12.0) * current.turbulence * 0.16;
        const scale = 1 + breathe + push + drift;

        // Y rotation, then a small X tilt.
        const x = p.x * cos - p.z * sin;
        const z0 = p.x * sin + p.z * cos;
        const y = p.y * Math.cos(tilt) - z0 * Math.sin(tilt);
        const z = p.y * Math.sin(tilt) + z0 * Math.cos(tilt);

        const perspective = 2.6 / (2.6 - z * 0.55);
        projected.push({
          x: cx + x * radius * scale * perspective,
          y: cy + y * radius * scale * perspective,
          z,
          size: p.size * perspective * (0.75 + smoothed.level * 0.55),
          energy: Math.min(1, Math.abs(breathe + push) * 1.6 + smoothed.level * 0.5),
        });
      }

      projected.sort((a, b) => a.z - b.z);

      for (const p of projected) {
        const depthFade = 0.35 + 0.65 * ((p.z + 1) / 2);
        const alpha = Math.min(1, 0.55 * depthFade * current.intensity + smoothed.level * 0.25);
        const light = 60 + p.energy * 26;
        ctx.beginPath();
        ctx.fillStyle = `hsla(${hue + p.energy * 26}, 88%, ${light}%, ${alpha})`;
        ctx.arc(p.x, p.y, Math.max(0.4, p.size), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = "source-over";
    };

    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
    };
  }, [levelsRef]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
