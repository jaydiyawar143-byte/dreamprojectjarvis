"use client";

import { motion } from "framer-motion";
import { BOOT, easeCinematic} from "./motion";

export type SystemState = "online" | "authenticating" | "granted" | "denied";

const LABEL: Record<SystemState, string> = {
  online: "System Online",
  authenticating: "Verifying Operator",
  granted: "J.A.R.V.I.S. Online",
  denied: "Access Denied",
};

const TONE: Record<SystemState, { dot: string; text: string; ring: string }> = {
  online: { dot: "bg-sys-ok", text: "text-sys-dim", ring: "bg-sys-ok/20" },
  authenticating: { dot: "bg-sys-cyan", text: "text-sys-cyan/80", ring: "bg-sys-cyan/20" },
  granted: { dot: "bg-sys-ok", text: "text-sys-ok", ring: "bg-sys-ok/25" },
  denied: { dot: "bg-sys-danger", text: "text-sys-danger", ring: "bg-sys-danger/20" },
};

/**
 * Live system indicator. `aria-live="polite"` so a screen reader announces the
 * state change (authenticating → granted/denied) without the user hunting for
 * it, but politely enough not to interrupt the form.
 */
export function SystemStatus({ state }: { state: SystemState }) {
  const tone = TONE[state];

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...easeCinematic, delay: BOOT.brand + 0.1 }}
      className="flex items-center justify-center gap-2.5"
    >
      <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
        {/* Halo only while idle — during auth the dot itself carries the motion */}
        {state === "online" && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${tone.ring}`}
          />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${tone.dot} animate-sys-pulse`} />
      </span>

      <span
        aria-live="polite"
        className={`font-mono text-xs uppercase tracking-hud transition-colors duration-300 sm:text-sm ${tone.text}`}
      >
        {LABEL[state]}
      </span>
    </motion.div>
  );
}
