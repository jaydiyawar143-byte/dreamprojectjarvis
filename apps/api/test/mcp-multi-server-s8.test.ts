// S8.8 — several reviewed MCP servers, side by side.
//
// The shipped review holds two real servers — `dates` and `units` — each with
// its own identity, its own pinned listing and, once registered, its own
// managed connection, verification state and breaker. Everything here runs
// through the container's own registerMcpTools into a real ToolRegistry and a
// real ToolExecutor (PermissionService, deadline, the real AuditLogger over an
// in-memory repository), against real server processes. The S8.2 fake server
// stands in only where a server must misbehave, show its environment or record
// what it was sent.
//
// Pinned: one server's start, failure, drift, breaker, live metadata or
// secrets never reach the other; the presentation and the health check tell
// them apart; shutdown closes every one; nothing is ever added at runtime.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_MANIFEST,
  mcpFailure,
  mcpToolFingerprint,
  modelFacingToolName,
  type AuditEntry,
  type CapabilityView,
  type IApprovalManager,
  type IAuditRepository,
  type ITool,
  type McpServerManifest,
  type McpToolManifestEntry,
  type ToolExecutionRequest,
} from "@jarvis/core";
import { MCP_RUNTIME, type McpConnection } from "@jarvis/mcp";
import { ToolExecutor, ToolRegistry } from "@jarvis/tools";
import { AuditLogger, PermissionService } from "@jarvis/security";
import { registerMcpTools } from "../src/services/container.js";
import { CapabilityService } from "../src/services/capabilities/capability-service.js";
import { mcpToolUnavailable, runCheck, type IntegrationDeps } from "../src/services/integration-registry.js";

type Obj = Record<string, unknown>;

const [DATES, UNITS] = MCP_MANIFEST.servers as [McpServerManifest, McpServerManifest];
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

/** A shipped server under a review its live listing no longer matches. */
function drifted(server: McpServerManifest): McpServerManifest {
  const [first, ...rest] = server.tools;
  const reviewed = { ...first!, description: "Worded differently at an older review." };
  return { ...server, tools: [{ ...reviewed, fingerprint: mcpToolFingerprint(reviewed) }, ...rest] };
}

/** A shipped server whose entry script is missing: it cannot start. */
const broken = (server: McpServerManifest): McpServerManifest => ({
  ...server,
  transport: { ...server.transport, args: [`pilot/no-such-${server.id}-server.mjs`] },
});

/** The S8.2 fake server in `mode`, reviewed as server `id`. `log` is its control file / record log. */
function fake(id: string, mode: string, env: Record<string, string> = {}): { server: McpServerManifest; log: string; set(value: string): void } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mcp-multi-"));
  dirs.push(dir);
  const log = join(dir, "control");
  const tools = SPEC.tools.map(
    (tool) =>
      ({
        ...tool,
        id: `mcp.${id}.${String(tool.name)}`,
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
      id,
      transport: { kind: "stdio", command: "node", args: [fileURLToPath(new URL("fake-server.mjs", FIXTURES)), mode, log, join(dir, "starts")] },
      env,
      expectedServerInfo: SPEC.serverInfo,
      tools,
    },
    log,
    set: (value) => writeFileSync(log, value),
  };
}

const native: ITool = {
  id: "time.now",
  name: "time.now",
  description: "Current time.",
  category: "system",
  risk: "READ_ONLY",
  parameters: [],
  requiresApproval: false,
  requiredPermissions: ["read"],
  version: "1.0.0",
  enabled: true,
  execute: async () => ({ success: true, data: { now: "fixed" } }),
  validate: () => true,
};

interface Setup {
  registry: ToolRegistry;
  connections: McpConnection[];
  executor: ToolExecutor;
  of(serverId: string): McpConnection;
  call(toolId: string, params: Obj, extra?: Partial<ToolExecutionRequest>): ReturnType<ToolExecutor["execute"]>;
}

