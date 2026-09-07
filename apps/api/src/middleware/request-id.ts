// ---------------------------------------------------------------------------
// Sprint 9.2 / 9.9 — Request correlation.
//
// Before this, a `traceId` was minted independently inside four route handlers
// and returned in their response bodies, while `morgan` wrote a separate access
// line that knew nothing about it. There was no way to tie a reported error
// back to the request that caused it.
//
// One id is now assigned at the edge, reused by every handler that wants one,
// echoed to the client, and available to the error handler.
//
// An inbound `x-request-id` is ACCEPTED but not trusted: it is bounded and
// stripped of anything that is not a safe identifier character, because it ends
// up in logs and in a response header where a newline would let a caller forge
// a log line or split a header.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";

/** Every request carries one; handlers should prefer it over minting their own. */
export interface TracedRequest extends Request {
  traceId?: string;
}

const MAX_INBOUND_ID_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

/** Returns the caller's id when it is safe to reuse, otherwise null. */
export function sanitizeInboundRequestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INBOUND_ID_LENGTH) return null;
  return SAFE_ID.test(trimmed) ? trimmed : null;
}

export function requestId() {
  return (req: TracedRequest, res: Response, next: NextFunction): void => {
    const inbound = sanitizeInboundRequestId(req.headers["x-request-id"]);
    const traceId = inbound ?? randomUUID();
    req.traceId = traceId;
    res.setHeader("x-request-id", traceId);
    next();
  };
}
