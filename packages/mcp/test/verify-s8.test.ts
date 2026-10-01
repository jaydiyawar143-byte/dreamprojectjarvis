// S8.5 — McpConnection.verify(): the on-demand health check, against real
// processes of the fake server.
//
// What the integration health check relies on: an idle server is started and
// verified exactly as connect() does; a running one is asked for its tools
// again, NOW, and compared with the review — so a server that drifted or hung
// after it started is caught by the check rather than by the next tool call.
// It only ever fails a server, never adds a tool, and never goes around the
// breaker or a close().
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mcpFailure, mcpToolFingerprint, type McpServerManifest, type McpToolManifestEntry } from "@jarvis/core";
import { MCP_RUNTIME } from "../src/config.js";
import { McpConnection, type McpConnectionOptions } from "../src/connection.js";

type Obj = Record<string, unknown>;

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));
const SPEC = JSON.parse(readFileSync(new URL("./fixtures/fake-tools.json", import.meta.url), "utf8")) as {
  serverInfo: { name: string; version: string };
  tools: Obj[];
};

function entry(tool: Obj): McpToolManifestEntry {
  return {
    ...tool,
    id: `mcp.fake.${String(tool.name)}`,
    readOnly: true,
    risk: "READ_ONLY",
    requiresApproval: false,
    requiredPermissions: ["read", "execute"],
    enabled: true,
    fingerprint: mcpToolFingerprint(tool as never),
  } as McpToolManifestEntry;
}

const opened: McpConnection[] = [];
const dirs: string[] = [];

/** A controllable fake server, its control file and its start log. */
function controlled(options: McpConnectionOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mcp-verify-"));
  dirs.push(dir);
  const control = join(dir, "control");
  const starts = join(dir, "starts");
  const server: McpServerManifest = {
    id: "fake",
    transport: { kind: "stdio", command: "node", args: [FIXTURE, "controlled", control, starts] },
    env: {},
    expectedServerInfo: SPEC.serverInfo,
    tools: SPEC.tools.map(entry),
  };
  const connection = new McpConnection(server, options);
  opened.push(connection);
  return {
    server,
    connection,
    set: (value: string) => writeFileSync(control, value),
    starts: (): number[] =>
      existsSync(starts) ? readFileSync(starts, "utf8").split("\n").filter(Boolean).map(Number) : [],
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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

describe("a server that is not running", () => {
  it("is started and verified, exactly as connect() would", async () => {
    const fake = controlled();
    expect(fake.connection.serverId).toBe("fake");
    expect(await fake.connection.verify()).toEqual({ ok: true });
    expect(fake.connection.getState()).toBe("ready");
    expect(fake.starts()).toHaveLength(1);
  });

  it("is started once for concurrent checks", async () => {
    const fake = controlled();
    expect(await Promise.all([fake.connection.verify(), fake.connection.verify()])).toEqual([{ ok: true }, { ok: true }]);
    expect(fake.starts()).toHaveLength(1);
  });

  it("is refused without spawning while the breaker is open", async () => {
    const fake = controlled({ now: () => 0 });
    fake.set("fail");
    for (let i = 0; i < MCP_RUNTIME.breakerFailures; i++) {
      expect(await fake.connection.verify()).toEqual({ ok: false, failure: mcpFailure("INITIALIZATION_FAILED") });
    }
    fake.set("ok");
    expect(await fake.connection.verify()).toEqual({ ok: false, failure: mcpFailure("SERVER_UNAVAILABLE") });
    expect(fake.starts()).toHaveLength(MCP_RUNTIME.breakerFailures);
  });

  it("is refused without spawning once closed", async () => {
    const fake = controlled();
    await fake.connection.connect();
    await fake.connection.close();
    expect(await fake.connection.verify()).toEqual({ ok: false, failure: mcpFailure("SERVER_UNAVAILABLE") });
    expect(fake.starts()).toHaveLength(1);
  });

  it("is restarted after it died — a fresh, verified process", async () => {
    const fake = controlled();
    await fake.connection.connect();
    fake.set("die");
    expect((await fake.connection.callTool("search_notes", { query: "x" })).ok).toBe(false);
    expect(fake.connection.getState()).toBe("failed");
    fake.set("ok");
    expect(await fake.connection.verify()).toEqual({ ok: true });
    expect(fake.starts()).toHaveLength(2);
  });
});

describe("a running server is checked again, live", () => {
  it("stays ready on the same process when it still matches its review — and offers only the reviewed entries", async () => {
    const fake = controlled();
    await fake.connection.connect();
    expect(await fake.connection.verify()).toEqual({ ok: true });
    expect(fake.starts()).toHaveLength(1);
    const offered = fake.connection.listVerifiedTools();
    expect(offered).toHaveLength(2);
    expect(offered[0]).toBe(fake.server.tools[0]);
    expect(offered[1]).toBe(fake.server.tools[1]);
  });

  it("fails a server whose listing changed without announcing it, and stops it", async () => {
    const fake = controlled();
    await fake.connection.connect();
    const [pid] = fake.starts();
    fake.set("drift_list");
    const drift = [{ kind: "FINGERPRINT_MISMATCH", tool: "search_notes" }];
    expect(await fake.connection.verify()).toEqual({ ok: false, failure: mcpFailure("SCHEMA_INVALID", drift) });
    expect(fake.connection.getState()).toBe("failed");
    expect(fake.connection.listVerifiedTools()).toEqual([]);
    expect(await fake.connection.callTool("search_notes", { query: "x" })).toEqual({
      ok: false,
      failure: mcpFailure("SCHEMA_INVALID", drift),
    });
    await until(() => !alive(pid!));
  });

  it("times out a server that stopped answering, and stops it", async () => {
    const fake = controlled({ connectTimeoutMs: 500 });
    await fake.connection.connect();
    const [pid] = fake.starts();
    fake.set("hang_list");
    expect(await fake.connection.verify()).toEqual({ ok: false, failure: mcpFailure("TIMEOUT") });
    expect(fake.connection.getState()).toBe("failed");
    await until(() => !alive(pid!));
  });});
