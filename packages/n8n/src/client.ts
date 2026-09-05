import { buildWebhookUrl, type N8nConfig } from "./config.js";
import {
  classifyN8nError,
  classifyTransportError,
  type ClassifiedN8nError,
} from "./error-handler.js";

// ---------------------------------------------------------------------------
// n8n HTTP transport (Sprint 5.4)
// ---------------------------------------------------------------------------
// Mirrors packages/meta-graph/src/client.ts and packages/whatsapp/src/client.ts.
//
// The one behaviour worth stating explicitly: this client TRACKS whether the
// request was transmitted. Triggering a workflow is not idempotent, so the
// difference between "never left the process" and "may have started a run"
// decides whether the caller may retry. Everything downstream — the execution
// journal status, the tool result — depends on getting that distinction right.
// ---------------------------------------------------------------------------

export interface N8nHttpResponse {
  status: number;
  body: unknown;
}

export interface N8nTriggerRequest {
  webhookPath: string;
  payload: Record<string, unknown>;
  /** Correlation id echoed into n8n so a workflow can call back correctly. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class N8nRequestError extends Error {
  override readonly name = "N8nRequestError";
  readonly classified: ClassifiedN8nError;

  constructor(classified: ClassifiedN8nError) {
    // Message is already redacted by the classifier.
    super(classified.message);
    this.classified = classified;
  }
}

export interface N8nHttpClient {
  trigger(req: N8nTriggerRequest): Promise<N8nHttpResponse>;
}

export function createN8nHttpClient(config: N8nConfig): N8nHttpClient {
  return {
    async trigger(req: N8nTriggerRequest): Promise<N8nHttpResponse> {
      // Throws before any network activity if the path could escape the host.
      const url = buildWebhookUrl(config, req.webhookPath);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? config.timeoutMs);
      const combinedSignal =
        req.signal !== undefined
          ? AbortSignal.any([controller.signal, req.signal])
          : controller.signal;

      let transmitted = false;

      try {
        if (combinedSignal.aborted) {
          throw new N8nRequestError(classifyTransportError(new Error("aborted"), false));
        }

        transmitted = true;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            // Authenticates JARVIS to n8n. Header form only — never a query
            // string, which would land the key in n8n's access logs.
            "X-N8N-API-KEY": config.apiKey,
            "Content-Type": "application/json",
            ...req.headers,
          },
          body: JSON.stringify(req.payload),
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
        if (err instanceof N8nRequestError) throw err;
        throw new N8nRequestError(classifyTransportError(err, transmitted));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function isSuccessResponse(resp: N8nHttpResponse): boolean {
  return resp.status >= 200 && resp.status < 300;
}

export function extractError(resp: N8nHttpResponse): ClassifiedN8nError {
  return classifyN8nError(resp.status, resp.body);
}
