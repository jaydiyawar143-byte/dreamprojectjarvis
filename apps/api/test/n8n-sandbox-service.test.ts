// ---------------------------------------------------------------------------
// n8n Sandbox Service — configuration gating, delegation and what the log says.
//
// No live sandbox service and no network. The client is a stub, so this file
// pins the parts that must not drift:
//
//   • the service is built ONLY when both N8N_SANDBOX_API_URL and
//     N8N_SANDBOX_API_KEY are present, and boot never throws because a sandbox
//     is misconfigured;
//   • the loader's reason names a FIELD, never its value;
//   • the service delegates to its one client and adds no HTTP of its own;
//   • the operational log carries ids, codes and timings — never the key, the
//     base URL, the command, environment values, stdout or stderr.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  N8nSandboxError,
  type N8nSandbox,
  type N8nSandboxClient,
  type N8nSandboxEvent,
  type N8nSandboxExecutionResult,
  type N8nSandboxExecutionSnapshot,
  type N8nSandboxResult,
} from "@jarvis/n8n";

import { loadN8nSandboxConfig } from "../src/services/n8n-sandbox/config.js";
import { N8nSandboxService } from "../src/services/n8n-sandbox/sandbox-service.js";
import { getContainer, resetContainer } from "../src/services/container.js";
import { createOperationalLog, type OperationalLog } from "../src/services/observability/index.js";

const API_KEY = "SECRET-SANDBOX-KEY-VALUE";
const BASE_URL = "https://sandbox.internal.test";
const SANDBOX_ID = "550e8400-e29b-41d4-a716-446655440000";
const EXEC_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const SANDBOX: N8nSandbox = {
  id: SANDBOX_ID,
  status: "running",
  createdAt: 1,
  lastActiveAt: 2,
  ephemeral: false,
  egress: "public",
  tenantId: "tenant",
};

const RESULT: N8nSandboxExecutionResult = {
  execId: EXEC_ID,
  exitCode: 0,
  success: true,
  executionTimeMs: 12,
  timedOut: false,
  killed: false,
  stdout: "hello",
  stderr: "",
  outputTruncated: false,
};

/** A log that keeps its lines, written through the real redaction. */
function captureLog(): { log: OperationalLog; lines: string[] } {
  const lines: string[] = [];
  const log = createOperationalLog({
    service: "jarvis-api",
    write: (line) => lines.push(line),
  });
  return { log, lines };
}

/**
 * A client whose every method is a mock. The service must not add behaviour on
 * top of it, so each test asserts on the delegation as well as the result.
 */
function fakeClient(overrides: Partial<N8nSandboxClient> = {}) {
  const client: N8nSandboxClient = {
    createSandbox: vi.fn(
      async (): Promise<N8nSandboxResult<N8nSandbox>> => ({ ok: true, data: SANDBOX })
    ),
    listSandboxes: vi.fn(
      async (): Promise<N8nSandboxResult<N8nSandbox[]>> => ({ ok: true, data: [SANDBOX] })
    ),
    getSandbox: vi.fn(
      async (): Promise<N8nSandboxResult<N8nSandbox>> => ({ ok: true, data: SANDBOX })
    ),
    deleteSandbox: vi.fn(async (): Promise<N8nSandboxResult<void>> => ({ ok: true, data: undefined })),
    execute: vi.fn(
      async (): Promise<N8nSandboxResult<N8nSandboxExecutionResult>> => ({ ok: true, data: RESULT })
    ),
    streamExecution: vi.fn(() => emptyStream(RESULT)),
    resumeExecution: vi.fn(() => emptyStream(RESULT)),
    getExecution: vi.fn(
      async (): Promise<N8nSandboxResult<N8nSandboxExecutionSnapshot>> => ({
        ok: true,
        data: {
          sandboxId: SANDBOX_ID,
          execId: EXEC_ID,
          status: "exited",
          eventCount: 1,
          lastSeq: 3,
          terminal: {
            seq: 3,
            type: "exit",
            exitCode: 0,
            success: true,
            executionTimeMs: 12,
            timedOut: false,
            killed: false,
          },
          stdout: "hello",
          stderr: "",
          outputTruncated: false,
        },
      })
    ),
    cancelExecution: vi.fn(async (): Promise<N8nSandboxResult<void>> => ({ ok: true, data: undefined })),
    checkConnection: vi.fn(
      async (): Promise<N8nSandboxResult<{ sandboxCount: number }>> => ({
        ok: true,
        data: { sandboxCount: 1 },
      })
    ),
    ...overrides,
  };
  return client;
}

