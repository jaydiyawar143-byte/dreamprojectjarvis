import type { Transition, Variants } from "framer-motion";

/**
 * Shared motion vocabulary for the auth experience.
 *
 * Three rules hold everywhere:
 *
 *  1. Only `transform` and `opacity` are animated, so every transition stays on
 *     the compositor and never triggers layout.
 *
 *  2. NOTHING here branches on prefers-reduced-motion. The server cannot know
 *     that preference, so any markup or inline style derived from it differs
 *     between the server render and the first client render — which React
 *     reports as "Hydration failed because the initial UI does not match".
 *     Reduced motion is handled in two places instead:
 *       - Framer transitions: <MotionConfig reducedMotion="user"> in
 *         auth-experience.tsx, applied at animation time, not render time.
 *       - CSS keyframe loops: the prefers-reduced-motion block in globals.css,
 *         which applies from the very first paint.
 *
 *  3. Nothing is animation-gated. If motion never runs, the same content is
 *     still present and usable.
 */

/** Technical, slightly damped. No overshoot wobble. */
export const springTechnical: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 30,
  mass: 0.9,
};

/** Cinematic ease for fades and larger reveals. */
export const easeCinematic: Transition = {
  duration: 0.55,
  ease: [0.22, 0.61, 0.36, 1],
};

/** Boot sequence step delays (seconds). Background → HUD → console → controls. */
export const BOOT = {
  background: 0,
  hud: 0.18,
  rings: 0.3,
  console: 0.42,
  brand: 0.62,
  controls: 0.78,
} as const;

/** Fade + lift. The default entrance for stacked console content. */
export function riseIn(delay = 0): Variants {
  return {
    hidden: { opacity: 0, y: 14 },
    show: {
      opacity: 1,
      y: 0,
      transition: { ...easeCinematic, delay },
    },
  };
}

/** Container that releases its children one after another. */
export function stagger(delayChildren = 0, step = 0.07): Variants {
  return {
    hidden: {},
    show: { transition: { staggerChildren: step, delayChildren } },
  };
}

/** The console body scaling into place — 0.96 → 1, per the boot sequence. */
export function consoleIn(): Variants {
  return {
    hidden: { opacity: 0, scale: 0.96, y: 10 },
    show: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: { ...springTechnical, delay: BOOT.console },
    },
  };
}

/**
 * Horizontal swap between the login and signup panels. Direction is +1 when
 * moving login → signup and -1 coming back, so the two panels slide past each
 * other rather than both entering from the same side.
 */
export function panelSwap(direction: number): Variants {
  const shift = 26 * direction;
  return {
    hidden: { opacity: 0, x: shift },
    show: {
      opacity: 1,
      x: 0,
      transition: { duration: 0.34, ease: [0.22, 0.61, 0.36, 1] },
    },
    exit: {
      opacity: 0,
      x: -shift,
      transition: { duration: 0.22, ease: "easeIn" },
    },
  };
}
