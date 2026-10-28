// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the browser service wire protocol, version 1.
//
// The version is part of every request and every response, and it is checked
// BEFORE the payload. A deployment of the API and a deployment of the browser
// service are rolled out separately, so the one thing that must never happen
// is an older peer reading a newer request as though it were its own.
//
// A change that alters the meaning of an existing field, removes one, or makes
// a previously valid request invalid is a NEW version string. Additive changes
// that an older peer can ignore are not, but the peer must still be given a
// way to say "I do not know this operation" — see `UNKNOWN_OPERATION`.
// ---------------------------------------------------------------------------

export const BROWSER_PROTOCOL_VERSION = "jarvis-browser/1" as const;

export type BrowserProtocolVersion = typeof BROWSER_PROTOCOL_VERSION;
