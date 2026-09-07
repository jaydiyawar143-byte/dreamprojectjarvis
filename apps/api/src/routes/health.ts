import { Router, type Router as ExpressRouter } from "express";

// ---------------------------------------------------------------------------
// Phase 10.6 — lifecycle-aware health reporting.
//
// RUNNING  → { status: "ok" }                      (HTTP 200, unchanged)
// DRAINING → { status: "draining", state: ... }    (HTTP 200, non-breaking:
//                                                   load balancers keep the
//                                                   existing contract; the
//                                                   body flags degradation)
// STOPPED  → server is closed; endpoint unreachable.
//
// No secrets or internal configuration are ever included in responses.
// The legacy stateless `healthRouter` export is preserved for compatibility.
// ---------------------------------------------------------------------------

export const healthRouter: ExpressRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "jarvis-api",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ---------------------------------------------------------------------------
// Sprint 9.10 — liveness and readiness, added ALONGSIDE the existing probe.
//
// `GET /` is deliberately unchanged, byte for byte. Its 200-while-draining
// behaviour is a documented decision and is pinned by shutdown.test.ts, so the
// new probes are new routes rather than a redefinition of that one.
//
//   /live   — is the process up? Never touches a dependency, so a database
//             outage cannot get a healthy process killed and restarted into
//             the same outage.
//   /ready  — should this instance receive traffic? Checks the database with a
//             bounded query and reports 503 while draining, which is the
//             signal a load balancer actually needs.
//
// Neither reveals configuration. A failed dependency check reports THAT it
// failed, never the driver's error text, which routinely contains a host, a
// port and sometimes credentials.
// ---------------------------------------------------------------------------

/** Bounded so a hung database cannot hold the probe open indefinitely. */
export const READINESS_CHECK_TIMEOUT_MS = 2000;

export interface ReadinessDependencies {
  /** Resolves when the database answers. Injected so tests need no Postgres. */
  pingDatabase?: () => Promise<unknown>;
  timeoutMs?: number;
}

async function withTimeout(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createHealthRouter(
  lifecycle?: {
    getState(): string;
  },
  deps: ReadinessDependencies = {}
): ExpressRouter {
  const router: ExpressRouter = Router();

  router.get("/", (_req, res) => {
    const state = lifecycle?.getState() ?? "RUNNING";
    const draining = state !== "RUNNING";
    res.json({
      status: draining ? "draining" : "ok",
      ...(draining ? { state } : {}),
      service: "jarvis-api",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  router.get("/live", (_req, res) => {
    // Intentionally dependency-free. Liveness answers "is this process
    // wedged?", and failing it because Postgres is down would restart a
    // perfectly healthy instance into the same outage.
    res.status(200).json({
      status: "alive",
      service: "jarvis-api",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  router.get("/ready", (_req, res) => {
    void (async () => {
      const state = lifecycle?.getState() ?? "RUNNING";
      if (state !== "RUNNING") {
        res.status(503).json({
          status: "draining",
          state,
          service: "jarvis-api",
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const databaseOk = deps.pingDatabase
        ? await withTimeout(
            Promise.resolve().then(() => deps.pingDatabase!()),
            deps.timeoutMs ?? READINESS_CHECK_TIMEOUT_MS
          )
        : true;

      res.status(databaseOk ? 200 : 503).json({
        status: databaseOk ? "ready" : "not_ready",
        service: "jarvis-api",
        // The name of the check, never the reason it failed.
        checks: { database: databaseOk ? "ok" : "failed" },
        timestamp: new Date().toISOString(),
      });
    })();
  });

  return router;
}
