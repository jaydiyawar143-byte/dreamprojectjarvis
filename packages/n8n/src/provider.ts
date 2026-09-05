import type { N8nTriggerResult } from "@jarvis/core";
import {
  createN8nHttpClient,
  isSuccessResponse,
  extractError,
  N8nRequestError,
  type N8nHttpClient,
} from "./client.js";
import { truncateSummary, type N8nConfig } from "./config.js";

// ---------------------------------------------------------------------------
// N8nCloudProvider (Sprint 5.4)
// ---------------------------------------------------------------------------
// The ONLY boundary to the n8n service, following the contract stated in
// packages/tools/src/tools/meta-ads-provider.ts: implementations must NEVER
// expose credentials to their callers.
//
// The provider takes a WEBHOOK PATH, not a URL. The path is resolved against
// the server-configured base URL inside the client, so no caller — tool, route
// or agent — can aim a trigger at an arbitrary host. Combined with the
// allow-list in N8nWorkflow, a caller cannot reach a workflow it does not own
// nor an endpoint outside the configured n8n instance.
//
// Nothing here decides WHETHER a trigger is permitted. Authorization and human
// approval live in the tool layer above, so this provider is pure transport and
// cannot be used to bypass the approval boundary.
// ---------------------------------------------------------------------------

export interface N8nProviderCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface N8nProvider {
  triggerWorkflow(
    webhookPath: string,
    payload: Record<string, unknown>,
    correlation: { executionId: string; traceId: string },
    options?: N8nProviderCallOptions
  ): Promise<N8nTriggerResult>;
}

export interface N8nCloudProviderConfig {
  config: N8nConfig;
  httpClient?: N8nHttpClient;
}

/** Reads n8n's execution id from any of the shapes it uses. */
function extractRemoteExecutionId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const key of ["executionId", "execution_id", "id"]) {
    const value = b[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

export class N8nCloudProvider implements N8nProvider {
  // Only the client is retained: it owns the config, including the base URL and
  // API key, so the provider itself never holds credential material.
  private readonly http: N8nHttpClient;

  constructor(opts: N8nCloudProviderConfig) {
    this.http = opts.httpClient ?? createN8nHttpClient(opts.config);
  }

  async triggerWorkflow(
    webhookPath: string,
    payload: Record<string, unknown>,
    correlation: { executionId: string; traceId: string },
    options?: N8nProviderCallOptions
  ): Promise<N8nTriggerResult> {
    const response = await this.http.trigger({
      webhookPath,
      // The correlation ids travel in the BODY as well as headers so a workflow
      // author can read them from either place when building the callback.
      payload: {
        ...payload,
        jarvisExecutionId: correlation.executionId,
        jarvisTraceId: correlation.traceId,
      },
      headers: {
        "X-Jarvis-Execution-Id": correlation.executionId,
        "X-Jarvis-Trace-Id": correlation.traceId,
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });

    if (!isSuccessResponse(response)) {
      throw new N8nRequestError(extractError(response));
    }

    return {
      remoteExecutionId: extractRemoteExecutionId(response.body),
      // Bounded before it can reach the database or a log.
      responseSummary: truncateSummary(response.body),
    };
  }
}

export function createN8nProvider(opts: N8nCloudProviderConfig): N8nCloudProvider {
  return new N8nCloudProvider(opts);
}
