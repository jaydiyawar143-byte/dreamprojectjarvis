"use client";

import { motion } from "framer-motion";
import { BOOT} from "./motion";

/**
 * Ambient technical metadata pinned to the screen corners.
 *
 * Kept to four short readings — enough to sell "operating system", far short of
 * filling the screen with noise. Hidden below `sm` so it can never compete with
 * the form on a phone, and `aria-hidden` because it carries no user meaning.
 */

const READINGS = [
  { pos: "left-8 top-8", lines: ["SYS.NODE // 07", "SECURE CHANNEL"], align: "text-left" },
  { pos: "right-8 top-8", lines: ["PROTOCOL // JRV-01", "ENCRYPTION ACTIVE"], align: "text-right" },
  { pos: "left-8 bottom-8", lines: ["NEURAL CORE ONLINE", "LAT 18.52 / LON 73.85"], align: "text-left" },
  { pos: "right-8 bottom-8", lines: ["BUILD 0.1.0", "UPLINK STABLE"], align: "text-right" },
] as const;

export function SystemTelemetry() {

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 hidden sm:block">
      {READINGS.map((r, i) => (
        <motion.div
          key={r.pos}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.9, delay: BOOT.hud + 0.25 + i * 0.09 }}
          className={`absolute ${r.pos} ${r.align} font-mono text-chrome uppercase leading-relaxed tracking-[0.18em] text-sys-dim/45`}
        >
          {r.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </motion.div>
      ))}
    </div>
  );
}
