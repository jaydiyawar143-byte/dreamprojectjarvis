"use client";

import { motion } from "framer-motion";
import { BOOT, easeCinematic} from "./motion";

/**
 * Decorative HUD framing: concentric scanning rings behind the console, screen
 * corner brackets, and thin telemetry rules.
 *
 * All of it is inline SVG + CSS rotation. The rings sit behind the console at
 * low opacity and are hidden below `md` so they can never crowd or overlap the
 * form on a phone.
 *
 * `intensity` rises during the success transition so the HUD can bloom outward
 * as the app hands off to the dashboard.
 */
export function HUDLayer({ intensity = 0 }: { intensity?: number }) {

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      {/* ---- Concentric rings, centred behind the console ----
          Centring lives on this plain wrapper, NOT on the motion element.
          Framer writes an inline `transform` for scale/rotate, which silently
          overrides Tailwind's -translate-x-1/2 -translate-y-1/2 utilities — the
          rings then hang off the screen centre by half their own size instead
          of being centred on it. Separating the two keeps both correct. */}
      <div className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 md:block">
        <motion.div
          initial={{ opacity: 0, scale: 0.9, rotate: -8 }}
          animate={{
            opacity: 1,
            scale: 1 + intensity * 0.16,
            rotate: 0,
          }}
          transition={{ type: "spring", stiffness: 60, damping: 18, delay: BOOT.rings }}
          className="relative h-[760px] w-[760px] lg:h-[880px] lg:w-[880px]"
        >
          {/* Outer ring — dashed, slow clockwise */}
          <svg
            viewBox="0 0 400 400"
            className="sys-ring animate-spin-slow absolute inset-0 h-full w-full"
            style={{ opacity: 0.62 + intensity * 0.38 }}
          >
            <circle
              cx="200"
              cy="200"
              r="196"
              fill="none"
              stroke="rgba(62,224,242,0.42)"
              strokeWidth="0.5"
              strokeDasharray="2 10"
            />
            {/* Four arc segments at the cardinal points */}
            {[0, 90, 180, 270].map((deg) => (
              <path
                key={deg}
                d="M 200 12 A 188 188 0 0 1 260 22"
                fill="none"
                stroke="rgba(62,224,242,0.55)"
                strokeWidth="1"
                transform={`rotate(${deg} 200 200)`}
              />
            ))}
          </svg>

          {/* Mid ring — counter-rotating, solid hairline with node dots */}
          <svg
            viewBox="0 0 400 400"
            className="sys-ring animate-spin-reverse absolute inset-[9%] h-[82%] w-[82%]"
            style={{ opacity: 0.6 + intensity * 0.4 }}
          >
            <circle
              cx="200"
              cy="200"
              r="190"
              fill="none"
              stroke="rgba(62,224,242,0.26)"
              strokeWidth="0.75"
            />
            {[30, 150, 210, 330].map((deg) => {
              const rad = (deg * Math.PI) / 180;
              return (
                <circle
                  key={deg}
                  cx={200 + 190 * Math.cos(rad)}
                  cy={200 + 190 * Math.sin(rad)}
                  r="2.4"
                  fill="rgba(62,224,242,0.75)"
                />
              );
            })}
          </svg>

          {/* Inner ring — long sweeping arc, the most visible motion cue */}
          <svg
            viewBox="0 0 400 400"
            className="sys-ring animate-spin-slow absolute inset-[20%] h-[60%] w-[60%]"
            style={{ opacity: 0.66 + intensity * 0.34, animationDuration: "22s" }}
          >
            <circle
              cx="200"
              cy="200"
              r="184"
              fill="none"
              stroke="rgba(62,224,242,0.20)"
              strokeWidth="1"
            />
            <path
              d="M 200 16 A 184 184 0 0 1 340 110"
              fill="none"
              stroke="rgba(62,224,242,0.6)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="M 200 384 A 184 184 0 0 1 60 290"
              fill="none"
              stroke="rgba(62,224,242,0.35)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </motion.div>
      </div>

      {/* ---- Screen corner brackets ---- */}
      {(
        [
          ["top-6 left-6", "border-t border-l", "sm:top-8 sm:left-8"],
          ["top-6 right-6", "border-t border-r", "sm:top-8 sm:right-8"],
          ["bottom-6 left-6", "border-b border-l", "sm:bottom-8 sm:left-8"],
          ["bottom-6 right-6", "border-b border-r", "sm:bottom-8 sm:right-8"],
        ] as const
      ).map(([pos, edges, sm], i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 0.55 + intensity * 0.45, scale: 1 }}
          transition={{ ...easeCinematic, delay: BOOT.hud + i * 0.06 }}
          className={`absolute h-8 w-8 border-sys-cyan/45 sm:h-12 sm:w-12 ${pos} ${edges} ${sm}`}
        />
      ))}

      {/* ---- Side telemetry rules (desktop only) ---- */}
      <motion.div
        initial={{ scaleY: 0 }}
        animate={{ scaleY: 1 }}
        transition={{ duration: 1.1, delay: BOOT.hud }}
        className="absolute left-8 top-1/2 hidden h-40 w-px origin-center -translate-y-1/2 bg-gradient-to-b from-transparent via-sys-cyan/30 to-transparent lg:block"
      />
      <motion.div
        initial={{ scaleY: 0 }}
        animate={{ scaleY: 1 }}
        transition={{ duration: 1.1, delay: BOOT.hud }}
        className="absolute right-8 top-1/2 hidden h-40 w-px origin-center -translate-y-1/2 bg-gradient-to-b from-transparent via-sys-cyan/30 to-transparent lg:block"
      />

      {/* ---- Central bloom, only during the success handoff ----
          Same wrapper split as the rings above, so a future transform-based
          tweak here can't knock it off centre. */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <motion.div
          initial={false}
          animate={{ opacity: intensity }}
          transition={{ duration: 0.5 }}
          className="h-[520px] w-[520px] rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(62,224,242,0.30) 0%, rgba(62,224,242,0.08) 42%, transparent 70%)",
          }}
        />
      </div>
    </div>
  );
}
