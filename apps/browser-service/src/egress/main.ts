// ---------------------------------------------------------------------------
// Phase 19, Stage 19.3 — the egress proxy process.
//
// A separate container from the browser service, built from the same image and
// started with `node apps/browser-service/dist/egress/main.js`. It is the only
// member of the internal `browser` network with a route outward, so the
// browser's traffic can leave by no other path.
//
// Fail-closed start-up: a configuration it cannot use exits before anything
// listens, and the browser service — which compose starts only once this is
// healthy — has then nothing to send through. Chromium never falls back to a
// direct connection when its proxy is down; it fails the request.
// ---------------------------------------------------------------------------

import { loadEgressConfig } from "./config.js";
import { createEgressHealthServer, createEgressProxy } from "./proxy.js";

/** The health listener's address. Not configurable: it is the container's own loopback. */
const HEALTH_HOST = "127.0.0.1";

/** Fixed-field operational logging. Never a path, a query, a header or a body. */
function log(event: string, fields: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({ level: "info", service: "browser-egress", event, ...fields }));
}

function fail(event: string, message: string): never {
  console.error(JSON.stringify({ level: "error", service: "browser-egress", event, message }));
  process.exit(1);
}

function main(): void {
  let config;
  try {
    config = loadEgressConfig();
  } catch (error) {
    fail("browser_egress_config_invalid", error instanceof Error ? error.message : "unknown");
  }

  const proxy = createEgressProxy({
    policy: config.policy,
    connectTimeoutMs: config.connectTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    maxConnections: config.maxConnections,
    log,
  });
  const health = createEgressHealthServer();

  proxy.on("error", (error) => fail("browser_egress_listen_failed", error.message));
  health.on("error", (error) => fail("browser_egress_health_listen_failed", error.message));

  proxy.listen(config.port, config.host, () => {
    log("browser_egress_started", {
      port: config.port,
      allowedPorts: config.policy.allowedPorts.join(","),
      domainAllowlist: config.policy.domainAllowlist.length,
    });
  });
  health.listen(config.healthPort, HEALTH_HOST, () => {
    log("browser_egress_health_listening", { port: config.healthPort });
  });

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log("browser_egress_stopping", { signal });
    health.close();
    proxy.close(() => process.exit(0));
    // Open tunnels do not hold the process: the browser service stops first.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main();
