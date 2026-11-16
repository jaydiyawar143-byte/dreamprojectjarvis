// ---------------------------------------------------------------------------
// Phase 19, P0 — the API's start-up diagnosis of its browser service.
//
// Two halves:
//
//   1. the background probe's schedule: it never blocks or throws, retries
//      only what can clear by itself, stops at the first success, and logs a
//      fixed reason per attempt (no timer runs here — the schedule is a seam);
//   2. the container's registration order, read as source text as the other
//      browser-wiring tests do: the TLS files are checked before a client
//      exists, a problem registers nothing and never falls back to an
//      in-process browser, and the probe starts only after registration.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserServiceEndpointConfig, BrowserServiceProbeResult } from "@jarvis/browser-protocol";
import { BROWSER_SERVICE_PROBE_MESSAGES } from "@jarvis/browser-protocol";
import { describe, expect, it } from "vitest";

import {
  BROWSER_SERVICE_PROBE_DELAYS_MS,
  causeForEndpointProblem,
  causeForTlsProblem,
  startBrowserServiceProbe,
} from "../src/services/browser-service-diagnostics.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CONTAINER_SOURCE = readFileSync(resolve(here, "../src/services/container.ts"), "utf-8");

const CONFIG: BrowserServiceEndpointConfig = {
  baseUrl: "https://browser-service:3200",
  keyId: "api-key-1",
  secret: "0123456789abcdef0123456789abcdef",
  peerIdentity: "jarvis-api",
  timeoutMs: 30_000,
  tls: { certPath: "/run/jarvis-browser-tls/client.crt", keyPath: "/run/jarvis-browser-tls/client.key", caPath: null },
};

const fail = (reason: keyof typeof BROWSER_SERVICE_PROBE_MESSAGES): BrowserServiceProbeResult => ({
  ok: false,
  reason,
  message: BROWSER_SERVICE_PROBE_MESSAGES[reason],
});

/** Runs the probe schedule to completion, recording delays and log lines. */
async function drive(answers: Array<BrowserServiceProbeResult | Error>) {
  const delays: number[] = [];
  const queue: Array<() => void> = [];
  const lines: Array<{ level: "info" | "warn"; event: string; fields?: Record<string, unknown> }> = [];
  let calls = 0;
  startBrowserServiceProbe({
    config: CONFIG,
    log: {
      info: (event, fields) => lines.push({ level: "info", event, fields }),
      warn: (event, fields) => lines.push({ level: "warn", event, fields }),
    },
    probe: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)]!;
      calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    schedule: (run, delayMs) => {
      delays.push(delayMs);
      queue.push(run);
    },
  });
  // Nothing has run yet: starting the probe returned before probing.
  expect(calls).toBe(0);
  while (queue.length > 0) {
    queue.shift()!();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolveTick) => setImmediate(resolveTick));
  }
  return { delays, lines, calls };
}

