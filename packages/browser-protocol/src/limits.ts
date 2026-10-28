// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — bounded transport.
//
// Every limit here is enforced BEFORE the work it protects:
//
//   • the body ceiling is applied to the raw bytes, before JSON is parsed, so
//     an enormous request cannot be turned into an enormous object first;
//   • the response ceiling is applied while reading, so a misbehaving browser
//     cannot exhaust the API's memory through a result;
//   • the clock-skew window is applied before a request is dispatched, so a
//     captured request stops working on its own.
//
// These are protocol constants, not deployment preferences. A deployment may
// choose a SHORTER session or a SMALLER ceiling, never a larger one.
// ---------------------------------------------------------------------------

/** Largest request body the service will read. */
export const BROWSER_PROTOCOL_MAX_BODY_BYTES = 64 * 1024;

/**
 * Largest response body the API will read.
 *
 * A screenshot is returned by id, never inline, so the only genuinely large
 * field is extracted page text — already capped by @jarvis/core.
 */
export const BROWSER_PROTOCOL_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Default per-request ceiling. A browser action is bounded above this too. */
export const BROWSER_PROTOCOL_DEFAULT_TIMEOUT_MS = 30_000;

/** How far a request's timestamp may differ from the service's clock. */
export const BROWSER_PROTOCOL_DEFAULT_CLOCK_SKEW_MS = 60_000;

/** How long a used nonce is remembered. Must cover the clock-skew window. */
export const BROWSER_PROTOCOL_NONCE_TTL_MS = 5 * 60_000;

/** The shortest shared secret the service will accept. */
export const BROWSER_PROTOCOL_MIN_SECRET_LENGTH = 32;

/** The shortest session a deployment may configure. */
export const BROWSER_PROTOCOL_MIN_SESSION_TTL_MS = 1_000;

/** The longest session the protocol allows. */
export const BROWSER_PROTOCOL_MAX_SESSION_TTL_MS = 240_000;

/** The most sessions one browser-service process may hold. */
export const BROWSER_PROTOCOL_MAX_SESSIONS = 16;
