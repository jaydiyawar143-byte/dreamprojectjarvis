// S8.6 — how the MCP path fails, through the real execution authority.
//
// Each case registers a reviewed manifest with the container's own
// registerMcpTools into a real ToolRegistry, and runs it through a real
// ToolExecutor: PermissionService, its deadline, and the real AuditLogger over
// an in-memory repository. The servers are real processes — the pilot wherever
// it can show the case, the S8.2 fake server where only a misbehaving server
// can. Every failure must fail closed with the existing contract — a fixed
// sentence and an McpFailureCode, never the server's own text — and leave
// nothing running.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_MANIFEST,
  mcpFailure,
  mcpToolFingerprint,
  type AuditEntry,
  type IApprovalManager,
  type IAuditRepository,
  type McpManifest,
  type McpServerManifest,
  type McpToolManifestEntry,
  type ToolExecutionRequest,
} from "@jarvis/core";
import { MCP_RUNTIME, type McpConnection } from "@jarvis/mcp";
import { ToolExecutor, ToolRegistry, sanitizeToolResult } from "@jarvis/tools";
import { AuditLogger, PermissionService } from "@jarvis/security";
import { registerMcpTools } from "../src/services/container.js";

type Obj = Record<string, unknown>;

const PILOT = MCP_MANIFEST.servers[0]!;
const FIXTURES = new URL("../../../packages/mcp/test/fixtures/", import.meta.url);
const SPEC = JSON.parse(readFileSync(new URL("fake-tools.json", FIXTURES), "utf8")) as {
  serverInfo: { name: string; version: string };
  tools: Obj[];
};

const opened: McpConnection[] = [];
const dirs: string[] = [];
let audit: AuditEntry[];

const processes = () => process.getActiveResourcesInfo().filter((r) => r === "ProcessWrap").length;

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The S8.2 fake server in `mode`, reviewed as server "fake". `log` receives what `record` mode records. */
function fake(mode: string): { server: McpServerManifest; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mcp-pilot-failures-"));
  dirs.push(dir);
  const log = join(dir, "control");
  const tools = SPEC.tools.map(
    (tool) =>
      ({
        ...tool,
        id: `mcp.fake.${String(tool.name)}`,
        readOnly: true,
        risk: "READ_ONLY",
        requiresApproval: false,
        requiredPermissions: ["read", "execute"],
        enabled: true,
        fingerprint: mcpToolFingerprint(tool as never),
      }) as unknown as McpToolManifestEntry
  );
  return {
    server: {
      id: "fake",
      transport: { kind: "stdio", command: "node", args: [fileURLToPath(new URL("fake-server.mjs", FIXTURES)), mode, log, join(dir, "starts")] },
      env: {},
      expectedServerInfo: SPEC.serverInfo,
      tools,
    },
    log,
  };
}

/** The pilot as reviewed, with these changes. */
const pilot = (changes: Partial<McpServerManifest>): McpServerManifest => ({ ...PILOT, ...changes });

/** Register `servers` the way the container does, behind a real ToolExecutor. */
function executorFor(...servers: McpServerManifest[]): ToolExecutor {
  const registry = new ToolRegistry();
  const manifest: McpManifest = { servers };
  const connections = registerMcpTools(registry, manifest);
  expect(connections, "the manifest was refused").toHaveLength(servers.length);
  opened.push(...connections);
  const repository: IAuditRepository = {
    create: async (entry) => {
      const row = { ...entry, id: `audit-${audit.length + 1}`, timestamp: new Date() } as AuditEntry;
      audit.push(row);
      return row;
    },
    query: async () => [],
  };
  const approvals: IApprovalManager = { requestApproval: vi.fn(), findExistingForTool: vi.fn().mockResolvedValue(null) };
  return new ToolExecutor(registry, new PermissionService(), approvals, new AuditLogger(repository));
}