/** These servers, registered exactly as the container registers the shipped review, behind a real ToolExecutor. */
function register(...servers: McpServerManifest[]): Setup {
  const registry = new ToolRegistry();
  registry.register(native);
  const connections = registerMcpTools(registry, { servers });
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
  const executor = new ToolExecutor(registry, new PermissionService(), approvals, new AuditLogger(repository));
  return {
    registry,
    connections,
    executor,
    of: (serverId) => connections.find((c) => c.serverId === serverId)!,
    call: (toolId, params, extra = {}) =>
      executor.execute({ toolId, params, userId: "user-s8-8", role: "admin", traceId: "trace-s8-8", ...extra }),
  };
}

const DAYS_CALL = ["mcp.dates.days_between", { start: "2026-01-01", end: "2026-03-01" }] as const;
const LENGTH_CALL = ["mcp.units.convert_length", { value: 5, from: "km", to: "mi" }] as const;

beforeEach(async () => {
  audit = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  // A server closed by the test before can take a moment to release its handle.
  await until(() => processes() === 0);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((connection) => connection.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("B. registration — one connection and one registry entry per reviewed server and tool", () => {
  it("registers every enabled reviewed tool exactly once, under deterministic ids and model names, each server on its own idle connection", () => {
    const { registry, connections } = register(DATES, UNITS);
    const ids = registry.getAll().map((t) => t.id).filter((id) => id.startsWith("mcp."));
    expect(ids).toEqual([
      "mcp.dates.days_between",
      "mcp.dates.day_of_week",
      "mcp.units.convert_length",
      "mcp.units.convert_temperature",
    ]);
    expect(ids.map(modelFacingToolName)).toEqual([
      "mcp-dates-days_between",
      "mcp-dates-day_of_week",
      "mcp-units-convert_length",
      "mcp-units-convert_temperature",
    ]);
    expect(new Set(ids.map(modelFacingToolName)).size).toBe(ids.length);
    expect(connections.map((c) => [c.serverId, c.getState()])).toEqual([
      ["dates", "idle"],
      ["units", "idle"],
    ]);
    expect(new Set(connections).size).toBe(2);
  });
});

describe("C/D. lazy and independent starts", () => {
  it("C: calling a dates tool starts dates alone", async () => {
    const setup = register(DATES, UNITS);
    expect(await setup.call(...DAYS_CALL)).toMatchObject({ status: "completed" });
    expect([setup.of("dates").getState(), setup.of("units").getState()]).toEqual(["ready", "idle"]);
    expect(processes()).toBe(1);
  });

  it("D: calling a units tool starts units alone", async () => {
    const setup = register(DATES, UNITS);
    expect(await setup.call(...LENGTH_CALL)).toMatchObject({
      status: "completed",
      result: { data: { content: [{ type: "text", text: "5 km is 3.10686 mi." }] } },
    });
    expect([setup.of("dates").getState(), setup.of("units").getState()]).toEqual(["idle", "ready"]);
    expect(processes()).toBe(1);
  });
});

describe("E–H. one server's failure or drift never reaches the other", () => {
  it("E: a dates server that cannot start — breaker opened and all — leaves units fully usable", async () => {
    const setup = register(broken(DATES), UNITS);
    for (let i = 0; i < MCP_RUNTIME.breakerFailures; i++) {
      expect(await setup.call(...DAYS_CALL)).toMatchObject({ status: "failed", error: "The MCP server is unavailable." });
    }
    // dates' breaker is open now; it refuses without spawning anything.
    expect(await setup.call(...DAYS_CALL)).toMatchObject({ result: { metadata: { mcpFailureCode: "SERVER_UNAVAILABLE" } } });
    expect(setup.of("units").getState()).toBe("idle");
    expect(await setup.call(...LENGTH_CALL)).toMatchObject({ status: "completed" });
    expect([setup.of("dates").getState(), setup.of("units").getState()]).toEqual(["failed", "ready"]);
  });

  it("F: a units server that cannot start leaves dates fully usable", async () => {
    const setup = register(DATES, broken(UNITS));
    expect(await setup.call(...LENGTH_CALL)).toMatchObject({ status: "failed" });
    expect(await setup.call(...DAYS_CALL)).toMatchObject({ status: "completed" });
    expect([setup.of("dates").getState(), setup.of("units").getState()]).toEqual(["ready", "failed"]);
  });

  it("G: dates drift refuses dates alone — units keeps answering", async () => {
    const setup = register(drifted(DATES), UNITS);
    expect(await setup.call(...DAYS_CALL)).toMatchObject({ status: "failed", error: mcpFailure("SCHEMA_INVALID").message });
    expect(await setup.call(...LENGTH_CALL)).toMatchObject({ status: "completed" });
    expect([setup.of("dates").getState(), setup.of("units").getState()]).toEqual(["failed", "ready"]);
  });

  it("H: units drift refuses units alone — dates keeps answering", async () => {
    const setup = register(DATES, drifted(UNITS));
    expect(await setup.call(...LENGTH_CALL)).toMatchObject({ status: "failed", error: mcpFailure("SCHEMA_INVALID").message });
    expect(await setup.call(...DAYS_CALL)).toMatchObject({ status: "completed" });
    expect([setup.of("dates").getState(), setup.of("units").getState()]).toEqual(["ready", "failed"]);
  });
});

describe("I. capability presentation tells the servers apart", () => {
  async function presentation(setup: Setup): Promise<Map<string, CapabilityView>> {
    const report = await new CapabilityService({
      toolRegistry: setup.registry,
      integrations: { listIntegrations: async () => [] },
      allowedToolIds: new Set(setup.registry.getAll().map((t) => t.id)),
      runtimeUnavailable: (toolId) => mcpToolUnavailable(setup.connections, toolId),
    }).report("user-s8-8");
    return new Map(report.capabilities.map((c) => [c.id, c]));
  }
  const availability = (views: Map<string, CapabilityView>, ...ids: string[]) => ids.map((id) => views.get(id)?.availability);

  it("healthy dates + failed units: dates usable, units unavailable — with each server's tools under their own ids", async () => {
    const setup = register(DATES, drifted(UNITS));
    await setup.of("dates").verify();
    await setup.of("units").verify();
    const views = await presentation(setup);
    expect(availability(views, "mcp.dates.days_between", "mcp.dates.day_of_week")).toEqual(["EXECUTABLE", "EXECUTABLE"]);
    expect(availability(views, "mcp.units.convert_length", "mcp.units.convert_temperature")).toEqual(["NOT_CONNECTED", "NOT_CONNECTED"]);
    expect(availability(views, "time.now")).toEqual(["EXECUTABLE"]);
    expect(views.get("mcp.dates.days_between")?.label).not.toBe(views.get("mcp.units.convert_length")?.label);
  });

  it("recovering the failed server restores that server alone; the healthy one never changes", async () => {
    const second = fake("beta", "controlled");
    second.set("fail");
    const setup = register(DATES, second.server);
    await setup.of("dates").verify();
    await setup.of("beta").verify();
    const failed = await presentation(setup);
    expect(availability(failed, "mcp.dates.days_between", "mcp.beta.search_notes")).toEqual(["EXECUTABLE", "NOT_CONNECTED"]);

    second.set("ok");
    expect(await setup.of("beta").verify()).toEqual({ ok: true });
    const recovered = await presentation(setup);
    expect(availability(recovered, "mcp.dates.days_between", "mcp.beta.search_notes")).toEqual(["EXECUTABLE", "EXECUTABLE"]);
    expect(recovered.get("mcp.dates.days_between")).toEqual(failed.get("mcp.dates.days_between"));
    expect([...recovered.keys()].sort()).toEqual([...failed.keys()].sort());
  });
});

describe("J. the Integration Center's check, one verdict per reviewed server", () => {
  const check = (setup: Setup) => {
    const deps: IntegrationDeps = {
      googleOAuthMounted: false,
      googleConnections: null,
      readMetaCredentials: async () => null,
      mcp: { enabled: () => true, servers: () => setup.connections },
    };
    return runCheck("user-s8-8", "mcp", deps);
  };

  it("all healthy → CONNECTED, naming each", async () => {
    const result = await check(register(DATES, UNITS));
    expect(result).toMatchObject({ health: "CONNECTED", detail: expect.stringMatching(/dates verified; units verified/) });
  });

  it("one failed → DEGRADED, naming the healthy and the failed server by their reviewed ids", async () => {
    const result = await check(register(DATES, drifted(UNITS)));
    expect(result?.health).toBe("DEGRADED");
    expect(result?.detail).toMatch(/1 of 2/);
    expect(result?.detail).toMatch(/dates verified; units no longer matches its review \(a reviewed tool has changed\)/);
  });

  it("none healthy → ERROR, each named — never the servers' own text", async () => {
    const result = await check(register(broken(DATES), drifted(UNITS)));
    expect(result?.health).toBe("ERROR");
    expect(result?.detail).toMatch(/dates did not finish starting; units no longer matches its review/);
    expect(result?.detail).not.toMatch(/Cannot find module|no-such|older review/);
  });

  it("changes no registration while it checks", async () => {
    const setup = register(DATES, drifted(UNITS));
    const before = setup.registry.getAll().map((t) => t.id);
    await check(setup);
    expect(setup.registry.getAll().map((t) => t.id)).toEqual(before);
  });
});

describe("K. shutdown", () => {
  it("closes every managed connection; afterwards neither server can be used or started", async () => {
    const setup = register(DATES, UNITS);
    await setup.call(...DAYS_CALL);
    await setup.call(...LENGTH_CALL);
    expect(processes()).toBe(2);

    await Promise.all(setup.connections.map((c) => c.close()));
    expect(setup.connections.map((c) => c.getState())).toEqual(["closed", "closed"]);
    await until(() => processes() === 0);
    expect(await setup.call(...DAYS_CALL)).toMatchObject({ status: "failed", error: "The MCP server is unavailable." });
    expect(await setup.call(...LENGTH_CALL)).toMatchObject({ status: "failed", error: "The MCP server is unavailable." });
    expect(processes()).toBe(0);
  });
});

describe("L. one server can never add, rename or claim another's tools", () => {
  const refuses = (servers: McpServerManifest[], ...nativeIds: string[]) => {
    const registry = new ToolRegistry();
    for (const id of nativeIds) registry.register({ ...native, id, name: id });
    expect(registerMcpTools(registry, { servers })).toEqual([]);
    expect(registry.getAll().map((t) => t.id).filter((id) => id.startsWith("mcp"))).toEqual(nativeIds.filter((id) => id.startsWith("mcp")));
  };

  it("refuses a duplicate server id — registering nothing at all", () => refuses([DATES, DATES]));

  it("refuses a review that files a tool under the other server's namespace", () => {
    const claimed = { ...UNITS.tools[0]!, id: "mcp.dates.convert_length" as const };
    refuses([DATES, { ...UNITS, tools: [claimed, UNITS.tools[1]!] }]);
  });

  it("refuses a native tool that already holds a reviewed MCP id or model-facing name", () => {
    refuses([DATES, UNITS], "mcp.units.convert_length");
    refuses([DATES, UNITS], "mcp-units-convert_length");
  });

  it("never registers what a live listing offers beyond the review — its server is refused, the other unaffected", async () => {
    const extra = fake("beta", "normal");
    const reviewedOnly = { ...extra.server, tools: [extra.server.tools[0]!] };
    const setup = register(DATES, reviewedOnly);
    expect(await setup.call("mcp.beta.search_notes", { query: "x" })).toMatchObject({
      status: "failed",
      error: mcpFailure("SCHEMA_INVALID").message,
    });
    expect(setup.registry.get("mcp.beta.server_status")).toBeUndefined();
    expect(await setup.call(...DAYS_CALL)).toMatchObject({ status: "completed" });
    expect(setup.registry.getAll().map((t) => t.id).filter((id) => id.startsWith("mcp."))).toEqual([
      "mcp.dates.days_between",
      "mcp.dates.day_of_week",
      "mcp.beta.search_notes",
    ]);
  });
});

describe("N/O. no secret and no identity crosses between servers", () => {
  it("N: each server receives its own mapped secret and never the other's — and a cross-mapping is refused", async () => {
    vi.stubEnv("JARVIS_MCP_ALPHA_TOKEN", "alpha-only-value");
    vi.stubEnv("JARVIS_MCP_BETA_TOKEN", "beta-only-value");
    const alpha = fake("alpha", "env_dump", { FAKE_TOKEN: "JARVIS_MCP_ALPHA_TOKEN" });
    const beta = fake("beta", "env_dump", { FAKE_TOKEN: "JARVIS_MCP_BETA_TOKEN" });
    const setup = register(alpha.server, beta.server);
    const statusOf = async (serverId: string) => {
      const result = await setup.call(`mcp.${serverId}.server_status`, {});
      const text = (result.result?.data as { content: Array<{ text: string }> }).content[0]!.text;
      return JSON.parse(text) as { envKeys: string[]; fakeToken: string | null };
    };
    const seenByAlpha = await statusOf("alpha");
    const seenByBeta = await statusOf("beta");
    expect([seenByAlpha.fakeToken, seenByBeta.fakeToken]).toEqual(["alpha-only-value", "beta-only-value"]);
    for (const seen of [seenByAlpha, seenByBeta]) {
      expect(seen.envKeys.filter((key) => key.startsWith("JARVIS"))).toEqual([]);
    }

    const crossMapped = { ...alpha.server, env: { FAKE_TOKEN: "JARVIS_MCP_BETA_TOKEN" } };
    expect(registerMcpTools(new ToolRegistry(), { servers: [crossMapped, beta.server] })).toEqual([]);
  });

  it("O: neither server is sent any JARVIS identity — each sees only its own tool name and arguments", async () => {
    const alpha = fake("alpha", "record");
    const beta = fake("beta", "record");
    const setup = register(alpha.server, beta.server);
    const identity = {
      userId: "user-identity-must-not-cross",
      agentId: "conversational-assistant",
      conversationId: "conversation-identity-must-not-cross",
      traceId: "trace-identity-must-not-cross",
    };
    expect(await setup.call("mcp.alpha.search_notes", { query: "for alpha" }, identity)).toMatchObject({ status: "completed" });
    expect(await setup.call("mcp.beta.search_notes", { query: "for beta" }, identity)).toMatchObject({ status: "completed" });

    const wire = (log: string) => (existsSync(log) ? readFileSync(log, "utf8") : "");
    const calls = (log: string) =>
      wire(log)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method?: string; params?: Obj })
        .filter((m) => m.method === "tools/call")
        .map((m) => m.params);
    for (const log of [alpha.log, beta.log]) {
      for (const leak of ["identity-must-not-cross", "conversational-assistant", "user-s8-8"]) {
        expect(wire(log), leak).not.toContain(leak);
      }
    }
    expect(calls(alpha.log)).toEqual([{ name: "search_notes", arguments: { query: "for alpha" } }]);
    expect(calls(beta.log)).toEqual([{ name: "search_notes", arguments: { query: "for beta" } }]);
  });
});

describe("Q. audit", () => {
  it("records one ordinary tool.execute row per call, whichever server answered — nothing MCP-specific", async () => {
    const setup = register(DATES, UNITS);
    await setup.call(...DAYS_CALL);
    await setup.call(...LENGTH_CALL);
    expect(audit.map((row) => [row.action, row.toolId, row.result])).toEqual([
      ["tool.execute", "mcp.dates.days_between", "success"],
      ["tool.execute", "mcp.units.convert_length", "success"],
    ]);
    expect(audit.map((row) => row.parameters)).toEqual([DAYS_CALL[1], LENGTH_CALL[1]]);
  });
});
