// ---------------------------------------------------------------------------
// S8.1 — the MCP contract. Pure data shapes: no I/O, no SDK, no runtime.
//
// THE MANIFEST IS THE AUTHORITY. An MCP server is reachable from JARVIS only
// through a reviewed manifest entry written in this repository. What a live
// server says about itself — names, descriptions, schemas, annotations,
// serverInfo — is untrusted: a later step may compare it with the manifest to
// DISABLE a tool, never to register, describe, grant or classify one.
//
// v1 is deliberately narrow: local stdio servers, READ_ONLY tools only,
// OWNER/ADMIN only, flat parameter schemas. Nothing here touches ITool, the
// ToolRegistry or ToolExecutor; an MCP tool will reach them as an ordinary
// ITool built from an entry.
// ---------------------------------------------------------------------------

import type { RiskLevel, ToolPermission } from "./tool.js";

/** `^[a-z][a-z0-9]{1,15}$`. */
export type McpServerId = string;

/** The local JARVIS id — always `mcp.<server id>.<tool name>`, from manifest data only. */
export type McpToolId = `mcp.${string}.${string}`;

/** What the model sees: the local id with every `.` turned into `-`. */
export type McpModelFacingName = `mcp-${string}-${string}`;

/** v1's only transport: a local process speaking MCP over stdio. */
export interface McpStdioTransport {
  kind: "stdio";
  /** v1: `node` — a pinned package in the image, never a runtime download. */
  command: string;
  /** `args[0]` is the server's entry script, never a runtime flag. */
  args: readonly string[];
}

export type McpServerTransport = McpStdioTransport;

/** What the server must report in `initialize`. Self-reported: a drift check, not identity. */
export interface McpExpectedServerInfo {
  name: string;
  /** An exact version — never a range. */
  version: string;
}

/** The server's own hints. They may only make a decision stricter. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type McpParameterType = "string" | "number" | "integer" | "boolean";

/** One flat input parameter. v1 allows nothing else. */
export interface McpInputProperty {
  type: McpParameterType;
  description?: string;
  enum?: readonly (string | number | boolean)[];
  /** Strings only. */
  maxLength?: number;
}

export interface McpInputSchema {
  type: "object";
  properties: Readonly<Record<string, McpInputProperty>>;
  required?: readonly string[];
  additionalProperties?: false;
}

/**
 * One reviewed tool. `name`, `description`, `inputSchema`, `outputSchema` and
 * `annotations` are the server's own listing, copied verbatim at review time;
 * `fingerprint` pins exactly those fields. Everything else is JARVIS's decision.
 */
export interface McpToolManifestEntry {
  /** Must equal `mcp.<server id>.<name>`. */
  id: McpToolId;
  /** The remote tool name, exactly as the server lists it. */
  name: string;
  /** The only description the model will ever see for this tool. */
  description: string;
  inputSchema: McpInputSchema;
  outputSchema?: Readonly<Record<string, unknown>>;
  annotations?: McpToolAnnotations;
  /** Explicit read-only intent. v1 accepts nothing else. */
  readOnly: true;
  risk: Extract<RiskLevel, "READ_ONLY">;
  requiresApproval: false;
  /** Exactly `read` and `execute`: OWNER and ADMIN only. */
  requiredPermissions: readonly ToolPermission[];
  /** A reviewed tool can be kept off without discarding its review. */
  enabled: boolean;
  /** `mcpToolFingerprint` of the reviewed fields, captured at review time. */
  fingerprint: string;
}

export interface McpServerManifest {
  id: McpServerId;
  transport: McpServerTransport;
  /**
   * The server process's environment: the variable the SERVER reads → the
   * JARVIS variable that holds its value. Names only; a value never appears in
   * a manifest. Every JARVIS-side name sits in this server's own namespace,
   * `JARVIS_MCP_<ID>_…`, so no manifest can forward DATABASE_URL or any other
   * JARVIS secret.
   */
  env: Readonly<Record<string, string>>;
  expectedServerInfo: McpExpectedServerInfo;
  tools: readonly McpToolManifestEntry[];
}

export interface McpManifest {
  servers: readonly McpServerManifest[];
}

