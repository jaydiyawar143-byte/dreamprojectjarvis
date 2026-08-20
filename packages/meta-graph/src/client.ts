import type { MetaConfig } from "./config.js";
import { buildBaseUrl } from "./config.js";
import { classifyMetaError, type ClassifiedMetaError } from "./error-handler.js";

export interface MetaHttpResponse {
  status: number;
  body: unknown;
}

export interface MetaHttpRequest {
  method: "GET" | "POST";
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface MetaHttpClient {
  request(req: MetaHttpRequest): Promise<MetaHttpResponse>;
}

export function createMetaHttpClient(config: MetaConfig): MetaHttpClient {
  const baseUrl = buildBaseUrl(config);
  const timeoutMs = config.timeoutMs;

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
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? timeoutMs);

      try {
        const fetchInit: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
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
        if (err instanceof Error && err.name === "AbortError") {
          return { status: 408, body: { error: { message: "Request timed out", type: "timeout", code: 408 } } };
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
