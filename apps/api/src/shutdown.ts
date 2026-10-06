// ---------------------------------------------------------------------------
// Phase 10.6 — Graceful shutdown controller (apps/api)
//
// Owns the application-level shutdown sequence:
//
//   RUNNING → DRAINING            new side-effecting work refused (gate)
//           → STOP_ACCEPTING      http server stops accepting connections
//           → WAIT_FOR_SAFE_EXECUTIONS   bounded grace period for in-flight
//                                  executions to reach terminal state
//           → RELEASE_RESOURCES   socket.io closed, prisma disconnected
//           → STOPPED             final summary logged/audited
//
// Guarantees:
// - Idempotent: beginShutdown() is single-flight; calling it twice (or a
//   second signal arriving) runs cleanup exactly once.
// - No blind cancellation: when the grace period expires, in-flight
//   executions are NOT aborted and NEVER marked FAILED. Their durable
//   journal rows stay EXECUTING/UNKNOWN so Phase 10.2 stale-lease recovery
//   and Phase 10.5 reconciliation handle them on next startup.
// - Client sockets are never the source of truth: closing socket.io at
//   RELEASE_RESOURCES cannot cancel executions (Phase 10.4 decision:
//   CLIENT DISCONNECT ≠ EXECUTION CANCELLATION).
// - DB failure during shutdown is logged honestly: if resource release
//   fails we report failure instead of claiming clean persistence.
// - Bounded (Phase 13): the sequence always reaches STOPPED. `server.close`
//   calls back only when EVERY connection has ended, so it is started at
//   STOP_ACCEPTING and never waited on without a limit — one stuck request, or
//   the dashboard's open socket, used to hold the whole sequence there. Open
//   requests get what is left of the grace period, then are closed.
//
// Windows safety: signal delivery is unreliable on win32, so hosts can
// invoke beginShutdown() programmatically (tests, deployment hooks); signal
// handler registration is wrapped defensively and deduplicated module-wide
// so hot reload / repeated imports never install duplicate listeners.
// ---------------------------------------------------------------------------

import type { Server } from "http";
import type { ShutdownLifecycle, DrainSummary } from "@jarvis/core";

export interface ShutdownControllerOptions {
  lifecycle: ShutdownLifecycle;
  /** HTTP server to stop accepting new connections on. */
  server?: Pick<Server, "close"> & {
    closeAllConnections?(): void;
    closeIdleConnections?(): void;
  };
  /**
   * Closed only at RELEASE_RESOURCES, after executions drained. Closing it
   * must not affect execution outcomes — they are journal-backed.
   */
  closeIo?: () => void;
  /**
   * Sprint 7 — external processes this API owns, released before the database.
   *
   * Currently the shared Chrome behind the browser tools. Optional, so a
   * deployment without browsing wires nothing and behaves exactly as before.
   */
  releaseExternalResources?: () => Promise<void>;
  /** Disconnected last, after all persistence work has settled. */
  disconnectDatabase?: () => Promise<void>;
  /** Bounded grace period (validated JARVIS_SHUTDOWN_GRACE_MS). */
  graceMs: number;
  /** Structured, secret-free logger. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /**
   * Phase 13 — told when a step of the sequence failed, so it can be reported
   * to the error monitor. A hook that throws is ignored: shutdown goes on.
   */
  onError?: (error: unknown, stage: "release_resources" | "sequence") => void;
  /**
   * Called once after STOPPED (host may process.exit). Never called on
   * shutdown errors caused by failed resource release — those are surfaced.
   */
  onStopped?: () => void;
}

export interface ShutdownController {
  /**
   * Idempotent, single-flight. Every call returns the same completion
   * promise; the sequence body executes exactly once per process.
   */
  beginShutdown(reason: string): Promise<void>;
  /** True while/after the sequence runs. */
  isShuttingDown(): boolean;
}

/** Module-level guard: no duplicate signal handlers across re-imports/tests. */
let signalHandlersInstalled = false;
const installedSignals: string[] = [];

export function areSignalHandlersInstalled(): boolean {
  return signalHandlersInstalled;
}

export function getInstalledSignals(): readonly string[] {
  return installedSignals;
}

/**
 * Registers SIGTERM/SIGINT handlers exactly once per process. Safe to call
 * repeatedly (idempotent). Registration failures (platforms without signal
 * support) are swallowed — programmatic beginShutdown remains available.
 */
export function installSignalHandlers(
  beginShutdown: (reason: string) => Promise<void>
): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    try {
      const listener = () => {
        void beginShutdown(signal);
      };
      process.once(signal, listener);
      installedSignals.push(signal);
    } catch {
      // Platform does not support this signal — proceed without it.
    }
  }
}

