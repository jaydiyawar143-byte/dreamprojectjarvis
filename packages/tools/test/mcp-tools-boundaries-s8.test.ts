// S8.3 — boundaries for the MCP tool adapter.
//
// The adapter knows a port, never a provider: no SDK, no packages/mcp, no
// process, no database, no network. Nothing wires it in yet: no registration,
// no grant, no container change. ToolExecutor and ToolRegistry are pinned
// byte-for-byte (the same digests as packages/core/test/mcp-boundaries-s8).
// Asserted on source.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const REPO = new URL("../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, REPO), "utf8").replace(/\r\n/g, "\n");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

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

/** Source with comments removed: what the code does, not what it mentions. */
const code = (path: string): string =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const ADAPTER = "packages/tools/src/tools/mcp-tools.ts";

describe("the adapter knows a port, never a provider", () => {
  it("imports only @jarvis/core and BaseTool", () => {
    const specifiers = [...read(ADAPTER).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    expect([...new Set(specifiers)].sort()).toEqual(["../base-tool.js", "@jarvis/core"]);
  });

  it("has no SDK, process, database, network, model, memory, audit or approval logic", () => {
    expect(code(ADAPTER)).not.toMatch(
      /@modelcontextprotocol|@jarvis\/mcp|child_process|spawn\(|[Pp]risma|@jarvis\/db|fetch\(|node:https?|axios|CircuitBreaker|\.close\(|[Aa]uditLogger|IAIProvider|IMemoryStore|consumeForExecution|approvalId|journal/
    );
  });

  it("leaves packages/tools without the SDK or packages/mcp, in dependencies and in source", () => {
    const pkg = JSON.parse(read("packages/tools/package.json")) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
    expect(deps.filter((d) => d.startsWith("@modelcontextprotocol/") || d === "@jarvis/mcp")).toEqual([]);
    const offenders = sources("packages/tools/src").filter((f) => /["'](?:@modelcontextprotocol\/|@jarvis\/mcp["'])/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

describe("the executor and the registry are untouched", () => {
  it("pins ToolExecutor and ToolRegistry byte-for-byte", () => {
    expect(sha256(read("packages/tools/src/executor.ts"))).toBe(
      "ecc76194d55ecaed8cb434555c328afc0c7e1039a4347db0a132ebd3ad104f06"
    );
    expect(sha256(read("packages/tools/src/registry.ts"))).toBe(
      "f62f401378deecdf774a700b88cd5a4a375b142dfbc93406065445c58b6495ac"
    );
  });
});

describe("only the composition root wires the adapter in", () => {
  const ADAPTER_NAMES = /\b(?:createMcpTools|McpTool|McpCallPort)\b/;

  it("is used by apps/api's container alone (S8.4) — no agent, memory, db, security or web code", () => {
    const users = [
      "apps/api/src",
      "apps/web/src",
      "packages/agents/src",
      "packages/memory/src",
      "packages/db/src",
      "packages/security/src",
    ]
      .flatMap(sources)
      .filter((file) => ADAPTER_NAMES.test(code(file)));
    expect(users).toEqual(["apps/api/src/services/container.ts"]);
  });

  it("names no MCP tool in a policy or the skill catalogue by hand", () => {
    expect(read("packages/agents/src/agent-policy.ts")).not.toMatch(/["'`]mcp[.-]/);
    expect(read("packages/core/src/capability-presentation.ts")).not.toMatch(/["'`]mcp[.-]/);
  });

  it("adds no migration and no schema change", () => {
    const migrations = readdirSync(new URL("packages/db/prisma/migrations", REPO));
    expect(migrations.filter((m) => /mcp/i.test(m))).toEqual([]);
    expect(read("packages/db/prisma/schema.prisma")).not.toMatch(/mcp/i);
  });
});
