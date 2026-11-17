// ---------------------------------------------------------------------------
// UEE-0 — the n8n Sandbox import boundary.
//
// The Sandbox Service runs shell commands in a sandbox an operator's service
// owns. In this release it is built and NOT exposed: no route, tool or agent is
// wired to `container.n8nSandbox` (container.ts says so, and logs it). This file
// makes that sentence a test instead of a comment, so a later change that
// connects it has to do so on purpose, in front of a failing assertion.
//
// WHAT IS APPROVED, and nothing else:
//   - apps/api/src/services/container.ts          the composition root: builds the
//                                                  one instance, hands it to nothing
//   - apps/api/src/services/n8n-sandbox/**         the service and its config loader
//   - packages/n8n/src/index.ts, sandbox-*.ts      the provider package itself
//   - packages/config/src/index.ts                 the N8N_SANDBOX_* variable NAMES,
//                                                  in the environment schema only
//
// WHAT THIS CATCHES. Production source only (src of every app and package, and
// scripts): a module specifier that resolves to the sandbox implementation —
// by any relative path, with or without an extension, static, dynamic, `require`
// or re-exported — a deep package specifier into it, or any identifier the
// `@jarvis/n8n` barrel exports for it (so `import { … } from "@jarvis/n8n"` and
// a namespace import are caught by name, not by path). The barrel's list is READ
// from packages/n8n/src/index.ts, so a sandbox export added tomorrow is guarded
// today.
//
// WHAT IT DOES NOT. It is a text scan of comment-free source (see
// helpers/source-scan.ts), not a type checker: a name built at run time
// (`n8n["create" + …]`) is invisible to it. It guards against a change that did
// not mean to cross the boundary. The structural guarantee that nothing can
// RUN the sandbox is still that nothing holds the instance, which the container
// test below pins line by line.
//
// Tests are not scanned: a test that names a sandbox type carries no authority.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import {
  moduleSpecifiers,
  productionSourceFiles,
  readRepoFile,
  resolveRelative,
  stripComments,
} from "./helpers/source-scan.js";

// ---------------------------------------------------------------------------
// The approved files
// ---------------------------------------------------------------------------

const CONTAINER = "apps/api/src/services/container.ts";
const API_IMPLEMENTATION = /^apps\/api\/src\/services\/n8n-sandbox\//;
const PROVIDER_PACKAGE = /^packages\/n8n\/src\/(?:index|sandbox-[a-z-]+)\.ts$/;
const ENVIRONMENT_SCHEMA = "packages/config/src/index.ts";
const N8N_BARREL = "packages/n8n/src/index.ts";

type Kind = "path" | "symbol" | "env";

interface Finding {
  file: string;
  kind: Kind;
  detail: string;
}