async function* emptyStream(result: N8nSandboxExecutionResult) {
  return result;
}

async function collect(
  stream: AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult>
): Promise<{ events: N8nSandboxEvent[]; result: N8nSandboxExecutionResult }> {
  const events: N8nSandboxEvent[] = [];
  let step = await stream.next();
  while (!step.done) {
    events.push(step.value);
    step = await stream.next();
  }
  return { events, result: step.value };
}

beforeEach(() => {
  resetContainer();
});

afterEach(() => {
  resetContainer();
  vi.unstubAllEnvs();
});

describe("n8n Sandbox — configuration gating", () => {
  it("is disabled, with a value-free reason, when nothing is set", () => {
    const loaded = loadN8nSandboxConfig({});
    expect(loaded.enabled).toBe(false);
    if (loaded.enabled) return;
    expect(loaded.reason).toContain("N8N_SANDBOX_API_URL");
    expect(loaded.reason).toContain("N8N_SANDBOX_API_KEY");
  });

  it("names the missing field, and only the field", () => {
    const keyOnly = loadN8nSandboxConfig({ N8N_SANDBOX_API_KEY: API_KEY });
    expect(keyOnly.enabled).toBe(false);
    if (!keyOnly.enabled) {
      expect(keyOnly.reason).toContain("N8N_SANDBOX_API_URL");
      expect(keyOnly.reason).not.toContain(API_KEY);
    }

    const urlOnly = loadN8nSandboxConfig({ N8N_SANDBOX_API_URL: BASE_URL });
    expect(urlOnly.enabled).toBe(false);
    if (!urlOnly.enabled) {
      expect(urlOnly.reason).toContain("N8N_SANDBOX_API_KEY");
      expect(urlOnly.reason).not.toContain(BASE_URL);
    }
  });

  it("is enabled with both values and builds the validated config", () => {
    const loaded = loadN8nSandboxConfig({
      N8N_SANDBOX_API_URL: `${BASE_URL}/`,
      N8N_SANDBOX_API_KEY: API_KEY,
    });
    expect(loaded.enabled).toBe(true);
    if (!loaded.enabled) return;
    expect(loaded.config.apiUrl).toBe(BASE_URL);
    expect(loaded.config.apiKey).toBe(API_KEY);
  });

  it("is disabled, not a boot failure, when a value is invalid — and never repeats the key", () => {
    const loaded = loadN8nSandboxConfig({
      N8N_SANDBOX_API_URL: "not a url",
      N8N_SANDBOX_API_KEY: API_KEY,
    });
    expect(loaded.enabled).toBe(false);
    if (loaded.enabled) return;
    expect(loaded.reason).toContain("N8N_SANDBOX_API_URL");
    expect(loaded.reason).not.toContain(API_KEY);
  });

  it("refuses a URL that embeds credentials before anything is built", () => {
    const loaded = loadN8nSandboxConfig({
      N8N_SANDBOX_API_URL: "https://user:pass@sandbox.internal.test",
      N8N_SANDBOX_API_KEY: API_KEY,
    });
    expect(loaded.enabled).toBe(false);
    if (loaded.enabled) return;
    expect(loaded.reason).toContain("credentials");
    expect(loaded.reason).not.toContain("pass");
  });
});

