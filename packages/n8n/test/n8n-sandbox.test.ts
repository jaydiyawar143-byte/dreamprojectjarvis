import { describe, it, expect, vi, afterEach } from "vitest";

import {
  createN8nSandboxConfig,
  describeN8nSandboxStatus,
  isN8nSandboxConfigured,
  N8N_SANDBOX_DEFAULT_MAX_OUTPUT_BYTES,
  N8N_SANDBOX_DEFAULT_REQUEST_TIMEOUT_MS,
  N8N_SANDBOX_EXECUTION_GRACE_MS,
} from "../src/sandbox-config.js";
import {
  createN8nSandboxNdjsonDecoder,
  parseN8nSandboxEvent,
} from "../src/sandbox-ndjson.js";
import { redactSandboxText } from "../src/sandbox-error.js";
import {
  createN8nSandboxClient,
  type N8nSandboxFetch,
} from "../src/sandbox-client.js";

// ---------------------------------------------------------------------------
// n8n Sandbox Service client
//
// No live sandbox service and no network: every request is served by a stub, so
// this suite asserts the WIRE CONTRACT (method, path, header, body, NDJSON
// handling), the failure classification and the cancellation rules without ever
// needing a real key.
// ---------------------------------------------------------------------------

const API_KEY = "SECRET-SANDBOX-KEY-VALUE";
const BASE_URL = "https://sandbox.test";
const SANDBOX_ID = "550e8400-e29b-41d4-a716-446655440000";
const EXEC_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const config = createN8nSandboxConfig({
  apiUrl: BASE_URL,
  apiKey: API_KEY,
  requestTimeoutMs: 200,
  executionTimeoutMs: 5_000,
  maxOutputBytes: 4_096,
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function emptyResponse(status: number) {
  return new Response(null, { status });
}

function ndjsonResponse(
  chunks: string[],
  options: { status?: number; headers?: Record<string, string> } = {}
) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: options.status ?? 200,
    headers: { "content-type": "application/x-ndjson", ...options.headers },
  });
}

const started = (execId = EXEC_ID) => JSON.stringify({ seq: 0, type: "started", exec_id: execId });
const stdout = (seq: number, data: string) =>
  JSON.stringify({ seq, type: "stdout", data });
const stderr = (seq: number, data: string) =>
  JSON.stringify({ seq, type: "stderr", data });
const exit = (seq: number, exitCode = 0) =>
  JSON.stringify({
    seq,
    type: "exit",
    exit_code: exitCode,
    success: exitCode === 0,
    execution_time_ms: 12,
    timed_out: false,
    killed: false,
  });

/**
 * A response whose reader is observed directly: read/cancel/releaseLock are
 * counted so a regression that keeps reading, cancels a finished stream or
 * forgets to release the lock is visible without a live service.
 */
function observedStreamResponse(
  chunks: string[],
  headers: Record<string, string> = {}
) {
  const encoder = new TextEncoder();
  const reads: number[] = [];
  const cancels: number[] = [];
  const releases: number[] = [];
  let index = 0;
  const reader = {
    read: async () => {
      if (index >= chunks.length) return { done: true, value: undefined };
      reads.push(index++);
      return { done: false, value: encoder.encode(chunks[index - 1]!) };
    },
    cancel: async () => {
      cancels.push(index);
    },
    releaseLock: () => {
      releases.push(index);
    },
  };
  const response = {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: { getReader: () => reader },
  } as unknown as Response;
  return { response, reads, cancels, releases };
}

