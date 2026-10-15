import type { N8nTriggerResult } from "@jarvis/core";
import {
  createN8nHttpClient,
  isSuccessResponse,
  extractError,
  N8nRequestError,
  type N8nHttpClient,
} from "./client.js";
import {
  createN8nApiClient,
  type N8nApiClient,
  type N8nApiResult,
  type N8nExecutionPage,
  type N8nListAllWorkflowsOptions,
  type N8nListExecutionsParams,
  type N8nListWorkflowsParams,
  type N8nRemoteExecution,
  type N8nWorkflowPage,
  type N8nWorkflowTraversal,
} from "./api-client.js";
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

/**
 * The READ-ONLY management surface of the same n8n instance the trigger uses:
 * is the key accepted, which workflows exist, how an execution ended.
 *
 * It is a separate interface from `N8nProvider` on purpose. A caller that only
 * needs to start a workflow is handed the trigger port and nothing else; the
 * broader surface is opt-in. Every method returns errors as values, and none of
 * them writes to n8n.
 */
export interface N8nApiProvider {
  /** One authenticated read that proves the origin and the key. */
  checkConnection(): Promise<N8nApiResult<{ workflowCount: number }>>;
  /** One page of workflows, with n8n's `nextCursor` when there is more. */
  listWorkflows(params?: N8nListWorkflowsParams): Promise<N8nApiResult<N8nWorkflowPage>>;
  /** Follows `nextCursor` for a bounded number of pages. */
  listAllWorkflows(options?: N8nListAllWorkflowsOptions): Promise<N8nApiResult<N8nWorkflowTraversal>>;
  /** One page of executions, for status monitoring. */
  listExecutions(params?: N8nListExecutionsParams): Promise<N8nApiResult<N8nExecutionPage>>;
  /** Reads one execution's status by its n8n id. */
  getExecution(id: string): Promise<N8nApiResult<N8nRemoteExecution>>;
}

export interface N8nCloudProviderConfig {
  config: N8nConfig;
  httpClient?: N8nHttpClient;
  apiClient?: N8nApiClient;
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

export class N8nCloudProvider implements N8nProvider, N8nApiProvider {
  // Only the clients are retained: they own the config, including the base URL
  // and API key, so the provider itself never holds credential material.
  private readonly http: N8nHttpClient;
  private readonly api: N8nApiClient;

  constructor(opts: N8nCloudProviderConfig) {
    this.http = opts.httpClient ?? createN8nHttpClient(opts.config);
    this.api = opts.apiClient ?? createN8nApiClient(opts.config);
  }

  // --- Read-only management surface (never writes to n8n) -------------------

  checkConnection(): Promise<N8nApiResult<{ workflowCount: number }>> {
    return this.api.checkConnection();
  }

  listWorkflows(params?: N8nListWorkflowsParams): Promise<N8nApiResult<N8nWorkflowPage>> {
    return this.api.listWorkflows(params);
  }

  listAllWorkflows(
    options?: N8nListAllWorkflowsOptions
  ): Promise<N8nApiResult<N8nWorkflowTraversal>> {
    return this.api.listAllWorkflows(options);
  }

  listExecutions(
    params?: N8nListExecutionsParams
  ): Promise<N8nApiResult<N8nExecutionPage>> {
    return this.api.listExecutions(params);
  }

  getExecution(id: string): Promise<N8nApiResult<N8nRemoteExecution>> {
    return this.api.getExecution(id);
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
