// S8.3 — the MCP call boundary, shared by the runtime (packages/mcp) and the
// tool adapter (packages/tools): one failure vocabulary with fixed sentences,
// and one check of arguments against a REVIEWED input schema. Pure.
import { describe, it, expect } from "vitest";
import {
  mcpFailure,
  mcpToolFingerprint,
  validateMcpArguments,
  type McpFailureCode,
  type McpToolManifestEntry,
} from "../src/mcp-manifest.js";
import { classifyToolFailure } from "../src/tool-failure-classifier.js";

type Obj = Record<string, unknown>;

function entry(tool: Obj): McpToolManifestEntry {
  return {
    ...tool,
    id: `mcp.fake.${String(tool.name)}`,
    readOnly: true,
    risk: "READ_ONLY",
    requiresApproval: false,
    requiredPermissions: ["read", "execute"],
    enabled: true,
    fingerprint: mcpToolFingerprint(tool as never),
  } as McpToolManifestEntry;
}

const SEARCH = entry({
  name: "search_notes",
  description: "Searches the fake notes and returns matching titles.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to look for.", maxLength: 200 },
      limit: { type: "integer", description: "How many results to return." },
    },
    required: ["query"],
    additionalProperties: false,
  },
});

const PICK = entry({
  name: "pick",
  description: "Picks one.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["fast", "full"] },
      ratio: { type: "number" },
      flag: { type: "boolean" },
    },
  },
});

const CODES: McpFailureCode[] = [
  "SERVER_UNAVAILABLE",
  "INITIALIZATION_FAILED",
  "TOOL_NOT_FOUND",
  "SCHEMA_INVALID",
  "INVALID_ARGUMENTS",
  "TIMEOUT",
  "CANCELLED",
  "AUTH_FAILURE",
  "RATE_LIMITED",
  "REMOTE_ERROR",
  "RESPONSE_TOO_LARGE",
  "UNKNOWN",
];

describe("mcpFailure", () => {
  it("has one fixed sentence per code", () => {
    for (const code of CODES) {
      expect(mcpFailure(code).message.length, code).toBeGreaterThan(10);
      expect(mcpFailure(code)).toEqual(mcpFailure(code));
    }
  });

  it("carries drift only when given, as labels", () => {
    expect(mcpFailure("TIMEOUT")).toEqual({ code: "TIMEOUT", message: "The MCP tool timed out." });
    expect(mcpFailure("SCHEMA_INVALID", [{ kind: "MISSING_TOOL", tool: "search_notes" }])).toEqual({
      code: "SCHEMA_INVALID",
      message: "This MCP tool changed and needs review.",
      drift: [{ kind: "MISSING_TOOL", tool: "search_notes" }],
    });
  });

  it("is never read as a Google, Gmail or approval failure by the existing classifier", () => {
    const expected: Partial<Record<McpFailureCode, string>> = {
      SERVER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
      INITIALIZATION_FAILED: "PROVIDER_UNAVAILABLE",
      TIMEOUT: "PROVIDER_UNAVAILABLE",
      RATE_LIMITED: "RATE_LIMITED",
    };
    for (const code of CODES) {
      const classified = classifyToolFailure(mcpFailure(code).message, "mcp.fake.search_notes");
      expect(classified.code, code).toBe(expected[code] ?? "TOOL_EXECUTION_FAILED");
    }
  });
});

describe("validateMcpArguments", () => {
  it.each([[{ query: "notes" }], [{ query: "notes", limit: 3 }]])("accepts %j", (args) => {
    expect(validateMcpArguments(SEARCH, args)).toBe(true);
  });

  it("accepts every declared type, and nothing at all when nothing is required", () => {
    expect(validateMcpArguments(PICK, { mode: "fast", ratio: 0.5, flag: false })).toBe(true);
    expect(validateMcpArguments(PICK, {})).toBe(true);
  });

  it.each([
    ["not an object", "notes"],
    ["null", null],
    ["an array", ["notes"]],
    ["an unknown key", { query: "notes", url: "https://evil.test" }],
    ["a missing required key", { limit: 3 }],
    ["a mistyped string", { query: 5 }],
    ["a fractional integer", { query: "notes", limit: 1.5 }],
    ["a string past maxLength", { query: "x".repeat(201) }],
    ["an inherited key", Object.create({ query: "notes" }) as Obj],
  ])("refuses %s for search_notes", (_label, args) => {
    expect(validateMcpArguments(SEARCH, args)).toBe(false);
  });

  it.each([
    ["a value outside the enum", { mode: "slow" }],
    ["a non-finite number", { ratio: Number.POSITIVE_INFINITY }],
    ["a mistyped boolean", { flag: "yes" }],
  ])("refuses %s", (_label, args) => {
    expect(validateMcpArguments(PICK, args)).toBe(false);
  });
});
