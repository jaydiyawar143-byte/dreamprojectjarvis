// S8.5 — MCP inside the EXISTING integration architecture.
//
// MCP is one more server-managed integration: a descriptor in the catalogue, a
// connection test in integration-registry's runCheck, and the one command
// service behind both the button and the sentence. Pinned here: what it
// reports when switched off and with no reviewed server; that its health is
// S8.2's real verification and never configuration; that several servers give
// one deterministic verdict that names each of them; and that nothing a
// server says, and no secret, reaches the output.
//
// Real McpConnections over the S8.2 fake server wherever a process is
// involved. A stand-in only where no stdio server can answer: AUTH_FAILURE,
// which belongs to remote transports, and a check that throws.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTEGRATION_IDS,
  MCP_MANIFEST,
  getIntegrationDescriptor,
  isIntegrationId,
  mcpFailure,
  mcpToolFingerprint,
  resolveIntegrationAlias,
  type IntegrationCommandContext,
  type IntegrationCommandInput,
  type IntegrationPermission,
  type IntegrationView,
  type McpConnectResult,
  type McpServerManifest,
  type McpToolManifestEntry,
} from "@jarvis/core";
import { MCP_RUNTIME, McpConnection, type McpConnectionOptions } from "@jarvis/mcp";
import { createIntegrationTools } from "@jarvis/tools";
import {
  __resetIntegrationChecks,
  getIntegration,
  runCheck,
  type IntegrationDeps,
} from "../src/services/integration-registry.js";
import {
  IntegrationCommandService,
  type IntegrationStatePort,
  type RateLimitPort,
} from "../src/services/integrations/command-service.js";
import { getContainer, getMcpConnections, mcpIntegrationRuntime, resetContainer } from "../src/services/container.js";

type Obj = Record<string, unknown>;

const FIXTURES = new URL("../../../packages/mcp/test/fixtures/", import.meta.url);
const SERVER_SCRIPT = fileURLToPath(new URL("fake-server.mjs", FIXTURES));
const SPEC = JSON.parse(readFileSync(new URL("fake-tools.json", FIXTURES), "utf8")) as {
  serverInfo: { name: string; version: string };
  tools: Obj[];
};
const [SEARCH, STATUS] = SPEC.tools as [Obj, Obj];
const USER = "user-1";
const AS_USER: IntegrationCommandContext = { userId: USER, source: "frontend" };

function entry(serverId: string, tool: Obj): McpToolManifestEntry {
  return {
    ...tool,
    id: `mcp.${serverId}.${String(tool.name)}`,
    readOnly: true,
    risk: "READ_ONLY",
    requiresApproval: false,
    requiredPermissions: ["read", "execute"],
    enabled: true,
    fingerprint: mcpToolFingerprint(tool as never),
  } as unknown as McpToolManifestEntry;
}

const opened: McpConnection[] = [];
const dirs: string[] = [];

interface FakeServer {
  connection: McpConnection;
  set(value: string): void;
  starts(): number[];
}

/** Reviewed server `id`, running the S8.2 fake server in `mode`, behind a real McpConnection. */
function server(
  id: string,
  mode: string,
  overrides: Partial<McpServerManifest> = {},
  options: McpConnectionOptions = {}
): FakeServer {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mcp-health-"));
  dirs.push(dir);
  const control = join(dir, "control");
  const starts = join(dir, "starts");
  const connection = new McpConnection(
    {
      id,
      transport: { kind: "stdio", command: "node", args: [SERVER_SCRIPT, mode, control, starts] },
      env: { FAKE_TOKEN: `JARVIS_MCP_${id.toUpperCase()}_TOKEN` },
      expectedServerInfo: SPEC.serverInfo,
      tools: [entry(id, SEARCH), entry(id, STATUS)],
      ...overrides,
    },
    options
  );
  opened.push(connection);
  return {
    connection,
    set: (value) => writeFileSync(control, value),
    starts: () => (existsSync(starts) ? readFileSync(starts, "utf8").split("\n").filter(Boolean).map(Number) : []),
  };
}

