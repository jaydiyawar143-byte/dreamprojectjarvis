// ---------------------------------------------------------------------------
// n8n Sandbox Service — the one place this API talks to the sandbox.
//
// WHAT IT IS. A thin, logged wrapper around `@jarvis/n8n`'s sandbox client. It
// owns no HTTP, no credentials of its own and no policy the client does not
// already enforce: the client validates ids, bounds output, applies timeouts,
// cancels on abort and redacts provider text. This service exists so that a
// future route and a future tool — the two surfaces the integration rule
// requires — call ONE instance with one logging contract.
//
// WHAT IT IS NOT. It is not wired to a route, a tool or an agent allowlist.
// Nothing in this release can reach it from a chat message or a screen. It runs
// inside a sandbox the operator's service owns; it never starts a process on
// the JARVIS host and never touches the n8n Cloud integration.
//
// WHAT IT NEVER LOGS. The API key, the base URL, the command, environment
// values, stdout or stderr. A log line carries ids, an outcome code and
// timings only; the operational log's redaction is a second guard, not the
// first.
// ---------------------------------------------------------------------------

import {
  N8nSandboxError,
  type N8nSandbox,
  type N8nSandboxClient,
  type N8nSandboxCreateOptions,
  type N8nSandboxEvent,
  type N8nSandboxExecutionRequest,
  type N8nSandboxExecutionResult,
  type N8nSandboxExecutionSnapshot,
  type N8nSandboxRequestOptions,
  type N8nSandboxResult,
  type N8nSandboxResumeOptions,
} from "@jarvis/n8n";

import type { OperationalLog } from "../observability/index.js";

export interface N8nSandboxServiceOptions {
  client: N8nSandboxClient;
  /** Already scoped to the `n8n-sandbox` component by the container. */
  log: OperationalLog;
}

export class N8nSandboxService {
  private readonly client: N8nSandboxClient;
  private readonly log: OperationalLog;

  constructor(options: N8nSandboxServiceOptions) {
    this.client = options.client;
    this.log = options.log;
  }

  /** A read that proves the URL, key and tenant path all work. */
  async checkConnection(
    request: N8nSandboxRequestOptions = {}
  ): Promise<N8nSandboxResult<{ sandboxCount: number }>> {
    const result = await this.client.checkConnection(request);
    if (!result.ok) {
      this.logFailure("check_connection", result.error);
    } else {
      this.log.info("n8n_sandbox_connection_checked", {
        sandboxCount: result.data.sandboxCount,
      });
    }
    return result;
  }

  async createSandbox(
    options: N8nSandboxCreateOptions = {},
    request: N8nSandboxRequestOptions = {}
  ): Promise<N8nSandboxResult<N8nSandbox>> {
    const result = await this.client.createSandbox(options, request);
    if (!result.ok) {
      this.logFailure("create_sandbox", result.error);
    } else {
      this.log.info("n8n_sandbox_created", {
        sandboxId: result.data.id,
        status: result.data.status,
      });
    }
    return result;
  }

  listSandboxes(
    request: N8nSandboxRequestOptions = {}
  ): Promise<N8nSandboxResult<N8nSandbox[]>> {
    return this.client.listSandboxes(request);
  }

  getSandbox(
    sandboxId: string,
    request: N8nSandboxRequestOptions = {}
  ): Promise<N8nSandboxResult<N8nSandbox>> {
    return this.client.getSandbox(sandboxId, request);
  }

  async deleteSandbox(
    sandboxId: string,
    request: N8nSandboxRequestOptions = {}
  ): Promise<N8nSandboxResult<void>> {
    const result = await this.client.deleteSandbox(sandboxId, request);
    if (!result.ok) {
      this.logFailure("delete_sandbox", result.error, { sandboxId });
    } else {
      this.log.info("n8n_sandbox_deleted", { sandboxId });
    }
    return result;
  }

