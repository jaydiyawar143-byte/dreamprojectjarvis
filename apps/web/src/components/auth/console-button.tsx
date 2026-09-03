"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { springTechnical } from "./motion";

type Props = {
  children: ReactNode;
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost";
};

/**
 * The console's action control.
 *
 * Hover raises it 1px, deepens the cyan bloom and runs a single light sweep
 * across the face. All three are transform/opacity only, and all three are
 * neutralised under prefers-reduced-motion by globals.css and MotionConfig.
 */
export function ConsoleButton({
  children,
  type = "button",
  onClick,
  disabled,
  variant = "primary",
}: Props) {
  const isPrimary = variant === "primary";

  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { y: 0, scale: 0.995 }}
      transition={springTechnical}
      className={`sys-focus group relative w-full overflow-hidden rounded-md py-3.5 font-mono text-[0.65rem] uppercase tracking-hud transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-50 ${
        isPrimary
          ? "border border-sys-cyan/45 bg-sys-cyan/10 text-sys-cyan-soft shadow-[0_0_22px_-10px_rgba(62,224,242,0.7)] hover:border-sys-cyan/85 hover:bg-sys-cyan/[0.16] hover:shadow-[0_0_34px_-8px_rgba(62,224,242,0.85)]"
          : "border border-sys-edge bg-white/[0.02] text-sys-text hover:border-sys-cyan/40 hover:bg-white/[0.04] hover:text-white"
      }`}
    >
      {/* Light sweep on hover. Always rendered so server and client markup
          agree; globals.css drops its transition under reduced motion. */}
      <span
        aria-hidden="true"
        className="sys-sweep pointer-events-none absolute inset-y-0 -left-full w-1/2 skew-x-[-18deg] bg-gradient-to-r from-transparent via-white/[0.14] to-transparent transition-transform duration-700 group-hover:translate-x-[320%]"
      />

      {/* Top edge highlight, brightens on hover */}
      {isPrimary && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-sys-cyan/60 to-transparent opacity-70 transition-opacity duration-300 group-hover:opacity-100"
        />
      )}

      <span className="relative z-10 flex items-center justify-center gap-2">{children}</span>
    </motion.button>
  );
}
