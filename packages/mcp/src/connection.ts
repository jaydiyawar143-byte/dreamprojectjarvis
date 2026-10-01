// ---------------------------------------------------------------------------
// S8.2 — one reviewed MCP server, behind one connection.
//
//   idle ──connect()──▶ connecting ──verified──▶ ready
//                           │                       │  drift · crash · timeout ·
//                           ▼                       ▼  cancellation · oversize
//                        failed ◀───────────────────┘
//   failed ──connect()──▶ connecting        any ──close()──▶ closed (final)
//
// LAZY. Nothing is spawned until connect() is first called.
// VERIFIED. `ready` only after initialize, the full tools/list and a match with
//   the reviewed manifest: name, exact version, every tool's fingerprint,
//   nothing missing, nothing extra, nothing twice. Any difference fails
//   closed. tools/list_changed re-verifies; it can only fail the server,
//   never add a tool.
// ISOLATED. The server runs as `node <reviewed script> <reviewed args>`, with
//   no shell and exactly its reviewed environment. stderr is discarded; one
//   stdout message over the byte limit stops the server.
// BOUNDED. A per-server breaker (core's CircuitBreaker) keeps failing starts
//   from becoming a restart loop. Nothing here retries.
// What leaves this class is the manifest's own entries, normalised results
// and fixed failures — never live metadata or server text.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";
import {
  CircuitBreaker,
  mcpFailure,
  validateMcpArguments,
  validateMcpManifest,
  type McpCallPort,
  type McpCallResult,
  type McpConnectResult,
  type McpFailure,
  type McpFailureCode,
  type McpServerManifest,
  type McpToolManifestEntry,
} from "@jarvis/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { MCP_RUNTIME, serverEnvironment } from "./config.js";
import { failureFromError, normalizeCallResult, verifyServer } from "./normalize.js";

export type McpConnectionState = "idle" | "connecting" | "ready" | "failed" | "closed";

export interface McpConnectionOptions {
  /** Where the server's mapped `JARVIS_MCP_<ID>_…` variables are read. Default: process.env. */
  environment?: Readonly<Record<string, string | undefined>>;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxMessageBytes?: number;
  closeGraceMs?: number;
  /** The breaker's clock. */
  now?: () => number;
}

const READY: McpConnectResult = Object.freeze({ ok: true });

const refused = (code: McpFailureCode): { ok: false; failure: McpFailure } => ({
  ok: false,
  failure: mcpFailure(code),
});

/** Failures after which the server is stopped: it may be stuck, or its stream is broken. */
const STOPS_SERVER: ReadonlySet<McpFailureCode> = new Set([
  "CANCELLED",
  "TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "SERVER_UNAVAILABLE",
]);

/** One reviewed server. Implements core's McpCallPort, the only face the tool adapter sees. */
export class McpConnection implements McpCallPort {
  private state: McpConnectionState = "idle";
  private failure?: McpFailure;
  private verified: readonly McpToolManifestEntry[] = [];
  private client?: Client;
  private serverProcess?: ServerProcess;
  private attempt?: Promise<McpConnectResult>;
  private reverifying?: Promise<void>;
  private listChanged = false;
  /** Bumped whenever a client is discarded, so its late callbacks change nothing. */
  private generation = 0;
  private readonly breaker: CircuitBreaker;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly limits: {
    connectTimeoutMs: number;
    callTimeoutMs: number;
    maxMessageBytes: number;
    closeGraceMs: number;
  };

  constructor(
    private readonly server: McpServerManifest,
    options: McpConnectionOptions = {}
  ) {
    // The manifest is the authority, so it must be one: re-checked here, not trusted.
    if (!validateMcpManifest({ servers: [server] }).valid) {
      throw new Error("The MCP server manifest is not valid");
    }
    this.environment = options.environment ?? process.env;
    this.limits = {
      connectTimeoutMs: options.connectTimeoutMs ?? MCP_RUNTIME.connectTimeoutMs,
      callTimeoutMs: options.callTimeoutMs ?? MCP_RUNTIME.callTimeoutMs,
      maxMessageBytes: options.maxMessageBytes ?? MCP_RUNTIME.maxMessageBytes,
      closeGraceMs: options.closeGraceMs ?? MCP_RUNTIME.closeGraceMs,
    };
    this.breaker = new CircuitBreaker(
      {
        failureThreshold: MCP_RUNTIME.breakerFailures,
        openDurationMs: MCP_RUNTIME.breakerCooldownMs,
        halfOpenMaxProbes: 1,
      },
      options.now ? { now: options.now } : {}
    );
  }

