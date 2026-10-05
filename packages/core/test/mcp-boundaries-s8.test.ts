// S8.1 — architecture boundaries for the MCP contract.
//
// S8.1 adds a pure contract and nothing else. Pinned here: the contract has no
// SDK and no I/O beyond hashing; ITool, ToolRegistry and ToolExecutor are
// untouched; agents reach MCP only through the policy's one derived grant and
// only the API's composition root and integration layer wire it (S8.4, S8.5);
// the packages that must never know MCP do not; no migration was added.
// Asserted on source, because that is where these properties live.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as core from "../src/index.js";
import { modelFacingToolName } from "../src/mcp-manifest.js";

const REPO = new URL("../../../", import.meta.url);

/** Source text with line endings normalised, so a pin survives a CRLF checkout. */
const read = (path: string): string =>
  readFileSync(new URL(path, REPO), "utf8").replace(/\r\n/g, "\n");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Every .ts/.tsx file under `dir`, repo-relative. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, REPO), { withFileTypes: true })) {
    if (["node_modules", "dist", ".next"].includes(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const MCP_IMPORT = /(?:from\s+|import\s*\(\s*)["'][^"']*(?:mcp|modelcontextprotocol)[^"']*["']/i;
const MCP_IDENTIFIER = /\b(?:Mcp[A-Z]\w*|MCP_[A-Z_]+|mcp[A-Z]\w*|modelFacingToolName)\b/;

function mcpReferences(dirs: string[]): string[] {
  return dirs
    .flatMap(sources)
    .filter((file) => {
      const text = read(file);
      return MCP_IMPORT.test(text) || MCP_IDENTIFIER.test(text);
    });
}

const CONTRACT = ["packages/core/src/types/mcp.ts", "packages/core/src/mcp-manifest.ts"];

describe("the MCP contract is pure", () => {
  it("imports nothing but node:crypto and core itself", () => {
    for (const file of CONTRACT) {
      const specifiers = [...read(file).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      expect(specifiers.length, file).toBeGreaterThan(0);
      for (const s of specifiers) {
        expect(s === "node:crypto" || s.startsWith("./"), `${file} imports ${s}`).toBe(true);
      }
    }
  });

  it("has no MCP SDK — not in core's dependencies, its lockfile entry or the contract", () => {
    const pkg = JSON.parse(read("packages/core/package.json")) as Record<string, Record<string, string>>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps).filter((d) => d.includes("modelcontextprotocol"))).toEqual([]);
    // S8.2 added the SDK to packages/mcp alone; core's own importer never lists it.
    const lock = read("pnpm-lock.yaml");
    const start = lock.indexOf("\n  packages/core:\n");
    expect(start).toBeGreaterThan(-1);
    expect(lock.slice(start, lock.indexOf("\n\n", start + 1))).not.toContain("@modelcontextprotocol");
    for (const file of CONTRACT) expect(read(file)).not.toContain("@modelcontextprotocol");
  });

  it("is exported from the package entry", () => {
    expect(typeof core.validateMcpManifest).toBe("function");
    expect(typeof core.mcpToolFingerprint).toBe("function");
    expect(core.MCP_MANIFEST.servers.map((server) => server.id)).toEqual(["dates", "units"]); // S8.6 / S8.8
  });
});

describe("the tool architecture is untouched", () => {
  it("leaves ITool exactly as it was, with nothing MCP in it", () => {
    const source = read("packages/core/src/types/tool.ts");
    const body = source.slice(source.indexOf("export interface ITool {"));
    const block = body.slice(0, body.indexOf("\n}\n"));
    const members = [...block.matchAll(/^ {2}(\w+)\??\s*[:(]/gm)].map((m) => m[1]);
    expect(members).toEqual([
      "id",
      "name",
      "description",
      "category",
      "risk",
      "parameters",
      "requiresApproval",
      "requiredPermissions",
      "version",
      "enabled",
      "execute",
      "validate",
    ]);
    expect(source).not.toMatch(/mcp/i);
  });

  it("leaves ToolExecutor and ToolRegistry byte-for-byte unchanged", () => {
    // A pin, not an aspiration: S8 never edits either file. A later phase that
    // must change one updates its digest here, deliberately.
    expect(sha256(read("packages/tools/src/executor.ts"))).toBe(
      "ecc76194d55ecaed8cb434555c328afc0c7e1039a4347db0a132ebd3ad104f06"
    );
    expect(sha256(read("packages/tools/src/registry.ts"))).toBe(
      "f62f401378deecdf774a700b88cd5a4a375b142dfbc93406065445c58b6495ac"
    );
  });

  it("names tools for the model exactly as the container's converter does", () => {
    // container.ts keeps its own copy of this rule; the validator's collision
    // check is only sound while the two agree.
    const rule = 'id.replace(/[^a-zA-Z0-9_-]/g, "-")';
    expect(read("apps/api/src/services/container.ts")).toContain(rule);
    expect(read("packages/core/src/mcp-manifest.ts")).toContain(rule);
    expect(modelFacingToolName("meta.insights")).toBe("meta-insights");
    expect(modelFacingToolName("maps.reverse.geocode")).toBe("maps-reverse-geocode");
    expect(modelFacingToolName("a b/c")).toBe("a-b-c");
  });
});

describe("MCP stays where it was put", () => {
  it("is never known to memory, db, security or the web app", () => {
    expect(
      mcpReferences(["packages/memory/src", "packages/db/src", "packages/security/src", "apps/web/src"])
    ).toEqual([]);
  });

  it("reaches agents only through the policy's one derived grant (S8.4)", () => {
    expect(mcpReferences(["packages/agents/src"]).sort()).toEqual([
      "packages/agents/src/agent-policy.ts",
      "packages/agents/src/index.ts",
    ]);
    // No MCP tool is ever named in a policy by hand.
    expect(read("packages/agents/src/agent-policy.ts")).not.toMatch(/["'`]mcp[.-]/);
  });

  it("is wired by the composition root, reported by the integration layer (S8.5), and in tools only by the S8.3 adapter", () => {
    // S8.5 widened apps/api by the integration layer alone: the registry's
    // health check, the command service's MCP branches, and index.ts handing
    // the no-key route the same runtime. packages/mcp itself is still imported
    // by the container alone (packages/mcp/test/boundaries-s8.test.ts).
    expect(mcpReferences(["apps/api/src"]).sort()).toEqual([
      "apps/api/src/index.ts",
      "apps/api/src/services/container.ts",
      "apps/api/src/services/integration-registry.ts",
      "apps/api/src/services/integrations/command-service.ts",
    ]);
    expect(mcpReferences(["packages/tools/src"]).sort()).toEqual([
      "packages/tools/src/index.ts",
      "packages/tools/src/tools/mcp-tools.ts",
    ]);
  });

  it("adds no migration and no schema change", () => {
    const migrations = readdirSync(new URL("packages/db/prisma/migrations", REPO));
    expect(migrations.filter((m) => /mcp/i.test(m))).toEqual([]);
    expect(read("packages/db/prisma/schema.prisma")).not.toMatch(/mcp/i);
  });
});
