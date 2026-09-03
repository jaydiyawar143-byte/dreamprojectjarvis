"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";
import { BOOT, easeCinematic } from "./motion";

/**
 * Deep-space environment behind the auth console.
 *
 * Everything is CSS or a handful of absolutely-positioned divs — no canvas, no
 * requestAnimationFrame loop, no image assets. Particle count is deliberately
 * small and drops further on small screens (see `count` below); hundreds of
 * animated nodes would cost far more than they add.
 */

type Particle = {
  left: number;
  top: number;
  size: number;
  delay: number;
  duration: number;
  drift: number;
  opacity: number;
};

/**
 * Deterministic pseudo-random field.
 *
 * Two subtleties, both learned the hard way:
 *  - Math.sin is not bit-identical between Node's libm and V8 in the browser.
 *    Unrounded, the server rendered `top:36.423228198509605%` and the client
 *    computed `...198691504%`, which React reports as a hydration mismatch.
 *  - Rounding to 3 decimals is far coarser than that 1e-10 divergence, so both
 *    sides now serialise the exact same string.
 */
function seeded(i: number, salt: number) {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const round = (n: number, dp = 3) => Number(n.toFixed(dp));

function buildParticles(count: number): Particle[] {
  return Array.from({ length: count }, (_, i) => ({
    left: round(seeded(i, 1) * 100),
    top: round(seeded(i, 2) * 100),
    size: round(1 + seeded(i, 3) * 1.8, 2),
    delay: round(seeded(i, 4) * 8, 2),
    duration: round(9 + seeded(i, 5) * 11, 2),
    drift: round(-18 - seeded(i, 6) * 26, 2),
    opacity: round(0.18 + seeded(i, 7) * 0.38, 2),
  }));
}

export function SystemBackground() {

  // 14 particles on desktop. The mobile half is hidden with `hidden sm:block`
  // rather than a resize listener, so there is no JS on the resize path.
  const particles = useMemo(() => buildParticles(14), []);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      {/* Base void */}
      <div className="absolute inset-0 bg-sys-void" />

      {/* Atmospheric radial glows. Two cool sources, kept very low opacity so
          the screen reads as near-black rather than "blue website". */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ ...easeCinematic, duration: 1.2, delay: BOOT.background }}
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 46% at 50% 38%, rgba(23,108,126,0.20) 0%, transparent 68%)," +
            "radial-gradient(46% 40% at 82% 82%, rgba(16,74,96,0.16) 0%, transparent 70%)," +
            "radial-gradient(40% 34% at 12% 16%, rgba(20,90,110,0.13) 0%, transparent 72%)",
        }}
      />

      {/* Technical grid, drifting upward and dissolving at the edges */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.4, delay: BOOT.background }}
        className="sys-grid-mask absolute inset-0"
      >
        <div className="sys-grid animate-grid-drift absolute -inset-y-24 inset-x-0" />
      </motion.div>

      {/* Horizon line — a single bright hairline that grounds the composition */}
      <motion.div
        initial={{ scaleX: 0, opacity: 0 }}
        animate={{ scaleX: 1, opacity: 0.5 }}
        transition={{ duration: 1.6, delay: BOOT.hud, ease: "easeOut" }}
        className="sys-hairline absolute left-0 right-0 top-1/2 h-px origin-center"
      />

      {/* Floating particles */}
      <div className="absolute inset-0">
        {particles.map((p, i) => (
          <span
            key={i}
            className={`sys-particle absolute rounded-full bg-sys-cyan ${i % 2 === 1 ? "hidden sm:block" : ""}`}
            style={{
              left: `${p.left}%`,
              top: `${p.top}%`,
              width: p.size,
              height: p.size,
              opacity: p.opacity,
              boxShadow: "0 0 6px rgba(62,224,242,0.7)",
              // Always emitted so server and client markup match. The
              // prefers-reduced-motion block in globals.css stops it.
              animation: `float-${i % 3} ${p.duration}s ease-in-out ${p.delay}s infinite`,
              // Per-particle drift distance without generating 14 keyframe rules.
              ["--drift" as string]: `${p.drift}px`,
            }}
          />
        ))}
      </div>

      {/* Console backlight. Without a brighter field directly behind the panel
          the backdrop-blur has nothing to refract and the glass reads as a flat
          dark rectangle. This is what makes it look like glass. */}
      <div
        className="absolute left-1/2 top-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(45,150,175,0.20) 0%, rgba(30,110,135,0.10) 45%, transparent 72%)",
        }}
      />

      {/* Vignette — pulls focus to the console. Kept gentle: too strong and it
          swallows the HUD rings, leaving a stray arc in one corner. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 86% 74% at 50% 45%, transparent 46%, rgba(3,6,11,0.72) 100%)",
        }}
      />

      {/* Film grain */}
      <div className="sys-grain absolute inset-0 opacity-[0.16] mix-blend-overlay" />

      {/* Three drift tracks, shared by all particles via modulo above. */}
      <style jsx global>{`
        @keyframes float-0 {
          0%,
          100% {
            transform: translate3d(0, 0, 0);
          }
          50% {
            transform: translate3d(6px, var(--drift), 0);
          }
        }
        @keyframes float-1 {
          0%,
          100% {
            transform: translate3d(0, 0, 0);
          }
          50% {
            transform: translate3d(-9px, var(--drift), 0);
          }
        }
        @keyframes float-2 {
          0%,
          100% {
            transform: translate3d(0, 0, 0);
          }
          50% {
            transform: translate3d(3px, var(--drift), 0);
          }
        }
      `}</style>
    </div>
  );
}
