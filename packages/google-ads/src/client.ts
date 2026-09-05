import { buildAdsBaseUrl, type GoogleConfig } from "./config.js";
import { classifyGoogleError, type ClassifiedGoogleError } from "./error-handler.js";

// ---------------------------------------------------------------------------
// Google Ads HTTP transport (Sprint 5.2)
// ---------------------------------------------------------------------------
// Mirrors packages/meta-graph/src/client.ts, including its abort semantics.
// One difference matters: Meta puts the token in the query string, Google puts
// it in an Authorization header. The header form is preferable — query strings
// end up in access logs and referrers — and it means a URL captured anywhere
// carries no credential.
//
// Sprint 5.2 is read-only, so every request here is a POST to searchStream
// (Google Ads has no GET query endpoint) but NONE of them mutate. That makes
// abort handling simpler than Meta's: no request can leave a partial write.
// ---------------------------------------------------------------------------

export type GoogleAbortPhase = "before-send" | "in-flight";

export class GoogleRequestAbortedError extends Error {
  override readonly name = "GoogleRequestAbortedError";
  readonly phase: GoogleAbortPhase;
  /**
   * Always false in Sprint 5.2: the provider exposes no mutating operation, so
   * a cancelled request cannot have changed remote state. Kept explicit so a
   * future write path has to set it deliberately.
   */
  readonly sideEffectPossible = false;

  constructor(phase: GoogleAbortPhase) {
    super(
      phase === "before-send"
        ? "Google Ads request aborted before transmission"
        : "Google Ads request aborted in flight"
    );
    this.phase = phase;
  }
}

export interface GoogleHttpResponse {
  status: number;
  body: unknown;
}

export interface GoogleSearchRequest {
  customerId: string;
  query: string;
  accessToken: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GoogleAdsHttpClient {
  search(req: GoogleSearchRequest): Promise<GoogleHttpResponse>;
}

export function createGoogleAdsHttpClient(config: GoogleConfig): GoogleAdsHttpClient {
  const baseUrl = buildAdsBaseUrl(config);

  return {
    async search(req: GoogleSearchRequest): Promise<GoogleHttpResponse> {
      const url = `${baseUrl}/customers/${req.customerId}/googleAds:search`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? config.timeoutMs);
      const combinedSignal =
        req.signal !== undefined
          ? AbortSignal.any([controller.signal, req.signal])
          : controller.signal;

      let transmitted = false;
      const abortError = () =>
        new GoogleRequestAbortedError(transmitted ? "in-flight" : "before-send");

      try {
        if (combinedSignal.aborted) throw abortError();

        const headers: Record<string, string> = {
          Authorization: `Bearer ${req.accessToken}`,
          "developer-token": config.developerToken,
          "Content-Type": "application/json",
        };
        // Required when the target customer is reached through a manager
        // account; Google rejects the call without it in that topology.
        if (config.loginCustomerId) {
          headers["login-customer-id"] = config.loginCustomerId;
        }

        transmitted = true;
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ query: req.query }),
          signal: combinedSignal,
        });

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

export function isSuccessResponse(resp: GoogleHttpResponse): boolean {
  if (resp.status < 200 || resp.status >= 300) return false;
  if (resp.body && typeof resp.body === "object" && "error" in resp.body) return false;
  return true;
}

export function extractError(resp: GoogleHttpResponse): ClassifiedGoogleError {
  return classifyGoogleError(resp.status, resp.body);
}
