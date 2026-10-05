// S8.7 — honest MCP capability presentation.
//
// A reviewed MCP server whose last start or check failed already refuses every
// call (fail closed). Until S8.7 the capability report still called its tools
// usable. The existing CapabilityService now reads the managed connections'
// state — read-only, never starting, listing or verifying anything — and
// presents a failed server's tools as NOT_CONNECTED, in fixed words. Healthy
// and not-yet-started servers keep their presentation; MCP switched off keeps
// presenting nothing; native tools are untouched; nothing is ever added.
//
// Real registration (the container's registerMcpTools), real McpConnections and
// real server processes: the pilot, and the S8.2 fake server where a server
// must fail and recover on cue.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_MANIFEST,
  mcpToolFingerprint,
  type CapabilityView,
  type ITool,
  type McpServerManifest,
  type McpToolManifestEntry,
} from "@jarvis/core";
import type { McpConnection } from "@jarvis/mcp";
import { ToolRegistry } from "@jarvis/tools";
import { getContainer, getMcpConnections, registerMcpTools, resetContainer } from "../src/services/container.js";
import { CapabilityService, type CapabilityDeps } from "../src/services/capabilities/capability-service.js";
import { mcpToolUnavailable } from "../src/services/integration-registry.js";

type Obj = Record<string, unknown>;

const PILOT = MCP_MANIFEST.servers[0]!;
const FIXTURES = new URL("../../../packages/mcp/test/fixtures/", import.meta.url);
const SPEC = JSON.parse(readFileSync(new URL("fake-tools.json", FIXTURES), "utf8")) as {
  serverInfo: { name: string; version: string };
  tools: Obj[];
};

const opened: McpConnection[] = [];
const dirs: string[] = [];

/** The S8.2 fake server, controllable through `set`, reviewed as server "fake". */
function controllable(): { server: McpServerManifest; set(value: string): void } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mcp-presentation-"));
  dirs.push(dir);
  const control = join(dir, "control");
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
      transport: { kind: "stdio", command: "node", args: [fileURLToPath(new URL("fake-server.mjs", FIXTURES)), "controlled", control, join(dir, "starts")] },
      env: {},
      expectedServerInfo: SPEC.serverInfo,
      tools,
    },
    set: (value) => writeFileSync(control, value),
  };
}

/** The pilot under a review its live listing no longer matches. */
function driftedPilot(): McpServerManifest {
  const tools = PILOT.tools.map((tool) => {
    if (tool.name !== "days_between") return tool;
    const reviewed = { ...tool, description: "Counts calendar days, as worded at an older review." };
    return { ...reviewed, fingerprint: mcpToolFingerprint(reviewed) };
  });
  return { ...PILOT, tools };
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
  execute: async () => ({ success: true }),
  validate: () => true,
};

/** A registry holding these reviewed servers (as the container registers them) and one native tool. */
function registryWith(...servers: McpServerManifest[]): { registry: ToolRegistry; connections: McpConnection[] } {
  const registry = new ToolRegistry();
  registry.register(native);
  const connections = registerMcpTools(registry, { servers });
  expect(connections, "the manifest was refused").toHaveLength(servers.length);
  opened.push(...connections);
  return { registry, connections };
}

/** The capability report, keyed by id — with the S8.7 runtime read, or without it as before S8.7. */
async function presentation(
  registry: ToolRegistry,
  connections: readonly McpConnection[] | null
): Promise<Map<string, CapabilityView>> {
  const deps: CapabilityDeps = {
    toolRegistry: registry,
    integrations: { listIntegrations: async () => [] },
    allowedToolIds: new Set(registry.getAll().map((t) => t.id)),
    ...(connections ? { runtimeUnavailable: (toolId: string) => mcpToolUnavailable(connections, toolId) } : {}),
  };
  const report = await new CapabilityService(deps).report("user-s8-7");
  return new Map(report.capabilities.map((c) => [c.id, c]));
}

const processes = () => process.getActiveResourcesInfo().filter((r) => r === "ProcessWrap").length;

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
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

describe("a healthy server", () => {
  it("keeps exactly its pre-S8.7 presentation, before its first use and once verified", async () => {
    const { registry, connections } = registryWith(PILOT);
    const before = await presentation(registry, null);
    expect(before.get("mcp.dates.days_between")?.availability).toBe("EXECUTABLE");

    expect(await presentation(registry, connections)).toEqual(before);
    expect(connections[0]!.getState()).toBe("idle");

    expect(await connections[0]!.verify()).toEqual({ ok: true });
    expect(await presentation(registry, connections)).toEqual(before);
  });
});