describe("n8n Sandbox — the service delegates and logs only ids and outcomes", () => {
  it("creates a sandbox through its one client", async () => {
    const client = fakeClient();
    const { log, lines } = captureLog();
    const service = new N8nSandboxService({ client, log });

    const result = await service.createSandbox({ ephemeral: false });

    expect(result).toEqual({ ok: true, data: SANDBOX });
    expect(client.createSandbox).toHaveBeenCalledTimes(1);
    const line = JSON.parse(lines.at(-1)!);
    expect(line.event).toBe("n8n_sandbox_created");
    expect(line.sandboxId).toBe(SANDBOX_ID);
    expect(line.status).toBe("running");
  });

  it("executes through the client and logs no command or output", async () => {
    const client = fakeClient();
    const { log, lines } = captureLog();
    const service = new N8nSandboxService({ client, log });

    const result = await service.execute(SANDBOX_ID, {
      command: "cat /run/secrets/token",
      env: { GITHUB_TOKEN: "ghp_do_not_log_me" },
    });

    expect(result).toEqual({ ok: true, data: RESULT });
    expect(client.execute).toHaveBeenCalledWith(
      SANDBOX_ID,
      expect.objectContaining({ command: "cat /run/secrets/token" }),
      {}
    );

    const output = lines.join("\n");
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain(BASE_URL);
    expect(output).not.toContain("cat /run/secrets/token");
    expect(output).not.toContain("ghp_do_not_log_me");
    expect(output).not.toContain("hello");

    const line = JSON.parse(lines.at(-1)!);
    expect(line.event).toBe("n8n_sandbox_execution_finished");
    expect(line).toMatchObject({
      sandboxId: SANDBOX_ID,
      execId: EXEC_ID,
      exitCode: 0,
      success: true,
      outputTruncated: false,
    });
  });

  it("logs a failure as a code, a validated reason and a retryability, never the provider's prose", async () => {
    const error = new N8nSandboxError("FORBIDDEN", `denied for ${API_KEY}`, {
      httpStatus: 403,
      reason: "tenant_request_limit",
      sideEffectPossible: false,
    });
    const client = fakeClient({
      execute: vi.fn(async () => ({ ok: false, error }) as N8nSandboxResult<N8nSandboxExecutionResult>),
    });
    const { log, lines } = captureLog();
    const service = new N8nSandboxService({ client, log });

    const result = await service.execute(SANDBOX_ID, { command: "x" });

    expect(result).toEqual({ ok: false, error });
    const line = JSON.parse(lines.at(-1)!);
    expect(line.event).toBe("n8n_sandbox_operation_failed");
    expect(line).toMatchObject({
      operation: "execute",
      code: "FORBIDDEN",
      retryable: false,
      reason: "tenant_request_limit",
      sandboxId: SANDBOX_ID,
    });
    expect(lines.join("\n")).not.toContain(API_KEY);
  });

  it("streams events unchanged and logs once, at the end", async () => {
    const events: N8nSandboxEvent[] = [
      { seq: 0, type: "started", execId: EXEC_ID },
      { seq: 1, type: "stdout", data: "a secret line" },
      {
        seq: 2,
        type: "exit",
        exitCode: 1,
        success: false,
        executionTimeMs: 5,
        timedOut: false,
        killed: false,
      },
    ];
    const client = fakeClient({
      streamExecution: vi.fn(() => streamOf(events, { ...RESULT, exitCode: 1, success: false })),
    });
    const { log, lines } = captureLog();
    const service = new N8nSandboxService({ client, log });

    const collected = await collect(
      service.streamExecution(SANDBOX_ID, { command: "echo secret", execId: EXEC_ID })
    );

    expect(collected.events).toEqual(events);
    expect(collected.result.exitCode).toBe(1);
    // Only the terminal outcome is written, and only once.
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({
      event: "n8n_sandbox_execution_finished",
      operation: "execute",
      sandboxId: SANDBOX_ID,
      execId: EXEC_ID,
      exitCode: 1,
      success: false,
    });
    expect(lines[0]).not.toContain("a secret line");
    expect(lines[0]).not.toContain("echo secret");
  });

  it("logs a stream failure and rethrows it to its caller", async () => {
    const error = new N8nSandboxError("TOOL_TIMEOUT", "deadline", { execId: EXEC_ID });
    const client = fakeClient({
      streamExecution: vi.fn(() => streamThatFails(EXEC_ID, error)),
    });
    const { log, lines } = captureLog();
    const service = new N8nSandboxService({ client, log });

    await expect(
      collect(service.streamExecution(SANDBOX_ID, { command: "sleep 60" }))
    ).rejects.toBe(error);

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({
      event: "n8n_sandbox_operation_failed",
      operation: "execute",
      code: "TOOL_TIMEOUT",
      sandboxId: SANDBOX_ID,
      execId: EXEC_ID,
    });
  });

  it("closes its client stream when the caller stops reading early, without logging success", async () => {
    let closed = false;
    async function* endless(): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult> {
      try {
        yield { seq: 0, type: "started", execId: EXEC_ID };
        yield { seq: 1, type: "stdout", data: "still going" };
        // Never reaches a terminal event.
        await new Promise(() => {});
        throw new Error("unreachable in this test");
      } finally {
        closed = true;
      }
    }

    const client = fakeClient({ streamExecution: vi.fn(() => endless()) });
    const { log, lines } = captureLog();
    const service = new N8nSandboxService({ client, log });

    const stream = service.streamExecution(SANDBOX_ID, { command: "tail -f /var/log/app.log" });
    await stream.next();
    await stream.return(undefined as unknown as N8nSandboxExecutionResult);

    expect(closed).toBe(true);
    expect(lines).toHaveLength(0);
  });

  it("returns a status read without writing the output into the log", async () => {
    const client = fakeClient();
    const { log, lines } = captureLog();
    const service = new N8nSandboxService({ client, log });

    const result = await service.getExecution(SANDBOX_ID, EXEC_ID);

    expect(result.ok).toBe(true);
    expect(client.getExecution).toHaveBeenCalledWith(SANDBOX_ID, EXEC_ID, {});
    expect(lines).toHaveLength(0);
  });

  it("checks the connection with a read and reports the count", async () => {
    const client = fakeClient();
    const { log, lines } = captureLog();
    const service = new N8nSandboxService({ client, log });

    const result = await service.checkConnection();

    expect(result).toEqual({ ok: true, data: { sandboxCount: 1 } });
    expect(client.checkConnection).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lines.at(-1)!).event).toBe("n8n_sandbox_connection_checked");
  });
});