  /** S8.5 — the reviewed id of the server this runs: manifest data, never live. */
  get serverId(): string {
    return this.server.id;
  }

  getState(): McpConnectionState {
    return this.state;
  }

  getFailure(): McpFailure | undefined {
    return this.failure;
  }

  /** The reviewed entries this server may run — the manifest's own objects. Empty unless ready. */
  listVerifiedTools(): readonly McpToolManifestEntry[] {
    return this.state === "ready" ? this.verified : [];
  }

  /**
   * Start and verify the server, once. Concurrent callers share one attempt;
   * a caller's signal ends only its own wait.
   */
  connect(signal?: AbortSignal): Promise<McpConnectResult> {
    if (signal?.aborted) return Promise.resolve(refused("CANCELLED"));
    if (this.state === "ready") return Promise.resolve(READY);
    if (this.state === "closed") return Promise.resolve(refused("SERVER_UNAVAILABLE"));
    this.attempt ??= this.start().finally(() => {
      this.attempt = undefined;
    });
    return signal ? untilAborted(this.attempt, signal) : this.attempt;
  }

  /** Call one reviewed, enabled tool. Never connects; never accepts a name outside the manifest. */
  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<McpCallResult> {
    if (this.reverifying) await this.reverifying;
    const tool = this.server.tools.find((t) => t.name === name && t.enabled);
    if (!tool) return refused("TOOL_NOT_FOUND");
    const { client, serverProcess: server, generation } = this;
    if (this.state !== "ready" || !client || !server) {
      return { ok: false, failure: this.state === "failed" && this.failure ? this.failure : mcpFailure("SERVER_UNAVAILABLE") };
    }
    if (!validateMcpArguments(tool, args)) return refused("INVALID_ARGUMENTS");
    if (signal?.aborted) return refused("CANCELLED");

    try {
      const result = await client.callTool({ name: tool.name, arguments: { ...args } }, undefined, {
        signal,
        timeout: this.limits.callTimeoutMs,
      });
      return normalizeCallResult(result);
    } catch (error) {
      const failure = signal?.aborted
        ? mcpFailure("CANCELLED")
        : server.stopReason
          ? mcpFailure(server.stopReason)
          : failureFromError(error, "call");
      // A call abandoned mid-flight may leave the server stuck on it; a broken
      // stream is a broken server. Either way it is stopped, not left running.
      if (STOPS_SERVER.has(failure.code)) await this.discard(generation, failure);
      return { ok: false, failure };
    }
  }

  /**
   * S8.5 — the on-demand health check. Not running: start and verify, as
   * connect() does — breaker and all. Running: list its tools again, now, and
   * compare them with the review, as tools/list_changed does. A difference, a
   * broken stream or no answer in time fails the server and stops it; this
   * never adds a tool and never retries.
   */
  async verify(): Promise<McpConnectResult> {
    if (this.reverifying) await this.reverifying;
    const { client, serverProcess: server, generation } = this;
    if (this.state !== "ready" || !client || !server) return this.connect();

    let failure: McpFailure | undefined;
    try {
      const listed = await this.listTools(client, AbortSignal.timeout(this.limits.connectTimeoutMs));
      const verdict = listed && verifyServer(this.server, client.getServerVersion(), listed);
      if (!verdict) failure = mcpFailure("RESPONSE_TOO_LARGE");
      else if (!verdict.ok) failure = mcpFailure("SCHEMA_INVALID", verdict.drift);
    } catch (error) {
      // The SDK reports a request past its deadline as a timeout.
      failure = server.stopReason ? mcpFailure(server.stopReason) : failureFromError(error, "call");
    }

    if (failure) {
      await this.discard(generation, failure);
      return { ok: false, failure };
    }
    // Closed, or failed by something else, while this check ran.
    return generation === this.generation ? READY : { ok: false, failure: this.failure ?? mcpFailure("SERVER_UNAVAILABLE") };
  }

