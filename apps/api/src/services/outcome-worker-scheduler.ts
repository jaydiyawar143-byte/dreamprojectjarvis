// ---------------------------------------------------------------------------
// Phase 11.7B — runtime scheduling for the OutcomeWorker.
//
// The worker itself is complete and tested in @jarvis/core; what was missing
// is anything that invokes it. This module is that invocation: an interval
// sweep that runs in the API process after the server is listening.
//
// Guarantees:
//   - Never overlaps. A tick that fires while a sweep is still running joins
//     the in-flight sweep instead of starting a second one, so a slow Meta
//     response can never stack sweeps on top of each other.
//   - Topology-safe. It relies solely on OutcomeWorker's lease-based claim
//     (single-winner), so multiple API instances can run the same sweep.
//   - Shutdown-aware. The tidy sweep is tracked with the ShutdownLifecycle
//     (EXTERNAL_SIDE_EFFECT), so a graceful drain waits for it to settle
//     before the database connection is released; the timer is stopped the
//     moment draining begins, so no new sweep can start mid-shutdown.
//   - Side-effect-free when nothing is due. With zero outcome records the
//     sweep is one cheap database query; it only reaches a provider when a
//     record is actually claimable.
//
// THE WORKER DOES THE GATING. This module only calls processDue(); it has no
// permission logic, no audit writes and no provider access of its own — all of
// that lives in the worker and the executor it is given.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { type ShutdownLifecycle, OutcomeWorker } from "@jarvis/core";

export type OutcomeWorkerSchedulingLog = (
  level: "info" | "warn",
  event: string,
  meta?: Record<string, unknown>
) => void;

export interface OutcomeWorkerSchedulerOptions {
  /** The worker to sweep with. Constructed at the composition root. */
  worker: Pick<OutcomeWorker, "processDue">;
  /** Lifecycle gate + in-flight registry. Draining stops the timer. */
  lifecycle: ShutdownLifecycle;
  /** Milliseconds between sweeps. 0 or negative disables scheduling. */
  intervalMs: number;
  /** Structured, secret-free logger. Defaults to JSON console lines. */
  log?: OutcomeWorkerSchedulingLog;
}

export interface OutcomeWorkerScheduler {
  /**
   * Run (or join) one sweep immediately. Used by the timer and available for
   * tests and manual control.
   */
  sweep(): Promise<void>;
  /**
   * Stop the timer and wait for any in-flight sweep to settle. New sweeps
   * are refused afterwards; calling sweep() after stop() is a no-op.
   */
  stop(): Promise<void>;
}

const SWEEP_RISK = "EXTERNAL_SIDE_EFFECT" as const;

const defaultLog: OutcomeWorkerSchedulingLog = (level, event, meta) => {
  console.log(JSON.stringify({ level, event, ...(meta ?? {}) }));
};

export function startOutcomeWorkerSweep(
  options: OutcomeWorkerSchedulerOptions
): OutcomeWorkerScheduler {
  const { worker, lifecycle, intervalMs } = options;
  const log = options.log ?? defaultLog;

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let sweepSeq = 0;
  let unsubscribe: (() => void) | null = null;

  const settleSweep = async (seq: number): Promise<void> => {
    const startedAt = Date.now();
    const executionId = `outcome-worker-sweep-${seq}-${randomUUID()}`;
    const drainHandle = lifecycle.trackExecution(executionId, SWEEP_RISK);
    try {
      // processDue() never rejects by design (failures are reported in the
      // result); the try/catch is a defensive container for regression.
      const result = await worker.processDue();
      log("info", "outcome_worker_sweep_completed", {
        sweep: seq,
        durationMs: Date.now() - startedAt,
        processedCount: result.processedCount,
        finalizedCount: result.finalizedCount,
        revisionCount: result.revisionCount,
        failedCount: result.failedCount,
      });
      if (result.errors.length > 0) {
        log("warn", "outcome_worker_sweep_errors", {
          sweep: seq,
          errorCount: result.errors.length,
          errors: result.errors.slice(0, 20),
        });
      }
    } catch (err) {
      log("warn", "outcome_worker_sweep_error", {
        sweep: seq,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      drainHandle.complete();
    }
  };

  const sweep = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    if (!lifecycle.canAcceptNewWork(SWEEP_RISK)) {
      // Draining has begun: this sweep is side-effecting and must not start.
      // The state-change listener stops the timer itself; this guard closes
      // the small window between the signal and the listener firing.
      return Promise.resolve();
    }
    const seq = ++sweepSeq;
    const current = settleSweep(seq);
    inFlight = current;
    // Clear the slot in the same microtask that finishes the sweep, so the
    // next tick can start a fresh one without waiting for a re-read.
    void current.finally(() => {
      if (inFlight === current) inFlight = null;
    });
    return current;
  };

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    stopTimer();
    unsubscribe?.();
    log("info", "outcome_worker_stopped", { sweep: sweepSeq });
    await inFlight;
  };

  if (intervalMs <= 0) {
    stopped = true;
    log("info", "outcome_worker_disabled", {
      reason: "JARVIS_OUTCOME_WORKER_INTERVAL_MS is 0 or negative",
    });
    return {
      sweep: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
  }

  // Stop scheduling the moment draining begins: a shutdown must never start a
  // fresh sweep mid-sequence, and the drain below waits for the in-flight one.
  unsubscribe = lifecycle.onStateChange((state) => {
    if (state !== "RUNNING") stopTimer();
  });

  log("info", "outcome_worker_started", { intervalMs });

  timer = setInterval(() => {
    void sweep();
  }, intervalMs);

  // Immediate first sweep: crash-recovery for stale leases left by a previous
  // instance (idempotent and safe precisely because claims are lease-based).
  void sweep();

  return { sweep, stop };
}