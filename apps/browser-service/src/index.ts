// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the browser service process.
//
// Start-up order matters, and it is fail-closed at every step:
//
//   1. configuration is read; a missing key, secret or identity throws, so the
//      process never runs in a state where it would answer every request with
//      a refusal while looking healthy;
//   2. the engine is built; Chromium stays off unless explicitly enabled;
//   3. the server is built and only then does it listen.
//
// There is no route, tool or agent that starts this process. It is a separate
// deployment target, with its own image, user, resource limits and network
// position (`docker-compose.yml`, profile `browser-service`).
// ---------------------------------------------------------------------------

import { ProcessNonceStore } from "@jarvis/browser-protocol";

import { loadBrowserServiceConfig } from "./config.js";
import { createBrowserEngine } from "./engine.js";
import { BrowserSessionRegistry } from "./session-registry.js";
import { createBrowserServiceHealthServer, createBrowserServiceServer } from "./server.js";

/** The health listener's address. Not configurable: it is the container's own loopback. */
const HEALTH_HOST = "127.0.0.1";

/** Fixed-field operational logging. Never a header, a body or a page. */
function log(event: string, fields: Record<string, string | number | boolean> = {}): void {
  console.log(
    JSON.stringify({
      level: "info",
      service: "browser",
      event,
      ...fields,
    })
  );
}

function fail(event: string, message: string): never {
  console.error(
    JSON.stringify({
      level: "error",
      service: "browser",
      event,
      // Configuration errors name a field, never its value. They are written
      // once at start-up and then the process exits.
      message,
    })
  );
  process.exit(1);
}

function main(): void {
  let config;
  try {
    config = loadBrowserServiceConfig();
  } catch (error) {
    fail("browser_service_config_invalid", error instanceof Error ? error.message : "unknown");
  }

  let engine;
  try {
    engine = createBrowserEngine(config, log);
  } catch (error) {
    fail("browser_service_engine_unavailable", error instanceof Error ? error.message : "unknown");
  }

  const registry = new BrowserSessionRegistry(engine.engine, {
    sessionTtlMs: config.sessionTtlMs,
    maxSessions: config.maxSessions,
    maxSessionsPerOrganization: config.maxSessionsPerOrganization,
    openTimeoutMs: config.requestTimeoutMs,
  });

  const server = createBrowserServiceServer({
    config,
    registry,
    nonces: new ProcessNonceStore(),
    chromiumEnabled: engine.chromiumEnabled,
    log,
  });

  // Expiry is enforced on every request; the sweeper makes it true even when
  // the caller stops talking. One second is far below the shortest TTL.
  const sweeper = setInterval(() => registry.reap(), 1_000);
  sweeper.unref();

  // Phase 19.4 — expired, half-written and unreadable artifacts are removed at
  // start-up and then on an interval. The first sweep is also the store's
  // start-up check: a directory the service cannot use (not writable, or not
  // an artifact store) stops the service, rather than leaving it healthy and
  // refusing every artifact. A later failed sweep is logged and retried at the
  // next interval; an expired artifact is refused on read either way.
  const sweepArtifacts = engine.sweepArtifacts;
  let artifactSweeper: NodeJS.Timeout | undefined;
  if (sweepArtifacts) {
    void sweepArtifacts().catch(() =>
      fail("browser_service_artifacts_unavailable", "the artifact store in BROWSER_SERVICE_DOWNLOAD_DIR cannot be used")
    );
    artifactSweeper = setInterval(
      () => void sweepArtifacts().catch(() => log("artifact_sweep_failed")),
      config.chromium.artifacts.sweepIntervalMs
    );
    artifactSweeper.unref();
  }

  const health = createBrowserServiceHealthServer({
    config,
    chromiumEnabled: engine.chromiumEnabled,
  });

  server.listen(config.port, config.host, () => {
    log("browser_service_started", {
      port: config.port,
      chromium: engine.chromiumEnabled ? "enabled" : "disabled",
      mutualTls: true,
    });
  });
  health.listen(config.healthPort, HEALTH_HOST, () => {
    log("browser_service_health_listening", { port: config.healthPort });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("browser_service_stopping", { signal });
    clearInterval(sweeper);
    if (artifactSweeper) clearInterval(artifactSweeper);
    health.close();
    server.close(() => {
      void registry
        .shutdown()
        .catch(() => undefined)
        .then(() => {
          log("browser_service_stopped");
          process.exit(0);
        });
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