describe("a server whose last start or check failed", () => {
  it("is presented as unavailable, in fixed words — and only that changes", async () => {
    const { registry, connections } = registryWith(driftedPilot());
    const healthy = await presentation(registry, connections);
    expect((await connections[0]!.verify()).ok).toBe(false);

    const failed = await presentation(registry, connections);
    for (const id of ["mcp.dates.days_between", "mcp.dates.day_of_week"]) {
      expect(failed.get(id)).toEqual({
        ...healthy.get(id),
        availability: "NOT_CONNECTED",
        reason: expect.stringMatching(/failed its last start or check/),
        requiredAction: expect.stringMatching(/Test Connection/),
      });
    }
  });

  it("uses the same fixed words whatever failed — never the server's own text", async () => {
    const drifted = registryWith(driftedPilot());
    await drifted.connections[0]!.verify();
    const missing = registryWith({ ...PILOT, transport: { ...PILOT.transport, args: ["pilot/no-such-server.mjs"] } });
    await missing.connections[0]!.verify();
    const closed = registryWith(PILOT);
    await closed.connections[0]!.close();

    const views = [
      (await presentation(drifted.registry, drifted.connections)).get("mcp.dates.day_of_week")!,
      (await presentation(missing.registry, missing.connections)).get("mcp.dates.day_of_week")!,
      (await presentation(closed.registry, closed.connections)).get("mcp.dates.day_of_week")!,
    ];
    expect(views.map((v) => v.availability)).toEqual(["NOT_CONNECTED", "NOT_CONNECTED", "NOT_CONNECTED"]);
    expect(new Set(views.map((v) => `${v.reason}|${v.requiredAction}`)).size).toBe(1);
    expect(JSON.stringify(views)).not.toMatch(/Cannot find module|no-such-server|older review|SCHEMA_INVALID|Error/);
  });

  it("is usable again once it passes its check — the reviewed tools return, and nothing else appears", async () => {
    const fake = controllable();
    const { registry, connections } = registryWith(fake.server);
    const ids = [...(await presentation(registry, connections)).keys()].sort();

    fake.set("fail");
    expect((await connections[0]!.verify()).ok).toBe(false);
    expect((await presentation(registry, connections)).get("mcp.fake.search_notes")?.availability).toBe("NOT_CONNECTED");

    fake.set("ok");
    expect(await connections[0]!.verify()).toEqual({ ok: true });
    const recovered = await presentation(registry, connections);
    expect(recovered.get("mcp.fake.search_notes")?.availability).toBe("EXECUTABLE");
    expect([...recovered.keys()].sort()).toEqual(ids);
  });
});

describe("what it never does", () => {
  it("touches only the failed server's tools — another server and every native tool keep their presentation", async () => {
    const fake = controllable();
    fake.set("fail");
    const { registry, connections } = registryWith(PILOT, fake.server);
    expect(await connections[0]!.verify()).toEqual({ ok: true });
    expect((await connections[1]!.verify()).ok).toBe(false);

    const before = await presentation(registry, null);
    const after = await presentation(registry, connections);
    expect(after.get("mcp.dates.days_between")).toEqual(before.get("mcp.dates.days_between"));
    expect(after.get("time.now")).toEqual(before.get("time.now"));
    expect(after.get("mcp.fake.search_notes")?.availability).toBe("NOT_CONNECTED");
  });

  it("starts, lists and verifies nothing to decide — an idle server stays idle", async () => {
    // A server closed by the test before can take a moment to release its handle.
    await until(() => processes() === 0);
    const { registry, connections } = registryWith(PILOT);
    await presentation(registry, connections);
    await presentation(registry, connections);
    expect(connections[0]!.getState()).toBe("idle");
    expect(processes()).toBe(0);
  });

  it("answers nothing about a tool that is not a registered server's", () => {
    const { connections } = registryWith(PILOT);
    expect(mcpToolUnavailable(connections, "time.now")).toBeNull();
    expect(mcpToolUnavailable(connections, "mcp.unknown.days_between")).toBeNull();
    expect(mcpToolUnavailable([], "mcp.dates.days_between")).toBeNull();
  });
});

describe("in the container", () => {
  function useEnvironment(mcpEnabled: string | undefined): void {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("JWT_SECRET", "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA");
    vi.stubEnv("BROWSER_ENABLED", "false");
    vi.stubEnv("OPENAI_API_KEY", undefined);
    // A throwaway key, so the container builds its CapabilityService.
    vi.stubEnv("JARVIS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("JARVIS_MCP_ENABLED", mcpEnabled);
  }

  const runtimeOf = () =>
    (getContainer().capabilities as unknown as { deps: CapabilityDeps }).deps.runtimeUnavailable!;

  it("is wired into the existing CapabilityService, reading the managed connections tool calls use", async () => {
    useEnvironment("true");
    const unavailable = runtimeOf();
    expect(unavailable("mcp.dates.days_between")).toBeNull();
    expect(unavailable("time.now")).toBeNull();

    await Promise.all(getMcpConnections().map((connection) => connection.close()));
    expect(unavailable("mcp.dates.days_between")).toMatchObject({ reason: expect.stringMatching(/failed its last start or check/) });
    expect(unavailable("time.now")).toBeNull();
  });

  it("keeps presenting no MCP capability at all while MCP is switched off", () => {
    useEnvironment(undefined);
    const unavailable = runtimeOf();
    expect(getContainer().toolRegistry.getAll().filter((t) => t.id.startsWith("mcp."))).toEqual([]);
    expect(unavailable("mcp.dates.days_between")).toBeNull();
  });
});
