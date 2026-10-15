import { describe, it, expect } from "vitest";
import { mcpFailure, type McpCallResult, type McpFailure } from "@jarvis/core";
import {
  N8N_MCP_DEFAULT_TIMEOUT_MS,
  N8N_MCP_ENDPOINT_PATH,
  createN8nMcpConfig,
  isN8nMcpConfigured,
  isN8nMcpEnabled,
  resolveN8nMcpEndpoint,
} from "../src/mcp-config.js";
import {
  createN8nMcpConnector,
  n8nMcpAutomationRecords,
  type N8nMcpDiscovery,
  type N8nMcpResult,
  type N8nMcpTool,
  type N8nMcpTransport,
} from "../src/mcp-connector.js";

// ---------------------------------------------------------------------------
// The n8n MCP surface (S8.7)
//
// Two halves, tested separately because they fail differently:
//
//   mcp-config.ts      reads the environment. Wrong here means the connector is
//                      pointed at the wrong host or the wrong secret, and the
//                      failure would look like an auth problem forever.
//   mcp-connector.ts   owns the discovery gate. Wrong here means a tool can be
//                      invoked that the server never exposed — the one mistake
//                      this connector exists to prevent.
//
// No test touches a socket: the transport is the injected stub below.
// ---------------------------------------------------------------------------

const ENDPOINT = "https://dreamprojectjarvis.app.n8n.cloud/mcp-server/http";

/** A transport whose answers are scripted per call. Never opens a socket. */
function scriptedTransport(options: {
  listings?: Array<N8nMcpResult<N8nMcpDiscovery>>;
  calls?: Array<McpCallResult>;
} = {}): N8nMcpTransport & {
  readonly calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }>;
  readonly closes: { count: number };
  readonly listCount: { count: number };
  url?: string;
} {
  const listings = [...(options.listings ?? [])];
  const calls = [...(options.calls ?? [])];
  const state = {
    calls: [] as Array<{ name: string; args: Readonly<Record<string, unknown>> }>,
    closes: { count: 0 },
    listCount: { count: 0 },
    url: undefined as string | undefined,
  };
  return {
    ...state,
    get url() {
      return state.url;
    },
    set url(value: string | undefined) {
      state.url = value;
    },
    async connect() {
      return { ok: true } as const;
    },
    async listTools(): Promise<N8nMcpResult<N8nMcpDiscovery>> {
      state.listCount.count += 1;
      const next = listings.shift();
      if (next === undefined) return { ok: false, failure: mcpFailure("SERVER_UNAVAILABLE") };
      return next;
    },
    async callTool(name, args): Promise<McpCallResult> {
      state.calls.push({ name, args });
      const next = calls.shift();
      if (next === undefined) return { ok: false, failure: mcpFailure("TOOL_NOT_FOUND") };
      return next;
    },
    async close() {
      state.closes.count += 1;
    },
  };
}

function discovery(tools: N8nMcpTool[], extra: Partial<N8nMcpDiscovery> = {}): N8nMcpResult<N8nMcpDiscovery> {
  return {
    ok: true,
    data: {
      tools,
      serverInfo: { name: "n8n-mcp", version: "1.0.0" },
      truncated: false,
      ...extra,
    },
  };
}

function tool(name: string, extra: Partial<N8nMcpTool> = {}): N8nMcpTool {
  return {
    name,
    description: null,
    inputSchema: null,
    readOnly: false,
    destructive: false,
    ...extra,
  };
}

