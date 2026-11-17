// ---------------------------------------------------------------------------
// n8n Sandbox Service errors
// ---------------------------------------------------------------------------
// Same discipline as `error-handler.ts`: errors are values where a caller can
// branch, classified honestly, and redacted before they can reach a log, an
// audit row or a response.
//
// The one sandbox-specific hazard is a command execution that outlives its
// stream. Disconnecting does NOT stop it; only `DELETE .../executions/{execId}`
// does. So an error from a POST execution is marked `sideEffectPossible` when
// the request may have reached the service, and `execId` is carried whenever it
// is known so a caller can look the execution up rather than run it again.
// ---------------------------------------------------------------------------

export type N8nSandboxErrorCode =
  | "INVALID_REQUEST"
  | "AUTHENTICATION_FAILED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "GONE"
  | "RATE_LIMITED"
  | "BAD_GATEWAY"
  | "UNAVAILABLE"
  | "SERVICE_ERROR"
  | "TOOL_TIMEOUT"
  | "ABORTED"
  | "NETWORK_ERROR"
  | "MALFORMED_RESPONSE"
  | "STREAM_INCOMPLETE"
  | "EXECUTION_FAILED";

export interface N8nSandboxErrorOptions {
  httpStatus?: number;
  execId?: string;
  retryable?: boolean;
  sideEffectPossible?: boolean;
  /** A stable, token-shaped code from the service (e.g. `no_capacity`). */
  reason?: string;
  /** True when a 409 says the sandbox came back after a guest crash. */
  sandboxRestarted?: boolean;
}

export class N8nSandboxError extends Error {
  override readonly name = "N8nSandboxError";
  readonly code: N8nSandboxErrorCode;
  readonly httpStatus?: number;
  /** An execution whose outcome may still be discoverable by this id. */
  readonly execId?: string;
  /** Whether repeating the SAME request unchanged is safe. */
  readonly retryable: boolean;
  /** Whether the request may have taken effect despite the error. */
  readonly sideEffectPossible: boolean;
  /**
   * The service's stable machine-readable reason, when it supplied one that
   * passed validation. Never prose, a URL or a credential: only the token
   * shape the 1.15.0 contract documents (`no_capacity`, `sandbox_restarted`,
   * `tenant_request_limit`, ...).
   */
  readonly reason?: string;
  /**
   * A 409 caused by a guest crash and recovery, not by any other conflict.
   * The sandbox is running again but its in-memory state is gone.
   */
  readonly sandboxRestarted: boolean;

