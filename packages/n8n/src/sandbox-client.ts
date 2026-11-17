import {
  createN8nSandboxConfig,
  N8N_SANDBOX_EXECUTION_GRACE_MS,
  type N8nSandboxConfig,
} from "./sandbox-config.js";
import {
  N8nSandboxError,
  classifySandboxHttpError,
  classifySandboxTransportError,
  incompleteSandboxStreamError,
  malformedSandboxResponseError,
  redactSandboxText,
  type N8nSandboxErrorOptions,
  type N8nSandboxResult,
} from "./sandbox-error.js";
import {
  createN8nSandboxNdjsonDecoder,
  isTerminalSandboxEvent,
  parseN8nSandboxEvent,
  type N8nSandboxErrorEvent,
  type N8nSandboxEvent,
  type N8nSandboxExitEvent,
} from "./sandbox-ndjson.js";

// ---------------------------------------------------------------------------
// n8n Sandbox Service client
// ---------------------------------------------------------------------------
// The official `n8n-io/n8n-sandbox-service` REST API. Commands run inside a
// sandbox the service owns; this client never starts a process on the JARVIS
// host. It is a THIRD n8n surface, separate from the Public REST client
// (`api-client.ts`) and the MCP connector (`mcp-connector.ts`), and it is
// additive: nothing in those files changes because this one exists.
//
// Four properties, all deliberate:
//
//  1. THE KEY TRAVELS IN A HEADER, NEVER A URL. `X-Api-Key` is the header the
//     service documents. A key in a query string would be archived by any
//     proxy's request log.
//
//  2. THE URL IS SERVER CONFIGURATION. No caller value is ever concatenated
//     into a base URL. Path ids are validated as UUIDs before use, so an id
//     cannot escape its path segment.
//
//  3. AN EXECUTION OUTLIVES ITS STREAM. Disconnecting stops events, not the
//     process. `execute` therefore reads to a terminal event and reports an
//     incomplete stream as a failure, never as an empty success. A caller
//     abort or a client deadline asks the service to kill the process; an
//     incomplete stream does not, so the caller can resume it.
//
//  4. NOTHING SECRET IS RETURNED. Error text is redacted (including the exact
//     key) before it becomes a message. Bodies are parsed into fixed shapes,
//     not passed through.
// ---------------------------------------------------------------------------

/** A validated sandbox record. `status` is `running` or `stopped`. */
export interface N8nSandbox {
  id: string;
  status: string;
  createdAt: number;
  lastActiveAt: number;
  ephemeral: boolean;
  egress: string;
  tenantId: string;
}

export interface N8nSandboxCreateOptions {
  /** Lowercase UUID to create or reconnect to. Omitted: the service generates one. */
  id?: string;
  /** Delete instead of stop once idle. Fixed at creation. */
  ephemeral?: boolean;
  /** Outbound network policy. Fixed at creation. */
  egress?: "public" | "none";
}

export interface N8nSandboxExecutionRequest {
  /** Runs via `/bin/sh -c` inside the sandbox. */
  command: string;
  env?: Record<string, string>;
  workdir?: string;
  /**
   * Server-side timeout for the command. Clamped to the configured ceiling;
   * the client's stream deadline is this plus a grace period.
   */
  timeoutMs?: number;
  /** Lowercase UUID. Makes the execution idempotent and resumable. */
  execId?: string;
}

export interface N8nSandboxExecutionResult {
  execId: string;
  exitCode: number;
  success: boolean;
  executionTimeMs: number;
  timedOut: boolean;
  killed: boolean;
  stdout: string;
  stderr: string;
  /** True when collected output hit the configured ceiling. */
  outputTruncated: boolean;
}

export interface N8nSandboxExecutionSnapshot {
  sandboxId: string;
  execId: string;
  /** `running` while no terminal event has been retained yet. */
  status: "running" | "exited" | "failed";
  eventCount: number;
  lastSeq: number | null;
  terminal: N8nSandboxExitEvent | N8nSandboxErrorEvent | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface N8nSandboxRequestOptions {
  signal?: AbortSignal;
}

export interface N8nSandboxResumeOptions extends N8nSandboxRequestOptions {
  /** Only events with `seq > after` are returned. */
  after?: number;
  /** Keep the stream open until the command finishes. Defaults to false for a status read. */
  follow?: boolean;
}

export interface N8nSandboxClient {
  createSandbox(
    options?: N8nSandboxCreateOptions,
    request?: N8nSandboxRequestOptions
  ): Promise<N8nSandboxResult<N8nSandbox>>;
  listSandboxes(request?: N8nSandboxRequestOptions): Promise<N8nSandboxResult<N8nSandbox[]>>;
  getSandbox(
    sandboxId: string,
    request?: N8nSandboxRequestOptions
  ): Promise<N8nSandboxResult<N8nSandbox>>;
  deleteSandbox(
    sandboxId: string,
    request?: N8nSandboxRequestOptions
  ): Promise<N8nSandboxResult<void>>;

