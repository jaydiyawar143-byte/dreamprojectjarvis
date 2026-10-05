// S8.6 / S8.8 — the pilots: real, reviewed, read-only MCP servers.
//
// `pilot/dates-server.mjs` (S8.6) and `pilot/units-server.mjs` (S8.8) are real
// MCP servers on the pinned official SDK's server stack — real initialize,
// protocol negotiation, tools/list and tools/call — not the hand-rolled fake.
// Each is reviewed into core's shipped MCP_MANIFEST as its own server and run
// here through McpConnection exactly as JARVIS runs it: from its reviewed,
// package-relative entry script, with only its reviewed environment (none),
// verified against its own review before any call.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_MANIFEST, mcpFailure, mcpReadToolIds, validateMcpManifest, type McpCallResult } from "@jarvis/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpConnection } from "../src/connection.js";

const PILOT_DIR = new URL("../pilot/", import.meta.url);
const read = (url: URL) => readFileSync(url, "utf8").replace(/\r\n/g, "\n");

const opened: McpConnection[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((connection) => connection.close()));
});

/** A managed connection to the shipped review of one server. */
function reviewed(serverId: string): McpConnection {
  const server = MCP_MANIFEST.servers.find((s) => s.id === serverId);
  if (!server) throw new Error(`no reviewed server ${serverId}`);
  const connection = new McpConnection(server);
  opened.push(connection);
  return connection;
}

const processes = () => process.getActiveResourcesInfo().filter((r) => r === "ProcessWrap").length;

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function textOf(result: McpCallResult): string {
  if (!result.ok || result.content[0]?.type !== "text") throw new Error("expected a text result");
  return result.content[0].text;
}

// ---------------------------------------------------------------------------

describe("the shipped review", () => {
  it("holds two independently reviewed servers — dates and units — valid, and every tool read-only", () => {
    expect(MCP_MANIFEST.servers.map((s) => s.id)).toEqual(["dates", "units"]);
    expect(validateMcpManifest(MCP_MANIFEST).valid).toBe(true);
    expect(mcpReadToolIds(MCP_MANIFEST)).toEqual([
      "mcp.dates.days_between",
      "mcp.dates.day_of_week",
      "mcp.units.convert_length",
      "mcp.units.convert_temperature",
    ]);
    for (const server of MCP_MANIFEST.servers) {
      expect(server.env, server.id).toEqual({});
      expect(server.transport.args, server.id).toEqual([`pilot/${server.id}-server.mjs`]);
      for (const tool of server.tools) {
        expect(tool).toMatchObject({ readOnly: true, risk: "READ_ONLY", requiresApproval: false });
      }
    }
    expect(MCP_MANIFEST.servers.map((s) => s.expectedServerInfo.name)).toEqual(["jarvis-dates", "jarvis-units"]);
  });

  it("cannot be edited at runtime", () => {
    for (const server of MCP_MANIFEST.servers) {
      expect(Object.isFrozen(server.tools[0]!.inputSchema.properties), server.id).toBe(true);
      expect(() => {
        (server.tools[0] as { description: string }).description = "Edited at runtime.";
      }).toThrow();
    }
  });
});

describe("the dates pilot, through McpConnection", () => {
  it("starts from its reviewed relative entry script and verifies against its review", async () => {
    const connection = reviewed("dates");
    expect(await connection.connect()).toEqual({ ok: true });
    const offered = connection.listVerifiedTools();
    expect(offered).toHaveLength(2);
    expect(offered[0]).toBe(MCP_MANIFEST.servers[0]!.tools[0]);
    expect(offered[1]).toBe(MCP_MANIFEST.servers[0]!.tools[1]);
  });

  it("answers both tools from the calendar alone", async () => {
    const connection = reviewed("dates");
    await connection.connect();
    expect(textOf(await connection.callTool("days_between", { start: "2026-01-01", end: "2026-03-01" }))).toBe(
      "59 days from 2026-01-01 to 2026-03-01."
    );
    expect(textOf(await connection.callTool("days_between", { start: "2026-03-01", end: "2026-01-01" }))).toBe(
      "-59 days from 2026-03-01 to 2026-01-01."
    );
    expect(textOf(await connection.callTool("day_of_week", { date: "2026-10-05" }))).toBe("2026-10-05 is a Monday.");
    expect(textOf(await connection.callTool("day_of_week", { date: "2024-02-29" }))).toBe("2024-02-29 is a Thursday.");
  });

  it("refuses an impossible date as a tool error — never rolled over, never with the server's text", async () => {
    const connection = reviewed("dates");
    await connection.connect();
    for (const date of ["2026-02-30", "2026-13-01", "26-01-01"]) {
      expect(await connection.callTool("day_of_week", { date })).toEqual({ ok: false, failure: mcpFailure("REMOTE_ERROR") });
    }
    expect(connection.getState()).toBe("ready");
  });

  it("is stateless: repeated calls give the same answer on one process, and close ends it", async () => {
    // A process closed by the test before can take a moment to release its handle.
    await until(() => processes() === 0);
    const before = processes();
    const connection = reviewed("dates");
    await connection.connect();
    const first = await connection.callTool("days_between", { start: "2026-01-01", end: "2026-12-31" });
    const second = await connection.callTool("days_between", { start: "2026-01-01", end: "2026-12-31" });
    expect(second).toEqual(first);
    expect(processes()).toBe(before + 1);
    await connection.close();
    await until(() => processes() === before);
  });
});