type Check = { readonly serverId: string; verify(): Promise<McpConnectResult> };

/** MCP as the container hands it over: the switch, and the registered servers. */
const runtime = (enabled: boolean, servers: readonly Check[]) => ({ enabled: () => enabled, servers: () => servers });

function deps(mcp?: ReturnType<typeof runtime>): IntegrationDeps {
  return {
    googleOAuthMounted: false,
    googleConnections: null,
    readMetaCredentials: async () => null,
    ...(mcp ? { mcp } : {}),
  };
}

const check = (...servers: Check[]) => runCheck(USER, "mcp", deps(runtime(true, servers)));

// The command service, on the same in-memory ports the parity test uses.
function stateStore(): IntegrationStatePort {
  const rows = new Map<string, { enabled: boolean; enabledServices: string[]; lastSuccessfulSyncAt: string | null }>();
  const fresh = () => ({ enabled: true, enabledServices: [], lastSuccessfulSyncAt: null });
  return {
    async get(userId, integration) {
      return { ...(rows.get(`${userId}:${integration}`) ?? fresh()) };
    },
    async patch(userId, integration, changes) {
      const next = { ...(rows.get(`${userId}:${integration}`) ?? fresh()), ...changes };
      rows.set(`${userId}:${integration}`, next);
      return { ...next };
    },
    async clear(userId, integration) {
      rows.delete(`${userId}:${integration}`);
    },
  };
}

const allowAll: RateLimitPort = {
  async check(_userId, _bucket, limit) {
    return { allowed: true, currentCount: 0, limit };
  },
};

function service(mcp: ReturnType<typeof runtime>) {
  const audit: Array<{ action: string; result: string; metadata?: Obj }> = [];
  const commands = new IntegrationCommandService({
    credentials: { read: async () => null, write: async () => {}, remove: async () => {} },
    state: stateStore(),
    audit: { log: async (row: (typeof audit)[number]) => void audit.push(row), query: async () => [] } as never,
    rateLimiter: allowAll,
    googleConnections: null,
    oauthStates: null,
    googleConfig: () => null,
    mapsUsage: async () => null,
    mcp,
  });
  const run = (command: IntegrationCommandInput["command"]) =>
    commands.execute({ command, integration: command === "list" ? null : "mcp" }, AS_USER);
  return { commands, audit, run };
}

const viewOf = (result: Awaited<ReturnType<IntegrationCommandService["execute"]>>): IntegrationView => {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.data as IntegrationView;
};

function useEnvironment(mcpEnabled: string | undefined): void {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("JWT_SECRET", "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA");
  vi.stubEnv("BROWSER_ENABLED", "false");
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("JARVIS_MCP_ENABLED", mcpEnabled);
}

