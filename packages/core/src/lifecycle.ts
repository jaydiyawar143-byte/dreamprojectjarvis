// ---------------------------------------------------------------------------
// Phase 10.6 — Application lifecycle / graceful shutdown
//
// An explicit, forward-only state machine that governs whether new work may
// begin and tracks in-flight executions so a controlled shutdown never
// abandons work silently and never turns ambiguous external side effects
// into FAILED outcomes.
//
// Lifecycle:
//   RUNNING → DRAINING → STOP_ACCEPTING → WAIT_FOR_SAFE_EXECUTIONS
//           → RELEASE_RESOURCES → STOPPED
//
// The state machine itself is pure TypeScript (no node APIs) so it can be
// unit-tested deterministically and embedded in any host (API server,
// workers, test runners).
//
// Windows note (dev environment): OS signal delivery is unreliable on
// Windows (SIGTERM often terminates without running handlers). Hosts must
// therefore be able to trigger shutdown programmatically; signal handlers
// are registered defensively and are best-effort.
// ---------------------------------------------------------------------------

import type { RiskLevel } from "./types/tool.js";

export type LifecycleState =
  | "RUNNING"
  | "DRAINING"
  | "STOP_ACCEPTING"
  | "WAIT_FOR_SAFE_EXECUTIONS"
  | "RELEASE_RESOURCES"
  | "STOPPED";

/** Ordered progression index for validating forward transitions. */
const STATE_ORDER: Readonly<Record<LifecycleState, number>> = {
  RUNNING: 0,
  DRAINING: 1,
  STOP_ACCEPTING: 2,
  WAIT_FOR_SAFE_EXECUTIONS: 3,
  RELEASE_RESOURCES: 4,
  STOPPED: 5,
};

/**
 * Deterministic error surfaced to callers whose work is refused because a
 * shutdown has begun. Never silent — every rejection is observable.
 */
export const SERVICE_SHUTTING_DOWN_ERROR = "service shutting down";

export interface ShutdownInitiation {
  /** Human-readable reason (signal name, deployment hook, manual call…). */
  reason: string;
  /** When draining began. */
  at: Date;
}

export interface InFlightExecutionHandle {
  readonly executionId: string;
  /** Marks the execution as safely finished (any terminal journal state). */
  complete(): void;
}

export interface DrainSummary {
  /** Executions that reached a terminal state before the deadline. */
  completed: number;
  /**
   * Executions still active when the grace period expired. Their durable
   * journal rows are left untouched (EXECUTING/UNKNOWN) so Phase 10.2
   * stale-lease recovery and Phase 10.5 reconciliation handle them on the
   * next startup. They are NEVER marked FAILED by shutdown.
   */
  leftForRecovery: number;
  /** True when the grace period expired with executions still active. */
  timedOut: boolean;
}

export interface ShutdownLifecycleOptions {
  now?: () => Date;
}

/**
 * Central lifecycle gate. Owns three concerns:
 *
 * 1. State machine — forward-only, idempotent transitions.
 * 2. Work admission — canAcceptNewWork() is the single authority used by
 *    executors/approval paths to decide whether new work may begin.
 * 3. In-flight registry — supplementary tracking used to await safe
 *    completion during shutdown. Durable journal state always remains the
 *    source of truth; this registry is best-effort only.
 */
export class ShutdownLifecycle {
  private state: LifecycleState = "RUNNING";
  private initiation: ShutdownInitiation | null = null;

  private readonly inFlight = new Map<
    string,
    { risk: RiskLevel; startedAt: Date }
  >();
  private completedCount = 0;

  private readonly stateListeners = new Set<
    (state: LifecycleState, initiation: ShutdownInitiation | null) => void
  >();

  private readonly drainWaiters = new Set<() => void>();

  private readonly now: () => Date;

  constructor(options?: ShutdownLifecycleOptions) {
    this.now = options?.now ?? (() => new Date());
  }

  getState(): LifecycleState {
    return this.state;
  }

  isShuttingDown(): boolean {
    return this.state !== "RUNNING";
  }

  getShutdownInitiation(): ShutdownInitiation | null {
    return this.initiation;
  }