const request = (toolId: string, params: Obj, extra: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest => ({
  toolId,
  params,
  userId: "user-s8-6-failures",
  role: "admin",
  traceId: "trace-s8-6-failures",
  ...extra,
});

beforeEach(() => {
  audit = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((connection) => connection.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("C. failures fail closed with the existing MCP contract", () => {
  it("server unavailable: a server that cannot run is refused, then the breaker stops trying", async () => {
    const executor = executorFor(pilot({ transport: { ...PILOT.transport, args: ["pilot/no-such-server.mjs"] } }));
    const call = () => executor.execute(request("mcp.dates.day_of_week", { date: "2026-10-05" }));
    for (let i = 0; i < MCP_RUNTIME.breakerFailures; i++) {
      expect(await call()).toMatchObject({
        status: "failed",
        error: "The MCP server is unavailable.",
        result: { metadata: { mcpFailureCode: "INITIALIZATION_FAILED" } },
      });
    }
    expect(await call()).toMatchObject({ status: "failed", result: { metadata: { mcpFailureCode: "SERVER_UNAVAILABLE" } } });
    await until(() => processes() === 0);
  });

  it("initialization failure: refused, without the server's own error text", async () => {
    const result = await executorFor(fake("init_error").server).execute(request("mcp.fake.search_notes", { query: "x" }));
    expect(result).toMatchObject({
      status: "failed",
      error: mcpFailure("INITIALIZATION_FAILED").message,
      result: { metadata: { mcpFailureCode: "INITIALIZATION_FAILED" } },
    });
    expect(JSON.stringify(result)).not.toContain("fake initialize failure");
  });

  it("tool drift: a reviewed tool the live pilot no longer lists refuses the whole server", async () => {
    const extra: McpToolManifestEntry = {
      ...PILOT.tools[1]!,
      id: "mcp.dates.add_days",
      name: "add_days",
      description: "Adds days to a date.",
    };
    const executor = executorFor(pilot({ tools: [...PILOT.tools, { ...extra, fingerprint: mcpToolFingerprint(extra) }] }));
    const result = await executor.execute(request("mcp.dates.day_of_week", { date: "2026-10-05" }));
    expect(result).toMatchObject({
      status: "failed",
      error: mcpFailure("SCHEMA_INVALID").message,
      result: { metadata: { mcpFailureCode: "SCHEMA_INVALID" } },
    });
    await until(() => processes() === 0);
  });

  it("tool not found: a reviewed tool switched off is never registered; ToolExecutor refuses it and nothing starts", async () => {
    const executor = executorFor(pilot({ tools: [PILOT.tools[0]!, { ...PILOT.tools[1]!, enabled: false }] }));
    expect(await executor.execute(request("mcp.dates.day_of_week", { date: "2026-10-05" }))).toMatchObject({
      status: "failed",
      error: "Tool not found",
    });
    expect(processes()).toBe(0);
    // The rest of the reviewed server still works: verification takes away, never adds.
    expect(await executor.execute(request("mcp.dates.days_between", { start: "2026-01-01", end: "2026-03-01" }))).toMatchObject({
      status: "completed",
    });
  });

  it("invalid or malformed result: a tool error and an unreadable result are both REMOTE_ERROR, without server text", async () => {
    const invalid = await executorFor(PILOT).execute(request("mcp.dates.day_of_week", { date: "2026-02-30" }));
    expect(invalid).toMatchObject({ status: "failed", error: mcpFailure("REMOTE_ERROR").message });
    expect(JSON.stringify(invalid)).not.toContain("real calendar date");

    const malformed = await executorFor(fake("malformed_result").server).execute(request("mcp.fake.search_notes", { query: "x" }));
    expect(malformed).toMatchObject({
      status: "failed",
      error: mcpFailure("REMOTE_ERROR").message,
      result: { metadata: { mcpFailureCode: "REMOTE_ERROR" } },
    });
    expect(JSON.stringify(malformed)).not.toContain("not a list");
  });

  it("timeout: ToolExecutor's deadline ends the call and the stuck server is stopped", async () => {
    const executor = executorFor(fake("slow").server);
    const result = await executor.execute(request("mcp.fake.search_notes", { query: "x" }, { timeoutMs: 500 }));
    expect(result).toMatchObject({ status: "timed_out", error: "Execution timed out" });
    expect(opened[0]!.getState()).toBe("failed");
    await until(() => processes() === 0);
  });

  it("cancellation: the caller's abort reaches the tool, which reports CANCELLED and stops the stuck server", async () => {
    const executor = executorFor(fake("slow").server);
    const caller = new AbortController();
    const pending = executor.execute(request("mcp.fake.search_notes", { query: "x" }, { signal: caller.signal }));
    await until(() => opened[0]!.getState() === "ready");
    caller.abort();
    expect(await pending).toMatchObject({
      status: "failed",
      error: mcpFailure("CANCELLED").message,
      result: { metadata: { mcpFailureCode: "CANCELLED" } },
    });
    await until(() => opened[0]!.getState() === "failed" && processes() === 0);
  });
});

describe("B. what the server is sent, and what comes back", () => {
  it("receives no JARVIS identity: only the tool name and its reviewed arguments cross the wire", async () => {
    const { server, log } = fake("record");
    const executor = executorFor(server);
    const result = await executor.execute(
      request("mcp.fake.search_notes", { query: "alpha" }, {
        userId: "user-identity-must-not-cross",
        agentId: "conversational-assistant",
        conversationId: "conversation-identity-must-not-cross",
        traceId: "trace-identity-must-not-cross",
      })
    );
    expect(result.status).toBe("completed");

    const wire = existsSync(log) ? readFileSync(log, "utf8") : "";
    for (const identity of ["identity-must-not-cross", "conversational-assistant", "user-s8-6"]) {
      expect(wire, identity).not.toContain(identity);
    }
    const calls = wire
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Obj })
      .filter((message) => message.method === "tools/call");
    expect(calls.map((call) => call.params)).toEqual([{ name: "search_notes", arguments: { query: "alpha" } }]);
  });

  it("keeps a secret out of the audit row and out of what the model is shown; the result stays marked untrusted", async () => {
    const secret = "sk-live-AbCdEf1234567890AbCdEfGh";
    const result = await executorFor(fake("normal").server).execute(request("mcp.fake.search_notes", { query: `key ${secret}` }));
    expect(result.status).toBe("completed");
    expect(result.result?.metadata).toMatchObject({ treatedAsUntrustedData: true });

    // The audit row is redacted by the real AuditLogger.
    const executed = audit.filter((row) => row.action === "tool.execute");
    expect(executed).toHaveLength(1);
    expect(JSON.stringify(executed)).not.toContain(secret);
    // The assistant's tool-result envelope is built from exactly this sanitizer.
    expect(JSON.stringify(sanitizeToolResult(result.result!).result)).not.toContain(secret);
  });

  it("fails with fixed sentences only — no failure carries a secret or server text", async () => {
    const results = [
      await executorFor(fake("is_error").server).execute(request("mcp.fake.search_notes", { query: "x" })),
      await executorFor(fake("crash_on_call").server).execute(request("mcp.fake.search_notes", { query: "x" })),
    ];
    expect(results.map((r) => r.error)).toEqual([mcpFailure("REMOTE_ERROR").message, mcpFailure("SERVER_UNAVAILABLE").message]);
    expect(JSON.stringify(results)).not.toMatch(/Traceback|not-a-real-secret|line 42/);
  });
});
