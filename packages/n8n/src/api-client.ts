import type { N8nConfig } from "./config.js";
import {
  classifyN8nError,
  classifyTransportError,
  type ClassifiedN8nError,
} from "./error-handler.js";

// ---------------------------------------------------------------------------
// n8n Public REST API client (read-only)
// ---------------------------------------------------------------------------
// The webhook client in `client.ts` triggers a workflow and receives its result
// by callback. This module is the OTHER n8n surface: the Public REST API that
// answers questions ABOUT the instance — is the key accepted, which workflows
// exist, how an execution ended. It is deliberately READ-ONLY.
//
// Three properties, all of them deliberate:
//
//  1. THE KEY TRAVELS IN A HEADER, NEVER A URL. n8n's access logs and any proxy
//     between here and there record the request line; a key in a query string
//     would be archived there. `X-N8N-API-KEY` is the header n8n documents.
//
//  2. THE URL IS BUILT FROM SERVER CONFIG ONLY. Every path is a literal this
//     module chooses (`/api/v1/workflows`, `/api/v1/executions`); no caller
//     value can name a host, a scheme or a path. A self-hosted n8n usually sits
//     beside JARVIS, so a caller-influenced URL would be an SSRF primitive.
//
//  3. A READ NEVER REPORTS A POSSIBLE SIDE EFFECT. A listing that times out may
//     have reached n8n, but a GET cannot change anything there, so the error is
//     marked `sideEffectPossible: false` and a caller may safely retry. The
//     trigger path makes the opposite claim because a POST can start a run.
//
// Errors are VALUES, not throws: `{ ok: false, error }`. That keeps the call
// sites honest — a caller that wants to distinguish "rejected the key" from
// "temporarily unreachable" must read the classification, and cannot swallow it
// with a blanket try/catch. Every message is redacted before it is returned.
// ---------------------------------------------------------------------------

/** n8n's documented maximum for `limit` on a listing request. */
export const N8N_MAX_PAGE_SIZE = 250;

/** Hard ceiling on how many pages a traversal will follow before stopping. */
export const N8N_MAX_LIST_PAGES = 20;

/** A read that succeeded, or a classified, credential-free failure. */
export type N8nApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ClassifiedN8nError };

/** Only the fields JARVIS exposes; the rest of n8n's payload is dropped. */
export interface N8nRemoteWorkflow {
  id: string;
  name: string;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface N8nWorkflowPage {
  workflows: N8nRemoteWorkflow[];
  nextCursor: string | null;
}

export interface N8nRemoteExecution {
  id: string;
  workflowId: string | null;
  status: string | null;
  finished: boolean | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

export interface N8nExecutionPage {
  executions: N8nRemoteExecution[];
  nextCursor: string | null;
}

export interface N8nListWorkflowsParams {
  limit?: number;
  cursor?: string;
}

export interface N8nListExecutionsParams {
  limit?: number;
  cursor?: string;
  workflowId?: string;
  status?: string;
}

export interface N8nListAllWorkflowsOptions {
  /** Page size per request. Clamped to 1..250. */
  pageSize?: number;
  /** Safety ceiling on pages followed. Clamped to 1..N8N_MAX_LIST_PAGES. */
  maxPages?: number;
}

export interface N8nWorkflowTraversal {
  workflows: N8nRemoteWorkflow[];
  /** True when the page ceiling was reached before the cursor ran out. */
  truncated: boolean;
}

export interface N8nApiClient {
  /** Lists one page of workflows. */
  listWorkflows(params?: N8nListWorkflowsParams): Promise<N8nApiResult<N8nWorkflowPage>>;
  /** Follows `nextCursor` up to a bounded number of pages. */
  listAllWorkflows(options?: N8nListAllWorkflowsOptions): Promise<N8nApiResult<N8nWorkflowTraversal>>;
  /** Lists one page of executions, for status monitoring. */
  listExecutions(params?: N8nListExecutionsParams): Promise<N8nApiResult<N8nExecutionPage>>;
  /** Reads one execution's status by its n8n id. */
  getExecution(id: string): Promise<N8nApiResult<N8nRemoteExecution>>;
  /**
   * The cheapest authenticated read: one workflow. Success proves the base URL
   * resolves AND the key is accepted; nothing is written.
   */
  checkConnection(): Promise<N8nApiResult<{ workflowCount: number }>>;
}

/** A response shape we did not expect — never the body, which may hold data. */
function malformedResponseError(): ClassifiedN8nError {
  return {
    code: "INVALID_REQUEST",
    retryable: false,
    sideEffectPossible: false,
    message: "n8n returned an unexpected response shape",
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return N8N_MAX_PAGE_SIZE;
  const whole = Math.trunc(raw);
  if (whole < 1) return 1;
  if (whole > N8N_MAX_PAGE_SIZE) return N8N_MAX_PAGE_SIZE;
  return whole;
}

function clampPages(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return N8N_MAX_LIST_PAGES;
  const whole = Math.trunc(raw);
  if (whole < 1) return 1;
  if (whole > N8N_MAX_LIST_PAGES) return N8N_MAX_LIST_PAGES;
  return whole;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Builds an absolute API URL confined to the configured origin.
 *
 * `resource` is a literal chosen by the code below, never a caller value. The
 * query is assembled with URLSearchParams, so a cursor or id cannot inject an
 * authority marker or a second parameter.
 */
function buildApiUrl(
  config: N8nConfig,
  resource: "workflows" | "executions",
  query: Record<string, string | undefined>,
  id?: string
): string {
  const base = config.baseUrl.replace(/\/+$/, "");
  const baseOrigin = new URL(base).origin;
  // `resource` is a literal; a validated id is the only variable segment, and
  // it is percent-encoded so it cannot inject a path or an authority marker.
  const segment = id ? `/${encodeURIComponent(id)}` : "";
  const url = new URL(`${base}/api/v1/${resource}${segment}`);
  if (url.origin !== baseOrigin) {
    throw new Error("Resolved n8n API URL escaped the configured base URL");
  }
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value.length > 0) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** One GET against the Public API. Resolves with whatever n8n answered. */
async function getJson(
  config: N8nConfig,
  url: string
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        // Header form only — a key in the URL would be archived in access logs.
        "X-N8N-API-KEY": config.apiKey,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // Keep the raw text so the classifier can produce a redacted message.
        body = text;
      }
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeWorkflows(body: unknown): N8nWorkflowPage | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.data)) return null;