  /** Runs a command to completion and collects its output. */
  execute(
    sandboxId: string,
    request: N8nSandboxExecutionRequest,
    options?: N8nSandboxRequestOptions
  ): Promise<N8nSandboxResult<N8nSandboxExecutionResult>>;

  /**
   * Yields every event as it arrives and returns the aggregate once a terminal
   * event is seen. Throws `N8nSandboxError` on failure.
   */
  streamExecution(
    sandboxId: string,
    request: N8nSandboxExecutionRequest,
    options?: N8nSandboxRequestOptions
  ): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult>;

  /** Reconnect to an execution that already exists, without re-running it. */
  resumeExecution(
    sandboxId: string,
    execId: string,
    options?: N8nSandboxResumeOptions
  ): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult>;

  /** A one-shot status/history read. Never keeps the stream open by default. */
  getExecution(
    sandboxId: string,
    execId: string,
    options?: N8nSandboxResumeOptions
  ): Promise<N8nSandboxResult<N8nSandboxExecutionSnapshot>>;

  /** Kills a running process. Idempotent: an unknown execution answers 204. */
  cancelExecution(
    sandboxId: string,
    execId: string,
    request?: N8nSandboxRequestOptions
  ): Promise<N8nSandboxResult<void>>;

  /** A read that proves the base URL, the key and the tenant path all work. */
  checkConnection(
    request?: N8nSandboxRequestOptions
  ): Promise<N8nSandboxResult<{ sandboxCount: number }>>;
}

export type N8nSandboxFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface N8nSandboxClientOptions {
  /** Omitted: read and validate `N8N_SANDBOX_*` from the environment. */
  config?: N8nSandboxConfig;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: N8nSandboxFetch;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const textEncoder = new TextEncoder();

/** A timer that aborts a request, and can say whether it was the one that did. */
interface BoundedSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): BoundedSignal {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function normalizeUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new N8nSandboxError("INVALID_REQUEST", `${field} must be a lowercase UUID`);
  }
  return normalized;
}

function invalid(message: string): N8nSandboxError {
  return new N8nSandboxError("INVALID_REQUEST", message);
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseSandbox(value: unknown): N8nSandbox {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedSandboxResponseError();
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
  const status = typeof raw.status === "string" ? raw.status : "";
  if (!UUID_PATTERN.test(id) || status.length === 0) {
    throw malformedSandboxResponseError();
  }
  return {
    id,
    status,
    createdAt: readNumber(raw.created_at),
    lastActiveAt: readNumber(raw.last_active_at),
    ephemeral: raw.ephemeral === true,
    egress: typeof raw.egress === "string" ? raw.egress : "public",
    tenantId: typeof raw.tenant_id === "string" ? raw.tenant_id : "",
  };
}

function validateEnvironment(env: Record<string, string>): Record<string, string> {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw invalid("env must be an object of string values");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.length === 0 || typeof value !== "string") {
      throw invalid("env must be an object of string values");
    }
    out[key] = value;
  }
  return out;
}

/**
 * Builds the client. Extends nothing and registers nothing: building one is
 * not exposure, because no route, tool or agent is handed this instance yet.
 */
