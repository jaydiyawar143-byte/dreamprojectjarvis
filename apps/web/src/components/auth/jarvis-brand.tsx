"use client";

import { motion } from "framer-motion";
import { BOOT, riseIn, stagger } from "./motion";

/**
 * Wordmark block. The concept of an intelligent system is carried by the
 * interface itself — there is deliberately no robot illustration here.
 */
export function JarvisBrand() {

  return (
    <motion.div
      variants={stagger(BOOT.brand, 0.08)}
      initial="hidden"
      animate="show"
      className="flex flex-col items-center text-center"
    >
      {/* Crosshair rule above the wordmark */}
      <motion.div
        variants={riseIn()}
        className="mb-5 flex items-center gap-3"
        aria-hidden="true"
      >
        <span className="h-px w-8 bg-gradient-to-r from-transparent to-sys-cyan/50" />
        <span className="h-1 w-1 rotate-45 bg-sys-cyan/70" />
        <span className="h-px w-8 bg-gradient-to-l from-transparent to-sys-cyan/50" />
      </motion.div>

      <motion.h1
        variants={riseIn()}
        className="text-[1.65rem] font-semibold leading-none tracking-[0.3em] text-white sm:text-[2rem]"
      >
        {/* Spaced letterform, but read as one word by assistive tech. */}
        <span aria-hidden="true">J.A.R.V.I.S.</span>
        <span className="sr-only">JARVIS</span>
      </motion.h1>

      <motion.p
        variants={riseIn()}
        className="mt-3 font-mono text-xs uppercase tracking-hud text-sys-dim sm:text-sm"
      >
        Artificial Intelligence System
      </motion.p>

      <motion.div
        variants={riseIn()}
        transition={{ duration: 0.6, delay: BOOT.brand }}
        className="mt-5 h-px w-24 bg-gradient-to-r from-transparent via-sys-cyan/40 to-transparent"
        aria-hidden="true"
      />
    </motion.div>
  );
}
