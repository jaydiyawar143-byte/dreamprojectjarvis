import type { OmniRouteConfig } from "./config.js";

// ---------------------------------------------------------------------------
// OmniRoute connection check
// ---------------------------------------------------------------------------
// ONE READ, plus one probe. Both are `GET /models` on the configured base; the
// list is the cheapest call that proves the gateway is up, speaks the
// OpenAI-compatible API, and accepts the key. Nothing is generated, nothing is
// billed, nothing changes on the gateway.
//
// THE PROBE EXISTS BECAUSE OMNIROUTE DOES NOT REQUIRE A KEY BY DEFAULT. Its
// REQUIRE_API_KEY switch is off on a fresh install, and such a gateway answers
// the model list to anyone. A check that only sent the key would then report
// "key accepted" about a key nobody looked at. So the same request is repeated
// WITHOUT the key: a 401/403 proves the key was really checked; a model list
// proves it was not — and that anyone who can reach the gateway can spend the
// provider accounts behind it.
// ---------------------------------------------------------------------------

/** Anything longer is not a model list this check will read. */
export const OMNIROUTE_MAX_RESPONSE_CHARS = 4 * 1024 * 1024;

export type OmniRouteFailureReason =
  /** 401/403 to the request that carried the key. */
  | "UNAUTHORIZED"
  /** 404 — the base URL does not point at the gateway's API mount. */
  | "NOT_FOUND"
  /** 3xx — reported, never followed, because following would carry the key. */
  | "REDIRECTED"
  /** Any other non-2xx status. */
  | "HTTP_ERROR"
  | "TIMEOUT"
  /** No response at all: refused, reset, unresolvable. */
  | "UNREACHABLE"
  /** A 2xx that is not an OpenAI-compatible model list. */
  | "UNEXPECTED_RESPONSE";

export type OmniRouteCheckResult =
  | {
      ok: true;
      /** Entries with an id in the gateway's model list. */
      modelCount: number;
      /**
       * Whether the gateway refuses the same request without the key.
       *   true   it answered 401/403 — the key was really checked.
       *   false  it answered the list — the key was not checked at all.
       *   null   some other answer, so neither is known.
       */
      keyRequired: boolean | null;
    }
  | { ok: false; reason: OmniRouteFailureReason; httpStatus?: number };

export interface OmniRouteClientOptions {
  /** Test seam. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** The model-list URL. Built from server configuration and a literal only. */
export function omniRouteModelsUrl(config: OmniRouteConfig): string {
  return `${config.baseUrl}/models`;
}

interface Answer {
  status: number;
  text: string;
}

async function get(
  config: OmniRouteConfig,
  withKey: boolean,
  fetchImpl: typeof fetch
): Promise<Answer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(omniRouteModelsUrl(config), {
      method: "GET",
      headers: withKey
        ? // Header form only — a key in the URL would be archived in access logs.
          { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" }
        : { Accept: "application/json" },
      // A redirect is answered, never followed: following it would hand the key
      // to whatever host the gateway — or something in front of it — named.
      redirect: "manual",
      signal: controller.signal,
    });
    const ok = response.status >= 200 && response.status < 300;
    return { status: response.status, text: ok ? await response.text() : "" };
  } finally {
    clearTimeout(timer);
  }
}

/** How many models the list names, or null when it is not an OpenAI-compatible list. */
function countModels(text: string): number | null {
  if (text.length === 0 || text.length > OMNIROUTE_MAX_RESPONSE_CHARS) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data.filter(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" &&
      (item as { id: string }).id.length > 0
  ).length;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** The same request without the key. Never fails the check — at worst it knows nothing. */
async function probeKeyRequired(config: OmniRouteConfig, fetchImpl: typeof fetch): Promise<boolean | null> {
  try {
    const answer = await get(config, false, fetchImpl);
    if (answer.status === 401 || answer.status === 403) return true;
    if (answer.status >= 200 && answer.status < 300 && countModels(answer.text) !== null) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Checks the gateway: reachable, OpenAI-compatible, and accepting the key.
 *
 * Errors are values. Nothing here throws, and no failure carries the gateway's
 * own text — a status and a fixed reason are all a caller gets, so nothing the
 * gateway says can reach a card, an audit row or a log.
 */
export async function checkOmniRouteConnection(
  config: OmniRouteConfig,
  options: OmniRouteClientOptions = {}
): Promise<OmniRouteCheckResult> {
  const fetchImpl = options.fetch ?? fetch;

  let answer: Answer;
  try {
    answer = await get(config, true, fetchImpl);
  } catch (error) {
    return { ok: false, reason: isAbort(error) ? "TIMEOUT" : "UNREACHABLE" };
  }

  const { status } = answer;
  if (status === 401 || status === 403) return { ok: false, reason: "UNAUTHORIZED", httpStatus: status };
  if (status === 404) return { ok: false, reason: "NOT_FOUND", httpStatus: status };
  if (status >= 300 && status < 400) return { ok: false, reason: "REDIRECTED", httpStatus: status };
  if (status < 200 || status >= 300) return { ok: false, reason: "HTTP_ERROR", httpStatus: status };

  const modelCount = countModels(answer.text);
  if (modelCount === null) return { ok: false, reason: "UNEXPECTED_RESPONSE", httpStatus: status };

  return { ok: true, modelCount, keyRequired: await probeKeyRequired(config, fetchImpl) };
}