describe("the units pilot (S8.8), through McpConnection", () => {
  it("starts from its own reviewed entry script and verifies against its own review", async () => {
    const connection = reviewed("units");
    expect(await connection.connect()).toEqual({ ok: true });
    const units = MCP_MANIFEST.servers[1]!;
    expect(connection.listVerifiedTools()).toEqual([units.tools[0], units.tools[1]]);
    expect(connection.listVerifiedTools()[0]).toBe(units.tools[0]);
  });

  it("converts lengths and temperatures by fixed arithmetic, to six significant figures", async () => {
    const connection = reviewed("units");
    await connection.connect();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["convert_length", { value: 5, from: "km", to: "mi" }, "5 km is 3.10686 mi."],
      ["convert_length", { value: 1, from: "mi", to: "ft" }, "1 mi is 5280 ft."],
      ["convert_length", { value: 30, from: "cm", to: "in" }, "30 cm is 11.811 in."],
      ["convert_temperature", { value: 100, from: "C", to: "F" }, "100 C is 212 F."],
      ["convert_temperature", { value: 98.6, from: "F", to: "C" }, "98.6 F is 37 C."],
      ["convert_temperature", { value: 0, from: "K", to: "C" }, "0 K is -273.15 C."],
    ];
    for (const [tool, args, expected] of cases) {
      expect(textOf(await connection.callTool(tool, args)), `${tool} ${JSON.stringify(args)}`).toBe(expected);
    }
  });

  it("refuses a temperature below absolute zero as a tool error, and a unit outside its review before sending", async () => {
    const connection = reviewed("units");
    await connection.connect();
    expect(await connection.callTool("convert_temperature", { value: -300, from: "C", to: "K" })).toEqual({
      ok: false,
      failure: mcpFailure("REMOTE_ERROR"),
    });
    expect(await connection.callTool("convert_length", { value: 1, from: "league", to: "m" })).toEqual({
      ok: false,
      failure: mcpFailure("INVALID_ARGUMENTS"),
    });
    expect(connection.getState()).toBe("ready");
  });
});

describe("what each pilot offers on the wire", () => {
  it.each(MCP_MANIFEST.servers.map((s) => [s.id] as const))(
    "%s declares tools only — no resources, prompts, completions or logging — and its reviewed identity",
    async (serverId) => {
      const server = MCP_MANIFEST.servers.find((s) => s.id === serverId)!;
      const client = new Client({ name: "s8-probe", version: "1.0.0" });
      const script = fileURLToPath(new URL(server.transport.args[0]!.replace(/^pilot\//, ""), PILOT_DIR));
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [script] }));
      try {
        expect(client.getServerCapabilities()).toEqual({ tools: {} });
        expect(client.getServerVersion()).toMatchObject(server.expectedServerInfo);
      } finally {
        await client.close();
      }
    }
  );
});

describe("pilot boundaries", () => {
  const pilots = readdirSync(PILOT_DIR).filter((file) => file.endsWith(".mjs"));

  it("are exactly the reviewed servers' entry scripts", () => {
    expect(pilots.sort()).toEqual(MCP_MANIFEST.servers.map((s) => `${s.id}-server.mjs`).sort());
  });

  it.each(pilots.map((file) => [file] as const))(
    "%s is plain arithmetic: the SDK server, stdio and nothing else — no fs, network, process or environment",
    (file) => {
      const source = read(new URL(file, PILOT_DIR));
      const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
      expect(specifiers).toEqual([
        "@modelcontextprotocol/sdk/server/index.js",
        "@modelcontextprotocol/sdk/server/stdio.js",
        "@modelcontextprotocol/sdk/types.js",
      ]);
      expect(source).not.toMatch(/process\.env|import\(|require\(|child_process|node:|Date\.now|new Date\(\)/);
    }
  );

  it("are never imported by the runtime: packages/mcp/src stays client-only", () => {
    const src = new URL("../src/", import.meta.url);
    for (const file of readdirSync(src)) {
      expect(read(new URL(file, src)), file).not.toMatch(/pilot|sdk\/server/);
    }
  });
});