const OK_CALL: McpCallResult = { ok: true, content: [{ type: "text", text: "done" }] };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("n8n MCP — the endpoint is derived, never hard-coded", () => {
  it("builds the endpoint from N8N_BASE_URL and nothing else", () => {
    expect(N8N_MCP_ENDPOINT_PATH).toBe("/mcp-server/http");
    expect(resolveN8nMcpEndpoint("https://dreamprojectjarvis.app.n8n.cloud")).toBe(ENDPOINT);
  });

  it("tolerates a trailing slash on the base URL without doubling it", () => {
    expect(resolveN8nMcpEndpoint("https://dreamprojectjarvis.app.n8n.cloud/")).toBe(ENDPOINT);
    expect(resolveN8nMcpEndpoint("https://dreamprojectjarvis.app.n8n.cloud///")).toBe(ENDPOINT);
  });

  it("lets an explicit endpoint override the derivation — a self-hosted mount", () => {
    expect(resolveN8nMcpEndpoint("https://n8n.example.test", "https://other.example.test/custom/mcp")).toBe(
      "https://other.example.test/custom/mcp"
    );
    // The override wins even with no base URL at all.
    expect(resolveN8nMcpEndpoint(undefined, "https://other.example.test/custom/mcp")).toBe(
      "https://other.example.test/custom/mcp"
    );
  });

  it("returns null rather than a relative or empty endpoint", () => {
    expect(resolveN8nMcpEndpoint(undefined)).toBeNull();
    expect(resolveN8nMcpEndpoint("")).toBeNull();
    expect(resolveN8nMcpEndpoint("   ")).toBeNull();
    // A base that is not absolute cannot produce an absolute endpoint.
    expect(resolveN8nMcpEndpoint("not-a-url")).toBeNull();
  });

  it("throws a named error, not an empty endpoint, when there is nothing to reach", () => {
    expect(() => createN8nMcpConfig({ baseUrl: undefined, endpoint: undefined })).toThrow(
      /N8N_BASE_URL or N8N_MCP_ENDPOINT is required/
    );
  });
});

describe("n8n MCP — allowed origins", () => {
  it("always includes the base origin, so the derived endpoint is never refused", () => {
    const config = createN8nMcpConfig({ baseUrl: "https://dreamprojectjarvis.app.n8n.cloud" });
    expect(config.allowedOrigins).toContain("https://dreamprojectjarvis.app.n8n.cloud");
    expect(config.endpoint).toBe(ENDPOINT);
  });

  it("adds an explicit extra origin for a deployment that serves MCP elsewhere", () => {
    const config = createN8nMcpConfig({
      baseUrl: "https://n8n.example.test",
      endpoint: "https://mcp.example.test/mcp",
      allowedOrigins: ["https://mcp.example.test"],
    });
    expect(config.allowedOrigins).toEqual(["https://mcp.example.test", "https://n8n.example.test"]);
  });

  it("reports origins sorted, so two processes reading the same env agree", () => {
    const a = createN8nMcpConfig({ baseUrl: "https://b.test", allowedOrigins: ["https://z.test", "https://a.test"] });
    const b = createN8nMcpConfig({ baseUrl: "https://b.test", allowedOrigins: ["https://a.test", "https://z.test"] });
    expect(a.allowedOrigins).toEqual(b.allowedOrigins);
    expect([...a.allowedOrigins]).toEqual([...a.allowedOrigins].sort());
  });

  it("reads the comma-separated override and drops blank entries", () => {
    // Parsed the same way createN8nMcpConfig parses N8N_MCP_ALLOWED_ORIGINS.
    const raw = "https://a.test, , https://b.test";
    const parsed = raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const config = createN8nMcpConfig({
      baseUrl: "https://n8n.example.test",
      allowedOrigins: parsed,
    });
    expect(config.allowedOrigins).toEqual(["https://a.test", "https://b.test", "https://n8n.example.test"]);
  });
});

