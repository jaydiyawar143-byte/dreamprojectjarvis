"use client";

import { AnimatePresence, motion } from "framer-motion";
import { LoginForm } from "./login-form";
import { SignupForm } from "./signup-form";
import { SocialAuth } from "./social-auth";
import { AuthStatus, type AuthPhase, type StageKey, type StageState } from "./auth-status";
import { consoleIn, panelSwap, riseIn, BOOT } from "./motion";

export type AuthMode = "login" | "signup";

/**
 * The glass command console: HUD framing, the active form panel, the alternate
 * channel, and the status overlay that covers it during authentication.
 */
export function AuthConsole({
  mode,
  direction,
  busy,
  phase,
  stages,
  error,
  onLogin,
  onSignup,
  onSwitch,
  onDismissError,
  googleEnabled,
  onGoogle,
}: {
  mode: AuthMode;
  direction: number;
  busy: boolean;
  phase: AuthPhase;
  stages: Record<StageKey, StageState>;
  error?: string;
  onLogin: (email: string, password: string) => void;
  onSignup: (email: string, name: string, password: string) => void;
  onSwitch: (mode: AuthMode) => void;
  onDismissError: () => void;
  /** Server-reported Google availability; null while being probed. */
  googleEnabled: boolean | null;
  onGoogle: () => void;
}) {
  const isLogin = mode === "login";

  return (
    <motion.div
      variants={consoleIn()}
      initial="hidden"
      animate="show"
      className="sys-glass sys-rim relative w-full rounded-xl border border-white/[0.07] p-6 shadow-console sm:p-8"
    >
      {/* ---- Console header: title + node id ---- */}
      <motion.div
        variants={riseIn()}
        initial="hidden"
        animate="show"
        transition={{ delay: BOOT.controls - 0.08 }}
        className="mb-6 flex items-center justify-between border-b border-sys-line pb-4"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-3 w-px bg-sys-cyan/70"
          />
          {/* aria-live so the heading change is announced on mode switch */}
          <h2
            aria-live="polite"
            className="font-mono text-xs uppercase tracking-hud text-sys-text sm:text-sm"
          >
            {isLogin ? "Operator Identification" : "Initialize Operator"}
          </h2>
        </div>
        <span
          aria-hidden="true"
          className="font-mono text-chrome uppercase tracking-hud text-sys-dim/60"
        >
          {isLogin ? "AUTH/01" : "AUTH/02"}
        </span>
      </motion.div>

      {/* ---- Swapping form panel ----
          `mode="wait"` so the outgoing panel finishes before the incoming one
          starts; the two never overlap and the console height settles once. */}
      <AnimatePresence mode="wait" initial={false} custom={direction}>
        <motion.div
          key={mode}
          variants={panelSwap(direction)}
          initial="hidden"
          animate="show"
          exit="exit"
        >
          {isLogin ? (
            <LoginForm busy={busy} onSubmit={onLogin} />
          ) : (
            <SignupForm busy={busy} onSubmit={onSignup} />
          )}
        </motion.div>
      </AnimatePresence>

      {/* ---- Alternate channel ---- */}
      <motion.div
        variants={riseIn()}
        initial="hidden"
        animate="show"
        transition={{ delay: BOOT.controls + 0.18 }}
        className="mt-6"
      >
        <SocialAuth busy={busy} enabled={googleEnabled} onGoogle={onGoogle} />
      </motion.div>

      {/* ---- Mode switch ---- */}
      <motion.p
        variants={riseIn()}
        initial="hidden"
        animate="show"
        transition={{ delay: BOOT.controls + 0.26 }}
        className="mt-6 text-center font-mono text-xs uppercase tracking-hud text-sys-dim"
      >
        {isLogin ? "New operator? " : "Already registered? "}
        <button
          type="button"
          onClick={() => onSwitch(isLogin ? "signup" : "login")}
          disabled={busy}
          className="sys-focus rounded text-sys-cyan underline-offset-4 transition-colors hover:text-sys-cyan-soft hover:underline disabled:opacity-50"
        >
          {isLogin ? "Create Identity" : "Access System"}
        </button>
      </motion.p>

      {/* ---- Console corner brackets ---- */}
      {(
        [
          "left-0 top-0 border-l border-t",
          "right-0 top-0 border-r border-t",
          "left-0 bottom-0 border-b border-l",
          "right-0 bottom-0 border-b border-r",
        ] as const
      ).map((c) => (
        <span
          key={c}
          aria-hidden="true"
          className={`pointer-events-none absolute h-4 w-4 border-sys-cyan/40 ${c}`}
        />
      ))}

      {/* ---- Status overlay ---- */}
      <AnimatePresence>
        {phase !== "idle" && (
          <AuthStatus
            phase={phase}
            stages={stages}
            error={error}
            onDismiss={phase === "denied" ? onDismissError : undefined}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
