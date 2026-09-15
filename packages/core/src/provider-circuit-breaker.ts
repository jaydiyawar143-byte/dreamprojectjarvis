// ---------------------------------------------------------------------------
// R-27 — an in-memory circuit breaker for one model-provider client.
//
//   closed     calls go through; consecutive TRANSIENT failures are counted
//   open       calls are refused without reaching the provider, for a bounded
//              time
//   half_open  up to `halfOpenMaxProbes` calls go through at once; a success
//              closes the circuit, a transient failure opens it again
//
// Only transient failures count. A missing or rejected key, an invalid model
// or request, an exceeded context window or a cancelled call is `neutral`: it
// says nothing about whether the provider is up.
//
// State lives in the instance and nowhere else, so a restart starts closed and
// two instances never share a count. Callers own the scope; the OpenAI adapter
// holds one per adapter, which is one per API key per process.
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive transient failures that open the circuit. */
  failureThreshold: number;
  /** How long an open circuit refuses calls before letting a probe through. */
  openDurationMs: number;
  /** Probes allowed at the same time while half-open. */
  halfOpenMaxProbes: number;
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: Readonly<CircuitBreakerOptions> = Object.freeze({
  failureThreshold: 5,
  openDurationMs: 30_000,
  halfOpenMaxProbes: 1,
});

/** A state change, reported with the count and nothing else. */
export interface CircuitTransition {
  from: CircuitState;
  to: CircuitState;
  consecutiveFailures: number;
}

/** Permission for one call; hand it back to exactly one `record…` method. */
export interface CircuitPermit {
  readonly probe: boolean;
}

export class CircuitBreaker {
  private readonly options: CircuitBreakerOptions;
  private readonly now: () => number;
  private readonly onTransition?: (transition: CircuitTransition) => void;

  private current: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;
  private probesInFlight = 0;

  constructor(
    options: Partial<CircuitBreakerOptions> = {},
    deps: { now?: () => number; onTransition?: (transition: CircuitTransition) => void } = {}
  ) {
    this.options = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...options };
    this.now = deps.now ?? Date.now;
    this.onTransition = deps.onTransition;
  }

  /** The current state; an open circuit whose time is up becomes half-open here. */
  get state(): CircuitState {
    if (this.current === "open" && this.now() - this.openedAt >= this.options.openDurationMs) {
      this.probesInFlight = 0;
      this.moveTo("half_open");
    }
    return this.current;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** A permit for one call, or null when the call must be refused. */
  acquire(): CircuitPermit | null {
    switch (this.state) {
      case "closed":
        return { probe: false };
      case "open":
        return null;
      case "half_open":
        if (this.probesInFlight >= this.options.halfOpenMaxProbes) return null;
        this.probesInFlight++;
        return { probe: true };
    }
  }

  recordSuccess(permit: CircuitPermit): void {
    if (permit.probe) {
      this.releaseProbe();
      if (this.current === "half_open") {
        this.failures = 0;
        this.moveTo("closed");
      }
      return;
    }
    if (this.current === "closed") this.failures = 0;
  }

  recordTransientFailure(permit: CircuitPermit): void {
    if (permit.probe) {
      this.releaseProbe();
      if (this.current === "half_open") this.open();
      return;
    }
    // A call admitted before the circuit opened changes nothing once it has.
    if (this.current !== "closed") return;
    this.failures++;
    if (this.failures >= this.options.failureThreshold) this.open();
  }

  /** A failure that says nothing about the provider's health. */
  recordNeutral(permit: CircuitPermit): void {
    if (permit.probe) this.releaseProbe();
  }

  private open(): void {
    this.openedAt = this.now();
    this.moveTo("open");
  }

  private releaseProbe(): void {
    this.probesInFlight = Math.max(0, this.probesInFlight - 1);
  }

  private moveTo(next: CircuitState): void {
    if (next === this.current) return;
    const from = this.current;
    this.current = next;
    this.onTransition?.({ from, to: next, consecutiveFailures: this.failures });
  }
}