  /** Stop the server and refuse everything after. Final. */
  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.failure = undefined;
    this.verified = [];
    this.generation++;
    const client = this.client;
    this.client = undefined;
    this.serverProcess = undefined;
    await client?.close();
  }

  // -------------------------------------------------------------------------

  private async start(): Promise<McpConnectResult> {
    const permit = this.breaker.acquire();
    if (!permit) {
      // Open breaker: refused without spawning anything.
      this.state = "failed";
      this.failure = mcpFailure("SERVER_UNAVAILABLE");
      return refused("SERVER_UNAVAILABLE");
    }

    const generation = ++this.generation;
    this.state = "connecting";
    this.failure = undefined;
    this.listChanged = false;
    const server = new ServerProcess(
      this.server.transport.args,
      serverEnvironment(this.server, this.environment),
      this.limits
    );
    // No capabilities: no sampling, no elicitation, no roots. A server that asks is told "method not found".
    const client = new Client({ name: "jarvis", version: "1.0.0" }, { capabilities: {}, enforceStrictCapabilities: true });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.onListChanged(generation));
    client.onclose = () => this.onServerClosed(generation, server);
    this.client = client;
    this.serverProcess = server;

    let failure: McpFailure | undefined;
    let tools: readonly McpToolManifestEntry[] = [];
    try {
      const deadline = AbortSignal.timeout(this.limits.connectTimeoutMs);
      await client.connect(server, { signal: deadline, timeout: this.limits.connectTimeoutMs });
      const listed = await this.listTools(client, deadline);
      const verdict = listed && verifyServer(this.server, client.getServerVersion(), listed);
      if (!verdict) failure = mcpFailure("RESPONSE_TOO_LARGE");
      else if (!verdict.ok) failure = mcpFailure("SCHEMA_INVALID", verdict.drift);
      else tools = verdict.tools;
    } catch (error) {
      failure = server.stopReason ? mcpFailure(server.stopReason) : failureFromError(error, "connect");
    }

    if (generation !== this.generation) {
      // Closed while connecting: not the server's fault, and close() stopped it.
      this.breaker.recordNeutral(permit);
      return refused("SERVER_UNAVAILABLE");
    }
    if (failure) {
      this.breaker.recordTransientFailure(permit);
      await this.discard(generation, failure);
      return { ok: false, failure };
    }
    this.breaker.recordSuccess(permit);
    this.verified = tools;
    this.state = "ready";
    if (this.listChanged) this.scheduleReverify(generation);
    return READY;
  }

  /** Every page of tools/list, or null when the listing runs past its bounds. */
  private async listTools(client: Client, signal: AbortSignal): Promise<unknown[] | null> {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_RUNTIME.maxListPages; page++) {
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        signal,
        timeout: this.limits.connectTimeoutMs,
      });
      tools.push(...result.tools);
      if (tools.length > MCP_RUNTIME.maxListedTools) return null;
      cursor = result.nextCursor;
      if (cursor === undefined) return tools;
    }
    return null;
  }

  private onListChanged(generation: number): void {
    if (generation !== this.generation) return;
    this.listChanged = true;
    // While connecting, start() re-verifies once it is ready.
    if (this.state === "ready") this.scheduleReverify(generation);
  }

  private scheduleReverify(generation: number): void {
    if (this.reverifying) return; // the running pass loops while a change is pending
    this.reverifying = this.reverify(generation).finally(() => {
      this.reverifying = undefined;
      if (this.listChanged && generation === this.generation && this.state === "ready") {
        this.scheduleReverify(generation);
      }
    });
  }

  /** Verify again after tools/list_changed. It can only fail the server — never add a tool. */
  private async reverify(generation: number): Promise<void> {
    while (this.listChanged && generation === this.generation && this.state === "ready" && this.client) {
      this.listChanged = false;
      const client = this.client;
      let failure: McpFailure | undefined;
      try {
        const listed = await this.listTools(client, AbortSignal.timeout(this.limits.connectTimeoutMs));
        const verdict = listed && verifyServer(this.server, client.getServerVersion(), listed);
        if (!verdict) failure = mcpFailure("RESPONSE_TOO_LARGE");
        else if (!verdict.ok) failure = mcpFailure("SCHEMA_INVALID", verdict.drift);
      } catch (error) {
        failure = failureFromError(error, "connect");
      }
      if (failure) {
        await this.discard(generation, failure);
        return;
      }
    }
  }

  private onServerClosed(generation: number, server: ServerProcess): void {
    // While connecting, the pending request fails and start() records it.
    if (generation !== this.generation || this.state !== "ready") return;
    void this.discard(generation, mcpFailure(server.stopReason ?? "SERVER_UNAVAILABLE"));
  }

  /** Fail this generation: stop its server and offer nothing until connect() succeeds again. */
  private async discard(generation: number, failure: McpFailure): Promise<void> {
    if (generation !== this.generation || this.state === "closed") return;
    this.generation++;
    this.state = "failed";
    this.failure = failure;
    this.verified = [];
    const client = this.client;
    this.client = undefined;
    this.serverProcess = undefined;
    await client?.close();
  }
}

