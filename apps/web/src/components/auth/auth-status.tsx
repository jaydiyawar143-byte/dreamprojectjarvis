"use client";

import { motion } from "framer-motion";
import { AlertTriangle, Check, ShieldCheck } from "lucide-react";
import { springTechnical } from "./motion";

export type StageKey = "identity" | "credential" | "security" | "system";
export type StageState = "pending" | "active" | "ok" | "failed";
export type AuthPhase = "idle" | "authenticating" | "granted" | "denied";

export const STAGE_ORDER: StageKey[] = ["identity", "credential", "security", "system"];

const STAGE_LABEL: Record<StageKey, string> = {
  identity: "Identity",
  credential: "Credential",
  security: "Security",
  system: "System",
};

/** Dot-leader row: "IDENTITY ......... VERIFYING" */
function StageRow({
  label,
  state,
  index,
}: {
  label: string;
  state: StageState;
  index: number;
}) {
  const text =
    state === "ok" ? "OK" : state === "failed" ? "FAILED" : state === "active" ? "VERIFYING" : "—";

  const tone =
    state === "ok"
      ? "text-sys-ok"
      : state === "failed"
        ? "text-sys-danger"
        : state === "active"
          ? "text-sys-cyan"
          : "text-sys-dim";

  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className="flex items-baseline gap-2 font-mono text-xs uppercase tracking-[0.14em]"
    >
      <span className={state === "pending" ? "text-sys-dim" : "text-sys-text"}>{label}</span>
      {/* Dot leader fills the gap and keeps the status column aligned */}
      <span
        aria-hidden="true"
        className="min-w-0 flex-1 translate-y-[-2px] overflow-hidden text-sys-dim"
      >
        ........................................
      </span>
      <span className={`shrink-0 tabular-nums ${tone}`}>
        {state === "active" ? (
          <span className="inline-flex items-center gap-1">
            <span className="h-1 w-1 animate-sys-pulse rounded-full bg-sys-cyan" />
            {text}
          </span>
        ) : (
          text
        )}
      </span>
    </motion.div>
  );
}

/**
 * Overlay shown once the operator submits.
 *
 * This is a progress *indicator*, never a substitute for the real result: the
 * parent only advances `system` to "ok" after the actual auth request resolves,
 * and any failure short-circuits straight to the denied panel carrying the real
 * server message.
 */
export function AuthStatus({
  phase,
  stages,
  error,
  onDismiss,
}: {
  phase: AuthPhase;
  stages: Record<StageKey, StageState>;
  error?: string;
  onDismiss?: () => void;
}) {

  if (phase === "idle") return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      // Opaque, not translucent. The console beneath is itself glass, so a
      // semi-transparent overlay let the form bleed through and the status rows
      // landed on top of the submit button — unreadable. A subtle radial keeps
      // it from reading as a flat grey slab.
      style={{
        background:
          "radial-gradient(120% 90% at 50% 30%, #0a141f 0%, #05090f 60%, #04080d 100%)",
      }}
      className="absolute inset-0 z-20 flex flex-col justify-center rounded-xl px-7 sm:px-9"
      // The whole overlay is announced as one unit when it appears.
      role="status"
      aria-live="assertive"
    >
      {phase === "authenticating" && (
        <>
          <div className="mb-5 flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-sys-pulse rounded-full bg-sys-cyan" aria-hidden="true" />
            <p className="font-mono text-xs uppercase tracking-hud text-sys-cyan">
              Authenticating…
            </p>
          </div>
          <div className="space-y-2.5">
            {STAGE_ORDER.map((key, i) => (
              <StageRow
                key={key}
                label={STAGE_LABEL[key]}
                state={stages[key]}
                index={i}
              />
            ))}
          </div>
        </>
      )}

      {phase === "granted" && (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={springTechnical}
          className="flex flex-col items-center text-center"
        >
          <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-sys-ok/40 bg-sys-ok/10">
            <Check className="h-5 w-5 text-sys-ok" aria-hidden="true" />
          </span>
          <p className="font-mono text-[0.8rem] uppercase tracking-hud text-sys-ok">
            Access Granted
          </p>
          <p className="mt-2.5 font-mono text-xs uppercase tracking-hud text-sys-dim">
            Welcome, Operator
          </p>
        </motion.div>
      )}

      {phase === "denied" && (
        <motion.div
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
          className="flex flex-col items-center text-center"
        >
          <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-sys-danger/40 bg-sys-danger/10">
            <AlertTriangle className="h-5 w-5 text-sys-danger" aria-hidden="true" />
          </span>
          <p className="font-mono text-[0.8rem] uppercase tracking-hud text-sys-danger">
            Access Denied
          </p>

          {/* The real server message, verbatim. Never replaced by flavour text. */}
          <p className="mt-3 max-w-[19rem] text-[0.78rem] leading-relaxed text-sys-text">
            {error || "Identity verification failed."}
          </p>

          <p className="mt-2.5 font-mono text-xs uppercase tracking-hud text-sys-dim">
            Check Operator ID and Access Key
          </p>

          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="sys-focus mt-6 rounded border border-sys-edge px-5 py-2 font-mono text-xs uppercase tracking-hud text-sys-text transition-colors hover:border-sys-cyan/50 hover:text-white"
            >
              Retry
            </button>
          )}
        </motion.div>
      )}

      {/* Corner framing for the overlay itself */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-3 h-3 w-3 border-l border-t border-sys-cyan/25"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-3 right-3 h-3 w-3 border-b border-r border-sys-cyan/25"
      />
      {phase === "granted" && (
        <ShieldCheck className="sr-only" aria-hidden="true" />
      )}
    </motion.div>
  );
}