describe("the background probe", () => {
  it("probes once at once, and logs the service as reachable", async () => {
    const { delays, lines, calls } = await drive([{ ok: true }]);
    expect(delays).toEqual([0]);
    expect(calls).toBe(1);
    expect(lines).toEqual([
      { level: "info", event: "browser_service_reachable", fields: { attempt: 1, protocolVersion: "jarvis-browser/1" } },
    ]);
  });

  it("retries a service that is not up yet, backing off, and stops at the first success", async () => {
    const { delays, lines, calls } = await drive([fail("unreachable"), fail("timeout"), { ok: true }]);
    expect(delays).toEqual([0, BROWSER_SERVICE_PROBE_DELAYS_MS[1], BROWSER_SERVICE_PROBE_DELAYS_MS[2]]);
    expect(calls).toBe(3);
    expect(lines.map((line) => [line.event, line.fields?.reason ?? null, line.fields?.retrying ?? null])).toEqual([
      ["browser_service_probe_failed", "unreachable", true],
      ["browser_service_probe_failed", "timeout", true],
      ["browser_service_reachable", null, null],
    ]);
  });

  it("gives up after the last attempt, saying so", async () => {
    const { calls, lines } = await drive([fail("unreachable")]);
    expect(calls).toBe(BROWSER_SERVICE_PROBE_DELAYS_MS.length);
    expect(lines.at(-1)?.fields).toMatchObject({ reason: "unreachable", retrying: false });
  });

  it.each(["authentication", "protocol-version", "tls-handshake", "client-credentials-unreadable", "unexpected-response"] as const)(
    "does not repeat a configuration failure (%s): it is logged once, as final",
    async (reason) => {
      const { delays, lines, calls } = await drive([fail(reason)]);
      expect(calls).toBe(1);
      expect(delays).toEqual([0]);
      expect(lines).toEqual([
        {
          level: "warn",
          event: "browser_service_probe_failed",
          fields: { attempt: 1, reason, message: BROWSER_SERVICE_PROBE_MESSAGES[reason], retrying: false },
        },
      ]);
    }
  );

  it("turns a probe that throws into a reason, and never throws into start-up", async () => {
    const { lines } = await drive([new Error("socket exploded at 10.0.0.1 with /run/secret")]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.fields?.reason).toBe("unexpected-response");
    expect(JSON.stringify(lines)).not.toMatch(/10\.0\.0\.1|\/run\/secret|exploded/);
  });

  it("logs nothing that could be a secret, a path or a host", async () => {
    const { lines } = await drive([fail("authentication")]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(CONFIG.secret);
    expect(text).not.toContain("/run/jarvis-browser-tls");
    expect(text).not.toContain("browser-service:3200");
  });
});

describe("registration causes", () => {
  it("names each kind of configuration mistake", () => {
    expect(causeForEndpointProblem("missing")).toBe("configuration_missing");
    expect(causeForEndpointProblem("invalid-url")).toBe("invalid_service_url");
    expect(causeForEndpointProblem("invalid-value")).toBe("configuration_invalid");
    expect(causeForTlsProblem("unreadable")).toBe("tls_material_unreadable");
    for (const problem of ["invalid", "mismatched-pair", "expired", "not-yet-valid", "wrong-identity"] as const) {
      expect(causeForTlsProblem(problem)).toBe("tls_material_invalid");
    }
  });
});

describe("the container checks the TLS material before registering, and probes after", () => {
  const ready = CONTAINER_SOURCE.indexOf('} else if (browserService.state === "ready") {');
  const local = CONTAINER_SOURCE.indexOf("} else if (isBrowserConfigured()) {");
  const branch = CONTAINER_SOURCE.slice(ready, local);

  it("checks the client TLS files against the peer identity before a client exists", () => {
    expect(ready).toBeGreaterThan(-1);
    expect(local).toBeGreaterThan(ready);
    const check = branch.indexOf(
      "checkBrowserServiceClientTls(browserService.config.tls, browserService.config.peerIdentity)"
    );
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(branch.indexOf("new BrowserServiceClient("));
  });

  it("registers nothing, and builds no runtime, when the TLS material is not usable", () => {
    const refused = branch.slice(branch.indexOf("if (!tlsCheck || !tlsCheck.ok) {"), branch.indexOf("} else {"));
    expect(refused).toContain("browser_registration_skipped");
    expect(refused).toContain("causeForTlsProblem(tlsCheck.problem)");
    expect(refused).not.toContain("registry.register(");
    expect(refused).not.toContain("new BrowserRuntime(");
    expect(refused).not.toContain("new RemoteBrowserRuntime(");
  });

  it("starts the probe only after the tools are registered, through the operational log", () => {
    const register = branch.indexOf("registry.register(tool)");
    const probe = branch.indexOf("startBrowserServiceProbe({");
    expect(register).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(register);
    expect(branch.slice(probe, probe + 200)).toContain('operationalLog.child("browser-service")');
    // Exactly one probe, in the remote branch.
    expect(CONTAINER_SOURCE.match(/startBrowserServiceProbe\(/g) ?? []).toHaveLength(1);
  });

  it("says why browsing is off, and whether a browser-service URL is being ignored", () => {
    const disabled = CONTAINER_SOURCE.slice(
      CONTAINER_SOURCE.indexOf("if (!isBrowserEnabled()) {"),
      CONTAINER_SOURCE.indexOf('} else if (browserService.state === "invalid") {')
    );
    expect(disabled).toContain('event: "browser_tools_disabled"');
    expect(disabled).toContain('cause: "disabled"');
    expect(disabled).toContain('browserServiceConfigured: browserService.state !== "absent"');
  });

  it("names the kind of configuration mistake when the endpoint is unusable", () => {
    const invalid = CONTAINER_SOURCE.slice(
      CONTAINER_SOURCE.indexOf('} else if (browserService.state === "invalid") {'),
      ready
    );
    expect(invalid).toContain("cause: causeForEndpointProblem(browserService.problem)");
  });
});
