import { buildBaseUrl, type WhatsAppConfig } from "./config.js";
import { classifyWhatsAppError, type ClassifiedWhatsAppError } from "./error-handler.js";

// ---------------------------------------------------------------------------
// WhatsApp Cloud API transport (Sprint 5.3)
// ---------------------------------------------------------------------------
// Mirrors packages/meta-graph/src/client.ts, with one deliberate difference:
// the access token goes in an Authorization header, not the query string. Meta
// Ads puts it in the URL, which means the token lands in access logs; the Cloud
// API accepts the header form, so a captured URL here carries no credential.
//
// Abort semantics match the Meta client because they matter for the same
// reason: a send is a non-idempotent external side effect, so a cancellation
// AFTER transmission is ambiguous — the message may already have gone out.
// ---------------------------------------------------------------------------

export type WhatsAppAbortPhase = "before-send" | "in-flight";

export class WhatsAppRequestAbortedError extends Error {
  override readonly name = "WhatsAppRequestAbortedError";
  readonly phase: WhatsAppAbortPhase;
  /** True only for a transmitted POST: the message may have been delivered. */
  readonly sideEffectPossible: boolean;

  constructor(phase: WhatsAppAbortPhase, method: "GET" | "POST") {
    // Static strings: a message must never embed the URL or a token.
    super(
      phase === "before-send"
        ? "WhatsApp request aborted before transmission"
        : `WhatsApp ${method} request aborted in flight; delivery outcome uncertain`
    );
    this.phase = phase;
    this.sideEffectPossible = phase === "in-flight" && method === "POST";
  }
}

export interface WhatsAppHttpResponse {
  status: number;
  body: unknown;
}

export interface WhatsAppHttpRequest {
  method: "GET" | "POST";
  /** Path relative to the API version root, e.g. "<phoneNumberId>/messages". */
  path: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WhatsAppHttpClient {
  request(req: WhatsAppHttpRequest): Promise<WhatsAppHttpResponse>;
}

export function createWhatsAppHttpClient(config: WhatsAppConfig): WhatsAppHttpClient {
  const baseUrl = buildBaseUrl(config);

  return {
    async request(req: WhatsAppHttpRequest): Promise<WhatsAppHttpResponse> {
      const url = `${baseUrl}/${req.path.replace(/^\/+/, "")}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? config.timeoutMs);
      const combinedSignal =
        req.signal !== undefined
          ? AbortSignal.any([controller.signal, req.signal])
          : controller.signal;

      let transmitted = false;
      const abortError = () =>
        new WhatsAppRequestAbortedError(transmitted ? "in-flight" : "before-send", req.method);

      try {
        if (combinedSignal.aborted) throw abortError();

        const init: RequestInit = {
          method: req.method,
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
          signal: combinedSignal,
        };
        if (req.body && req.method === "POST") {
          init.body = JSON.stringify(req.body);
        }

        transmitted = true;
        const response = await fetch(url, init);
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

export function isSuccessResponse(resp: WhatsAppHttpResponse): boolean {
  if (resp.status < 200 || resp.status >= 300) return false;
  if (resp.body && typeof resp.body === "object" && "error" in resp.body) return false;
  return true;
}

export function extractError(resp: WhatsAppHttpResponse): ClassifiedWhatsAppError {
  return classifyWhatsAppError(resp.status, resp.body);
}