function clientWith(fetch: N8nSandboxFetch) {
  return createN8nSandboxClient({ config, fetch });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("n8n Sandbox configuration", () => {
  it("requires both the URL and the key", () => {
    expect(isN8nSandboxConfigured({})).toBe(false);
    expect(isN8nSandboxConfigured({ N8N_SANDBOX_API_URL: BASE_URL })).toBe(false);
    expect(isN8nSandboxConfigured({ N8N_SANDBOX_API_KEY: "k" })).toBe(false);
    expect(
      isN8nSandboxConfigured({ N8N_SANDBOX_API_URL: BASE_URL, N8N_SANDBOX_API_KEY: "k" })
    ).toBe(true);

    expect(describeN8nSandboxStatus({}).reason).toContain("N8N_SANDBOX_API_URL");
    expect(
      describeN8nSandboxStatus({ N8N_SANDBOX_API_URL: BASE_URL }).reason
    ).toContain("N8N_SANDBOX_API_KEY");
  });

  it("applies defaults and strips a trailing slash from the URL", () => {
    const created = createN8nSandboxConfig({
      apiUrl: "https://sandbox.test/",
      apiKey: "k",
    });
    expect(created.apiUrl).toBe("https://sandbox.test");
    expect(created.requestTimeoutMs).toBe(N8N_SANDBOX_DEFAULT_REQUEST_TIMEOUT_MS);
    expect(created.maxOutputBytes).toBe(N8N_SANDBOX_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it("refuses a URL carrying credentials, a query or a non-http scheme", () => {
    const base = { apiKey: "k" };
    expect(() => createN8nSandboxConfig({ ...base, apiUrl: "https://u:p@host" })).toThrow(
      /credentials/
    );
    expect(() => createN8nSandboxConfig({ ...base, apiUrl: "https://host?x=1" })).toThrow(
      /query or fragment/
    );
    expect(() => createN8nSandboxConfig({ ...base, apiUrl: "ftp://host" })).toThrow(
      /http or https/
    );
  });

  it("never repeats the key in a configuration error", () => {
    try {
      createN8nSandboxConfig({ apiUrl: "not a url", apiKey: API_KEY });
      throw new Error("expected a configuration error");
    } catch (error) {
      expect(String(error)).not.toContain(API_KEY);
    }
  });
});

describe("n8n Sandbox NDJSON parsing", () => {
  it("parses each documented event type", () => {
    expect(parseN8nSandboxEvent(started())).toEqual({
      seq: 0,
      type: "started",
      execId: EXEC_ID,
    });
    expect(parseN8nSandboxEvent(stdout(1, "hi\n"))).toEqual({
      seq: 1,
      type: "stdout",
      data: "hi\n",
    });
    const parsedExit = parseN8nSandboxEvent(exit(3, 2));
    expect(parsedExit).toMatchObject({ type: "exit", exitCode: 2, success: false });
    expect(parseN8nSandboxEvent(JSON.stringify({ type: "error", error: "boom" }))).toEqual({
      seq: null,
      type: "error",
      error: "boom",
    });
  });

  it("refuses a line whose required fields are missing", () => {
    expect(() => parseN8nSandboxEvent("not json")).toThrow(/unexpected response/);
    expect(() => parseN8nSandboxEvent(JSON.stringify({ type: "exit" }))).toThrow(
      /unexpected response/
    );
    expect(() => parseN8nSandboxEvent(JSON.stringify({ type: "nope" }))).toThrow(
      /unexpected response/
    );
  });

  it("rebuilds a line split across chunks and accepts CRLF", () => {
    const decoder = createN8nSandboxNdjsonDecoder();
    expect(decoder.push('{"seq":1,"type":"std')).toEqual([]);
    expect(decoder.push('out","data":"x"}\r\n{"seq":2')).toEqual([
      '{"seq":1,"type":"stdout","data":"x"}',
    ]);
    expect(decoder.push(',"type":"stdout","data":"y"}')).toEqual([]);
    // The service may omit the final newline; flush returns the last line.
    expect(decoder.flush()).toEqual(['{"seq":2,"type":"stdout","data":"y"}']);
  });
});

describe("n8n Sandbox client — sandbox lifecycle", () => {
  it("creates a sandbox with the key in a header and no body", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      jsonResponse(201, {
        id: SANDBOX_ID,
        status: "running",
        created_at: 1,
        last_active_at: 1,
        ephemeral: false,
        egress: "public",
        tenant_id: "t",
      })
    );

    const result = await clientWith(fetchMock).createSandbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.id).toBe(SANDBOX_ID);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE_URL}/sandboxes`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe(API_KEY);
    expect(init?.body).toBeUndefined();
  });

  it("sends create options as a bounded body and accepts 200", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      jsonResponse(200, {
        id: SANDBOX_ID,
        status: "stopped",
        created_at: 1,
        last_active_at: 1,
        ephemeral: true,
        egress: "none",
        tenant_id: "t",
      })
    );

    const result = await clientWith(fetchMock).createSandbox({
      id: SANDBOX_ID,
      ephemeral: true,
      egress: "none",
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      id: SANDBOX_ID,
      ephemeral: true,
      egress: "none",
    });
  });

  it("lists, reads and deletes", async () => {
    const fetchMock = vi
      .fn<N8nSandboxFetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, [
          {
            id: SANDBOX_ID,
            status: "running",
            created_at: 1,
            last_active_at: 2,
            ephemeral: false,
            egress: "public",
            tenant_id: "t",
          },
        ])
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: SANDBOX_ID,
          status: "running",
          created_at: 1,
          last_active_at: 2,
          ephemeral: false,
          egress: "public",
          tenant_id: "t",
        })
      )
      .mockResolvedValueOnce(emptyResponse(204));

    const client = clientWith(fetchMock);
    const list = await client.listSandboxes();
    const get = await client.getSandbox(SANDBOX_ID);
    const del = await client.deleteSandbox(SANDBOX_ID);

    expect(list.ok && list.data).toHaveLength(1);
    expect(get.ok && get.data.id).toBe(SANDBOX_ID);
    expect(del.ok).toBe(true);
    expect(String(fetchMock.mock.calls[1]![0])).toBe(`${BASE_URL}/sandboxes/${SANDBOX_ID}`);
    expect(fetchMock.mock.calls[2]![1]?.method).toBe("DELETE");
  });

  it("refuses a sandbox id that could escape its path, without a request", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>();
    const result = await clientWith(fetchMock).getSandbox("../../admin/tenants");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_REQUEST");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the connection check as a real read", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      jsonResponse(200, [{ id: SANDBOX_ID }])
    );
    const result = await clientWith(fetchMock).checkConnection();
    expect(result.ok && result.data.sandboxCount).toBe(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE_URL}/sandboxes`);
  });
});