/** The fields a fingerprint covers — and nothing else a server may send. */
export interface McpFingerprintFields {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface McpManifestValidationOptions {
  /** Ids of tools registered outside this manifest, checked for collisions. */
  registeredToolIds?: readonly string[];
}

export type McpManifestIssueCode =
  | "INVALID_MANIFEST"
  | "UNKNOWN_FIELD"
  | "TOO_MANY_SERVERS"
  | "INVALID_SERVER"
  | "INVALID_SERVER_ID"
  | "DUPLICATE_SERVER_ID"
  | "UNSUPPORTED_TRANSPORT"
  | "INVALID_COMMAND"
  | "INVALID_ARGS"
  | "INVALID_ENV"
  | "ENV_OUTSIDE_NAMESPACE"
  | "INVALID_SERVER_INFO"
  | "INVALID_TOOLS"
  | "TOO_MANY_TOOLS"
  | "INVALID_TOOL"
  | "INVALID_TOOL_NAME"
  | "DUPLICATE_TOOL_NAME"
  | "TOOL_ID_MISMATCH"
  | "DUPLICATE_TOOL_ID"
  | "MODEL_NAME_TOO_LONG"
  | "MODEL_NAME_COLLISION"
  | "RESERVED_NAMESPACE"
  | "INVALID_DESCRIPTION"
  | "DESCRIPTION_TOO_LONG"
  | "DESCRIPTION_INJECTION"
  | "INVALID_INPUT_SCHEMA"
  | "UNSUPPORTED_SCHEMA_KEYWORD"
  | "NESTED_SCHEMA"
  | "SCHEMA_TOO_LARGE"
  | "TOO_MANY_PARAMETERS"
  | "INVALID_PARAMETER_NAME"
  | "INVALID_PARAMETER_SCHEMA"
  | "CREDENTIAL_PARAMETER"
  | "DESTINATION_PARAMETER"
  | "INVALID_OUTPUT_SCHEMA"
  | "INVALID_ANNOTATIONS"
  | "HINT_CONTRADICTS_READ_ONLY"
  | "NOT_READ_ONLY"
  | "APPROVAL_NOT_ALLOWED"
  | "INVALID_PERMISSIONS"
  | "INVALID_ENABLED"
  | "INVALID_FINGERPRINT"
  | "FINGERPRINT_MISMATCH";

export interface McpManifestIssue {
  /** Where, e.g. `servers[0].tools[1].inputSchema.properties.query`. Never a value. */
  path: string;
  code: McpManifestIssueCode;
  /** Fixed per code; never echoes manifest content. */
  message: string;
}

export interface McpManifestValidation {
  valid: boolean;
  issues: readonly McpManifestIssue[];
}

// ---------------------------------------------------------------------------
// S8.3 — the call boundary. The runtime (packages/mcp) implements McpCallPort;
// the tool adapter (packages/tools) depends on it and on nothing else. No SDK
// type ever crosses it.
// ---------------------------------------------------------------------------

/** Why an MCP operation failed. AUTH_FAILURE and RATE_LIMITED belong to remote transports. */
export type McpFailureCode =
  | "SERVER_UNAVAILABLE"
  | "INITIALIZATION_FAILED"
  | "TOOL_NOT_FOUND"
  | "SCHEMA_INVALID"
  | "INVALID_ARGUMENTS"
  | "TIMEOUT"
  | "CANCELLED"
  | "AUTH_FAILURE"
  | "RATE_LIMITED"
  | "REMOTE_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "UNKNOWN";

export type McpDriftKind =
  | "SERVER_INFO_MISMATCH"
  | "MISSING_TOOL"
  | "UNEXPECTED_TOOL"
  | "DUPLICATE_TOOL"
  | "FINGERPRINT_MISMATCH"
  | "INVALID_TOOL";

/** One difference from the review. `tool` is a reviewed name, or a live name only when plain. */
export interface McpDrift {
  kind: McpDriftKind;
  tool?: string;
}

export interface McpFailure {
  code: McpFailureCode;
  /** A fixed sentence for the code; never server text. */
  message: string;
  drift?: readonly McpDrift[];
}

/** Text is kept; anything else is described, never carried. */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; mimeType: string; bytes: number; omitted: true }
  | { type: "resource" | "resource_link" | "unsupported"; omitted: true };

export type McpCallResult =
  | { ok: true; content: readonly McpContent[]; structuredContent?: Readonly<Record<string, unknown>> }
  | { ok: false; failure: McpFailure };

export type McpConnectResult = { ok: true } | { ok: false; failure: McpFailure };

/**
 * What a tool needs from one server's runtime — and all it gets. The runtime
 * owns the process, verification and its breaker; through this port it only
 * says whether it is ready, which reviewed entries it verified, and runs a call.
 */
export interface McpCallPort {
  /** Make the server ready — lazily, once; the runtime decides how. */
  connect(signal?: AbortSignal): Promise<McpConnectResult>;
  /** The reviewed entries the live server was verified against. Empty unless ready. */
  listVerifiedTools(): readonly McpToolManifestEntry[];
  /** Call one reviewed tool by its remote name. */
  callTool(name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<McpCallResult>;
}
