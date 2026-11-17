// ---------------------------------------------------------------------------
// Phase 19, P0 — what the API says about its browser service at start-up.
//
// Registration and reachability are different questions, answered at different
// moments:
//
//   • registration (synchronous, in the container): is browsing switched on,
//     is the configuration complete, are the URL and the TLS files usable? A
//     "no" registers no browser tool. Each "no" is its own `cause`.
//   • reachability (here, in the background, after registration): does the
//     service actually answer this API — network, TLS handshake, identity,
//     signature, clock, protocol version? The tools stay registered whatever
//     the answer, so a service that starts after the API needs no restart;
//     the answer is logged, so a failure is visible before anyone browses.
//
// The probe never blocks start-up, never throws into it, and logs fixed
// reasons and sentences only — never a host, a path, a certificate or a value.
// ---------------------------------------------------------------------------

import {
  BROWSER_PROTOCOL_VERSION,
  probeBrowserService,
  type BrowserServiceEndpointConfig,
  type BrowserServiceEndpointProblem,
  type BrowserServiceProbeFailure,
  type BrowserServiceProbeResult,
  type BrowserServiceTlsProblem,
} from "@jarvis/browser-protocol";

import type { OperationalLog } from "./observability/index.js";

/** Delay before each attempt: the first at once, then backing off. */
export const BROWSER_SERVICE_PROBE_DELAYS_MS: readonly number[] = Object.freeze([0, 5_000, 15_000, 30_000, 60_000]);

/**
 * Failures that can clear without anyone changing anything — the service is
 * still starting, briefly overloaded, or a clock is being corrected. Every
 * other failure is configuration, and repeating the probe would only repeat
 * the line: it is logged once as final.
 */
const TRANSIENT: ReadonlySet<BrowserServiceProbeFailure> = new Set<BrowserServiceProbeFailure>([
  "unreachable",
  "timeout",
  "service-unavailable",
  "clock-skew",
]);

export interface BrowserServiceProbeScheduleDeps {
  config: BrowserServiceEndpointConfig;
  log: Pick<OperationalLog, "info" | "warn">;
  /** Test seam. Production probes the real service. */
  probe?: (config: BrowserServiceEndpointConfig) => Promise<BrowserServiceProbeResult>;
  /** Test seam. Production uses an unref'd timer, so the probe never holds the process. */
  schedule?: (run: () => void, delayMs: number) => void;
}

/** Start probing the browser service in the background. Returns at once. */
export function startBrowserServiceProbe(deps: BrowserServiceProbeScheduleDeps): void {
  const probe = deps.probe ?? ((config: BrowserServiceEndpointConfig) => probeBrowserService(config));
  const schedule =
    deps.schedule ??
    ((run: () => void, delayMs: number) => {
      setTimeout(run, delayMs).unref();
    });
  let attempt = 0;

  const run = (): void => {
    attempt += 1;
    const thisAttempt = attempt;
    probe(deps.config)
      .catch((): BrowserServiceProbeResult => ({
        ok: false,
        reason: "unexpected-response",
        message: "The browser service probe failed unexpectedly.",
      }))
      .then((result) => {
        if (result.ok) {
          deps.log.info("browser_service_reachable", {
            attempt: thisAttempt,
            protocolVersion: BROWSER_PROTOCOL_VERSION,
          });
          return;
        }
        const next = BROWSER_SERVICE_PROBE_DELAYS_MS[thisAttempt];
        const retrying = TRANSIENT.has(result.reason) && next !== undefined;
        deps.log.warn("browser_service_probe_failed", {
          attempt: thisAttempt,
          reason: result.reason,
          message: result.message,
          retrying,
        });
        if (retrying) schedule(run, next);
      })
      .catch(() => undefined);
  };

  schedule(run, BROWSER_SERVICE_PROBE_DELAYS_MS[0]!);
}

/** The `cause` an operator reads on `browser_registration_skipped`. */
export type BrowserRegistrationSkipCause =
  | "configuration_missing"
  | "invalid_service_url"
  | "configuration_invalid"
  | "tls_material_unreadable"
  | "tls_material_invalid"
  | "construction_failed";

export function causeForEndpointProblem(problem: BrowserServiceEndpointProblem): BrowserRegistrationSkipCause {
  switch (problem) {
    case "missing":
      return "configuration_missing";
    case "invalid-url":
      return "invalid_service_url";
    case "invalid-value":
      return "configuration_invalid";
  }
}

export function causeForTlsProblem(problem: BrowserServiceTlsProblem): BrowserRegistrationSkipCause {
  return problem === "unreadable" ? "tls_material_unreadable" : "tls_material_invalid";
}
