// ---------------------------------------------------------------------------
// The write path to Google — Phase 13.
//
// DELIBERATELY A SEPARATE MODULE FROM `http.ts`.
//
// `callGoogle` issues GETs and nothing else, and its header says that is the
// point: a module that cannot express a POST cannot be the place a write
// accidentally appears. That guarantee is worth keeping, so writes get their
// own file rather than a `method` parameter on the read path. The consequence
// is that every mutating call in this package is reachable only through this
// module, and `grep callGoogleWrite` enumerates the entire write surface.
//
// WHAT IT ADDS OVER THE READ PATH.
//
//   IDEMPOTENCY IS THE CALLER'S JOB, NOT A HEADER. Google's APIs do not honour
//   an Idempotency-Key header, so this module cannot make a retry safe on its
//   own. It exposes the outcome honestly instead: a timeout or an abort returns
//   `indeterminate: true`, because an aborted POST may well have been applied.
//   The caller (the execution journal) is what turns that into "do not retry".
//
//   A 409/412 IS NOT A FAILURE TO RETRY. Google answers 409 for "already
//   exists", which for a create is frequently the SECOND attempt of a retried
//   call succeeding-in-effect. It is classified separately so the caller can
//   treat it as a duplicate rather than an error.
//
// EVERYTHING ELSE IS INHERITED DELIBERATELY: the same timeout discipline, the
// same 401-is-needs_reauth classification, the same URL stripping, and the same
// rule that no token appears in any return value or log line.
// ---------------------------------------------------------------------------

import type { GoogleTaskStatus } from "@jarvis/core";

/** Writes get a longer ceiling than reads: an upload is not a metadata fetch. */
export const DEFAULT_WRITE_TIMEOUT_MS = 30_000;

/** The only methods this package may use to mutate. No PUT-as-delete games. */
export type WriteMethod = "POST" | "PATCH" | "PUT" | "DELETE";

export interface GoogleWriteOptions {
  accessToken: string;
  url: string;
  method: WriteMethod;
  /** JSON body. Omitted for DELETE and for query-only calls. */
  body?: unknown;
  /** Raw body for multipart uploads, with its own content type. */
  rawBody?: { contentType: string; payload: string | Uint8Array };
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export type GoogleWriteOutcome<T> =
  | { ok: true; body: T; duplicate?: false }
  /**
   * Google says the thing already exists.
   *
   * Reported distinctly because for a retried create this is very often the
   * first attempt having succeeded after all — treating it as a hard failure
   * makes a safe retry look broken.
   */
  | { ok: false; duplicate: true; status: "provider_error"; message: string }
  | {
      ok: false;
      duplicate?: false;
      status: Exclude<GoogleTaskStatus, "ok">;
      message: string;
      requiredAction?: string;
      /**
       * True when the call may or may not have been applied — a timeout, an
       * abort, or a 5xx after the request was sent.
       *
       * THIS IS THE MOST IMPORTANT FIELD IN THE FILE. An aborted POST is not a
       * POST that did not happen, and a caller that retries on it will send the
       * email twice. The execution journal reads this to decide FAILED (safe to
       * retry) versus UNKNOWN (never retry automatically).
       */
      indeterminate?: boolean;
    };

/** Strips anything identifying from a provider message before display. */
function sanitize(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  return raw.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200).trim();
}

/**
 * Performs one authenticated mutating call against Google.
 *
 * Returns rather than throws, for the same reason the read path does: the
 * caller must be able to distinguish "not connected" from "failed" from
 * "possibly applied", and an exception collapses all three.
 */
export async function callGoogleWrite<T>(
  options: GoogleWriteOptions
): Promise<GoogleWriteOutcome<T>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
    Accept: "application/json",
  };

  let payload: string | Uint8Array | undefined;
  if (options.rawBody) {
    headers["Content-Type"] = options.rawBody.contentType;
    payload = options.rawBody.payload;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(options.body);
  }

  try {
    const response = await fetchImpl(options.url, {
      method: options.method,
      headers,
      // Cast through `never` rather than `BodyInit`: this package targets Node
      // without DOM lib types, where `BodyInit` is not declared, and a string
      // or Uint8Array is a valid fetch body at runtime regardless.
      ...(payload !== undefined ? { body: payload as never } : {}),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }

    if (response.ok) return { ok: true, body: parsed as T };

    return classifyWriteFailure<T>(response.status, parsed);
  } catch (error) {
    const aborted = (error as { name?: string })?.name === "AbortError";
    return {
      ok: false,
      status: "provider_error",
      message: aborted
        ? `Google did not respond within ${Math.round(timeoutMs / 1000)}s. The change may or may not have been applied.`
        : "Google could not be reached. The change may or may not have been applied.",
      // The request left this process. Whether Google applied it is unknown,
      // and an automatic retry could duplicate it.
      indeterminate: true,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

function classifyWriteFailure<T>(httpStatus: number, body: unknown): GoogleWriteOutcome<T> {
  const error = (body as { error?: { message?: string; errors?: Array<{ reason?: string }> } })
    ?.error;
  const reasons = new Set((error?.errors ?? []).map((e) => e.reason).filter(Boolean));
  const message = sanitize(error?.message, "");

  if (httpStatus === 401) {
    return {
      ok: false,
      status: "needs_reauth",
      message: "Google rejected the stored authorization.",
      requiredAction: "Reconnect your Google account to authorize again.",
    };
  }

  if (httpStatus === 403) {
    if (
      reasons.has("insufficientPermissions") ||
      reasons.has("forbidden") ||
      /insufficient|scope/i.test(message)
    ) {
      return {
        ok: false,
        status: "permission_missing",
        // Named as a WRITE scope: the user may well have granted read and be
        // surprised that this is refused.
        message: "Your Google connection does not grant permission to make this change.",
        requiredAction:
          "Reconnect Google and approve write access for this service, then try again.",
      };
    }
    if (reasons.has("rateLimitExceeded") || reasons.has("userRateLimitExceeded")) {
      return {
        ok: false,
        status: "provider_error",
        message: "Google is rate-limiting this account. Try again shortly.",
      };
    }
    return {
      ok: false,
      status: "permission_missing",
      message: message || "Google refused the change.",
      requiredAction: "Reconnect Google and approve write access for this service.",
    };
  }

  // Already exists. For a retried create this is often the first attempt
  // having succeeded, so it is NOT an ordinary failure.
  if (httpStatus === 409) {
    return {
      ok: false,
      duplicate: true,
      status: "provider_error",
      message: message || "That item already exists at Google.",
    };
  }

  if (httpStatus === 404) {
    return {
      ok: false,
      status: "provider_error",
      message: "The target does not exist, or this account cannot see it.",
    };
  }

  if (httpStatus === 412) {
    // A precondition failed — the target changed under us. Never retried
    // blindly: the plan the user approved described a different state.
    return {
      ok: false,
      status: "provider_error",
      message: "The target changed before the change could be applied. Re-plan and approve again.",
    };
  }

  if (httpStatus === 429) {
    return {
      ok: false,
      status: "provider_error",
      message: "Google is rate-limiting this account. Try again shortly.",
    };
  }

  if (httpStatus >= 500) {
    return {
      ok: false,
      status: "provider_error",
      message: message
        ? `Google returned an error: ${message}`
        : `Google returned HTTP ${httpStatus}.`,
      // A 5xx arrives AFTER the request was processed at least partially.
      indeterminate: true,
    };
  }

  return {
    ok: false,
    status: "provider_error",
    message: message ? `Google rejected the change: ${message}` : `Google returned HTTP ${httpStatus}.`,
  };
}
