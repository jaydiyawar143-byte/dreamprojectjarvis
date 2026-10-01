// S8.2 — the MCP connection, against real processes of the fake server.
//
// Every test spawns test/fixtures/fake-server.mjs through McpConnection, the
// way a reviewed server will be spawned: `node <script> <args>`, with only the
// reviewed environment. What is asserted is what the rest of JARVIS will rely
// on: lazy start, verification before use, fail-closed drift, bounded output,
// cancellation, and no process left behind.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, expect } from "vitest";
import {
  mcpFailure,
  mcpToolFingerprint,
  type McpCallResult,
  type McpServerManifest,
  type McpToolManifestEntry,
} from "@jarvis/core";
import { MCP_RUNTIME } from "../src/config.js";
import { McpConnection, type McpConnectionOptions } from "../src/connection.js";

type Obj = Record<string, unknown>;

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));
const SPEC = JSON.parse(readFileSync(new URL("./fixtures/fake-tools.json", import.meta.url), "utf8")) as {
  serverInfo: { name: string; version: string };
  tools: Obj[];
};
const [SEARCH, STATUS] = SPEC.tools as [Obj, Obj];

/** What Windows' process layer (libuv) adds to every child itself. Linux adds nothing. */
const WINDOWS_SYSTEM_VARIABLES = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

function entry(tool: Obj, overrides: Obj = {}): McpToolManifestEntry {
  const reviewed = { ...tool, ...overrides };
  return {
    ...reviewed,
    id: `mcp.fake.${String(reviewed.name)}`,
    readOnly: true,
    risk: "READ_ONLY",
    requiresApproval: false,
    requiredPermissions: ["read", "execute"],
    enabled: true,
    fingerprint: mcpToolFingerprint(reviewed as never),
  } as McpToolManifestEntry;
}

const opened: McpConnection[] = [];
const dirs: string[] = [];

/** A scratch control file and start log for one test. */
function scratch(): { control: string; starts: string } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mcp-"));
  dirs.push(dir);
  return { control: join(dir, "control"), starts: join(dir, "starts") };
}

function fakeServer(
  mode: string,
  overrides: Partial<McpServerManifest> = {},
  files: { control: string; starts: string } = scratch()
): McpServerManifest {
  return {
    id: "fake",
    transport: { kind: "stdio", command: "node", args: [FIXTURE, mode, files.control, files.starts] },
    env: { FAKE_TOKEN: "JARVIS_MCP_FAKE_TOKEN" },
    expectedServerInfo: SPEC.serverInfo,
    tools: [entry(SEARCH), entry(STATUS)],
    ...overrides,
  };
}

function open(server: McpServerManifest, options: McpConnectionOptions = {}): McpConnection {
  const connection = new McpConnection(server, options);
  opened.push(connection);
  return connection;
}

