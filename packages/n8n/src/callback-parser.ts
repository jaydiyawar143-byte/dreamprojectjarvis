import type { N8nCallbackEvent } from "@jarvis/core";
import { truncateSummary } from "./config.js";

// ---------------------------------------------------------------------------
// Callback payload parsing (Sprint 5.4)
// ---------------------------------------------------------------------------
// The contract a workflow's final HTTP Request node must satisfy:
//
//   POST /api/v1/n8n/callback
//   X-Jarvis-Signature: sha256=<hmac>
//   {
//     "eventId":     "<unique per delivery>",
//     "executionId": "<jarvisExecutionId echoed from the trigger>",
//     "status":      "success" | "error",
//     "summary":     "...",            // optional
//     "errorMessage":"...",            // optional
//     "executionId_n8n": "...",        // optional, n8n's own id
//     "timestamp":   "<ISO 8601>"      // optional
//   }
//
// Parsing is strict here, unlike the WhatsApp webhook parser. WhatsApp receives
// batches from Meta where one bad element must not poison the rest; a callback
// is a single result whose identity fields are mandatory, so a payload missing
// them is rejected rather than silently half-applied.
// ---------------------------------------------------------------------------

/** Bounds the id fields so a hostile callback cannot bloat a row or an index. */
const MAX_ID_LENGTH = 200;

function readId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ID_LENGTH) return null;
  return trimmed;
}

function readTimestamp(value: unknown, fallback: Date): Date {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Accept seconds or milliseconds; anything below this threshold is seconds.
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  return fallback;
}

export type CallbackParseFailure =
  | "MISSING_EVENT_ID"
  | "MISSING_EXECUTION_ID"
  | "INVALID_STATUS"
  | "MALFORMED";

export type CallbackParseResult =
  | { ok: true; event: N8nCallbackEvent }
  | { ok: false; reason: CallbackParseFailure };

export function parseCallbackPayload(
  payload: unknown,
  now: Date = new Date()
): CallbackParseResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "MALFORMED" };
  }
  const b = payload as Record<string, unknown>;

  // Without an event id there is no deduplication key, so the callback cannot
  // be applied safely at all.
  const eventId = readId(b.eventId);
  if (!eventId) return { ok: false, reason: "MISSING_EVENT_ID" };

  const executionId = readId(b.executionId);
  if (!executionId) return { ok: false, reason: "MISSING_EXECUTION_ID" };

  const status = b.status;
  if (status !== "success" && status !== "error") {
    return { ok: false, reason: "INVALID_STATUS" };
  }

  return {
    ok: true,
    event: {
      eventId,
      executionId,
      status,
      remoteExecutionId: readId(b.executionId_n8n ?? b.remoteExecutionId),
      summary: truncateSummary(b.summary),
      errorMessage: truncateSummary(b.errorMessage),
      timestamp: readTimestamp(b.timestamp, now),
    },
  };
}

/**
 * Freshness window backing replay protection.
 *
 * A valid signature proves the callback came from a holder of the shared
 * secret; it says nothing about when. Without this, a captured body stays
 * replayable forever. The unique constraint on callbackEventId is the second,
 * independent guard.
 */
export function isCallbackFresh(
  timestamp: Date,
  maxAgeMs: number,
  now: Date = new Date()
): boolean {
  const age = now.getTime() - timestamp.getTime();
  // A minute of tolerance absorbs clock skew between n8n and this host.
  return age <= maxAgeMs && age >= -60_000;
}
