// ---------------------------------------------------------------------------
// One HTTP path to Google, with one error classification.
//
// Every Gmail, Drive and Calendar call goes through `callGoogle`. That is what
// makes the guarantees below true everywhere rather than true in the service
// somebody remembered:
//
//   TIMEOUTS ALWAYS. A hung provider call would otherwise hold a request open
//   until the platform killed it, and the user would see nothing at all rather
//   than "Google did not respond".
//
//   401 IS NOT A PROVIDER ERROR. Google answers 401 for a revoked or expired
//   grant. Classified as `needs_reauth`, because retrying is guaranteed to fail
//   and only re-consent fixes it. 403 with an insufficient-scope reason is
//   `permission_missing` for the same reason.
//
//   THE RAW BODY NEVER ESCAPES. A Google error body can carry the request URL,
//   and a Gmail URL can carry a query — which is user content. Only a
//   classified code and a bounded, sanitized message leave this module.
//
//   NO TOKEN IS EVER LOGGED. The token exists in the Authorization header and
//   nowhere else; it is not part of any thrown value, any return value, or any
//   log line this module produces.
// ---------------------------------------------------------------------------

import type { GoogleTaskStatus } from "@jarvis/core";

/** Default ceiling for a single provider call. */
export const DEFAULT_TIMEOUT_MS = 12_000;

export interface GoogleCallOptions {
  accessToken: string;
  /** Absolute URL. Built by the services from constants, never from user input. */
  url: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export type GoogleCallOutcome<T> =
  | { ok: true; body: T }
  | {
      ok: false;
      status: Exclude<GoogleTaskStatus, "ok">;
      message: string;
      requiredAction?: string;
    };

/**
 * Strips anything identifying from a provider message before it is shown.
 *
 * Google's messages are usually safe ("Invalid Credentials"), but they can echo
 * a request URL, and a Gmail list URL contains the search query — which is the
 * user's own private text. Bounded and URL-stripped rather than trusted.
 */
function sanitizeProviderMessage(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  return raw
    .replace(/https?:\/\/\S+/g, "[url]")
    .slice(0, 200)
    .trim();
}

/**
 * Performs one authenticated GET against Google.
 *
 * GET only, deliberately: this phase is read-only, and a module that cannot
 * express a POST cannot be the place a write accidentally appears.
 */
export async function callGoogle<T>(options: GoogleCallOptions): Promise<GoogleCallOutcome<T>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // A caller-supplied signal (a cancelled chat turn) must also stop the call,
  // without losing the timeout.
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort);

  try {
    const response = await fetchImpl(options.url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }

    if (response.ok) return { ok: true, body: body as T };

    return classifyFailure(response.status, body);
  } catch (error) {
    // An abort is the timeout firing (or the caller cancelling). Reported as a
    // provider error because a retry genuinely might succeed — unlike a 401.
    const aborted = (error as { name?: string })?.name === "AbortError";
    return {
      ok: false,
      status: "provider_error",
      message: aborted
        ? `Google did not respond within ${Math.round(timeoutMs / 1000)}s.`
        : "Google could not be reached.",
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Maps an HTTP status and error body onto the task status union. */
function classifyFailure<T>(httpStatus: number, body: unknown): GoogleCallOutcome<T> {
  const error = (body as { error?: { message?: string; errors?: Array<{ reason?: string }> } })
    ?.error;
  const reasons = new Set((error?.errors ?? []).map((e) => e.reason).filter(Boolean));
  const providerMessage = sanitizeProviderMessage(error?.message, "");

  // 401 — the grant is gone or the token is bad. Never retryable.
  if (httpStatus === 401) {
    return {
      ok: false,
      status: "needs_reauth",
      message: "Google rejected the stored authorization.",
      requiredAction: "Reconnect your Google account to authorize again.",
    };
  }

  if (httpStatus === 403) {
    // 403 is overloaded: it is an unscoped token, a disabled API, or a quota
    // exhaustion. They need different remedies, so they are separated.
    if (
      reasons.has("insufficientPermissions") ||
      reasons.has("forbidden") ||
      /insufficient|scope/i.test(providerMessage)
    ) {
      return {
        ok: false,
        status: "permission_missing",
        message: "Your Google connection does not grant access to this data.",
        requiredAction: "Reconnect Google and include this service to grant read access.",
      };
    }
    if (reasons.has("rateLimitExceeded") || reasons.has("userRateLimitExceeded")) {
      return {
        ok: false,
        status: "provider_error",
        message: "Google is rate-limiting this account. Try again shortly.",
      };
    }
    if (reasons.has("accessNotConfigured") || /has not been used|is disabled/i.test(providerMessage)) {
      return {
        ok: false,
        status: "provider_error",
        message: "This Google API is not enabled for the configured project.",
        requiredAction: "Enable the API in the Google Cloud console for this project.",
      };
    }
    return {
      ok: false,
      status: "permission_missing",
      message: providerMessage || "Google refused the request.",
      requiredAction: "Reconnect Google and grant the required read access.",
    };
  }

  if (httpStatus === 404) {
    return {
      ok: false,
      status: "provider_error",
      message: "That item does not exist, or this account cannot see it.",
    };
  }

  if (httpStatus === 429) {
    return {
      ok: false,
      status: "provider_error",
      message: "Google is rate-limiting this account. Try again shortly.",
    };
  }

  return {
    ok: false,
    status: "provider_error",
    message: providerMessage
      ? `Google returned an error: ${providerMessage}`
      : `Google returned HTTP ${httpStatus}.`,
  };
}

/**
 * Builds a URL from a fixed base and a parameter map.
 *
 * User input reaches Google only as an encoded query PARAMETER — never as part
 * of the path and never as a whole URL — so a caller cannot redirect a call to
 * another host or another endpoint.
 */
export function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