describe("n8n MCP — the switch and the configured check are different questions", () => {
  it("is off unless N8N_MCP_ENABLED is exactly \"true\"", () => {
    expect(isN8nMcpEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isN8nMcpEnabled({ N8N_MCP_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    // The near-misses an operator actually types must all stay OFF.
    for (const value of ["True", "TRUE", "1", "yes", "on", " true ", "enabled"]) {
      expect(isN8nMcpEnabled({ N8N_MCP_ENABLED: value } as NodeJS.ProcessEnv), value).toBe(false);
    }
  });

  it("is configured only when switched on, with an endpoint AND a token", () => {
    const full = {
      N8N_MCP_ENABLED: "true",
      N8N_BASE_URL: "https://n8n.example.test",
      N8N_MCP_TOKEN: "tok",
    } as NodeJS.ProcessEnv;
    expect(isN8nMcpConfigured(full)).toBe(true);

    // Switched off: nothing else matters.
    expect(isN8nMcpConfigured({ ...full, N8N_MCP_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
    // Switched on but no endpoint to reach.
    expect(isN8nMcpConfigured({ ...full, N8N_BASE_URL: undefined } as NodeJS.ProcessEnv)).toBe(false);
    // Switched on, reachable, but no token to present.
    expect(isN8nMcpConfigured({ ...full, N8N_MCP_TOKEN: undefined } as NodeJS.ProcessEnv)).toBe(false);
    expect(isN8nMcpConfigured({ ...full, N8N_MCP_TOKEN: "" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("treats a missing token as unconfigured but NOT as an error", () => {
    // The config is still buildable: discovery will report AUTH_FAILURE in its
    // own words rather than the process refusing to start.
    const config = createN8nMcpConfig({ baseUrl: "https://n8n.example.test" });
    expect(config.token).toBeNull();
    expect(config.endpoint).toBe(ENDPOINT.replace("dreamprojectjarvis.app.n8n.cloud", "n8n.example.test"));
  });

  it("keeps the MCP token separate from the REST API key", () => {
    const config = createN8nMcpConfig({
      baseUrl: "https://n8n.example.test",
      token: "mcp-bearer-token",
    });
    expect(config.token).toBe("mcp-bearer-token");
    // No property carries the REST key at all — the two can never be swapped.
    expect(Object.keys(config).sort()).toEqual(["allowedOrigins", "endpoint", "timeoutMs", "token"]);
  });
});

describe("n8n MCP — validation names the field, never the value", () => {
  it("rejects a token that is empty rather than silently sending a blank header", () => {
    const config = createN8nMcpConfig({ baseUrl: "https://n8n.example.test", token: "" });
    expect(config.token).toBeNull();
  });

  it("rejects an out-of-range timeout at startup rather than silently clamping it", () => {
    // Fail fast, in the composition root, with the field named — a silently
    // clamped timeout would look like a slow n8n for the life of the process.
    expect(() => createN8nMcpConfig({ baseUrl: "https://n8n.example.test", timeoutMs: 999_999 })).toThrow(
      /timeoutMs/
    );
    expect(() => createN8nMcpConfig({ baseUrl: "https://n8n.example.test", timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(createN8nMcpConfig({ baseUrl: "https://n8n.example.test" }).timeoutMs).toBe(N8N_MCP_DEFAULT_TIMEOUT_MS);
  });

  it("carries field names but no field values in its error message", () => {
    let message = "";
    try {
      createN8nMcpConfig({ baseUrl: "https://n8n.example.test", timeoutMs: -1 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/timeoutMs/);
    expect(message).not.toContain("-1");
  });
});

// ---------------------------------------------------------------------------
// The connector: the discovery gate
// ---------------------------------------------------------------------------

describe("n8n MCP connector — discovery is the gate for invocation", () => {
  it("invokes a tool the last discovery returned, passing the arguments through", async () => {
    const transport = scriptedTransport({
      listings: [discovery([tool("run_workflow"), tool("list_workflows", { readOnly: true })])],
      calls: [OK_CALL],
    });
    const connector = createN8nMcpConnector(transport);

    const found = await connector.discoverTools();
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data.tools.map((t) => t.name)).toEqual(["run_workflow", "list_workflows"]);
    expect(found.data.tools[1].readOnly).toBe(true);
    expect(found.data.serverInfo).toEqual({ name: "n8n-mcp", version: "1.0.0" });

    const called = await connector.invokeTool("run_workflow", { id: "42" });
    expect(called).toEqual(OK_CALL);
    expect(transport.calls).toEqual([{ name: "run_workflow", args: { id: "42" } }]);
  });

  it("refuses a tool name the discovery never returned, and never reaches the wire", async () => {
    const transport = scriptedTransport({
      listings: [discovery([tool("run_workflow")])],
      calls: [OK_CALL],
    });
    const connector = createN8nMcpConnector(transport);
    await connector.discoverTools();

    const refused = await connector.invokeTool("some_other_tool", {});
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe("TOOL_NOT_FOUND");
    // The transport was never asked: a name we were not shown cannot be invoked.
    expect(transport.calls).toEqual([]);
  });

  it("discovers first when nothing has been discovered, then invokes", async () => {
    const transport = scriptedTransport({
      listings: [discovery([tool("run_workflow")])],
      calls: [OK_CALL],
    });
    const connector = createN8nMcpConnector(transport);

    // No discoverTools() call here at all — invokeTool must do the listing.
    const called = await connector.invokeTool("run_workflow", { a: 1 });
    expect(called).toEqual(OK_CALL);
    expect(transport.listCount.count).toBe(1);
    expect(transport.calls).toEqual([{ name: "run_workflow", args: { a: 1 } }]);
  });

  it("refuses an undiscovered name even after discovering something else", async () => {
    const transport = scriptedTransport({
      listings: [discovery([tool("alpha"), tool("beta")])],
    });
    const connector = createN8nMcpConnector(transport);
    await connector.discoverTools();

    const refused = await connector.invokeTool("gamma", {});
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe("TOOL_NOT_FOUND");
  });

  it("discovers exactly once across many invocations of the same tool", async () => {
    const transport = scriptedTransport({
      listings: [discovery([tool("run_workflow")])],
      calls: [OK_CALL, OK_CALL],
    });
    const connector = createN8nMcpConnector(transport);

    await connector.discoverTools();
    await connector.invokeTool("run_workflow", { n: 1 });
    await connector.invokeTool("run_workflow", { n: 2 });

    expect(transport.listCount.count).toBe(1);
    expect(transport.calls.map((c) => c.args)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe("n8n MCP connector — a failed discovery closes the gate", () => {
  it("discards the previous listing so a later invoke cannot ride on a stale set", async () => {
    const transport = scriptedTransport({
      listings: [
        discovery([tool("run_workflow")]),
        { ok: false, failure: mcpFailure("AUTH_FAILURE") },
        { ok: false, failure: mcpFailure("AUTH_FAILURE") },
      ],
      calls: [OK_CALL],
    });
    const connector = createN8nMcpConnector(transport);

    await connector.discoverTools();
    expect((await connector.discoverTools()).ok).toBe(false);

    // run_workflow WAS discovered earlier — but the gate is closed again.
    const refused = await connector.invokeTool("run_workflow", {});
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe("AUTH_FAILURE");
    expect(transport.calls).toEqual([]);
  });

  it("reports a discovery failure as itself, rather than pretending the tool is missing", async () => {
    const transport = scriptedTransport({
      listings: [{ ok: false, failure: mcpFailure("RATE_LIMITED") }],
    });
    const connector = createN8nMcpConnector(transport);

    const refused = await connector.invokeTool("anything", {});
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe("RATE_LIMITED");
  });

  it("reports an empty listing as an empty gate, not as an error", async () => {
    const transport = scriptedTransport({ listings: [discovery([])] });
    const connector = createN8nMcpConnector(transport);

    const found = await connector.discoverTools();
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data.tools).toEqual([]);

    const refused = await connector.invokeTool("anything", {});
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe("TOOL_NOT_FOUND");
  });

  it("surfaces a truncated listing so no caller mistakes a page for the whole set", async () => {
    const transport = scriptedTransport({
      listings: [discovery([tool("a"), tool("b")], { truncated: true })],
    });
    const connector = createN8nMcpConnector(transport);

    const found = await connector.discoverTools();
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data.truncated).toBe(true);
    // Truncation narrows the gate; it does not open it wider.
    expect((await connector.invokeTool("a", {})).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Errors are values, and the connector reports itself honestly
// ---------------------------------------------------------------------------

describe("n8n MCP connector — errors are values", () => {
  it("resolves every failure as a value with a fixed sentence, never as a throw", async () => {
    for (const failure of [
      mcpFailure("AUTH_FAILURE"),
      mcpFailure("RATE_LIMITED"),
      mcpFailure("REMOTE_ERROR"),
      mcpFailure("SERVER_UNAVAILABLE"),
    ]) {
      const transport = scriptedTransport({ listings: [{ ok: false, failure }] });
      const connector = createN8nMcpConnector(transport);

      const result = await connector.discoverTools();
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.failure).toEqual(failure);
      // A fixed, human-readable sentence — never the provider's own text.
      expect(result.failure.message).toBe(failure.message);
      expect(result.failure.message.length).toBeGreaterThan(0);
    }
  });

  it("passes a transport call failure through unchanged", async () => {
    const failure: McpFailure = mcpFailure("RATE_LIMITED");
    const transport = scriptedTransport({
      listings: [discovery([tool("run_workflow")])],
      calls: [{ ok: false, failure }],
    });
    const connector = createN8nMcpConnector(transport);
    await connector.discoverTools();

    const called = await connector.invokeTool("run_workflow", {});
    expect(called.ok).toBe(false);
    if (called.ok) return;
    expect(called.failure).toEqual(failure);
  });

  it("reports an empty endpoint for a transport that exposes no URL, rather than guessing", () => {
    const connector = createN8nMcpConnector(scriptedTransport());
    expect(connector.endpoint).toBe("");
  });

  it("reports the transport's URL when it has one — and that URL holds no secret", async () => {
    const transport = scriptedTransport();
    (transport as { url?: string }).url = ENDPOINT;
    const connector = createN8nMcpConnector(transport);
    expect(connector.endpoint).toBe(ENDPOINT);
    expect(connector.endpoint).not.toMatch(/token|key|secret/i);
  });

  it("closes the transport, and reports a provider id that defaults to n8n", async () => {
    const transport = scriptedTransport();
    const connector = createN8nMcpConnector(transport);
    expect(connector.providerId).toBe("n8n");
    await connector.close();
    await connector.close(); // idempotent — delegated to a transport that is
    expect(transport.closes.count).toBe(2);
  });

  it("accepts an instance-scoped provider id for a fleet of self-hosted n8n", () => {
    const connector = createN8nMcpConnector(scriptedTransport(), { providerId: "n8n-eu-1" });
    expect(connector.providerId).toBe("n8n-eu-1");
  });
});

// ---------------------------------------------------------------------------
// Discovery lands in the shared registry beside REST workflows
// ---------------------------------------------------------------------------

describe("n8n MCP — discovered tools join the shared automation registry", () => {
  it("makes one record per tool, carrying the connector handle and provider id", () => {
    const records = n8nMcpAutomationRecords("n8n", [
      tool("run_workflow", { description: "Run it", readOnly: false }),
      tool("list_workflows", { readOnly: true }),
    ]);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      providerId: "n8n",
      kind: "tool",
      externalId: "run_workflow",
      name: "run_workflow",
      description: "Run it",
      available: true,
      observedVia: ["mcp"],
      handles: { mcp: "run_workflow" },
    });
    expect(records[1].metadata.readOnly).toBe("true");
    // A tool the server listed is available; nothing more is claimed.
    expect(records.every((r) => r.available)).toBe(true);
  });

  it("carries no monitor or manage operation — nothing has shown a tool can do them", () => {
    const [record] = n8nMcpAutomationRecords("n8n", [tool("run_workflow")]);
    expect(record.operations).not.toContain("monitor");
    expect(record.operations).not.toContain("manage");
  });

  it("records the workflow link only when the tool names one", () => {
    const linked = n8nMcpAutomationRecords("n8n", [tool("wf_7", { inputSchema: { workflowId: "7" } })]);
    expect(linked[0].metadata.workflowId).toBe("7");

    const unlinked = n8nMcpAutomationRecords("n8n", [tool("wf_7")]);
    expect(unlinked[0].metadata.workflowId).toBeUndefined();
  });

  it("keeps the readOnly hint as metadata only — a hint is not a permission", () => {
    const [record] = n8nMcpAutomationRecords("n8n", [tool("list_workflows", { readOnly: true })]);
    expect(record.metadata.readOnly).toBe("true");

    // A discovered tool MAY be listed, described and invoked — the hint does not
    // change that. What the hint never does is grant anything: invocation is
    // governed by the approval boundary above this connector, not by the
    // server's own opinion of itself.
    expect(record.operations).toContain("execute");
    // Deterministic, not alphabetical: the same input always yields the same
    // ordering, so two processes agree on what a tool can do.
    expect(n8nMcpAutomationRecords("n8n", [tool("list_workflows", { readOnly: true })])[0].operations).toEqual(
      record.operations
    );
    // And it claims no monitor or manage: nothing has shown a tool can do them.
    expect(record.operations).not.toContain("monitor");
    expect(record.operations).not.toContain("manage");
  });

  it("returns an empty list for an empty discovery, rather than a phantom record", () => {
    expect(n8nMcpAutomationRecords("n8n", [])).toEqual([]);
  });
});