  constructor(code: N8nSandboxErrorCode, message: string, options: N8nSandboxErrorOptions = {}) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.sideEffectPossible = options.sideEffectPossible ?? false;
    this.sandboxRestarted = options.sandboxRestarted === true;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.execId !== undefined) this.execId = options.execId;
    if (options.reason !== undefined) this.reason = options.reason;
  }

  /** Never includes the API key: the message was redacted when it was built. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      sideEffectPossible: this.sideEffectPossible,
      sandboxRestarted: this.sandboxRestarted,
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
      ...(this.execId !== undefined ? { execId: this.execId } : {}),
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
    };
  }
}

export type N8nSandboxResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: N8nSandboxError };

/** Strips credential material from anything the service said. */
export function redactSandboxText(message: string): string {
  return message
    .replace(/bearer\s+[^\s,]+/gi, "Bearer [REDACTED]")
    .replace(
      /(x-api-key|x_api_key|apiKey|api_key|authorization)["'\s:=]+[^\s,"'}]+/gi,
      "$1: [REDACTED]"
    )
    // Credentials embedded in a URL, e.g. https://user:pass@host/...
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function truncateForError(value: string, max = 500): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

function providerMessage(body: unknown): string | null {
  if (typeof body === "string" && body.trim().length > 0) {
    return truncateForError(body.trim());
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  // The documented error body is `{error, code}`; a runner 409 uses
  // `{error, reason}` instead. Only the prose fields are read as a message:
  // `reason` is a stable code, and is kept separately (see `providerReason`).
  for (const key of ["error", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return truncateForError(value.trim());
    }
  }
  return null;
}

/**
 * The stable machine-readable code a 429 or 409 carries in `reason`.
 *
 * Only the token shape the 1.15.0 contract documents is accepted. Anything
 * else — prose, a path, a URL, a credential — is dropped rather than carried
 * into an error, a log or a response.
 */
const PROVIDER_REASON_PATTERN = /^[a-z0-9_]{1,64}$/;

export function providerReason(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).reason;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return PROVIDER_REASON_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** True for a 409 that says the sandbox restarted after a guest crash. */
export function reportsSandboxRestart(body: unknown): boolean {
  return providerReason(body) === "sandbox_restarted";
}

/** A stable sentence for a status, used when the body carries no usable text. */
function defaultMessage(status: number): string {
  if (status === 400) return "The sandbox service rejected the request";
  if (status === 401) return "The sandbox service rejected the API key";
  if (status === 403) return "The sandbox operation is not permitted";
  if (status === 404) return "The sandbox or execution was not found";
  if (status === 409) return "The sandbox state conflicts with the request";
  if (status === 410) return "The execution history is no longer retained";
  if (status === 429) return "The sandbox service is busy; retry later";
  if (status === 502) return "The sandbox service could not reach a usable sandbox";
  if (status === 503) return "The sandbox service is temporarily unavailable";
  return "The sandbox service returned an error";
}

function codeForStatus(status: number): N8nSandboxErrorCode {
  if (status === 400 || status === 422) return "INVALID_REQUEST";
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 410) return "GONE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 502) return "BAD_GATEWAY";
  if (status === 503) return "UNAVAILABLE";
  if (status >= 500) return "SERVICE_ERROR";
  return "INVALID_REQUEST";
}

/**
 * Turns an HTTP failure into a typed error.
 *
 * `sanitize` is supplied by the client and removes the exact API key from any
 * provider text, in addition to the generic patterns above. A service that
 * echoed the key in a body cannot leak it through this path.
 *
 * `sideEffectPossible` says whether THIS request type could take effect at all.
 * `sideEffectForStatus` narrows that per status; the default admits the 5xx and
 * gateway-timeout statuses that may have reached a runner. `POST /sandboxes`
 * overrides it, because 502 and 503 are documented as having created nothing.
 */
export function classifySandboxHttpError(
  status: number,
  body: unknown,
  options: {
    sanitize?: (value: string) => string;
    sideEffectPossible?: boolean;
    sideEffectForStatus?: (status: number) => boolean;
    /** True when the response carried `X-Sandbox-Restarted: 1`. */
    sandboxRestarted?: boolean;
  } = {}
): N8nSandboxError {
  const safe = options.sanitize ?? redactSandboxText;
  const detail = providerMessage(body);
  const message = safe(detail ? `${defaultMessage(status)}: ${detail}` : defaultMessage(status));
  const bodyReason = providerReason(body);
  const restarted = options.sandboxRestarted === true || bodyReason === "sandbox_restarted";
  // The 1.15.0 contract says either signal identifies a restart. When only the
  // header survived a proxy hop, still give callers the structured token rather
  // than making them parse a sentence.
  const reason = bodyReason ?? (restarted ? "sandbox_restarted" : undefined);
  const possibleForStatus = options.sideEffectForStatus ?? defaultSideEffectForStatus;

  return new N8nSandboxError(codeForStatus(status), message, {
    httpStatus: status,
    // 503 is a transient refusal. The 409 restart is retried once, on purpose:
    // it is never repeated silently, so it is not marked retryable.
    retryable: status === 429 || status === 503,
    // 401/403/404/409/410/429 are refusals: nothing ran. A 5xx or gateway
    // timeout may have reached a runner, so the caller supplies that fact.
    sideEffectPossible: options.sideEffectPossible === true && possibleForStatus(status),
    ...(reason !== undefined ? { reason } : {}),
    sandboxRestarted: restarted,
  });
}

function defaultSideEffectForStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 504;
}

/** Classifies a transport-level failure (DNS, refused, reset, abort). */
export function classifySandboxTransportError(
  err: unknown,
  options: {
    signal?: AbortSignal;
    timedOut?: boolean;
    sideEffectPossible?: boolean;
    execId?: string;
    sanitize?: (value: string) => string;
  } = {}
): N8nSandboxError {
  const safe = options.sanitize ?? redactSandboxText;
  const raw = err instanceof Error ? err.message : "sandbox request failed";
  const name = err instanceof Error ? err.name : "";
  const isAbort = name === "AbortError" || /abort/i.test(raw);

  if (options.signal?.aborted || (isAbort && !options.timedOut)) {
    return new N8nSandboxError("ABORTED", "The sandbox request was cancelled", {
      sideEffectPossible: options.sideEffectPossible === true,
      ...(options.execId !== undefined ? { execId: options.execId } : {}),
    });
  }

  if (options.timedOut || isAbort) {
    return new N8nSandboxError("TOOL_TIMEOUT", "The sandbox request timed out", {
      sideEffectPossible: options.sideEffectPossible === true,
      ...(options.execId !== undefined ? { execId: options.execId } : {}),
    });
  }

  return new N8nSandboxError(
    "NETWORK_ERROR",
    safe(`The sandbox request failed: ${raw}`),
    {
      sideEffectPossible: options.sideEffectPossible === true,
      ...(options.execId !== undefined ? { execId: options.execId } : {}),
    }
  );
}

export function malformedSandboxResponseError(): N8nSandboxError {
  return new N8nSandboxError(
    "MALFORMED_RESPONSE",
    "The sandbox service returned an unexpected response"
  );
}

/**
 * A stream that ended without `exit` or `error`.
 *
 * A POST execution may still be running, so its outcome is uncertain. A resume
 * or a status read changed nothing, so it passes `false`.
 */
export function incompleteSandboxStreamError(
  execId?: string,
  sideEffectPossible = true
): N8nSandboxError {
  return new N8nSandboxError(
    "STREAM_INCOMPLETE",
    "The execution stream ended without an exit or error event",
    { sideEffectPossible, ...(execId !== undefined ? { execId } : {}) }
  );
}