  /**
   * Idempotent. Only the first call transitions out of RUNNING and records
   * the initiation reason/timestamp; later calls are no-ops.
   */
  beginDraining(reason: string): ShutdownInitiation {
    if (this.initiation) return this.initiation;
    this.initiation = { reason, at: this.now() };
    this.transitionTo("DRAINING");
    return this.initiation;
  }

  markStopAccepting(): void {
    this.transitionTo("STOP_ACCEPTING");
  }

  markWaitForSafeExecutions(): void {
    this.transitionTo("WAIT_FOR_SAFE_EXECUTIONS");
  }

  markReleasingResources(): void {
    this.transitionTo("RELEASE_RESOURCES");
  }

  markStopped(): void {
    this.transitionTo("STOPPED");
  }

  /**
   * Admission control.
   *
   * - RUNNING: everything accepted.
   * - DRAINING: READ_ONLY work may continue (explicitly safe per phase
   *   spec); anything with side effects is refused.
   * - STOP_ACCEPTING or beyond: nothing accepted, including reads.
   */
  canAcceptNewWork(risk: RiskLevel): boolean {
    switch (this.state) {
      case "RUNNING":
        return true;
      case "DRAINING":
        return risk === "READ_ONLY";
      default:
        return false;
    }
  }

  /** Convenience predicate covering any shutdown progress at all. */
  acceptsOnlyReadWork(): boolean {
    return this.state === "DRAINING";
  }

  /**
   * Registers an in-flight execution. Returns a handle whose complete()
   * must be called exactly once when the execution reaches ANY terminal
   * outcome (success/failure/UNKNOWN-safe terminal states). Completion is
   * idempotent per executionId.
   */
  trackExecution(executionId: string, risk: RiskLevel): InFlightExecutionHandle {
    this.inFlight.set(executionId, { risk, startedAt: this.now() });
    let done = false;
    return {
      executionId,
      complete: () => {
        if (done) return;
        done = true;
        if (this.inFlight.delete(executionId)) {
          this.completedCount += 1;
          this.notifyDrainWaiters();
        }
      },
    };
  }

  getActiveExecutionCount(): number {
    return this.inFlight.size;
  }

  getCompletedExecutionCount(): number {
    return this.completedCount;
  }

  /**
   * Resolves as soon as all tracked executions complete, or after
   * timeoutMs elapses — whichever comes first. Never rejects. On timeout
   * the remaining executions are reported as leftForRecovery and their
   * durable journal state is intentionally left untouched.
   */
  async waitForActiveExecutions(timeoutMs: number): Promise<DrainSummary> {
    const timedOut = await this.waitForIdle(timeoutMs);
    return {
      completed: this.completedCount,
      leftForRecovery: this.getActiveExecutionCount(),
      timedOut,
    };
  }

  onStateChange(
    listener: (
      state: LifecycleState,
      initiation: ShutdownInitiation | null
    ) => void
  ): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private transitionTo(next: LifecycleState): void {
    // Forward-only: ignore stale/out-of-order/duplicate transitions so the
    // machine can never regress (e.g. a late DRAINING call after STOPPED).
    if (STATE_ORDER[next] <= STATE_ORDER[this.state]) return;
    this.state = next;
    if (next === "STOPPED" || next === "RELEASE_RESOURCES") {
      // Nothing new can arrive anymore; wake waiters so hosts finish fast.
      this.notifyDrainWaiters();
    }
    for (const listener of [...this.stateListeners]) {
      try {
        listener(this.state, this.initiation);
      } catch {
        // Listener errors must never break the shutdown sequence.
      }
    }
  }

  private waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.getActiveExecutionCount() === 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      // settle(true)  → grace period expired (timed out)
      // settle(false) → all executions completed before the deadline
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.drainWaiters.delete(wake);
        resolve(value);
      };
      const wake = () => settle(this.getActiveExecutionCount() !== 0);
      const timer = setTimeout(() => settle(true), Math.max(0, timeoutMs));
      this.drainWaiters.add(wake);
    });
  }

  private notifyDrainWaiters(): void {
    if (this.getActiveExecutionCount() === 0) {
      for (const waiter of [...this.drainWaiters]) waiter();
    }
  }
}