/** The shared attempt, or CANCELLED as soon as this caller's signal aborts. */
function untilAborted(attempt: Promise<McpConnectResult>, signal: AbortSignal): Promise<McpConnectResult> {
  return new Promise((resolve) => {
    const onAbort = () => resolve(refused("CANCELLED"));
    signal.addEventListener("abort", onAbort, { once: true });
    void attempt.then((result) => {
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    });
  });
}

/**
 * The server process, as an MCP transport. Message framing and the byte limit
 * are the SDK's own ReadBuffer; spawning is done here, because the SDK's
 * StdioClientTransport always merges part of the parent's environment into
 * the child, and this must pass exactly the reviewed variables.
 */
class ServerProcess implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** Why this transport stopped the server itself, when it did. */
  stopReason?: McpFailureCode;

  private child?: ChildProcess;
  private stopping?: Promise<void>;
  private readonly buffer: ReadBuffer;

  constructor(
    private readonly args: readonly string[],
    private readonly env: Record<string, string>,
    private readonly limits: { maxMessageBytes: number; closeGraceMs: number }
  ) {
    this.buffer = new ReadBuffer({ maxBufferSize: limits.maxMessageBytes });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // `node` is the runtime JARVIS itself runs on: no PATH lookup, no shell.
      const child = spawn(process.execPath, [...this.args], {
        env: this.env,
        stdio: ["pipe", "pipe", "ignore"],
        shell: false,
        windowsHide: true,
      });
      this.child = child;
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("spawn", () => resolve());
      child.once("close", () => {
        this.child = undefined;
        this.buffer.clear();
        this.onclose?.();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return Promise.reject(new Error("Not connected"));
    return new Promise((resolve) => {
      if (stdin.write(serializeMessage(message))) return resolve();
      const done = () => {
        stdin.off("drain", done);
        stdin.off("close", done);
        resolve();
      };
      stdin.once("drain", done);
      stdin.once("close", done);
    });
  }

  close(): Promise<void> {
    this.stopping ??= this.terminate();
    return this.stopping;
  }

  private receive(chunk: Buffer): void {
    try {
      this.buffer.append(chunk);
    } catch {
      // One message past the limit: stop the server instead of reading on.
      this.stopReason ??= "RESPONSE_TOO_LARGE";
      this.child?.kill("SIGKILL");
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch (error) {
        // A malformed line is dropped; the request it was meant to answer times out.
        this.onerror?.(error as Error);
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  /** End of input first; SIGTERM if the server lingers; SIGKILL if it still does. */
  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const settle = (): Promise<void> =>
      Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, this.limits.closeGraceMs).unref())]);
    child.stdin?.end();
    await settle();
    if (this.child) {
      child.kill("SIGTERM");
      await settle();
    }
    if (this.child) {
      child.kill("SIGKILL");
      await settle();
    }
  }
}