function isApproved(file: string, kind: Kind): boolean {
  if (file === CONTAINER) return true;
  if (API_IMPLEMENTATION.test(file)) return true;
  if (PROVIDER_PACKAGE.test(file)) return true;
  // The variable NAMES, so the environment schema can validate them. It holds no
  // client, no key and no behaviour.
  return kind === "env" && file === ENVIRONMENT_SCHEMA;
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

/** Every identifier the @jarvis/n8n barrel exports that names the sandbox. */
function barrelSandboxNames(): string[] {
  const code = stripComments(readRepoFile(N8N_BARREL));
  const names = new Set<string>();
  // Capital S / all-caps: the lower-case word in a "./sandbox-client.js" path is
  // not an identifier.
  for (const match of code.matchAll(/\b[A-Za-z_$][\w$]*(?:Sandbox|SANDBOX)[\w$]*\b/g)) names.add(match[0]);
  return [...names].sort();
}

const BARREL_NAMES = barrelSandboxNames();

/**
 * Matches the barrel's names, and the API service's own (which the barrel does
 * not export). The `N8N_SANDBOX_*` tokens are NOT here: a variable and a
 * constant the barrel exports share one spelling (`N8N_SANDBOX_MAX_OUTPUT_BYTES`
 * is both), so every such token is judged as one thing, below.
 */
const SANDBOX_SYMBOL = new RegExp(
  `\\b(?:${[
    ...BARREL_NAMES.filter((name) => !name.startsWith("N8N_SANDBOX_")),
    "N8nSandbox\\w*",
    "n8nSandbox\\w*",
    "loadN8nSandbox\\w*",
  ].join("|")})\\b`,
  "g"
);
/** The variable names and the constants that share them. Only the environment schema may spell them. */
const SANDBOX_ENV = /\bN8N_SANDBOX_[A-Z0-9_]+\b/g;

/** Whether a repo-relative path (extension removed) is the sandbox implementation. */
function isSandboxPath(path: string): boolean {
  return (
    path === "apps/api/src/services/n8n-sandbox" ||
    path.startsWith("apps/api/src/services/n8n-sandbox/") ||
    /^packages\/n8n\/(?:src|dist)\/sandbox-[a-z-]+$/.test(path)
  );
}

function sandboxFindings(file: string, source: string): Finding[] {
  const code = stripComments(source);
  const findings: Finding[] = [];

  for (const specifier of moduleSpecifiers(code)) {
    const relative = resolveRelative(file, specifier);
    if (relative !== null) {
      if (isSandboxPath(relative)) findings.push({ file, kind: "path", detail: specifier });
    } else if (/^@jarvis\/n8n\/.*sandbox/i.test(specifier)) {
      // A deep package import that skips the barrel.
      findings.push({ file, kind: "path", detail: specifier });
    }
  }

  const symbolNames = new Set<string>();
  for (const match of code.matchAll(SANDBOX_SYMBOL)) symbolNames.add(match[0]);
  for (const name of [...symbolNames].sort()) findings.push({ file, kind: "symbol", detail: name });

  const envNames = new Set<string>();
  for (const match of code.matchAll(SANDBOX_ENV)) envNames.add(match[0]);
  for (const name of [...envNames].sort()) findings.push({ file, kind: "env", detail: name });
  return findings;
}

const unapproved = (findings: Finding[]): Finding[] => findings.filter((f) => !isApproved(f.file, f.kind));

// ---------------------------------------------------------------------------
// 1. The detector itself — positive and negative controls
//
// A scan that finds nothing proves nothing until it is shown to find something.
// ---------------------------------------------------------------------------

describe("the detector finds a sandbox reference however it is written", () => {
  const FROM = "packages/tools/src/tools/example.ts";
  const detail = (source: string, file = FROM): string[] => sandboxFindings(file, source).map((f) => `${f.kind}:${f.detail}`);

  it.each<[string, string, string]>([
    ["a named import from the barrel", `import { createN8nSandboxClient } from "@jarvis/n8n";`, "symbol:createN8nSandboxClient"],
    ["a type-only import", `import type { N8nSandboxClient } from "@jarvis/n8n";`, "symbol:N8nSandboxClient"],
    ["an aliased import", `import { createN8nSandboxClient as make } from "@jarvis/n8n";`, "symbol:createN8nSandboxClient"],
    ["a namespace import used by name", `import * as n8n from "@jarvis/n8n";\nconst c = n8n.createN8nSandboxClient({});`, "symbol:createN8nSandboxClient"],
    ["a re-export", `export { N8nSandboxService } from "./somewhere.js";`, "symbol:N8nSandboxService"],
    ["the instance read off the container", `const s = container.n8nSandbox;`, "symbol:n8nSandbox"],
    ["a barrel helper that is not a client", `import { redactSandboxText } from "@jarvis/n8n";`, "symbol:redactSandboxText"],
    ["a multi-line import list", `import {\n  a,\n  N8nSandboxError,\n} from "@jarvis/n8n";`, "symbol:N8nSandboxError"],
    ["the API key's variable", `const key = process.env.N8N_SANDBOX_API_KEY;`, "env:N8N_SANDBOX_API_KEY"],
    ["the API URL's variable, by string", `const name = "N8N_SANDBOX_API_URL";`, "env:N8N_SANDBOX_API_URL"],
  ])("%s", (_label, source, expected) => {
    expect(detail(source)).toContain(expected);
  });

  // FROM is packages/tools/src/tools/example.ts: three levels up is `packages/`,
  // four is the repository root.
  it.each<[string, string, string, string?]>([
    ["a relative path to the service", `import { x } from "../../../../apps/api/src/services/n8n-sandbox/sandbox-service.js";`, "path:../../../../apps/api/src/services/n8n-sandbox/sandbox-service.js"],
    ["a relative path with no extension", `import { x } from "../../../../apps/api/src/services/n8n-sandbox/sandbox-service";`, "path:../../../../apps/api/src/services/n8n-sandbox/sandbox-service"],
    ["the service's directory", `import { x } from "../../../../apps/api/src/services/n8n-sandbox";`, "path:../../../../apps/api/src/services/n8n-sandbox"],
    ["a sibling path from another API folder", `import { x } from "../services/n8n-sandbox/config.js";`, "path:../services/n8n-sandbox/config.js", "apps/api/src/routes/example.ts"],
    ["the provider's client by relative path", `import { x } from "../../../n8n/src/sandbox-client.js";`, "path:../../../n8n/src/sandbox-client.js"],
    ["the provider's compiled output", `import { x } from "../../../n8n/dist/sandbox-client.js";`, "path:../../../n8n/dist/sandbox-client.js"],
    ["a deep package specifier that skips the barrel", `import { x } from "@jarvis/n8n/src/sandbox-client.js";`, "path:@jarvis/n8n/src/sandbox-client.js"],
    ["a side-effect import", `import "../../../n8n/src/sandbox-config.js";`, "path:../../../n8n/src/sandbox-config.js"],
    ["a dynamic import", `const m = await import("../../../n8n/src/sandbox-client.js");`, "path:../../../n8n/src/sandbox-client.js"],
    ["a require", `const m = require("../../../n8n/src/sandbox-ndjson");`, "path:../../../n8n/src/sandbox-ndjson"],
    ["an import-equals require", `import m = require("../../../n8n/src/sandbox-error");`, "path:../../../n8n/src/sandbox-error"],
    ["a star re-export", `export * from "../../../../apps/api/src/services/n8n-sandbox/index.js";`, "path:../../../../apps/api/src/services/n8n-sandbox/index.js"],
  ])("%s", (_label, source, expected, file) => {
    expect(detail(source, file ?? FROM)).toContain(expected);
  });

  it.each<[string, string]>([
    ["an ordinary n8n import", `import { N8nTriggerWorkflowTool, createN8nProvider } from "@jarvis/n8n";`],
    ["a path that only looks similar", `import { x } from "../n8n/src/api-client.js";`],
    // From packages/tools/src/tools/, `../n8n-sandbox/` is
    // packages/tools/src/n8n-sandbox/, which is not the service: the scan
    // resolves paths, it does not match words.
    ["a path that resolves somewhere else", `import { x } from "../n8n-sandbox/config.js";`],
    ["a word in a comment", `// the N8nSandboxService is not wired here\n/* createN8nSandboxClient */\nconst a = 1;`],
    ["the lower-case word in ordinary code", `const sandbox = new Map();`],
    ["a browser sandbox", `const options = { chromiumSandbox: true };`],
  ])("does not flag %s", (_label, source) => {
    expect(sandboxFindings(FROM, source)).toEqual([]);
  });
});

describe("the approval step refuses a reference from anywhere that is not approved", () => {
  const REFERENCE = `import { createN8nSandboxClient } from "@jarvis/n8n";\nconst key = process.env.N8N_SANDBOX_API_KEY;`;

  it.each([
    "packages/agents/src/agents/example-agent.ts",
    "packages/tools/src/tools/example-tools.ts",
    "packages/core/src/example.ts",
    "packages/memory/src/example.ts",
    "apps/api/src/routes/example.ts",
    "apps/api/src/services/tasks/example.ts",
    "apps/api/src/services/n8n-sandbox-adjacent/example.ts",
    "apps/web/src/lib/example.ts",
    "scripts/example.mjs",
    "packages/n8n/src/provider.ts",
    "packages/n8n/src/api-client.ts",
  ])("%s", (file) => {
    const refused = unapproved(sandboxFindings(file, REFERENCE));
    expect(refused.map((f) => f.kind).sort()).toEqual(["env", "symbol"]);
  });

  it.each([CONTAINER, "apps/api/src/services/n8n-sandbox/sandbox-service.ts", "packages/n8n/src/sandbox-client.ts", N8N_BARREL])(
    "%s is approved",
    (file) => {
      expect(unapproved(sandboxFindings(file, REFERENCE))).toEqual([]);
    }
  );

  it("the environment schema may spell the variable names and nothing more", () => {
    expect(unapproved(sandboxFindings(ENVIRONMENT_SCHEMA, `N8N_SANDBOX_API_KEY: z.string().optional(),`))).toEqual([]);
    expect(unapproved(sandboxFindings(ENVIRONMENT_SCHEMA, `import { createN8nSandboxClient } from "@jarvis/n8n";`)).map((f) => f.kind)).toEqual(["symbol"]);
  });
});

describe("the barrel's sandbox exports are read, not remembered", () => {
  it("includes the client factory, the client type and the config helpers", () => {
    expect(BARREL_NAMES).toEqual(
      expect.arrayContaining(["createN8nSandboxClient", "N8nSandboxClient", "createN8nSandboxConfig", "describeN8nSandboxStatus"])
    );
  });

  it("holds more than a handful, so an empty parse cannot pass for a clean scan", () => {
    expect(BARREL_NAMES.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 2. The real repository
// ---------------------------------------------------------------------------

describe("production source", () => {
  const files = productionSourceFiles();
  const findings = files.flatMap((file) => sandboxFindings(file, readRepoFile(file)));

  it("is scanned in full, not an empty or partial set", () => {
    expect(files.length).toBeGreaterThan(300);
    for (const expected of [CONTAINER, "packages/agents/src/orchestrator.ts", "packages/tools/src/executor.ts", "apps/api/src/routes/chat.ts"]) {
      expect(files).toContain(expected);
    }
  });

  it("finds the approved files' references, so the scan is not blind", () => {
    const byFile = new Set(findings.map((f) => f.file));
    expect(byFile.has(CONTAINER)).toBe(true);
    expect(byFile.has("apps/api/src/services/n8n-sandbox/sandbox-service.ts")).toBe(true);
    expect(byFile.has(N8N_BARREL)).toBe(true);
    expect(byFile.has(ENVIRONMENT_SCHEMA)).toBe(true);
  });

  it("is referenced only by the approved wiring and implementation", () => {
    // A failure here lists the file, the kind and the name. If the new reference
    // is meant — a tool and a route for the sandbox are an expected later change —
    // approve it HERE, in the same change, with the reason: this list is the
    // record of where the sandbox may be touched.
    expect(unapproved(findings)).toEqual([]);
  });

  it("is not reached from any agent, tool, route, task service or other package", () => {
    // The same claim as above, said for the places a connection would most
    // plausibly be made, so a failure names the area rather than a list.
    for (const area of ["packages/agents/src/", "packages/tools/src/", "packages/core/src/", "apps/api/src/routes/", "apps/api/src/services/tasks/"]) {
      expect(findings.filter((f) => f.file.startsWith(area))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The composition root builds the instance and gives it to nothing
// ---------------------------------------------------------------------------

describe("the container's handle on the sandbox", () => {
  const code = stripComments(readRepoFile(CONTAINER));
  const lines = code.split("\n").map((line) => line.trim());

  it("names the instance in exactly four places: its type, its declaration, its construction, its return", () => {
    const mentions = lines.filter((line) => /\bn8nSandbox\b/.test(line)).sort();
    expect(mentions).toEqual(
      [
        "let n8nSandbox: N8nSandboxService | null = null;",
        "n8nSandbox = new N8nSandboxService({",
        "n8nSandbox,",
        "n8nSandbox: N8nSandboxService | null;",
      ].sort()
    );
  });

  it("passes it to no tool, agent, route, registry or other service", () => {
    // Any use beyond the four lines above would put the instance on a new line.
    // The assertion above is what catches it; this one names the plausible
    // shapes so a failure reads as what it is.
    for (const line of lines) {
      if (!/\bn8nSandbox\b/.test(line)) continue;
      expect(line).not.toMatch(/register|Registry|Tool\(|Agent\(|createRouter|\.use\(|new \w+\([^)]*n8nSandbox/);
    }
  });

  it("builds the one client, once", () => {
    expect(code.match(/\bcreateN8nSandboxClient\s*\(/g) ?? []).toHaveLength(1);
    expect(code.match(/\bnew N8nSandboxService\s*\(/g) ?? []).toHaveLength(1);
  });
});
