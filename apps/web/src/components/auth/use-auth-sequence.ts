"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthPhase, StageKey, StageState } from "./auth-status";

const IDLE_STAGES: Record<StageKey, StageState> = {
  identity: "pending",
  credential: "pending",
  security: "pending",
  system: "pending",
};

/** Cosmetic pacing for the first three checks, in ms from submit. */
const TIMELINE: Array<{ at: number; done: StageKey | null; next: StageKey }> = [
  { at: 0, done: null, next: "identity" },
  { at: 380, done: "identity", next: "credential" },
  { at: 760, done: "credential", next: "security" },
  { at: 1140, done: "security", next: "system" },
];

/** Floor so a very fast response doesn't flash the overlay and vanish. */
const MIN_VISIBLE_MS = 900;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Binds the staged "AUTHENTICATING…" display to a real auth request.
 *
 * The contract that matters: this hook NEVER reports success on its own. The
 * first three rows are pacing for the request already in flight; `system` only
 * flips to "ok" after the caller's promise resolves without an error, and any
 * error short-circuits immediately to `denied` carrying the real message. A
 * slow request simply leaves `system` on VERIFYING for as long as it takes.
 */
export function useAuthSequence(reduced: boolean | null) {
  const [phase, setPhase] = useState<AuthPhase>("idle");
  const [stages, setStages] = useState<Record<StageKey, StageState>>(IDLE_STAGES);
  const [error, setError] = useState<string | undefined>();

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, []);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    setPhase("idle");
    setStages(IDLE_STAGES);
    setError(undefined);
  }, [clearTimers]);

  /**
   * @param submit the real network call. Must resolve `{ error }` on failure.
   * @returns whether authentication genuinely succeeded.
   */
  const run = useCallback(
    async (submit: () => Promise<{ error?: string }>): Promise<boolean> => {
      clearTimers();
      setError(undefined);
      setStages(IDLE_STAGES);
      setPhase("authenticating");

      const startedAt = Date.now();

      // Pace the first three checks while the request is in flight. Under
      // reduced motion everything is marked active at once instead.
      if (reduced) {
        setStages({
          identity: "active",
          credential: "active",
          security: "active",
          system: "active",
        });
      } else {
        for (const step of TIMELINE) {
          timers.current.push(
            setTimeout(() => {
              if (!alive.current) return;
              setStages((s) => ({
                ...s,
                ...(step.done ? { [step.done]: "ok" as StageState } : {}),
                [step.next]: "active" as StageState,
              }));
            }, step.at)
          );
        }
      }

      // --- the actual authentication request ---
      const result = await submit();

      clearTimers();
      if (!alive.current) return false;

      if (result.error) {
        // Whatever was still in flight is the thing that failed.
        setStages((s) => {
          const next = { ...s };
          for (const k of Object.keys(next) as StageKey[]) {
            if (next[k] === "active") next[k] = "failed";
          }
          return next;
        });
        setError(result.error);
        setPhase("denied");
        return false;
      }

      // Real success — only now is every check allowed to read OK.
      setStages({ identity: "ok", credential: "ok", security: "ok", system: "ok" });

      const elapsed = Date.now() - startedAt;
      const floor = reduced ? 0 : Math.max(0, MIN_VISIBLE_MS - elapsed);
      if (floor) await wait(floor);
      if (!alive.current) return false;

      setPhase("granted");
      return true;
    },
    [clearTimers, reduced]
  );

  return { phase, stages, error, run, reset };
}
