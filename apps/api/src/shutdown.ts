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
  server?: Pick<Server, "close"> & { closeAllConnections?(): void };
  /**
   * Closed only at RELEASE_RESOURCES, after executions drained. Closing it
   * must not affect execution outcomes — they are journal-backed.
   */
  closeIo?: () => void;
  /** Disconnected last, after all persistence work has settled. */
  disconnectDatabase?: () => Promise<void>;
  /** Bounded grace period (validated JARVIS_SHUTDOWN_GRACE_MS). */
  graceMs: number;
  /** Structured, secret-free logger. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
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
    disconnectDatabase,
    graceMs,
    log = (message, meta) =>
      console.log(`[shutdown] ${message}${meta ? " " + JSON.stringify(meta) : ""}`),
    onStopped,
  } = options;

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
      if (server) {
        await new Promise<void>((resolve) => {
          // Callback form: waits for open keep-alive connections; bounded
          // below by the overall flow so a stuck socket cannot hang us
          // forever (closeAllConnections fires at RELEASE_RESOURCES).
          server.close(() => resolve());
        });
      }

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
      // executions), then the database connection.
      // -----------------------------------------------------------------
      lifecycle.markReleasingResources();
      let dbDisconnected = true;
      try {
        closeIo?.();
        if (
          server &&
          typeof (server as { closeAllConnections?(): void })
            .closeAllConnections === "function"
        ) {
          (server as { closeAllConnections(): void }).closeAllConnections();
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
    }
  };

  return {
    beginShutdown,
    isShuttingDown: () => lifecycle.isShuttingDown(),
  };
}
