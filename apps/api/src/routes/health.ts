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

export function createHealthRouter(lifecycle?: {
  getState(): string;
}): ExpressRouter {
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

  return router;
}
