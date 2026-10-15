import {
  automationRecordFromMcpTool,
  mcpFailure,
  type AutomationRecord,
  type McpCallResult,
  type McpFailure,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// The n8n MCP connector (S8.7)
// ---------------------------------------------------------------------------
// The REST surface answers "which workflows exist and how did they run"; this
// one answers "which automation tools may be discovered and invoked". They are
// different surfaces of the same instance and they are NOT interchangeable: the
// REST client cannot invoke a tool, and this connector cannot list an inactive
// workflow's metadata or read an execution.
//
// THE TRANSPORT IS INJECTED. This module never imports the MCP SDK and never
// builds a socket. It takes the narrow `N8nMcpTransport` it needs — `connect`,
// `listTools`, `callTool`, `close` — which the composition root (apps/api) fills
// with an `HttpMcpConnection` from `@jarvis/mcp`, and a test fills with a stub.
// That keeps the provider package SDK-free and makes every path here testable
// without a network.
//
// DISCOVERY IS THE GATE FOR INVOCATION. `invokeTool` refuses a name that the
// most recent discovery did not return. A model (or a caller) cannot name a tool
// it was never shown, so the set of invocable tools is exactly the set the
// server actually exposed — never an arbitrary string that happens to route.
//
// ERRORS ARE VALUES. Every method resolves with `{ ok: false, failure }` and a
// fixed sentence; a provider's own text is never carried, because an n8n error
// can echo a request header back.
// ---------------------------------------------------------------------------

export interface N8nMcpTool {
  name: string;
  description: string | null;
  inputSchema: Readonly<Record<string, unknown>> | null;
  /** The server's own annotation. Advisory — a hint is not a permission. */
  readOnly: boolean;
  destructive: boolean;
}

export interface N8nMcpServerInfo {
  name: string;
  version: string;
}

export interface N8nMcpDiscovery {
  tools: readonly N8nMcpTool[];
  serverInfo: N8nMcpServerInfo | null;
  /** True when the transport's page or tool ceiling cut the listing short. */
  truncated: boolean;
}

export type N8nMcpResult<T> = { ok: true; data: T } | { ok: false; failure: McpFailure };

/**
 * The slice of a remote MCP connection this connector needs. Structural, so an
 * `HttpMcpConnection` satisfies it without this package depending on the SDK.
 */
export interface N8nMcpTransport {
  connect(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; failure: McpFailure }>;
  listTools(signal?: AbortSignal): Promise<N8nMcpResult<N8nMcpDiscovery>>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface N8nMcpConnectorOptions {
  /** The provider id records carry. "n8n" today; an instance id for a fleet. */
  providerId?: string;
}

export interface N8nMcpConnector {
  /** The endpoint this connector speaks to. Safe to show — it holds no secret. */
  readonly endpoint: string;
  /** Lists the tools the server exposes now, bounded by the transport. */
  discoverTools(signal?: AbortSignal): Promise<N8nMcpResult<N8nMcpDiscovery>>;
  /** Invokes a DISCOVERED tool. The caller owns the approval boundary. */
  invokeTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<McpCallResult>;
  /** Ends the session. Idempotent. */
  close(): Promise<void>;
}

/**
 * A discovered tool as a registry record, so REST workflows and MCP tools land
 * in one normalized view (`@jarvis/core`'s automation registry).
 */
export function n8nMcpAutomationRecords(
  providerId: string,
  tools: readonly N8nMcpTool[]
): AutomationRecord[] {
  return tools.map((tool) =>
    automationRecordFromMcpTool(providerId, {
      name: tool.name,
      description: tool.description,
      readOnly: tool.readOnly,
      // A tool that names the workflow it targets lets the registry link it to
      // the REST workflow of the same id. n8n does not always, so this is
      // best-effort and the merge treats a missing link as "no link".
      workflowId: typeof tool.inputSchema?.workflowId === "string" ? tool.inputSchema.workflowId : null,
    })
  );
}

export function createN8nMcpConnector(
  transport: N8nMcpTransport,
  options: N8nMcpConnectorOptions = {}
): N8nMcpConnector & { readonly providerId: string } {
  const providerId = options.providerId ?? "n8n";
  // The names the last discovery returned. `null` means "not discovered yet",
  // which is NOT the same as "discovered nothing" — an empty set.
  let discoveredNames: Set<string> | null = null;

  return {
    providerId,

    get endpoint(): string {
      // The transport owns the URL; when it exposes one, report it. A stub
      // transport without one reports a fixed placeholder rather than a lie.
      const withUrl = transport as { url?: unknown };
      return typeof withUrl.url === "string" ? withUrl.url : "";
    },

    async discoverTools(signal?: AbortSignal): Promise<N8nMcpResult<N8nMcpDiscovery>> {
      const result = await transport.listTools(signal);
      if (!result.ok) {
        // A failed discovery leaves the gate CLOSED: the previous set is
        // discarded, so a subsequent invoke cannot ride on a stale listing.
        discoveredNames = null;
        return result;
      }
      discoveredNames = new Set(result.data.tools.map((tool) => tool.name));
      return result;
    },

    async invokeTool(
      name: string,
      args: Readonly<Record<string, unknown>>,
      signal?: AbortSignal
    ): Promise<McpCallResult> {
      if (discoveredNames === null) {
        // Never discovered: discover first, so the gate is a real listing and
        // not a guess. A discovery failure is reported as itself.
        const discovery = await this.discoverTools(signal);
        if (!discovery.ok) return { ok: false, failure: discovery.failure };
      }
      if (!discoveredNames!.has(name)) {
        return { ok: false, failure: mcpFailure("TOOL_NOT_FOUND") };
      }
      return transport.callTool(name, args, signal);
    },

    close(): Promise<void> {
      return transport.close();
    },
  };
}
