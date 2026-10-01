// S8.5 — the MCP health check as the container wires it.
//
// For this file core's MCP_MANIFEST holds one reviewed server: the S8.2 fake
// server, under the id "fake", as in the S8.4 wiring test. Everything else is
// real — the container, its managed connections, the registry's runCheck, the
// command service, the ToolRegistry, the agent policies and ToolExecutor.
// Pinned here: a check runs on the connection tool calls use, never a second
// one; it registers, grants and changes nothing; startup still starts
// nothing; and shutdown ends what a check started.
import { randomBytes } from "node:crypto";
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
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mcp-health-wiring-"));
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

import { MCP_MANIFEST, type AuditLogger, type IApprovalManager, type McpServerManifest } from "@jarvis/core";
import { AGENT_IDS, AGENT_POLICIES, MCP_READ_TOOLS } from "@jarvis/agents";
import { ToolExecutor, type ToolRegistry } from "@jarvis/tools";
import { PermissionService } from "@jarvis/security";
import { getContainer, getMcpConnections, mcpIntegrationRuntime, resetContainer } from "../src/services/container.js";
import {
  __resetIntegrationChecks,
  listIntegrations,
  runCheck,
  type IntegrationDeps,
} from "../src/services/integration-registry.js";

const SERVER = MCP_MANIFEST.servers[0] as McpServerManifest;
const [, , CONTROL, STARTS] = SERVER.transport.args as [string, string, string, string];
const SEARCH = "mcp.fake.search_notes";
const USER = "user-1";

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

function useEnvironment(options: { encryptionKey?: boolean } = {}): void {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("JWT_SECRET", "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA");
  vi.stubEnv("BROWSER_ENABLED", "false");
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("JARVIS_MCP_ENABLED", "true");
  // A throwaway key, so the container builds its integration command service.
  vi.stubEnv("JARVIS_ENCRYPTION_KEY", options.encryptionKey ? randomBytes(32).toString("base64") : undefined);
}

/** The registry deps as the legacy route builds them, with the container's MCP runtime. */
const registryDeps = (): IntegrationDeps => ({
  googleOAuthMounted: false,
  googleConnections: null,
  readMetaCredentials: async () => null,
  mcp: mcpIntegrationRuntime,
});

const check = (deps: IntegrationDeps = registryDeps()) => runCheck(USER, "mcp", deps);

function executorOver(registry: ToolRegistry): ToolExecutor {
  const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger;
  const approvals: IApprovalManager = {
    requestApproval: vi.fn(),
    findExistingForTool: vi.fn().mockResolvedValue(null),
  };
  return new ToolExecutor(registry, new PermissionService(), approvals, audit);
}

/** Every agent's allowlist, as plain data. */
const allowlists = () =>
  Object.fromEntries(Object.entries(AGENT_POLICIES).map(([id, policy]) => [id, [...policy.allowedTools]]));

beforeEach(() => {
  __resetIntegrationChecks();
  resetContainer();
  vi.spyOn(console, "log").mockImplementation(() => {});
  rmSync(STARTS, { force: true });
  rmSync(CONTROL, { force: true });
});

afterEach(async () => {
  await Promise.all(getMcpConnections().map((connection) => connection.close()));
  resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => rmSync(dirname(STARTS), { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe("startup stays lazy", () => {
  it("starts nothing at boot — and reading the integration's state starts nothing either", async () => {
    useEnvironment();
    getContainer();
    const mcp = (await listIntegrations(USER, registryDeps())).find((view) => view.id === "mcp");
    expect(mcp?.health).toBe("UNVERIFIED");
    expect(mcp?.detail).toMatch(/fake/);
    expect(getMcpConnections()[0]!.getState()).toBe("idle");
    expect(starts()).toEqual([]);
  });
});

describe("the check runs on the managed connection the tools use", () => {
  it("is what the container hands the command service, and a tool call afterwards reuses the server it verified", async () => {
    useEnvironment({ encryptionKey: true });
    const container = getContainer();
    const serviceDeps = (container.integrationCommands as unknown as { registryDeps(): IntegrationDeps }).registryDeps();
    expect(serviceDeps.mcp).toBe(mcpIntegrationRuntime);

    expect((await check(serviceDeps))?.health).toBe("CONNECTED");
    expect(getMcpConnections()[0]!.getState()).toBe("ready");
    expect(starts()).toHaveLength(1);

    const call = await executorOver(container.toolRegistry).execute({
      toolId: SEARCH,
      params: { query: "alpha" },
      userId: USER,
      role: "admin",
      traceId: "trace-s8-5",
    });
    expect(call.status).toBe("completed");
    expect(starts()).toHaveLength(1);
  });

  it("never builds a second connection, however many checks run at once", async () => {
    useEnvironment();
    getContainer();
    const [connection] = getMcpConnections();
    const results = await Promise.all([check(), check(), check()]);
    expect(results.map((r) => r?.health)).toEqual(["CONNECTED", "CONNECTED", "CONNECTED"]);
    expect(getMcpConnections()).toHaveLength(1);
    expect(getMcpConnections()[0]).toBe(connection);
    expect(starts()).toHaveLength(1);
  });
});

describe("a check observes — it registers, grants and changes nothing", () => {
  it("leaves the tool registry, every agent policy and the manifest exactly as they were, healthy or not", async () => {
    useEnvironment();
    const container = getContainer();
    const tools = container.toolRegistry.getAll().map((t) => t.id).sort();
    const policies = allowlists();
    const general = [...container.agentRegistry.getPolicy(AGENT_IDS.general)!.allowedTools];
    const grant = [...MCP_READ_TOOLS];
    const manifest = JSON.stringify(MCP_MANIFEST);

    expect((await check())?.health).toBe("CONNECTED");
    writeFileSync(CONTROL, "drift_list");
    expect((await check())?.health).toBe("ERROR");

    expect(container.toolRegistry.getAll().map((t) => t.id).sort()).toEqual(tools);
    expect(allowlists()).toEqual(policies);
    expect([...container.agentRegistry.getPolicy(AGENT_IDS.general)!.allowedTools]).toEqual(general);
    expect([...MCP_READ_TOOLS]).toEqual(grant);
    expect(JSON.stringify(MCP_MANIFEST)).toBe(manifest);
    expect(container.toolRegistry.get("time.now")).toBeDefined();
  });
});

describe("shutdown", () => {
  it("ends the server a check started, and a later check starts nothing", async () => {
    useEnvironment();
    getContainer();
    expect((await check())?.health).toBe("CONNECTED");
    const [pid] = starts();
    expect(alive(pid!)).toBe(true);

    await Promise.all(getMcpConnections().map((connection) => connection.close()));
    expect(alive(pid!)).toBe(false);

    const after = await check();
    expect(after?.health).toBe("ERROR");
    expect(after?.detail).toMatch(/fake is unavailable/);
    expect(starts()).toHaveLength(1);
  });
});