  /** Runs a command to completion and collects its output. */
  async execute(
    sandboxId: string,
    request: N8nSandboxExecutionRequest,
    options: N8nSandboxRequestOptions = {}
  ): Promise<N8nSandboxResult<N8nSandboxExecutionResult>> {
    const startedAt = Date.now();
    const result = await this.client.execute(sandboxId, request, options);
    const durationMs = Date.now() - startedAt;

    if (!result.ok) {
      this.logFailure("execute", result.error, {
        sandboxId,
        durationMs,
      });
      return result;
    }

    this.log.info("n8n_sandbox_execution_finished", {
      sandboxId,
      execId: result.data.execId,
      exitCode: result.data.exitCode,
      success: result.data.success,
      timedOut: result.data.timedOut,
      killed: result.data.killed,
      outputTruncated: result.data.outputTruncated,
      durationMs,
      executionTimeMs: result.data.executionTimeMs,
    });
    return result;
  }

  /**
   * Streams events as they arrive and returns the aggregate at the end.
   *
   * The wrapper logs only the terminal outcome. It never logs an event's data,
   * so a command that prints a token cannot put it in the operational log.
   */
  streamExecution(
    sandboxId: string,
    request: N8nSandboxExecutionRequest,
    options: N8nSandboxRequestOptions = {}
  ): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult> {
    return this.streamWithLog(
      "execute",
      sandboxId,
      request.execId,
      this.client.streamExecution(sandboxId, request, options)
    );
  }

  /** Reconnects to an execution without re-running it. */
  resumeExecution(
    sandboxId: string,
    execId: string,
    options: N8nSandboxResumeOptions = {}
  ): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult> {
    return this.streamWithLog(
      "resume",
      sandboxId,
      execId,
      this.client.resumeExecution(sandboxId, execId, options)
    );
  }

  /** A one-shot status read. Never keeps the stream open by default. */
  getExecution(
    sandboxId: string,
    execId: string,
    options: N8nSandboxResumeOptions = {}
  ): Promise<N8nSandboxResult<N8nSandboxExecutionSnapshot>> {
    return this.client.getExecution(sandboxId, execId, options);
  }

  async cancelExecution(
    sandboxId: string,
    execId: string,
    request: N8nSandboxRequestOptions = {}
  ): Promise<N8nSandboxResult<void>> {
    const result = await this.client.cancelExecution(sandboxId, execId, request);
    if (!result.ok) {
      this.logFailure("cancel_execution", result.error, { sandboxId, execId });
    } else {
      this.log.info("n8n_sandbox_execution_cancelled", { sandboxId, execId });
    }
    return result;
  }

  private async *streamWithLog(
    operation: "execute" | "resume",
    sandboxId: string,
    execIdHint: string | undefined,
    stream: AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult>
  ): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult> {
    const startedAt = Date.now();
    let execId = execIdHint;
    let completed = false;

    try {
      let step = await stream.next();
      while (!step.done) {
        const event = step.value;
        if (event.type === "started") execId = event.execId;
        yield event;
        step = await stream.next();
      }

      const result = step.value;
      completed = true;
      this.log.info("n8n_sandbox_execution_finished", {
        operation,
        sandboxId,
        execId: result.execId,
        exitCode: result.exitCode,
        success: result.success,
        timedOut: result.timedOut,
        killed: result.killed,
        outputTruncated: result.outputTruncated,
        durationMs: Date.now() - startedAt,
        executionTimeMs: result.executionTimeMs,
      });
      return result;
    } catch (error) {
      this.logFailure(operation, error, {
        sandboxId,
        ...(execId ? { execId } : {}),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      if (!completed) {
        // A caller that stops reading — a closed response, a dismissed screen —
        // gets its client stream closed so the fetch body and its reader are
        // released. The execution itself keeps running inside the sandbox; it
        // stays resumable by id, and nothing is logged as a success.
        try {
          await stream.return(undefined as unknown as N8nSandboxExecutionResult);
        } catch {
          // Closing an already-finished stream is best-effort.
        }
      }
    }
  }

  private logFailure(
    operation: string,
    error: unknown,
    fields: Record<string, unknown> = {}
  ): void {
    const sandboxError = error instanceof N8nSandboxError ? error : null;
    this.log.warn("n8n_sandbox_operation_failed", {
      operation,
      code: sandboxError?.code ?? "UNKNOWN",
      retryable: sandboxError?.retryable ?? false,
      // `reason` is a validated token from the service (or the restart header),
      // never provider prose: safe to log, useful when diagnosing a refusal.
      ...(sandboxError?.reason ? { reason: sandboxError.reason } : {}),
      ...(sandboxError?.sandboxRestarted ? { sandboxRestarted: true } : {}),
      ...fields,
    });
  }
}
