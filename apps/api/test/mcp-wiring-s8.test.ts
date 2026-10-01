// S8.4 — MCP wired into the container and the policy.
//
// For this file the reviewed manifest (core's MCP_MANIFEST) holds one server:
// the S8.2 fake server fixture, under the id "fake". Everything else is real —
// the container, the agent policies derived from that manifest, the
// ToolRegistry, McpConnection, McpTool, PermissionService and ToolExecutor.
// Only ToolExecutor's audit sink is a stub, because it writes a database row.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@jarvis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jarvis/core")>();
  const { mkdtempSync, readFileSync: read } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const fixtures = new URL("../../../packages/mcp/test/fixtures/", import.meta.url);
  const spec = JSON.parse(read(new URL("fake-tools.json", fixtures), "utf8")) as {
    serverInfo: { name: string; version: string };
    tools: Array<Record<string, unknown>>;
  };
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mcp-wiring-"));
  const tools = spec.tools.map((tool) => ({
    ...tool,
    id: `mcp.fake.${String(tool.name)}`,
    readOnly: true,
    risk: "READ_ONLY",
    requiresApproval: false,
    requiredPermissions: ["read", "execute"],
    enabled: true,
    fingerprint: actual.mcpToolFingerprint(tool as never),
  }));
  const server = {
    id: "fake",
    transport: {
      kind: "stdio",
      command: "node",
      args: [fileURLToPath(new URL("fake-server.mjs", fixtures)), "controlled", join(dir, "control"), join(dir, "starts")],
    },
    env: {},
    expectedServerInfo: spec.serverInfo,
    tools,
  };
  return { ...actual, MCP_MANIFEST: { servers: [server] } };
});

import {
  MCP_MANIFEST,
  mcpFailure,
  type AIToolDefinition,
  type AuditLogger,
  type IApprovalManager,
  type McpManifest,
  type McpServerManifest,
} from "@jarvis/core";
import { AGENT_IDS, AGENT_POLICIES, MCP_READ_TOOLS, isToolAllowed, schedulableToolIds } from "@jarvis/agents";
import { McpTool, ToolExecutor, ToolRegistry } from "@jarvis/tools";
import { PermissionService } from "@jarvis/security";
import { getContainer, getMcpConnections, registerMcpTools, resetContainer } from "../src/services/container.js";
import { CapabilityService } from "../src/services/capabilities/capability-service.js";

const SERVER = MCP_MANIFEST.servers[0] as McpServerManifest;
const [, , CONTROL, STARTS] = SERVER.transport.args as [string, string, string, string];
const SEARCH = "mcp.fake.search_notes";
const STATUS = "mcp.fake.server_status";
const JWT_SECRET = "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA";

