// ---------------------------------------------------------------------------
// UEE-0 — a small source scanner for the security boundary tests.
//
// The boundary tests assert on SOURCE, the way `mcp-tools-boundaries-s8` and
// `memory-architecture-p14` do: what the code does, not what a comment says.
// This file holds the parts they share — walking the production sources and
// reading a file with its comments removed — and nothing else. It is not a
// parser. It is a text scan, and every limit of one is stated where it matters
// (see `stripComments`).
//
// No production code imports it.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: this file is apps/api/test/helpers/. */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".next", ".turbo", ".git", "coverage"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** Posix-style path relative to the repository root. */
export function toRepoPath(absolute: string): string {
  return absolute.slice(REPO_ROOT.length).replace(/\\/g, "/");
}

function walk(directory: string, out: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, out);
    else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(toRepoPath(absolute));
  }
}

/**
 * Every production source file: `src` of each app and package, and `scripts`.
 *
 * Tests are deliberately not here. A test that imports a boundary-guarded
 * symbol carries no runtime authority; the boundaries below are about what can
 * RUN, so they read what ships.
 */
export function productionSourceFiles(): string[] {
  const roots: string[] = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(REPO_ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const src = join(groupDir, entry.name, "src");
      if (entry.isDirectory() && existsSync(src) && statSync(src).isDirectory()) roots.push(src);
    }
  }
  const scripts = join(REPO_ROOT, "scripts");
  if (existsSync(scripts)) roots.push(scripts);

  const files: string[] = [];
  for (const root of roots) walk(root, files);
  return files.sort();
}

export function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Source with comments removed: what the code does, not what it mentions.
 *
 * The same rule the repository's other source-scan tests use, and with the same
 * limits. It is a regular-expression pass, not a tokenizer: a `//` inside a
 * string or a regular-expression literal removes the rest of that line, and an
 * opening block-comment marker inside a string can remove text up to the next
 * closing one. `://` is kept, so a URL survives. Hiding an import from it takes deliberate effort, and these
 * tests guard against a change that did not mean to cross a boundary, not
 * against someone writing code to evade a scan.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// Module specifiers
// ---------------------------------------------------------------------------

/**
 * Every module specifier a file names, in any syntax a TypeScript or JavaScript
 * file can use to load one:
 *
 *   import a from "x"          import { a } from "x"        import type { A } from "x"
 *   import * as a from "x"     import "x"
 *   export * from "x"          export { a } from "x"        export type { A } from "x"
 *   import("x")                require("x")                 import a = require("x")
 */
export function moduleSpecifiers(code: string): string[] {
  const found: string[] = [];
  const patterns: RegExp[] = [
    // import … from "x" / import "x" / export … from "x". The lazy gap may span
    // lines, so a multi-line import list is read; it cannot span a quote or a
    // semicolon, so it cannot run on into the next statement.
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/g,
    // import("x")
    /\bimport\s*\(\s*["']([^"']+)["']\s*[,)]/g,
    // require("x"), and so `import a = require("x")`
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

/**
 * Where a RELATIVE specifier points, as a repo-relative path with the extension
 * removed — `./sandbox-client.js` from packages/n8n/src/index.ts is
 * `packages/n8n/src/sandbox-client`, as is `./sandbox-client` and
 * `../src/sandbox-client.ts`. A package specifier has no path here: null.
 */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  return joined.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
}
