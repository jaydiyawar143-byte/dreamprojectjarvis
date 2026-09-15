// ---------------------------------------------------------------------------
// R-27 — the in-memory circuit breaker for a model provider.
//
// closed     calls go through; consecutive TRANSIENT failures are counted
// open       calls are refused without reaching the provider, for a bounded time
// half_open  a limited number of probes go through; a success closes the
//            circuit, a transient failure reopens it
//
// Only transient failures count. A missing key, an invalid key or model, an
// invalid or too-long request say nothing about whether the provider is up.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import { CircuitBreaker, type CircuitTransition } from "../src/provider-circuit-breaker.js";

function setup(options: Partial<{ failureThreshold: number; openDurationMs: number; halfOpenMaxProbes: number }> = {}) {
  let clock = 0;
  const transitions: CircuitTransition[] = [];
  const breaker = new CircuitBreaker(
    { failureThreshold: 3, openDurationMs: 1000, halfOpenMaxProbes: 1, ...options },
    { now: () => clock, onTransition: (transition) => transitions.push(transition) }
  );
  return {
    breaker,
    transitions,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function failTransiently(breaker: CircuitBreaker, times: number) {
  for (let i = 0; i < times; i++) {
    const permit = breaker.acquire();
    expect(permit, `call ${i + 1} should be let through`).not.toBeNull();
    breaker.recordTransientFailure(permit!);
  }
}

describe("R-27 — CircuitBreaker", () => {
  it("starts closed and lets calls through", () => {
    const { breaker } = setup();

    expect(breaker.state).toBe("closed");
    expect(breaker.acquire()).toEqual({ probe: false });
  });

  it("counts consecutive transient failures", () => {
    const { breaker } = setup();

    failTransiently(breaker, 2);

    expect(breaker.consecutiveFailures).toBe(2);
    expect(breaker.state).toBe("closed");
  });

  it("does not count failures that are not transient", () => {
    const { breaker } = setup();

    for (let i = 0; i < 5; i++) {
      breaker.recordNeutral(breaker.acquire()!);
    }

    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.state).toBe("closed");
  });

  it("resets the count after a success", () => {
    const { breaker } = setup();

    failTransiently(breaker, 2);
    breaker.recordSuccess(breaker.acquire()!);
    failTransiently(breaker, 2);

    expect(breaker.consecutiveFailures).toBe(2);
    expect(breaker.state).toBe("closed");
  });

  it("opens at the threshold and then refuses calls", () => {
    const { breaker, transitions } = setup();

    failTransiently(breaker, 3);

    expect(breaker.state).toBe("open");
    expect(breaker.acquire()).toBeNull();
    expect(transitions).toEqual([{ from: "closed", to: "open", consecutiveFailures: 3 }]);
  });

  it("stays open for the whole open duration, then lets a probe through", () => {
    const { breaker, advance } = setup();
    failTransiently(breaker, 3);

    advance(999);
    expect(breaker.acquire()).toBeNull();

    advance(1);
    expect(breaker.state).toBe("half_open");
    expect(breaker.acquire()).toEqual({ probe: true });
  });

  it("lets only the configured number of probes through while half-open", () => {
    const { breaker, advance } = setup({ halfOpenMaxProbes: 2 });
    failTransiently(breaker, 3);
    advance(1000);

    expect(breaker.acquire()).toEqual({ probe: true });
    expect(breaker.acquire()).toEqual({ probe: true });
    expect(breaker.acquire()).toBeNull();
  });

  it("closes after a successful probe", () => {
    const { breaker, advance, transitions } = setup();
    failTransiently(breaker, 3);
    advance(1000);

    breaker.recordSuccess(breaker.acquire()!);

    expect(breaker.state).toBe("closed");
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.acquire()).toEqual({ probe: false });
    expect(transitions.map((t) => t.to)).toEqual(["open", "half_open", "closed"]);
  });

  it("reopens after a failed probe, for another full open duration", () => {
    const { breaker, advance } = setup();
    failTransiently(breaker, 3);
    advance(1000);

    breaker.recordTransientFailure(breaker.acquire()!);

    expect(breaker.state).toBe("open");
    advance(999);
    expect(breaker.acquire()).toBeNull();
    advance(1);
    expect(breaker.acquire()).toEqual({ probe: true });
  });

  it("frees the probe slot after a non-transient outcome, without closing", () => {
    const { breaker, advance } = setup();
    failTransiently(breaker, 3);
    advance(1000);

    breaker.recordNeutral(breaker.acquire()!);

    expect(breaker.state).toBe("half_open");
    expect(breaker.acquire()).toEqual({ probe: true });
  });

  it("keeps instances independent, and a new instance — as after a restart — starts closed", () => {
    const first = setup();
    failTransiently(first.breaker, 3);

    const second = setup();

    expect(first.breaker.state).toBe("open");
    expect(second.breaker.state).toBe("closed");
    expect(second.breaker.acquire()).toEqual({ probe: false });
  });

  it("reports a transition with states and a count, nothing else", () => {
    const { breaker, transitions } = setup();

    failTransiently(breaker, 3);

    expect(Object.keys(transitions[0]!).sort()).toEqual(["consecutiveFailures", "from", "to"]);
  });
});
