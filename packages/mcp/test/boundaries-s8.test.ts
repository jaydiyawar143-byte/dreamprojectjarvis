// S8.2 — package boundaries for the MCP runtime.
//
// The SDK lives in packages/mcp and nowhere else; the API container is this
// package's only user (S8.4); no policy names an MCP tool by hand, and no
// migration exists. The byte-for-byte pins on ToolExecutor and ToolRegistry
// stay in packages/core/test/mcp-boundaries-s8.test.ts. Asserted on source.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const REPO = new URL("../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, REPO), "utf8").replace(/\r\n/g, "\n");

/** Every .ts/.tsx/.mjs/.js source file under `dir`, repo-relative. */
function sources(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(new URL(dir, REPO))) return out;
  for (const entry of readdirSync(new URL(dir, REPO), { withFileTypes: true })) {
    if (["node_modules", "dist", ".next", ".turbo"].includes(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(?:tsx?|mjs|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const workspaces = (root: "packages" | "apps"): string[] =>
  readdirSync(new URL(root, REPO), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `${root}/${d.name}`);

const ALL = [...workspaces("packages"), ...workspaces("apps")];
const SDK = /["']@modelcontextprotocol\//;
const THIS_PACKAGE = /["']@jarvis\/mcp["']/;

describe("the MCP SDK lives only in packages/mcp", () => {
  it("is imported by no source outside packages/mcp", () => {
    const outside = ALL.filter((w) => w !== "packages/mcp")
      .flatMap((w) => sources(`${w}/src`))
      .filter((file) => SDK.test(read(file)));
    expect(outside).toEqual([]);
  });

  it("is declared by packages/mcp alone, pinned to an exact version", () => {
    for (const workspace of ALL) {
      const pkg = JSON.parse(read(`${workspace}/package.json`)) as Record<string, Record<string, string> | undefined>;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      const declared = Object.keys(deps).filter((d) => d.startsWith("@modelcontextprotocol/"));
      expect(declared, workspace).toEqual(workspace === "packages/mcp" ? ["@modelcontextprotocol/sdk"] : []);
      if (workspace === "packages/mcp") expect(deps["@modelcontextprotocol/sdk"]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("is used for its client only — no SDK server, and no SDK stdio transport", () => {
    // The SDK's StdioClientTransport always merges part of the parent's
    // environment into the child; this package spawns servers itself.
    for (const file of sources("packages/mcp/src")) {
      const imports = [...read(file).matchAll(/from\s+["'](@modelcontextprotocol\/[^"']+)["']/g)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(specifier, file).toMatch(/^@modelcontextprotocol\/sdk\/(?:client\/index|shared\/stdio|shared\/transport|types)\.js$/);
      }
    }
  });
});

describe("only the composition root depends on packages/mcp", () => {
  it("is imported by apps/api's container alone (S8.4) — no other package or app", () => {
    const users = ALL.filter((w) => w !== "packages/mcp")
      .flatMap((w) => [`${w}/package.json`, ...sources(`${w}/src`)])
      .filter((file) => THIS_PACKAGE.test(read(file)));
    expect(users.sort()).toEqual(["apps/api/package.json", "apps/api/src/services/container.ts"]);
  });

  it("depends on core, the SDK and zod only — never tools, agents, memory, db or security", () => {
    const pkg = JSON.parse(read("packages/mcp/package.json")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@jarvis/core", "@modelcontextprotocol/sdk", "zod"]);
    for (const file of sources("packages/mcp/src")) {
      // Code only: comments may name what this package deliberately does not touch.
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, file).not.toMatch(/\bToolRegistry\b|\bToolExecutor\b|\.register\(|@jarvis\/(?:tools|agents|memory|db|security)\b/);
    }
  });

  it("is not depended on by core", () => {
    const pkg = JSON.parse(read("packages/core/package.json")) as Record<string, Record<string, string> | undefined>;
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty("@jarvis/mcp");
  });

  it("names no MCP tool in a policy by hand and adds no migration", () => {
    expect(read("packages/agents/src/agent-policy.ts")).not.toMatch(/["'`]mcp[.-]/);
    const migrations = readdirSync(new URL("packages/db/prisma/migrations", REPO));
    expect(migrations.filter((m) => /mcp/i.test(m))).toEqual([]);
    expect(read("packages/db/prisma/schema.prisma")).not.toMatch(/mcp/i);
  });
});
