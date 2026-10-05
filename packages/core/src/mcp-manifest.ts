// ---------------------------------------------------------------------------
// S8.1 — the MCP manifest and its validator. Pure: no I/O, no SDK, no clock.
//
// The manifest is the reviewed list of MCP servers and tools JARVIS may use.
// It ships two reviewed servers (S8.6, S8.8). The API container registers
// exactly what `validateMcpManifest` accepts, and only while
// JARVIS_MCP_ENABLED is "true" (S8.4).
//
// What the validator guarantees for v1, failing closed on anything else:
//   - names are deterministic — `mcp.<server>.<tool>`, from manifest data
//     alone — and a model-facing name cannot collide with any other tool's;
//   - every tool is explicitly READ_ONLY, unapproved and OWNER/ADMIN-only; a
//     server's hints may make that stricter, never looser, and descriptions
//     are never read to decide it;
//   - parameters are flat scalars, never a credential, never a destination;
//   - the reviewed listing is pinned by a fingerprint;
//   - the server is a pinned local Node script whose environment can only
//     come from its own JARVIS_MCP_<ID>_ variables.
// An issue carries a path and a fixed message, never a value from the manifest.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type {
  McpDrift,
  McpFailure,
  McpFailureCode,
  McpFingerprintFields,
  McpManifest,
  McpManifestIssue,
  McpManifestIssueCode,
  McpManifestValidation,
  McpManifestValidationOptions,
  McpToolId,
  McpToolManifestEntry,
} from "./types/mcp.js";
import { canonicalizeForHash } from "./utils/params-hash.js";
import { containsInstructionInjection } from "./utils/untrusted-content.js";

const SERVER_ID_PATTERN = /^[a-z][a-z0-9]{1,15}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
const PARAMETER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const ENTRY_SCRIPT_PATTERN = /\.(?:js|mjs|cjs)$/;

/** Conservative v1 bounds. */
export const MCP_LIMITS = Object.freeze({
  servers: 4,
  toolsPerServer: 16,
  /** Every MCP tool joins the general assistant's list, which the model provider caps. */
  toolsTotal: 32,
  parametersPerTool: 16,
  descriptionLength: 1024,
  /** Canonical JSON bytes, per schema. */
  schemaBytes: 8192,
  args: 16,
  argLength: 512,
  envVars: 8,
  /** serverInfo name and version, annotation title. */
  textLength: 128,
  /** The model provider's function-name limit. */
  modelFacingName: 64,
});

/** v1 runs pinned Node packages only: no shell, no package runner, no runtime download. */
const ALLOWED_COMMANDS: readonly string[] = ["node"];

/** OWNER and ADMIN hold both; MEMBER and VIEWER lack `execute`. */
const REQUIRED_PERMISSIONS: readonly string[] = ["read", "execute"];

/** Frozen all the way down: reviewed data cannot be edited at runtime. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The reviewed MCP servers. Each one runs only while JARVIS_MCP_ENABLED is
 * "true", and only after its live listing matches this review exactly.
 *
 * S8.6 — `dates`, the pilot: packages/mcp/pilot/dates-server.mjs, a real MCP
 * server on the pinned official SDK. Stateless calendar arithmetic, no
 * environment.
 *
 * S8.8 — `units`: packages/mcp/pilot/units-server.mjs, the second server,
 * reviewed independently. Stateless unit conversion, no environment.
 *
 * Every tool below is its server's live listing copied verbatim at review;
 * the fingerprints pin it. Each server runs on its own connection, verified
 * against its own entry alone.
 */
