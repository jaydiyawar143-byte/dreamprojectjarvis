import type { MetaConfig } from "./config.js";
import { buildBaseUrl } from "./config.js";
import { classifyMetaError, type ClassifiedMetaError } from "./error-handler.js";

export interface MetaHttpResponse {
  status: number;
  body: unknown;
}

// ---------------------------------------------------------------------------
// MetaRequestAbortedError — Phase 10.4 transport-phase abort reporting
// ---------------------------------------------------------------------------
// Thrown when a request is cancelled (caller signal or the client's own
// timeout). Carries WHERE the cancellation happened so the journal layer can
// distinguish KNOWN outcomes from AMBIGUOUS ones:
//
//   phase = "before-send" : the request never left the process — no external
//                           side effect is possible (safe -> FAILED).
//   phase = "in-flight"   : the request had been transmitted; the provider
//                           may have applied the write before the socket was
//                           torn down (ambiguous -> UNKNOWN for writes).
//
// sideEffectPossible is true only for transmitted non-idempotent (POST)
// requests whose outcome the client could not observe. GETs can never cause
// an external side effect, so their cancellation stays deterministic.
//
// Error messages are STATIC strings — they must never embed the request URL,
// query string or any credential material (the Graph URL carries the token).
// ---------------------------------------------------------------------------

export type MetaAbortPhase = "before-send" | "in-flight";

export class MetaRequestAbortedError extends Error {
  override readonly name = "MetaRequestAbortedError";
  readonly phase: MetaAbortPhase;
  readonly sideEffectPossible: boolean;

  constructor(phase: MetaAbortPhase, method: "GET" | "POST") {
    super(
      phase === "before-send"
        ? "Meta request aborted before transmission"
        : `Meta ${method} request aborted in flight; provider outcome uncertain`
    );
    this.phase = phase;
    // Only a transmitted write (POST) can have mutated remote state. A GET
    // is side-effect free; a before-send abort never reached the network.
    this.sideEffectPossible = phase === "in-flight" && method === "POST";
  }
}

export interface MetaHttpRequest {
  method: "GET" | "POST";
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
  /**
   * Caller's cancellation signal (Phase 10.4). Combined with the client's
   * own timeout controller — whichever fires first cancels the fetch.
   */
  signal?: AbortSignal;
}

export interface MetaHttpClient {
  request(req: MetaHttpRequest): Promise<MetaHttpResponse>;
}

/**
 * Authoritative transport timeout: ONE controller per request. The caller's
 * signal (when present) is merged into the same combined signal handed to
 * fetch, so every cancellation path — deadline expiry or upstream abort —
 * cancels the actual socket instead of racing an orphaned request.
 */
export function createMetaHttpClient(config: MetaConfig): MetaHttpClient {
  const baseUrl = buildBaseUrl(config);
  const defaultTimeoutMs = config.timeoutMs;

  return {
    async request(req: MetaHttpRequest): Promise<MetaHttpResponse> {
      const url = new URL(`${baseUrl}/${req.path.replace(/^\/+/, "")}`);

      if (req.params) {
        for (const [key, value] of Object.entries(req.params)) {
          if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
          }
        }
      }

      url.searchParams.set("access_token", config.accessToken);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? defaultTimeoutMs);

      const combinedSignal =
        req.signal !== undefined
          ? AbortSignal.any([controller.signal, req.signal])
          : controller.signal;

      let transmitted = false;

      const abortError = (): MetaRequestAbortedError =>
        new MetaRequestAbortedError(transmitted ? "in-flight" : "before-send", req.method);

      try {
        if (combinedSignal.aborted) throw abortError();

        const fetchInit: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          signal: combinedSignal,
        };

        if (req.body && req.method === "POST") {
          const bodyParams = new URLSearchParams();
          bodyParams.set("access_token", config.accessToken);
          for (const [key, value] of Object.entries(req.body)) {
            if (value !== undefined && value !== null) {
              bodyParams.set(key, String(value));
            }
          }
          fetchInit.body = bodyParams.toString();
          fetchInit.headers = { "Content-Type": "application/x-www-form-urlencoded" };
        }

        transmitted = true;
        const response = await fetch(url.toString(), fetchInit);
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }

        return { status: response.status, body };
      } catch (err) {
        if (combinedSignal.aborted || (err instanceof Error && err.name === "AbortError")) {
          throw abortError();
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function isSuccessResponse(resp: MetaHttpResponse): boolean {
  if (resp.status < 200 || resp.status >= 300) return false;
  if (resp.body && typeof resp.body === "object" && "error" in resp.body) return false;
  return true;
}

export function extractError(resp: MetaHttpResponse): ClassifiedMetaError {
  return classifyMetaError(resp.status, resp.body);
}