beforeEach(() => {
  __resetIntegrationChecks();
  resetContainer();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((connection) => connection.close()));
  await Promise.all(getMcpConnections().map((connection) => connection.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("the MCP integration descriptor", () => {
  it("is a server-managed integration in the catalogue and in the closed id set", () => {
    expect(getIntegrationDescriptor("mcp")?.configKind).toBe("server-managed");
    expect(isIntegrationId("mcp")).toBe(true);
    expect(INTEGRATION_IDS).toContain("mcp");
  });

  it("offers the universal verbs only — nothing connects, configures or disconnects it, or runs an action through it", () => {
    const descriptor = getIntegrationDescriptor("mcp")!;
    expect([...descriptor.commands].sort()).toEqual([
      "disable",
      "enable",
      "getAudit",
      "getHealth",
      "getPermissions",
      "status",
      "testConnection",
      "validateConfig",
    ]);
    expect(descriptor.actions).toEqual([]);
  });

  it("is plain reviewed data: no SDK object, transport, schema or fingerprint, and a switch the server sets", () => {
    const descriptor = getIntegrationDescriptor("mcp")!;
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    expect(Object.keys(descriptor).sort()).toEqual([
      "actions",
      "category",
      "commands",
      "configKind",
      "envVars",
      "fields",
      "id",
      "name",
      "subtitle",
    ]);
    expect(descriptor.envVars).toEqual(["JARVIS_MCP_ENABLED"]);
    for (const field of descriptor.fields) expect(field.serverManaged, field.name).toBe(true);
    expect(JSON.stringify(descriptor)).not.toMatch(/stdio|fake-server|inputSchema|fingerprint|modelcontextprotocol|transport/i);
  });

  it("holds no credential", () => {
    expect(getIntegrationDescriptor("mcp")!.fields.filter((f) => f.kind === "secret")).toEqual([]);
  });

  it("is what a sentence naming MCP resolves to — ahead of the automation words n8n answers to", () => {
    expect(resolveIntegrationAlias("MCP")).toBe("mcp");
    expect(resolveIntegrationAlias("mcp servers ka status batao")).toBe("mcp");
    expect(resolveIntegrationAlias("MCP automation server")).toBe("mcp");
    expect(resolveIntegrationAlias("n8n")).toBe("n8n");
  });

  it("appears in the one integration list, in a category the page already groups — no MCP-specific route or state", async () => {
    const { run } = service(runtime(false, []));
    const listed = await run("list");
    const views = listed.ok ? (listed.data as { integrations: IntegrationView[] }).integrations : [];
    expect(views.find((v) => v.id === "mcp")?.category).toBe("automation");
  });
});

describe("switched off — JARVIS_MCP_ENABLED is not \"true\"", () => {
  it("reports DISABLED, says how to switch it on, and starts nothing — even with a server registered", async () => {
    const alpha = server("alpha", "normal");
    const off = deps(runtime(false, [alpha.connection]));
    const result = await runCheck(USER, "mcp", off);
    expect(result?.health).toBe("DISABLED");
    expect(result?.detail).toMatch(/JARVIS_MCP_ENABLED=true/);
    expect((await getIntegration(USER, "mcp", off))?.health).toBe("DISABLED");
    expect(alpha.connection.getState()).toBe("idle");
    expect(alpha.starts()).toEqual([]);
  });

  it.each([
    ["unset", undefined],
    ["false", "false"],
    ["TRUE", "TRUE"],
  ])("registers and starts nothing in the container when it is %s, and the check says so", async (_label, value) => {
    useEnvironment(value);
    const container = getContainer();
    const before = container.toolRegistry.getAll().map((t) => t.id).sort();
    expect((await runCheck(USER, "mcp", deps(mcpIntegrationRuntime)))?.health).toBe("DISABLED");
    expect(container.toolRegistry.getAll().map((t) => t.id).sort()).toEqual(before);
    expect(before.filter((id) => id.startsWith("mcp."))).toEqual([]);
    expect(getMcpConnections()).toEqual([]);
  });

  it("is shown switched off by the command service: not set up, its switch missing, nothing granted", async () => {
    const { run } = service(runtime(false, []));
    const view = viewOf(await run("status"));
    expect(view).toMatchObject({
      health: "DISABLED",
      connection: "NOT_CONNECTED",
      configComplete: false,
      missingConfig: ["enabled"],
    });
    expect(view.permissions.filter((p) => p.granted)).toEqual([]);
    const validation = await run("validateConfig");
    expect(validation.ok && (validation.data as { valid: boolean }).valid).toBe(false);
    expect(validation.message).toMatch(/JARVIS_MCP_ENABLED/);
  });
});

describe("switched on with the manifest as shipped — the reviewed servers (S8.6, S8.8)", () => {
  it("registers one connection per server, starts nothing, and reports them unverified — never healthy before a check", async () => {
    useEnvironment("true");
    getContainer();
    expect(MCP_MANIFEST.servers.map((s) => s.id)).toEqual(["dates", "units"]);
    expect(getMcpConnections().map((c) => [c.serverId, c.getState()])).toEqual([
      ["dates", "idle"],
      ["units", "idle"],
    ]);
    const view = await getIntegration(USER, "mcp", deps(mcpIntegrationRuntime));
    expect(view?.health).toBe("UNVERIFIED");
    expect(view?.detail).toMatch(/Reviewed MCP servers: dates, units\./);
    expect(getMcpConnections().map((c) => c.getState())).toEqual(["idle", "idle"]);
  });
});

describe("switched on with no reviewed server", () => {
  it("reports NOT_CONNECTED — the existing 'nothing configured' state — and starts nothing", async () => {
    const result = await runCheck(USER, "mcp", deps(runtime(true, [])));
    expect(result?.health).toBe("NOT_CONNECTED");
    expect(result?.detail).toMatch(/No reviewed MCP server/);
  });

  it("invents no phantom server: not set up, not healthy, nothing granted, and a test that says so", async () => {
    const { run } = service(runtime(true, []));
    const view = viewOf(await run("status"));
    expect(view).toMatchObject({ health: "NOT_CONNECTED", connection: "NOT_CONNECTED", missingConfig: [] });
    expect(view.permissions.filter((p) => p.granted)).toEqual([]);
    const tested = await run("testConnection");
    expect(!tested.ok && tested.code).toBe("NOT_CONNECTED");
  });
});

describe("health is S8.2's real verification — never configuration", () => {
  it("is UNVERIFIED until checked, and CONNECTED only once the server started and matched its review", async () => {
    const alpha = server("alpha", "normal");
    const on = deps(runtime(true, [alpha.connection]));
    expect((await getIntegration(USER, "mcp", on))?.health).toBe("UNVERIFIED");
    expect(alpha.starts()).toEqual([]);

    const result = await runCheck(USER, "mcp", on);
    expect(result?.health).toBe("CONNECTED");
    expect(result?.detail).toMatch(/alpha verified/);
    expect(alpha.connection.getState()).toBe("ready");
    expect(alpha.starts()).toHaveLength(1);

    const view = await getIntegration(USER, "mcp", on);
    expect(view).toMatchObject({ health: "CONNECTED", lastError: null });
    expect(view?.lastCheckedAt).not.toBeNull();
  });

  it.each([
    ["initialize fails", "init_error", {}, /alpha did not finish starting/],
    ["tools/list fails", "list_error", {}, /alpha did not finish starting/],
    ["it crashes at start", "crash", {}, /alpha did not finish starting/],
    [
      "its serverInfo differs from the review",
      "normal",
      { expectedServerInfo: { ...SPEC.serverInfo, version: "9.9.9" } },
      /alpha no longer matches its review \(another server name or version\)/,
    ],
    [
      "a reviewed tool is missing",
      "normal",
      { tools: [entry("alpha", SEARCH), entry("alpha", STATUS), entry("alpha", { ...SEARCH, name: "archive_notes" })] },
      /alpha no longer matches its review \(a reviewed tool is missing\)/,
    ],
    ["a fingerprint changed", "drift", {}, /alpha no longer matches its review \(a reviewed tool has changed\)/],
    [
      "an unreviewed tool is offered",
      "normal",
      { tools: [entry("alpha", SEARCH)] },
      /alpha no longer matches its review \(an unreviewed tool is offered\)/,
    ],
  ])("is ERROR when %s", async (_label, mode, overrides, detail) => {
    const alpha = server("alpha", mode, overrides as Partial<McpServerManifest>);
    const result = await check(alpha.connection);
    expect(result?.health).toBe("ERROR");
    expect(result?.detail).toMatch(detail);
    expect(alpha.connection.getState()).toBe("failed");
  });

  it("is ERROR — timed out — when a running server stops answering", async () => {
    const alpha = server("alpha", "controlled", {}, { connectTimeoutMs: 500 });
    expect((await check(alpha.connection))?.health).toBe("CONNECTED");
    alpha.set("hang_list");
    const result = await check(alpha.connection);
    expect(result?.health).toBe("ERROR");
    expect(result?.detail).toMatch(/alpha timed out/);
  });

  it("reports a server that keeps crashing as unavailable, and leaves restarts to S8.2's breaker", async () => {
    const alpha = server("alpha", "controlled");
    alpha.set("fail");
    for (let i = 0; i < MCP_RUNTIME.breakerFailures; i++) {
      expect((await check(alpha.connection))?.detail).toMatch(/alpha did not finish starting/);
    }
    alpha.set("ok");
    const result = await check(alpha.connection);
    expect(result?.health).toBe("ERROR");
    expect(result?.detail).toMatch(/alpha is unavailable/);
    expect(alpha.starts()).toHaveLength(MCP_RUNTIME.breakerFailures);
  });

  it("is ERROR — credentials refused — when a server reports AUTH_FAILURE", async () => {
    const remote: Check = { serverId: "remote", verify: async () => ({ ok: false, failure: mcpFailure("AUTH_FAILURE") }) };
    const result = await check(remote);
    expect(result?.health).toBe("ERROR");
    expect(result?.detail).toMatch(/remote refused JARVIS's credentials/);
  });
});

describe("several servers — one deterministic verdict that names every server", () => {
  it("is CONNECTED only when every server verified", async () => {
    const result = await check(server("alpha", "normal").connection, server("beta", "normal").connection);
    expect(result?.health).toBe("CONNECTED");
    expect(result?.detail).toMatch(/alpha verified; beta verified/);
  });

  it("is DEGRADED, not healthy, when one of them fails — and names the one that failed", async () => {
    const result = await check(server("alpha", "normal").connection, server("beta", "crash").connection);
    expect(result?.health).toBe("DEGRADED");
    expect(result?.detail).toMatch(/1 of 2/);
    expect(result?.detail).toMatch(/alpha verified; beta did not finish starting/);
  });

  it("is ERROR when every server fails — the same verdict, in manifest order, every time", async () => {
    const servers = [server("alpha", "init_error").connection, server("beta", "drift").connection];
    const first = await check(...servers);
    const second = await check(...servers);
    expect(first?.health).toBe("ERROR");
    expect(first?.detail).toMatch(/alpha did not finish starting; beta no longer matches its review/);
    expect(second).toMatchObject({ health: first?.health, detail: first?.detail });
  });

  it("does not let one server's broken check hide another's state, or carry its error", async () => {
    const broken: Check = { serverId: "beta", verify: () => Promise.reject(new Error("raw failure: token=sk-test-123")) };
    const result = await check(server("alpha", "normal").connection, broken);
    expect(result?.health).toBe("DEGRADED");
    expect(result?.detail).toMatch(/alpha verified; beta failed its check/);
    expect(result?.detail).not.toMatch(/raw failure|sk-test-123/);
  });
});

describe("nothing the server says, and no secret, reaches the output", () => {
  it("carries no live metadata — no instructions, descriptions, schemas, fingerprints, transport or serverInfo", async () => {
    const alpha = server("alpha", "normal");
    const on = deps(runtime(true, [alpha.connection]));
    const result = await runCheck(USER, "mcp", on);
    expect(result?.health).toBe("CONNECTED");
    const text = JSON.stringify([result, await getIntegration(USER, "mcp", on)]);
    for (const hidden of [
      "Ignore previous",
      String(SEARCH.description),
      String(STATUS.description),
      "inputSchema",
      mcpToolFingerprint(SEARCH as never),
      "fake-server.mjs",
      "stdio",
      SPEC.serverInfo.name,
    ]) {
      expect(text, hidden).not.toContain(hidden);
    }
  });

  it("never carries a secret the server was given, through any verb", async () => {
    vi.stubEnv("JARVIS_MCP_ALPHA_TOKEN", "sk-live-SHOULD-NEVER-APPEAR");
    const alpha = server("alpha", "normal");
    const { run } = service(runtime(true, [alpha.connection]));
    const outputs = [];
    for (const command of ["testConnection", "status", "getHealth", "getPermissions", "validateConfig", "list"] as const) {
      outputs.push(await run(command));
    }
    expect(alpha.connection.getState()).toBe("ready");
    expect(JSON.stringify(outputs)).not.toContain("sk-live-SHOULD-NEVER-APPEAR");
  });

  it("never carries the server's own error text", async () => {
    const result = await check(server("alpha", "init_error").connection, server("beta", "list_error").connection);
    expect(result?.health).toBe("ERROR");
    expect(result?.detail).not.toMatch(/fake initialize failure|fake list failure|MCP error|-32603/);
  });

  it("names no tool in a drift verdict — an unreviewed tool's name is the server's own text", async () => {
    const result = await check(server("alpha", "normal", { tools: [entry("alpha", SEARCH)] }).connection);
    expect(result?.detail).toMatch(/an unreviewed tool is offered/);
    expect(result?.detail).not.toContain(String(STATUS.name));
  });
});

describe("one service behind the button and the sentence", () => {
  it("runs the same real check for both, and audits each with its source", async () => {
    const alpha = server("alpha", "normal");
    const { commands, audit, run } = service(runtime(true, [alpha.connection]));

    const button = await run("testConnection");
    expect(button.ok && button.view).toMatchObject({ health: "CONNECTED", connection: "CONNECTED" });

    const tool = createIntegrationTools({ execute: (input, context) => commands.execute(input, context) }).find(
      (t) => t.id === "integration.test"
    )!;
    const sentence = await tool.execute({ integration: "MCP" }, { userId: USER } as never);
    expect(sentence.success).toBe(true);
    expect((sentence.data as { health: string }).health).toBe("CONNECTED");

    // The second check re-verified the running server; it did not start another.
    expect(alpha.starts()).toHaveLength(1);
    expect(
      audit.filter((row) => row.action === "integration.testConnection").map((row) => row.metadata?.source)
    ).toEqual(["frontend", "jarvis"]);
  });

  it("reports a failed check as a failed test, with the verdict as its message", async () => {
    const { run } = service(runtime(true, [server("alpha", "init_error").connection]));
    const result = await run("testConnection");
    expect(!result.ok && result.code).toBe("PROVIDER_ERROR");
    expect(result.message).toMatch(/alpha did not finish starting/);
  });

  it("starts nothing when a user switches it off and on, and refuses the check while it is off", async () => {
    const alpha = server("alpha", "normal");
    const { run } = service(runtime(true, [alpha.connection]));
    const off = await run("disable");
    expect(off.ok && off.view?.health).toBe("DISABLED");
    const refused = await run("testConnection");
    expect(!refused.ok && refused.code).toBe("NOT_CONNECTED");
    const on = await run("enable");
    expect(on.ok && on.view?.health).toBe("UNVERIFIED");
    expect(alpha.starts()).toEqual([]);
  });

  it.each(["connect", "configure", "reconnect", "disconnect", "executeAction"] as const)(
    "refuses %s — nothing about MCP is changed or run through the integration layer",
    async (command) => {
      const alpha = server("alpha", "normal");
      const result = await service(runtime(true, [alpha.connection])).run(command);
      expect(!result.ok && result.code).toBe("UNSUPPORTED_COMMAND");
      expect(alpha.starts()).toEqual([]);
    }
  );

  it("grants one read-only permission, and only while a reviewed server is registered", async () => {
    const permissionsOf = async (servers: readonly Check[]) => {
      const result = await service(runtime(true, servers)).run("getPermissions");
      return (result.ok ? (result.data as { permissions: IntegrationPermission[] }).permissions : []).map((p) => ({
        access: p.access,
        granted: p.granted,
      }));
    };
    expect(await permissionsOf([server("alpha", "normal").connection])).toEqual([{ access: "read", granted: true }]);
    expect(await permissionsOf([])).toEqual([{ access: "read", granted: false }]);
  });
});