export function createShutdownController(
  options: ShutdownControllerOptions
): ShutdownController {
  const {
    lifecycle,
    server,
    closeIo,
    releaseExternalResources,
    disconnectDatabase,
    graceMs,
    log = (message, meta) =>
      console.log(`[shutdown] ${message}${meta ? " " + JSON.stringify(meta) : ""}`),
    onStopped,
  } = options;

  const reportError = (error: unknown, stage: "release_resources" | "sequence"): void => {
    try {
      options.onError?.(error, stage);
    } catch {
      // A reporter that fails must not stop the shutdown it is reporting on.
    }
  };

  let shutdownPromise: Promise<void> | null = null;

  const beginShutdown = (reason: string): Promise<void> => {
    // Idempotency: every caller (second signal, double invocation, health
    // probe racing signals) awaits the SAME promise; the body runs once.
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runSequence(reason);
    return shutdownPromise;
  };

  const runSequence = async (reason: string): Promise<void> => {
    // -------------------------------------------------------------------
    // DRAINING — gate now refuses new side-effecting work deterministically.
    // -------------------------------------------------------------------
    const initiation = lifecycle.beginDraining(`shutdown initiated (${reason})`);
    const activeAtStart = lifecycle.getActiveExecutionCount();
    log("shutdown initiated", {
      reason,
      signal: reason.toUpperCase(),
      timestamp: initiation.at.toISOString(),
      activeExecutions: activeAtStart,
      graceMs,
    });

    try {
      // -----------------------------------------------------------------
      // STOP_ACCEPTING — no new work of any kind enters from here on.
      // -----------------------------------------------------------------
      lifecycle.markStopAccepting();
      // Phase 13 — started here, NOT awaited here. The callback fires only once
      // every connection has ended, and awaiting it at this point let a single
      // open connection hold the sequence before anything had drained.
      const deadline = Date.now() + graceMs;
      let serverClosed = !server;
      const whenServerClosed = server
        ? new Promise<void>((resolve) => {
            server.close(() => {
              serverClosed = true;
              resolve();
            });
          })
        : Promise.resolve();

      // -----------------------------------------------------------------
      // WAIT_FOR_SAFE_EXECUTIONS — let tracked executions finish within
      // the grace period. On expiry we deliberately leave their durable
      // journal state untouched (recoverable), never FAILED, never retried.
      // -----------------------------------------------------------------
      lifecycle.markWaitForSafeExecutions();
      let drain: DrainSummary = {
        completed: 0,
        leftForRecovery: activeAtStart,
        timedOut: false,
      };
      try {
        drain = await lifecycle.waitForActiveExecutions(graceMs);
      } catch {
        // waitForActiveExecutions never rejects; defensive containment only.
      }

      log("drain finished", {
        executionsCompleted: drain.completed,
        executionsLeftForRecovery: drain.leftForRecovery,
        timedOut: drain.timedOut,
      });

      // -----------------------------------------------------------------
      // RELEASE_RESOURCES — transports first (socket close CANNOT cancel
      // executions), then child processes, then the database connection.
      // -----------------------------------------------------------------
      lifecycle.markReleasingResources();
      let dbDisconnected = true;
      try {
        closeIo?.();
        if (server) {
          // Requests already running get what is left of the grace period to
          // finish. A keep-alive connection is only swept by `close()` if it
          // was idle at that moment, so idle ones are swept again as requests
          // complete — otherwise each would hold on for its keep-alive timeout.
          const remainingMs = Math.max(0, deadline - Date.now());
          if (!serverClosed && remainingMs > 0) {
            const sweep = setInterval(() => server.closeIdleConnections?.(), 50);
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
              whenServerClosed,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, remainingMs);
              }),
            ]);
            clearInterval(sweep);
            if (timer) clearTimeout(timer);
          }
          log("connections closed", { forced: !serverClosed });
          // Whatever is still open is closed now; nothing waits past here.
          server.closeAllConnections?.();
        }
        // Sprint 7 — external processes we own (the browser) go before the
        // database, so anything still finishing can record its journal row.
        if (releaseExternalResources) {
          await releaseExternalResources();
        }
        if (disconnectDatabase) {
          await disconnectDatabase();
        }
      } catch (err) {
        dbDisconnected = false;
        // Fail safely: report the truth instead of claiming clean release.
        log("resource release error", {
          message: err instanceof Error ? err.message : String(err),
        });
        reportError(err, "release_resources");
      }

      // -----------------------------------------------------------------
      // STOPPED — final traceable audit trail (no secrets, no payloads).
      // -----------------------------------------------------------------
      lifecycle.markStopped();
      log("shutdown complete", {
        reason,
        executionsCompleted: drain.completed,
        executionsLeftForRecovery: drain.leftForRecovery,
        databaseDisconnected: dbDisconnected,
        timestamp: new Date().toISOString(),
      });

      if (!dbDisconnected) return; // surface partial failure to host logs

      onStopped?.();
    } catch (err) {
      // The sequence itself failed (e.g. server.close threw). Log honestly
      // and stop advancing state; durable journal data remains authoritative.
      log("shutdown sequence error", {
        message: err instanceof Error ? err.message : String(err),
      });
      reportError(err, "sequence");
    }
  };

  return {
    beginShutdown,
    isShuttingDown: () => lifecycle.isShuttingDown(),
  };
}