/** Pids of every fake-server process started so far. */
const starts = (): number[] =>
  existsSync(STARTS) ? readFileSync(STARTS, "utf8").split("\n").filter(Boolean).map(Number) : [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

let logged: string[];

function useEnvironment(mcpEnabled: string | undefined): void {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("JWT_SECRET", JWT_SECRET);
  vi.stubEnv("BROWSER_ENABLED", "false");
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("JARVIS_MCP_ENABLED", mcpEnabled);
}

const mcpIds = (registry: { getAll(): Array<{ id: string }> }): string[] =>
  registry.getAll().map((t) => t.id).filter((id) => id.startsWith("mcp."));

const approvals: IApprovalManager = {
  requestApproval: vi.fn(),
  findExistingForTool: vi.fn().mockResolvedValue(null),
};

function executorOver(registry: ToolRegistry): ToolExecutor {
  const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger;
  return new ToolExecutor(registry, new PermissionService(), approvals, audit);
}

const request = (toolId: string, role: "owner" | "admin" | "member" | "viewer", params: Record<string, unknown>) => ({
  toolId,
  params,
  userId: "user-1",
  role,
  traceId: "trace-s8-4",
});

function capabilityReportFor(registry: ToolRegistry) {
  return new CapabilityService({
    toolRegistry: registry,
    integrations: { listIntegrations: async () => [] },
    allowedToolIds: new Set(Object.values(AGENT_POLICIES).flatMap((p) => [...p.allowedTools])),
  }).report("user-1");
}

beforeEach(() => {
  resetContainer();
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  rmSync(STARTS, { force: true });
  rmSync(CONTROL, { force: true });
});

afterEach(async () => {
  await Promise.all(getMcpConnections().map((connection) => connection.close()));
  resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// The scratch directory the substituted manifest points at.
afterAll(() => rmSync(dirname(STARTS), { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe("switched off — the default", () => {
  it.each([["unset", undefined], ["false", "false"], ["TRUE", "TRUE"], ["1", "1"], ["yes", "yes"]])(
    "registers nothing, starts nothing and offers nothing when JARVIS_MCP_ENABLED is %s",
    async (_label, value) => {
      useEnvironment(value);
      const container = getContainer();
      expect(mcpIds(container.toolRegistry)).toEqual([]);
      expect(getMcpConnections()).toEqual([]);
      expect(starts()).toEqual([]);
      const report = await capabilityReportFor(container.toolRegistry);
      expect(report.capabilities.filter((c) => c.id.startsWith("mcp."))).toEqual([]);
    }
  );
});

describe("switched on", () => {
  it("registers the reviewed tools in the existing registry, without starting the server", () => {
    useEnvironment("true");
    const container = getContainer();
    expect(mcpIds(container.toolRegistry)).toEqual([SEARCH, STATUS]);
    for (const id of [SEARCH, STATUS]) expect(container.toolRegistry.get(id)).toBeInstanceOf(McpTool);
    const connections = getMcpConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0]!.getState()).toBe("idle");
    expect(starts()).toEqual([]);
    expect(logged.some((line) => line.includes('"event":"mcp_tools_registered"'))).toBe(true);
    // A fresh container starts from nothing: no connection survives a reset.
    resetContainer();
    expect(getMcpConnections()).toEqual([]);
  });

  it("leaves every native tool exactly as it was", () => {
    useEnvironment("false");
    const native = getContainer().toolRegistry.getAll().map((t) => t.id).sort();
    resetContainer();
    useEnvironment("true");
    const withMcp = getContainer().toolRegistry.getAll().map((t) => t.id);
    expect(withMcp.filter((id) => !id.startsWith("mcp.")).sort()).toEqual(native);
  });

  it("grants the tools to the general assistant alone, through its compiled-in policy", () => {
    useEnvironment("true");
    const container = getContainer();
    expect(MCP_READ_TOOLS).toEqual([SEARCH, STATUS]);
    const general = container.agentRegistry.getPolicy(AGENT_IDS.general)!;
    for (const id of [SEARCH, STATUS]) {
      expect(isToolAllowed(id, general.allowedTools), id).toBe(true);
      expect(isToolAllowed(id.replace(/\./g, "-"), general.allowedTools), id).toBe(true);
    }
    for (const [agentId, policy] of Object.entries(AGENT_POLICIES)) {
      if (agentId === AGENT_IDS.general) continue;
      for (const id of [SEARCH, STATUS]) expect(isToolAllowed(id, policy.allowedTools), `${agentId}/${id}`).toBe(false);
    }
  });

  it("offers the general assistant the reviewed definition, under the S8.1 model-facing name", () => {
    useEnvironment("true");
    const assistant = getContainer().agentRegistry.get(AGENT_IDS.general) as unknown as { providerTools: AIToolDefinition[] };
    const offered = assistant.providerTools.find((d) => d.name === "mcp-fake-search_notes");
    expect(offered?.description).toBe(SERVER.tools[0]!.description);
    expect(JSON.stringify(offered)).not.toContain(SERVER.tools[0]!.fingerprint);
  });

  it("keeps the tools out of scheduled work — the container's task services never see them", () => {
    useEnvironment("true");
    const container = getContainer();
    const schedulable = schedulableToolIds();
    expect(schedulable.has(SEARCH)).toBe(false);
    expect(schedulable.has(STATUS)).toBe(false);
    // The allowlist the container actually hands the task planner and executor.
    type WithAllowlist = { deps: { allowedToolIds: ReadonlySet<string> } };
    for (const service of [container.taskPlanner, container.taskExecution] as unknown as WithAllowlist[]) {
      expect(service.deps.allowedToolIds.has(SEARCH)).toBe(false);
      expect(service.deps.allowedToolIds.has(STATUS)).toBe(false);
      expect(service.deps.allowedToolIds.has("time.now")).toBe(true);
    }
    // …while the general assistant may still use them in a conversation.
    expect(isToolAllowed(SEARCH, container.agentRegistry.getPolicy(AGENT_IDS.general)!.allowedTools)).toBe(true);
  });

  it("runs a granted tool through ToolExecutor, starting the server on first use — once", async () => {
    useEnvironment("true");
    const container = getContainer();
    const [connection] = getMcpConnections();
    const executor = executorOver(container.toolRegistry);

    const first = await executor.execute(request(SEARCH, "admin", { query: "alpha" }));
    expect(first.status).toBe("completed");
    expect(first.result?.data).toEqual({ content: [{ type: "text", text: "results for alpha" }] });
    expect(connection!.getState()).toBe("ready");
    expect(starts()).toHaveLength(1);

    expect((await executor.execute(request(SEARCH, "owner", { query: "beta" }))).status).toBe("completed");
    expect(starts()).toHaveLength(1);
  });

  it("keeps the OWNER/ADMIN boundary: MEMBER and VIEWER are refused before anything starts", async () => {
    useEnvironment("true");
    const executor = executorOver(getContainer().toolRegistry);
    expect((await executor.execute(request(SEARCH, "member", { query: "x" }))).status).toBe("permission_denied");
    expect((await executor.execute(request(SEARCH, "viewer", { query: "x" }))).status).toBe("permission_denied");
    expect(starts()).toEqual([]);
  });

  it("survives a server that will not start: boot is unaffected, the call fails as a normal tool result", async () => {
    writeFileSync(CONTROL, "fail");
    useEnvironment("true");
    const container = getContainer();
    expect(container.toolRegistry.get("time.now")).toBeDefined();
    const result = await executorOver(container.toolRegistry).execute(request(SEARCH, "admin", { query: "x" }));
    expect(result.status).toBe("failed");
    expect(result.error).toBe(mcpFailure("INITIALIZATION_FAILED").message);
  });

  it("closes the server at shutdown, through the hook index.ts calls", async () => {
    useEnvironment("true");
    const container = getContainer();
    const status = await executorOver(container.toolRegistry).execute(request(STATUS, "admin", {}));
    const content = (status.result?.data as { content: Array<{ text: string }> }).content;
    const pid = (JSON.parse(content[0]!.text) as { pid: number }).pid;
    expect(alive(pid)).toBe(true);
    await Promise.all(getMcpConnections().map((c) => c.close()));
    expect(alive(pid)).toBe(false);
    expect(getMcpConnections()[0]!.getState()).toBe("closed");

    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const release = index.slice(index.indexOf("releaseExternalResources:"), index.indexOf("disconnectDatabase:"));
    expect(release).toMatch(/getMcpConnections\(\)[\s\S]*\.close\(\)/);
  });

  it("presents the tools naturally — no ids, schemas, fingerprints or transport", async () => {
    useEnvironment("true");
    const report = await capabilityReportFor(getContainer().toolRegistry);
    const mcp = report.capabilities.filter((c) => c.id.startsWith("mcp."));
    expect(mcp.map((c) => c.label)).toEqual(["Search notes", "Server status"]);
    for (const capability of mcp) {
      expect(capability).toMatchObject({ group: "system", integration: null, availability: "EXECUTABLE", access: "read" });
    }
    expect(mcp[0]!.description).toBe(SERVER.tools[0]!.description);
    const text = JSON.stringify(report);
    for (const hidden of [SERVER.tools[0]!.fingerprint, SERVER.tools[1]!.fingerprint, "inputSchema", "fake-server.mjs", "stdio", "Ignore previous"]) {
      expect(text, hidden).not.toContain(hidden);
    }
  });
});

describe("registerMcpTools — the reviewed manifest decides, all or nothing", () => {
  const nativeTool = (id: string) => ({
    id,
    name: id,
    description: "native",
    category: "system" as const,
    risk: "READ_ONLY" as const,
    parameters: [],
    requiresApproval: false,
    requiredPermissions: ["read" as const],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
  });

  function registryWith(...ids: string[]): ToolRegistry {
    const registry = new ToolRegistry();
    for (const id of ids) registry.register(nativeTool(id));
    return registry;
  }

  const withTools = (tools: McpServerManifest["tools"], extra: Partial<McpServerManifest> = {}): McpManifest => ({
    servers: [{ ...SERVER, tools, ...extra }],
  });

  it("registers every enabled reviewed tool, with one idle connection per server", () => {
    const registry = registryWith("time.now");
    const connections = registerMcpTools(registry, MCP_MANIFEST);
    expect(mcpIds(registry)).toEqual([SEARCH, STATUS]);
    expect(connections).toHaveLength(1);
    expect(connections[0]!.getState()).toBe("idle");
  });

  it("leaves out a disabled tool", () => {
    const registry = registryWith();
    registerMcpTools(registry, withTools([SERVER.tools[0]!, { ...SERVER.tools[1]!, enabled: false }]));
    expect(mcpIds(registry)).toEqual([SEARCH]);
  });

  it.each([
    ["a tool that is not read-only", withTools([SERVER.tools[0]!, { ...SERVER.tools[1]!, risk: "HIGH_IMPACT" } as never])],
    ["a duplicate tool id", withTools([SERVER.tools[0]!, SERVER.tools[0]!])],
    ["a duplicate server", { servers: [SERVER, SERVER] }],
    ["a stale fingerprint", withTools([SERVER.tools[0]!, { ...SERVER.tools[1]!, description: "Edited after review." }])],
  ])("registers nothing at all from a manifest with %s", (_label, manifest) => {
    const registry = registryWith("time.now");
    expect(registerMcpTools(registry, manifest)).toEqual([]);
    expect(mcpIds(registry)).toEqual([]);
    expect(registry.get("time.now")).toBeDefined();
    const skipped = logged.find((line) => line.includes('"event":"mcp_registration_skipped"'));
    expect(skipped).toBeDefined();
    expect(skipped).not.toContain(SERVER.tools[0]!.description);
  });

  it("refuses a model-facing name that would collide with a registered tool, renaming nothing", () => {
    const registry = registryWith("mcp-fake-search_notes");
    expect(registerMcpTools(registry, MCP_MANIFEST)).toEqual([]);
    expect(registry.getAll().map((t) => t.id)).toEqual(["mcp-fake-search_notes"]);
  });
});
