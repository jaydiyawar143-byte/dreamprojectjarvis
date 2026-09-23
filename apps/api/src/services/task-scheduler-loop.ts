// ---------------------------------------------------------------------------
// Scheduler V1 — the interval that makes a schedule happen.
//
// Deliberately the SAME shape as `outcome-worker-scheduler.ts`, which is this
// repository's established in-process scheduler: an interval sweep, one sweep
// at a time, tracked with the ShutdownLifecycle so a drain waits for it. That
// file already answered "how does a long-running job live inside the API
// process here", and a second, differently-shaped answer would be the
// duplication the integration rule exists to prevent.
//
// GUARANTEES, and where each comes from:
//
//   never overlaps      a tick arriving while a sweep runs JOINS it
//   shutdown-aware      the timer stops the moment draining begins, and the
//                       in-flight sweep is tracked so the drain waits
//   never blocks HTTP   it is a timer, not a request path
//   survives restart    the due set is a DATABASE QUERY, never in-process
//                       state; the first sweep runs immediately on boot, so a
//                       10:00 task on a process that died at 09:59 runs when
//                       the next process starts
//   runs overdue once   the claim clears `scheduledAt`, so "late" never means
//                       "repeatedly"
//
// SINGLE PROCESS, MULTIPLE REPLICAS. The timer is per-process, so N replicas
// sweep N times — and that is SAFE rather than duplicated, because the claim
// is one atomic UPDATE on `scheduledAt`: exactly one replica wins each task
// and the losers do no work. No queue, no lock service, no leader election.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { InFlightExecutionHandle, ShutdownLifecycle } from "@jarvis/core";
import type { TaskSchedulerService } from "./tasks/task-scheduler-service.js";

export type TaskSchedulerLog = (
  level: "info" | "warn",
  event: string,
  meta?: Record<string, unknown>
) => void;

export interface TaskSchedulerLoopOptions {
  scheduler: Pick<TaskSchedulerService, "runDue" | "recoverOrphanedClaims">;
  lifecycle: ShutdownLifecycle;
  /** Milliseconds between sweeps. 0 or negative disables scheduling. */
  intervalMs: number;
  log?: TaskSchedulerLog;
}

export interface TaskSchedulerLoop {
  /** Run (or join) one sweep now. Used by the timer, tests and manual control. */
  sweep(): Promise<void>;
  /** Stop the timer and wait for any in-flight sweep to settle. */
  stop(): Promise<void>;
}

/**
 * A scheduled run reaches real tools, so it is side-effecting for drain
 * purposes — the same classification the outcome sweep uses, and what stops a
 * shutdown starting one.
 */
const SWEEP_RISK = "EXTERNAL_SIDE_EFFECT" as const;

const defaultLog: TaskSchedulerLog = (level, event, meta) => {
  console.log(JSON.stringify({ level, event, ...(meta ?? {}) }));
};

export function startTaskSchedulerLoop(
  options: TaskSchedulerLoopOptions
): TaskSchedulerLoop {
  const { scheduler, lifecycle, intervalMs } = options;
  const log = options.log ?? defaultLog;

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let sweepSeq = 0;
  let unsubscribe: (() => void) | null = null;

  const settleSweep = async (seq: number): Promise<void> => {
    const startedAt = Date.now();
    // Declared out here so `finally` can reach it, ASSIGNED inside the try so
    // that nothing on this path can fail without being logged. Before, a throw
    // from `trackExecution` escaped as an unhandled rejection through the
    // `void sweep()` call site — the one way a sweep could still die silently.
    let drainHandle: InFlightExecutionHandle | null = null;
    try {
      const executionId = `task-scheduler-sweep-${seq}-${randomUUID()}`;
      drainHandle = lifecycle.trackExecution(executionId, SWEEP_RISK);

      // V2.2 - recovery runs FIRST, inside the same sweep.
      //
      // Inside, not beside: it inherits the whole shutdown story (the drain
      // handle above, the no-overlap guard, the RUNNING-state gate) and there
      // is no second daemon to reason about. Running it before `runDue` means
      // a claim re-armed now becomes eligible in the same sweep rather than
      // waiting another interval.
      //
      // It never calls a tool. It clears one column on tasks whose own status
      // proves nothing ran.
      const recovered = await scheduler.recoverOrphanedClaims();

      const outcomes = await scheduler.runDue();

      // EVERY successful sweep logs, including an empty one.
      //
      // This line is the loop's proof of life. An earlier version logged only
      // when something was due, which made "nothing was scheduled" and "the
      // sweep died months ago" produce byte-identical output — and a
      // background loop that reaches real providers has to be distinguishable
      // from a dead one. `dueCount: 0` is a fact worth one line a minute.
      log("info", "task_scheduler_sweep_completed", {
        sweep: seq,
        durationMs: Date.now() - startedAt,
        // V2.2 - on the same line as the rest of the sweep, so a recovery is
        // never something you have to go looking for.
        reArmed: recovered.filter((r) => r.outcome === "re_armed").length,
        recoveryLost: recovered.filter((r) => r.outcome === "lost").length,
        dueCount: outcomes.length,
        executed: outcomes.filter((o) => o.outcome === "executed").length,
        notPlanned: outcomes.filter((o) => o.outcome === "not_planned").length,
        claimLost: outcomes.filter((o) => o.outcome === "claim_lost").length,
        refused: outcomes.filter((o) => o.outcome === "execution_refused").length,
      });
    } catch (err) {
      // A sweep that throws must not kill the timer: the next one should still
      // run. The message is logged, never the payload.
      log("warn", "task_scheduler_sweep_error", {
        sweep: seq,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Null only when tracking itself failed — in which case there is no
      // registration to complete, and the drain registry is already correct.
      drainHandle?.complete();
    }
  };

  const sweep = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    // A tick during a sweep JOINS it rather than starting a second one. This
    // is what "no overlapping ticks" means here; the database claim is what
    // makes overlap harmless anyway.
    if (inFlight) return inFlight;
    if (!lifecycle.canAcceptNewWork(SWEEP_RISK)) return Promise.resolve();

    const seq = ++sweepSeq;
    const current = settleSweep(seq);
    inFlight = current;
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
    log("info", "task_scheduler_stopped", { sweep: sweepSeq });
    await inFlight;
  };

  if (intervalMs <= 0) {
    stopped = true;
    log("info", "task_scheduler_disabled", {
      reason: "JARVIS_TASK_SCHEDULER_INTERVAL_MS is 0 or negative",
    });
    return { sweep: () => Promise.resolve(), stop: () => Promise.resolve() };
  }

  unsubscribe = lifecycle.onStateChange((state) => {
    if (state !== "RUNNING") stopTimer();
  });

  log("info", "task_scheduler_started", { intervalMs });

  timer = setInterval(() => {
    void sweep();
  }, intervalMs);

  // The immediate first sweep is the restart story: anything that fell due
  // while no process was running is discovered and run now, once.
  void sweep();

  return { sweep, stop };
}
