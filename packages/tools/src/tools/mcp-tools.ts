// ---------------------------------------------------------------------------
// S8.3 — MCP tools as ordinary JARVIS tools.
//
// One reviewed manifest entry becomes one ITool. Everything the model or the
// executor can see — id, name, description, parameters, risk, permissions —
// comes from the reviewed entry; a live server can change none of it.
//
// The tool owns no process. It asks its McpCallPort to be ready and to call;
// spawning, verification and the breaker belong to the runtime
// (packages/mcp). Approval, policy, permissions, audit and the deadline stay
// with ToolExecutor. Nothing here registers anything: the API container does (S8.4).
// ---------------------------------------------------------------------------

import {
  mcpFailure,
  mcpToolId,
  untrustedContentMetadata,
  validateMcpArguments,
  validateMcpManifest,
  type McpCallPort,
  type McpCallResult,
  type McpFailure,
  type McpServerManifest,
  type McpToolManifestEntry,
  type ToolContext,
  type ToolParameter,
  type ToolResult,
} from "@jarvis/core";
import { BaseTool } from "../base-tool.js";

/** A failure as a ToolResult: the provider's fixed sentence for people, its code for logs. */
const failed = (failure: McpFailure): ToolResult => ({
  success: false,
  error: failure.message,
  metadata: { mcpFailureCode: failure.code },
});

/** The reviewed input schema as the flat parameter list ITool speaks. */
function parametersOf(entry: McpToolManifestEntry): ToolParameter[] {
  const required = entry.inputSchema.required ?? [];
  return Object.entries(entry.inputSchema.properties).map(([name, property]) => ({
    name,
    type: property.type,
    description: property.description ?? "",
    required: required.includes(name),
  }));
}

/** Content blocks as data, marked untrusted the way every remote-content tool is. */
function toToolResult(result: McpCallResult): ToolResult {
  if (!result.ok) return failed(result.failure);
  const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  return {
    success: true,
    data:
      result.structuredContent === undefined
        ? { content: result.content }
        : { content: result.content, structuredContent: result.structuredContent },
    metadata: untrustedContentMetadata(text),
  };
}

/** One reviewed MCP tool. Build it through createMcpTools. */
export class McpTool extends BaseTool {
  constructor(
    server: McpServerManifest,
    private readonly entry: McpToolManifestEntry,
    private readonly port: McpCallPort
  ) {
    // The S8.1 naming rule decides the id; the entry must agree with it.
    const id = mcpToolId(server.id, entry.name);
    if (id !== entry.id) throw new Error("The MCP server manifest is not valid");
    super(
      id,
      entry.name,
      entry.description,
      "integration",
      parametersOf(entry),
      entry.requiresApproval,
      [...entry.requiredPermissions],
      entry.risk,
      server.expectedServerInfo.version,
      entry.enabled
    );
  }

  /** The reviewed schema decides — never a live one. */
  validate(params: Record<string, unknown>): boolean {
    return validateMcpArguments(this.entry, params);
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!this.entry.enabled) return failed(mcpFailure("TOOL_NOT_FOUND"));
    if (!this.validate(params)) return failed(mcpFailure("INVALID_ARGUMENTS"));
    try {
      const ready = await this.port.connect(context.signal);
      if (!ready.ok) return failed(ready.failure);
      // The port must have verified this very review: not another server's
      // tool of the same name, not another listing under the same id.
      const verified = this.port
        .listVerifiedTools()
        .some((tool) => tool.id === this.entry.id && tool.fingerprint === this.entry.fingerprint);
      if (!verified) return failed(mcpFailure("TOOL_NOT_FOUND"));
      return toToolResult(await this.port.callTool(this.entry.name, params, context.signal));
    } catch {
      // A port that throws is broken; what it threw is never passed on.
      return failed(mcpFailure("UNKNOWN"));
    }
  }
}

/**
 * One ITool per enabled, reviewed entry of one server — nothing for a disabled
 * entry, nothing that was never reviewed. Throws on a manifest S8.1 would not
 * accept. Registers nothing and touches no port: wiring is the caller's.
 */
export function createMcpTools(server: McpServerManifest, port: McpCallPort): McpTool[] {
  if (!validateMcpManifest({ servers: [server] }).valid) {
    throw new Error("The MCP server manifest is not valid");
  }
  return server.tools.filter((entry) => entry.enabled).map((entry) => new McpTool(server, entry, port));
}