  const workflows: N8nRemoteWorkflow[] = [];
  for (const item of raw.data.slice(0, N8N_MAX_PAGE_SIZE)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = nonEmptyString(row.id);
    // A row with no id cannot be addressed, so it is dropped rather than
    // surfaced as an unusable entry.
    if (!id) continue;
    workflows.push({
      id,
      name: typeof row.name === "string" ? row.name : "",
      active: row.active === true,
      createdAt: nonEmptyString(row.createdAt),
      updatedAt: nonEmptyString(row.updatedAt),
    });
  }
  return { workflows, nextCursor: nonEmptyString(raw.nextCursor) };
}

function normalizeExecutionRow(item: unknown): N8nRemoteExecution | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const id = nonEmptyString(row.id);
  if (!id) return null;
  return {
    id,
    workflowId: nonEmptyString(row.workflowId),
    status: nonEmptyString(row.status),
    finished: typeof row.finished === "boolean" ? row.finished : null,
    startedAt: nonEmptyString(row.startedAt),
    stoppedAt: nonEmptyString(row.stoppedAt),
  };
}

function normalizeExecutions(body: unknown): N8nExecutionPage | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.data)) return null;

  const executions: N8nRemoteExecution[] = [];
  for (const item of raw.data.slice(0, N8N_MAX_PAGE_SIZE)) {
    const execution = normalizeExecutionRow(item);
    if (execution) executions.push(execution);
  }
  return { executions, nextCursor: nonEmptyString(raw.nextCursor) };
}

/** Turns a resolved HTTP response into a typed, error-as-value result. */
function interpret<T>(
  status: number,
  body: unknown,
  normalize: (body: unknown) => T | null
): N8nApiResult<T> {
  if (status < 200 || status >= 300) {
    return { ok: false, error: classifyN8nError(status, body) };
  }
  const data = normalize(body);
  if (data === null) return { ok: false, error: malformedResponseError() };
  return { ok: true, data };
}

/** A request we refuse before sending it — a bad id, nothing more. */
function invalidRequestError(message: string): ClassifiedN8nError {
  return { code: "INVALID_REQUEST", retryable: false, sideEffectPossible: false, message };
}

export function createN8nApiClient(config: N8nConfig): N8nApiClient {
  async function read<T>(
    resource: "workflows" | "executions",
    query: Record<string, string | undefined>,
    normalize: (body: unknown) => T | null,
    id?: string
  ): Promise<N8nApiResult<T>> {
    try {
      const { status, body } = await getJson(config, buildApiUrl(config, resource, query, id));
      return interpret(status, body, normalize);
    } catch (err) {
      // A GET cannot change state in n8n, so a transmitted-but-failed read is
      // never "possibly applied" — the caller may retry it.
      return { ok: false, error: classifyTransportError(err, false) };
    }
  }

  function listWorkflows(params: N8nListWorkflowsParams = {}) {
    const limit = clampLimit(params.limit);
    return read("workflows", { limit: String(limit), cursor: params.cursor }, normalizeWorkflows);
  }

  return {
    listWorkflows,

    async listAllWorkflows(options = {}) {
      const pageSize = clampLimit(options.pageSize ?? N8N_MAX_PAGE_SIZE);
      const maxPages = clampPages(options.maxPages);

      const collected: N8nRemoteWorkflow[] = [];
      let cursor: string | undefined;
      let truncated = false;

      for (let page = 0; page < maxPages; page += 1) {
        const result = await read(
          "workflows",
          { limit: String(pageSize), cursor },
          normalizeWorkflows
        );
        if (!result.ok) return result;

        collected.push(...result.data.workflows);
        if (!result.data.nextCursor) {
          return { ok: true, data: { workflows: collected, truncated: false } };
        }
        // A cursor that repeats would loop forever; treat it as the end.
        if (result.data.nextCursor === cursor) {
          return { ok: true, data: { workflows: collected, truncated: true } };
        }
        cursor = result.data.nextCursor;
        truncated = true;
      }

      return { ok: true, data: { workflows: collected, truncated } };
    },

    listExecutions(params = {}) {
      const limit = clampLimit(params.limit);
      return read(
        "executions",
        {
          limit: String(limit),
          cursor: params.cursor,
          workflowId: params.workflowId,
          status: params.status,
        },
        normalizeExecutions
      );
    },

    getExecution(id) {
      const safeId = typeof id === "string" ? id.trim() : "";
      // Conservative charset, and no scheme, slash or dot-dot can survive it.
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(safeId) || safeId.includes("..")) {
        return Promise.resolve({ ok: false as const, error: invalidRequestError("Invalid execution id") });
      }
      return read("executions", {}, normalizeExecutionRow, safeId);
    },

    checkConnection() {
      // One workflow is enough to prove the origin AND the key. A 200 with an
      // empty instance is still CONNECTED; the count is informational.
      return listWorkflows({ limit: 1 }).then((result) =>
        result.ok
          ? { ok: true as const, data: { workflowCount: result.data.workflows.length } }
          : result
      );
    },
  };
}
