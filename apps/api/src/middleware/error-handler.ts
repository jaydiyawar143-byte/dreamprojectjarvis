// ---------------------------------------------------------------------------
// Sprint 9.2 / 9.11 — Safe production errors.
//
// Three problems this closes, all of them present before Sprint 9:
//
//   1. THE PROCESS COULD BE KILLED BY A REQUEST. Express 4 does not catch a
//      rejected promise from an async handler. Roughly fifteen handlers had no
//      try/catch, so a database blip became an unhandled rejection, which
//      Node 20 turns into process death. `asyncHandler` routes those rejections
//      into `next()` instead.
//
//   2. STACK TRACES COULD REACH A CLIENT. Express's own default handler
//      serialises `err.stack` into the body whenever NODE_ENV is not
//      "production" — and NODE_ENV defaults to "development" in this repo. The
//      handler below always terminates the request itself, so the default one
//      is never reached.
//
//   3. UNKNOWN ROUTES RETURNED EXPRESS'S HTML. A 404 catch-all now answers in
//      the same JSON envelope as everything else.
//
// The response envelope matches the one already used across the routes —
// `{ success, error: { code, message }, traceId, timestamp }` — so a client that
// handles a route error already handles these.
// ---------------------------------------------------------------------------

import type { Response, NextFunction, RequestHandler } from "express";
import { JarvisError } from "@jarvis/core";

import {
  errorMonitor,
  operationalLog,
  writeRecord,
  type ErrorMonitor,
} from "../services/observability/index.js";
import type { TracedRequest } from "./request-id.js";

/**
 * Wraps an async handler so a rejection reaches the error handler.
 *
 * Express 5 does this on its own; this repo is on Express 4, where an
 * unhandled rejection escapes to the process instead.
 *
 * TWO DELIBERATE DETAILS, both about how this repo's API tests drive routes.
 * They walk `router.stack` and branch on the handler's ARITY: a function of
 * three or more parameters is treated as middleware and awaited until it calls
 * `next()`, while a shorter one is treated as the terminal handler and its
 * returned promise is awaited.
 *
 *   1. The wrapper declares TWO parameters and reads `next` off `arguments`,
 *      so it is recognised as a terminal handler. A three-parameter wrapper
 *      makes every wrapped route hang: the harness waits for a `next()` that a
 *      responding handler never calls. Express passes all three arguments
 *      either way, so nothing changes at runtime.
 *
 *   2. The promise is RETURNED rather than voided, so an awaiting caller sees
 *      the response actually being produced. Express ignores the return value.
 *
 * When there is no `next` to hand the error to, it is rethrown rather than
 * swallowed — a silently discarded rejection would turn a failing test green.
 */
export function asyncHandler(
  handler: (req: never, res: Response, next: NextFunction) => Promise<unknown> | unknown
): RequestHandler {
  const wrapped = function (req: unknown, res: Response) {
    // eslint-disable-next-line prefer-rest-params
    const next = arguments[2] as NextFunction | undefined;
    return Promise.resolve(handler(req as never, res, next as NextFunction)).catch(
      (error: unknown) => {
        if (typeof next === "function") {
          next(error);
          return;
        }
        throw error;
      }
    );
  };
  return wrapped as unknown as RequestHandler;
}

/** Terminal 404, answering in the same shape as every other error. */
export function notFoundHandler() {
  return (req: TracedRequest, res: Response): void => {
    res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Route not found" },
      traceId: req.traceId,
      timestamp: new Date().toISOString(),
    });
  };
}

interface ErrorHandlerOptions {
  /** Overridden in tests. */
  log?: (line: Record<string, unknown>) => void;
  /** Told about every failure that is the server's fault. Overridden in tests. */
  monitor?: ErrorMonitor;
}

/**
 * The last middleware. Must be mounted after every route.
 *
 * A `JarvisError` is trusted to describe itself: its code and message were
 * written for a caller. Anything else is reported as INTERNAL_ERROR with a
 * fixed message, because an arbitrary throw's message can contain a connection
 * string, a file path or a provider's raw response.
 *
 * Phase 13 — the detail that is logged goes through the operational log, which
 * takes the secrets out of it, and a failure with a 5xx status is also reported
 * to the error monitor. A 4xx is the caller's mistake and is not.
 */
export function errorHandler(options: ErrorHandlerOptions = {}) {
  const log =
    options.log ??
    ((line: Record<string, unknown>) => writeRecord(operationalLog.child("http"), line));
  const monitor = options.monitor ?? errorMonitor;

  return (error: unknown, req: TracedRequest, res: Response, next: NextFunction): void => {
    // Headers already sent means a response was streaming when it failed;
    // Express must close the socket rather than append a second body.
    if (res.headersSent) {
      next(error);
      return;
    }

    const known = error instanceof JarvisError;
    const status = known ? error.statusCode : 500;
    const code = known ? error.code : "INTERNAL_ERROR";
    const message = known ? error.message : "Internal server error";

    // The full detail is logged, never returned. `stack` stays server-side.
    log({
      level: status >= 500 ? "error" : "warn",
      event: "request_failed",
      traceId: req.traceId,
      method: req.method,
      path: req.path,
      status,
      code,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    if (status >= 500) {
      monitor.captureException(error, {
        context: {
          component: "http",
          traceId: req.traceId,
          method: req.method,
          path: req.path,
          status,
          code,
        },
      });
    }

    res.status(status).json({
      success: false,
      error: { code, message },
      traceId: req.traceId,
      timestamp: new Date().toISOString(),
    });
  };
}

/**
 * Last-resort process handlers.
 *
 * These do NOT exit. A rejection that escapes every route is a bug worth
 * knowing about, but killing a healthy process that is mid-way through other
 * requests turns one bug into an outage. The shutdown controller remains the
 * only thing that ends this process deliberately.
 *
 * Phase 13 — each is also reported to the error monitor as `fatal`: nothing in
 * the application caught it, which is the kind of failure worth being woken for.
 */
export function installProcessErrorHandlers(
  options: {
    log?: (line: Record<string, unknown>) => void;
    monitor?: ErrorMonitor;
    /** The emitter the handlers are attached to. The process, except in tests. */
    target?: Pick<NodeJS.Process, "on">;
  } = {}
): void {
  const log =
    options.log ??
    ((line: Record<string, unknown>) => writeRecord(operationalLog.child("process"), line));
  const monitor = options.monitor ?? errorMonitor;
  const target = options.target ?? process;

  target.on("unhandledRejection", (reason: unknown) => {
    log({
      level: "error",
      event: "unhandled_rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    monitor.captureException(reason, {
      severity: "fatal",
      context: { component: "process", origin: "unhandled_rejection" },
    });
  });

  target.on("uncaughtException", (error: Error) => {
    log({
      level: "error",
      event: "uncaught_exception",
      message: error.message,
      stack: error.stack,
    });
    monitor.captureException(error, {
      severity: "fatal",
      context: { component: "process", origin: "uncaught_exception" },
    });
  });
}