export function createN8nSandboxClient(
  options: N8nSandboxClientOptions = {}
): N8nSandboxClient {
  const config = options.config ?? createN8nSandboxConfig();
  const fetchImpl: N8nSandboxFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  /** Removes the deployment's exact key, then anything shaped like a credential. */
  const sanitize = (value: string): string => {
    const withoutKey = config.apiKey
      ? value.split(config.apiKey).join("[REDACTED]")
      : value;
    return redactSandboxText(withoutKey);
  };

  function failure(error: unknown): { ok: false; error: N8nSandboxError } {
    if (error instanceof N8nSandboxError) return { ok: false, error };
    return {
      ok: false,
      error: classifySandboxTransportError(error, { sanitize }),
    };
  }

  async function readErrorBody(response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      return null;
    }
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      // A non-JSON error page is still useful text, and is redacted by the
      // classifier before it can become a message.
      return text;
    }
  }

  interface JsonResponse {
    ok: boolean;
    status: number;
    body: unknown;
  }

  /** Per-operation error shape. Defaults to "a non-GET may have taken effect". */
  interface ErrorPolicy {
    sideEffectPossible?: boolean;
    sideEffectForStatus?: (status: number) => boolean;
  }

  async function requestJson(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    policy: ErrorPolicy = {}
  ): Promise<JsonResponse> {
    const canAffect = policy.sideEffectPossible ?? method !== "GET";
    const bounded = withTimeout(signal, config.requestTimeoutMs);
    try {
      const response = await fetchImpl(`${config.apiUrl}${path}`, {
        method,
        headers: {
          "X-Api-Key": config.apiKey,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: bounded.signal,
      });

      // A write that answered 2xx cannot be retried blindly, but a 4xx is a
      // refusal and nothing changed. Only a 5xx may have reached a runner, and
      // a create narrows that further (see `createSandbox`).
      if (!response.ok) {
        const parsed = await readErrorBody(response);
        throw classifySandboxHttpError(response.status, parsed, {
          sanitize,
          sideEffectPossible: canAffect,
          ...(policy.sideEffectForStatus
            ? { sideEffectForStatus: policy.sideEffectForStatus }
            : {}),
          sandboxRestarted: response.headers.get("x-sandbox-restarted") === "1",
        });
      }

      if (response.status === 204) return { ok: true, status: 204, body: null };

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw classifySandboxTransportError(error, {
          signal: bounded.timedOut() ? undefined : signal,
          timedOut: bounded.timedOut(),
          sideEffectPossible: false,
          sanitize,
        });
      }
      if (text.trim().length === 0) return { ok: true, status: response.status, body: null };
      try {
        return { ok: true, status: response.status, body: JSON.parse(text) };
      } catch {
        throw malformedSandboxResponseError();
      }
    } catch (error) {
      if (error instanceof N8nSandboxError) throw error;
      throw classifySandboxTransportError(error, {
        signal: bounded.timedOut() ? undefined : signal,
        timedOut: bounded.timedOut(),
        sideEffectPossible: canAffect,
        sanitize,
      });
    } finally {
      bounded.dispose();
    }
  }

  /**
   * Yields parsed events from an NDJSON body.
   *
   * The decoder buffers a line split across chunks. A body that ends mid-line
   * still yields that line, because the service is allowed to omit a final
   * newline; a body that ends without a terminal event is the caller's signal
   * that the execution did not complete.
   *
   * `control.completed` is set by the caller when it stops at a terminal event.
   * Cancelling a response body is an upstream signal that can make the service
   * tear down the execution, so a completed (or naturally ended) stream is only
   * released — it is never cancelled. Only a stream abandoned before its end
   * is cancelled, and the lock is released in both cases.
   */
  async function* ndjsonEvents(
    response: Response,
    control: { completed: boolean }
  ): AsyncGenerator<N8nSandboxEvent> {
    if (!response.body) throw malformedSandboxResponseError();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const ndjson = createN8nSandboxNdjsonDecoder();
    let reachedEnd = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const text = decoder.decode(value, { stream: true });
        if (text.length === 0) continue;
        for (const line of ndjson.push(text)) yield parseN8nSandboxEvent(line);
      }
      const tail = decoder.decode();
      const finalLines = [
        ...(tail.length > 0 ? ndjson.push(tail) : []),
        ...ndjson.flush(),
      ];
      for (const line of finalLines) yield parseN8nSandboxEvent(line);
      reachedEnd = true;
    } finally {
      if (!reachedEnd && !control.completed) {
        try {
          await reader.cancel();
        } catch {
          // The body may already be closed or errored; there is nothing to do.
        }
      }
      try {
        reader.releaseLock();
      } catch {
        // Ignore: releasing a reader is best-effort.
      }
    }
  }

  function resolveExecutionTimeout(requested: number | undefined): number {
    if (requested === undefined) return config.executionTimeoutMs;
    if (
      typeof requested !== "number" ||
      !Number.isInteger(requested) ||
      requested <= 0
    ) {
      throw invalid("timeoutMs must be a positive integer");
    }
    return Math.min(requested, config.executionTimeoutMs);
  }

  /**
   * The shared streaming loop for POST (start) and GET (resume).
   *
   * Cancellation policy: a caller abort or a client deadline kills the process,
   * because both mean "stop". A stream that merely ended without a terminal
   * event is reported as incomplete and left running, so the caller can resume
   * it by id instead of re-executing the command. A terminal event ends the
   * read, and a completed execution is never cancelled.
   *
   * `sideEffectPossible` is what this request could have done: true for a POST
   * that starts a command, false for a read-only resume. It is carried on
   * every error this loop can raise.
   */
  async function* runStream(
    sandboxId: string,
    execIdHint: string | undefined,
    url: string,
    init: RequestInit,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    sideEffectPossible: boolean
  ): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult> {
    const bounded = withTimeout(signal, deadlineMs);
    const streamControl = { completed: false };
    let execId = execIdHint;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
    let terminal: N8nSandboxExitEvent | N8nSandboxErrorEvent | null = null;
    let cancelReason: "none" | "abort" | "timeout" = "none";

    const withExecId = (base: N8nSandboxErrorOptions = {}): N8nSandboxErrorOptions =>
      execId ? { ...base, execId } : base;

    try {
      const response = await fetchImpl(url, { ...init, signal: bounded.signal });

      const headerExecId = response.headers.get("x-exec-id");
      if (headerExecId) {
        // The header lets a caller resume even if the `started` event never
        // arrives. It is server-provided, so a non-UUID is a broken response.
        execId = normalizeUuid(headerExecId, "X-Exec-Id");
      }

      if (!response.ok) {
        const body = await readErrorBody(response);
        throw classifySandboxHttpError(response.status, body, {
          sanitize,
          sideEffectPossible,
          sandboxRestarted: response.headers.get("x-sandbox-restarted") === "1",
        });
      }

      for await (const event of ndjsonEvents(response, streamControl)) {
        if (event.type === "started") execId = event.execId;

        if (event.type === "stdout" || event.type === "stderr") {
          if (!outputTruncated) {
            const size = textEncoder.encode(event.data).length;
            if (outputBytes + size > config.maxOutputBytes) {
              outputTruncated = true;
            } else {
              outputBytes += size;
              (event.type === "stdout" ? stdout : stderr).push(event.data);
            }
          }
        }

        if (isTerminalSandboxEvent(event)) {
          terminal = event;
          // Mark completion BEFORE yielding: a caller that stops at the
          // terminal event must not make the reader cancel a finished stream.
          streamControl.completed = true;
        }
        yield event;

        // The stream ends at `exit` or `error`. Stop reading at once: the
        // remaining body is not part of this execution. The reader is released
        // without cancellation, and nothing below asks the service to kill a
        // process that has already finished.
        if (terminal) break;
      }

      if (!terminal) {
        if (bounded.timedOut()) {
          cancelReason = "timeout";
          throw new N8nSandboxError(
            "TOOL_TIMEOUT",
            "The sandbox execution did not finish before its deadline",
            withExecId({ sideEffectPossible })
          );
        }
        if (signal?.aborted) {
          cancelReason = "abort";
          throw new N8nSandboxError(
            "ABORTED",
            "The sandbox execution was cancelled",
            withExecId({ sideEffectPossible })
          );
        }
        // The execution may still be running; leave it resumable.
        throw incompleteSandboxStreamError(execId, sideEffectPossible);
      }

      if (terminal.type === "error") {
        throw new N8nSandboxError(
          "EXECUTION_FAILED",
          sanitize(terminal.error),
          withExecId({ sideEffectPossible })
        );
      }

      if (!execId) throw incompleteSandboxStreamError(undefined, sideEffectPossible);

      return {
        execId,
        exitCode: terminal.exitCode,
        success: terminal.success,
        executionTimeMs: terminal.executionTimeMs,
        timedOut: terminal.timedOut,
        killed: terminal.killed,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        outputTruncated,
      };
    } catch (error) {
      const timedOut = bounded.timedOut();
      const mapped =
        error instanceof N8nSandboxError
          ? error
          : classifySandboxTransportError(error, {
              signal: timedOut ? undefined : signal,
              timedOut,
              sideEffectPossible,
              ...(execId ? { execId } : {}),
              sanitize,
            });

      if (mapped.code === "ABORTED") cancelReason = "abort";
      if (mapped.code === "TOOL_TIMEOUT") cancelReason = "timeout";
      throw mapped;
    } finally {
      bounded.dispose();
      if (cancelReason !== "none" && execId) {
        await bestEffortCancel(sandboxId, execId);
      }
    }
  }

  /** Cancel is idempotent and must never mask the error that asked for it. */
  async function bestEffortCancel(sandboxId: string, execId: string): Promise<void> {
    try {
      await requestJson(
        "DELETE",
        `/sandboxes/${sandboxId}/executions/${execId}`,
        undefined,
        undefined
      );
    } catch {
      // Deliberately swallowed: cancellation is a cleanup step.
    }
  }

  async function* startExecution(
    sandboxId: string,
    request: N8nSandboxExecutionRequest,
    options: N8nSandboxRequestOptions
  ): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult> {
    const sid = normalizeUuid(sandboxId, "sandbox id");
    if (typeof request.command !== "string" || request.command.trim().length === 0) {
      throw invalid("command is required");
    }
    const timeoutMs = resolveExecutionTimeout(request.timeoutMs);

    const body: Record<string, unknown> = {
      command: request.command,
      timeout_ms: timeoutMs,
    };
    if (request.env !== undefined) body.env = validateEnvironment(request.env);
    if (request.workdir !== undefined) {
      if (typeof request.workdir !== "string") throw invalid("workdir must be a string");
      body.workdir = request.workdir;
    }

    let execIdHint: string | undefined;
    if (request.execId !== undefined) {
      execIdHint = normalizeUuid(request.execId, "exec_id");
      body.exec_id = execIdHint;
    }

    return yield* runStream(
      sid,
      execIdHint,
      `${config.apiUrl}/sandboxes/${sid}/executions`,
      {
        method: "POST",
        headers: {
          "X-Api-Key": config.apiKey,
          Accept: "application/x-ndjson",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      timeoutMs + N8N_SANDBOX_EXECUTION_GRACE_MS,
      options.signal,
      true
    );
  }

  async function* resumeExistingExecution(
    sandboxId: string,
    execId: string,
    options: N8nSandboxResumeOptions
  ): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult> {
    const sid = normalizeUuid(sandboxId, "sandbox id");
    const eid = normalizeUuid(execId, "execution id");
    const params = new URLSearchParams();
    if (options.after !== undefined) {
      if (!Number.isInteger(options.after) || options.after < 0) {
        throw invalid("after must be a non-negative integer");
      }
      params.set("after", String(options.after));
    }
    params.set("follow", "true");

    return yield* runStream(
      sid,
      eid,
      `${config.apiUrl}/sandboxes/${sid}/executions/${eid}?${params.toString()}`,
      {
        method: "GET",
        headers: {
          "X-Api-Key": config.apiKey,
          Accept: "application/x-ndjson",
        },
      },
      config.executionTimeoutMs + N8N_SANDBOX_EXECUTION_GRACE_MS,
      options.signal,
      // A resume GET never starts anything: no error here can have changed the
      // execution it is reading.
      false
    );
  }

  return {
    async createSandbox(createOptions = {}, request = {}) {
      try {
        const body: Record<string, unknown> = {};
        if (createOptions.id !== undefined) {
          body.id = normalizeUuid(createOptions.id, "sandbox id");
        }
        if (createOptions.ephemeral !== undefined) {
          if (typeof createOptions.ephemeral !== "boolean") {
            throw invalid("ephemeral must be a boolean");
          }
          body.ephemeral = createOptions.ephemeral;
        }
        if (createOptions.egress !== undefined) {
          if (createOptions.egress !== "public" && createOptions.egress !== "none") {
            throw invalid('egress must be "public" or "none"');
          }
          body.egress = createOptions.egress;
        }

        const result = await requestJson(
          "POST",
          "/sandboxes",
          Object.keys(body).length > 0 ? body : undefined,
          request.signal,
          {
            sideEffectPossible: true,
            // 502 (egress not confirmed, stale cleanup failed) and 503 (no
            // capacity) are documented as having created nothing. Any other
            // 5xx, or a gateway timeout, may have left a sandbox behind, and
            // repeating the create would then need the same `id`.
            sideEffectForStatus: (status) =>
              status === 408 ||
              status === 504 ||
              (status >= 500 && status !== 502 && status !== 503),
          }
        );
        return { ok: true, data: parseSandbox(result.body) };
      } catch (error) {
        return failure(error);
      }
    },

    async listSandboxes(request = {}) {
      try {
        const result = await requestJson("GET", "/sandboxes", undefined, request.signal);
        if (!Array.isArray(result.body)) throw malformedSandboxResponseError();
        return { ok: true, data: result.body.map(parseSandbox) };
      } catch (error) {
        return failure(error);
      }
    },

    async getSandbox(sandboxId, request = {}) {
      try {
        const sid = normalizeUuid(sandboxId, "sandbox id");
        const result = await requestJson(
          "GET",
          `/sandboxes/${sid}`,
          undefined,
          request.signal
        );
        return { ok: true, data: parseSandbox(result.body) };
      } catch (error) {
        return failure(error);
      }
    },

    async deleteSandbox(sandboxId, request = {}) {
      try {
        const sid = normalizeUuid(sandboxId, "sandbox id");
        await requestJson("DELETE", `/sandboxes/${sid}`, undefined, request.signal);
        return { ok: true, data: undefined };
      } catch (error) {
        return failure(error);
      }
    },

    async execute(sandboxId, request, options = {}) {
      try {
        const stream = startExecution(sandboxId, request, options);
        let step = await stream.next();
        while (!step.done) step = await stream.next();
        return { ok: true, data: step.value };
      } catch (error) {
        return failure(error);
      }
    },

    streamExecution(sandboxId, request, options = {}) {
      return startExecution(sandboxId, request, options);
    },

    resumeExecution(sandboxId, execId, options = {}) {
      return resumeExistingExecution(sandboxId, execId, options);
    },

    async getExecution(sandboxId, execId, options = {}) {
      const bounded = withTimeout(options.signal, config.requestTimeoutMs);
      const streamControl = { completed: false };
      try {
        const sid = normalizeUuid(sandboxId, "sandbox id");
        const eid = normalizeUuid(execId, "execution id");
        const params = new URLSearchParams();
        if (options.after !== undefined) {
          if (!Number.isInteger(options.after) || options.after < 0) {
            throw invalid("after must be a non-negative integer");
          }
          params.set("after", String(options.after));
        }
        params.set("follow", options.follow === true ? "true" : "false");

        const response = await fetchImpl(
          `${config.apiUrl}/sandboxes/${sid}/executions/${eid}?${params.toString()}`,
          {
            method: "GET",
            headers: {
              "X-Api-Key": config.apiKey,
              Accept: "application/x-ndjson",
            },
            signal: bounded.signal,
          }
        );

        if (!response.ok) {
          const body = await readErrorBody(response);
          throw classifySandboxHttpError(response.status, body, {
            sanitize,
            sideEffectPossible: false,
            sandboxRestarted: response.headers.get("x-sandbox-restarted") === "1",
          });
        }

        const stdout: string[] = [];
        const stderr: string[] = [];
        let outputBytes = 0;
        let outputTruncated = false;
        let eventCount = 0;
        let lastSeq: number | null = null;
        let terminal: N8nSandboxExitEvent | N8nSandboxErrorEvent | null = null;

        for await (const event of ndjsonEvents(response, streamControl)) {
          eventCount += 1;
          if (event.seq !== null) lastSeq = event.seq;
          if (event.type === "stdout" || event.type === "stderr") {
            if (!outputTruncated) {
              const size = textEncoder.encode(event.data).length;
              if (outputBytes + size > config.maxOutputBytes) {
                outputTruncated = true;
              } else {
                outputBytes += size;
                (event.type === "stdout" ? stdout : stderr).push(event.data);
              }
            }
          }
          if (isTerminalSandboxEvent(event)) {
            terminal = event;
            // A snapshot that found the end is complete: release the reader
            // without cancelling the service's retained execution.
            streamControl.completed = true;
            break;
          }
        }

        const status: N8nSandboxExecutionSnapshot["status"] =
          terminal === null ? "running" : terminal.type === "error" ? "failed" : "exited";

        return {
          ok: true,
          data: {
            sandboxId: sid,
            execId: eid,
            status,
            eventCount,
            lastSeq,
            terminal,
            stdout: stdout.join(""),
            stderr: stderr.join(""),
            outputTruncated,
          },
        };
      } catch (error) {
        return failure(error);
      } finally {
        bounded.dispose();
      }
    },

    async cancelExecution(sandboxId, execId, request = {}) {
      try {
        const sid = normalizeUuid(sandboxId, "sandbox id");
        const eid = normalizeUuid(execId, "execution id");
        await requestJson(
          "DELETE",
          `/sandboxes/${sid}/executions/${eid}`,
          undefined,
          request.signal
        );
        return { ok: true, data: undefined };
      } catch (error) {
        return failure(error);
      }
    },

    async checkConnection(request = {}) {
      try {
        const result = await requestJson("GET", "/sandboxes", undefined, request.signal);
        if (!Array.isArray(result.body)) throw malformedSandboxResponseError();
        return { ok: true, data: { sandboxCount: result.body.length } };
      } catch (error) {
        return failure(error);
      }
    },
  };
}