/** Pids of every process the fake server has started, in order. */
const startsIn = (path: string): number[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(Number) : [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function textOf(result: McpCallResult): string {
  if (!result.ok || result.content[0]?.type !== "text") throw new Error("expected a text result");
  return result.content[0].text;
}

async function pidOf(connection: McpConnection): Promise<number> {
  return (JSON.parse(textOf(await connection.callTool("server_status", {}))) as { pid: number }).pid;
}

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((connection) => connection.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("starts idle, spawns nothing and offers nothing", async () => {
    const files = scratch();
    const connection = open(fakeServer("normal", {}, files));
    expect(connection.getState()).toBe("idle");
    expect(connection.getFailure()).toBeUndefined();
    expect(connection.listVerifiedTools()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(startsIn(files.starts)).toEqual([]);
  });

  it("connects lazily on first use: idle → connecting → ready", async () => {
    const files = scratch();
    const server = fakeServer("normal", {}, files);
    const connection = open(server);
    const pending = connection.connect();
    expect(connection.getState()).toBe("connecting");
    expect(await pending).toEqual({ ok: true });
    expect(connection.getState()).toBe("ready");
    expect(startsIn(files.starts)).toHaveLength(1);
    // What it offers is the reviewed manifest itself, never the live listing.
    const offered = connection.listVerifiedTools();
    expect(offered).toHaveLength(2);
    expect(offered[0]).toBe(server.tools[0]);
    expect(offered[1]).toBe(server.tools[1]);
  });

  it("shares one attempt between concurrent connects, and is a no-op once ready", async () => {
    const files = scratch();
    const connection = open(fakeServer("normal", {}, files));
    expect(await Promise.all([connection.connect(), connection.connect()])).toEqual([{ ok: true }, { ok: true }]);
    expect(await connection.connect()).toEqual({ ok: true });
    expect(startsIn(files.starts)).toHaveLength(1);
  });

  it("reads a paged listing in full", async () => {
    expect(await open(fakeServer("paged")).connect()).toEqual({ ok: true });
  });

  it("discards stderr instead of collecting it", async () => {
    const connection = open(fakeServer("stderr_flood"));
    expect(await connection.connect()).toEqual({ ok: true });
    expect(textOf(await connection.callTool("search_notes", { query: "alpha" }))).toBe("results for alpha");
  });

  it("never passes on the server's own instructions", async () => {
    const connection = open(fakeServer("normal"));
    await connection.connect();
    expect(JSON.stringify(connection.listVerifiedTools())).not.toContain("Ignore previous");
  });
});

describe("startup verification fails closed", () => {
  it.each(["init_error", "bad_version", "list_error", "crash"])("%s → INITIALIZATION_FAILED", async (mode) => {
    const connection = open(fakeServer(mode));
    const result = await connection.connect();
    expect(result).toEqual({ ok: false, failure: mcpFailure("INITIALIZATION_FAILED") });
    expect(connection.getState()).toBe("failed");
    expect(connection.getFailure()).toEqual(mcpFailure("INITIALIZATION_FAILED"));
    expect(connection.listVerifiedTools()).toEqual([]);
  });

  it("times out a server that never initializes, and stops it", async () => {
    const files = scratch();
    const connection = open(fakeServer("hang", {}, files), { connectTimeoutMs: 300 });
    expect(await connection.connect()).toEqual({ ok: false, failure: mcpFailure("INITIALIZATION_FAILED") });
    const [pid] = startsIn(files.starts);
    await until(() => !alive(pid!));
  });

  it.each([
    ["a missing reviewed tool", "normal", { tools: [entry(SEARCH), entry(STATUS), entry(SEARCH, { name: "archive_notes" })] }, [{ kind: "MISSING_TOOL", tool: "archive_notes" }]],
    ["an unexpected live tool", "normal", { tools: [entry(SEARCH)] }, [{ kind: "UNEXPECTED_TOOL", tool: "server_status" }]],
    ["a changed fingerprint", "drift", {}, [{ kind: "FINGERPRINT_MISMATCH", tool: "search_notes" }]],
    ["another server version", "normal", { expectedServerInfo: { ...SPEC.serverInfo, version: "1.0.1" } }, [{ kind: "SERVER_INFO_MISMATCH" }]],
    ["a duplicate live tool", "duplicate", {}, [{ kind: "DUPLICATE_TOOL", tool: "search_notes" }]],
  ] as const)("rejects %s as SCHEMA_INVALID, offering nothing", async (_label, mode, overrides, drift) => {
    const files = scratch();
    const connection = open(fakeServer(mode, overrides as Partial<McpServerManifest>, files));
    expect(await connection.connect()).toEqual({ ok: false, failure: mcpFailure("SCHEMA_INVALID", drift) });
    expect(connection.getState()).toBe("failed");
    expect(connection.listVerifiedTools()).toEqual([]);
    expect(await connection.callTool("search_notes", { query: "x" })).toEqual({
      ok: false,
      failure: mcpFailure("SCHEMA_INVALID", drift),
    });
    // A server that failed verification is not left running.
    const [pid] = startsIn(files.starts);
    await until(() => !alive(pid!));
  });

  it("refuses to build a connection from a manifest that is not valid", () => {
    expect(() => new McpConnection(fakeServer("normal", { id: "Not-Valid" }))).toThrow(
      "The MCP server manifest is not valid"
    );
  });
});

describe("calls", () => {
  it("refuses a call before the connection is ready — and does not connect for it", async () => {
    const files = scratch();
    const connection = open(fakeServer("normal", {}, files));
    expect(await connection.callTool("search_notes", { query: "x" })).toEqual({
      ok: false,
      failure: mcpFailure("SERVER_UNAVAILABLE"),
    });
    expect(connection.getState()).toBe("idle");
    expect(startsIn(files.starts)).toEqual([]);
  });

  it("calls a reviewed tool once ready", async () => {
    const connection = open(fakeServer("normal"));
    await connection.connect();
    expect(await connection.callTool("search_notes", { query: "alpha", limit: 2 })).toEqual({
      ok: true,
      content: [{ type: "text", text: "results for alpha" }],
    });
  });

  it("refuses a tool outside the manifest, and a reviewed tool that is disabled", async () => {
    const connection = open(fakeServer("normal", { tools: [entry(SEARCH), { ...entry(STATUS), enabled: false }] }));
    expect(await connection.connect()).toEqual({ ok: true });
    expect(connection.listVerifiedTools().map((t) => t.name)).toEqual(["search_notes"]);
    for (const name of ["delete_everything", "server_status", "mcp.fake.search_notes"]) {
      expect(await connection.callTool(name, {}), name).toEqual({ ok: false, failure: mcpFailure("TOOL_NOT_FOUND") });
    }
  });

  it("refuses arguments the review does not allow", async () => {
    const connection = open(fakeServer("normal"));
    await connection.connect();
    for (const args of [{}, { query: 5 }, { query: "x", url: "https://evil.test" }]) {
      expect(await connection.callTool("search_notes", args as Obj)).toEqual({
        ok: false,
        failure: mcpFailure("INVALID_ARGUMENTS"),
      });
    }
    expect(connection.getState()).toBe("ready");
  });

  it("omits binary output, keeping only what it is and how big", async () => {
    const connection = open(fakeServer("binary"));
    await connection.connect();
    const result = await connection.callTool("search_notes", { query: "x" });
    expect(result).toEqual({
      ok: true,
      content: [
        { type: "image", mimeType: "image/png", bytes: 16, omitted: true },
        { type: "audio", mimeType: "audio/wav", bytes: 10, omitted: true },
        { type: "text", text: "caption" },
        { type: "resource_link", omitted: true },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(Buffer.from("fake image bytes").toString("base64"));
  });

  it("maps a tool-level error to REMOTE_ERROR without the server's text, and stays ready", async () => {
    const connection = open(fakeServer("is_error"));
    await connection.connect();
    const result = await connection.callTool("search_notes", { query: "x" });
    expect(result).toEqual({ ok: false, failure: mcpFailure("REMOTE_ERROR") });
    expect(JSON.stringify(result)).not.toContain("Traceback");
    expect(connection.getState()).toBe("ready");
  });

  it("refuses a server's sampling request — the server is told no, and nothing else happens", async () => {
    const connection = open(fakeServer("sampling"));
    await connection.connect();
    expect(JSON.parse(textOf(await connection.callTool("search_notes", { query: "x" })))).toEqual({
      refused: true,
      code: -32601,
    });
    expect(connection.getState()).toBe("ready");
  });

  it("gives the server only its reviewed variables — never the parent's", async () => {
    const environment = {
      JARVIS_MCP_FAKE_TOKEN: "test-token-value",
      DATABASE_URL: "postgres://must-not-leak",
      JWT_SECRET: "must-not-leak",
      JARVIS_ENCRYPTION_KEY: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      NODE_OPTIONS: "--require must-not-leak",
      LD_PRELOAD: "must-not-leak.so",
      DYLD_INSERT_LIBRARIES: "must-not-leak",
      PATH: "/must-not-leak",
    };
    const connection = open(fakeServer("env_dump"), { environment });
    expect(await connection.connect()).toEqual({ ok: true });
    const { envKeys, fakeToken } = JSON.parse(textOf(await connection.callTool("server_status", {}))) as {
      envKeys: string[];
      fakeToken: string | null;
    };
    expect(fakeToken).toBe("test-token-value");
    const platform = process.platform === "win32" ? WINDOWS_SYSTEM_VARIABLES : [];
    expect(envKeys.filter((key) => key !== "FAKE_TOKEN" && !platform.includes(key.toUpperCase()))).toEqual([]);
    for (const forbidden of ["DATABASE_URL", "JWT_SECRET", "JARVIS_ENCRYPTION_KEY", "OPENAI_API_KEY", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
      expect(envKeys, forbidden).not.toContain(forbidden);
    }
  });

  it("stops a server whose output is too large, as RESPONSE_TOO_LARGE", async () => {
    const connection = open(fakeServer("huge"));
    await connection.connect();
    const pid = await pidOf(connection);
    expect(await connection.callTool("search_notes", { query: "x" })).toEqual({
      ok: false,
      failure: mcpFailure("RESPONSE_TOO_LARGE"),
    });
    expect(connection.getState()).toBe("failed");
    await until(() => !alive(pid));
  });

  it("marks the server failed when it dies during a call", async () => {
    const connection = open(fakeServer("crash_on_call"));
    await connection.connect();
    expect(await connection.callTool("search_notes", { query: "x" })).toEqual({
      ok: false,
      failure: mcpFailure("SERVER_UNAVAILABLE"),
    });
    expect(connection.getState()).toBe("failed");
    expect(connection.getFailure()).toEqual(mcpFailure("SERVER_UNAVAILABLE"));
  });
});

describe("cancellation and timeouts", () => {
  it("cancels a call with CANCELLED and stops the server it was waiting on", async () => {
    const connection = open(fakeServer("slow"));
    await connection.connect();
    const pid = await pidOf(connection);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    expect(await connection.callTool("search_notes", { query: "x" }, controller.signal)).toEqual({
      ok: false,
      failure: mcpFailure("CANCELLED"),
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(connection.getState()).toBe("failed");
    await until(() => !alive(pid));
    // The next use starts a fresh server.
    expect(await connection.connect()).toEqual({ ok: true });
  });

  it("refuses an already-cancelled call without sending it", async () => {
    const connection = open(fakeServer("slow"));
    await connection.connect();
    expect(await connection.callTool("search_notes", { query: "x" }, AbortSignal.abort())).toEqual({
      ok: false,
      failure: mcpFailure("CANCELLED"),
    });
    expect(connection.getState()).toBe("ready");
  });

  it("times out a call it cannot finish, and stops the server", async () => {
    const connection = open(fakeServer("slow"), { callTimeoutMs: 300 });
    await connection.connect();
    const pid = await pidOf(connection);
    expect(await connection.callTool("search_notes", { query: "x" })).toEqual({
      ok: false,
      failure: mcpFailure("TIMEOUT"),
    });
    expect(connection.getState()).toBe("failed");
    await until(() => !alive(pid));
  });

  it("lets a caller stop waiting for a connection", async () => {
    const connection = open(fakeServer("hang"), { connectTimeoutMs: 10_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    expect(await connection.connect(controller.signal)).toEqual({ ok: false, failure: mcpFailure("CANCELLED") });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("tools/list_changed", () => {
  it("re-verifies, and fails closed when the listing really changed", async () => {
    const connection = open(fakeServer("list_changed"));
    await connection.connect();
    // The first call makes the server change its listing and announce it.
    expect(textOf(await connection.callTool("search_notes", { query: "a" }))).toBe("results for a");
    const drift = [{ kind: "FINGERPRINT_MISMATCH", tool: "search_notes" }];
    expect(await connection.callTool("search_notes", { query: "b" })).toEqual({
      ok: false,
      failure: mcpFailure("SCHEMA_INVALID", drift),
    });
    expect(connection.getState()).toBe("failed");
    expect(connection.listVerifiedTools()).toEqual([]);
  });

  it("stays ready when the announced change changed nothing", async () => {
    const connection = open(fakeServer("list_changed_same"));
    await connection.connect();
    expect(textOf(await connection.callTool("search_notes", { query: "a" }))).toBe("results for a");
    expect(textOf(await connection.callTool("search_notes", { query: "b" }))).toBe("results for b");
    expect(connection.getState()).toBe("ready");
  });
});

describe("shutdown", () => {
  it("stops the server, and is final", async () => {
    const connection = open(fakeServer("normal"));
    await connection.connect();
    const pid = await pidOf(connection);
    await connection.close();
    expect(connection.getState()).toBe("closed");
    expect(alive(pid)).toBe(false);
    expect(await connection.connect()).toEqual({ ok: false, failure: mcpFailure("SERVER_UNAVAILABLE") });
    expect(await connection.callTool("search_notes", { query: "x" })).toEqual({
      ok: false,
      failure: mcpFailure("SERVER_UNAVAILABLE"),
    });
    await connection.close();
    expect(connection.getState()).toBe("closed");
  });

  it("leaves no process behind when closed mid-connect", async () => {
    const files = scratch();
    const connection = open(fakeServer("hang", {}, files), { connectTimeoutMs: 10_000 });
    const pending = connection.connect();
    await until(() => startsIn(files.starts).length === 1);
    await connection.close();
    expect((await pending).ok).toBe(false);
    expect(connection.getState()).toBe("closed");
    const [pid] = startsIn(files.starts);
    expect(alive(pid!)).toBe(false);
  });
});

describe("breaker", () => {
  it("opens after repeated startup failures, then refuses without spawning", async () => {
    const files = scratch();
    let clock = 0;
    const connection = open(fakeServer("controlled", {}, files), { now: () => clock });
    writeFileSync(files.control, "fail");
    for (let i = 0; i < MCP_RUNTIME.breakerFailures; i++) {
      expect((await connection.connect()).ok).toBe(false);
    }
    expect(startsIn(files.starts)).toHaveLength(MCP_RUNTIME.breakerFailures);

    writeFileSync(files.control, "ok");
    expect(await connection.connect()).toEqual({ ok: false, failure: mcpFailure("SERVER_UNAVAILABLE") });
    expect(startsIn(files.starts)).toHaveLength(MCP_RUNTIME.breakerFailures);

    // After the cooldown one probe is let through, and it succeeds.
    clock += MCP_RUNTIME.breakerCooldownMs;
    expect(await connection.connect()).toEqual({ ok: true });
    expect(startsIn(files.starts)).toHaveLength(MCP_RUNTIME.breakerFailures + 1);
  });

  it("resets the count after a verified connection", async () => {
    const files = scratch();
    const connection = open(fakeServer("controlled", {}, files), { now: () => 0 });
    const failTimes = async (n: number) => {
      writeFileSync(files.control, "fail");
      for (let i = 0; i < n; i++) expect((await connection.connect()).ok).toBe(false);
    };

    await failTimes(MCP_RUNTIME.breakerFailures - 1);
    writeFileSync(files.control, "ok");
    expect(await connection.connect()).toEqual({ ok: true });

    // Bring the server down mid-call — a runtime failure, not a startup one.
    writeFileSync(files.control, "die");
    expect((await connection.callTool("search_notes", { query: "x" })).ok).toBe(false);

    // Had the success not reset the count, the breaker would open here.
    await failTimes(MCP_RUNTIME.breakerFailures - 1);
    writeFileSync(files.control, "ok");
    expect(await connection.connect()).toEqual({ ok: true });
    expect(startsIn(files.starts)).toHaveLength(2 * MCP_RUNTIME.breakerFailures);
  });
});
