// S8.4 — what the wiring reads from the MCP contract.
//
// `mcpReadToolIds` is the policy's view of the reviewed manifest: the ids the
// general assistant may be granted, and nothing from a manifest that is not
// valid. `describeCapability` is how a registered MCP tool is presented: by
// its reviewed name in words — never its id, schema or fingerprint. Pure.
import { describe, it, expect } from "vitest";
import { describeCapability } from "../src/capability-catalog.js";
import { MCP_MANIFEST, mcpReadToolIds, mcpToolFingerprint } from "../src/mcp-manifest.js";
import type { McpManifest, McpToolManifestEntry } from "../src/types/mcp.js";

type Obj = Record<string, unknown>;

function entry(name: string, overrides: Obj = {}): McpToolManifestEntry {
  const tool = {
    name,
    description: `Reviewed description of ${name}.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
  return {
    ...tool,
    id: `mcp.docs.${name}`,
    readOnly: true,
    risk: "READ_ONLY",
    requiresApproval: false,
    requiredPermissions: ["read", "execute"],
    enabled: true,
    fingerprint: mcpToolFingerprint(tool),
    ...overrides,
  } as McpToolManifestEntry;
}

function manifest(tools: McpToolManifestEntry[]): McpManifest {
  return {
    servers: [
      {
        id: "docs",
        transport: { kind: "stdio", command: "node", args: ["servers/docs/index.js"] },
        env: {},
        expectedServerInfo: { name: "docs-server", version: "1.0.0" },
        tools,
      },
    ],
  };
}

describe("mcpReadToolIds", () => {
  it("is the reviewed servers' tools for the shipped manifest, in manifest order (S8.6, S8.8)", () => {
    expect(mcpReadToolIds(MCP_MANIFEST)).toEqual([
      "mcp.dates.days_between",
      "mcp.dates.day_of_week",
      "mcp.units.convert_length",
      "mcp.units.convert_temperature",
    ]);
  });

  it("lists the enabled reviewed tools, in manifest order", () => {
    expect(mcpReadToolIds(manifest([entry("search_notes"), entry("get_note")]))).toEqual([
      "mcp.docs.search_notes",
      "mcp.docs.get_note",
    ]);
  });

  it("leaves out a disabled tool", () => {
    expect(mcpReadToolIds(manifest([entry("search_notes"), entry("get_note", { enabled: false })]))).toEqual([
      "mcp.docs.search_notes",
    ]);
  });

  it("grants nothing at all from a manifest that is not valid", () => {
    // One bad entry voids the whole manifest: no partial grant.
    expect(mcpReadToolIds(manifest([entry("search_notes"), entry("get_note", { risk: "HIGH_IMPACT" })]))).toEqual([]);
    expect(mcpReadToolIds({ servers: "nope" } as unknown as McpManifest)).toEqual([]);
  });
});

describe("describeCapability for an MCP tool", () => {
  it("labels it by its reviewed name in words — never by its id", () => {
    const meta = describeCapability("mcp.docs.search_notes", "Searches the team's notes.");
    expect(meta.label).toBe("Search notes");
    expect(meta.label).not.toContain("mcp");
    expect(meta.description).toBe("Searches the team's notes.");
  });

  it("files it under system, gated by no integration", () => {
    expect(describeCapability("mcp.docs.get_note", "x")).toMatchObject({ group: "system", integration: null });
  });

  it("leaves every other tool's label exactly as it was", () => {
    expect(describeCapability("custom.unknown_tool", "x").label).toBe("custom.unknown_tool");
    expect(describeCapability("memory.list", "x").label).toBe(describeCapability("memory.list", "y").label);
  });
});
