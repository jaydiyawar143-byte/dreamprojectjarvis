// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the browser service's fixed error vocabulary.
//
// The service is a different process with a different trust boundary, so the
// API must never put its words, a provider's words, a URL, a selector, a
// credential or a page title on the wire as an error. Each code has ONE fixed
// sentence. The API attaches its own code to that sentence; it never forwards
// a free-form message from the service to a model or a person.
//
// `PROVIDER_ERROR` deliberately says nothing about which provider or why. The
// detail belongs in the browser service's own operational log, keyed by the
// request id — never in the response, because a response crosses a boundary.
// ---------------------------------------------------------------------------

export const BROWSER_SERVICE_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "UNKNOWN_OPERATION",
  "UNAUTHENTICATED",
  "REQUEST_EXPIRED",
  "REPLAY_DETECTED",
  "NOT_AUTHORIZED",
  "CROSS_TENANT_DENIED",
  "SESSION_NOT_FOUND",
  "SESSION_EXPIRED",
  "LIMIT_EXCEEDED",
  "TOO_LARGE",
  "TIMEOUT",
  "UNAVAILABLE",
  "PROVIDER_ERROR",
  "UNKNOWN_OUTCOME",
] as const;

export type BrowserServiceErrorCode = (typeof BROWSER_SERVICE_ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(BROWSER_SERVICE_ERROR_CODES);

export function isBrowserServiceErrorCode(value: unknown): value is BrowserServiceErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

/**
 * One sentence per code. Fixed, so a response cannot become a side channel:
 * a caller learns what class of refusal happened, never what was inside the
 * request, the page or the provider's answer.
 */
export const BROWSER_SERVICE_ERROR_MESSAGES: Readonly<Record<BrowserServiceErrorCode, string>> =
  Object.freeze({
    INVALID_REQUEST: "The request was not valid.",
    UNSUPPORTED_VERSION: "The request protocol version is not supported.",
    UNKNOWN_OPERATION: "The requested operation is not supported.",
    UNAUTHENTICATED: "The request could not be authenticated.",
    REQUEST_EXPIRED: "The request has expired.",
    REPLAY_DETECTED: "The request was already used.",
    NOT_AUTHORIZED: "This action is not allowed.",
    CROSS_TENANT_DENIED: "This session belongs to another organization.",
    SESSION_NOT_FOUND: "The session was not found.",
    SESSION_EXPIRED: "The session has expired.",
    LIMIT_EXCEEDED: "The browser service is at capacity.",
    TOO_LARGE: "The request or its result is too large.",
    TIMEOUT: "The browser service did not answer in time.",
    UNAVAILABLE: "The browser service is not available.",
    PROVIDER_ERROR: "The browser could not perform the action.",
    UNKNOWN_OUTCOME: "The outcome of the action is unknown; it was not retried.",
  });

/**
 * What a failed call may have done on the other side (Stage 19.2 audit, H2).
 *
 *   not-sent   the request never left the API: nothing can have happened;
 *   no-effect  it was sent, and either the service refused it before acting,
 *              or the operation has no external effect (a read, a session);
 *   uncertain  a WRITE was sent and no definitive answer came back — the
 *              click or submit may have reached the site.
 *
 * An uncertain write must be recorded UNKNOWN and never retried (Phase 19.1).
 */
export type BrowserServiceOutcome = "not-sent" | "no-effect" | "uncertain";

/**
 * The service's refusals that come BEFORE an action is handed to the browser:
 * the request was not authenticated, not valid, or named a session the service
 * would not use. Every other failure of a sent write — TIMEOUT, PROVIDER_ERROR,
 * UNKNOWN_OUTCOME, REPLAY_DETECTED (an earlier copy of the same signed request
 * may have run), UNAVAILABLE — leaves the action's outcome uncertain.
 *
 * An allowlist on purpose: a code added later is uncertain until someone
 * decides, here, that it is known to precede the action.
 */
const REFUSED_BEFORE_ACTION: ReadonlySet<BrowserServiceErrorCode> = new Set<BrowserServiceErrorCode>([
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "UNKNOWN_OPERATION",
  "UNAUTHENTICATED",
  "REQUEST_EXPIRED",
  "NOT_AUTHORIZED",
  "CROSS_TENANT_DENIED",
  "SESSION_NOT_FOUND",
  "SESSION_EXPIRED",
  "LIMIT_EXCEEDED",
  "TOO_LARGE",
]);

/** What a refusal the service SENT says about the action it answers. */
export function outcomeOfServiceRefusal(
  code: BrowserServiceErrorCode,
  write: boolean
): BrowserServiceOutcome {
  return write && !REFUSED_BEFORE_ACTION.has(code) ? "uncertain" : "no-effect";
}

/**
 * A refusal from the browser service, or the API's own refusal to call it.
 *
 * It carries a code, the outcome above, and nothing else. There is
 * deliberately no `cause`: a cause is how a transport error's message — with
 * a URL, a header or a page fragment in it — reaches a surface that must not
 * show one.
 *
 * `phase` and `sideEffectPossible` are the shape the execution journal reads
 * (`classifyWriteOutcome` in @jarvis/tools): `before-send` is a known FAILED,
 * `in-flight` without a possible side effect is a known FAILED, and
 * `in-flight` with one is UNKNOWN.
 */
export class BrowserServiceError extends Error {
  override readonly name = "BrowserServiceError";
  readonly outcome: BrowserServiceOutcome;
  readonly phase: "before-send" | "in-flight";
  readonly sideEffectPossible: boolean;

  /**
   * `outcome` defaults to `not-sent`: an error made before a request exists.
   * Every path that has sent one names its outcome explicitly.
   *
   * An uncertain outcome is told as one, whatever its code: "the service is
   * not available" after a submit may have reached the site would let a person
   * believe nothing happened. The code still says what failed.
   */
  constructor(readonly code: BrowserServiceErrorCode, outcome: BrowserServiceOutcome = "not-sent") {
    super(BROWSER_SERVICE_ERROR_MESSAGES[outcome === "uncertain" ? "UNKNOWN_OUTCOME" : code]);
    this.outcome = outcome;
    this.phase = outcome === "not-sent" ? "before-send" : "in-flight";
    this.sideEffectPossible = outcome === "uncertain";
  }
}