describe("n8n Sandbox client — execution", () => {
  it("streams stdout, stderr and exit in order", async () => {
    const line1 = `${started()}\n`;
    const line2 = `${stdout(1, "hello ")}\n${stdout(2, "world\n")}\n`;
    const line3 = `${stderr(3, "warn")}\n`;
    const line4 = `${exit(4, 0)}\n`;
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      // A JSON line is deliberately split across two chunks.
      ndjsonResponse([line1, line2.slice(0, 15), line2.slice(15), line3, line4])
    );

    const events: string[] = [];
    const client = clientWith(fetchMock);

    const stream = client.streamExecution(SANDBOX_ID, { command: "echo hello" });
    let step = await stream.next();
    while (!step.done) {
      events.push(step.value.type);
      step = await stream.next();
    }
    const aggregate = { ok: true as const, data: step.value };

    expect(events).toEqual(["started", "stdout", "stdout", "stderr", "exit"]);
    expect(aggregate.data).toMatchObject({
      execId: EXEC_ID,
      exitCode: 0,
      success: true,
      stdout: "hello world\n",
      stderr: "warn",
      outputTruncated: false,
    });
  });

  it("sends the documented execution body and honours a caller exec id", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      ndjsonResponse([`${started()}\n`, `${exit(1)}\n`], {
        headers: { "x-exec-id": EXEC_ID },
      })
    );

    const result = await clientWith(fetchMock).execute(SANDBOX_ID, {
      command: "ls",
      env: { FOO: "bar" },
      workdir: "/home/user",
      timeoutMs: 1_000,
      execId: EXEC_ID,
    });

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE_URL}/sandboxes/${SANDBOX_ID}/executions`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe(API_KEY);
    expect(headers.Accept).toBe("application/x-ndjson");
    expect(JSON.parse(String(init?.body))).toEqual({
      command: "ls",
      timeout_ms: 1_000,
      env: { FOO: "bar" },
      workdir: "/home/user",
      exec_id: EXEC_ID,
    });
  });

  it("stops at exit, releases the reader, and never cancels or DELETEs a finished execution", async () => {
    const observed = observedStreamResponse([
      `${started()}\n`,
      `${stdout(1, "ok\n")}\n`,
      `${exit(2)}\n`,
      `${stdout(3, "must not be read")}\n`,
    ]);
    const fetchMock = vi.fn<N8nSandboxFetch>(async () => observed.response);

    const result = await clientWith(fetchMock).execute(SANDBOX_ID, {
      command: "echo ok",
      execId: EXEC_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ execId: EXEC_ID, stdout: "ok\n", success: true });
    // Only the three chunks up to and including exit were read.
    expect(observed.reads).toEqual([0, 1, 2]);
    // A completed stream is released, not cancelled.
    expect(observed.cancels).toEqual([]);
    expect(observed.releases).toHaveLength(1);
    // Nothing asks the service to kill an execution that already exited.
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).not.toContain("DELETE");
  });

  it("treats an error event as terminal without cancelling the execution", async () => {
    const observed = observedStreamResponse([
      `${started()}\n`,
      `${JSON.stringify({ seq: 1, type: "error", error: "command failed" })}\n`,
      `${exit(2)}\n`,
    ]);
    const fetchMock = vi.fn<N8nSandboxFetch>(async () => observed.response);

    const result = await clientWith(fetchMock).execute(SANDBOX_ID, {
      command: "false",
      execId: EXEC_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXECUTION_FAILED");
    expect(observed.reads).toEqual([0, 1]);
    expect(observed.cancels).toEqual([]);
    expect(observed.releases).toHaveLength(1);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).not.toContain("DELETE");
  });

  it("releases a snapshot reader at the terminal event without cancelling", async () => {
    const observed = observedStreamResponse([
      `${started()}\n`,
      `${stdout(1, "done")}\n`,
      `${exit(2)}\n`,
      `${stdout(3, "must not be read")}\n`,
    ]);

    const result = await clientWith(async () => observed.response).getExecution(
      SANDBOX_ID,
      EXEC_ID
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("exited");
    expect(observed.reads).toEqual([0, 1, 2]);
    expect(observed.cancels).toEqual([]);
    expect(observed.releases).toHaveLength(1);
  });

  it("still cancels and releases a stream the caller abandons before its end", async () => {
    const observed = observedStreamResponse([`${started()}\n`, `${stdout(1, "partial")}\n`]);
    const stream = clientWith(async () => observed.response).streamExecution(SANDBOX_ID, {
      command: "sleep 60",
      execId: EXEC_ID,
    });

    const first = await stream.next();
    expect(first.value).toMatchObject({ type: "started" });
    // A caller that walks away must not leave the response body locked, but
    // this is not a completed execution: cancelling the body is correct here.
    await stream.return(undefined as never);

    expect(observed.cancels).toHaveLength(1);
    expect(observed.releases).toHaveLength(1);
  });

  it("treats a stream that ends without exit or error as incomplete", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      ndjsonResponse([`${started()}\n`, `${stdout(1, "partial")}\n`])
    );

    const result = await clientWith(fetchMock).execute(SANDBOX_ID, { command: "sleep 1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("STREAM_INCOMPLETE");
    expect(result.error.execId).toBe(EXEC_ID);
    // Incomplete is not cancelled: the execution may be resumed by id.
    const methods = fetchMock.mock.calls.map(([, init]) => init?.method);
    expect(methods).not.toContain("DELETE");
  });

  it("turns an error event into EXECUTION_FAILED with a redacted message", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      ndjsonResponse([
        `${started()}\n`,
        `${JSON.stringify({ type: "error", error: `denied for ${API_KEY}` })}\n`,
      ])
    );

    const result = await clientWith(fetchMock).execute(SANDBOX_ID, { command: "x" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXECUTION_FAILED");
    expect(result.error.message).not.toContain(API_KEY);
  });

  it("caps collected output but still reports the exit", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      ndjsonResponse([
        `${started()}\n`,
        `${stdout(1, "x".repeat(2_500))}\n`,
        `${stdout(2, "y".repeat(2_500))}\n`,
        `${exit(3)}\n`,
      ])
    );

    const result = await clientWith(fetchMock).execute(SANDBOX_ID, { command: "x" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outputTruncated).toBe(true);
    // 4096-byte ceiling: the first 2500-byte event is kept, the next is not.
    expect(result.data.stdout).toBe("x".repeat(2_500));
  });

  it("reports a missing command without a request", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>();
    const result = await clientWith(fetchMock).execute(SANDBOX_ID, { command: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_REQUEST");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels the execution when the caller aborts", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetchMock = vi.fn<N8nSandboxFetch>(async (input, init) => {
      calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
      if (init?.method === "DELETE") return emptyResponse(204);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });

    const pending = clientWith(fetchMock).execute(
      SANDBOX_ID,
      { command: "sleep 60", execId: EXEC_ID },
      { signal: controller.signal }
    );
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ABORTED");
    expect(calls).toContain(`DELETE /sandboxes/${SANDBOX_ID}/executions/${EXEC_ID}`);
  });

  it("cancels the execution when the client deadline expires", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const fetchMock = vi.fn<N8nSandboxFetch>(async (input, init) => {
      calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
      if (init?.method === "DELETE") return emptyResponse(204);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });

    // executionTimeoutMs is softened by the grace, so a caller-chosen 100ms
    // becomes a 100ms server timeout and a 100ms + grace client deadline.
    const pending = clientWith(fetchMock).execute(
      SANDBOX_ID,
      { command: "sleep 60", timeoutMs: 100, execId: EXEC_ID }
    );
    await vi.advanceTimersByTimeAsync(100 + N8N_SANDBOX_EXECUTION_GRACE_MS + 10);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TOOL_TIMEOUT");
    expect(calls).toContain(`DELETE /sandboxes/${SANDBOX_ID}/executions/${EXEC_ID}`);
  });

  it("resumes an execution from a sequence number", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      ndjsonResponse([`${stdout(6, "tail")}\n`, `${exit(7)}\n`])
    );

    const client = clientWith(fetchMock);
    const stream = client.resumeExecution(SANDBOX_ID, EXEC_ID, { after: 5 });
    const types: string[] = [];
    let next = await stream.next();
    while (!next.done) {
      types.push(next.value.type);
      next = await stream.next();
    }
    expect(types).toEqual(["stdout", "exit"]);
    expect(next.value.stdout).toBe("tail");

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`/sandboxes/${SANDBOX_ID}/executions/${EXEC_ID}`);
    expect(String(url)).toContain("after=5");
    expect(String(url)).toContain("follow=true");
  });

  it("reads an execution snapshot without requiring a terminal event", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      ndjsonResponse([`${started()}\n`, `${stdout(1, "still running")}\n`])
    );

    const result = await clientWith(fetchMock).getExecution(SANDBOX_ID, EXEC_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("running");
    expect(result.data.stdout).toBe("still running");
    expect(result.data.terminal).toBeNull();
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("follow=false");
  });

  it("cancels an execution by id", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () => emptyResponse(204));
    const result = await clientWith(fetchMock).cancelExecution(SANDBOX_ID, EXEC_ID);
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("DELETE");
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `${BASE_URL}/sandboxes/${SANDBOX_ID}/executions/${EXEC_ID}`
    );
  });
});

describe("n8n Sandbox client — failures", () => {
  it("classifies a rejected key without echoing it", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      jsonResponse(401, { error: `invalid key ${API_KEY}`, code: 401 })
    );

    const result = await clientWith(fetchMock).listSandboxes();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AUTHENTICATION_FAILED");
    expect(result.error.httpStatus).toBe(401);
    expect(result.error.message).not.toContain(API_KEY);
    expect(result.error.retryable).toBe(false);
  });

  it("classifies create failures by the 1.15.0 contract: 502/503 create nothing", async () => {
    const busy = await clientWith(
      vi.fn<N8nSandboxFetch>(async () =>
        jsonResponse(503, { error: "busy", code: 503, reason: "no_capacity" })
      )
    ).createSandbox();
    const stale = await clientWith(
      vi.fn<N8nSandboxFetch>(async () => jsonResponse(502, { error: "stale", code: 502 }))
    ).createSandbox();
    const refused = await clientWith(
      vi.fn<N8nSandboxFetch>(async () => jsonResponse(403, { error: "quota", code: 403 }))
    ).createSandbox();

    // 503 (no capacity) and 502 (cleanup/egress failure) are documented as
    // creating NOTHING. 503 is safe to retry; 502 is not.
    expect(!busy.ok && busy.error.retryable).toBe(true);
    expect(!busy.ok && busy.error.reason).toBe("no_capacity");
    expect(!busy.ok && busy.error.sideEffectPossible).toBe(false);
    expect(!stale.ok && stale.error.retryable).toBe(false);
    expect(!stale.ok && stale.error.sideEffectPossible).toBe(false);
    expect(!refused.ok && refused.error.code).toBe("FORBIDDEN");
    expect(!refused.ok && refused.error.sideEffectPossible).toBe(false);
  });

  it("still admits a create whose 5xx or gateway timeout may have reached a runner", async () => {
    for (const status of [500, 408, 504]) {
      const result = await clientWith(
        vi.fn<N8nSandboxFetch>(async () => jsonResponse(status, { error: "uncertain" }))
      ).createSandbox();
      expect(!result.ok && result.error.sideEffectPossible, `status ${status}`).toBe(true);
    }
  });

  it("keeps sideEffectPossible tied to the operation, not the status alone", async () => {
    const failing = (status: number) =>
      vi.fn<N8nSandboxFetch>(async () => jsonResponse(status, { error: "uncertain" }));

    // POST /executions may have started a command before a 5xx was returned.
    const exec = await clientWith(failing(500)).execute(SANDBOX_ID, { command: "echo ok" });
    expect(!exec.ok && exec.error.sideEffectPossible).toBe(true);

    // A 429 is refused before the sandbox is reached, on any operation.
    const limited = await clientWith(failing(429)).execute(SANDBOX_ID, { command: "echo ok" });
    expect(!limited.ok && limited.error.sideEffectPossible).toBe(false);

    // A resume GET never starts anything, whatever the status.
    const resume = await clientWith(failing(500)).resumeExecution(SANDBOX_ID, EXEC_ID);
    await expect(resume.next()).rejects.toMatchObject({ sideEffectPossible: false });

    // DELETE of a sandbox or execution may have succeeded despite a late 5xx.
    const del = await clientWith(failing(500)).deleteSandbox(SANDBOX_ID);
    expect(!del.ok && del.error.sideEffectPossible).toBe(true);
    const cancel = await clientWith(failing(500)).cancelExecution(SANDBOX_ID, EXEC_ID);
    expect(!cancel.ok && cancel.error.sideEffectPossible).toBe(true);
  });

  it("preserves a validated provider reason and reads X-Sandbox-Restarted", async () => {
    const limited = await clientWith(
      vi.fn<N8nSandboxFetch>(async () =>
        jsonResponse(
          429,
          { error: `busy for ${API_KEY}`, code: 429, reason: "tenant_request_limit" },
          { "retry-after": "1" }
        )
      )
    ).listSandboxes();
    expect(!limited.ok && limited.error.reason).toBe("tenant_request_limit");
    expect(!limited.ok && limited.error.message).not.toContain(API_KEY);

    const restarted = await clientWith(
      vi.fn<N8nSandboxFetch>(async () =>
        jsonResponse(
          409,
          { error: `sandbox restarted for ${API_KEY}`, reason: "sandbox_restarted" },
          { "X-Sandbox-Restarted": "1" }
        )
      )
    ).execute(SANDBOX_ID, { command: "echo ok" });
    expect(!restarted.ok && restarted.error.code).toBe("CONFLICT");
    expect(!restarted.ok && restarted.error.reason).toBe("sandbox_restarted");
    expect(!restarted.ok && restarted.error.sandboxRestarted).toBe(true);
    expect(!restarted.ok && restarted.error.sideEffectPossible).toBe(false);
    expect(!restarted.ok && restarted.error.message).not.toContain(API_KEY);

    // The header is the only signal when a proxy strips the body.
    const headerOnly = await clientWith(
      vi.fn<N8nSandboxFetch>(async () =>
        jsonResponse(409, "sandbox restarted", { "x-sandbox-restarted": "1" })
      )
    ).listSandboxes();
    expect(!headerOnly.ok && headerOnly.error.sandboxRestarted).toBe(true);
    expect(!headerOnly.ok && headerOnly.error.reason).toBe("sandbox_restarted");
    expect(!headerOnly.ok && JSON.stringify(headerOnly.error.toJSON())).not.toContain(API_KEY);
  });

  it("drops a reason that is prose, a URL or a credential", async () => {
    for (const reason of [`Bearer ${API_KEY}`, "https://evil.test/x", "a reason with spaces"]) {
      const result = await clientWith(
        vi.fn<N8nSandboxFetch>(async () =>
          jsonResponse(503, { error: "busy", code: 503, reason })
        )
      ).createSandbox();
      expect(!result.ok && result.error.reason).toBeUndefined();
      expect(!result.ok && JSON.stringify(result.error.toJSON())).not.toContain(API_KEY);
    }
  });

  it("classifies a connection failure as a network error", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
    });

    const result = await clientWith(fetchMock).checkConnection();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("refuses a malformed body rather than inventing a sandbox", async () => {
    const fetchMock = vi.fn<N8nSandboxFetch>(async () =>
      jsonResponse(201, { status: "running" })
    );

    const result = await clientWith(fetchMock).createSandbox();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MALFORMED_RESPONSE");
  });

  it("redacts credentials from provider text", () => {
    expect(redactSandboxText("Authorization: Bearer abc.def")).not.toContain("abc.def");
    expect(redactSandboxText("api_key=supersecret")).not.toContain("supersecret");
    expect(redactSandboxText("https://user:pass@host/x")).toBe(
      "https://[REDACTED]@host/x"
    );
  });
});