export const MCP_MANIFEST: McpManifest = deepFreeze<McpManifest>({
  servers: [
    {
      id: "dates",
      transport: { kind: "stdio", command: "node", args: ["pilot/dates-server.mjs"] },
      env: {},
      expectedServerInfo: { name: "jarvis-dates", version: "1.0.0" },
      tools: [
        {
          id: "mcp.dates.days_between",
          name: "days_between",
          description:
            "Counts the days from one calendar date to another. The count is negative when the second date is earlier.",
          inputSchema: {
            type: "object",
            properties: {
              start: { type: "string", description: "The first date, written YYYY-MM-DD.", maxLength: 10 },
              end: { type: "string", description: "The second date, written YYYY-MM-DD.", maxLength: 10 },
            },
            required: ["start", "end"],
            additionalProperties: false,
          },
          annotations: { title: "Days between dates", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
          readOnly: true,
          risk: "READ_ONLY",
          requiresApproval: false,
          requiredPermissions: ["read", "execute"],
          enabled: true,
          fingerprint: "9d41560c20d5850d8a8232ee35e85d71e913b1bfa028a69a02d83b1fd4adce84",
        },
        {
          id: "mcp.dates.day_of_week",
          name: "day_of_week",
          description: "Names the day of the week a calendar date falls on.",
          inputSchema: {
            type: "object",
            properties: {
              date: { type: "string", description: "The date, written YYYY-MM-DD.", maxLength: 10 },
            },
            required: ["date"],
            additionalProperties: false,
          },
          annotations: { title: "Day of the week", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
          readOnly: true,
          risk: "READ_ONLY",
          requiresApproval: false,
          requiredPermissions: ["read", "execute"],
          enabled: true,
          fingerprint: "014d340bf784ddb25b4d1039d666ae40c340e3f28fe6320983fce147b00c85ec",
        },
      ],
    },
    {
      id: "units",
      transport: { kind: "stdio", command: "node", args: ["pilot/units-server.mjs"] },
      env: {},
      expectedServerInfo: { name: "jarvis-units", version: "1.0.0" },
      tools: [
        {
          id: "mcp.units.convert_length",
          name: "convert_length",
          description: "Converts a length between metric and imperial units.",
          inputSchema: {
            type: "object",
            properties: {
              value: { type: "number", description: "The amount to convert." },
              from: { type: "string", description: "The unit to convert from.", enum: ["mm", "cm", "m", "km", "in", "ft", "yd", "mi"] },
              to: { type: "string", description: "The unit to convert to.", enum: ["mm", "cm", "m", "km", "in", "ft", "yd", "mi"] },
            },
            required: ["value", "from", "to"],
            additionalProperties: false,
          },
          annotations: { title: "Convert length", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
          readOnly: true,
          risk: "READ_ONLY",
          requiresApproval: false,
          requiredPermissions: ["read", "execute"],
          enabled: true,
          fingerprint: "dc6e1927307712f32be54cf376ca43068df39fb9e0d002090810cb2d46216362",
        },
        {
          id: "mcp.units.convert_temperature",
          name: "convert_temperature",
          description:
            "Converts a temperature between Celsius, Fahrenheit and Kelvin. Values below absolute zero are refused.",
          inputSchema: {
            type: "object",
            properties: {
              value: { type: "number", description: "The amount to convert." },
              from: { type: "string", description: "The unit to convert from.", enum: ["C", "F", "K"] },
              to: { type: "string", description: "The unit to convert to.", enum: ["C", "F", "K"] },
            },
            required: ["value", "from", "to"],
            additionalProperties: false,
          },
          annotations: { title: "Convert temperature", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
          readOnly: true,
          risk: "READ_ONLY",
          requiresApproval: false,
          requiredPermissions: ["read", "execute"],
          enabled: true,
          fingerprint: "cc21084c513bcc4f223112e07c7024e509c6c1d73d57903f2d106c5ee2f0b018",
        },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The local id, `mcp.<server>.<tool>`. Throws on a name the v1 rules refuse. */
export function mcpToolId(serverId: string, toolName: string): McpToolId {
  if (!SERVER_ID_PATTERN.test(serverId) || !TOOL_NAME_PATTERN.test(toolName)) {
    throw new RangeError("An MCP tool id needs a valid server id and tool name");
  }
  return `mcp.${serverId}.${toolName}`;
}

/**
 * The name the model sees for any tool id. Mirrors the converter in
 * apps/api/src/services/container.ts — a boundary test keeps the two equal.
 */
export function modelFacingToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

// Parameter names are compared after normalising (lower case, letters and
// digits only), so `apiKey`, `api_key` and `API-KEY` are one name. Fixed
// lists — no language analysis.
const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Credentials only as the whole name: `author` is not `auth`, `max_tokens` not `token`. */
const CREDENTIAL_NAMES = new Set(["auth", "bearer", "idtoken", "jwt", "pwd", "token"]);
/** Unambiguous anywhere in a name. */
const CREDENTIAL_FRAGMENTS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "apikey",
  "privatekey",
  "authorization",
  "credential",
  "cookie",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "apitoken",
  "sessiontoken",
  "accesskey",
];
/** Where data could be sent. A read-only tool may not take one. */
const DESTINATION_NAMES = new Set([
  "host",
  "hosts",
  "hostname",
  "hostnames",
  "recipient",
  "recipients",
  "destination",
  "destinations",
  "target",
  "targets",
  "callback",
  "callbacks",
  "webhook",
  "webhooks",
  "endpoint",
  "endpoints",
]);
/** `url`, `callbackUrl`, `redirect_uri`, `baseURL`. */
const DESTINATION_SUFFIXES = ["url", "urls", "uri", "uris"];

function isCredentialName(name: string): boolean {
  const n = normalise(name);
  return CREDENTIAL_NAMES.has(n) || CREDENTIAL_FRAGMENTS.some((f) => n.includes(f));
}

function isDestinationName(name: string): boolean {
  const n = normalise(name);
  return DESTINATION_NAMES.has(n) || DESTINATION_SUFFIXES.some((s) => n.endsWith(s));
}

/** Variables that steer the runtime or the loader rather than the server. */
const isForbiddenServerVariable = (name: string): boolean =>
  name === "PATH" || /^(?:NODE|LD|DYLD)_/.test(name);

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * SHA-256 of canonical JSON over the reviewed fields — name, description,
 * inputSchema, outputSchema, annotations — and nothing else a server may send.
 * Same canonical form as approval-parameter hashing: keys sorted at every
 * depth, arrays positional, absent and undefined alike.
 */
export function mcpToolFingerprint(tool: McpFingerprintFields): string {
  const { name, description, inputSchema, outputSchema, annotations } = tool;
  return createHash("sha256")
    .update(canonicalizeForHash({ name, description, inputSchema, outputSchema, annotations }))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MESSAGES: Readonly<Record<McpManifestIssueCode, string>> = Object.freeze({
  INVALID_MANIFEST: "The manifest must be an object with a servers array.",
  UNKNOWN_FIELD: "This field is not part of the MCP manifest contract.",
  TOO_MANY_SERVERS: `At most ${MCP_LIMITS.servers} MCP servers are allowed.`,
  INVALID_SERVER: "Each server must be an object.",
  INVALID_SERVER_ID: "Server ids must match ^[a-z][a-z0-9]{1,15}$.",
  DUPLICATE_SERVER_ID: "Server ids must be unique.",
  UNSUPPORTED_TRANSPORT: "Only the stdio transport is supported.",
  INVALID_COMMAND: `The command must be one of: ${ALLOWED_COMMANDS.join(", ")}.`,
  INVALID_ARGS:
    `Args must be 1 to ${MCP_LIMITS.args} plain strings of at most ${MCP_LIMITS.argLength} characters; ` +
    "the first is a .js, .mjs or .cjs entry script, never a runtime flag.",
  INVALID_ENV:
    `Env maps at most ${MCP_LIMITS.envVars} server variables, named ^[A-Z][A-Z0-9_]*$ ` +
    "and never PATH or a NODE_, LD_ or DYLD_ variable.",
  ENV_OUTSIDE_NAMESPACE: "Server variables may only come from JARVIS_MCP_<SERVER ID>_<NAME> variables.",
  INVALID_SERVER_INFO: `Expected serverInfo needs a plain name of at most ${MCP_LIMITS.textLength} characters and an exact version.`,
  INVALID_TOOLS: "Tools must be an array.",
  TOO_MANY_TOOLS: `At most ${MCP_LIMITS.toolsPerServer} tools per server and ${MCP_LIMITS.toolsTotal} in total.`,
  INVALID_TOOL: "Each tool must be an object.",
  INVALID_TOOL_NAME: "Tool names must match ^[a-z][a-z0-9_]{0,40}$.",
  DUPLICATE_TOOL_NAME: "A server may list each tool name once.",
  TOOL_ID_MISMATCH: "The tool id must be exactly mcp.<server id>.<tool name>.",
  DUPLICATE_TOOL_ID: "Tool ids must be unique across the manifest and the registered tools.",
  MODEL_NAME_TOO_LONG: `Model-facing names must be at most ${MCP_LIMITS.modelFacingName} characters.`,
  MODEL_NAME_COLLISION: "The model-facing name collides with another tool's.",
  RESERVED_NAMESPACE: "Only manifest tools may use the mcp namespace.",
  INVALID_DESCRIPTION: "Descriptions must be non-empty plain text, with no control, invisible or bidirectional characters.",
  DESCRIPTION_TOO_LONG: `Descriptions must be at most ${MCP_LIMITS.descriptionLength} characters.`,
  DESCRIPTION_INJECTION: "The description reads as an instruction to the model.",
  INVALID_INPUT_SCHEMA:
    "The input schema must be a flat JSON object schema: type object, properties, " +
    "an optional required list of declared names and an optional additionalProperties false.",
  UNSUPPORTED_SCHEMA_KEYWORD: "This schema keyword is not supported.",
  NESTED_SCHEMA: "Nested objects and arrays are not supported.",
  SCHEMA_TOO_LARGE: `Schemas must be at most ${MCP_LIMITS.schemaBytes} bytes.`,
  TOO_MANY_PARAMETERS: `At most ${MCP_LIMITS.parametersPerTool} parameters are allowed.`,
  INVALID_PARAMETER_NAME: "Parameter names must match ^[A-Za-z][A-Za-z0-9_]{0,63}$.",
  INVALID_PARAMETER_SCHEMA:
    "A parameter is a string, number, integer or boolean, with an optional description, " +
    "a non-empty enum of that type, and maxLength on strings only.",
  CREDENTIAL_PARAMETER: "Credentials never travel as tool arguments; they come only from the server's environment.",
  DESTINATION_PARAMETER: "A read-only tool may not take a destination such as a URL, host, recipient or webhook.",
  INVALID_OUTPUT_SCHEMA: "The output schema must be a JSON object schema of type object.",
  INVALID_ANNOTATIONS: "Annotations may hold only a plain title and the four boolean hints.",
  HINT_CONTRADICTS_READ_ONLY: "The server's own hints say this tool is not read-only.",
  NOT_READ_ONLY: "Only tools explicitly declared readOnly, with risk READ_ONLY, are accepted.",
  APPROVAL_NOT_ALLOWED: "Read-only MCP tools must declare requiresApproval false.",
  INVALID_PERMISSIONS: "requiredPermissions must be exactly read and execute.",
  INVALID_ENABLED: "enabled must be a boolean.",
  INVALID_FINGERPRINT: "The fingerprint must be 64 lowercase hex characters.",
  FINGERPRINT_MISMATCH: "The fingerprint does not match the reviewed fields; review again and re-pin.",
});

const SERVER_KEYS = ["id", "transport", "env", "expectedServerInfo", "tools"];
const TOOL_KEYS = [
  "id",
  "name",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
  "readOnly",
  "risk",
  "requiresApproval",
  "requiredPermissions",
  "enabled",
  "fingerprint",
];
const INPUT_SCHEMA_KEYS = ["type", "properties", "required", "additionalProperties"];
const PARAMETER_KEYS = ["type", "description", "enum", "maxLength"];
const PARAMETER_TYPES = ["string", "number", "integer", "boolean"];
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

type Obj = Record<string, unknown>;
type Report = (path: string, code: McpManifestIssueCode) => void;

interface Context {
  report: Report;
  serverIds: Set<string>;
  toolIds: Set<string>;
  modelNames: Set<string>;
  registeredIds: ReadonlySet<string>;
  registeredModelNames: ReadonlySet<string>;
}

function isPlainObject(value: unknown): value is Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Sorted, so the issue order never depends on how an object was written. */
const keysOf = (value: Obj): string[] => Object.keys(value).sort();

/** A key is printed in a path only when it fits `pattern`; anything else could be a value. */
const segment = (key: string, index: number, pattern = /^\$?[A-Za-z]{1,32}$/): string =>
  pattern.test(key) ? `.${key}` : `[#${index}]`;

/**
 * Control, invisible and bidirectional characters: what a reviewer cannot see
 * but a model still reads. Tabs are allowed, newlines only where asked.
 */
function hasHiddenCharacters(text: string, allowNewlines: boolean): boolean {
  for (const char of text) {
    const c = char.codePointAt(0) ?? 0;
    if (c === 0x09 || (allowNewlines && c === 0x0a)) continue;
    if (
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) || // DEL and C1 controls
      (c >= 0x200b && c <= 0x200f) || // zero-width characters, LRM, RLM
      (c >= 0x202a && c <= 0x202e) || // bidi embedding and override
      (c >= 0x2060 && c <= 0x2064) || // word joiner, invisible operators
      (c >= 0x2066 && c <= 0x2069) || // bidi isolates
      c === 0xfeff || // byte-order mark
      (c >= 0xe0000 && c <= 0xe007f) // tag characters
    ) {
      return true;
    }
  }
  return false;
}

const isPlainText = (value: unknown, max: number, allowNewlines: boolean): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !hasHiddenCharacters(value, allowNewlines);

/** Strict JSON: plain objects, arrays, strings, finite numbers, booleans, null. */
function isJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!isJson(value[i], depth + 1)) return false;
    return true;
  }
  return isPlainObject(value) && Object.values(value).every((v) => isJson(v, depth + 1));
}

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(canonicalizeForHash(value)).length;

function checkKeys(value: Obj, allowed: readonly string[], path: string, report: Report): void {
  keysOf(value).forEach((key, i) => {
    if (!allowed.includes(key)) report(`${path}${segment(key, i)}`, "UNKNOWN_FIELD");
  });
}

/**
 * Validate a manifest. Fails closed: anything not explicitly allowed is an
 * issue, and a manifest is valid only with no issues at all.
 *
 * `registeredToolIds` are the tools registered outside the manifest. The
 * model-facing converter does not detect collisions, so this does: no MCP
 * tool may share an id or a model-facing name with one of them, and none of
 * them may sit in the `mcp` namespace.
 */
export function validateMcpManifest(
  manifest: unknown,
  options: McpManifestValidationOptions = {}
): McpManifestValidation {
  const issues: McpManifestIssue[] = [];
  const report: Report = (path, code) => {
    issues.push({ path, code, message: MESSAGES[code] });
  };

  if (!isPlainObject(manifest) || !Array.isArray(manifest.servers)) {
    report("manifest", "INVALID_MANIFEST");
    return { valid: false, issues };
  }
  checkKeys(manifest, ["servers"], "manifest", report);

  const registered = (options.registeredToolIds ?? []).filter((id) => typeof id === "string");
  const ctx: Context = {
    report,
    serverIds: new Set(),
    toolIds: new Set(),
    modelNames: new Set(),
    registeredIds: new Set(registered),
    registeredModelNames: new Set(registered.map(modelFacingToolName)),
  };

  const servers: unknown[] = manifest.servers;
  if (servers.length > MCP_LIMITS.servers) report("servers", "TOO_MANY_SERVERS");
  let toolCount = 0;
  servers.forEach((server, s) => {
    toolCount += validateServer(server, `servers[${s}]`, ctx);
  });
  if (toolCount > MCP_LIMITS.toolsTotal) report("servers", "TOO_MANY_TOOLS");

  registered.forEach((id, i) => {
    if (modelFacingToolName(id).startsWith("mcp-")) report(`registeredToolIds[${i}]`, "RESERVED_NAMESPACE");
  });

  return { valid: issues.length === 0, issues };
}

/** Returns how many tools the server lists. */
function validateServer(server: unknown, path: string, ctx: Context): number {
  const { report } = ctx;
  if (!isPlainObject(server)) {
    report(path, "INVALID_SERVER");
    return 0;
  }
  checkKeys(server, SERVER_KEYS, path, report);

  const id = typeof server.id === "string" && SERVER_ID_PATTERN.test(server.id) ? server.id : undefined;
  if (id === undefined) report(`${path}.id`, "INVALID_SERVER_ID");
  else if (ctx.serverIds.has(id)) report(`${path}.id`, "DUPLICATE_SERVER_ID");
  if (id !== undefined) ctx.serverIds.add(id);

  validateTransport(server.transport, `${path}.transport`, report);
  validateEnv(server.env, id, `${path}.env`, report);
  validateServerInfo(server.expectedServerInfo, `${path}.expectedServerInfo`, report);

  if (!Array.isArray(server.tools)) {
    report(`${path}.tools`, "INVALID_TOOLS");
    return 0;
  }
  if (server.tools.length > MCP_LIMITS.toolsPerServer) report(`${path}.tools`, "TOO_MANY_TOOLS");
  const names = new Set<string>();
  server.tools.forEach((tool, t) => validateTool(tool, id, names, `${path}.tools[${t}]`, ctx));
  return server.tools.length;
}

function validateTransport(transport: unknown, path: string, report: Report): void {
  if (!isPlainObject(transport)) {
    report(path, "UNSUPPORTED_TRANSPORT");
    return;
  }
  checkKeys(transport, ["kind", "command", "args"], path, report);
  if (transport.kind !== "stdio") report(`${path}.kind`, "UNSUPPORTED_TRANSPORT");
  if (typeof transport.command !== "string" || !ALLOWED_COMMANDS.includes(transport.command)) {
    report(`${path}.command`, "INVALID_COMMAND");
  }

  const args = transport.args;
  if (!Array.isArray(args) || args.length === 0 || args.length > MCP_LIMITS.args) {
    report(`${path}.args`, "INVALID_ARGS");
  }
  if (!Array.isArray(args)) return;
  args.forEach((arg, i) => {
    const plain = isPlainText(arg, MCP_LIMITS.argLength, false);
    // The entry script comes first, so no runtime flag (-e, --require,
    // --inspect…) can run anything but the pinned package.
    const entry = i > 0 || (plain && !arg.startsWith("-") && ENTRY_SCRIPT_PATTERN.test(arg));
    if (!plain || !entry) report(`${path}.args[${i}]`, "INVALID_ARGS");
  });
}

function validateEnv(env: unknown, serverId: string | undefined, path: string, report: Report): void {
  if (!isPlainObject(env)) {
    report(path, "INVALID_ENV");
    return;
  }
  const names = keysOf(env);
  if (names.length > MCP_LIMITS.envVars) report(path, "INVALID_ENV");
  const prefix = serverId === undefined ? undefined : `JARVIS_MCP_${serverId.toUpperCase()}_`;
  names.forEach((name, i) => {
    const at = `${path}${segment(name, i, ENV_NAME_PATTERN)}`;
    if (!ENV_NAME_PATTERN.test(name) || isForbiddenServerVariable(name)) report(at, "INVALID_ENV");
    const source = env[name];
    const inNamespace =
      typeof source === "string" &&
      ENV_NAME_PATTERN.test(source) &&
      prefix !== undefined &&
      source.startsWith(prefix) &&
      source.length > prefix.length;
    // With no valid server id there is no namespace to check against; the id
    // is already reported.
    if (prefix !== undefined && !inNamespace) report(at, "ENV_OUTSIDE_NAMESPACE");
  });
}

function validateServerInfo(info: unknown, path: string, report: Report): void {
  if (!isPlainObject(info)) {
    report(path, "INVALID_SERVER_INFO");
    return;
  }
  checkKeys(info, ["name", "version"], path, report);
  if (!isPlainText(info.name, MCP_LIMITS.textLength, false)) report(`${path}.name`, "INVALID_SERVER_INFO");
  const version = info.version;
  if (
    typeof version !== "string" ||
    version.length > MCP_LIMITS.textLength ||
    !EXACT_VERSION_PATTERN.test(version)
  ) {
    report(`${path}.version`, "INVALID_SERVER_INFO");
  }
}

function validateTool(
  tool: unknown,
  serverId: string | undefined,
  names: Set<string>,
  path: string,
  ctx: Context
): void {
  const { report } = ctx;
  if (!isPlainObject(tool)) {
    report(path, "INVALID_TOOL");
    return;
  }
  checkKeys(tool, TOOL_KEYS, path, report);

  // Naming — from the manifest's own server id and tool name, nothing else.
  const name = typeof tool.name === "string" && TOOL_NAME_PATTERN.test(tool.name) ? tool.name : undefined;
  if (name === undefined) report(`${path}.name`, "INVALID_TOOL_NAME");
  else if (names.has(name)) report(`${path}.name`, "DUPLICATE_TOOL_NAME");
  if (name !== undefined) names.add(name);
  if (serverId !== undefined && name !== undefined) {
    const id = mcpToolId(serverId, name);
    if (tool.id !== id) report(`${path}.id`, "TOOL_ID_MISMATCH");
    if (ctx.toolIds.has(id) || ctx.registeredIds.has(id)) report(`${path}.id`, "DUPLICATE_TOOL_ID");
    ctx.toolIds.add(id);
    const modelName = modelFacingToolName(id);
    if (modelName.length > MCP_LIMITS.modelFacingName) report(`${path}.id`, "MODEL_NAME_TOO_LONG");
    if (ctx.modelNames.has(modelName) || ctx.registeredModelNames.has(modelName)) {
      report(`${path}.id`, "MODEL_NAME_COLLISION");
    }
    ctx.modelNames.add(modelName);
  }

  validateDescription(tool.description, `${path}.description`, report);
  validateInputSchema(tool.inputSchema, `${path}.inputSchema`, report);
  if (tool.outputSchema !== undefined) validateOutputSchema(tool.outputSchema, `${path}.outputSchema`, report);
  if (tool.annotations !== undefined) validateAnnotations(tool.annotations, `${path}.annotations`, report);

  // Classification is the manifest's explicit declaration — never inferred.
  if (tool.readOnly !== true) report(`${path}.readOnly`, "NOT_READ_ONLY");
  if (tool.risk !== "READ_ONLY") report(`${path}.risk`, "NOT_READ_ONLY");
  if (tool.requiresApproval !== false) report(`${path}.requiresApproval`, "APPROVAL_NOT_ALLOWED");
  const permissions = tool.requiredPermissions;
  if (
    !Array.isArray(permissions) ||
    permissions.length !== REQUIRED_PERMISSIONS.length ||
    !REQUIRED_PERMISSIONS.every((p) => permissions.includes(p))
  ) {
    report(`${path}.requiredPermissions`, "INVALID_PERMISSIONS");
  }
  if (typeof tool.enabled !== "boolean") report(`${path}.enabled`, "INVALID_ENABLED");

  if (typeof tool.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(tool.fingerprint)) {
    report(`${path}.fingerprint`, "INVALID_FINGERPRINT");
  } else if (fingerprintOf(tool) !== tool.fingerprint) {
    report(`${path}.fingerprint`, "FINGERPRINT_MISMATCH");
  }
}

/** Null when the fields cannot be hashed at all; their shapes are reported elsewhere. */
function fingerprintOf(tool: Obj): string | null {
  try {
    return mcpToolFingerprint(tool as unknown as McpFingerprintFields);
  } catch {
    return null;
  }
}

function validateDescription(value: unknown, path: string, report: Report): void {
  if (typeof value !== "string" || value.trim().length === 0 || hasHiddenCharacters(value, true)) {
    report(path, "INVALID_DESCRIPTION");
  } else if (value.length > MCP_LIMITS.descriptionLength) {
    report(path, "DESCRIPTION_TOO_LONG");
  } else if (containsInstructionInjection(value)) {
    report(path, "DESCRIPTION_INJECTION");
  }
}

function validateInputSchema(schema: unknown, path: string, report: Report): void {
  if (!isPlainObject(schema)) {
    report(path, "INVALID_INPUT_SCHEMA");
    return;
  }
  keysOf(schema).forEach((key, i) => {
    if (!INPUT_SCHEMA_KEYS.includes(key)) report(`${path}${segment(key, i)}`, "UNSUPPORTED_SCHEMA_KEYWORD");
  });
  if (!isJson(schema)) report(path, "INVALID_INPUT_SCHEMA");
  else if (byteLength(schema) > MCP_LIMITS.schemaBytes) report(path, "SCHEMA_TOO_LARGE");
  if (schema.type !== "object") report(`${path}.type`, "INVALID_INPUT_SCHEMA");
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    report(`${path}.additionalProperties`, "INVALID_INPUT_SCHEMA");
  }

  const properties = schema.properties;
  if (!isPlainObject(properties)) {
    report(`${path}.properties`, "INVALID_INPUT_SCHEMA");
    return;
  }
  const names = keysOf(properties);
  if (names.length > MCP_LIMITS.parametersPerTool) report(`${path}.properties`, "TOO_MANY_PARAMETERS");
  names.forEach((name, i) =>
    validateParameter(name, properties[name], `${path}.properties${segment(name, i, PARAMETER_NAME_PATTERN)}`, report)
  );

  const required = schema.required;
  if (
    required !== undefined &&
    !(
      Array.isArray(required) &&
      required.every((r) => typeof r === "string" && Object.hasOwn(properties, r)) &&
      new Set(required).size === required.length
    )
  ) {
    report(`${path}.required`, "INVALID_INPUT_SCHEMA");
  }
}

function validateParameter(name: string, property: unknown, path: string, report: Report): void {
  if (!PARAMETER_NAME_PATTERN.test(name)) report(path, "INVALID_PARAMETER_NAME");
  if (isCredentialName(name)) report(path, "CREDENTIAL_PARAMETER");
  if (isDestinationName(name)) report(path, "DESTINATION_PARAMETER");
  if (!isPlainObject(property)) {
    report(path, "INVALID_PARAMETER_SCHEMA");
    return;
  }
  keysOf(property).forEach((key, i) => {
    if (!PARAMETER_KEYS.includes(key)) report(`${path}${segment(key, i)}`, "UNSUPPORTED_SCHEMA_KEYWORD");
  });

  const type = property.type;
  if (type === "object" || type === "array") {
    report(`${path}.type`, "NESTED_SCHEMA");
    return;
  }
  if (typeof type !== "string" || !PARAMETER_TYPES.includes(type)) {
    report(`${path}.type`, "INVALID_PARAMETER_SCHEMA");
    return;
  }
  if (property.description !== undefined) {
    if (typeof property.description !== "string") report(`${path}.description`, "INVALID_PARAMETER_SCHEMA");
    else validateDescription(property.description, `${path}.description`, report);
  }
  if (property.enum !== undefined && !isEnumOf(property.enum, type)) {
    report(`${path}.enum`, "INVALID_PARAMETER_SCHEMA");
  }
  const maxLength = property.maxLength;
  if (maxLength !== undefined && !(type === "string" && Number.isSafeInteger(maxLength) && (maxLength as number) > 0)) {
    report(`${path}.maxLength`, "INVALID_PARAMETER_SCHEMA");
  }
}

function isEnumOf(values: unknown, type: string): boolean {
  if (!Array.isArray(values) || values.length === 0 || new Set(values).size !== values.length) return false;
  return values.every((v) =>
    type === "string"
      ? typeof v === "string"
      : type === "boolean"
        ? typeof v === "boolean"
        : type === "integer"
          ? Number.isSafeInteger(v)
          : typeof v === "number" && Number.isFinite(v)
  );
}

function validateOutputSchema(schema: unknown, path: string, report: Report): void {
  if (!isPlainObject(schema) || !isJson(schema) || schema.type !== "object") {
    report(path, "INVALID_OUTPUT_SCHEMA");
    return;
  }
  if (byteLength(schema) > MCP_LIMITS.schemaBytes) report(path, "SCHEMA_TOO_LARGE");
}

function validateAnnotations(annotations: unknown, path: string, report: Report): void {
  if (!isPlainObject(annotations)) {
    report(path, "INVALID_ANNOTATIONS");
    return;
  }
  const wellFormed = keysOf(annotations).every((key) =>
    key === "title"
      ? isPlainText(annotations.title, MCP_LIMITS.textLength, false)
      : HINTS.includes(key) && typeof annotations[key] === "boolean"
  );
  if (!wellFormed) report(path, "INVALID_ANNOTATIONS");
  // A hint may only tighten: a server that calls its own tool a writer is believed.
  if (annotations.readOnlyHint === false || annotations.destructiveHint === true) {
    report(path, "HINT_CONTRADICTS_READ_ONLY");
  }
}

// ---------------------------------------------------------------------------
// The call boundary (S8.3) — shared by the runtime and the tool adapter, so
// both speak one failure vocabulary and check arguments one way.
// ---------------------------------------------------------------------------

/**
 * One fixed sentence per failure, safe for a person to read. Worded so the
 * existing tool-failure classifier never takes one for a Google, Gmail or
 * approval failure — a test holds that.
 */
const FAILURE_MESSAGES: Readonly<Record<McpFailureCode, string>> = Object.freeze({
  SERVER_UNAVAILABLE: "The MCP server is unavailable.",
  INITIALIZATION_FAILED: "The MCP server is unavailable.",
  TOOL_NOT_FOUND: "This MCP tool is not offered.",
  SCHEMA_INVALID: "This MCP tool changed and needs review.",
  INVALID_ARGUMENTS: "The MCP tool rejected its input.",
  TIMEOUT: "The MCP tool timed out.",
  CANCELLED: "The MCP tool call was cancelled.",
  AUTH_FAILURE: "The MCP server refused JARVIS's credentials; the operator must update them.",
  RATE_LIMITED: "The MCP server's rate limit was reached.",
  REMOTE_ERROR: "The MCP tool reported an error.",
  RESPONSE_TOO_LARGE: "The MCP server sent more output than allowed.",
  UNKNOWN: "The MCP tool failed.",
});

/** A failure with its fixed sentence, and the drift that caused it when there is any. */
export function mcpFailure(code: McpFailureCode, drift?: readonly McpDrift[]): McpFailure {
  return drift === undefined
    ? { code, message: FAILURE_MESSAGES[code] }
    : { code, message: FAILURE_MESSAGES[code], drift };
}

/**
 * Do these arguments fit the tool's REVIEWED input schema exactly? Unknown
 * keys never do. A live server's schema is never consulted.
 */
export function validateMcpArguments(tool: McpToolManifestEntry, args: unknown): boolean {
  if (!isPlainObject(args)) return false;
  const { properties, required = [] } = tool.inputSchema;
  if (!required.every((name) => Object.hasOwn(args, name))) return false;
  return Object.entries(args).every(([name, value]) => {
    const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
    if (!property) return false;
    if (property.enum && !property.enum.includes(value as string | number | boolean)) return false;
    switch (property.type) {
      case "string":
        return typeof value === "string" && (property.maxLength === undefined || value.length <= property.maxLength);
      case "integer":
        return Number.isSafeInteger(value);
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "boolean":
        return typeof value === "boolean";
      default:
        return false;
    }
  });
}

// ---------------------------------------------------------------------------
// The grant (S8.4)
// ---------------------------------------------------------------------------

/**
 * The tool ids a reviewed manifest offers for granting: every enabled tool,
 * in manifest order — and nothing at all from a manifest that is not valid.
 * The agent policy derives its MCP group from this, so a tool is grantable
 * only by being reviewed into the manifest.
 */
export function mcpReadToolIds(manifest: McpManifest): readonly string[] {
  if (!validateMcpManifest(manifest).valid) return [];
  return manifest.servers.flatMap((server) => server.tools.filter((tool) => tool.enabled).map((tool) => tool.id));
}
