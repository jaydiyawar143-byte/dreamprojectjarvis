// ---------------------------------------------------------------------------
// Phase 19, Stage 19.6 — the desktop agent's routes.
//
// The agent calls OUT to these; nothing here ever calls an agent, and the
// agent listens on nothing. Each request is signed by the device's key over
// its exact bytes, so this router is mounted BEFORE the app-wide JSON parser
// and reads the raw body itself, as the WhatsApp and n8n webhooks do. There is
// no session and no user token: the device's signature, verified against the
// public key stored at pairing, is the only credential. Every answer is
// signed by the server's command key, bound to the request it answers.
//
//   POST /pair                    redeem a pairing code with a fresh key
//   POST /poll                    held up to 20 s; at most one command back
//   POST /grants                  consent the person gave at the device
//   POST /session/end             control ended at the device
//   POST /commands/:id/result     one answer per command
// ---------------------------------------------------------------------------

import express, { Router, type Request, type Response } from "express";

import type { DesktopAgentRoute, DesktopControlService } from "../services/desktop/desktop-control-service.js";

/** Larger than any message the protocol allows; a body past it is refused unread. */
const MAX_BODY = "64kb";

export function createDesktopAgentRouter(service: DesktopControlService): Router {
  const router = Router();
  router.use(express.raw({ type: () => true, limit: MAX_BODY }));

  const handle = (route: DesktopAgentRoute) => async (req: Request, res: Response) => {
    const result = await service.handleAgent(route, {
      method: req.method,
      // As called, query and all: the signature covers it, and a query is refused.
      path: req.originalUrl,
      headers: req.headers,
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      source: req.ip ?? "unknown",
      ...(route === "result" ? { commandId: String(req.params.id ?? "") } : {}),
    });
    // The bytes sent are exactly the bytes that were signed.
    res.status(result.status).set(result.headers).type("application/json").send(JSON.stringify(result.body));
  };

  router.post("/pair", handle("pair"));
  router.post("/poll", handle("poll"));
  router.post("/grants", handle("grants"));
  router.post("/session/end", handle("session/end"));
  router.post("/commands/:id/result", handle("result"));
  return router;
}
