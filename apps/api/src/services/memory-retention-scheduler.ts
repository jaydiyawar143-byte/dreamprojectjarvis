// ---------------------------------------------------------------------------
// Phase 14 — when the memory retention sweep runs.
//
// The same shape as the outcome-worker and task-scheduler loops, and for the
// same reasons:
//
//   - CONTROLLED. One interval timer, started after the server is listening,
//     gated on JARVIS_MEMORY_RETENTION_INTERVAL_MS (0 disables it and says so).
//   - NEVER OVERLAPS. A tick that fires while a sweep is running joins it.
//   - SHUTDOWN-AWARE. The timer stops the moment draining begins, and the
//     in-flight sweep is tracked so the drain waits for it.
//   - BOUNDED. Each sweep visits a limited number of users and deletes a
//     limited number of memories for each (MEMORY_RETENTION in core).
//
// THIS MODULE DELETES NOTHING AND DECIDES NOTHING. It calls sweep(); what may
// be purged is the retention policy's, and the deleting is done by the
// `memory.purge_expired` tool through the tool executor.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { ShutdownLifecycle } from "@jarvis/core";
import type { MemoryRetentionSweep } from "@jarvis/memory";

export type MemoryRetentionLog = (level: "info" | "warn", event: string, meta?: Record<string, unknown>) => void;

export interface MemoryRetentionSchedulerOptions {
  sweep: Pick<MemoryRetentionSweep, "sweep">;
  lifecycle: ShutdownLifecycle;
  /** Milliseconds between sweeps. 0 or negative disables the sweep. */
  intervalMs: number;
  log?: MemoryRetentionLog;
}

export interface MemoryRetentionScheduler {
  /** Run (or join) one sweep now. */
  sweep(): Promise<void>;
  /** Stop the timer and wait for a sweep in flight. */
  stop(): Promise<void>;
}

const SWEEP_RISK = "LOW_IMPACT" as const;

export function startMemoryRetentionSweep(options: MemoryRetentionSchedulerOptions): MemoryRetentionScheduler {
  const { lifecycle, intervalMs } = options;
  const log: MemoryRetentionLog = options.log ?? ((level, event, meta) => console.log(JSON.stringify({ level, event, ...(meta ?? {}) })));

  if (intervalMs <= 0) {
    log("info", "memory_retention_disabled", { reason: "JARVIS_MEMORY_RETENTION_INTERVAL_MS is 0 or negative" });
    return { sweep: () => Promise.resolve(), stop: () => Promise.resolve() };
  }

  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    const startedAt = Date.now();
    const handle = lifecycle.trackExecution(`memory-retention-sweep-${randomUUID()}`, SWEEP_RISK);
    try {
      const result = await options.sweep.sweep();
      // Counts only: never a user id, never memory content.
      log(result.failed > 0 ? "warn" : "info", "memory_retention_sweep_completed", { ...result, durationMs: Date.now() - startedAt });
    } catch (error) {
      log("warn", "memory_retention_sweep_error", { errorName: error instanceof Error ? error.name : typeof error });
    } finally {
      handle.complete();
    }
  };

  const sweep = (): Promise<void> => {
    if (stopped || !lifecycle.canAcceptNewWork(SWEEP_RISK)) return Promise.resolve();
    if (inFlight) return inFlight;
    const current = run();
    inFlight = current;
    void current.finally(() => {
      if (inFlight === current) inFlight = null;
    });
    return current;
  };

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => void sweep(), intervalMs);
  const stopTimer = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const unsubscribe = lifecycle.onStateChange((state) => {
    if (state !== "RUNNING") stopTimer();
  });

  log("info", "memory_retention_started", { intervalMs });
  // The first sweep, now: what expired while the process was down.
  void sweep();

  return {
    sweep,
    async stop() {
      if (stopped) return;
      stopped = true;
      stopTimer();
      unsubscribe();
      await inFlight;
    },
  };
}