describe("n8n Sandbox — the container builds it only when configured", () => {
  function buildEnv(values: Record<string, string>) {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("JWT_SECRET", "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA");
    vi.stubEnv("BROWSER_ENABLED", "false");
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  }

  it("is null when neither value is set", () => {
    buildEnv({});
    vi.stubEnv("N8N_SANDBOX_API_URL", "");
    vi.stubEnv("N8N_SANDBOX_API_KEY", "");

    expect(getContainer().n8nSandbox).toBeNull();
  });

  it("is an instance when both are set, and the start-up line names neither value", () => {
    buildEnv({
      N8N_SANDBOX_API_URL: BASE_URL,
      N8N_SANDBOX_API_KEY: API_KEY,
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    expect(getContainer().n8nSandbox).toBeInstanceOf(N8nSandboxService);
    const output = lines.join("\n");
    expect(output).toContain("n8n_sandbox_configured");
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain(BASE_URL);
    vi.restoreAllMocks();
  });
});

async function* streamOf(
  events: N8nSandboxEvent[],
  result: N8nSandboxExecutionResult
): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult> {
  for (const event of events) yield event;
  return result;
}

async function* streamThatFails(
  _execId: string,
  error: N8nSandboxError
): AsyncGenerator<N8nSandboxEvent, N8nSandboxExecutionResult> {
  yield { seq: 0, type: "started", execId: _execId };
  throw error;
}
